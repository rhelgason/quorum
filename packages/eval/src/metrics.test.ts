import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  adjustedRandIndex,
  diagnose,
  evaluate,
  pairwise,
  vMeasure,
} from './metrics.ts';

/** Metrics are floating point; pin to 6 decimals. */
function close(actual: number, expected: number, message?: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    message ?? `expected ${actual} to be within 1e-6 of ${expected}`,
  );
}

describe('adjustedRandIndex', () => {
  test('scores an identical clustering as 1', () => {
    close(adjustedRandIndex([0, 0, 1, 1], [0, 0, 1, 1]), 1);
  });

  test('is invariant to label renaming', () => {
    // Cluster ids are arbitrary; only the partition matters.
    close(adjustedRandIndex([0, 0, 1, 1], ['b', 'b', 'a', 'a']), 1);
  });

  test('matches scikit-learn on its documented example', () => {
    // adjusted_rand_score([0, 0, 1, 1], [0, 0, 1, 2]) == 0.5714285714285715
    close(adjustedRandIndex([0, 0, 1, 1], [0, 0, 1, 2]), 0.5714285714285715);
  });

  test('goes negative for a worse-than-chance labeling', () => {
    // Perfectly anti-correlated: every true pair separated, every pred pair
    // wrong. This is the property that makes ARI worth having over Rand.
    close(adjustedRandIndex([0, 0, 1, 1], [0, 1, 0, 1]), -0.5);
  });

  test('penalizes over-splitting', () => {
    close(adjustedRandIndex([0, 0, 0, 1, 1, 1], [0, 0, 1, 1, 2, 2]), 0.24242424242424243);
  });

  test('scores all-singletons near zero, not near one', () => {
    // The failure mode chance correction exists to catch: shattering everything
    // gets perfect precision under naive measures.
    const ari = adjustedRandIndex([0, 0, 1, 1], [0, 1, 2, 3]);
    close(ari, 0);
  });

  test('handles degenerate labelings', () => {
    close(adjustedRandIndex([], []), 1);
    close(adjustedRandIndex([0], [0]), 1);
    close(adjustedRandIndex([0, 0], [0, 0]), 1);
  });

  test('rejects misaligned inputs rather than scoring garbage', () => {
    assert.throws(() => adjustedRandIndex([0, 0], [0]), /same length/);
  });
});

describe('pairwise', () => {
  test('is perfect on an identical clustering', () => {
    const r = pairwise([0, 0, 1, 1], [0, 0, 1, 1]);
    close(r.precision, 1);
    close(r.recall, 1);
    close(r.f1, 1);
    assert.equal(r.falsePositives, 0);
    assert.equal(r.falseNegatives, 0);
  });

  test('separates over-merging from splitting', () => {
    // truth: {0,1,2} {3}   pred: {0,1} {2,3}
    // pred pair (2,3) is a wrong merge; truth pairs (0,2),(1,2) are wrong splits.
    const r = pairwise([0, 0, 0, 1], [0, 0, 1, 1]);
    assert.equal(r.truePositives, 1);
    assert.equal(r.falsePositives, 1, 'one over-merge');
    assert.equal(r.falseNegatives, 2, 'two splits');
    close(r.precision, 0.5);
    close(r.recall, 1 / 3);
    close(r.f1, 0.4);
  });

  test('all-singletons has vacuous precision and zero recall', () => {
    const r = pairwise([0, 0, 1, 1], [0, 1, 2, 3]);
    assert.equal(r.truePositives, 0);
    assert.equal(r.falsePositives, 0);
    assert.equal(r.falseNegatives, 2);
    close(r.precision, 1, 'no predicted pairs to be wrong about');
    close(r.recall, 0);
    close(r.f1, 0);
  });

  test('one-big-cluster has full recall and poor precision', () => {
    const r = pairwise([0, 0, 1, 1], [0, 0, 0, 0]);
    close(r.recall, 1);
    close(r.precision, 2 / 6);
    assert.equal(r.falsePositives, 4);
  });

  test('handles a single item without dividing by zero', () => {
    const r = pairwise([0], [0]);
    close(r.precision, 1);
    close(r.recall, 1);
    close(r.f1, 1);
  });
});

