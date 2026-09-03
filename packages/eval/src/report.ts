/**
 * Scoring runners and text formatting.
 *
 * Pure functions only — the console entrypoint lives in `cli.ts`. Run it with
 * `node packages/eval/src/cli.ts`.
 */

import { truthLabels, type Corpus } from './corpus.ts';
import { diagnose, evaluate, type EvalReport } from './metrics.ts';
import { scoreHardPairs, type HardPairReport } from './hard-pairs.ts';
import type { Clusterer } from './baselines.ts';
import { topKAgreement } from './task-metrics.ts';
import { groupSubmissionIds, toDocs, toRankableClusters } from './adapt.ts';
import { medoid } from '../../aggregate/src/cluster.ts';
import { explain, rank } from '../../aggregate/src/rank.ts';

export interface RunResult {
  name: string;
  metrics: EvalReport;
  hardPairs: HardPairReport;
}

export function run(corpus: Corpus, name: string, clusterer: Clusterer): RunResult {
  const predicted = clusterer(corpus.submissions);
  return {
    name,
    metrics: evaluate(truthLabels(corpus), predicted),
    hardPairs: scoreHardPairs(corpus, predicted),
  };
}

export interface SubsetResult {
  name: string;
  metrics: EvalReport;
}

/**
 * Score a clusterer over a slice of the corpus.
 *
 * A single aggregate number hides that a method can be excellent on one class
 * of feedback and useless on another — which turns out to be exactly the case
 * for structural clustering.
 */
export function runSubset(
  corpus: Corpus,
  name: string,
  clusterer: Clusterer,
  predicate: (s: Corpus['submissions'][number]) => boolean,
): SubsetResult {
  const subset = corpus.submissions.filter(predicate);
  const predicted = clusterer(subset);
  return {
    name,
    metrics: evaluate(
      subset.map((s) => s.cluster),
      predicted,
    ),
  };
}

export function formatSubsetTable(results: readonly SubsetResult[]): string {
  const header = '  slice                        items  clusters     ARI      F1   preP   preR';
  const rule = '  ' + '-'.repeat(header.length - 2);
  const rows = results.map((r) => {
    const m = r.metrics;
    return [
      '  ',
      r.name.padEnd(26),
      String(m.items).padStart(5),
      String(m.predictedClusters).padStart(9),
      pct(m.adjustedRandIndex),
      pct(m.pairwise.f1),
      pct(m.pairwise.precision).slice(1),
      pct(m.pairwise.recall).slice(1),
    ].join(' ');
  });
  return [header, rule, ...rows].join('\n');
}

function pct(n: number): string {
  return n.toFixed(3).padStart(6);
}

export function formatTable(results: readonly RunResult[]): string {
  const header =
    '  method                     clusters     ARI      F1   preP   preR    hom   comp   pairs';
  const rule = '  ' + '-'.repeat(header.length - 2);
  const rows = results.map((r) => {
    const m = r.metrics;
    return [
      '  ',
      r.name.padEnd(24),
      String(m.predictedClusters).padStart(8),
      pct(m.adjustedRandIndex),
      pct(m.pairwise.f1),
      pct(m.pairwise.precision).slice(1),
      pct(m.pairwise.recall).slice(1),
      pct(m.v.homogeneity).slice(1),
      pct(m.v.completeness).slice(1),
      `${r.hardPairs.correct}/${r.hardPairs.total}`.padStart(8),
    ].join(' ');
  });
  return [header, rule, ...rows].join('\n');
}

export function formatDiagnosis(corpus: Corpus, clusterer: Clusterer, limit = 4): string {
  const predicted = clusterer(corpus.submissions);
  const d = diagnose(truthLabels(corpus), predicted);
  const lines: string[] = [];

  lines.push('  worst over-merges (predicted cluster mixing true clusters):');
  for (const m of d.merges.slice(0, limit)) {
    lines.push(`    ${m.size} items from ${m.sources.length}: ${m.sources.map((s) => `${s.trueCluster}×${s.count}`).join(', ')}`);
  }
  lines.push(`  worst splits (true cluster scattered):`);
  for (const s of d.splits.slice(0, limit)) {
    lines.push(`    ${s.trueCluster} (${s.size} items) → ${s.fragments.length} fragments`);
  }
  return lines.join('\n');
}

export function formatTraps(result: RunResult): string {
  return result.hardPairs.byTrap
    .map((t) => `    ${t.trap.padEnd(32)} ${t.correct}/${t.total}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Rank agreement reporting — the headline. See ADR-0014.
// ---------------------------------------------------------------------------

export function formatRankTable(
  corpus: Corpus,
  now: string,
  methods: readonly (readonly [string, () => string[]])[],
): string {
  const header = '  method                        ARI   top10  capture  biggest misses';
  const rule = '  ' + '-'.repeat(header.length - 2);
  const rows = methods.map(([name, produce]) => {
    const labels = produce();
    const m = evaluate(truthLabels(corpus), labels);
    const t = topKAgreement(corpus, labels, 10, now);
    return [
      '  ',
      name.padEnd(24),
      m.adjustedRandIndex.toFixed(3).padStart(7),
      `${t.hits.length}/10`.padStart(7),
      t.meanCapture.toFixed(2).padStart(8),
      ` ${t.misses.slice(0, 2).join(', ')}`,
    ].join(' ');
  });
  return [header, rule, ...rows].join('\n');
}

/**
 * The product output: a ranked backlog with a medoid label and an
 * explanation of the score.
 *
 * Every row is traceable — a real user sentence as the title, and the score
 * broken into its inputs. No generated text anywhere, which is the no-LLM
 * fallback path working end to end.
 */
export function formatRankedList(
  corpus: Corpus,
  labels: readonly string[],
  now: string,
  limit: number,
): string {
  const bodyById = new Map(corpus.submissions.map((s) => [s.id, s.body]));
  const docs = toDocs(corpus.submissions);
  const memberIds = groupSubmissionIds(corpus.submissions, labels);
  const ranked = rank(toRankableClusters(corpus.submissions, labels), { now });

  const lines: string[] = [];
  ranked.slice(0, limit).forEach((entry, i) => {
    const ids = memberIds.get(entry.id) ?? [];
    const label = medoid(ids, docs, { threshold: 0 });
    const title = label === undefined ? '(no members)' : (bodyById.get(label) ?? label);
    lines.push(`  ${String(i + 1).padStart(2)}. [${entry.score.toFixed(2).padStart(6)}] ${title}`);
    lines.push(`      ${explain(entry)}`);
  });
  return lines.join('\n');
}
