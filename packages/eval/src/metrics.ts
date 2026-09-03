/**
 * Clustering evaluation metrics.
 *
 * Every threshold in Quorum's aggregation pipeline — the LSH cutoff, the
 * lexical:semantic weighting, the leader-follower similarity floor, HDBSCAN's
 * `min_cluster_size` — is unfalsifiable without these. See
 * `docs/adr/0005-deterministic-core-llm-at-render-edge.md`.
 *
 * Definitions match scikit-learn's (`adjusted_rand_score`, `v_measure_score`)
 * so numbers here are comparable to published baselines and to anything the
 * Python aggregator produces. The test suite pins several values against
 * scikit-learn's documented outputs.
 *
 * Why three metrics rather than one:
 *
 *  - **Pairwise F1** is the one to reason about intuitively — precision is
 *    "when we merged two items, were we right", recall is "of the items that
 *    belong together, how many did we find". Splits and merges are visible
 *    separately, which is what you need when tuning a threshold in one
 *    direction.
 *  - **ARI** is chance-corrected. Without that correction, shattering
 *    everything into singletons scores deceptively well on some measures.
 *    ARI goes to ~0 for random labelings and can go negative for
 *    worse-than-random.
 *  - **V-measure** decomposes into homogeneity (no cluster mixes topics) and
 *    completeness (no topic is split across clusters). Those map directly onto
 *    the two failure modes we actually care about: over-merging, which is what
 *    embeddings alone do, and chaining, which is what single-linkage does.
 *
 * A scalar is for tracking regressions. For tuning, use `diagnose()` — knowing
 * *which* clusters merged wrongly beats knowing that ARI dropped 0.03.
 */

/** A clustering: one label per item, index-aligned across truth and prediction. */
export type Labels = readonly (string | number)[];

export interface PairwiseScore {
  precision: number;
  recall: number;
  f1: number;
  /** Pairs correctly placed together. */
  truePositives: number;
  /** Pairs wrongly merged — the over-merge count. */
  falsePositives: number;
  /** Pairs wrongly separated — the split count. */
  falseNegatives: number;
}

export interface VMeasureScore {
  homogeneity: number;
  completeness: number;
  vMeasure: number;
}

export interface EvalReport {
  items: number;
  trueClusters: number;
  predictedClusters: number;
  adjustedRandIndex: number;
  pairwise: PairwiseScore;
  v: VMeasureScore;
}

