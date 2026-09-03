/**
 * Online leader-follower clustering.
 *
 * An arriving submission is compared against stored centroids; if the best
 * match clears a threshold it joins that cluster and updates the centroid,
 * otherwise it seeds a new one. O(clusters) per item, real-time, and — the
 * property that matters — **stable by construction**: existing assignments
 * never change, so a PM's top-ten list doesn't reshuffle overnight.
 *
 * Re-clustering from scratch on every run is what makes those lists churn
 * until nobody trusts them. See `docs/adr/0005-deterministic-core-llm-at-render-edge.md`.
 *
 * The cost of stability is order dependence: the same items in a different
 * order can produce different clusters. That's accepted deliberately, and it's
 * why the offline HDBSCAN/Leiden pass exists to propose repairs — it is not a
 * bug to be fixed by sorting.
 */

import { Centroid, cosine, vectorize, type IdfTable, type SparseVector } from './vector.ts';
import { tokenize, type TokenizeOptions } from './text.ts';
import { DenseCentroid, denseCosine } from './embed.ts';

export interface Doc {
  id: string;
  text: string;
  /** Structural context. Used only when `structuralBonus` is enabled. */
  route?: string;
  appVersion?: string;
  platform?: string;
  /**
   * Precomputed sentence embedding, L2-normalized.
   *
   * Supplied by the caller rather than fetched here, because embedding is
   * async and batched while clustering is synchronous and per-item. Ingest
   * embeds a batch, then clusters.
   */
  vector?: Float64Array;
}

export interface ClusterOptions {
  /**
   * Cosine similarity required to join an existing cluster.
   *
   * The single most consequential number in the pipeline. Do not hand-pick it:
   * sweep it against the eval corpus and read the precision/recall curve.
   */
  threshold: number;
  tokenize?: TokenizeOptions;
  /**
   * Additive bonus when an item shares route + version with a cluster's
   * plurality. Default 0 — measurement showed structural signal helps defects
   * and actively hurts feature requests
   * (`docs/adr/0013-structural-clustering-is-a-regression-detector.md`), so it
   * is off unless a caller opts in for a bug-only pass.
   */
  structuralBonus?: number;
  /** Precomputed IDF. Omit to derive it from the input batch. */
  idf?: IdfTable;
  /**
   * Weight on the semantic signal, 0..1. Default 0 (lexical only).
   *
   * `similarity = (1 - w) * lexical + w * semantic`
   *
   * Blended rather than either/or because the two fail differently: embeddings
   * bridge paraphrase but over-merge adjacent topics ("dark mode" with "light
   * mode"), while lexical is precise on shared product nouns and blind to
   * rewording. Documents without a `vector` fall back to lexical-only scoring,
   * so a partially-embedded batch still clusters.
   */
  semanticWeight?: number;
}

export interface ClusterAssignment {
  docId: string;
  clusterId: string;
  /** Similarity at assignment time. 0 when the doc seeded a new cluster. */
  similarity: number;
}

export interface ClusterResult {
  assignments: ClusterAssignment[];
  /** Cluster id → member doc ids, in arrival order. */
  clusters: Map<string, string[]>;
  /** Index-aligned with the input docs, for the eval harness. */
  labels: string[];
}

interface LiveCluster {
  id: string;
  centroid: Centroid;
  dense: DenseCentroid;
  /** Counts of `route|version` among members, for the structural bonus. */
  structure: Map<string, number>;
}

function structuralKey(doc: Doc): string {
  return `${doc.platform ?? ''}|${doc.route ?? ''}|${doc.appVersion ?? ''}`;
}

/** Share of a cluster's members sitting on the same route + version as `doc`. */
function structuralAgreement(cluster: LiveCluster, doc: Doc): number {
  const key = structuralKey(doc);
  let total = 0;
  for (const count of cluster.structure.values()) total += count;
  if (total === 0) return 0;
  return (cluster.structure.get(key) ?? 0) / total;
}

