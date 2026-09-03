/**
 * The measurement ADR-0013 left open.
 *
 * Structural clustering cannot rank feature requests, so the v0.1 promise now
 * rests on lexical similarity carrying the ranked list. This file answers
 * whether it can, and pins the answer so a regression is visible.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { clusterDocs, type Doc } from '../../aggregate/src/cluster.ts';
import { loadCorpus, truthLabels, type Submission } from './corpus.ts';
import { evaluate } from './metrics.ts';
import { scoreHardPairs } from './hard-pairs.ts';

const corpus = loadCorpus();

export function toDocs(submissions: readonly Submission[]): Doc[] {
  return submissions.map((s) => ({
    id: s.id,
    text: s.body,
    route: s.route,
    appVersion: s.appVersion,
    platform: s.platform,
  }));
}

const docs = toDocs(corpus.submissions);
const truth = truthLabels(corpus);

function scoreAt(threshold: number, opts: { bigrams?: boolean; structuralBonus?: number } = {}) {
  const result = clusterDocs(docs, {
    threshold,
    structuralBonus: opts.structuralBonus ?? 0,
    tokenize: { bigrams: opts.bigrams ?? false },
  });
  return {
    metrics: evaluate(truth, result.labels),
    pairs: scoreHardPairs(corpus, result.labels),
  };
}

describe('lexical clustering beats every prior baseline', () => {
  // The bar to clear, from packages/eval/README.md.
  const STRUCTURAL_BEST_ARI = 0.138;
  const STRUCTURAL_BEST_F1 = 0.162;

  test('at a swept threshold it is several times better than structural', () => {
    let best = { ari: -1, f1: -1, threshold: 0 };
    for (let t = 0.05; t <= 0.6; t += 0.05) {
      const { metrics } = scoreAt(t);
      if (metrics.adjustedRandIndex > best.ari) {
        best = { ari: metrics.adjustedRandIndex, f1: metrics.pairwise.f1, threshold: t };
      }
    }
    assert.ok(
      best.ari > STRUCTURAL_BEST_ARI * 2,
      `expected a large improvement over structural ${STRUCTURAL_BEST_ARI}, got ${best.ari.toFixed(3)} at t=${best.threshold.toFixed(2)}`,
    );
    assert.ok(best.f1 > STRUCTURAL_BEST_F1 * 2, `F1 ${best.f1.toFixed(3)}`);
  });

  test('crucially, it works on feature requests where structural did not', () => {
    // Structural scored ARI 0.023 on this slice — the finding that broke v0.1.
    const featureIdx = corpus.submissions
      .map((s, i) => (s.kind === 'feature_request' ? i : -1))
      .filter((i) => i >= 0);
    const featureDocs = featureIdx.map((i) => docs[i] as Doc);
    const featureTruth = featureIdx.map((i) => truth[i] as string);

    const result = clusterDocs(featureDocs, { threshold: 0.25 });
    const m = evaluate(featureTruth, result.labels);
    assert.ok(
      m.adjustedRandIndex > 0.2,
      `feature-request ARI must clear structural's 0.023 by an order of magnitude, got ${m.adjustedRandIndex.toFixed(3)}`,
    );
  });
});

describe('threshold behaves monotonically, as a tunable knob must', () => {
  test('precision rises and recall falls as the threshold rises', () => {
    const low = scoreAt(0.1).metrics.pairwise;
    const high = scoreAt(0.5).metrics.pairwise;
    assert.ok(high.precision > low.precision, 'precision should rise');
    assert.ok(high.recall < low.recall, 'recall should fall');
  });

  test('no threshold collapses the corpus into one cluster or shatters it', () => {
    assert.ok(scoreAt(0.1).metrics.predictedClusters > 1);
    assert.ok(scoreAt(0.5).metrics.predictedClusters < corpus.submissions.length);
  });
});

describe('what lexical clustering still cannot do', () => {
  // These are the limits that decide whether embeddings are needed, so they
  // are asserted rather than left as prose.

  test('it cannot solve paraphrase with no shared vocabulary', () => {
    // 'add dark mode' vs 'the app destroys my eyes at night' — zero content
    // overlap. No lexical method can join these; this is what embeddings buy.
    const result = clusterDocs(docs, { threshold: 0.25 });
    const byId = new Map(corpus.submissions.map((s, i) => [s.id, result.labels[i]]));
    assert.notEqual(
      byId.get('s001'),
      byId.get('s002'),
      'if this ever passes, re-run the embedding cost/benefit — the gap closed',
    );
  });

  test('it still over-merges the feature-vs-bug trap without bigrams', () => {
    const result = clusterDocs(docs, { threshold: 0.25, tokenize: { bigrams: false } });
    const byId = new Map(corpus.submissions.map((s, i) => [s.id, result.labels[i]]));
    assert.equal(
      byId.get('s016'),
      byId.get('s024'),
      'csv-export and its bug report share every noun',
    );
  });

  test('but bigrams DO rescue the feature-vs-bug trap', () => {
    // Contrary to expectation: word order carries the intent signal here.
    // "export expenses to csv" and "csv export is missing the last row" share
    // every unigram and no bigram. Cheap, and it fixes the corpus's hardest
    // designed trap — which is why bigrams are on in the recommended config.
    const result = clusterDocs(docs, { threshold: 0.25, tokenize: { bigrams: true } });
    const byId = new Map(corpus.submissions.map((s, i) => [s.id, result.labels[i]]));
    assert.notEqual(byId.get('s016'), byId.get('s024'));
  });

  test('overall hard-pair accuracy stays mediocre even when ARI is good', () => {
    // The reason aggregate metrics are never read alone.
    const { pairs } = scoreAt(0.25);
    assert.ok(pairs.accuracy < 0.85, `got ${pairs.accuracy.toFixed(2)} — update ADR if this jumps`);
  });
});
