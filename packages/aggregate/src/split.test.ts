import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyOutliers,
  applySplits,
  diameterPair,
  proposeOutliers,
  proposeSplits,
  type SplitMember,
  type SplittableCluster,
} from './split.ts';
import { buildIdf, l2Normalize, vectorize, type SparseVector } from './vector.ts';
import { tokenize } from './text.ts';

/** A normalized vector from explicit term weights — `cosine` is a bare dot product. */
function vec(terms: Record<string, number>): SparseVector {
  return l2Normalize(new Map(Object.entries(terms)));
}

function member(id: string, terms: Record<string, number>): SplitMember {
  return { id, vector: vec(terms) };
}

/** Two disjoint topics sharing no terms — the clearest possible boundary. */
function twoTopics(): SplittableCluster {
  return {
    id: 'c0',
    members: [
      member('a1', { dark: 1, mode: 1 }),
      member('a2', { dark: 1, mode: 1, night: 0.5 }),
      member('b1', { csv: 1, export: 1 }),
      member('b2', { csv: 1, export: 1, broken: 0.5 }),
    ],
  };
}

/** Real text, through the same tokenizer the clusterer uses. */
function fromText(id: string, entries: [string, string][]): SplittableCluster {
  const tokenized = entries.map(([, text]) => tokenize(text));
  const idf = buildIdf(tokenized);
  return {
    id,
    members: entries.map(([memberId], i) => ({
      id: memberId,
      vector: vectorize(tokenized[i] as string[], idf),
    })),
  };
}

describe('diameter seeding', () => {
  test('finds the two least similar members', () => {
    const pair = diameterPair(twoTopics().members);
    assert.deepEqual([pair?.[0].id, pair?.[1].id].sort(), ['a1', 'b1']);
  });

  test('undefined for fewer than two members', () => {
    assert.equal(diameterPair([]), undefined);
    assert.equal(diameterPair([member('a', { x: 1 })]), undefined);
  });

  test('seeding is deterministic, so a reviewer sees the same proposal twice', () => {
    // Random seeding would show a declining reviewer a slightly different
    // version of the same split tomorrow.
    const first = diameterPair(twoTopics().members);
    const second = diameterPair(twoTopics().members);
    assert.equal(first?.[0].id, second?.[0].id);
    assert.equal(first?.[1].id, second?.[1].id);
  });
});

