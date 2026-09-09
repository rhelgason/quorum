/**
 * Caching in front of an embedder, and a stand-in embedder for the path that
 * has no model.
 *
 * ## Why the cache is not optional
 *
 * Tuning the hybrid weights means sweeping `semanticWeight` × `threshold` over
 * the whole corpus. The vectors do not change between cells — only how they
 * are combined does — so an uncached sweep re-embeds every document for every
 * configuration. On a 25-cell grid over 161 documents that is 4,025 embed
 * calls to compute 161 distinct vectors, which turns a sweep against a local
 * model from seconds into minutes and against a hosted one into money.
 *
 * The cache is keyed on `(model, text)`. Not on text alone: two models produce
 * different vectors for the same sentence, and silently blending them would
 * produce a similarity matrix that is meaningless in a way nothing downstream
 * could detect.
 */

import type { Embedder } from './embed.ts';
import { normalizeDense } from './embed.ts';
import { tokenize, type TokenizeOptions } from './text.ts';

export interface EmbeddingCache {
  get(key: string): Float64Array | undefined;
  set(key: string, vector: Float64Array): void;
}

/**
 * The cache key.
 *
 * A NUL separator rather than a delimiter that could appear in either half —
 * a model named `a` with text `b:c` and a model named `a:b` with text `c` must
 * not collide.
 */
export function cacheKey(model: string, text: string): string {
  return `${model}\u0000${text}`;
}

/**
 * Split a key back into its parts.
 *
 * Lives here so exactly one module knows what the separator is. A persistent
 * cache has to write the model and text as separate fields to stay greppable,
 * and re-deriving the split at the call site is how the two halves drift.
 */
export function parseCacheKey(key: string): { model: string; text: string } {
  const at = key.indexOf('\u0000');
  if (at === -1) return { model: '', text: key };
  return { model: key.slice(0, at), text: key.slice(at + 1) };
}

export interface MemoryEmbeddingCache extends EmbeddingCache {
  readonly size: number;
  entries(): [string, Float64Array][];
}

export function createMemoryEmbeddingCache(
  initial: Iterable<[string, Float64Array]> = [],
): MemoryEmbeddingCache {
  const map = new Map<string, Float64Array>(initial);
  return {
    get: (key) => map.get(key),
    set: (key, vector) => {
      map.set(key, vector);
    },
    get size() {
      return map.size;
    },
    entries: () => [...map.entries()],
  };
}

export interface CachingEmbedderStats {
  hits: number;
  misses: number;
  /** Duplicate texts collapsed within a single batch. */
  deduped: number;
}

export interface CachingEmbedder extends Embedder {
  readonly stats: CachingEmbedderStats;
}

/**
 * Wrap an embedder so repeated texts cost nothing.
 *
 * Two separate savings, and the second is the one people forget: misses are
 * deduplicated *within* a batch as well as across calls. A feedback corpus is
 * full of exact repeats — "dark mode", "Dark mode", "+1" — and a naive
 * implementation embeds each occurrence.
 *
 * Order is preserved exactly. An embedder that returned vectors in a different
 * order than its inputs would mislabel every document, and the result would
 * still look like a plausible clustering.
 */
export function cachingEmbedder(inner: Embedder, cache: EmbeddingCache): CachingEmbedder {
  const stats: CachingEmbedderStats = { hits: 0, misses: 0, deduped: 0 };

  return {
    name: inner.name,
    ...(inner.dimensions !== undefined && { dimensions: inner.dimensions }),
    stats,

    async embed(texts) {
      const out = new Array<Float64Array | undefined>(texts.length);
      // text → the positions in `out` waiting on it.
      const pending = new Map<string, number[]>();

      texts.forEach((text, index) => {
        const hit = cache.get(cacheKey(inner.name, text));
        if (hit !== undefined) {
          out[index] = hit;
          stats.hits++;
          return;
        }

        const waiting = pending.get(text);
        if (waiting === undefined) {
          pending.set(text, [index]);
          stats.misses++;
        } else {
          waiting.push(index);
          stats.deduped++;
        }
      });

      const misses = [...pending.keys()];
      if (misses.length > 0) {
        const vectors = await inner.embed(misses);
        if (vectors.length !== misses.length) {
          throw new Error(
            `embedder "${inner.name}" returned ${String(vectors.length)} vectors for ${String(misses.length)} inputs`,
          );
        }

        misses.forEach((text, i) => {
          const vector = vectors[i] as Float64Array;
          cache.set(cacheKey(inner.name, text), vector);
          for (const index of pending.get(text) as number[]) out[index] = vector;
        });
      }

      return out as Float64Array[];
    },
  };
}

// ---------------------------------------------------------------------------
// The stand-in
// ---------------------------------------------------------------------------

export interface HashingEmbedderOptions {
  dimensions?: number;
  tokenize?: TokenizeOptions;
  /** Include adjacent token pairs, so word order carries a little weight. */
  bigrams?: boolean;
  name?: string;
}

/**
 * A deterministic embedder that needs no model, no network, and no download.
 *
 * **This is not a semantic model and must never be presented as one.** It is
 * the hashing trick: tokens are hashed into a fixed-width vector with signed
 * accumulation. Two texts are close when they share tokens, which is exactly
 * what TF-IDF already measures — so it cannot bridge "add dark mode" and "why
 * is everything so white", which is the entire reason embeddings are on the
 * roadmap ([ADR-0019](../../../docs/adr/0019-embedding-quality-bar.md)).
 *
 * What it is legitimately for: **testing the plumbing**. The hybrid path —
 * vectors reaching the clusterer, `semanticWeight` blending them, the cache
 * returning them in order — has to work before a real model can say anything,
 * and none of that needs a real model to verify. It gives CI a semantic path
 * to exercise on a machine with no registry access.
 *
 * It also yields a useful invariant: because it encodes roughly the same
 * signal as the lexical scorer, swapping it in at any `semanticWeight` should
 * leave rank agreement **about the same** — not better, not much worse. A
 * sweep where it improves the score is measuring a bug, and a sweep where it
 * collapses the score means the blend is wired wrong.
 */
export function createHashingEmbedder(options: HashingEmbedderOptions = {}): Embedder {
  const dimensions = options.dimensions ?? 256;
  const tokenOptions = options.tokenize ?? {};
  const bigrams = options.bigrams ?? true;
  const name = options.name ?? 'hashing-stand-in';

  return {
    name,
    dimensions,
    embed(texts) {
      return Promise.resolve(
        texts.map((text) => {
          const vector = new Float64Array(dimensions);
          const tokens = tokenize(text, tokenOptions);

          const add = (term: string): void => {
            const h = fnv1a(term);
            // A second, independent hash picks the sign. Without it every
            // collision accumulates in the same direction and unrelated texts
            // drift toward a shared vector.
            const sign = (fnv1a(`${term}#`) & 1) === 0 ? 1 : -1;
            const slot = h % dimensions;
            vector[slot] = (vector[slot] as number) + sign;
          };

          for (const token of tokens) add(token);
          if (bigrams) {
            for (let i = 1; i < tokens.length; i++) add(`${tokens[i - 1] as string}_${tokens[i] as string}`);
          }

          return normalizeDense(vector);
        }),
      );
    },
  };
}

/** FNV-1a, 32-bit. Not cryptographic and does not need to be. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
