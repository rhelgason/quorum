/**
 * The hybrid sweep: `semanticWeight` × `threshold`, scored on rank agreement.
 *
 * This is the missing half of `docs/adr/0019-embedding-quality-bar.md`. The
 * oracle ablation established that a *perfect* semantic signal takes the
 * pipeline from 5/10 to 10/10, so embeddings are worth building and the bar is
 * low. What it could not say is what a *real* model does, or how to blend it
 * with lexical, because neither had ever been run.
 *
 * ## Why a grid rather than a single number
 *
 * The two knobs interact, and not gently. Raising `semanticWeight` raises
 * every pairwise similarity, so a threshold tuned for lexical-only
 * over-merges the moment vectors are switched on. Reporting "model X scores
 * 7/10" at one arbitrary threshold measures the threshold as much as the
 * model. The grid makes that visible instead of hiding it in a single cell.
 *
 * ## Why rank agreement and not ARI
 *
 * ADR-0014, measured: tuning on ARI picks a configuration whose ranked list is
 * *worse*. ARI is reported here alongside, but only as a diagnostic — the
 * `best` this module returns is always by top-10 agreement.
 */

import { clusterDocs, type Doc } from '../../aggregate/src/cluster.ts';
import type { TokenizeOptions } from '../../aggregate/src/text.ts';
import { adjustedRandIndex, pairwise } from './metrics.ts';
import { topKAgreement } from './task-metrics.ts';
import type { Corpus } from './corpus.ts';
import { truthLabels } from './corpus.ts';

export interface SweepCell {
  semanticWeight: number;
  threshold: number;
  /** Top-`k` rank agreement. The number that decides. */
  hits: number;
  /** Adjusted Rand Index. Diagnostic only — see ADR-0014. */
  ari: number;
  /**
   * Pairwise precision: of the pairs this clustering put together, the
   * fraction that truly belong together. The conflation guard — see
   * "the degenerate zone" above.
   */
  precision: number;
  clusters: number;
  /** True when over-merging disqualified this cell from winning. */
  degenerate: boolean;
  /** Truth cluster ids the ranked list missed, worst first. */
  misses: string[];
}

export interface SweepResult {
  embedder: string;
  k: number;
  cells: SweepCell[];
  /** Highest `hits`; ties broken toward less semantic weight, then lower threshold. */
  best: SweepCell;
  /** The `semanticWeight: 0` row at the best threshold, for comparison. */
  lexicalBaseline: SweepCell;
  ceiling: number;
  /** How many clusters the corpus actually has. The over-merge yardstick. */
  truthClusters: number;
  /** Cells excluded from `best` for conflating more than the control. */
  disqualified: number;
}

export interface SweepOptions {
  semanticWeights?: readonly number[];
  thresholds?: readonly number[];
  k?: number;
  now?: string;
  tokenize?: TokenizeOptions;
  /**
   * How much pairwise precision a cell may give up against the lexical control
   * before it is treated as over-merged. Default 0.1 (ten percent).
   */
  precisionTolerance?: number;
}

/**
 * Default grid.
 *
 * `semanticWeight: 0` is always included and is not padding — it is the
 * control. Without a lexical-only row in the same run, on the same corpus,
 * with the same clock, there is no way to say whether the model helped.
 */
export const DEFAULT_SEMANTIC_WEIGHTS: readonly number[] = [0, 0.25, 0.5, 0.75, 1];
export const DEFAULT_THRESHOLDS: readonly number[] = [0.1, 0.2, 0.3, 0.4, 0.5];

/**
 * Run the grid.
 *
 * `docs` must already carry vectors. Embedding happens once, outside, because
 * the vectors are identical in every cell — see `embed-cache.ts` for why that
 * matters more than it sounds.
 */
export function sweep(
  corpus: Corpus,
  docs: readonly Doc[],
  embedderName: string,
  options: SweepOptions = {},
): SweepResult {
  const semanticWeights = options.semanticWeights ?? DEFAULT_SEMANTIC_WEIGHTS;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const k = options.k ?? 10;
  const now = options.now ?? '2026-09-01T00:00:00Z';
  const truth = truthLabels(corpus);

  const cells: SweepCell[] = [];

  for (const semanticWeight of semanticWeights) {
    for (const threshold of thresholds) {
      const labels = clusterDocs(docs, {
        threshold,
        semanticWeight,
        ...(options.tokenize !== undefined && { tokenize: options.tokenize }),
      }).labels;

      const report = topKAgreement(corpus, labels, k, now);
      cells.push({
        semanticWeight,
        threshold,
        hits: report.hits.length,
        ari: adjustedRandIndex(truth, labels),
        precision: pairwise(truth, labels).precision,
        clusters: new Set(labels).size,
        degenerate: false,
        misses: report.misses.slice(0, 2),
      });
    }
  }

  // The control: the best lexical-only cell, chosen the same way.
  const lexicalRow = cells.filter((cell) => cell.semanticWeight === 0);
  const lexicalBaseline = (
    lexicalRow.length > 0
      ? [...lexicalRow].sort((a, b) => b.hits - a.hits || a.threshold - b.threshold)[0]
      : cells[0]
  ) as SweepCell;

  // Anything that conflates more than the control is disqualified from
  // winning. Compared against the control rather than a fixed number, because
  // the right precision for a corpus is not knowable in advance — but "worse
  // than the thing you are replacing" always disqualifies.
  // Parenthesised deliberately: `??` binds looser than `-`, so
  // `1 - options.precisionTolerance ?? 0.1` evaluates to NaN when the option is
  // absent, every comparison against it is false, and the guard silently never
  // fires. Which is exactly the failure it exists to prevent.
  const floor = lexicalBaseline.precision * (1 - (options.precisionTolerance ?? 0.1));
  for (const cell of cells) cell.degenerate = cell.precision < floor;

  // Ties break toward *less* machinery: the same score with a lower semantic
  // weight is a better result, because it is cheaper, has no model dependency,
  // and degrades to lexical without changing behaviour.
  const rank = (a: SweepCell, b: SweepCell): number =>
    b.hits - a.hits || a.semanticWeight - b.semanticWeight || a.threshold - b.threshold;

  const eligible = cells.filter((cell) => !cell.degenerate);
  const best = ([...(eligible.length > 0 ? eligible : cells)].sort(rank)[0]) as SweepCell;

  return {
    embedder: embedderName,
    k,
    cells,
    best,
    lexicalBaseline,
    ceiling: topKAgreement(corpus, truth, k, now).hits.length,
    truthClusters: new Set(truth).size,
    disqualified: cells.filter((cell) => cell.degenerate).length,
  };
}