export function clusterDocs(docs: readonly Doc[], options: ClusterOptions): ClusterResult {
  const tokenOptions = options.tokenize ?? {};
  const structuralBonus = options.structuralBonus ?? 0;
  const semanticWeight = Math.min(1, Math.max(0, options.semanticWeight ?? 0));

  const tokenized = docs.map((d) => tokenize(d.text, tokenOptions));
  const idf = options.idf ?? buildIdfFrom(tokenized);
  const vectors = tokenized.map((t) => vectorize(t, idf));

  const live: LiveCluster[] = [];
  const assignments: ClusterAssignment[] = [];
  const clusters = new Map<string, string[]>();
  const labels: string[] = [];

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i] as Doc;
    const vector = vectors[i] as SparseVector;

    let best: LiveCluster | undefined;
    let bestScore = -1;

    for (const candidate of live) {
      const lexical = cosine(vector, candidate.centroid.vector());

      // Blend only when both sides actually carry a semantic vector. Treating
      // a missing embedding as similarity 0 would penalise it rather than
      // simply not counting it.
      const candidateDense = candidate.dense.vector();
      const canBlend =
        semanticWeight > 0 && doc.vector !== undefined && candidateDense !== undefined;

      let score = canBlend
        ? (1 - semanticWeight) * lexical +
          semanticWeight * denseCosine(doc.vector as Float64Array, candidateDense as Float64Array)
        : lexical;

      if (structuralBonus > 0) {
        score += structuralBonus * structuralAgreement(candidate, doc);
      }
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    // An empty lexical vector means every token was out-of-vocabulary or
    // stopped out. Such a doc matches everything at 0 and nothing meaningfully,
    // so it seeds its own cluster rather than being dumped into whichever
    // cluster happens to be first — unless it carries an embedding, which is
    // precisely the case semantic similarity exists to rescue.
    const hasSignal = vector.size > 0 || (semanticWeight > 0 && doc.vector !== undefined);

    if (best !== undefined && hasSignal && bestScore >= options.threshold) {
      best.centroid.add(vector);
      if (doc.vector !== undefined) best.dense.add(doc.vector);
      const key = structuralKey(doc);
      best.structure.set(key, (best.structure.get(key) ?? 0) + 1);
      clusters.get(best.id)?.push(doc.id);
      assignments.push({ docId: doc.id, clusterId: best.id, similarity: bestScore });
      labels.push(best.id);
    } else {
      const id = `c${live.length}`;
      const centroid = new Centroid();
      centroid.add(vector);
      const dense = new DenseCentroid();
      if (doc.vector !== undefined) dense.add(doc.vector);
      live.push({ id, centroid, dense, structure: new Map([[structuralKey(doc), 1]]) });
      clusters.set(id, [doc.id]);
      assignments.push({ docId: doc.id, clusterId: id, similarity: 0 });
      labels.push(id);
    }
  }

  return { assignments, clusters, labels };
}

function buildIdfFrom(tokenized: readonly (readonly string[])[]): IdfTable {
  const df = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = tokenized.length;
  const idf: IdfTable = new Map();
  for (const [term, count] of df) idf.set(term, Math.log(1 + n / (1 + count)));
  return idf;
}

/**
 * The submission closest to its cluster centroid — a free, human-written,
 * inherently auditable label.
 *
 * This is the no-LLM fallback path from
 * `docs/adr/0005-deterministic-core-llm-at-render-edge.md`. When generation is
 * unavailable, disabled, or forbidden, the product shows a real sentence a real
 * user wrote instead of going blank.
 */
export function medoid(
  memberIds: readonly string[],
  docs: readonly Doc[],
  options: ClusterOptions,
): string | undefined {
  if (memberIds.length === 0) return undefined;

  // Resolve before any fast path. A single-member shortcut that returns the id
  // without checking it exists will happily hand back a dangling reference.
  const byId = new Map(docs.map((d) => [d.id, d]));
  const members = memberIds.map((id) => byId.get(id)).filter((d): d is Doc => d !== undefined);
  if (members.length === 0) return undefined;
  if (members.length === 1) return members[0]?.id;

  const tokenOptions = options.tokenize ?? {};
  const tokenized = members.map((d) => tokenize(d.text, tokenOptions));
  const idf = options.idf ?? buildIdfFrom(tokenized);
  const vectors = members.map((_, i) => vectorize(tokenized[i] as string[], idf));

  const centroid = new Centroid();
  for (const v of vectors) centroid.add(v);
  const center = centroid.vector();

  let bestId = members[0]?.id;
  let bestScore = -1;
  for (let i = 0; i < members.length; i++) {
    const score = cosine(vectors[i] as SparseVector, center);
    if (score > bestScore) {
      bestScore = score;
      bestId = members[i]?.id;
    }
  }
  return bestId;
}
