/**
 * LLM provider abstraction for the render edge.
 *
 * Two hard constraints shape this file, and both are product requirements
 * rather than preferences:
 *
 * **1. Free by default, and free must stay possible.** The default provider is
 * `none`. The repository runs, tests, and demos with no API key, no account,
 * and no spend — falling back to medoid labels
 * (`docs/adr/0005-deterministic-core-llm-at-render-edge.md`). Nothing in the
 * test suite or CI ever makes a network call. Providers with usable free
 * tiers are documented in `.env.example`; a paid provider is opt-in via config
 * only.
 *
 * **2. No model identifier is ever hardcoded.** Models are deprecated
 * constantly, and a repo that names one has to be edited every time that
 * happens. There is not a single model string in this codebase — the model is
 * a config value, and the transport is the OpenAI-compatible chat-completions
 * shape that Groq, Gemini, OpenRouter, Together, Ollama, llama.cpp, vLLM, and
 * others all expose. Switching provider or model is an environment change,
 * never a code change.
 *
 * When a configured model disappears, `QuorumLlmError` reports the models the
 * endpoint actually offers, so the fix is obvious instead of a bare 404.
 */

export interface GenerateRequest {
  /** System framing. Optional; not every endpoint honors it. */
  system?: string;
  prompt: string;
  maxTokens?: number;
  /** Default 0 — generated specs should be reproducible, not creative. */
  temperature?: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  /** Echoes the model that actually served the request, for the render cache key. */
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  /** Cheap capability probe. False means callers should use the fallback path. */
  isAvailable(): boolean;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  /** Model ids the endpoint reports, when it supports discovery. */
  listModels?(): Promise<string[]>;
}

export class QuorumLlmError extends Error {
  readonly provider: string;
  readonly status?: number;
  /** Populated on a model-not-found error, so the message can be actionable. */
  readonly availableModels?: string[];

  constructor(
    message: string,
    options: { provider: string; status?: number; availableModels?: string[] },
  ) {
    super(message);
    this.name = 'QuorumLlmError';
    this.provider = options.provider;
    if (options.status !== undefined) this.status = options.status;
    if (options.availableModels !== undefined) this.availableModels = options.availableModels;
  }
}

/**
 * The default. Always available, always declines to generate.
 *
 * Callers must treat "no LLM" as a normal state rather than an error — the
 * product degrades to medoid labels and keeps working.
 */
export const nullProvider: LlmProvider = {
  name: 'none',
  isAvailable: () => false,
  generate: () => {
    throw new QuorumLlmError('no LLM provider configured; use the medoid fallback', {
      provider: 'none',
    });
  },
};

export interface OpenAICompatibleConfig {
  /** e.g. a Groq, Gemini-compat, OpenRouter, or local Ollama endpoint. */
  baseUrl: string;
  /** Config value. Never a constant in this repo. */
  model: string;
  /** Omitted for local endpoints that need no auth. */
  apiKey?: string;
  /** Display name for errors and the render cache key. */
  name?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  model?: string;
  error?: { message?: string };
}

/**
 * One adapter for every OpenAI-compatible endpoint.
 *
 * This is the whole extensibility answer. Rather than a provider class per
 * vendor — each needing maintenance as vendors change SDKs — there is one
 * HTTP shape that the entire ecosystem has converged on. Adding a provider is
 * a URL and a key in the environment.
 */
export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): LlmProvider {
  const name = config.name ?? 'openai-compatible';
  const timeoutMs = config.timeoutMs ?? 30_000;
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  const base = config.baseUrl.replace(/\/+$/, '');

  function headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (config.apiKey !== undefined && config.apiKey !== '') {
      h.authorization = `Bearer ${config.apiKey}`;
    }
    return h;
  }

  return {
    name,

    // A local endpoint legitimately needs no key, so availability is about
    // having somewhere to call and something to call it with.
    isAvailable: () =>
      typeof doFetch === 'function' && base !== '' && config.model !== '',

    async listModels(): Promise<string[]> {
      const response = await doFetch(`${base}/models`, { headers: headers() });
      if (!response.ok) return [];
      const body = (await response.json()) as { data?: { id?: string }[] };
      return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    },

    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      request.signal?.addEventListener('abort', () => controller.abort());

      const messages: { role: string; content: string }[] = [];
      if (request.system !== undefined) messages.push({ role: 'system', content: request.system });
      messages.push({ role: 'user', content: request.prompt });

      try {
        const response = await doFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: headers(),
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            messages,
            temperature: request.temperature ?? 0,
            max_tokens: request.maxTokens ?? 1024,
          }),
        });

        if (!response.ok) {
          // A deprecated or renamed model is the single most likely failure in
          // a long-lived deployment, so spend one extra call to say which
          // models exist rather than surfacing a bare 404.
          let available: string[] | undefined;
          if (response.status === 404 || response.status === 400) {
            try {
              available = await this.listModels?.();
            } catch {
              available = undefined;
            }
          }
          const detail = available?.length
            ? ` Model '${config.model}' may be unavailable. Endpoint offers: ${available.slice(0, 20).join(', ')}`
            : '';
          throw new QuorumLlmError(
            `${name} request failed with ${response.status}.${detail}`,
            {
              provider: name,
              status: response.status,
              ...(available !== undefined ? { availableModels: available } : {}),
            },
          );
        }

        const body = (await response.json()) as ChatCompletionResponse;
        const text = body.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || text === '') {
          throw new QuorumLlmError(`${name} returned no content`, { provider: name });
        }
        return { text, model: body.model ?? config.model };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface LlmEnv {
  QUORUM_LLM_PROVIDER?: string;
  QUORUM_LLM_BASE_URL?: string;
  QUORUM_LLM_MODEL?: string;
  QUORUM_LLM_API_KEY?: string;
  QUORUM_LLM_TIMEOUT_MS?: string;
}

/**
 * Build a provider from environment configuration.
 *
 * Anything other than an explicit, fully-specified configuration yields
 * `nullProvider`. Failing closed matters: a half-configured deployment should
 * fall back to medoid labels silently rather than throw on every render, and
 * an unset environment must never accidentally start spending money.
 */
export function providerFromEnv(env: LlmEnv = {}, fetchImpl?: typeof fetch): LlmProvider {
  const kind = (env.QUORUM_LLM_PROVIDER ?? 'none').trim().toLowerCase();
  if (kind === '' || kind === 'none' || kind === 'off' || kind === 'false') return nullProvider;

  const baseUrl = env.QUORUM_LLM_BASE_URL?.trim();
  const model = env.QUORUM_LLM_MODEL?.trim();
  if (baseUrl === undefined || baseUrl === '' || model === undefined || model === '') {
    return nullProvider;
  }

  const timeout = Number.parseInt(env.QUORUM_LLM_TIMEOUT_MS ?? '', 10);

  return createOpenAICompatibleProvider({
    baseUrl,
    model,
    name: kind,
    ...(env.QUORUM_LLM_API_KEY !== undefined && env.QUORUM_LLM_API_KEY !== ''
      ? { apiKey: env.QUORUM_LLM_API_KEY }
      : {}),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
}
