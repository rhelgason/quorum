import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { clusterDocs, medoid, type Doc } from './cluster.ts';

function doc(id: string, text: string, extra: Partial<Doc> = {}): Doc {
  return { id, text, ...extra };
}

const DARK = [
  doc('d1', 'please add a dark mode'),
  doc('d2', 'dark mode would be great'),
  doc('d3', 'add darkmode to the settings'),
];
const CSV = [
  doc('c1', 'export expenses to csv'),
  doc('c2', 'csv export of all expenses'),
];

describe('clusterDocs', () => {
  test('groups near-identical text', () => {
    const r = clusterDocs(DARK, { threshold: 0.3 });
    assert.equal(r.labels[0], r.labels[1], 'd1 and d2 should merge');
  });

  test('separates unrelated topics', () => {
    const r = clusterDocs([...DARK, ...CSV], { threshold: 0.3 });
    assert.notEqual(r.labels[0], r.labels[3]);
  });

  test('a higher threshold produces more, smaller clusters', () => {
    const docs = [...DARK, ...CSV];
    const loose = clusterDocs(docs, { threshold: 0.05 });
    const tight = clusterDocs(docs, { threshold: 0.95 });
    assert.ok(tight.clusters.size > loose.clusters.size);
  });

  test('documents with identical token sets merge at any threshold', () => {
    // 'export expenses to csv' and 'csv export of all expenses' reduce to the
    // same stems, so cosine is exactly 1. Not a threshold bug — they are the
    // same request, and no cutoff below 1 should separate them.
    const r = clusterDocs(CSV, { threshold: 0.99 });
    assert.equal(r.clusters.size, 1);
  });

  test('threshold 0 with signal merges everything into one', () => {
    const r = clusterDocs(DARK, { threshold: 0 });
    assert.equal(r.clusters.size, 1);
  });

  test('labels, assignments, and clusters agree', () => {
    const docs = [...DARK, ...CSV];
    const r = clusterDocs(docs, { threshold: 0.3 });
    assert.equal(r.labels.length, docs.length);
    assert.equal(r.assignments.length, docs.length);
    let members = 0;
    for (const ids of r.clusters.values()) members += ids.length;
    assert.equal(members, docs.length);
    for (let i = 0; i < docs.length; i++) {
      assert.equal(r.assignments[i]?.docId, docs[i]?.id);
      assert.equal(r.assignments[i]?.clusterId, r.labels[i]);
    }
  });

  test('a doc that seeds a cluster reports similarity 0', () => {
    const r = clusterDocs(DARK, { threshold: 0.3 });
    assert.equal(r.assignments[0]?.similarity, 0);
  });

  test('existing assignments never change as new docs arrive', () => {
    // Stability by construction — the property that stops a top-ten list
    // reshuffling overnight.
    const first = clusterDocs(DARK, { threshold: 0.3 });
    const extended = clusterDocs([...DARK, ...CSV], { threshold: 0.3 });
    assert.deepEqual(
      extended.labels.slice(0, DARK.length),
      first.labels,
      'prefix labels must be unchanged',
    );
  });

  test('is deterministic for a fixed input order', () => {
    const a = clusterDocs([...DARK, ...CSV], { threshold: 0.3 });
    const b = clusterDocs([...DARK, ...CSV], { threshold: 0.3 });
    assert.deepEqual(a.labels, b.labels);
  });

  test('a doc with no usable tokens seeds its own cluster', () => {
    // An empty vector matches everything at 0. Without a guard it would be
    // dumped into whichever cluster happened to be first.
    const docs = [doc('a', 'dark mode please'), doc('empty', 'please can you add this')];
    const r = clusterDocs(docs, { threshold: 0 });
    assert.notEqual(r.labels[0], r.labels[1]);
  });

  test('handles an empty input', () => {
    const r = clusterDocs([], { threshold: 0.3 });
    assert.deepEqual(r.labels, []);
    assert.equal(r.clusters.size, 0);
  });

  test('handles a single doc', () => {
    const r = clusterDocs([doc('a', 'dark mode')], { threshold: 0.3 });
    assert.equal(r.clusters.size, 1);
  });
});

describe('clusterDocs — structural bonus', () => {
  const sameSurface = [
    doc('a', 'the scanner crashes immediately', { route: '/scan', appVersion: '4.12.0', platform: 'ios' }),
    doc('b', 'camera quits on launch', { route: '/scan', appVersion: '4.12.0', platform: 'ios' }),
  ];

  test('is off by default', () => {
    // Measurement showed structural signal helps defects and hurts feature
    // requests, so it must be opt-in per pass.
    const r = clusterDocs(sameSurface, { threshold: 0.5 });
    assert.notEqual(r.labels[0], r.labels[1]);
  });

  test('can merge same-surface reports when enabled', () => {
    const r = clusterDocs(sameSurface, { threshold: 0.5, structuralBonus: 0.6 });
    assert.equal(r.labels[0], r.labels[1]);
  });

  test('does not merge across different surfaces', () => {
    const different = [
      doc('a', 'the scanner crashes', { route: '/scan', appVersion: '4.12.0', platform: 'ios' }),
      doc('b', 'billing page errors', { route: '/billing', appVersion: '4.12.0', platform: 'web' }),
    ];
    const r = clusterDocs(different, { threshold: 0.5, structuralBonus: 0.6 });
    assert.notEqual(r.labels[0], r.labels[1]);
  });
});

describe('medoid', () => {
  test('picks a real member, never a synthesized string', () => {
    const docs = [...DARK];
    const id = medoid(docs.map((d) => d.id), docs, { threshold: 0.3 });
    assert.ok(docs.some((d) => d.id === id), 'medoid must be an actual submission');
  });

  test('picks the most central member', () => {
    const docs = [
      doc('central', 'dark mode setting'),
      doc('near', 'dark mode'),
      doc('far', 'dark mode setting for the whole application interface at night'),
    ];
    const id = medoid(['central', 'near', 'far'], docs, { threshold: 0.3 });
    assert.notEqual(id, 'far');
  });

  test('a single member is its own medoid', () => {
    assert.equal(medoid(['d1'], DARK, { threshold: 0.3 }), 'd1');
  });

  test('returns undefined for no members', () => {
    assert.equal(medoid([], DARK, { threshold: 0.3 }), undefined);
  });

  test('ignores ids that are not in the doc set', () => {
    assert.equal(medoid(['nope'], DARK, { threshold: 0.3 }), undefined);
  });

  test('is deterministic', () => {
    const ids = DARK.map((d) => d.id);
    assert.equal(medoid(ids, DARK, { threshold: 0.3 }), medoid(ids, DARK, { threshold: 0.3 }));
  });
});
