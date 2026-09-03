import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  allOneCluster,
  allSingletons,
  exactMatch,
  normalize,
  structural,
  structuralPlusToken,
  topContentWord,
} from './baselines.ts';
import { loadCorpus, truthLabels, type Submission } from './corpus.ts';
import { evaluate } from './metrics.ts';
import { run, runSubset } from './report.ts';

const corpus = loadCorpus();

function sub(overrides: Partial<Submission>): Submission {
  return {
    id: 'x',
    cluster: 'c',
    kind: 'bug',
    source: 'nub',
    body: 'body',
    route: '/a',
    appVersion: '1.0.0',
    platform: 'web',
    userId: 'u',
    clientTs: '2026-08-12T00:00:00Z',
    ...overrides,
  };
}

describe('normalize', () => {
  test('casefolds, strips punctuation, and collapses whitespace', () => {
    assert.equal(normalize('  Add DARK-mode, please!!  '), 'add dark mode please');
  });

  test('makes trivial variants identical', () => {
    assert.equal(normalize('Add dark mode!'), normalize('add   dark mode'));
  });
});

describe('topContentWord', () => {
  test('picks the longest non-stopword token', () => {
    assert.equal(topContentWord('please add the notifications'), 'notifications');
  });

  test('ignores short tokens and stopwords', () => {
    assert.equal(topContentWord('i can do it'), '');
  });
});

describe('degenerate baselines', () => {
  test('allOneCluster produces exactly one label', () => {
    const labels = allOneCluster(corpus.submissions);
    assert.equal(new Set(labels).size, 1);
    assert.equal(labels.length, corpus.submissions.length);
  });

  test('allOneCluster has perfect recall and near-zero precision', () => {
    const m = evaluate(truthLabels(corpus), allOneCluster(corpus.submissions));
    assert.equal(m.pairwise.recall, 1);
    assert.ok(m.pairwise.precision < 0.1);
  });

  test('allSingletons produces one label per item', () => {
    const labels = allSingletons(corpus.submissions);
    assert.equal(new Set(labels).size, corpus.submissions.length);
  });

  test('both degenerate baselines score ~0 ARI', () => {
    // The floor the chance correction exists to establish. Any real method
    // that cannot beat these is not doing anything.
    const one = evaluate(truthLabels(corpus), allOneCluster(corpus.submissions));
    const many = evaluate(truthLabels(corpus), allSingletons(corpus.submissions));
    assert.ok(Math.abs(one.adjustedRandIndex) < 0.01);
    assert.ok(Math.abs(many.adjustedRandIndex) < 0.01);
  });
});

describe('exactMatch', () => {
  test('merges normalized duplicates', () => {
    const labels = exactMatch([
      sub({ id: 'a', body: 'Add dark mode!' }),
      sub({ id: 'b', body: 'add   dark mode' }),
      sub({ id: 'c', body: 'something else' }),
    ]);
    assert.equal(labels[0], labels[1]);
    assert.notEqual(labels[0], labels[2]);
  });

  test('degenerates to singletons on this corpus, which has no verbatim repeats', () => {
    // A known limitation of hand-authored data: real corpora contain a
    // meaningful share of literal duplicates and this one does not, so
    // exact-match dedup looks worthless here and would not be in production.
    const labels = exactMatch(corpus.submissions);
    assert.equal(new Set(labels).size, corpus.submissions.length);
  });
});

