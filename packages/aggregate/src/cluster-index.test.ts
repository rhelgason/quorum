/**
 * Incremental cluster assignment.
 *
 * The load-bearing test is the equivalence one: given the same documents in
 * the same order and a fixed IDF, this must produce **exactly** what
 * `clusterDocs` produces. Without that, the service and the eval harness are
 * measuring two different clusterers and every number in `packages/eval`
 * stops describing what ships.
 *
 * The rest is about surviving a restart, which is the entire reason the state
 * is serializable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clusterDocs, type Doc } from './cluster.ts';
import { ClusterIndex } from './cluster-index.ts';
import { buildIdf } from './vector.ts';
import { tokenize } from './text.ts';
import { createHashingEmbedder } from './embed-cache.ts';

const CORPUS: Doc[] = [
  { id: 'a1', text: 'the csv export is broken and spins forever', route: '/reports' },
  { id: 'a2', text: 'csv export broken, nothing downloads', route: '/reports' },
  { id: 'b1', text: 'please add a dark mode', route: '/settings' },
  { id: 'b2', text: 'dark mode would be lovely, add dark mode', route: '/settings' },
  { id: 'c1', text: 'we need SAML SSO before rollout', route: '/security' },
  { id: 'a3', text: 'export to csv still broken today', route: '/reports' },
  { id: 'd1', text: 'completely unrelated sentence about penguins' },
];

/** The IDF the batch clusterer would build for the whole corpus. */
function fixedIdf(docs: readonly Doc[]) {
  return buildIdf(docs.map((d) => tokenize(d.text)));
}

describe('equivalence with clusterDocs', () => {
  it('matches the batch clusterer exactly under a fixed IDF', () => {
    const idf = fixedIdf(CORPUS);
    const batch = clusterDocs(CORPUS, { threshold: 0.25, idf });

    const index = new ClusterIndex({ threshold: 0.25, idf });
    const incremental = index.addAll(CORPUS);

    assert.deepEqual(
      incremental.map((a) => a.clusterId),
      batch.labels,
    );
  });

  it('matches across a range of thresholds', () => {
    const idf = fixedIdf(CORPUS);
    for (const threshold of [0.05, 0.15, 0.25, 0.4, 0.6]) {
      const batch = clusterDocs(CORPUS, { threshold, idf });
      const index = new ClusterIndex({ threshold, idf });
      assert.deepEqual(
        index.addAll(CORPUS).map((a) => a.clusterId),
        batch.labels,
        `threshold ${String(threshold)}`,
      );
    }
  });

  it('matches with semantic blending on', async () => {
    const embedder = createHashingEmbedder();
    const vectors = await embedder.embed(CORPUS.map((d) => d.text));
    const docs = CORPUS.map((doc, i) => ({ ...doc, vector: vectors[i] as Float64Array }));
    const idf = fixedIdf(docs);

    const batch = clusterDocs(docs, { threshold: 0.25, semanticWeight: 0.5, idf });
    const index = new ClusterIndex({ threshold: 0.25, semanticWeight: 0.5, idf });

    assert.deepEqual(
      index.addAll(docs).map((a) => a.clusterId),
      batch.labels,
    );
  });

  it('matches with a structural bonus on', () => {
    const idf = fixedIdf(CORPUS);
    const batch = clusterDocs(CORPUS, { threshold: 0.25, structuralBonus: 0.2, idf });
    const index = new ClusterIndex({ threshold: 0.25, structuralBonus: 0.2, idf });

    assert.deepEqual(
      index.addAll(CORPUS).map((a) => a.clusterId),
      batch.labels,
    );
  });
});

describe('incremental IDF', () => {
  it('groups the obvious things without being handed a table', () => {
    const index = new ClusterIndex({ threshold: 0.2 });
    index.addAll(CORPUS);

    // Two documents about a broken CSV export belong together whether or not
    // the corpus statistics were known in advance.
    assert.equal(index.labelFor('a1'), index.labelFor('a2'));
    assert.equal(index.labelFor('b1'), index.labelFor('b2'));
    assert.notEqual(index.labelFor('a1'), index.labelFor('b1'));
  });

  it('does not drop the terms a document introduces', () => {
    // Statistics have to update before vectorizing. Otherwise the first
    // document to use a word has it missing from the IDF table, gets an empty
    // vector, and can never match anything again.
    const index = new ClusterIndex({ threshold: 0.2 });
    index.add({ id: 'first', text: 'quorum aggregates feedback' });
    const second = index.add({ id: 'second', text: 'quorum aggregates feedback' });

    assert.equal(second.clusterId, index.labelFor('first'));
  });

  it('never reassigns an existing member', () => {
    const index = new ClusterIndex({ threshold: 0.2 });
    index.addAll(CORPUS);
    const before = index.assignments();

    for (let i = 0; i < 20; i++) {
      index.add({ id: `extra-${String(i)}`, text: `some other feedback number ${String(i)}` });
    }

    for (const [id, cluster] of before) {
      assert.equal(index.labelFor(id), cluster, `${id} moved after later writes`);
    }
  });
});

