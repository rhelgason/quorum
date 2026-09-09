/**
 * Type stripping, and the cache in front of it.
 *
 * The property that matters most is the one about line numbers: this repo has
 * no source maps, so a browser stack trace is only useful if the served line
 * is the same line as the file on disk.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StripCache, stripSource } from './strip.ts';

describe('stripSource', () => {
  it('removes annotations and leaves the runtime code alone', () => {
    const output = stripSource('const total: number = add(1, 2);', 'x.ts');
    assert.match(output, /const total\s+= add\(1, 2\);/);
    assert.ok(!output.includes('number'));
  });

  it('drops type-only imports and exports', () => {
    const source = [
      "import type { Doc } from './doc.ts';",
      "import { cluster } from './cluster.ts';",
      'export type Alias = Doc;',
      'export const run = () => cluster();',
    ].join('\n');

    const output = stripSource(source, 'x.ts');
    assert.ok(!output.includes('./doc.ts'), 'a type-only import would 404 in the browser');
    assert.ok(output.includes('./cluster.ts'), 'value imports survive');
    assert.ok(output.includes('export const run'));
  });

  it('keeps the .ts extension on value imports', () => {
    // The dev server resolves these as real requests, so rewriting them to
    // .js — which a bundler would do — would break every one of them.
    const output = stripSource("import { a } from '../core/src/a.ts';", 'x.ts');
    assert.ok(output.includes("'../core/src/a.ts'"));
  });

  it('preserves line count so stack traces line up', () => {
    const source = [
      'interface Big {',
      '  a: string;',
      '  b: number;',
      '}',
      '',
      'export const value = 1;',
    ].join('\n');

    const output = stripSource(source, 'x.ts');
    assert.equal(output.split('\n').length, source.split('\n').length);
    assert.equal(output.split('\n')[5], 'export const value = 1;');
  });

  it('turns unsupported syntax into a throwing module that names the file', () => {
    // `enum` is not erasable. Serving a blank or half-parsed body would give
    // the browser an unattributable syntax error; this at least says where.
    const output = stripSource('enum Color { Red }', 'packages/web/src/bad.ts');
    assert.match(output, /^throw new SyntaxError\(/);
    assert.ok(output.includes('packages/web/src/bad.ts'));
  });

  it('leaves plain JavaScript untouched', () => {
    const source = 'export const x = 1;\n';
    assert.equal(stripSource(source, 'x.ts'), source);
  });
});

describe('StripCache', () => {
  it('strips once per mtime', () => {
    const cache = new StripCache();
    let reads = 0;
    const read = (): string => {
      reads++;
      return 'const a: number = 1;';
    };

    const first = cache.get('/a.ts', 100, read);
    const second = cache.get('/a.ts', 100, read);

    assert.equal(reads, 1);
    assert.equal(first, second);
  });

  it('re-strips when the file changes', () => {
    const cache = new StripCache();
    assert.match(cache.get('/a.ts', 100, () => 'const a: number = 1;'), /const a/);
    assert.match(cache.get('/a.ts', 200, () => 'const b: string = "x";'), /const b/);
  });

  it('keys on path as well as mtime', () => {
    const cache = new StripCache();
    cache.get('/a.ts', 100, () => 'export const a = 1;');
    cache.get('/b.ts', 100, () => 'export const b = 2;');
    assert.equal(cache.size, 2);
  });
});
