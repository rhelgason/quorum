import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createOpenAICompatibleProvider,
  nullProvider,
  providerFromEnv,
  QuorumLlmError,
} from './llm.ts';

/** Minimal fake fetch. No test in this repo ever touches the network. */
function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status?: number; body: unknown },
): { impl: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const { status = 200, body } = handler(String(url), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const CHAT_OK = { choices: [{ message: { content: 'a generated spec' } }], model: 'served-model' };

describe('free by default', () => {
  test('an empty environment yields the null provider', () => {
    assert.equal(providerFromEnv({}).name, 'none');
    assert.equal(providerFromEnv({}).isAvailable(), false);
  });

  test('the null provider throws rather than silently returning empty text', () => {
    // Callers must take the medoid fallback explicitly, not mistake '' for output.
    assert.throws(() => nullProvider.generate({ prompt: 'x' }), /no LLM provider/);
  });

  test('a half-configured environment fails closed instead of erroring at render time', () => {
    // Provider set but no model, or no base URL: fall back, don't throw, and
    // above all don't guess a default that might cost money.
    assert.equal(providerFromEnv({ QUORUM_LLM_PROVIDER: 'groq' }).name, 'none');
    assert.equal(
      providerFromEnv({ QUORUM_LLM_PROVIDER: 'groq', QUORUM_LLM_MODEL: 'some-model' }).name,
      'none',
    );
    assert.equal(
      providerFromEnv({ QUORUM_LLM_PROVIDER: 'groq', QUORUM_LLM_BASE_URL: 'https://x/v1' }).name,
      'none',
    );
  });

  test('explicit off switches are all honored', () => {
    for (const value of ['none', 'off', 'false', '', '  NONE  ']) {
      assert.equal(providerFromEnv({ QUORUM_LLM_PROVIDER: value }).name, 'none', `for '${value}'`);
    }
  });

  test('a fully configured environment activates a provider', () => {
    const p = providerFromEnv({
      QUORUM_LLM_PROVIDER: 'groq',
      QUORUM_LLM_BASE_URL: 'https://api.example/v1',
      QUORUM_LLM_MODEL: 'whatever-model',
      QUORUM_LLM_API_KEY: 'k',
    });
    assert.equal(p.name, 'groq');
    assert.equal(p.isAvailable(), true);
  });
});

describe('no hardcoded models', () => {
  test('the model always comes from config and is sent verbatim', () => {
    const { impl, calls } = fakeFetch(() => ({ body: CHAT_OK }));
    const p = createOpenAICompatibleProvider({
      baseUrl: 'https://api.example/v1',
      model: 'some-future-model-v9',
      fetchImpl: impl,
    });
    return p.generate({ prompt: 'hi' }).then(() => {
      const body = JSON.parse(String(calls[0]?.init?.body));
      assert.equal(body.model, 'some-future-model-v9');
    });
  });

  test('any model string is accepted — no allowlist to go stale', async () => {
    const { impl } = fakeFetch(() => ({ body: CHAT_OK }));
    for (const model of ['a', 'vendor/model:tag', 'model-not-invented-yet-2031']) {
      const p = createOpenAICompatibleProvider({
        baseUrl: 'https://api.example/v1',
        model,
        fetchImpl: impl,
      });
      assert.equal((await p.generate({ prompt: 'x' })).text, 'a generated spec');
    }
  });

  test('the served model is echoed back for the render cache key', async () => {
    const { impl } = fakeFetch(() => ({ body: CHAT_OK }));
    const p = createOpenAICompatibleProvider({
      baseUrl: 'https://api.example/v1',
      model: 'requested',
      fetchImpl: impl,
    });
    assert.equal((await p.generate({ prompt: 'x' })).model, 'served-model');
  });
});

describe('model deprecation is actionable', () => {
  test('a 404 reports what the endpoint actually offers', async () => {
    // The most likely failure in a long-lived deployment. A bare 404 sends
    // someone reading vendor changelogs; this names the fix.
    const { impl } = fakeFetch((url) =>
      url.endsWith('/models')
        ? { body: { data: [{ id: 'model-a' }, { id: 'model-b' }] } }
        : { status: 404, body: {} },
    );
    const p = createOpenAICompatibleProvider({
      baseUrl: 'https://api.example/v1',
      model: 'retired-model',
      fetchImpl: impl,
    });

    await assert.rejects(
      () => p.generate({ prompt: 'x' }),
      (err: unknown) => {
        if (!(err instanceof QuorumLlmError)) throw new Error('expected QuorumLlmError');
        assert.match(err.message, /retired-model/);
        assert.match(err.message, /model-a, model-b/);
        assert.deepEqual(err.availableModels, ['model-a', 'model-b']);
        return true;
      },
    );
  });

  test('discovery failure degrades to a plain error rather than masking the original', async () => {
    const { impl } = fakeFetch((url) => {
      if (url.endsWith('/models')) throw new Error('network down');
      return { status: 404, body: {} };
    });
    const p = createOpenAICompatibleProvider({
      baseUrl: 'https://api.example/v1',
      model: 'm',
      fetchImpl: impl,
    });
    await assert.rejects(() => p.generate({ prompt: 'x' }), /failed with 404/);
  });

  test('listModels returns an empty list when discovery is unsupported', async () => {
    const { impl } = fakeFetch(() => ({ status: 501, body: {} }));
    const p = createOpenAICompatibleProvider({
      baseUrl: 'https://api.example/v1',
      model: 'm',
      fetchImpl: impl,
    });
    assert.deepEqual(await p.listModels?.(), []);
  });

  test('non-model errors are surfaced without a misleading model hint', async () => {
    const { impl } = fakeFetch(() => ({ status: 429, body: {} }));
    const p = createOpenAICompatibleProvider({
      baseUrl: 'https://api.example/v1',
      model: 'm',
      fetchImpl: impl,
    });
    await assert.rejects(
      () => p.generate({ prompt: 'x' }),
      (err: unknown) => {
        if (!(err instanceof QuorumLlmError)) throw new Error('expected QuorumLlmError');
        assert.equal(err.status, 429);
        assert.equal(err.availableModels, undefined);
        return true;
      },
    );
  });
});

describe('request shape', () => {
  test('auth header is set only when a key is supplied', async () => {
    const withKey = fakeFetch(() => ({ body: CHAT_OK }));
    await createOpenAICompatibleProvider({
      baseUrl: 'https://x/v1',
      model: 'm',
      apiKey: 'secret',
      fetchImpl: withKey.impl,
    }).generate({ prompt: 'p' });
    assert.match(
      String((withKey.calls[0]?.init?.headers as Record<string, string>)?.authorization),
      /Bearer secret/,
    );

    // Local endpoints (Ollama, llama.cpp) need no auth and must not be sent
    // an empty bearer token, which some reject outright.
    const noKey = fakeFetch(() => ({ body: CHAT_OK }));
    await createOpenAICompatibleProvider({
      baseUrl: 'http://localhost:11434/v1',
      model: 'm',
      fetchImpl: noKey.impl,
    }).generate({ prompt: 'p' });
    assert.equal((noKey.calls[0]?.init?.headers as Record<string, string>)?.authorization, undefined);
  });

  test('temperature defaults to 0 so generated specs are reproducible', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: CHAT_OK }));
    await createOpenAICompatibleProvider({
      baseUrl: 'https://x/v1',
      model: 'm',
      fetchImpl: impl,
    }).generate({ prompt: 'p' });
    assert.equal(JSON.parse(String(calls[0]?.init?.body)).temperature, 0);
  });

  test('a system prompt is included only when provided', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: CHAT_OK }));
    const p = createOpenAICompatibleProvider({
      baseUrl: 'https://x/v1',
      model: 'm',
      fetchImpl: impl,
    });
    await p.generate({ prompt: 'p' });
    assert.equal(JSON.parse(String(calls[0]?.init?.body)).messages.length, 1);
    await p.generate({ prompt: 'p', system: 's' });
    assert.equal(JSON.parse(String(calls[1]?.init?.body)).messages[0].role, 'system');
  });

  test('a trailing slash on the base URL does not double up', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: CHAT_OK }));
    await createOpenAICompatibleProvider({
      baseUrl: 'https://x/v1///',
      model: 'm',
      fetchImpl: impl,
    }).generate({ prompt: 'p' });
    assert.equal(calls[0]?.url, 'https://x/v1/chat/completions');
  });

  test('empty content is an error, not an empty spec', async () => {
    const { impl } = fakeFetch(() => ({ body: { choices: [{ message: { content: '' } }] } }));
    await assert.rejects(
      () =>
        createOpenAICompatibleProvider({
          baseUrl: 'https://x/v1',
          model: 'm',
          fetchImpl: impl,
        }).generate({ prompt: 'p' }),
      /no content/,
    );
  });
});