describe('idempotency', () => {
  it('re-adding a document changes nothing', () => {
    const index = new ClusterIndex({ threshold: 0.2 });
    index.addAll(CORPUS);

    const clustersBefore = index.clusters();
    const docCountBefore = index.docCount;

    const again = index.add(CORPUS[0] as Doc);

    // A replayed offline flush must not double a cluster's weight.
    assert.equal(again.clusterId, index.labelFor('a1'));
    assert.deepEqual(index.clusters(), clustersBefore);
    assert.equal(index.docCount, docCountBefore);
  });
});

describe('persistence', () => {
  it('survives a round trip through JSON', () => {
    const index = new ClusterIndex({ threshold: 0.25 });
    index.addAll(CORPUS);

    const restored = ClusterIndex.fromJSON(
      JSON.parse(JSON.stringify(index.toJSON())) as ReturnType<ClusterIndex['toJSON']>,
      { threshold: 0.25 },
    );

    assert.deepEqual(restored.assignments(), index.assignments());
    assert.deepEqual(restored.clusters(), index.clusters());
    assert.equal(restored.docCount, index.docCount);
    assert.equal(restored.clusterCount, index.clusterCount);
  });

  it('assigns a new document the same way after a restart', () => {
    const index = new ClusterIndex({ threshold: 0.25 });
    index.addAll(CORPUS);

    const restored = ClusterIndex.fromJSON(
      JSON.parse(JSON.stringify(index.toJSON())) as ReturnType<ClusterIndex['toJSON']>,
      { threshold: 0.25 },
    );

    const fresh: Doc = { id: 'new', text: 'the csv export broke again this morning', route: '/reports' };
    // The whole point of persisting centroids: a restart must not change where
    // the next submission lands.
    assert.equal(index.add(fresh).clusterId, restored.add({ ...fresh }).clusterId);
  });

  it('keeps dense centroids across a restart', async () => {
    const embedder = createHashingEmbedder();
    const vectors = await embedder.embed(CORPUS.map((d) => d.text));
    const docs = CORPUS.map((doc, i) => ({ ...doc, vector: vectors[i] as Float64Array }));

    const index = new ClusterIndex({ threshold: 0.25, semanticWeight: 0.5 });
    index.addAll(docs);

    const restored = ClusterIndex.fromJSON(
      JSON.parse(JSON.stringify(index.toJSON())) as ReturnType<ClusterIndex['toJSON']>,
      { threshold: 0.25, semanticWeight: 0.5 },
    );

    const fresh = { id: 'new', text: 'csv export is broken', vector: (await embedder.embed(['csv export is broken']))[0] as Float64Array };
    assert.equal(index.add(fresh).clusterId, restored.add({ ...fresh }).clusterId);
  });

  it('does not keep issuing ids it already used', () => {
    const index = new ClusterIndex({ threshold: 0.9 });
    index.addAll(CORPUS);

    const restored = ClusterIndex.fromJSON(
      JSON.parse(JSON.stringify(index.toJSON())) as ReturnType<ClusterIndex['toJSON']>,
      { threshold: 0.9 },
    );
    restored.add({ id: 'brand-new', text: 'entirely different subject matter here' });

    // Reusing an id would silently merge an old cluster with a new one, and
    // the ranked list would gain members nobody wrote.
    const ids = [...restored.clusters().keys()];
    assert.equal(new Set(ids).size, ids.length);
  });

  it('refuses a version it does not understand', () => {
    assert.throws(
      () =>
        ClusterIndex.fromJSON(
          { version: 2 as 1, docCount: 0, nextId: 0, df: [], clusters: [] },
          { threshold: 0.25 },
        ),
      /unsupported cluster index version/,
    );
  });

  it('serializes to something JSON can actually hold', () => {
    const index = new ClusterIndex({ threshold: 0.25 });
    index.addAll(CORPUS);

    // Maps and Float64Arrays do not survive JSON.stringify; a silent
    // `{}` here would be discovered only on the next restart.
    const text = JSON.stringify(index.toJSON());
    assert.ok(!text.includes('{}'), 'something serialized to an empty object');
    assert.ok(text.length > 100);
  });
});

describe('empty and degenerate input', () => {
  it('gives a document with no usable tokens its own cluster', () => {
    const index = new ClusterIndex({ threshold: 0.2 });
    index.add({ id: 'x', text: 'the and of' });
    index.add({ id: 'y', text: '!!!' });

    // Both vectorize to nothing. Matching them to each other at similarity 0
    // would be arbitrary.
    assert.notEqual(index.labelFor('x'), index.labelFor('y'));
  });

  it('starts empty', () => {
    const index = new ClusterIndex({ threshold: 0.2 });
    assert.equal(index.clusterCount, 0);
    assert.equal(index.docCount, 0);
    assert.deepEqual([...index.assignments()], []);
  });
});
