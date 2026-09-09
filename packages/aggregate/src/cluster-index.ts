/**
 * Incremental cluster assignment with persistable state.
 *
 * `clusterDocs` clusters a corpus from scratch. That is right for the eval
 * harness and wrong for a service: `services/api` recomputed the entire
 * pipeline on every `GET /v0/issues`, so a read cost O(corpus) instead of
 * O(new), and — worse — the IDF table shifted as the corpus grew, so a full
 * recompute could move an assignment made weeks ago. A ranked list whose rows
 * quietly reorganise between two page loads is not one anybody trusts.
 *
 * This is the same leader-follower algorithm, turned inside out: state lives
 * across calls instead of inside one loop, and can be written to disk.
 *
 * ## The IDF trade, stated plainly
 *
 * Term frequencies update as documents arrive, so a document is vectorized
 * against the IDF **as of the moment it was added**. Centroids therefore
 * accumulate vectors computed under slightly different weightings.
 *
 * That is an approximation, and it is the deliberate one. The alternative —
 * recomputing IDF and revectorizing everything — is exactly the churn this
 * exists to stop. Leader-follower never reassigns an existing member, so an
 * assignment is permanent once made; what drifts is the *weighting* future
 * comparisons use, which affects only where new documents land. Stability of
 * what a user already saw wins over marginal accuracy on what they have not.
 *
 * Pass a fixed `idf` to opt out. With one, this produces assignments
 * **identical** to `clusterDocs` over the same documents in the same order,
 * which is the property its tests pin.
 *
 * ## What still needs the offline pass
 *
 * Nothing here merges or splits clusters. Online assignment over-splits by
 * design — a high threshold buys order-robustness — and
 * [ADR-0018](../../../docs/adr/0018-two-tier-clustering-validated.md) recovers
 * the recall with an offline consolidation pass. That pass still runs over the
 * result; this only removes the need to re-derive the online tier every time.
 */

import { DenseCentroid, denseCosine } from './embed.ts';
import { tokenize, type TokenizeOptions } from './text.ts';
import { Centroid, cosine, vectorize, type IdfTable, type SparseVector } from './vector.ts';
import type { ClusterAssignment, Doc } from './cluster.ts';

export interface ClusterIndexOptions {
  /** Cosine similarity required to join. Same meaning as `ClusterOptions`. */
  threshold: number;
  tokenize?: TokenizeOptions;
  /** Weight on semantic similarity, 0..1. */
  semanticWeight?: number;
  /** Structural bonus. Default 0 — helps defects, hurts feature requests. */
  structuralBonus?: number;
  /**
   * A frozen IDF table. When given, term statistics stop updating and this
   * matches `clusterDocs` exactly.
   */
  idf?: IdfTable;
}

/** Everything needed to rebuild an index, as plain JSON. */
export interface SerializedClusterIndex {
  version: 1;
  docCount: number;
  nextId: number;
  /** Document frequency per term. */
  df: [string, number][];
  clusters: SerializedCluster[];
}

export interface SerializedCluster {
  id: string;
  memberIds: string[];
  /** Unnormalized centroid sum, and the count it is a sum over. */
  sum: [string, number][];
  count: number;
  dense?: { sum: number[]; count: number };
  structure: [string, number][];
}

interface IndexedCluster {
  id: string;
  memberIds: string[];
  centroid: Centroid;
  dense: DenseCentroid;
  structure: Map<string, number>;
}

function structuralKey(doc: Doc): string {
  return `${doc.platform ?? ''}|${doc.route ?? ''}|${doc.appVersion ?? ''}`;
}

export class ClusterIndex {
  readonly #options: ClusterIndexOptions;
  readonly #fixedIdf: IdfTable | undefined;
  readonly #df = new Map<string, number>();
  readonly #clusters: IndexedCluster[] = [];
  readonly #labels = new Map<string, string>();
  #docCount = 0;
  #nextId = 0;

  constructor(options: ClusterIndexOptions) {
    this.#options = options;
    this.#fixedIdf = options.idf;
  }

  get clusterCount(): number {
    return this.#clusters.length;
  }

  get docCount(): number {
    return this.#docCount;
  }

  /** The cluster a document landed in, if it has been added. */
  labelFor(docId: string): string | undefined {
    return this.#labels.get(docId);
  }

