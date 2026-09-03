/**
 * Does offline consolidation repair the fragmentation ADR-0014 diagnosed?
 *
 * Yes, partially, and the shape of the answer justifies the two-tier
 * architecture in `docs/DATA-MODEL.md`. Recorded in ADR-0018.
 *
 * These assertions are deliberately coarse. On a 161-item corpus one cluster
 * crossing the top-ten boundary moves the score by a whole point, and adjacent
 * threshold cells swing between 3 and 6. Pinning exact numbers here would pin
 * noise; only the direction and the ceiling are trustworthy.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { clusterDocs } from '../../aggregate/src/cluster.ts';
import {
  applyMerges,
  proposeMerges,
  type ClusterView,
  type Linkage,
} from '../../aggregate/src/consolidate.ts';
import { buildIdf, vectorize, type SparseVector } from '../../aggregate/src/vector.ts';
import { tokenize } from '../../aggregate/src/text.ts';
import { loadCorpus } from './corpus.ts';
import { toDocs } from './adapt.ts';
import { topKAgreement } from './task-metrics.ts';

const corpus = loadCorpus();
const NOW = '2026-09-01T00:00:00Z';
const docs = toDocs(corpus.submissions);

const tokenized = docs.map((d) => tokenize(d.text));
const idf = buildIdf(tokenized);
const vectors = tokenized.map((t) => vectorize(t, idf));

function toViews(labels: readonly string[]): ClusterView[] {
  const byLabel = new Map<string, number[]>();
  labels.forEach((l, i) => {
    const bucket = byLabel.get(l);
    if (bucket === undefined) byLabel.set(l, [i]);
    else bucket.push(i);
  });
  return [...byLabel.entries()].map(([id, idx]) => ({
    id,
    vectors: idx.map((i) => vectors[i] as SparseVector),
  }));
}

function topTen(labels: readonly string[]): number {
  return topKAgreement(corpus, labels, 10, NOW).hits.length;
}

function pipeline(online: number, offline: number, linkage: Linkage = 'average') {
  const labels = clusterDocs(docs, { threshold: online }).labels;
  const proposals = proposeMerges(toViews(labels), { threshold: offline, linkage });
  return { before: labels, after: applyMerges(labels, proposals), merges: proposals.length };
}

describe('consolidation repairs over-splitting', () => {
  test('it rescues the configuration that fragments most', () => {
    // t=0.15 is the best-ARI, worst-list configuration from ADR-0014. It is
    // over-split, which is exactly what the offline tier exists to fix.
    const { before, after, merges } = pipeline(0.15, 0.05);
    assert.ok(merges > 5, `expected substantive repair, got ${merges} merges`);
    assert.ok(
      topTen(after) > topTen(before),
      `expected improvement over ${topTen(before)}/10, got ${topTen(after)}/10`,
    );
  });

  test('it reduces cluster count without collapsing everything', () => {
    const { before, after } = pipeline(0.15, 0.05);
    const b = new Set(before).size;
    const a = new Set(after).size;
    assert.ok(a < b, 'fragments were reunited');
    assert.ok(a > 20, `must not collapse the corpus; got ${a} clusters`);
  });

  test('a conservative offline threshold is a no-op, not a regression', () => {
    // Safety property: turning consolidation down must never make things
    // worse than not running it.
    const { before, after, merges } = pipeline(0.15, 0.5);
    assert.equal(merges, 0);
    assert.deepEqual(after, before);
  });
});

describe('the two-tier architecture pays for itself', () => {
  test('precision-online plus recall-offline beats the best single pass', () => {
    // The claim behind DATA-MODEL's online/offline split: a high online
    // threshold (cheap, stable, order-independent assignments) followed by
    // offline repair should match or beat any single tuned threshold.
    const singlePass = Math.max(
      ...[0.1, 0.13, 0.15, 0.18, 0.2, 0.25].map((t) => topTen(clusterDocs(docs, { threshold: t }).labels)),
    );
    const twoTier = Math.max(
      ...[0.15, 0.16, 0.25, 0.3].flatMap((online) =>
        [0.03, 0.05, 0.07].map((offline) => topTen(pipeline(online, offline).after)),
      ),
    );
    assert.ok(
      twoTier >= singlePass,
      `two-tier ${twoTier}/10 should not lose to single-pass ${singlePass}/10`,
    );
  });

  test('average linkage is safe to run aggressively; single linkage is not', () => {
    // Aggressive average-linkage consolidation must not destroy the clustering.
    // The same threshold under single linkage chains it into rubble — the
    // concrete reason ADR-0005 rejects connected components.
    const labels = clusterDocs(docs, { threshold: 0.15 }).labels;
    const views = toViews(labels);

    const avg = applyMerges(labels, proposeMerges(views, { threshold: 0.03, linkage: 'average' }));
    const single = applyMerges(labels, proposeMerges(views, { threshold: 0.03, linkage: 'single' }));

    assert.ok(new Set(avg).size > 20, `average linkage kept structure: ${new Set(avg).size}`);
    assert.ok(
      new Set(single).size < new Set(avg).size / 2,
      `single linkage chained: ${new Set(single).size} clusters left`,
    );
  });
});

describe('the ceiling, which is why embeddings are still required', () => {
  test('no combination of thresholds reaches a usable ranked list', () => {
    // ADR-0014 concluded embeddings are needed for v0.1. Consolidation raises
    // the lexical ceiling but does not remove that conclusion. If this ever
    // fails high, re-run the embedding cost/benefit.
    let best = 0;
    for (const online of [0.1, 0.13, 0.15, 0.16, 0.18, 0.2, 0.25, 0.3]) {
      for (const offline of [0.03, 0.05, 0.07, 0.1]) {
        best = Math.max(best, topTen(pipeline(online, offline).after));
      }
    }
    assert.ok(best >= 6, `expected consolidation to reach ~6/10, got ${best}`);
    assert.ok(best <= 7, `lexical + consolidation should still miss ~a third; got ${best}/10`);
  });

  test('consolidation cannot invent a paraphrase link that no shared word supports', () => {
    // 'add dark mode' and 'the app destroys my eyes at night' share nothing.
    // No amount of cluster-level evidence creates a similarity that is zero at
    // the item level, which is precisely the gap embeddings fill.
    const { after } = pipeline(0.15, 0.03);
    const byId = new Map(corpus.submissions.map((s, i) => [s.id, after[i]]));
    assert.notEqual(byId.get('s001'), byId.get('s002'));
  });
});