export interface MetricOptions {
  /**
   * Label meaning "unassigned" — HDBSCAN emits -1. Noise items are expanded
   * into unique singleton clusters rather than pooled, because pooling would
   * score every unrelated outlier as deliberately grouped together and inflate
   * the result.
   */
  noiseLabel?: string | number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** n choose 2. */
function choose2(n: number): number {
  return (n * (n - 1)) / 2;
}

function assertAligned(truth: Labels, predicted: Labels): void {
  if (truth.length !== predicted.length) {
    throw new Error(
      `label arrays must be the same length: got ${truth.length} truth and ${predicted.length} predicted`,
    );
  }
}

/**
 * Replace each noise-labeled item with a unique label. Mutating a copy keeps
 * the caller's arrays untouched.
 */
function expandNoise(labels: Labels, noiseLabel: string | number | undefined): Labels {
  if (noiseLabel === undefined) return labels;
  let n = 0;
  return labels.map((l) => (l === noiseLabel ? `__noise_${n++}__` : l));
}

/** Cluster label to member indices. Insertion-ordered, so output is stable. */
function group(labels: Labels): Map<string | number, number[]> {
  const out = new Map<string | number, number[]>();
  for (let i = 0; i < labels.length; i++) {
    const key = labels[i] as string | number;
    const bucket = out.get(key);
    if (bucket === undefined) out.set(key, [i]);
    else bucket.push(i);
  }
  return out;
}

/** contingency[truthLabel][predLabel] = overlap count. */
function contingency(
  truth: Labels,
  predicted: Labels,
): Map<string | number, Map<string | number, number>> {
  const table = new Map<string | number, Map<string | number, number>>();
  for (let i = 0; i < truth.length; i++) {
    const t = truth[i] as string | number;
    const p = predicted[i] as string | number;
    let row = table.get(t);
    if (row === undefined) {
      row = new Map();
      table.set(t, row);
    }
    row.set(p, (row.get(p) ?? 0) + 1);
  }
  return table;
}

/** Natural-log entropy of a label distribution. Returns 0 for a single cluster. */
function entropy(labels: Labels): number {
  const n = labels.length;
  if (n === 0) return 0;
  let h = 0;
  for (const members of group(labels).values()) {
    const p = members.length / n;
    if (p > 0) h -= p * Math.log(p);
  }
  return h;
}

/** Conditional entropy H(A|B). */
function conditionalEntropy(a: Labels, b: Labels): number {
  const n = a.length;
  if (n === 0) return 0;
  const table = contingency(b, a); // rows keyed by B, so we condition on B
  let h = 0;
  for (const row of table.values()) {
    let rowTotal = 0;
    for (const count of row.values()) rowTotal += count;
    for (const count of row.values()) {
      if (count > 0) h -= (count / n) * Math.log(count / rowTotal);
    }
  }
  return h;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Adjusted Rand index. 1.0 is identical, ~0 is chance, negative is
 * worse than chance.
 */
export function adjustedRandIndex(
  truthIn: Labels,
  predictedIn: Labels,
  options: MetricOptions = {},
): number {
  assertAligned(truthIn, predictedIn);
  const truth = expandNoise(truthIn, options.noiseLabel);
  const predicted = expandNoise(predictedIn, options.noiseLabel);

  const n = truth.length;
  if (n === 0) return 1;

  let sumCells = 0;
  for (const row of contingency(truth, predicted).values()) {
    for (const count of row.values()) sumCells += choose2(count);
  }

  let sumTruth = 0;
  for (const members of group(truth).values()) sumTruth += choose2(members.length);

  let sumPred = 0;
  for (const members of group(predicted).values()) sumPred += choose2(members.length);

  const total = choose2(n);
  if (total === 0) return 1;

  const expected = (sumTruth * sumPred) / total;
  const max = (sumTruth + sumPred) / 2;

  // Degenerate case: both labelings are all-one-cluster or all-singletons, so
  // there is no variance to correct against. scikit-learn returns 1.0 when the
  // labelings agree, which they necessarily do here.
  if (max === expected) return 1;

  return (sumCells - expected) / (max - expected);
}

/**
 * Pairwise precision / recall / F1 over the set of co-clustered pairs.
 *
 * `falsePositives` is the over-merge count and `falseNegatives` the split
 * count — read them separately when deciding which way to move a threshold.
 */
export function pairwise(
  truthIn: Labels,
  predictedIn: Labels,
  options: MetricOptions = {},
): PairwiseScore {
  assertAligned(truthIn, predictedIn);
  const truth = expandNoise(truthIn, options.noiseLabel);
  const predicted = expandNoise(predictedIn, options.noiseLabel);

  let truePositives = 0;
  for (const row of contingency(truth, predicted).values()) {
    for (const count of row.values()) truePositives += choose2(count);
  }

  let predPairs = 0;
  for (const members of group(predicted).values()) predPairs += choose2(members.length);

  let truthPairs = 0;
  for (const members of group(truth).values()) truthPairs += choose2(members.length);

  const falsePositives = predPairs - truePositives;
  const falseNegatives = truthPairs - truePositives;

  // No predicted pairs means precision is vacuous; define it as 1 so that an
  // all-singletons prediction is punished through recall alone rather than
  // twice.
  const precision = predPairs === 0 ? 1 : truePositives / predPairs;
  const recall = truthPairs === 0 ? 1 : truePositives / truthPairs;
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { precision, recall, f1, truePositives, falsePositives, falseNegatives };
}

/**
 * Homogeneity, completeness, and their harmonic mean.
 *
 * Homogeneity falls when a predicted cluster mixes topics (over-merging).
 * Completeness falls when one topic is spread across predicted clusters
 * (splitting). They move in opposite directions as a similarity threshold
 * changes, which is exactly why both are reported.
 */
export function vMeasure(
  truthIn: Labels,
  predictedIn: Labels,
  options: MetricOptions = {},
): VMeasureScore {
  assertAligned(truthIn, predictedIn);
  const truth = expandNoise(truthIn, options.noiseLabel);
  const predicted = expandNoise(predictedIn, options.noiseLabel);

  if (truth.length === 0) return { homogeneity: 1, completeness: 1, vMeasure: 1 };

  const hTruth = entropy(truth);
  const hPred = entropy(predicted);

  // A degenerate labeling carries no information to lose, so the corresponding
  // score is perfect by convention (matches scikit-learn).
  const homogeneity =
    hTruth === 0 ? 1 : 1 - conditionalEntropy(truth, predicted) / hTruth;
  const completeness =
    hPred === 0 ? 1 : 1 - conditionalEntropy(predicted, truth) / hPred;

  const denominator = homogeneity + completeness;
  const v = denominator === 0 ? 0 : (2 * homogeneity * completeness) / denominator;

  return { homogeneity, completeness, vMeasure: v };
}

/** All three metrics plus cluster counts. */
export function evaluate(
  truth: Labels,
  predicted: Labels,
  options: MetricOptions = {},
): EvalReport {
  assertAligned(truth, predicted);
  const t = expandNoise(truth, options.noiseLabel);
  const p = expandNoise(predicted, options.noiseLabel);
  return {
    items: truth.length,
    trueClusters: group(t).size,
    predictedClusters: group(p).size,
    adjustedRandIndex: adjustedRandIndex(t, p),
    pairwise: pairwise(t, p),
    v: vMeasure(t, p),
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface SplitDiagnosis {
  /** A true cluster scattered across several predicted clusters. */
  trueCluster: string | number;
  size: number;
  /** Predicted clusters it landed in, largest share first. */
  fragments: { predictedCluster: string | number; count: number }[];
}

export interface MergeDiagnosis {
  /** A predicted cluster containing items from several true clusters. */
  predictedCluster: string | number;
  size: number;
  /** True clusters mixed into it, largest share first. */
  sources: { trueCluster: string | number; count: number }[];
}

export interface Diagnosis {
  splits: SplitDiagnosis[];
  merges: MergeDiagnosis[];
}

/**
 * Which clusters actually went wrong, worst first.
 *
 * This is the output to look at when tuning. A scalar tells you the run got
 * worse; this tells you that "CSV export" and "CSV export drops the last row"
 * merged, which points at the fix.
 */
export function diagnose(
  truthIn: Labels,
  predictedIn: Labels,
  options: MetricOptions = {},
): Diagnosis {
  assertAligned(truthIn, predictedIn);
  const truth = expandNoise(truthIn, options.noiseLabel);
  const predicted = expandNoise(predictedIn, options.noiseLabel);

  const byTruth = contingency(truth, predicted);
  const byPred = contingency(predicted, truth);

  const splits: SplitDiagnosis[] = [];
  for (const [trueCluster, row] of byTruth) {
    if (row.size < 2) continue;
    const fragments = [...row.entries()]
      .map(([predictedCluster, count]) => ({ predictedCluster, count }))
      .sort((a, b) => b.count - a.count);
    const size = fragments.reduce((sum, f) => sum + f.count, 0);
    splits.push({ trueCluster, size, fragments });
  }

  const merges: MergeDiagnosis[] = [];
  for (const [predictedCluster, row] of byPred) {
    if (row.size < 2) continue;
    const sources = [...row.entries()]
      .map(([trueCluster, count]) => ({ trueCluster, count }))
      .sort((a, b) => b.count - a.count);
    const size = sources.reduce((sum, s) => sum + s.count, 0);
    merges.push({ predictedCluster, size, sources });
  }

  // Worst first: most fragments, then largest. Deterministic ordering matters
  // because these reports get diffed between runs.
  splits.sort((a, b) => b.fragments.length - a.fragments.length || b.size - a.size);
  merges.sort((a, b) => b.sources.length - a.sources.length || b.size - a.size);

  return { splits, merges };
}
