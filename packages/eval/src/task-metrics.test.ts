import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadCorpus, truthLabels } from './corpus.ts';
import { topKAgreement } from './task-metrics.ts';
import { allOneCluster, allSingletons, structural } from './baselines.ts';
import { clusterDocs } from '../../aggregate/src/cluster.ts';
import { evaluate } from './metrics.ts';

const corpus = loadCorpus();
const truth = truthLabels(corpus);
const NOW = '2026-09-01T00:00:00Z';
const docs = corpus.submissions.map((s) => ({
  id: s.id,
  text: s.body,
  route: s.route,
  appVersion: s.appVersion,
  platform: s.platform,
}));

describe('topKAgreement — contract', () => {
  test('perfect clustering recovers the whole top ten with full capture', () => {
    const r = topKAgreement(corpus, truth, 10, NOW);
    assert.equal(r.recallAtK, 1);
    assert.equal(r.hits.length, 10);
    assert.deepEqual(r.misses, []);
    assert.equal(r.meanCapture, 1);
  });

  test('shattering everything destroys the list', () => {
    const r = topKAgreement(corpus, allSingletons(corpus.submissions), 10, NOW);
    assert.ok(r.recallAtK < 0.5);
    assert.ok(r.meanCapture < 0.25, 'every issue is maximally fragmented');
  });

  test('merging everything into one cluster cannot fill a top ten', () => {
    const r = topKAgreement(corpus, allOneCluster(corpus.submissions), 10, NOW);
    assert.ok(r.hits.length <= 1);
  });

  test('rejects misaligned predictions', () => {
    assert.throws(() => topKAgreement(corpus, ['x'], 10, NOW), /align/);
  });

  test('is deterministic', () => {
    const labels = clusterDocs(docs, { threshold: 0.15 }).labels;
    assert.deepEqual(
      topKAgreement(corpus, labels, 10, NOW),
      topKAgreement(corpus, labels, 10, NOW),
    );
  });

  test('hits and misses partition the truth top-k', () => {
    const r = topKAgreement(corpus, structural()(corpus.submissions), 10, NOW);
    assert.equal(r.hits.length + r.misses.length, r.truthTop.length);
    for (const m of r.misses) assert.ok(!r.hits.includes(m));
  });

  test('praise never appears in the truth top ten', () => {
    // Ranking excludes it; if this ever fails, rank() stopped filtering.
    const r = topKAgreement(corpus, truth, 10, NOW);
    assert.ok(!r.truthTop.some((t) => t.startsWith('praise-')));
  });
});

describe('the finding: ARI does not track ranked-list quality', () => {
  // This is why the harness reports top-K as the headline and treats the
  // clustering metrics as diagnostics. Recorded in ADR-0014.

  function measure(threshold: number) {
    const labels = clusterDocs(docs, { threshold }).labels;
    return {
      ari: evaluate(truth, labels).adjustedRandIndex,
      top10: topKAgreement(corpus, labels, 10, NOW).hits.length,
    };
  }

  test('the best-ARI threshold is not the best top-ten threshold', () => {
    const candidates = [0.1, 0.15, 0.2, 0.25].map((t) => ({ t, ...measure(t) }));
    const bestAri = candidates.reduce((a, b) => (b.ari > a.ari ? b : a));
    const bestTop = candidates.reduce((a, b) => (b.top10 > a.top10 ? b : a));
    assert.ok(
      bestAri.top10 < bestTop.top10,
      `tuning on ARI would pick t=${bestAri.t} (${bestAri.top10}/10) over t=${bestTop.t} (${bestTop.top10}/10)`,
    );
  });

  test('even the best lexical configuration loses half the top ten', () => {
    // The evidence that killed the "v1 with no ML" plan. If a change makes
    // this pass at 8+, revisit ADR-0014 — the embedding requirement may be gone.
    const best = Math.max(...[0.1, 0.15, 0.2, 0.25].map((t) => measure(t).top10));
    assert.ok(best <= 6, `expected lexical to cap out around half, got ${best}/10`);
  });

  test('found issues are still badly fragmented, understating their rank', () => {
    const r = topKAgreement(corpus, clusterDocs(docs, { threshold: 0.2 }).labels, 10, NOW);
    assert.ok(r.meanCapture < 0.75, `capture ${r.meanCapture.toFixed(2)}`);
  });
});
