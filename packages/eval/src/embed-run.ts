/**
 * Choosing an embedder for a sweep, and embedding the corpus once.
 *
 * Three sources, in order of precedence, and the ordering is the whole design:
 *
 *  1. **A real model**, from `QUORUM_EMBED_*`. The only one whose numbers mean
 *     anything about clustering quality.
 *  2. **The hashing stand-in**, with `QUORUM_EMBED_PROVIDER=stand-in`. Proves
 *     the hybrid path works; says nothing about quality.
 *  3. **Nothing.** Lexical only, which is the shipped v0.1 behaviour.
 *
 * Falling back to the stand-in automatically would be the wrong kind of
 * convenient: a sweep that quietly measured a hash function while the reader
 * believed it measured a model is worse than no sweep. So it has to be asked
 * for by name, and every report says which of the three it got.
 */

import { embedderFromEnv, type Embedder } from '../../aggregate/src/embed.ts';
import { cachingEmbedder, createHashingEmbedder } from '../../aggregate/src/embed-cache.ts';
import type { EmbeddingCache } from '../../aggregate/src/embed-cache.ts';

export type EmbedderKind = 'model' | 'stand-in' | 'mock' | 'none';

export interface ResolvedEmbedder {
  kind: EmbedderKind;
  embedder: Embedder | undefined;
  /** One line, safe to print above a results table. */
  provenance: string;
}

/** The value of `QUORUM_EMBED_PROVIDER` that selects the stand-in. */
export const STAND_IN = 'stand-in';

/**
 * The value that means "I am pointing at `npm run mock-model`".
 *
 * Recognised by name so the report cannot call it a real measurement. The mock
 * goes over real HTTP through the real adapter — which is the whole point of
 * it — so nothing else here can tell it apart from Ollama, and a run that
 * quietly claimed a hash function's scores were a model's would be the exact
 * failure this file's ordering was written to prevent.
 */
export const MOCK = 'mock';

export function resolveEmbedder(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): ResolvedEmbedder {
  const provider = (env['QUORUM_EMBED_PROVIDER'] ?? '').trim().toLowerCase();

  if (provider === STAND_IN) {
    const embedder = createHashingEmbedder();
    return {
      kind: 'stand-in',
      embedder,
      provenance:
        `stand-in (${embedder.name}) — a hash function, NOT a semantic model. ` +
        'It proves the hybrid path is wired; it cannot bridge paraphrase, so ' +
        'treat any score here as a plumbing check rather than a quality result.',
    };
  }

  const embedder = embedderFromEnv(env, fetchImpl);
  if (embedder !== undefined) {
    const where = env['QUORUM_EMBED_BASE_URL'] ?? '(unset)';

    if (provider === MOCK) {
      return {
        kind: 'mock',
        embedder,
        provenance:
          `mock endpoint at ${where} — a WIRING CHECK, not a measurement. ` +
          'It serves hash vectors over the real adapter, so it proves the URL, ' +
          'request shape and batching work. Its scores mean nothing.',
      };
    }

    return {
      kind: 'model',
      embedder,
      provenance: `model "${embedder.name}" at ${where} — real measurement.`,
    };
  }

  return {
    kind: 'none',
    embedder: undefined,
    provenance:
      'no embedder configured — lexical only. Set QUORUM_EMBED_PROVIDER, ' +
      'QUORUM_EMBED_BASE_URL and QUORUM_EMBED_MODEL to measure a real model, ' +
      `or QUORUM_EMBED_PROVIDER=${STAND_IN} to exercise the path without one.`,
  };
}

export interface EmbedCorpusResult {
  vectors: Float64Array[];
  /** Distinct texts sent to the model. */
  embedded: number;
  /** Served from cache, including duplicates within the batch. */
  reused: number;
}

/**
 * Embed every document once, through the cache.
 *
 * Batched at 64. Large enough that a local model amortises its per-request
 * overhead, small enough that a hosted endpoint's payload limit is not the
 * thing a first-time user discovers.
 */
export async function embedCorpus(
  embedder: Embedder,
  texts: readonly string[],
  cache: EmbeddingCache,
  batchSize = 64,
): Promise<EmbedCorpusResult> {
  const cached = cachingEmbedder(embedder, cache);
  const vectors: Float64Array[] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    vectors.push(...(await cached.embed(texts.slice(i, i + batchSize))));
  }

  return {
    vectors,
    embedded: cached.stats.misses,
    reused: cached.stats.hits + cached.stats.deduped,
  };
}
