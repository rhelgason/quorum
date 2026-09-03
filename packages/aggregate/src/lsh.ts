/**
 * SimHash over character shingles, and LSH banding on top of it.
 *
 * Two jobs, and it is worth being clear that they are different:
 *
 * **Near-duplicate collapse.** "Add dark mode", "add dark mode please!!", and
 * "Add Dark Mode" are one person's sentence written three ways. Catching them
 * with a bit-count instead of a vector comparison costs nothing.
 *
 * **Blocking.** Pairwise similarity is O(n²) and dies at scale. Banding puts
 * plausible matches in shared buckets so the expensive comparison only runs on
 * candidates. This is the job that actually matters as a corpus grows past a
 * few thousand submissions.
 *
 * Character shingles rather than word tokens, deliberately. Mobile feedback is
 * full of typos, and character n-grams give typo tolerance for free —
 * "dark mode" and "dakr mode" share most of their trigrams while sharing no
 * word token at all. That is the opposite trade-off from the clusterer in
 * `text.ts`, which stems and drops stopwords; the two are complementary, not
 * redundant.
 */

/** Bits in a fingerprint. 64 is the standard choice and fits two 32-bit words. */
export const SIMHASH_BITS = 64;

/**
 * Overlapping character n-grams of a normalized string.
 *
 * Text shorter than `size` yields one shingle — the whole string — rather than
 * nothing. Returning an empty set would fingerprint every short submission
 * identically to every other, silently collapsing "yes" and "no".
 */
export function shingles(text: string, size = 3): string[] {
  const cleaned = text.trim();
  if (cleaned === '') return [];
  if (cleaned.length <= size) return [cleaned];

  const out: string[] = [];
  for (let i = 0; i + size <= cleaned.length; i++) out.push(cleaned.slice(i, i + size));
  return out;
}

/**
 * 64-bit SimHash.
 *
 * Each shingle is hashed, then every bit position votes: set bits push the
 * accumulator up, clear bits push it down. The sign of each accumulator
 * becomes the output bit, so documents sharing most of their shingles agree on
 * most bits — which is what makes Hamming distance a similarity measure here
 * rather than an arbitrary comparison of two hashes.
 *
 * Weighted by shingle frequency on purpose: a phrase repeated through a
 * submission should pull the fingerprint toward itself.
 */
export function simhash(text: string, shingleSize = 3): bigint {
  const grams = shingles(text, shingleSize);
  if (grams.length === 0) return 0n;

  const accumulator = new Int32Array(SIMHASH_BITS);
  for (const gram of grams) {
    const [high, low] = hash64(gram);
    for (let bit = 0; bit < 32; bit++) {
      accumulator[bit] = (accumulator[bit] ?? 0) + ((low >>> bit) & 1 ? 1 : -1);
      accumulator[bit + 32] = (accumulator[bit + 32] ?? 0) + ((high >>> bit) & 1 ? 1 : -1);
    }
  }

  let fingerprint = 0n;
  for (let bit = 0; bit < SIMHASH_BITS; bit++) {
    if ((accumulator[bit] ?? 0) > 0) fingerprint |= 1n << BigInt(bit);
  }
  return fingerprint;
}

/**
 * Two independent 32-bit FNV-1a passes, giving 64 bits.
 *
 * Independence matters more than cryptographic strength: correlated halves
 * would make the high 32 bits carry no information the low 32 do not, halving
 * the effective fingerprint and inflating collisions. Different offset bases,
 * and the second pass walks the string backwards so the two do not share an
 * accumulation order.
 */
function hash64(text: string): [high: number, low: number] {
  let low = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    low ^= text.charCodeAt(i);
    low = Math.imul(low, 0x01000193) >>> 0;
  }

  let high = 0x9e3779b9;
  for (let i = text.length - 1; i >= 0; i--) {
    high ^= text.charCodeAt(i);
    high = Math.imul(high, 0x85ebca6b) >>> 0;
  }
  return [high >>> 0, low >>> 0];
}

/** Number of differing bits. 0 is identical, 64 is maximally different. */
export function hammingDistance(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let bits = 0;
  while (diff !== 0n) {
    diff &= diff - 1n; // clears the lowest set bit
    bits++;
  }
  return bits;
}

/** Similarity in 0..1, for comparing against a cosine-style threshold. */
export function simhashSimilarity(a: bigint, b: bigint): number {
  return 1 - hammingDistance(a, b) / SIMHASH_BITS;
}

/**
 * Split a fingerprint into band keys.
 *
 * The classic LSH trade-off, and the reason `bands` is a parameter rather than
 * a constant: two documents share a bucket if *any* band matches exactly, so
 * more bands means more candidates and higher recall at the cost of more
 * comparisons. With `b` bands of `r` bits, the probability of two documents
 * with bit-similarity `s` colliding is `1 - (1 - s^r)^b` — an S-curve whose
 * knee sits near `(1/b)^(1/r)`. Eight bands of eight bits puts that knee
 * around 0.76, which is the right neighbourhood for near-duplicate detection
 * and too aggressive for general clustering.
 */