/** The grid, as a table. Rows are semantic weight, columns are threshold. */
export function formatSweep(result: SweepResult): string {
  const thresholds = [...new Set(result.cells.map((c) => c.threshold))].sort((a, b) => a - b);
  const weights = [...new Set(result.cells.map((c) => c.semanticWeight))].sort((a, b) => a - b);

  const lines: string[] = [];
  lines.push(`  embedder: ${result.embedder}   ceiling ${String(result.ceiling)}/${String(result.k)}`);
  lines.push('');
  const grid = (
    title: string,
    render: (cell: SweepCell) => string,
  ): void => {
    lines.push(`  ${title}`);
    lines.push(`  semanticWeight  ${thresholds.map((t) => t.toFixed(2).padStart(7)).join('')}`);
    for (const weight of weights) {
      const rendered = thresholds.map((threshold) => {
        const cell = result.cells.find(
          (c) => c.semanticWeight === weight && c.threshold === threshold,
        );
        return cell === undefined ? '      -' : render(cell).padStart(7);
      });
      const label = weight === 0 ? `${weight.toFixed(2)} (lex)` : weight.toFixed(2);
      lines.push(`  ${label.padEnd(14)}${rendered.join('')}`);
    }
    lines.push('');
  };

  // A `!` marks a cell disqualified for conflating more than lexical does.
  // Printed rather than filtered out, because "the best score is in a cell we
  // refuse to use" is the interesting part of the result, not a detail.
  grid(`top-${String(result.k)} agreement (! = over-merged)`, (cell) =>
    `${String(cell.hits)}${cell.degenerate ? '!' : ''}`,
  );
  grid(`clusters found (truth has ${String(result.truthClusters)})`, (cell) => String(cell.clusters));
  grid('pairwise precision', (cell) => cell.precision.toFixed(2));

  lines.push(
    `  best  ${String(result.best.hits)}/${String(result.k)} at semanticWeight=${result.best.semanticWeight.toFixed(2)} threshold=${result.best.threshold.toFixed(2)}` +
      `  (${String(result.best.clusters)} clusters vs ${String(result.truthClusters)} true, precision ${result.best.precision.toFixed(2)}, ARI ${result.best.ari.toFixed(3)})`,
  );

  const topRaw = [...result.cells].sort((a, b) => b.hits - a.hits)[0] as SweepCell;
  if (topRaw.degenerate) {
    lines.push(
      `  ${String(result.disqualified)} cell(s) scored higher and were disqualified for over-merging — ` +
        `the top raw score was ${String(topRaw.hits)}/${String(result.k)} from only ${String(topRaw.clusters)} clusters ` +
        `(precision ${topRaw.precision.toFixed(2)} vs lexical ${result.lexicalBaseline.precision.toFixed(2)}).`,
    );
  }
  if (result.best.misses.length > 0) {
    lines.push(`        still missing: ${result.best.misses.join(', ')}`);
  }

  const delta = result.best.hits - result.lexicalBaseline.hits;
  lines.push(
    `  lexical-only best is ${String(result.lexicalBaseline.hits)}/${String(result.k)}, so the embedder is worth ` +
      `${delta >= 0 ? '+' : ''}${String(delta)}`,
  );

  // The check that catches a broken blend, stated rather than left to the
  // reader: ARI and rank agreement disagree often enough that reporting only
  // the winner hides it (ADR-0014).
  const bestByAri = [...result.cells].sort((a, b) => b.ari - a.ari)[0] as SweepCell;
  if (bestByAri.hits < result.best.hits) {
    lines.push(
      `  note: best ARI (${bestByAri.ari.toFixed(3)} at w=${bestByAri.semanticWeight.toFixed(2)} ` +
        `t=${bestByAri.threshold.toFixed(2)}) scores only ${String(bestByAri.hits)}/${String(result.k)} — tuning on ARI still picks worse.`,
    );
  }

  return lines.join('\n');
}
