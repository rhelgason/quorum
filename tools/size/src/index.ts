/**
 * `@quorum/size` — an upper bound on the shipped bundle, measured without a
 * bundler. See `measure.ts` for what the number does and does not mean.
 */

export { BUDGET_BYTES, collectModules, formatReport, measure } from './measure.ts';
export type { ModuleSize, SizeReport } from './measure.ts';