describe('proposing', () => {
  test('a cluster of two disjoint topics is proposed for splitting', () => {
    const proposals = proposeSplits([twoTopics()], { threshold: 0.2 });
    assert.equal(proposals.length, 1);
    assert.deepEqual(proposals[0]?.groups, [['a1', 'a2'], ['b1', 'b2']]);
  });

  test('the proposal carries the evidence a reviewer needs', () => {
    const proposal = proposeSplits([twoTopics()], { threshold: 0.2 })[0];
    assert.equal(proposal?.crossLinkage, 0);
    assert.ok((proposal?.withinLinkage[0] ?? 0) > 0.5);
    assert.ok((proposal?.withinLinkage[1] ?? 0) > 0.5);
  });

  test('a cohesive cluster is left alone', () => {
    const cohesive: SplittableCluster = {
      id: 'c1',
      members: [
        member('a', { dark: 1, mode: 1 }),
        member('b', { dark: 1, mode: 1 }),
        member('c', { dark: 1, mode: 1, please: 0.2 }),
        member('d', { dark: 1, mode: 1, night: 0.2 }),
      ],
    };
    assert.deepEqual(proposeSplits([cohesive], { threshold: 0.2 }), []);
  });

  test('a locked cluster is never proposed', () => {
    // A human who curated a cluster does not get it taken apart overnight.
    const locked = { ...twoTopics(), locked: true };
    assert.deepEqual(proposeSplits([locked], { threshold: 0.2 }), []);
  });

  test('a cluster too small to split both ways is skipped', () => {
    const small: SplittableCluster = {
      id: 'c2',
      members: [member('a', { dark: 1 }), member('b', { csv: 1 }), member('c', { csv: 1 })],
    };
    assert.deepEqual(proposeSplits([small], { threshold: 0.5, minGroupSize: 2 }), []);
  });

  test('minGroupSize refuses to shave off a singleton', () => {
    const lopsided: SplittableCluster = {
      id: 'c3',
      members: [
        member('a', { dark: 1, mode: 1 }),
        member('b', { dark: 1, mode: 1 }),
        member('c', { dark: 1, mode: 1 }),
        member('odd', { csv: 1 }),
      ],
    };
    assert.deepEqual(proposeSplits([lopsided], { threshold: 0.5, minGroupSize: 2 }), []);
    assert.equal(proposeSplits([lopsided], { threshold: 0.5, minGroupSize: 1 }).length, 1);
  });

  test('uniform noise is not split into two arbitrary halves', () => {
    // Everything near zero to everything else. There is no boundary here, and
    // inventing one wastes a reviewer's attention — this is what
    // minCohesionGain exists for.
    const noise: SplittableCluster = {
      id: 'c4',
      members: [
        member('a', { alpha: 1 }),
        member('b', { beta: 1 }),
        member('c', { gamma: 1 }),
        member('d', { delta: 1 }),
      ],
    };
    assert.deepEqual(proposeSplits([noise], { threshold: 0.5 }), []);
  });

  test('a lower threshold proposes less', () => {
    // Bias toward leaving things alone: splitting a real cluster fragments its
    // demand and drops every piece off the ranked list.
    assert.equal(proposeSplits([twoTopics()], { threshold: 0.2 }).length, 1);
    assert.equal(proposeSplits([twoTopics()], { threshold: -1 }).length, 0);
  });

  test('a rejected proposal is not made again', () => {
    const first = proposeSplits([twoTopics()], { threshold: 0.2 })[0]?.key;
    assert.ok(first !== undefined);
    const again = proposeSplits([twoTopics()], {
      threshold: 0.2,
      rejected: new Set([first ?? '']),
    });
    assert.deepEqual(again, []);
  });

  test('the key does not depend on member order', () => {
    // A rejection has to survive a re-run where the store returns members in a
    // different order, or the reviewer is asked the same question forever.
    const forward = twoTopics();
    const reversed: SplittableCluster = { id: 'c0', members: [...forward.members].reverse() };
    assert.equal(
      proposeSplits([forward], { threshold: 0.2 })[0]?.key,
      proposeSplits([reversed], { threshold: 0.2 })[0]?.key,
    );
  });

  test('maxProposals caps the review queue', () => {
    const clusters = [twoTopics(), { ...twoTopics(), id: 'c1' }, { ...twoTopics(), id: 'c2' }];
    assert.equal(proposeSplits(clusters, { threshold: 0.2, maxProposals: 2 }).length, 2);
  });

  test('the most clearly separable cluster is proposed first', () => {
    const clean = twoTopics();
    const murky: SplittableCluster = {
      id: 'c9',
      members: [
        member('x1', { dark: 1, mode: 1, app: 0.6 }),
        member('x2', { dark: 1, mode: 1, app: 0.6 }),
        member('y1', { csv: 1, export: 1, app: 0.6 }),
        member('y2', { csv: 1, export: 1, app: 0.6 }),
      ],
    };
    const proposals = proposeSplits([murky, clean], { threshold: 0.5 });
    assert.equal(proposals[0]?.clusterId, 'c0');
  });

  test('an empty cluster list yields nothing', () => {
    assert.deepEqual(proposeSplits([], { threshold: 0.5 }), []);
  });

  test('one topic plus unrelated stragglers is correctly NOT split', () => {
    // The demo's actual over-merge. The two absorbed items are unrelated to
    // each other, so they are not a second topic — grouping them would be a
    // third wrong answer. Extraction handles this; splitting must decline.
    const cluster = demoOverMerge();
    assert.deepEqual(proposeSplits([cluster], { threshold: 0.2, minGroupSize: 2 }), []);
  });
});

/** The over-merge the demo corpus produces, verbatim. */
function demoOverMerge(): SplittableCluster {
  return fromText('c0', [
    ['m1', 'Mobile app crashes every time I upload a photo'],
    ['m2', 'App crashes on photo upload from my phone, every single time'],
    ['m3', 'Upload crashes the mobile app instantly, cannot attach anything'],
    ['p1', 'Bulk edit would save us a huge amount of time'],
    ['p2', 'Would be great to have an audit log for compliance'],
  ]);
}

