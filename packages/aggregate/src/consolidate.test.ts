import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyMerges, linkageSimilarity, proposeMerges, type ClusterView } from './consolidate.ts';
import { buildIdf, vectorize, type SparseVector } from './vector.ts';
import { tokenize } from './text.ts';

/** Build vectors over a shared vocabulary so cosines are comparable. */
function vectorsFor(groups: readonly (readonly string[])[]): SparseVector[][] {
  const all = groups.flat().map((t) => tokenize(t));
  const idf = buildIdf(all);
  let i = 0;
  return groups.map((g) => g.map(() => vectorize(all[i++] as string[], idf)));
}

function view(id: string, vectors: SparseVector[], locked = false): ClusterView {
  return locked ? { id, vectors, locked: true } : { id, vectors };
}

describe('linkageSimilarity', () => {
  const [a, b] = vectorsFor([
    ['dark mode setting', 'dark mode please'],
    ['dark mode toggle', 'csv export broken'],
  ]);

  test('single linkage takes the best pair, average sits below it', () => {
    const single = linkageSimilarity(a!, b!, 'single');
    const average = linkageSimilarity(a!, b!, 'average');
    const complete = linkageSimilarity(a!, b!, 'complete');
    assert.ok(single >= average, 'single >= average');
    assert.ok(average >= complete, 'average >= complete');
  });

  test('is symmetric', () => {
    assert.equal(linkageSimilarity(a!, b!, 'average'), linkageSimilarity(b!, a!, 'average'));
  });

  test('empty groups score 0 rather than NaN', () => {
    assert.equal(linkageSimilarity([], a!, 'average'), 0);
    assert.equal(linkageSimilarity(a!, [], 'single'), 0);
  });
});

describe('single linkage chains; average linkage does not', () => {
  // The claim ADR-0005 makes about connected components, demonstrated.
  // A and C share nothing. B is a vague item that resembles both. Single
  // linkage bridges A to C through B; average linkage refuses.
  const [aVec, bVec, cVec] = vectorsFor([
    ['dark mode night theme'],
    ['dark screen export problem'],
    ['csv export spreadsheet download'],
  ]);
  const clusters = [view('A', aVec!), view('B', bVec!), view('C', cVec!)];

  test('single linkage merges all three through the bridge', () => {
    const proposals = proposeMerges(clusters, { threshold: 0.15, linkage: 'single' });
    const merged = applyMerges(['A', 'B', 'C'], proposals);
    assert.equal(new Set(merged).size, 1, 'A, B and C all collapsed together');
  });

  test('average linkage at the same threshold keeps A and C apart', () => {
    const proposals = proposeMerges(clusters, { threshold: 0.15, linkage: 'average' });
    const merged = applyMerges(['A', 'B', 'C'], proposals);
    assert.ok(new Set(merged).size > 1, 'the bridge did not carry');
    const byId = new Map(['A', 'B', 'C'].map((id, i) => [id, merged[i]]));
    assert.notEqual(byId.get('A'), byId.get('C'), 'unrelated issues stayed separate');
  });
});

