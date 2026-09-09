/**
 * The 15KB budget, measured honestly without a bundler.
 *
 * ## What this number is
 *
 * It walks the real module graph from an entry point, strips types, glues the
 * modules together, and gzips the result. No minification, no tree shaking,
 * no dead-code elimination, no mangling, and every doc comment still in place.
 *
 * That makes it an **upper bound**, and that is the point. A real bundler can
 * only make it smaller — esbuild with `--minify` on this kind of code
 * typically halves it before gzip — so if the upper bound is under budget, the
 * shipped bundle is under budget. A gate that can only be wrong in the
 * pessimistic direction is a gate worth having.
 *
 * ## What it is not
 *
 * Not the artifact anyone would ship, and not a substitute for measuring one.
 * It cannot detect a dependency that tree-shakes away cleanly, so it will
 * report a regression for code a bundler would have deleted. When the number
 * gets close to the budget, the answer is to run a real bundler, not to relax
 * this.
 *
 * The README says all of this too. A size number without its method is a
 * number people quote.
 */

import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { importSpecifiers, stripSource } from '../../devserver/src/strip.ts';

/** Gzipped bytes for core + nub. `docs/adr/0002` and the README both cite it. */
export const BUDGET_BYTES = 15 * 1024;

export interface ModuleSize {
  path: string;
  /** Bytes after type stripping and comment removal. */
  stripped: number;
}

export interface SizeReport {
  entry: string;
  modules: ModuleSize[];
  /** Source bytes on disk, all modules in the graph. */
  raw: number;
  /** Type-stripped and concatenated, comments intact. */
  stripped: number;
  /** The same, with comments removed. */
  code: number;
  /** Gzipped, comments intact. The pessimistic bound. */
  gzippedWithComments: number;
  /** Gzipped, comments removed. The number the budget is checked against. */
  gzipped: number;
  budget: number;
  withinBudget: boolean;
}

/**
 * Remove comments.
 *
 * Every minifier does this unconditionally, so counting comments against a
 * shipped-bundle budget measures the writing rather than the code — and this
 * repo's files are more comment than code by weight, which made the first
 * version of this report useless.
 *
 * Character-by-character rather than a regex, because the regex version gets
 * `'// not a comment'` and `/[/]/` wrong, and silently deleting the rest of a
 * line inside a string literal would understate the size.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const char = source[i] as string;
    const next = source[i + 1];

    if (char === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // A quote opens a literal; skip to its end so nothing inside is treated as
    // a comment. Template literals can nest expressions, but a `//` inside one
    // would have to be inside a nested string to matter, and this repo has
    // none — an over-count there would be conservative anyway.
    if (char === '"' || char === "'" || char === '`') {
      out += char;
      i++;
      while (i < n && source[i] !== char) {
        if (source[i] === '\\') {
          out += source[i] as string;
          i++;
        }
        if (i < n) {
          out += source[i] as string;
          i++;
        }
      }
      if (i < n) {
        out += char;
        i++;
      }
      continue;
    }

    out += char;
    i++;
  }

  // Collapse the blank lines the comments left behind.
  return out.replace(/\n[ \t]*(?=\n)/g, '').replace(/[ \t]+$/gm, '');
}

/**
 * Collect an entry point and everything it transitively imports **at runtime**.
 *
 * Imports are read off the *type-stripped* source, not the original. That
 * matters more than it sounds: `import type { Logger } from './log.ts'`
 * disappears entirely once types are gone, so a bundler never includes
 * `log.ts` at all. Scanning the raw file pulled in two modules that ship zero
 * bytes — `protocol.ts` is nothing but types — and inflated the report by a
 * fifth.
 *
 * Only relative specifiers are followed, which is exactly right here: a bare
 * specifier would mean a runtime dependency, and `@quorum/core` and
 * `@quorum/web` are supposed to have none. One showing up should be a loud
 * failure rather than a silently uncounted byte.
 */
export function collectModules(entry: string, read = (path: string): string => readFileSync(path, 'utf8')): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);

    for (const specifier of importSpecifiers(stripSource(read(path), path))) {
      if (!specifier.startsWith('.')) {
        throw new Error(`${path} imports "${specifier}" — this graph must have no dependencies`);
      }
      visit(resolve(dirname(path), specifier));
    }

    // Pushed after its imports so the concatenation is in dependency order,
    // which is what a bundler would emit.
    ordered.push(path);
  };

  visit(resolve(entry));
  return ordered;
}

export function measure(
  entry: string,
  options: { root?: string; budget?: number; read?: (path: string) => string } = {},
): SizeReport {
  const read = options.read ?? ((path: string): string => readFileSync(path, 'utf8'));
  const root = options.root ?? process.cwd();
  const budget = options.budget ?? BUDGET_BYTES;

  const paths = collectModules(entry, read);

  let raw = 0;
  const modules: ModuleSize[] = [];
  const withComments: string[] = [];
  const withoutComments: string[] = [];

  for (const path of paths) {
    const source = read(path);
    raw += Buffer.byteLength(source);

    // Import and export statements are dropped rather than rewritten. Keeping
    // them would make this a pile of separate modules, which is not what
    // ships; dropping them approximates a bundler's scope hoisting, and the
    // leftover identifiers do not change the byte count either way.
    const inlined = stripSource(source, path)
      .replace(/^[ \t]*import\s[^;]*?;/gm, '')
      .replace(/^[ \t]*import\s*['"][^'"]*['"]\s*;?/gm, '')
      .replace(/^[ \t]*export\s+(?=(?:const|function|class|let|var|async)\b)/gm, '')
      .replace(/^[ \t]*export\s*\{[^}]*\}\s*;?/gm, '');

    const code = stripComments(inlined);

    withComments.push(inlined);
    withoutComments.push(code);
    modules.push({ path: relative(root, path), stripped: Buffer.byteLength(code) });
  }

  const commented = withComments.join('\n');
  const bundle = withoutComments.join('\n');
  const gzipped = gzipSync(Buffer.from(bundle), { level: 9 }).length;

  return {
    entry: relative(root, resolve(entry)),
    modules: modules.sort((a, b) => b.stripped - a.stripped),
    raw,
    stripped: Buffer.byteLength(commented),
    code: Buffer.byteLength(bundle),
    gzippedWithComments: gzipSync(Buffer.from(commented), { level: 9 }).length,
    gzipped,
    budget,
    withinBudget: gzipped <= budget,
  };
}

export function formatReport(report: SizeReport): string {
  const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)}KB`;
  const lines: string[] = [];

  lines.push(`  entry       ${report.entry}`);
  lines.push(`  modules     ${String(report.modules.length)} reachable at runtime`);
  lines.push(`  source      ${kb(report.raw)} on disk`);
  lines.push(`  types out   ${kb(report.stripped)}`);
  lines.push(`  comments out ${kb(report.code)}`);
  lines.push('');
  lines.push(`  gzipped     ${kb(report.gzipped)}   against a ${kb(report.budget)} budget`);
  lines.push(`  (with comments kept, it would be ${kb(report.gzippedWithComments)})`);
  lines.push('');
  lines.push('  largest modules, types and comments removed:');
  for (const module of report.modules.slice(0, 8)) {
    lines.push(`    ${kb(module.stripped).padStart(7)}  ${module.path}`);
  }
  lines.push('');
  lines.push(
    report.withinBudget
      ? `  ${kb(report.budget - report.gzipped)} of headroom — and still an upper bound, since nothing here is minified or tree shaken.`
      : `  OVER BUDGET by ${kb(report.gzipped - report.budget)}. Measure with a real bundler before acting on it.`,
  );

  return lines.join('\n');
}
