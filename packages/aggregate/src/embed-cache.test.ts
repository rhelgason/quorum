/**
 * The embedding cache and the stand-in embedder.
 *
 * The properties worth testing here are all about *correspondence*: a cache
 * that returns the right vectors in the wrong order, or one vector for the
 * wrong text, produces a clustering that looks entirely plausible and is
 * nonsense. None of that fails loudly downstream.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cacheKey,
  cachingEmbedder,
  createHashingEmbedder,
  createMemoryEmbeddingCache,
  parseCacheKey,
} from './embed-cache.ts';
import { denseCosine } from './embed.ts';
import type { Embedder } from './embed.ts';

/** An embedder that records what it was asked and returns identifiable vectors. */
function recordingEmbedder(name = 'test-model'): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    name,
    calls,
    embed(texts) {
      calls.push([...texts]);
      // The vector encodes its text's length, so a misrouted vector is visible.
      return Promise.resolve(texts.map((t) => Float64Array.from([t.length, 0, 0])));
    },
  };
}

describe('cacheKey', () => {
  it('round-trips through parseCacheKey', () => {
    const { model, text } = parseCacheKey(cacheKey('nomic', 'add dark mode'));
    assert.equal(model, 'nomic');
    assert.equal(text, 'add dark mode');
  });

  it('does not collide when the separator appears ambiguous', () => {
    // model "a" + text "b:c" must differ from model "a:b" + text "c".
    assert.notEqual(cacheKey('a', 'b:c'), cacheKey('a:b', 'c'));
  });

  it('keeps text containing newlines and colons intact', () => {
    const text = 'line one:\nline two';
    assert.equal(parseCacheKey(cacheKey('m', text)).text, text);
  });

  it('treats a key with no separator as pure text', () => {
    assert.deepEqual(parseCacheKey('bare'), { model: '', text: 'bare' });
  });
});

describe('cachingEmbedder', () => {
  it('embeds once and serves the rest from cache', async () => {
    const inner = recordingEmbedder();
    const cached = cachingEmbedder(inner, createMemoryEmbeddingCache());

    await cached.embed(['alpha', 'beta']);
    await cached.embed(['alpha', 'beta']);

    assert.equal(inner.calls.length, 1, 'the second call should have hit the cache entirely');
    assert.deepEqual(cached.stats, { hits: 2, misses: 2, deduped: 0 });
  });

  it('deduplicates repeats inside one batch', async () => {
    const inner = recordingEmbedder();
    const cached = cachingEmbedder(inner, createMemoryEmbeddingCache());

    await cached.embed(['dark mode', 'dark mode', 'dark mode']);

    // A feedback corpus is full of exact repeats; embedding each occurrence is
    // pure waste against a metered endpoint.
    assert.deepEqual(inner.calls[0], ['dark mode']);
    assert.equal(cached.stats.deduped, 2);
  });

  it('returns vectors in input order, including duplicates', async () => {
    const inner = recordingEmbedder();
    const cached = cachingEmbedder(inner, createMemoryEmbeddingCache());

    const out = await cached.embed(['aaa', 'b', 'aaa', 'cccc']);

    // Encoded as length, so a misroute is detectable rather than plausible.
    assert.deepEqual([...(out[0] as Float64Array)], [3, 0, 0]);
    assert.deepEqual([...(out[1] as Float64Array)], [1, 0, 0]);
    assert.deepEqual([...(out[2] as Float64Array)], [3, 0, 0]);
    assert.deepEqual([...(out[3] as Float64Array)], [4, 0, 0]);
  });

  it('mixes cached and fresh texts without losing position', async () => {
    const inner = recordingEmbedder();
    const cache = createMemoryEmbeddingCache();
    const cached = cachingEmbedder(inner, cache);

    await cached.embed(['bb']);
    inner.calls.length = 0;

    const out = await cached.embed(['a', 'bb', 'ccc']);
    assert.deepEqual(inner.calls[0], ['a', 'ccc'], 'only the misses go to the model');
    assert.deepEqual(
      out.map((v) => v[0]),
      [1, 2, 3],
    );
  });

  it('scopes entries per model', async () => {
    const cache = createMemoryEmbeddingCache();
    const first = recordingEmbedder('model-a');
    const second = recordingEmbedder('model-b');

    await cachingEmbedder(first, cache).embed(['shared']);
    await cachingEmbedder(second, cache).embed(['shared']);

    // Two models produce different vectors for one sentence. Serving one for
    // the other yields a similarity matrix that is meaningless in a way
    // nothing downstream could detect.
    assert.equal(second.calls.length, 1);
    assert.equal(cache.size, 2);
  });

  it('throws when the model returns the wrong number of vectors', async () => {
    const broken: Embedder = {
      name: 'broken',
      embed: () => Promise.resolve([Float64Array.from([1])]),
    };
    await assert.rejects(
      cachingEmbedder(broken, createMemoryEmbeddingCache()).embed(['a', 'b']),
      /returned 1 vectors for 2 inputs/,
    );
  });

  it('handles an empty batch without calling the model', async () => {
    const inner = recordingEmbedder();
    const out = await cachingEmbedder(inner, createMemoryEmbeddingCache()).embed([]);
    assert.deepEqual(out, []);
    assert.equal(inner.calls.length, 0);
  });

  it('carries the inner name through, so keys stay stable', () => {
    const cached = cachingEmbedder(recordingEmbedder('nomic'), createMemoryEmbeddingCache());
    assert.equal(cached.name, 'nomic');
  });
});

