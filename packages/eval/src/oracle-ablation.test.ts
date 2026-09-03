/**
 * Oracle ablation: is a semantic signal worth building, and how good must it be?
 *
 * The oracle cheats — it derives vectors from ground-truth labels. That makes
 * it useless for claiming clustering quality and ideal for measuring the
 * *headroom of everything downstream of similarity*. Recorded in ADR-0019.
 *
 * Kept to a handful of configurations; the full sweep is in the ADR.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { clusterDocs, type Doc } from '../../aggregate/src/cluster.ts';
import { loadCorpus } from './corpus.ts';
import { toDocs } from './adapt.ts';
import { topKAgreement } from './task-metrics.ts';
import { createOracleEmbedder } from './oracle-embedder.ts';

const corpus = loadCorpus();
const NOW = '2026-09-01T00:00:00Z';
const baseDocs = toDocs(corpus.submissions);
const labelByText = new Map(corpus.submissions.map((s) => [s.body, s.cluster]));

/** Cache embeddings per noise level; each call embeds all 161 submissions. */
const cache = new Map<number, Float64Array[]>();

async function docsWithOracle(noise: number): Promise<Doc[]> {
  let vectors = cache.get(noise);
  if (vectors === undefined) {
    const embedder = createOracleEmbedder((t) => labelByText.get(t) ?? 'unknown', { noise });
    vectors = await embedder.embed(baseDocs.map((d) => d.text));
    cache.set(noise, vectors);
  }
  return baseDocs.map((d, i) => ({ ...d, vector: vectors[i] as Float64Array }));
}

async function topTen(noise: number, semanticWeight: number, threshold: number): Promise<number> {
  const docs = await docsWithOracle(noise);
  const labels = clusterDocs(docs, { threshold, semanticWeight }).labels;
  return topKAgreement(corpus, labels, 10, NOW).hits.length;
}

before(async () => {
  await docsWithOracle(0);
});

describe('the architecture is not the bottleneck', () => {
  test('a perfect semantic signal produces a perfect ranked list', () => {
    // The question worth answering before building an embedding pipeline: if
    // similarity were solved, would everything downstream — clustering,
    // ranking, medoid labelling — actually deliver? It does.
    return topTen(0, 0.8, 0.3).then((hits) => {
      assert.equal(hits, 10, `expected 10/10 with a perfect oracle, got ${hits}/10`);
    });
  });

  test('so the 6/10 lexical ceiling is a similarity problem, not a design problem', async () => {
    // Same pipeline, same ranking, same corpus. Only the similarity signal
    // changed. That isolates where the remaining error lives.
    const oracle = await topTen(0, 0.8, 0.3);
    const lexicalOnly = topKAgreement(
      corpus,
      clusterDocs(baseDocs, { threshold: 0.15 }).labels,
      10,
      NOW,
    ).hits.length;
    assert.ok(oracle > lexicalOnly + 3, `oracle ${oracle}/10 vs lexical ${lexicalOnly}/10`);
  });
});

describe('how good the embedder must be', () => {
  test('the pipeline tolerates substantial signal degradation', async () => {
    // Half the vector replaced by noise and the list is still nearly right.
    // The practical read: a modest local sentence-transformer is enough, and
    // there is no case for reaching for a large model.
    const hits = await topTen(0.5, 0.5, 0.2);
    assert.ok(hits >= 8, `expected >=8/10 at 50% noise, got ${hits}/10`);
  });

  test('but degrades sharply past that', async () => {
    // The cliff is what makes this a usable spec rather than a vague hope:
    // there is a quality bar, and it is locatable.
    const good = await topTen(0.5, 0.5, 0.2);
    const bad = await topTen(0.8, 0.5, 0.2);
    assert.ok(bad < good, `expected degradation: 0.5→${good}/10, 0.8→${bad}/10`);
  });
});

describe('hybrid beats pure semantic', () => {
  test('with a good signal, both work', async () => {
    assert.ok((await topTen(0.2, 0.5, 0.2)) >= 9);
    assert.ok((await topTen(0.2, 1.0, 0.4)) >= 9);
  });

  test('with a degraded signal, the lexical half is a floor', async () => {
    // This is the argument for blending rather than replacing. When the
    // semantic signal rots, pure-semantic clustering collapses while the
    // hybrid keeps working — lexical precision on shared product nouns does
    // not degrade just because the model is bad.
    const hybrid = await topTen(0.8, 0.5, 0.2);
    const pureSemantic = await topTen(0.8, 1.0, 0.4);
    assert.ok(
      hybrid > pureSemantic,
      `hybrid ${hybrid}/10 should beat pure semantic ${pureSemantic}/10 under noise`,
    );
  });
});

describe('oracle embedder mechanics', () => {
  test('is deterministic across calls and batch boundaries', async () => {
    const make = () => createOracleEmbedder((t) => labelByText.get(t) ?? 'x', { noise: 0.5 });
    const texts = baseDocs.slice(0, 6).map((d) => d.text);
    const whole = await make().embed(texts);
    const split = [...(await make().embed(texts.slice(0, 3))), ...(await make().embed(texts.slice(3)))];
    for (let i = 0; i < texts.length; i++) {
      assert.deepEqual(Array.from(whole[i] as Float64Array), Array.from(split[i] as Float64Array));
    }
  });

  test('noise 0 gives identical vectors to same-cluster items', async () => {
    const embedder = createOracleEmbedder((t) => labelByText.get(t) ?? 'x', { noise: 0 });
    const dark = corpus.submissions.filter((s) => s.cluster === 'dark-mode').slice(0, 2);
    const [a, b] = await embedder.embed(dark.map((s) => s.body));
    assert.deepEqual(Array.from(a as Float64Array), Array.from(b as Float64Array));
  });

  test('returns one vector per input, unit length', async () => {
    const embedder = createOracleEmbedder(() => 'c', { noise: 0.3 });
    const out = await embedder.embed(['a', 'b', 'c']);
    assert.equal(out.length, 3);
    for (const v of out) {
      let sum = 0;
      for (const x of v) sum += x * x;
      assert.ok(Math.abs(sum - 1) < 1e-9, `not unit length: ${sum}`);
    }
  });

  test('handles an empty batch', async () => {
    assert.deepEqual(await createOracleEmbedder(() => 'c', { noise: 0 }).embed([]), []);
  });
});