  /** Every assignment made so far, doc id → cluster id. */
  assignments(): Map<string, string> {
    return new Map(this.#labels);
  }

  /** Cluster id → member doc ids, in arrival order. */
  clusters(): Map<string, string[]> {
    return new Map(this.#clusters.map((c) => [c.id, [...c.memberIds]]));
  }

  /**
   * Add one document and return where it landed.
   *
   * Idempotent by doc id: re-adding a document already in the index returns
   * its existing assignment without touching any centroid. Ingest is
   * idempotent by design ([ADR-0020](../../../docs/adr/0020-identity-is-never-guessed.md))
   * and a replayed offline flush must not double a cluster's weight.
   */
  add(doc: Doc): ClusterAssignment {
    const existing = this.#labels.get(doc.id);
    if (existing !== undefined) {
      return { docId: doc.id, clusterId: existing, similarity: 1 };
    }

    const tokens = tokenize(doc.text, this.#options.tokenize ?? {});

    // Term statistics update *before* vectorizing, or every term this document
    // introduces is missing from the IDF table and gets dropped — leaving a
    // genuinely novel document with an empty vector and no way to match
    // anything, forever.
    if (this.#fixedIdf === undefined) {
      this.#docCount++;
      for (const term of new Set(tokens)) this.#df.set(term, (this.#df.get(term) ?? 0) + 1);
    } else {
      this.#docCount++;
    }

    const vector = vectorize(tokens, this.#idfFor(tokens));
    const semanticWeight = Math.min(1, Math.max(0, this.#options.semanticWeight ?? 0));
    const structuralBonus = this.#options.structuralBonus ?? 0;

    let best: IndexedCluster | undefined;
    let bestScore = -1;

    for (const candidate of this.#clusters) {
      const lexical = cosine(vector, candidate.centroid.vector());
      const candidateDense = candidate.dense.vector();
      const canBlend =
        semanticWeight > 0 && doc.vector !== undefined && candidateDense !== undefined;

      let score = canBlend
        ? (1 - semanticWeight) * lexical +
          semanticWeight * denseCosine(doc.vector as Float64Array, candidateDense)
        : lexical;

      if (structuralBonus > 0) score += structuralBonus * this.#agreement(candidate, doc);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    const hasSignal = vector.size > 0 || (semanticWeight > 0 && doc.vector !== undefined);

    if (best !== undefined && hasSignal && bestScore >= this.#options.threshold) {
      this.#absorb(best, doc, vector);
      this.#labels.set(doc.id, best.id);
      return { docId: doc.id, clusterId: best.id, similarity: bestScore };
    }

    const cluster: IndexedCluster = {
      id: `c${String(this.#nextId++)}`,
      memberIds: [],
      centroid: new Centroid(),
      dense: new DenseCentroid(),
      structure: new Map(),
    };
    this.#clusters.push(cluster);
    this.#absorb(cluster, doc, vector);
    this.#labels.set(doc.id, cluster.id);
    return { docId: doc.id, clusterId: cluster.id, similarity: 0 };
  }

  /** Add many, in order. Order matters — leader-follower is order-dependent. */
  addAll(docs: readonly Doc[]): ClusterAssignment[] {
    return docs.map((doc) => this.add(doc));
  }

  toJSON(): SerializedClusterIndex {
    return {
      version: 1,
      docCount: this.#docCount,
      nextId: this.#nextId,
      df: [...this.#df],
      clusters: this.#clusters.map((cluster) => ({
        id: cluster.id,
        memberIds: [...cluster.memberIds],
        sum: [...cluster.centroid.rawSum()],
        count: cluster.centroid.size,
        ...(cluster.dense.size > 0 && {
          dense: { sum: [...cluster.dense.rawSum()], count: cluster.dense.size },
        }),
        structure: [...cluster.structure],
      })),
    };
  }

  static fromJSON(data: SerializedClusterIndex, options: ClusterIndexOptions): ClusterIndex {
    if (data.version !== 1) {
      throw new Error(`unsupported cluster index version ${String(data.version)}`);
    }

    const index = new ClusterIndex(options);
    index.#docCount = data.docCount;
    index.#nextId = data.nextId;
    for (const [term, count] of data.df) index.#df.set(term, count);

    for (const serialized of data.clusters) {
      const cluster: IndexedCluster = {
        id: serialized.id,
        memberIds: [...serialized.memberIds],
        centroid: Centroid.fromSum(new Map(serialized.sum), serialized.count),
        dense:
          serialized.dense === undefined
            ? new DenseCentroid()
            : DenseCentroid.fromSum(Float64Array.from(serialized.dense.sum), serialized.dense.count),
        structure: new Map(serialized.structure),
      };
      index.#clusters.push(cluster);
      for (const id of cluster.memberIds) index.#labels.set(id, cluster.id);
    }

    return index;
  }

  #absorb(cluster: IndexedCluster, doc: Doc, vector: SparseVector): void {
    cluster.centroid.add(vector);
    if (doc.vector !== undefined) cluster.dense.add(doc.vector);
    const key = structuralKey(doc);
    cluster.structure.set(key, (cluster.structure.get(key) ?? 0) + 1);
    cluster.memberIds.push(doc.id);
  }

  #agreement(cluster: IndexedCluster, doc: Doc): number {
    const key = structuralKey(doc);
    let total = 0;
    for (const count of cluster.structure.values()) total += count;
    if (total === 0) return 0;
    return (cluster.structure.get(key) ?? 0) / total;
  }

  /**
   * IDF weights for one document's terms.
   *
   * Only this document's terms, never the whole vocabulary. `vectorize` looks
   * up exactly the terms it is given, and the centroids already hold weighted
   * sums from when their members were added — so a full table would be
   * O(vocabulary) work per write to produce values nothing reads. On a corpus
   * with tens of thousands of terms that is the difference between an ingest
   * that scales and one that does not.
   */
  #idfFor(tokens: readonly string[]): IdfTable {
    if (this.#fixedIdf !== undefined) return this.#fixedIdf;

    const idf: IdfTable = new Map();
    for (const term of new Set(tokens)) {
      const df = this.#df.get(term);
      if (df !== undefined) idf.set(term, Math.log(1 + this.#docCount / (1 + df)));
    }
    return idf;
  }
}