describe('createHashingEmbedder', () => {
  const embedder = createHashingEmbedder();

  it('is deterministic', async () => {
    const [a] = await embedder.embed(['the csv export is broken']);
    const [b] = await embedder.embed(['the csv export is broken']);
    assert.deepEqual([...(a as Float64Array)], [...(b as Float64Array)]);
  });

  it('produces unit vectors, so cosine is a dot product', async () => {
    const [v] = await embedder.embed(['dark mode please']);
    const norm = Math.sqrt([...(v as Float64Array)].reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9, `expected unit length, got ${String(norm)}`);
  });

  it('scores shared vocabulary as similar', async () => {
    const [a, b] = await embedder.embed([
      'the csv export is broken',
      'csv export broken again',
    ]);
    assert.ok(denseCosine(a as Float64Array, b as Float64Array) > 0.3);
  });

  it('scores unrelated text as dissimilar', async () => {
    const [a, b] = await embedder.embed([
      'the csv export is broken',
      'please add a dark mode',
    ]);
    assert.ok(denseCosine(a as Float64Array, b as Float64Array) < 0.2);
  });

  it('cannot bridge paraphrase, which is the whole point of the disclaimer', async () => {
    // If this ever starts passing as a *semantic* match, the stand-in has
    // stopped being an honest stand-in and the docs around it are lying.
    const [a, b] = await embedder.embed([
      'please add a dark mode',
      'why is everything so white, it hurts at night',
    ]);
    assert.ok(
      denseCosine(a as Float64Array, b as Float64Array) < 0.2,
      'a hash function is not a semantic model',
    );
  });

  it('respects the requested dimensionality', async () => {
    const small = createHashingEmbedder({ dimensions: 32 });
    const [v] = await small.embed(['anything']);
    assert.equal((v as Float64Array).length, 32);
    assert.equal(small.dimensions, 32);
  });

  it('returns a zero vector for text with no usable tokens', async () => {
    // Not a crash and not NaN: normalizeDense leaves an all-zero vector alone,
    // and the clusterer treats a zero vector as no signal rather than as
    // similarity zero.
    const [v] = await embedder.embed(['!!! ???']);
    assert.ok([...(v as Float64Array)].every((x) => x === 0));
  });
});