describe('outlier extraction', () => {
  // Measured mean similarity to the rest of that cluster:
  //   p2 0.000 · p1 0.051 · m3 0.160 · m2 0.224 · m1 0.289
  // 0.10 sits in the gap between the absorbed stragglers and the real core.
  const STRAGGLER_CUTOFF = 0.1;

  test('it finds the stragglers the demo corpus absorbed', () => {
    const proposals = proposeOutliers([demoOverMerge()], { maxMeanSimilarity: STRAGGLER_CUTOFF });
    assert.deepEqual(proposals.map((p) => p.memberId).sort(), ['p1', 'p2']);
  });

  test('the core of the cluster is left alone', () => {
    const proposals = proposeOutliers([demoOverMerge()], { maxMeanSimilarity: STRAGGLER_CUTOFF });
    for (const id of ['m1', 'm2', 'm3']) {
      assert.equal(proposals.some((p) => p.memberId === id), false, `${id} was extracted`);
    }
  });

  test('each extracted member becomes its own cluster', () => {
    // They are unrelated to each other, so one shared "outliers" cluster would
    // be a new over-merge.
    const cluster = demoOverMerge();
    const docIds = cluster.members.map((m) => m.id);
    const labels = docIds.map(() => 'c0');
    const proposals = proposeOutliers([cluster], { maxMeanSimilarity: STRAGGLER_CUTOFF });
    const applied = applyOutliers(docIds, labels, proposals);
    assert.deepEqual(applied, ['c0', 'c0', 'c0', 'c0~p1', 'c0~p2']);
  });

  test('a cohesive cluster loses nobody', () => {
    const cohesive: SplittableCluster = {
      id: 'c1',
      members: [
        member('a', { dark: 1, mode: 1 }),
        member('b', { dark: 1, mode: 1 }),
        member('c', { dark: 1, mode: 1 }),
      ],
    };
    assert.deepEqual(proposeOutliers([cohesive], { maxMeanSimilarity: 0.2 }), []);
  });

  test('a cluster is never dismantled below the floor', () => {
    // Greedy extraction without this check is fragmentation by another name.
    const noise: SplittableCluster = {
      id: 'c2',
      members: [
        member('a', { alpha: 1 }),
        member('b', { beta: 1 }),
        member('c', { gamma: 1 }),
      ],
    };
    const proposals = proposeOutliers([noise], { maxMeanSimilarity: 0.5, minClusterSize: 2 });
    assert.equal(proposals.length, 1);
  });

  test('a locked cluster is never touched', () => {
    const locked = { ...demoOverMerge(), locked: true };
    assert.deepEqual(proposeOutliers([locked], { maxMeanSimilarity: 0.05 }), []);
  });

  test('a small cluster is left alone', () => {
    const pair: SplittableCluster = {
      id: 'c3',
      members: [member('a', { alpha: 1 }), member('b', { beta: 1 })],
    };
    assert.deepEqual(proposeOutliers([pair], { maxMeanSimilarity: 0.5 }), []);
  });

  test('a rejected extraction is not proposed again', () => {
    const first = proposeOutliers([demoOverMerge()], { maxMeanSimilarity: STRAGGLER_CUTOFF })[0]?.key;
    assert.ok(first !== undefined);
    const again = proposeOutliers([demoOverMerge()], {
      maxMeanSimilarity: STRAGGLER_CUTOFF,
      rejected: new Set([first ?? '']),
    });
    assert.equal(again.some((p) => p.key === first), false);
  });

  test('maxProposals caps the queue', () => {
    const proposals = proposeOutliers([demoOverMerge()], { maxMeanSimilarity: STRAGGLER_CUTOFF, maxProposals: 1 });
    assert.equal(proposals.length, 1);
  });

  test('the weakest member is proposed first', () => {
    const proposals = proposeOutliers([demoOverMerge()], { maxMeanSimilarity: STRAGGLER_CUTOFF });
    const means = proposals.map((p) => p.meanSimilarity);
    assert.deepEqual(means, [...means].sort((a, b) => a - b));
  });

  test('a doc that has since moved is not reassigned', () => {
    const cluster = demoOverMerge();
    const docIds = cluster.members.map((m) => m.id);
    const proposals = proposeOutliers([cluster], { maxMeanSimilarity: STRAGGLER_CUTOFF });
    const labels = ['c0', 'c0', 'c0', 'c9', 'c0'];
    assert.deepEqual(applyOutliers(docIds, labels, proposals), ['c0', 'c0', 'c0', 'c9', 'c0~p2']);
  });

  test('applying nothing changes nothing', () => {
    assert.deepEqual(applyOutliers(['a'], ['c0'], []), ['c0']);
  });
});

describe('applying', () => {
  const docIds = ['a1', 'a2', 'b1', 'b2'];
  const labels = ['c0', 'c0', 'c0', 'c0'];

  test('the first group keeps the cluster id and the second is suffixed', () => {
    // A cluster that has been ranked, linked to a Jira ticket, and subscribed
    // to should not lose its identity because a third of it moved out.
    const proposals = proposeSplits([twoTopics()], { threshold: 0.2 });
    assert.deepEqual(applySplits(docIds, labels, proposals), ['c0', 'c0', 'c0b', 'c0b']);
  });

  test('applying nothing changes nothing', () => {
    assert.deepEqual(applySplits(docIds, labels, []), labels);
  });

  test('a doc that has since moved elsewhere is not dragged back', () => {
    // Stale proposals are real: the proposal was computed against a snapshot.
    const proposals = proposeSplits([twoTopics()], { threshold: 0.2 });
    const moved = ['c0', 'c0', 'c7', 'c0'];
    assert.deepEqual(applySplits(docIds, moved, proposals), ['c0', 'c0', 'c7', 'c0b']);
  });

  test('repeated splits of one cluster get distinct suffixes', () => {
    const proposals = [
      { clusterId: 'c0', groups: [['a1'], ['a2']] as [string[], string[]], crossLinkage: 0, withinLinkage: [1, 1] as [number, number], key: 'k1' },
      { clusterId: 'c0', groups: [['b1'], ['b2']] as [string[], string[]], crossLinkage: 0, withinLinkage: [1, 1] as [number, number], key: 'k2' },
    ];
    assert.deepEqual(applySplits(docIds, labels, proposals), ['c0', 'c0b', 'c0', 'c0c']);
  });

  test('labels longer than docIds are left alone rather than throwing', () => {
    assert.deepEqual(applySplits(['a1'], ['c0', 'c0'], []), ['c0', 'c0']);
  });
});
