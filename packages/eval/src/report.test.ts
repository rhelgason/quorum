import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadCorpus, truthLabels } from './corpus.ts';
import { allOneCluster, allSingletons, structural } from './baselines.ts';
import { scoreHardPairs } from './hard-pairs.ts';
import {
  formatDiagnosis,
  formatSubsetTable,
  formatTable,
  formatTraps,
  run,
  runSubset,
} from './report.ts';

const corpus = loadCorpus();

describe('run', () => {
  test('returns metrics and hard-pair results together', () => {
    const r = run(corpus, 'structural', structural());
    assert.equal(r.name, 'structural');
    assert.equal(r.metrics.items, corpus.submissions.length);
    assert.equal(r.hardPairs.total, corpus.hardPairs.length);
  });

  test('ground truth scores perfectly on every measure', () => {
    const r = run(corpus, 'truth', (subs) => subs.map((s) => s.cluster));
    assert.equal(r.metrics.adjustedRandIndex, 1);
    assert.equal(r.metrics.pairwise.f1, 1);
    assert.equal(r.hardPairs.correct, r.hardPairs.total);
  });
});

describe('runSubset', () => {
  test('scores only the filtered slice', () => {
    const bugs = corpus.submissions.filter((s) => s.kind === 'bug').length;
    const r = runSubset(corpus, 'bugs', structural(), (s) => s.kind === 'bug');
    assert.equal(r.metrics.items, bugs);
    assert.ok(bugs < corpus.submissions.length);
  });

  test('an empty slice does not throw', () => {
    const r = runSubset(corpus, 'none', structural(), () => false);
    assert.equal(r.metrics.items, 0);
  });

  test('scores the slice against slice-local truth, not global truth', () => {
    // Filtering changes which clusters exist. Scoring a subset against the
    // full label array would silently misalign and produce nonsense.
    const r = runSubset(corpus, 'one cluster', structural(), (s) => s.cluster === 'dark-mode');
    assert.equal(r.metrics.trueClusters, 1);
  });
});

describe('formatting', () => {
  const results = [
    run(corpus, 'all-one-cluster', allOneCluster),
    run(corpus, 'structural (7d)', structural()),
  ];

  test('formatTable emits a header, a rule, and one row per result', () => {
    const lines = formatTable(results).split('\n');
    assert.equal(lines.length, results.length + 2);
    assert.match(lines[0] as string, /method/);
    assert.match(lines[0] as string, /ARI/);
    assert.match(lines[2] as string, /all-one-cluster/);
    assert.match(lines[3] as string, /structural/);
  });

  test('formatTable rows carry three-decimal metrics', () => {
    assert.match(formatTable(results), /\d\.\d{3}/);
  });

  test('formatTable handles an empty result list', () => {
    assert.equal(formatTable([]).split('\n').length, 2);
  });

  test('formatSubsetTable emits one row per slice with item counts', () => {
    const out = formatSubsetTable([
      runSubset(corpus, 'bugs', structural(), (s) => s.kind === 'bug'),
    ]);
    const lines = out.split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[2] as string, /bugs/);
  });

  test('formatDiagnosis names both over-merges and splits', () => {
    const out = formatDiagnosis(corpus, structural());
    assert.match(out, /worst over-merges/);
    assert.match(out, /worst splits/);
    assert.match(out, /fragments/);
  });

  test('formatDiagnosis respects the limit', () => {
    const one = formatDiagnosis(corpus, structural(), 1).split('\n');
    const four = formatDiagnosis(corpus, structural(), 4).split('\n');
    assert.ok(four.length > one.length);
  });

  test('formatDiagnosis reports nothing to fix for a perfect clustering', () => {
    const out = formatDiagnosis(corpus, (subs) => subs.map((s) => s.cluster));
    assert.equal(out.split('\n').length, 2, 'two headers, no findings');
  });

  test('formatTraps lists every trap with its score', () => {
    const out = formatTraps(results[1]!);
    const traps = new Set(corpus.hardPairs.map((p) => p.trap));
    assert.equal(out.split('\n').length, traps.size);
    assert.match(out, /\d+\/\d+/);
  });
});

describe('scoreHardPairs error handling', () => {
  test('rejects predictions that do not align with the corpus', () => {
    assert.throws(() => scoreHardPairs(corpus, ['only-one']), /align/);
  });

  test('rejects a pair referencing an unknown submission', () => {
    const broken = structuredClone(corpus);
    (broken.hardPairs[0] as { a: string }).a = 'sZZZ';
    assert.throws(() => scoreHardPairs(broken, truthLabels(broken)), /unknown submission/);
  });

  test('an empty pair set scores as vacuously perfect', () => {
    const empty = { ...corpus, hardPairs: [] };
    const r = scoreHardPairs(empty, truthLabels(corpus));
    assert.equal(r.accuracy, 1);
    assert.equal(r.total, 0);
  });

  test('separates wrong merges from wrong splits', () => {
    // all-one-cluster merges everything, so every should-not-merge pair is a
    // false merge and no pair can be a false split.
    const r = scoreHardPairs(corpus, allOneCluster(corpus.submissions));
    assert.ok(r.falseMerges.length > 0);
    assert.equal(r.falseSplits.length, 0);

    const s = scoreHardPairs(corpus, allSingletons(corpus.submissions));
    assert.equal(s.falseMerges.length, 0);
    assert.ok(s.falseSplits.length > 0);
  });

  test('byTrap is ordered worst-first and covers every trap', () => {
    const r = scoreHardPairs(corpus, structural()(corpus.submissions));
    const traps = new Set(corpus.hardPairs.map((p) => p.trap));
    assert.equal(r.byTrap.length, traps.size);
    for (let i = 1; i < r.byTrap.length; i++) {
      const prev = r.byTrap[i - 1]!;
      const cur = r.byTrap[i]!;
      assert.ok(prev.correct / prev.total <= cur.correct / cur.total);
    }
  });

  test('a high hard-pair score does not imply a good clusterer', () => {
    // all-singletons gets most traps right purely because most traps are
    // "these should not merge". This is why the column is never read alone.
    const r = scoreHardPairs(corpus, allSingletons(corpus.submissions));
    assert.ok(r.accuracy > 0.5, 'scores well on pairs');
    const metrics = run(corpus, 'singletons', allSingletons).metrics;
    assert.equal(metrics.pairwise.f1, 0, 'while being useless');
  });
});
