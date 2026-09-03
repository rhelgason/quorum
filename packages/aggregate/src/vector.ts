/**
 * Sparse TF-IDF vectors and cosine similarity.
 *
 * TF-IDF cosine rather than BM25 because clustering needs a **symmetric**
 * measure and a centroid you can update incrementally. BM25 is a query-document
 * score: `sim(a,b) !== sim(b,a)`, and there is no natural "average BM25
 * document" to compare against. Leader-follower assignment
 * (`docs/DATA-MODEL.md`) is built entirely on comparing an arriving item to a
 * stored centroid, so symmetry isn't a nicety.
 *
 * Vectors are `Map<term, weight>`, L2-normalized at construction, so cosine is
 * a plain dot product.
 */

export type SparseVector = Map<string, number>;

/** term → inverse document frequency. */
export type IdfTable = Map<string, number>;

/**
 * Smoothed IDF over a document set: `ln(1 + N / (1 + df))`.
 *
 * Smoothing matters more than usual here. Feedback corpora are small and
 * heavily skewed — a term appearing in one of 161 documents would get an
 * enormous unsmoothed weight and let a single rare typo dominate a similarity
 * score.
 */
export function buildIdf(documents: readonly (readonly string[])[]): IdfTable {
  const df = new Map<string, number>();
  for (const tokens of documents) {
    for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = documents.length;
  const idf: IdfTable = new Map();
  for (const [term, count] of df) idf.set(term, Math.log(1 + n / (1 + count)));
  return idf;
}

/**
 * Build an L2-normalized TF-IDF vector.
 *
 * Sublinear term frequency (`1 + ln(tf)`) rather than raw counts: someone
 * writing "crash crash crash" is not three times more about crashing, and raw
 * counts let one emphatic user distort a cluster centroid.
 *
 * Terms absent from the IDF table are skipped rather than assigned a default.
 * An unknown term carries no evidence about similarity to anything already
 * seen, and guessing a weight for it is how out-of-vocabulary noise creeps
 * into scores.
 */
export function vectorize(tokens: readonly string[], idf: IdfTable): SparseVector {
  const tf = new Map<string, number>();
  for (const term of tokens) tf.set(term, (tf.get(term) ?? 0) + 1);

  const vector: SparseVector = new Map();
  for (const [term, count] of tf) {
    const weight = idf.get(term);
    if (weight === undefined) continue;
    vector.set(term, (1 + Math.log(count)) * weight);
  }
  return l2Normalize(vector);
}

/** Scale to unit length. A zero vector is returned unchanged. */
export function l2Normalize(vector: SparseVector): SparseVector {
  let sumSquares = 0;
  for (const value of vector.values()) sumSquares += value * value;
  if (sumSquares === 0) return vector;

  const norm = Math.sqrt(sumSquares);
  const out: SparseVector = new Map();
  for (const [term, value] of vector) out.set(term, value / norm);
  return out;
}

/**
 * Cosine similarity of two L2-normalized vectors.
 *
 * Iterates the smaller vector, since sparse feedback vectors differ wildly in
 * length ("dark mode pls" versus a paragraph).
 */
export function cosine(a: SparseVector, b: SparseVector): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, value] of small) {
    const other = large.get(term);
    if (other !== undefined) dot += value * other;
  }
  return dot;
}

/**
 * Running sum of member vectors, so a centroid is exact under both addition
 * and removal.
 *
 * Storing the sum rather than the mean is what makes a human splitting a
 * cluster an O(1) subtraction instead of a full recompute over every member —
 * see `docs/DATA-MODEL.md`. It also keeps the centroid exact rather than
 * accumulating float drift from repeated averaging.
 */
export class Centroid {
  private readonly sum: SparseVector = new Map();
  private count = 0;

  get size(): number {
    return this.count;
  }

  add(vector: SparseVector): void {
    for (const [term, value] of vector) this.sum.set(term, (this.sum.get(term) ?? 0) + value);
    this.count++;
  }

  remove(vector: SparseVector): void {
    if (this.count === 0) throw new Error('cannot remove from an empty centroid');
    for (const [term, value] of vector) {
      const next = (this.sum.get(term) ?? 0) - value;
      // Clean up terms that cancel out, or the sum grows without bound as a
      // long-lived cluster churns members.
      if (Math.abs(next) < 1e-12) this.sum.delete(term);
      else this.sum.set(term, next);
    }
    this.count--;
  }

  /** L2-normalized mean, ready for cosine. */
  vector(): SparseVector {
    if (this.count === 0) return new Map();
    const mean: SparseVector = new Map();
    for (const [term, value] of this.sum) mean.set(term, value / this.count);
    return l2Normalize(mean);
  }
}
