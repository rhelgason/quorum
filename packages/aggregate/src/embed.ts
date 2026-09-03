/**
 * Embedding provider abstraction.
 *
 * Same shape and same constraints as the LLM provider
 * ([ADR-0016](../../../docs/adr/0016-llm-is-config-not-code.md)): **no model
 * identifier appears anywhere in this file**, the default is absent, and one
 * OpenAI-compatible adapter covers every endpoint worth using — including a
 * fully local Ollama or llama.cpp server, which makes semantic clustering free
 * and keeps customer feedback on the customer's own hardware.
 *
 * Unlike the LLM, embeddings are **not** at the render edge — they feed
 * clustering, which is the deterministic core. That is still consistent with
 * [ADR-0005](../../../docs/adr/0005-deterministic-core-llm-at-render-edge.md):
 * a sentence embedding is a numerical similarity function, not an agent. It is
 * deterministic for a fixed model, produces the same vector every time, and
 * needs no network once the model is local.
 *
 * When no embedder is configured, clustering falls back to lexical similarity
 * alone. Degraded, and still the shipped v0.1 behaviour.
 */

export interface Embedder {
  readonly name: string;
  /** Vector dimensionality, when known ahead of the first call. */
  readonly dimensions?: number;
  /**
   * Embed a batch. Implementations must return one vector per input, in order.
   *
   * Batched rather than single because every hosted endpoint charges and rate
   * limits per request, and a local model is dramatically faster per item on a
   * batch.
   */
  embed(texts: readonly string[]): Promise<Float64Array[]>;
}

/** Cosine similarity for dense vectors. Assumes equal length. */
export function denseCosine(a: Float64Array, b: Float64Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Scale to unit length in place-free fashion, so cosine is a dot product. */
export function normalizeDense(v: Float64Array): Float64Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  if (sum === 0) return v;
  const norm = Math.sqrt(sum);
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / norm;
  return out;
}

/**
 * Running mean of dense vectors, with exact removal.
 *
 * Mirrors `Centroid` in `vector.ts`: store the sum, not the mean, so a human
 * splitting a cluster is a subtraction rather than a recompute over every
 * member.
 */
export class DenseCentroid {
  private sum: Float64Array | undefined;
  private count = 0;

  get size(): number {
    return this.count;
  }

  add(v: Float64Array): void {
    if (this.sum === undefined) this.sum = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) {
      this.sum[i] = (this.sum[i] as number) + (v[i] as number);
    }
    this.count++;
  }

  remove(v: Float64Array): void {
    if (this.sum === undefined || this.count === 0) {
      throw new Error('cannot remove from an empty centroid');
    }
    for (let i = 0; i < v.length; i++) {
      this.sum[i] = (this.sum[i] as number) - (v[i] as number);
    }
    this.count--;
  }

  vector(): Float64Array | undefined {
    if (this.sum === undefined || this.count === 0) return undefined;
    const mean = new Float64Array(this.sum.length);
    for (let i = 0; i < this.sum.length; i++) {
      mean[i] = (this.sum[i] as number) / this.count;
    }
    return normalizeDense(mean);
  }
}

export interface OpenAICompatibleEmbedderConfig {
  baseUrl: string;
  /** Config value. Never a constant in this repo. */
  model: string;
  apiKey?: string;
  name?: string;
  /** Inputs per HTTP request. Default 64. */
  batchSize?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class QuorumEmbedError extends Error {
  readonly provider: string;
  readonly status?: number;

  constructor(message: string, options: { provider: string; status?: number }) {
    super(message);
    this.name = 'QuorumEmbedError';
    this.provider = options.provider;
    if (options.status !== undefined) this.status = options.status;
  }
}

/**
 * One adapter for every OpenAI-compatible `/embeddings` endpoint: Ollama,
 * llama.cpp, LM Studio, vLLM, Gemini's compat layer, OpenAI, Together, and so
 * on. Adding a provider is a URL and a key.
 */
export function createOpenAICompatibleEmbedder(
  config: OpenAICompatibleEmbedderConfig,
): Embedder {
  const name = config.name ?? 'openai-compatible';
  const batchSize = config.batchSize ?? 64;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  const base = config.baseUrl.replace(/\/+$/, '');

  return {
    name,

    async embed(texts: readonly string[]): Promise<Float64Array[]> {
      if (texts.length === 0) return [];

      const out: Float64Array[] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (config.apiKey !== undefined && config.apiKey !== '') {
            headers.authorization = `Bearer ${config.apiKey}`;
          }

          const response = await doFetch(`${base}/embeddings`, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({ model: config.model, input: batch }),
          });

          if (!response.ok) {
            throw new QuorumEmbedError(`${name} embeddings request failed with ${response.status}`, {
              provider: name,
              status: response.status,
            });
          }

          const body = (await response.json()) as {
            data?: { embedding?: number[]; index?: number }[];
          };
          const rows = body.data ?? [];
          if (rows.length !== batch.length) {
            throw new QuorumEmbedError(
              `${name} returned ${rows.length} embeddings for ${batch.length} inputs`,
              { provider: name },
            );
          }

          // Endpoints are permitted to return results out of order, and some
          // do under load. Sorting by index rather than trusting arrival order
          // prevents silently attaching the wrong vector to a submission —
          // which would corrupt clusters with no visible error.
          const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
          for (const row of ordered) {
            if (!Array.isArray(row.embedding)) {
              throw new QuorumEmbedError(`${name} returned a malformed embedding`, { provider: name });
            }
            out.push(normalizeDense(Float64Array.from(row.embedding)));
          }
        } finally {
          clearTimeout(timer);
        }
      }
      return out;
    },
  };
}

export interface EmbedEnv {
  QUORUM_EMBED_PROVIDER?: string;
  QUORUM_EMBED_BASE_URL?: string;
  QUORUM_EMBED_MODEL?: string;
  QUORUM_EMBED_API_KEY?: string;
}

/**
 * Build an embedder from the environment, or `undefined` when not fully
 * configured.
 *
 * Fails closed for the same reason the LLM provider does: a half-configured
 * deployment should quietly fall back to lexical clustering rather than throw
 * on every ingest.
 */
export function embedderFromEnv(env: EmbedEnv = {}, fetchImpl?: typeof fetch): Embedder | undefined {
  const kind = (env.QUORUM_EMBED_PROVIDER ?? 'none').trim().toLowerCase();
  if (kind === '' || kind === 'none' || kind === 'off' || kind === 'false') return undefined;

  const baseUrl = env.QUORUM_EMBED_BASE_URL?.trim();
  const model = env.QUORUM_EMBED_MODEL?.trim();
  if (baseUrl === undefined || baseUrl === '' || model === undefined || model === '') {
    return undefined;
  }

  return createOpenAICompatibleEmbedder({
    baseUrl,
    model,
    name: kind,
    ...(env.QUORUM_EMBED_API_KEY !== undefined && env.QUORUM_EMBED_API_KEY !== ''
      ? { apiKey: env.QUORUM_EMBED_API_KEY }
      : {}),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
}