describe('proposeMerges', () => {
  const [f1, f2, other] = vectorsFor([
    ['dark mode please', 'add dark mode'],
    ['dark mode setting', 'dark mode toggle'],
    ['csv export missing rows', 'export csv broken'],
  ]);

  test('reunites two fragments of the same issue', () => {
    const proposals = proposeMerges([view('a', f1!), view('b', f2!)], { threshold: 0.1 });
    assert.equal(proposals.length, 1);
    assert.deepEqual(proposals[0]?.clusterIds, ['a', 'b']);
  });

  test('leaves genuinely different issues alone', () => {
    const proposals = proposeMerges([view('a', f1!), view('c', other!)], { threshold: 0.3 });
    assert.deepEqual(proposals, []);
  });

  test('reports sizes and similarity as reviewer evidence', () => {
    const [p] = proposeMerges([view('a', f1!), view('b', f2!)], { threshold: 0.1 });
    assert.deepEqual(p?.sizes, [2, 2]);
    assert.ok((p?.similarity as number) > 0.1);
  });

  test('never touches a locked cluster', () => {
    // The offline tier may not undo human curation.
    const proposals = proposeMerges([view('a', f1!), view('b', f2!, true)], { threshold: 0.1 });
    assert.deepEqual(proposals, []);
  });

  test('honours previously rejected proposals', () => {
    // Re-proposing a declined merge every night trains people to ignore the
    // queue, which is worse than having no queue.
    const first = proposeMerges([view('a', f1!), view('b', f2!)], { threshold: 0.1 });
    const key = first[0]?.key as string;
    const second = proposeMerges([view('a', f1!), view('b', f2!)], {
      threshold: 0.1,
      rejected: new Set([key]),
    });
    assert.deepEqual(second, []);
  });

  test('the rejection key is order-independent', () => {
    const ab = proposeMerges([view('a', f1!), view('b', f2!)], { threshold: 0.1 })[0]?.key;
    const ba = proposeMerges([view('b', f2!), view('a', f1!)], { threshold: 0.1 })[0]?.key;
    assert.equal(ab, ba);
  });

  test('maxSizeRatio blocks a big cluster from swallowing a singleton', () => {
    const [big, one] = vectorsFor([
      ['dark mode', 'dark mode please', 'dark mode setting', 'dark theme', 'dark ui'],
      ['dark mode toggle'],
    ]);
    const clusters = [view('big', big!), view('one', one!)];
    assert.equal(proposeMerges(clusters, { threshold: 0.1 }).length, 1, 'merges by default');
    assert.equal(
      proposeMerges(clusters, { threshold: 0.1, maxSizeRatio: 3 }).length,
      0,
      '5:1 exceeds the ratio',
    );
  });

  test('maxProposals caps the review queue', () => {
    const groups = vectorsFor([
      ['dark mode a', 'dark mode b'],
      ['dark mode c', 'dark mode d'],
      ['dark mode e', 'dark mode f'],
      ['dark mode g', 'dark mode h'],
    ]);
    const clusters = groups.map((v, i) => view(`c${i}`, v));
    assert.equal(proposeMerges(clusters, { threshold: 0.05, maxProposals: 2 }).length, 2);
  });

  test('is ordered strongest-evidence-first', () => {
    const groups = vectorsFor([
      ['dark mode please', 'add dark mode'],
      ['dark mode setting', 'dark mode toggle'],
      ['csv export broken rows', 'csv export missing'],
      ['csv export dropped line', 'csv download incomplete'],
    ]);
    const clusters = groups.map((v, i) => view(`c${i}`, v));
    const proposals = proposeMerges(clusters, { threshold: 0.05 });
    for (let i = 1; i < proposals.length; i++) {
      assert.ok((proposals[i - 1]?.similarity as number) >= (proposals[i]?.similarity as number));
    }
  });

  test('is deterministic', () => {
    const clusters = [view('a', f1!), view('b', f2!)];
    assert.deepEqual(
      proposeMerges(clusters, { threshold: 0.1 }),
      proposeMerges(clusters, { threshold: 0.1 }),
    );
  });

  test('handles empty and single-cluster inputs', () => {
    assert.deepEqual(proposeMerges([], { threshold: 0.1 }), []);
    assert.deepEqual(proposeMerges([view('a', f1!)], { threshold: 0.1 }), []);
  });

  test('skips clusters with no members', () => {
    assert.deepEqual(proposeMerges([view('a', f1!), view('empty', [])], { threshold: 0 }), []);
  });
});

describe('applyMerges', () => {
  test('rewrites labels to the surviving cluster id', () => {
    const merged = applyMerges(['a', 'b', 'c'], [
      { clusterIds: ['a', 'b'], similarity: 0.5, sizes: [1, 1], key: 'a+b' },
    ]);
    assert.equal(merged[0], merged[1]);
    assert.notEqual(merged[0], merged[2]);
  });

  test('picks the lowest id, so output does not depend on proposal order', () => {
    const forward = applyMerges(['z', 'a'], [
      { clusterIds: ['a', 'z'], similarity: 0.5, sizes: [1, 1], key: 'a+z' },
    ]);
    assert.deepEqual(forward, ['a', 'a']);
  });

  test('composes overlapping proposals instead of letting the last one win', () => {
    // a+b and b+c accepted separately must yield one cluster, not two.
    const merged = applyMerges(['a', 'b', 'c'], [
      { clusterIds: ['a', 'b'], similarity: 0.5, sizes: [1, 1], key: 'a+b' },
      { clusterIds: ['b', 'c'], similarity: 0.4, sizes: [1, 1], key: 'b+c' },
    ]);
    assert.equal(new Set(merged).size, 1);
  });

  test('accepting nothing changes nothing', () => {
    assert.deepEqual(applyMerges(['a', 'b'], []), ['a', 'b']);
  });

  test('ignores ids absent from the label array', () => {
    assert.deepEqual(
      applyMerges(['a'], [{ clusterIds: ['x', 'y'], similarity: 1, sizes: [1, 1], key: 'x+y' }]),
      ['a'],
    );
  });
});
