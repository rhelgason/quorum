import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createOpenAICompatibleEmbedder,
  DenseCentroid,
  denseCosine,
  embedderFromEnv,
  normalizeDense,
  QuorumEmbedError,
} from './embed.ts';

function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status?: number; body: unknown },
): { impl: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const { status = 200, body } = handler(String(url), init);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const rows = (n: number, offset = 0) => ({
  data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [i + offset, 1, 0] })),
});

describe('denseCosine', () => {
  test('is 1 for identical and 0 for orthogonal', () => {
    const a = Float64Array.from([1, 0, 0]);
    const b = Float64Array.from([0, 1, 0]);
    assert.ok(Math.abs(denseCosine(a, a) - 1) < 1e-12);
    assert.equal(denseCosine(a, b), 0);
  });

  test('is -1 for opposed vectors', () => {
    assert.ok(
      Math.abs(denseCosine(Float64Array.from([1, 0]), Float64Array.from([-1, 0])) + 1) < 1e-12,
    );
  });

  test('handles zero vectors without producing NaN', () => {
    assert.equal(denseCosine(Float64Array.from([0, 0]), Float64Array.from([1, 1])), 0);
  });
});

describe('normalizeDense', () => {
  test('scales to unit length', () => {
    const v = normalizeDense(Float64Array.from([3, 4]));
    assert.ok(Math.abs((v[0] as number) - 0.6) < 1e-12);
    assert.ok(Math.abs((v[1] as number) - 0.8) < 1e-12);
  });

  test('leaves a zero vector alone', () => {
    assert.deepEqual(Array.from(normalizeDense(Float64Array.from([0, 0]))), [0, 0]);
  });
});

describe('DenseCentroid', () => {
  const a = normalizeDense(Float64Array.from([1, 0, 0]));
  const b = normalizeDense(Float64Array.from([0, 1, 0]));

  test('starts empty', () => {
    const c = new DenseCentroid();
    assert.equal(c.size, 0);
    assert.equal(c.vector(), undefined);
  });

  test('a single member is its own centroid', () => {
    const c = new DenseCentroid();
    c.add(a);
    assert.ok(Math.abs(denseCosine(c.vector() as Float64Array, a) - 1) < 1e-12);
  });

  test('remove exactly reverses add', () => {
    const c = new DenseCentroid();
    c.add(a);
    const before = c.vector() as Float64Array;
    c.add(b);
    c.remove(b);
    assert.equal(c.size, 1);
    assert.ok(Math.abs(denseCosine(c.vector() as Float64Array, before) - 1) < 1e-12);
  });

  test('add/remove cycles do not drift', () => {
    const c = new DenseCentroid();
    c.add(a);
    for (let i = 0; i < 500; i++) {
      c.add(b);
      c.remove(b);
    }
    assert.ok(Math.abs(denseCosine(c.vector() as Float64Array, a) - 1) < 1e-9);
  });

  test('removing from empty throws rather than corrupting state', () => {
    assert.throws(() => new DenseCentroid().remove(a), /empty centroid/);
  });
});

describe('embedderFromEnv — absent by default', () => {
  test('an empty environment yields no embedder', () => {
    assert.equal(embedderFromEnv({}), undefined);
  });

  test('partial configuration fails closed', () => {
    assert.equal(embedderFromEnv({ QUORUM_EMBED_PROVIDER: 'ollama' }), undefined);
    assert.equal(
      embedderFromEnv({ QUORUM_EMBED_PROVIDER: 'ollama', QUORUM_EMBED_MODEL: 'm' }),
      undefined,
    );
  });

  test('off switches are honored', () => {
    for (const v of ['none', 'off', 'false', '', ' NONE ']) {
      assert.equal(embedderFromEnv({ QUORUM_EMBED_PROVIDER: v }), undefined, `for '${v}'`);
    }
  });

  test('full configuration produces an embedder named for the provider', () => {
    const e = embedderFromEnv({
      QUORUM_EMBED_PROVIDER: 'ollama',
      QUORUM_EMBED_BASE_URL: 'http://localhost:11434/v1',
      QUORUM_EMBED_MODEL: 'whatever',
    });
    assert.equal(e?.name, 'ollama');
  });
});

