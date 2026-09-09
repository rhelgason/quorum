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
const entry = process.argv[2] ?? join(repoRoot, 'packages/web/src/index.ts');

const report = measure(entry, { root: repoRoot, budget: BUDGET_BYTES });

console.log(`\n  Quorum size budget — core + nub\n`);
console.log(formatReport(report));
console.log('');

process.exit(report.withinBudget ? 0 : 1);
