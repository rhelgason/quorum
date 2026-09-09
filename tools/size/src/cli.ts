/**
 * ```
 * npm run size
 * ```
 *
 * Console plumbing over `measure.ts`, and excluded from coverage for the same
 * reason every other `cli.ts` here is.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { BUDGET_BYTES, formatReport, measure } from './measure.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// The element, not the package barrel.
//
// `index.ts` re-exports every module for people who want the pieces, and a
// static re-export pulls the picker and the frustration detector back into the
// graph — so measuring from there reports the whole library and makes lazy
// loading invisible. What the 15KB budget is about is the script tag: the
// element and what it needs to render, which is exactly `nub.ts`.
const entry = process.argv[2] ?? join(repoRoot, 'packages/web/src/nub.ts');

const report = measure(entry, { root: repoRoot, budget: BUDGET_BYTES });

console.log(`\n  Quorum size budget — core + nub\n`);
console.log(formatReport(report));
console.log('');

process.exit(report.withinBudget ? 0 : 1);
