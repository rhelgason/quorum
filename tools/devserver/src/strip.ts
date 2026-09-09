/**
 * Turning this repo's `.ts` sources into something a browser will execute.
 *
 * There is no bundler in the authoring environment and no way to install one,
 * but Node 24 exposes the type-stripper it uses to run `.ts` files directly.
 * Pointed at a file instead of a module graph, it is a transpiler: types out,
 * everything else untouched, line numbers preserved because the removed spans
 * are blanked rather than deleted.
 *
 * That yields something better than a bundle for development. The browser
 * loads the *actual* module graph — `nub.ts` importing `../../core/src/panel.ts`
 * — so a stack trace points at a real file and a real line, and there is no
 * build step between editing and reloading.
 *
 * The constraints this inherits are the same ones `node --test` already
 * imposes on the repo, so nothing new has to be avoided:
 *
 *  - relative imports must carry their `.ts` extension
 *  - only erasable syntax — no `enum`, `namespace`, parameter properties, or
 *    decorators
 *
 * What it is emphatically not: a production build. Nothing is minified, tree
 * shaken, or downleveled, and every module is a separate request.
 */

import { stripTypeScriptTypes } from 'node:module';

/**
 * Strip types from one module's source.
 *
 * `mode: 'strip'` rather than `'transform'` keeps the output byte-aligned with
 * the input, which is what makes browser stack traces line up with the file on
 * disk without a source map.
 */
export function stripSource(code: string, path: string): string {
  try {
    return stripTypeScriptTypes(code, { mode: 'strip' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Thrown as a module-level error so the browser console names the file
    // rather than reporting an opaque syntax error on a blank response.
    return `throw new SyntaxError(${JSON.stringify(`cannot type-strip ${path}: ${message}`)});`;
  }
}

/**
 * Every module specifier a source file imports.
 *
 * Anchored at the start of a line, which is the whole trick. A loose
 * `from\s*['"]...['"]` looks correct and is not: this repo's files are dense
 * with prose, and "read off framework internals where available, e.g. React
 * fiber" followed three lines later by a quoted union member matches happily.
 * The first version of this reported that `protocol.ts` imports `"\n  | "`.
 *
 * Import statements always begin a line here, and a continuation line inside a
 * multi-line import list begins with `{`, an identifier, or whitespace — never
 * with `import`. A doc comment line begins with `*`. So the anchor separates
 * them exactly.
 */
export function importSpecifiers(source: string): string[] {
  const patterns = [
    // import x from '…' / export { x } from '…' / import type … from '…'
    /^[ \t]*(?:import|export)\s[^;'"]*?\sfrom\s*['"]([^'"]+)['"]/gm,
    // import '…' — side effect only
    /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
    // await import('…')
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1] as string);
  }
  return [...new Set(found)];
}

/**
 * A read-through cache keyed on path and mtime.
 *
 * Stripping is fast, but the example app pulls in a few dozen modules on every
 * reload and re-reading plus re-parsing all of them makes an otherwise instant
 * refresh perceptibly slow.
 */
export class StripCache {
  readonly #entries = new Map<string, { mtimeMs: number; output: string }>();

  get(path: string, mtimeMs: number, read: () => string): string {
    const cached = this.#entries.get(path);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.output;

    const output = stripSource(read(), path);
    this.#entries.set(path, { mtimeMs, output });
    return output;
  }

  get size(): number {
    return this.#entries.size;
  }
}