export function bandKeys(fingerprint: bigint, bands = 8): string[] {
  if (!Number.isInteger(bands) || bands < 1 || bands > SIMHASH_BITS) {
    throw new Error(`bands must be an integer in 1..${String(SIMHASH_BITS)}, got ${String(bands)}`);
  }
  if (SIMHASH_BITS % bands !== 0) {
    throw new Error(`bands must divide ${String(SIMHASH_BITS)} evenly, got ${String(bands)}`);
  }

  const width = SIMHASH_BITS / bands;
  const mask = (1n << BigInt(width)) - 1n;
  const keys: string[] = [];
  for (let band = 0; band < bands; band++) {
    const chunk = (fingerprint >> BigInt(band * width)) & mask;
    // Band index is part of the key, so an identical bit pattern in two
    // different positions does not produce a false candidate.
    keys.push(`${String(band)}:${chunk.toString(36)}`);
  }
  return keys;
}

export interface LshDoc {
  id: string;
  text: string;
}

export interface BlockOptions {
  /** Bands to split the fingerprint into. Default 8. */
  bands?: number;
  /** Character shingle size. Default 3. */
  shingleSize?: number;
  /**
   * Skip buckets larger than this. Default 500.
   *
   * A pathologically popular band — thousands of submissions sharing eight
   * bits — contributes n² candidate pairs and almost no information, which is
   * precisely what blocking exists to prevent. Skipping it costs recall on
   * that band only; the other seven still have their say.
   *
   * It is a *size* cap rather than a "this bucket holds everything" check.
   * The obvious version of that check — skip when the bucket is the whole
   * corpus — silently breaks the smallest case there is: two identical
   * submissions share every band, so every bucket is "everything", and the one
   * pair the blocker exists to find is discarded.
   */
  maxBucketSize?: number;
}

/**
 * Candidate pairs, as an id → co-bucketed ids map.
 *
 * This is the blocking pass: it does not decide that anything is a duplicate,
 * only that a pair is worth the cost of a real comparison. Recall matters far
 * more than precision here — a missed candidate is a pair that will never be
 * compared at all, while a spurious one costs a single cosine.
 */
export function candidateBlocks(
  docs: readonly LshDoc[],
  options: BlockOptions = {},
): Map<string, Set<string>> {
  const bands = options.bands ?? 8;
  const shingleSize = options.shingleSize ?? 3;
  const maxBucketSize = options.maxBucketSize ?? 500;

  const buckets = new Map<string, string[]>();
  for (const doc of docs) {
    for (const key of bandKeys(simhash(doc.text, shingleSize), bands)) {
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [doc.id]);
      else bucket.push(doc.id);
    }
  }

  const candidates = new Map<string, Set<string>>();
  for (const doc of docs) candidates.set(doc.id, new Set());

  for (const bucket of buckets.values()) {
    if (bucket.length < 2 || bucket.length > maxBucketSize) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i] as string;
        const b = bucket[j] as string;
        candidates.get(a)?.add(b);
        candidates.get(b)?.add(a);
      }
    }
  }
  return candidates;
}

export interface NearDuplicateOptions extends BlockOptions {
  /**
   * Maximum differing bits for two documents to count as duplicates.
   * Default 6 of 64.
   *
   * Measured on realistic feedback rather than picked: exact text and
   * case/punctuation variants land at 0, a word inserted into a full-sentence
   * ticket at 2, a typo in a twenty-character phrase at 6. Different phrasing
   * of the same topic sits at 22 and unrelated text at 27+, so 6 leaves a wide
   * margin either side.
   *
   * **The caveat that matters: distance scales inversely with length.** The
   * same single-character typo costs 6 bits in "please add dark mode" and 18
   * in "dark mode", because a short string has few shingles and each one moves
   * more bits. Near-duplicate detection is therefore weakest on the shortest
   * submissions — which, on mobile, is a lot of them. Raising the threshold to
   * compensate would start merging genuinely different short feedback, so the
   * miss is accepted rather than tuned away.
   */
  maxDistance?: number;
}

/**
 * Groups of near-identical documents, in input order.
 *
 * Union-find over confirmed pairs, so a chain of near-duplicates lands in one
 * group. Chaining is acceptable *here* and catastrophic in clustering
 * (ADR-0018) because the threshold is so tight: at six bits out of sixty-four
 * these are restatements of one sentence, not adjacent topics.
 */
export function nearDuplicateGroups(
  docs: readonly LshDoc[],
  options: NearDuplicateOptions = {},
): string[][] {
  const maxDistance = options.maxDistance ?? 6;
  const shingleSize = options.shingleSize ?? 3;

  const fingerprints = new Map<string, bigint>();
  for (const doc of docs) fingerprints.set(doc.id, simhash(doc.text, shingleSize));

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (p === undefined || p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  for (const doc of docs) parent.set(doc.id, doc.id);

  const candidates = candidateBlocks(docs, options);
  for (const [id, others] of candidates) {
    const mine = fingerprints.get(id);
    if (mine === undefined) continue;
    for (const other of others) {
      const theirs = fingerprints.get(other);
      if (theirs === undefined) continue;
      if (hammingDistance(mine, theirs) <= maxDistance) union(id, other);
    }
  }

  // Input order, so the output is stable and readable rather than hash-ordered.
  const groups = new Map<string, string[]>();
  for (const doc of docs) {
    const root = find(doc.id);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [doc.id]);
    else group.push(doc.id);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}
