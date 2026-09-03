import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadCorpus, truthLabels, validate, type Corpus } from './corpus.ts';
import { scoreHardPairs } from './hard-pairs.ts';

const corpus = loadCorpus();

describe('corpus integrity', () => {
  test('has no validation issues', () => {
    const issues = validate(corpus);
    assert.deepEqual(
      issues,
      [],
      `corpus validation failed:\n${issues.map((i) => `  [${i.code}] ${i.message}`).join('\n')}`,
    );
  });

  test('is large enough to measure anything', () => {
    // Below roughly a hundred items, metric variance swamps the effect of a
    // threshold change and tuning becomes noise-fitting.
    assert.ok(corpus.submissions.length >= 150, `only ${corpus.submissions.length} submissions`);
    assert.ok(corpus.clusters.length >= 25, `only ${corpus.clusters.length} clusters`);
  });

  test('submission ids are unique', () => {
    const ids = new Set(corpus.submissions.map((s) => s.id));
    assert.equal(ids.size, corpus.submissions.length);
  });

  test('contains singletons, so noise handling is exercised', () => {
    const singletons = corpus.submissions.filter((s) => s.cluster.startsWith('singleton-'));
    assert.ok(singletons.length >= 15, `only ${singletons.length} singletons`);
  });

  test('cluster sizes vary, so the metrics are not measuring a uniform partition', () => {
    const sizes = new Map<string, number>();
    for (const s of corpus.submissions) sizes.set(s.cluster, (sizes.get(s.cluster) ?? 0) + 1);
    const declared = [...sizes.entries()]
      .filter(([id]) => !id.startsWith('singleton-'))
      .map(([, n]) => n);
    assert.ok(Math.max(...declared) >= 8);
    assert.ok(Math.min(...declared) <= 3);
  });

  test('spans multiple kinds, sources, platforms, and versions', () => {
    const distinct = (fn: (s: Corpus['submissions'][number]) => string) =>
      new Set(corpus.submissions.map(fn)).size;
    assert.ok(distinct((s) => s.kind) >= 4, 'kinds');
    assert.ok(distinct((s) => s.source) >= 5, 'sources');
    assert.equal(distinct((s) => s.platform), 2);
    assert.ok(distinct((s) => s.appVersion) >= 4, 'versions');
    assert.ok(distinct((s) => s.route) >= 10, 'routes');
  });

  test('includes users who filed more than once', () => {
    // Ranking counts unique users, not submissions. Without repeat filers the
    // corpus cannot exercise that.
    const counts = new Map<string, number>();
    for (const s of corpus.submissions) counts.set(s.userId, (counts.get(s.userId) ?? 0) + 1);
    const repeats = [...counts.values()].filter((n) => n > 1).length;
    assert.ok(repeats >= 3, `only ${repeats} repeat filers`);
  });

  test('every declared cluster carries a difficulty rating', () => {
    for (const c of corpus.clusters) {
      assert.ok(
        c.difficulty === 'easy' || c.difficulty === 'medium' || c.difficulty === 'hard',
        `cluster '${c.id}' has no valid difficulty`,
      );
    }
  });

  test('truthLabels aligns with submissions', () => {
    const labels = truthLabels(corpus);
    assert.equal(labels.length, corpus.submissions.length);
    assert.equal(labels[0], corpus.submissions[0]?.cluster);
  });
});

describe('hard pairs', () => {
  test('cover both directions', () => {
    const same = corpus.hardPairs.filter((p) => p.sameCluster).length;
    const diff = corpus.hardPairs.length - same;
    assert.ok(same >= 5, `only ${same} should-merge pairs`);
    assert.ok(diff >= 5, `only ${diff} should-not-merge pairs`);
  });

  test('cover several distinct traps', () => {
    const traps = new Set(corpus.hardPairs.map((p) => p.trap));
    assert.ok(traps.size >= 8, `only ${traps.size} distinct traps`);
  });

  test('the ground truth itself scores 100%', () => {
    // Sanity check on the pair definitions: if truth cannot pass its own
    // adversarial set, the set is wrong.
    const report = scoreHardPairs(corpus, truthLabels(corpus));
    assert.equal(report.correct, report.total);
    assert.equal(report.accuracy, 1);
  });
});

describe('validate', () => {
  /** Deep clone so mutations don't leak between tests. */
  function mutate(fn: (c: Corpus) => void): Corpus {
    const copy = structuredClone(corpus);
    fn(copy);
    return copy;
  }

  test('flags a submission referencing an undeclared cluster', () => {
    const broken = mutate((c) => {
      (c.submissions[0] as { cluster: string }).cluster = 'nope';
    });
    assert.ok(validate(broken).some((i) => i.code === 'undeclared-cluster'));
  });

  test('flags duplicate submission ids', () => {
    const broken = mutate((c) => {
      (c.submissions[1] as { id: string }).id = c.submissions[0]!.id;
    });
    assert.ok(validate(broken).some((i) => i.code === 'duplicate-id'));
  });

  test('flags a declared cluster with no members', () => {
    const broken = mutate((c) => {
      c.clusters.push({ id: 'ghost', title: 'Ghost', kind: 'bug', difficulty: 'easy' });
    });
    assert.ok(validate(broken).some((i) => i.code === 'empty-cluster'));
  });

  test('flags a declared cluster that shrank to one member', () => {
    const broken = mutate((c) => {
      c.submissions = c.submissions.filter(
        (s) => s.cluster !== 'praise-speed' || s.id === 's139',
      );
    });
    assert.ok(validate(broken).some((i) => i.code === 'undersized-cluster'));
  });

  test('flags a singleton that gained a second member', () => {
    const broken = mutate((c) => {
      (c.submissions[0] as { cluster: string }).cluster = 'singleton-001';
    });
    assert.ok(validate(broken).some((i) => i.code === 'fat-singleton'));
  });

  test('flags a hard pair pointing at a missing submission', () => {
    const broken = mutate((c) => {
      (c.hardPairs[0] as { a: string }).a = 'sZZZ';
    });
    assert.ok(validate(broken).some((i) => i.code === 'dangling-pair'));
  });

  test('flags a hard pair that contradicts the labels', () => {
    // The drift this exists to catch: someone relabels a submission and the
    // adversarial set silently starts asserting the opposite of the truth.
    const broken = mutate((c) => {
      (c.hardPairs[0] as { sameCluster: boolean }).sameCluster =
        !c.hardPairs[0]!.sameCluster;
    });
    assert.ok(validate(broken).some((i) => i.code === 'pair-contradicts-labels'));
  });

  test('flags an empty body and an unparseable timestamp', () => {
    const broken = mutate((c) => {
      (c.submissions[0] as { body: string }).body = '   ';
      (c.submissions[1] as { clientTs: string }).clientTs = 'not a date';
    });
    const codes = validate(broken).map((i) => i.code);
    assert.ok(codes.includes('empty-body'));
    assert.ok(codes.includes('bad-timestamp'));
  });

  test('reports every issue rather than stopping at the first', () => {
    const broken = mutate((c) => {
      (c.submissions[0] as { cluster: string }).cluster = 'nope';
      (c.submissions[2] as { cluster: string }).cluster = 'also-nope';
    });
    assert.ok(validate(broken).filter((i) => i.code === 'undeclared-cluster').length >= 2);
  });
});