describe('vMeasure', () => {
  test('is perfect on an identical clustering', () => {
    const r = vMeasure([0, 0, 1, 1], [0, 0, 1, 1]);
    close(r.homogeneity, 1);
    close(r.completeness, 1);
    close(r.vMeasure, 1);
  });

  test('splitting keeps homogeneity high and drops completeness', () => {
    // Each predicted cluster is pure, but one topic is spread across two.
    // v_measure_score([0, 0, 1, 1], [0, 1, 2, 3]) == 0.6666...
    const r = vMeasure([0, 0, 1, 1], [0, 1, 2, 3]);
    close(r.homogeneity, 1);
    close(r.completeness, 0.5);
    close(r.vMeasure, 2 / 3);
  });

  test('over-merging keeps completeness high and drops homogeneity', () => {
    // The mirror image — this asymmetry is the reason both are reported.
    const r = vMeasure([0, 1, 2, 3], [0, 0, 1, 1]);
    close(r.completeness, 1);
    close(r.homogeneity, 0.5);
    close(r.vMeasure, 2 / 3);
  });

  test('single true cluster is homogeneous by convention', () => {
    const r = vMeasure([0, 0, 0], [0, 1, 2]);
    close(r.homogeneity, 1);
  });

  test('handles empty input', () => {
    const r = vMeasure([], []);
    close(r.vMeasure, 1);
  });
});

describe('noise handling', () => {
  test('noise items are expanded to singletons, not pooled', () => {
    // Pooling -1 would score two unrelated outliers as a deliberate group.
    const truth = ['a', 'a', 'b', 'c'];
    const predicted = ['a', 'a', -1, -1];

    const pooled = pairwise(truth, predicted);
    const expanded = pairwise(truth, predicted, { noiseLabel: -1 });

    assert.equal(pooled.falsePositives, 1, 'pooling invents a wrong merge');
    assert.equal(expanded.falsePositives, 0, 'expansion does not');
    assert.ok(expanded.f1 > pooled.f1);
  });

  test('expansion does not mutate the caller arrays', () => {
    const predicted = ['a', -1];
    evaluate(['a', 'b'], predicted, { noiseLabel: -1 });
    assert.deepEqual(predicted, ['a', -1]);
  });

  test('noiseLabel is inert when the label is absent', () => {
    const withOption = evaluate(['a', 'a'], ['x', 'x'], { noiseLabel: -1 });
    const without = evaluate(['a', 'a'], ['x', 'x']);
    assert.deepEqual(withOption, without);
  });
});

describe('evaluate', () => {
  test('reports counts alongside the three metrics', () => {
    const r = evaluate([0, 0, 1, 1, 2], [0, 0, 1, 2, 2]);
    assert.equal(r.items, 5);
    assert.equal(r.trueClusters, 3);
    assert.equal(r.predictedClusters, 3);
    assert.ok(r.adjustedRandIndex <= 1);
    assert.ok(r.pairwise.f1 <= 1);
    assert.ok(r.v.vMeasure <= 1);
  });

  test('counts clusters after noise expansion', () => {
    const r = evaluate(['a', 'b', 'c'], ['x', -1, -1], { noiseLabel: -1 });
    assert.equal(r.predictedClusters, 3, 'two noise items became two clusters');
  });
});

describe('diagnose', () => {
  test('reports nothing when the clustering is perfect', () => {
    const d = diagnose([0, 0, 1, 1], [0, 0, 1, 1]);
    assert.deepEqual(d.splits, []);
    assert.deepEqual(d.merges, []);
  });

  test('names the true cluster that got split and where it went', () => {
    const d = diagnose(['dark-mode', 'dark-mode', 'dark-mode'], ['a', 'a', 'b']);
    assert.equal(d.splits.length, 1);
    assert.equal(d.splits[0]?.trueCluster, 'dark-mode');
    assert.equal(d.splits[0]?.size, 3);
    assert.deepEqual(d.splits[0]?.fragments, [
      { predictedCluster: 'a', count: 2 },
      { predictedCluster: 'b', count: 1 },
    ]);
  });

  test('names the predicted cluster that over-merged and what it mixed', () => {
    // The exact trap the corpus is built around: a feature request and a bug
    // about the same feature share heavy lexical overlap.
    const d = diagnose(['csv-export', 'csv-export-bug'], ['c1', 'c1']);
    assert.equal(d.merges.length, 1);
    assert.equal(d.merges[0]?.predictedCluster, 'c1');
    assert.deepEqual(d.merges[0]?.sources, [
      { trueCluster: 'csv-export', count: 1 },
      { trueCluster: 'csv-export-bug', count: 1 },
    ]);
  });

  test('orders worst-first by fragment count, then size', () => {
    const truth = ['a', 'a', 'a', 'b', 'b'];
    const predicted = ['1', '2', '3', '4', '5'];
    const d = diagnose(truth, predicted);
    assert.equal(d.splits[0]?.trueCluster, 'a', 'three fragments beats two');
    assert.equal(d.splits[1]?.trueCluster, 'b');
  });

  test('is deterministic across runs, since reports get diffed', () => {
    const truth = ['a', 'a', 'b', 'b', 'c', 'c'];
    const predicted = ['1', '2', '1', '2', '1', '2'];
    assert.deepEqual(diagnose(truth, predicted), diagnose(truth, predicted));
  });
});
