/**
 * The on-disk embedding cache, and choosing an embedder.
 *
 * The store's job is to make a sweep repeatable without a model, so the tests
 * that matter are the ones about surviving a file that is not pristine: a
 * truncated line, a missing file, a stale entry.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cacheKey, createHashingEmbedder } from '../../aggregate/src/embed-cache.ts';
import { openEmbeddingCache } from './embed-store.ts';
import { embedCorpus, MOCK, resolveEmbedder, STAND_IN } from './embed-run.ts';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-embed-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('openEmbeddingCache', () => {
  it('creates the file lazily and round-trips a vector', () => {
    const path = join(dir, 'round-trip.jsonl');
    const cache = openEmbeddingCache(path);

    assert.equal(cache.size, 0);
    cache.set(cacheKey('m', 'dark mode'), Float64Array.from([0.5, -0.25, 0]));

    const reopened = openEmbeddingCache(path);
    assert.deepEqual([...(reopened.get(cacheKey('m', 'dark mode')) as Float64Array)], [0.5, -0.25, 0]);
  });

  it('writes model and text as separate fields, so the file is greppable', () => {
    const path = join(dir, 'greppable.jsonl');
    openEmbeddingCache(path).set(cacheKey('nomic', 'csv export broken'), Float64Array.from([1]));

    const line = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>;
    assert.equal(line['model'], 'nomic');
    assert.equal(line['text'], 'csv export broken');
  });

  it('keeps a text containing a newline intact', () => {
    const path = join(dir, 'newline.jsonl');
    const text = 'first line\nsecond line';
    openEmbeddingCache(path).set(cacheKey('m', text), Float64Array.from([1]));

    // One JSON object per line, so an embedded newline has to survive as an
    // escape rather than splitting the record in two.
    assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1);
    assert.notEqual(openEmbeddingCache(path).get(cacheKey('m', text)), undefined);
  });

  it('rounds to six decimals, which cosine cannot tell apart', () => {
    const path = join(dir, 'precision.jsonl');
    openEmbeddingCache(path).set(cacheKey('m', 'x'), Float64Array.from([0.123456789]));

    const [value] = [...(openEmbeddingCache(path).get(cacheKey('m', 'x')) as Float64Array)];
    assert.equal(value, 0.123457);
  });

  it('skips a line truncated by a crash rather than refusing to start', () => {
    const path = join(dir, 'truncated.jsonl');
    const good = JSON.stringify({ model: 'm', text: 'kept', vector: [1] });
    writeFileSync(path, `${good}\n{"model":"m","text":"cut off","vec`);

    const cache = openEmbeddingCache(path);
    assert.equal(cache.corrupt, 1);
    assert.notEqual(cache.get(cacheKey('m', 'kept')), undefined);
  });

  it('skips a well-formed line that is the wrong shape', () => {
    const path = join(dir, 'wrong-shape.jsonl');
    writeFileSync(path, '{"model":"m","text":"x"}\n{"nonsense":true}\n');

    // Valid JSON, no vector. Loading it as one would put `undefined` where a
    // Float64Array belongs and fail somewhere far away.
    assert.equal(openEmbeddingCache(path).corrupt, 2);
  });

  it('lets a later entry win, so re-embedding updates', () => {
    const path = join(dir, 'update.jsonl');
    const cache = openEmbeddingCache(path);
    cache.set(cacheKey('m', 'x'), Float64Array.from([1]));
    cache.set(cacheKey('m', 'x'), Float64Array.from([2]));

    assert.deepEqual([...(openEmbeddingCache(path).get(cacheKey('m', 'x')) as Float64Array)], [2]);
  });

  it('counts what this process wrote', () => {
    const cache = openEmbeddingCache(join(dir, 'counts.jsonl'));
    cache.set(cacheKey('m', 'a'), Float64Array.from([1]));
    cache.set(cacheKey('m', 'b'), Float64Array.from([1]));
    assert.equal(cache.written, 2);
  });
});

describe('resolveEmbedder', () => {
  it('is none when nothing is configured', () => {
    const resolved = resolveEmbedder({});
    assert.equal(resolved.kind, 'none');
    assert.equal(resolved.embedder, undefined);
    assert.match(resolved.provenance, /no embedder configured/);
  });

  it('returns the stand-in only when asked for by name', () => {
    const resolved = resolveEmbedder({ QUORUM_EMBED_PROVIDER: STAND_IN });
    assert.equal(resolved.kind, 'stand-in');
    // Falling back to it silently would let a reader believe a hash function's
    // score said something about a model.
    assert.match(resolved.provenance, /NOT a semantic model/);
  });

  it('prefers a configured model over everything', () => {
    const resolved = resolveEmbedder({
      QUORUM_EMBED_PROVIDER: 'ollama',
      QUORUM_EMBED_BASE_URL: 'http://127.0.0.1:11434/v1',
      QUORUM_EMBED_MODEL: 'some-model',
    });
    assert.equal(resolved.kind, 'model');
    assert.match(resolved.provenance, /real measurement/);
  });

  it('refuses to call the mock endpoint a measurement', () => {
    const resolved = resolveEmbedder({
      QUORUM_EMBED_PROVIDER: MOCK,
      QUORUM_EMBED_BASE_URL: 'http://127.0.0.1:11500/v1',
      QUORUM_EMBED_MODEL: 'whatever',
    });

    // It goes over real HTTP through the real adapter, so nothing else can
    // tell it apart from Ollama. Reporting hash vectors as a model's numbers
    // is the exact failure the provenance line exists to prevent.
    assert.equal(resolved.kind, 'mock');
    assert.match(resolved.provenance, /WIRING CHECK/);
    assert.ok(!/real measurement/.test(resolved.provenance));
  });

  it('is none when a provider is named but half-configured', () => {
    // Fails closed, like the LLM provider: a half-configured deployment
    // degrades to lexical rather than throwing on every ingest.
    const resolved = resolveEmbedder({ QUORUM_EMBED_PROVIDER: 'ollama' });
    assert.equal(resolved.kind, 'none');
  });

  it('names the model in its provenance, so a report can never be anonymous', () => {
    const resolved = resolveEmbedder({
      QUORUM_EMBED_PROVIDER: 'openai',
      QUORUM_EMBED_BASE_URL: 'https://example.invalid/v1',
      QUORUM_EMBED_MODEL: 'm',
    });
    assert.match(resolved.provenance, /example\.invalid/);
  });
});

describe('embedCorpus', () => {
  it('embeds every text once and reports the split', async () => {
    const cache = openEmbeddingCache(join(dir, 'corpus.jsonl'));
    const texts = ['a', 'b', 'a', 'c'];

    const first = await embedCorpus(createHashingEmbedder(), texts, cache);
    assert.equal(first.vectors.length, 4);
    assert.equal(first.embedded, 3);
    assert.equal(first.reused, 1);

    const second = await embedCorpus(createHashingEmbedder(), texts, cache);
    assert.equal(second.embedded, 0, 'the second pass should be entirely cached');
    assert.equal(second.reused, 4);
  });

  it('batches without losing order', async () => {
    const texts = Array.from({ length: 10 }, (_, i) => `text number ${String(i)}`);
    const cache = openEmbeddingCache(join(dir, 'batched.jsonl'));

    const batched = await embedCorpus(createHashingEmbedder(), texts, cache, 3);
    const whole = await createHashingEmbedder().embed(texts);

    for (let i = 0; i < texts.length; i++) {
      assert.deepEqual([...(batched.vectors[i] as Float64Array)], [...(whole[i] as Float64Array)]);
    }
  });
});