describe('OpenAI-compatible embedder', () => {
  test('sends the configured model verbatim, with no allowlist', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: rows(1) }));
    const e = createOpenAICompatibleEmbedder({
      baseUrl: 'https://x/v1',
      model: 'model-not-invented-yet-2031',
      fetchImpl: impl,
    });
    await e.embed(['hello']);
    assert.equal(JSON.parse(String(calls[0]?.init?.body)).model, 'model-not-invented-yet-2031');
  });

  test('returns one unit-length vector per input', async () => {
    const { impl } = fakeFetch(() => ({ body: rows(2) }));
    const out = await createOpenAICompatibleEmbedder({
      baseUrl: 'https://x/v1',
      model: 'm',
      fetchImpl: impl,
    }).embed(['a', 'b']);
    assert.equal(out.length, 2);
    for (const v of out) {
      let sum = 0;
      for (const x of v) sum += x * x;
      assert.ok(Math.abs(sum - 1) < 1e-9);
    }
  });

  test('batches large inputs', async () => {
    const { impl, calls } = fakeFetch((_u, init) => {
      const n = JSON.parse(String(init?.body)).input.length;
      return { body: rows(n) };
    });
    const e = createOpenAICompatibleEmbedder({
      baseUrl: 'https://x/v1',
      model: 'm',
      batchSize: 2,
      fetchImpl: impl,
    });
    const out = await e.embed(['a', 'b', 'c', 'd', 'e']);
    assert.equal(out.length, 5);
    assert.equal(calls.length, 3, '5 inputs at batch size 2 is three requests');
  });

  test('sorts responses by index instead of trusting arrival order', async () => {
    // An endpoint returning out of order would otherwise attach the wrong
    // vector to a submission and corrupt clusters with no visible error.
    const { impl } = fakeFetch(() => ({
      body: {
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      },
    }));
    const out = await createOpenAICompatibleEmbedder({
      baseUrl: 'https://x/v1',
      model: 'm',
      fetchImpl: impl,
    }).embed(['first', 'second']);
    assert.ok(Math.abs((out[0]?.[0] as number) - 1) < 1e-12, 'first input got index 0');
    assert.ok(Math.abs((out[1]?.[1] as number) - 1) < 1e-12);
  });

  test('rejects a count mismatch rather than silently misaligning', async () => {
    const { impl } = fakeFetch(() => ({ body: rows(1) }));
    await assert.rejects(
      () =>
        createOpenAICompatibleEmbedder({
          baseUrl: 'https://x/v1',
          model: 'm',
          fetchImpl: impl,
        }).embed(['a', 'b']),
      /returned 1 embeddings for 2 inputs/,
    );
  });

  test('rejects a malformed embedding', async () => {
    const { impl } = fakeFetch(() => ({ body: { data: [{ index: 0, embedding: 'nope' }] } }));
    await assert.rejects(
      () =>
        createOpenAICompatibleEmbedder({
          baseUrl: 'https://x/v1',
          model: 'm',
          fetchImpl: impl,
        }).embed(['a']),
      /malformed embedding/,
    );
  });

  test('surfaces HTTP failures as QuorumEmbedError with a status', async () => {
    const { impl } = fakeFetch(() => ({ status: 503, body: {} }));
    await assert.rejects(
      () =>
        createOpenAICompatibleEmbedder({
          baseUrl: 'https://x/v1',
          model: 'm',
          fetchImpl: impl,
        }).embed(['a']),
      (err: unknown) => {
        if (!(err instanceof QuorumEmbedError)) throw new Error('expected QuorumEmbedError');
        assert.equal(err.status, 503);
        return true;
      },
    );
  });

  test('omits auth for local endpoints and includes it when keyed', async () => {
    const local = fakeFetch(() => ({ body: rows(1) }));
    await createOpenAICompatibleEmbedder({
      baseUrl: 'http://localhost:11434/v1',
      model: 'm',
      fetchImpl: local.impl,
    }).embed(['a']);
    assert.equal(
      (local.calls[0]?.init?.headers as Record<string, string>)?.authorization,
      undefined,
    );

    const keyed = fakeFetch(() => ({ body: rows(1) }));
    await createOpenAICompatibleEmbedder({
      baseUrl: 'https://x/v1',
      model: 'm',
      apiKey: 'k',
      fetchImpl: keyed.impl,
    }).embed(['a']);
    assert.match(
      String((keyed.calls[0]?.init?.headers as Record<string, string>)?.authorization),
      /Bearer k/,
    );
  });

  test('an empty input makes no request', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: rows(0) }));
    assert.deepEqual(
      await createOpenAICompatibleEmbedder({
        baseUrl: 'https://x/v1',
        model: 'm',
        fetchImpl: impl,
      }).embed([]),
      [],
    );
    assert.equal(calls.length, 0);
  });
});