describe('structural', () => {
  test('groups identical route, platform, version, and time bucket', () => {
    const labels = structural()([
      sub({ id: 'a', clientTs: '2026-08-13T00:00:00Z' }),
      sub({ id: 'b', clientTs: '2026-08-14T00:00:00Z' }),
    ]);
    assert.equal(labels[0], labels[1]);
  });

  test('splits a burst that straddles a bucket boundary — a known weakness', () => {
    // Epoch-anchored buckets are stable (see the test below) but arbitrary:
    // two submissions a day apart land in different buckets if the boundary
    // falls between them. This is a real cause of the low recall structural
    // clustering shows on release bursts, recorded in ADR-0013. A sliding
    // window or burst-detection pass would fix it; fixed buckets will not.
    const labels = structural()([
      sub({ id: 'a', clientTs: '2026-08-12T23:00:00Z' }),
      sub({ id: 'b', clientTs: '2026-08-13T01:00:00Z' }),
    ]);
    assert.notEqual(labels[0], labels[1], 'documents the boundary artifact, not desired behaviour');
  });

  test('separates different routes', () => {
    const labels = structural()([sub({ route: '/a' }), sub({ route: '/b' })]);
    assert.notEqual(labels[0], labels[1]);
  });

  test('separates different versions unless told otherwise', () => {
    const items = [sub({ appVersion: '4.12.0' }), sub({ appVersion: '4.11.0' })];
    assert.notEqual(structural()(items)[0], structural()(items)[1]);
    const merged = structural({ useVersion: false })(items);
    assert.equal(merged[0], merged[1]);
  });

  test('separates submissions in different time buckets', () => {
    const labels = structural({ bucketDays: 1 })([
      sub({ clientTs: '2026-08-12T00:00:00Z' }),
      sub({ clientTs: '2026-08-20T00:00:00Z' }),
    ]);
    assert.notEqual(labels[0], labels[1]);
  });

  test('buckets are epoch-anchored, so prepending an item does not relabel others', () => {
    // Anchoring to the earliest submission would make every label churn when
    // one older item arrives — the exact instability ADR-0005 warns about.
    const a = sub({ id: 'a', clientTs: '2026-08-20T00:00:00Z' });
    const b = sub({ id: 'b', clientTs: '2026-08-21T00:00:00Z' });
    const older = sub({ id: 'older', clientTs: '2026-01-01T00:00:00Z' });
    const before = structural()([a, b]);
    const after = structural()([older, a, b]);
    assert.deepEqual(before, after.slice(1));
  });

  test('is deterministic', () => {
    assert.deepEqual(structural()(corpus.submissions), structural()(corpus.submissions));
  });
});

describe('structuralPlusToken', () => {
  test('splits a structural group when head words differ', () => {
    const items = [
      sub({ id: 'a', body: 'the scanner keeps crashing' }),
      sub({ id: 'b', body: 'the totals are incorrect' }),
    ];
    assert.equal(structural()(items)[0], structural()(items)[1]);
    const split = structuralPlusToken()(items);
    assert.notEqual(split[0], split[1]);
  });
});

describe('measured baseline behaviour on the corpus', () => {
  // These pin the findings recorded in ADR-0013. If a change moves them, the
  // ADR needs revisiting rather than the assertion needing loosening.

  test('structural clustering is weak overall', () => {
    const r = run(corpus, 'structural', structural());
    assert.ok(
      r.metrics.adjustedRandIndex < 0.2,
      `expected weak overall ARI, got ${r.metrics.adjustedRandIndex}`,
    );
  });

  test('but is a high-precision detector on release-burst bug clusters', () => {
    const burst = new Set(corpus.clusters.filter((c) => c.structural === true).map((c) => c.id));
    const r = runSubset(corpus, 'burst', structural(), (s) => burst.has(s.cluster));
    assert.equal(r.metrics.pairwise.precision, 1, 'when it groups a burst, it should never be wrong');
    assert.ok(r.metrics.adjustedRandIndex > 0.4, `got ARI ${r.metrics.adjustedRandIndex}`);
  });

  test('and is near-useless on feature requests', () => {
    // The finding that matters: feature requests about one topic arrive from
    // all over the product, so route-based grouping shatters them.
    const r = runSubset(corpus, 'features', structural(), (s) => s.kind === 'feature_request');
    assert.ok(
      r.metrics.adjustedRandIndex < 0.1,
      `expected near-zero ARI on feature requests, got ${r.metrics.adjustedRandIndex}`,
    );
  });

  test('bugs score far better than feature requests under structural grouping', () => {
    const bugs = runSubset(corpus, 'bugs', structural(), (s) => s.kind === 'bug');
    const features = runSubset(corpus, 'features', structural(), (s) => s.kind === 'feature_request');
    assert.ok(bugs.metrics.pairwise.f1 > features.metrics.pairwise.f1 * 3);
  });

  test('no baseline solves the corpus, so there is headroom to measure against', () => {
    for (const clusterer of [allOneCluster, allSingletons, exactMatch, structural()]) {
      const m = evaluate(truthLabels(corpus), clusterer(corpus.submissions));
      assert.ok(m.adjustedRandIndex < 0.5, 'a baseline should not be near-solving this');
    }
  });
});
