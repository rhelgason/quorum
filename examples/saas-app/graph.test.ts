/**
 * Everything the browser would load, loaded — without a browser.
 *
 * This is the cheap half of verifying the example app, and it catches the
 * class of failure that is most likely and least interesting: a module that
 * 404s, an import a browser cannot resolve, or a file the type-stripper
 * chokes on. All three are invisible to `node --test`, because Node resolves
 * modules from disk with its own rules and never asks the dev server for
 * anything.
 *
 * It is emphatically **not** a substitute for
 * `packages/web/src/nub.browser.test.ts`. Nothing here executes a line of the
 * code it fetches, so it cannot tell you whether the element renders — only
 * that the browser would get all of it, and that what it got is JavaScript.
 * Those are different claims and the README says so.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { createDevServer } from '../../tools/devserver/src/serve.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

/** The three entry points a browser is told to load by the app's HTML. */
const ENTRIES = ['/packages/web/src/index.ts', '/app.js', '/backlog/backlog.js'];

let server: Server;
let base: string;

before(async () => {
  server = createDevServer({
    root: join(here, 'public'),
    mounts: { '/packages': join(repoRoot, 'packages') },
    spa: 'index.html',
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

interface Module {
  url: string;
  body: string;
  importedBy: string;
}

/** Fetch an entry point and everything it transitively imports. */
async function walk(entry: string): Promise<{ modules: Module[]; failures: string[] }> {
  const modules: Module[] = [];
  const failures: string[] = [];
  const seen = new Set<string>();

  async function visit(url: string, importedBy: string): Promise<void> {
    if (seen.has(url)) return;
    seen.add(url);

    const response = await fetch(url);
    if (!response.ok) {
      failures.push(`${String(response.status)} ${url} (imported by ${importedBy})`);
      return;
    }

    const body = await response.text();
    modules.push({ url, body, importedBy });

    for (const match of body.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1] as string;
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        // No import map and no bundler, so a bare specifier is unresolvable —
        // it would fail at runtime in the browser and nowhere else.
        failures.push(`bare specifier "${specifier}" in ${url}`);
        continue;
      }
      await visit(new URL(specifier, url).href, url);
    }
  }

  await visit(new URL(entry, base).href, '(entry)');
  return { modules, failures };
}

describe('the example app module graph', () => {
  it('resolves every import a browser would make', async () => {
    for (const entry of ENTRIES) {
      const { failures } = await walk(entry);
      assert.deepEqual(failures, [], `${entry} has unresolvable imports`);
    }
  });

  it('reaches the element, the client, and core through the graph', async () => {
    const { modules } = await walk('/packages/web/src/index.ts');
    const paths = modules.map((module) => new URL(module.url).pathname);

    // Guards against the graph passing because it collapsed to nothing.
    assert.ok(paths.includes('/packages/web/src/nub.ts'));
    assert.ok(paths.includes('/packages/web/src/client.ts'));
    assert.ok(paths.includes('/packages/core/src/transport.ts'));
    assert.ok(paths.includes('/packages/core/src/queue.ts'));
    assert.ok(paths.includes('/packages/core/src/panel.ts'));
  });

  it('serves JavaScript, not TypeScript', async () => {
    const { modules } = await walk('/packages/web/src/index.ts');

    for (const module of modules) {
      assert.ok(
        !module.body.startsWith('throw new SyntaxError'),
        `${module.url} could not be type-stripped: ${module.body.slice(0, 200)}`,
      );
      // A surviving annotation means the stripper silently passed the file
      // through, which the browser reports as a syntax error at line 1.
      assert.ok(
        !/^\s*(interface|type)\s+\w+/m.test(module.body),
        `${module.url} still contains type declarations`,
      );
    }
  });

  it('imports nothing from node: in anything the browser loads', async () => {
    const { modules } = await walk('/packages/web/src/index.ts');

    for (const module of modules) {
      assert.ok(
        !/['"]node:/.test(module.body),
        `${module.url} imports a Node builtin — @quorum/web must stay DOM-only`,
      );
    }
  });
});
