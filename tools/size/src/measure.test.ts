/**
 * The size measurement.
 *
 * The tests that matter are the ones about what gets *counted*, because the
 * two bugs this had were both over-counting: following type-only imports into
 * modules that ship nothing, and weighing doc comments a minifier deletes.
 * Both made a passing budget look like a failing one, which is the direction
 * that wastes a day.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { BUDGET_BYTES, collectModules, formatReport, measure, stripComments } from './measure.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// The element, not the package barrel — see the CLI for why. A static
// re-export from `index.ts` pulls the lazy modules back into the graph.
const ENTRY = join(repoRoot, 'packages/web/src/nub.ts');

/** A tiny in-memory module graph. */
function files(map: Record<string, string>): (path: string) => string {
  return (path) => {
    const source = map[path];
    if (source === undefined) throw new Error(`no such module: ${path}`);
    return source;
  };
}

describe('stripComments', () => {
  it('removes line and block comments', () => {
    const out = stripComments('const a = 1; // trailing\n/* block */\nconst b = 2;');
    assert.ok(!out.includes('trailing'));
    assert.ok(!out.includes('block'));
    assert.match(out, /const a = 1;/);
    assert.match(out, /const b = 2;/);
  });

  it('leaves comment-looking text inside strings alone', () => {
    // The reason this is a character scanner and not a regex. Deleting the
    // rest of the line here would understate the size.
    const source = `const url = 'https://example.com/x'; const c = "/* not a comment */";`;
    const out = stripComments(source);
    assert.ok(out.includes('https://example.com/x'));
    assert.ok(out.includes('/* not a comment */'));
  });

  it('handles escaped quotes inside strings', () => {
    const source = `const s = 'it\\'s fine'; // gone`;
    const out = stripComments(source);
    assert.ok(out.includes("it\\'s fine"));
    assert.ok(!out.includes('gone'));
  });

  it('keeps template literals intact', () => {
    const source = 'const t = `a // b ${x} c`;';
    assert.ok(stripComments(source).includes('a // b'));
  });

  it('does not leave a pile of blank lines behind', () => {
    const source = '/**\n * doc\n */\nconst a = 1;\n';
    assert.equal(stripComments(source).trim(), 'const a = 1;');
  });
});

describe('collectModules', () => {
  it('returns dependencies before their dependents', () => {
    const read = files({
      '/a.ts': "import { b } from './b.ts';\nexport const a = b;",
      '/b.ts': 'export const b = 1;',
    });
    assert.deepEqual(collectModules('/a.ts', read), ['/b.ts', '/a.ts']);
  });

  it('visits each module once in a diamond', () => {
    const read = files({
      '/a.ts': "import { b } from './b.ts';\nimport { c } from './c.ts';",
      '/b.ts': "import { d } from './d.ts';\nexport const b = d;",
      '/c.ts': "import { d } from './d.ts';\nexport const c = d;",
      '/d.ts': 'export const d = 1;',
    });
    assert.equal(collectModules('/a.ts', read).length, 4);
  });

  it('stops at a dynamic import, because a bundler makes it a chunk', () => {
    const read = files({
      '/a.ts': "import { b } from './b.ts';\nconst lazy = () => import('./big.ts');",
      '/b.ts': 'export const b = 1;',
      '/big.ts': 'export const big = 2;',
    });

    const lazy = new Set<string>();
    const paths = collectModules('/a.ts', read, lazy);

    // Counting it would make lazy loading invisible to the budget.
    assert.deepEqual(paths, ['/b.ts', '/a.ts']);
    assert.deepEqual([...lazy], ['/big.ts']);
  });

  it('treats a specifier imported both ways as static', () => {
    const read = files({
      '/a.ts': "import { b } from './b.ts';\nconst again = () => import('./b.ts');",
      '/b.ts': 'export const b = 1;',
    });
    const lazy = new Set<string>();
    // It is already in the initial bundle, so the dynamic form costs nothing
    // extra and must not be double-counted as a chunk.
    assert.deepEqual(collectModules('/a.ts', read, lazy), ['/b.ts', '/a.ts']);
    assert.deepEqual([...lazy], []);
  });

  it('ignores type-only imports, because a bundler does', () => {
    // `types.ts` ships zero bytes. Counting it inflated the real report by a
    // fifth and named two modules that are not in any bundle.
    const read = files({
      '/a.ts': "import type { T } from './types.ts';\nexport const a: T = 1;",
      '/types.ts': 'export type T = number;',
    });
    assert.deepEqual(collectModules('/a.ts', read), ['/a.ts']);
  });

  it('refuses a bare specifier', () => {
    const read = files({ '/a.ts': "import x from 'left-pad';" });
    assert.throws(() => collectModules('/a.ts', read), /must have no dependencies/);
  });
});

describe('measure, on the real entry point', () => {
  const report = measure(ENTRY, { root: repoRoot });

  it('reaches core through the web package', () => {
    const paths = report.modules.map((module) => module.path);
    assert.ok(paths.includes('packages/web/src/nub.ts'));
    assert.ok(paths.includes('packages/core/src/queue.ts'));
    assert.ok(paths.includes('packages/core/src/transport.ts'));
  });

  it('counts no type-only module', () => {
    const paths = report.modules.map((module) => module.path);

    // `state.ts` is nothing but declarations, so it ships zero bytes and must
    // not appear. If it does, the graph walk regressed to scanning unstripped
    // source, which is what inflated the first version of this report.
    assert.ok(!paths.includes('packages/core/src/state.ts'));
  });

  it('counts no lazily loaded module', () => {
    const paths = report.modules.map((module) => module.path);

    // Both are behind `import()`. A user who never opens the picker never
    // downloads it, so charging it to the initial bundle would have blocked a
    // change that was already made correctly.
    assert.ok(!paths.includes('packages/web/src/picker.ts'));
    assert.ok(!paths.includes('packages/web/src/frustration-dom.ts'));

    assert.deepEqual(
      report.lazy.map((chunk) => chunk.entry).sort(),
      ['packages/web/src/frustration-dom.ts', 'packages/web/src/picker.ts'],
    );
    for (const chunk of report.lazy) {
      assert.ok(chunk.gzipped > 0, `${chunk.entry} measured as nothing`);
    }
  });

  it('is within the 15KB budget', () => {
    assert.ok(
      report.withinBudget,
      `core + nub gzip to ${(report.gzipped / 1024).toFixed(1)}KB against a ${(BUDGET_BYTES / 1024).toFixed(0)}KB budget`,
    );
  });

  it('reports comment removal as a real reduction', () => {
    // If these were equal the comment stripper silently did nothing and the
    // budget check would be measuring prose.
    assert.ok(report.code < report.stripped);
    assert.ok(report.gzipped < report.gzippedWithComments);
  });

  it('formats a report that states the method', () => {
    const text = formatReport(report);
    // A size number without its method is a number people quote out of
    // context. It has to travel with the caveat.
    assert.match(text, /upper bound|OVER BUDGET/);
    assert.match(text, /budget/);
  });
});
