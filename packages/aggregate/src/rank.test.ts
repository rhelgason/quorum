import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  accountWeight,
  explain,
  growthMultiplier,
  rank,
  recencyDecay,
  type RankMember,
  type SubmissionKind,
} from './rank.ts';

const NOW = '2026-09-01T00:00:00Z';
const DAY = 86_400_000;

function daysAgo(n: number): string {
  return new Date(Date.parse(NOW) - n * DAY).toISOString();
}

function member(overrides: Partial<RankMember> = {}): RankMember {
  return {
    userId: 'u1',
    kind: 'feature_request' as SubmissionKind,
    clientTs: daysAgo(1),
    ...overrides,
  };
}

describe('accountWeight — logarithmic, not linear', () => {
  test('an anonymous or free user is exactly 1', () => {
    assert.equal(accountWeight(undefined), 1);
    assert.equal(accountWeight(0), 1);
    assert.equal(accountWeight(-5), 1);
  });

  test('revenue still orders users', () => {
    assert.ok(accountWeight(10_000) > accountWeight(1_000));
    assert.ok(accountWeight(1_000) > accountWeight(100));
    assert.ok(accountWeight(100) > accountWeight(0));
  });

  test('a whale counts as a few users, not a hundred', () => {
    // The whole point: linear MRR weighting turns the roadmap into "what does
    // our biggest customer want". A $10k/mo account is worth ~3 free users.
    const whale = accountWeight(10_000);
    assert.ok(whale > 2.9 && whale < 3.1, `expected ~3, got ${whale}`);
    assert.ok(whale < accountWeight(0) * 5, 'must not dominate a small cohort');
  });

  test('four free users outweigh one $10k account', () => {
    assert.ok(4 * accountWeight(0) > accountWeight(10_000));
  });

  test('even a $1M account cannot outvote a modest cohort', () => {
    assert.ok(6 * accountWeight(0) > accountWeight(1_000_000));
  });

  test('baseline is configurable', () => {
    assert.ok(accountWeight(1_000, 10) > accountWeight(1_000, 1_000));
  });
});

describe('recencyDecay', () => {
  test('is 1 at zero age and 0.5 at one half-life', () => {
    assert.equal(recencyDecay(0, 60), 1);
    assert.ok(Math.abs(recencyDecay(60, 60) - 0.5) < 1e-9);
    assert.ok(Math.abs(recencyDecay(120, 60) - 0.25) < 1e-9);
  });

  test('clamps future timestamps to 1 rather than amplifying them', () => {
    // Client clocks are wrong. A device set a year ahead must not score 2x.
    assert.equal(recencyDecay(-365, 60), 1);
  });
});

describe('growthMultiplier — volume floor', () => {
  test('is suppressed below the volume floor', () => {
    // 1 → 3 users is "200% growth" on evidence of three people. Unguarded,
    // clusters like this occupy the entire top of the list.
    const r = growthMultiplier(3, 1, 3, 3);
    assert.equal(r.multiplier, 1);
    assert.equal(r.suppressed, true);
  });

  test('applies once the prior window clears the floor', () => {
    const r = growthMultiplier(10, 5, 3, 3);
    assert.equal(r.multiplier, 2);
    assert.equal(r.suppressed, false);
  });

  test('is clamped so one runaway week cannot own the list forever', () => {
    assert.equal(growthMultiplier(100, 5, 3, 3).multiplier, 3);
  });

  test('shrinking demand produces a multiplier below 1', () => {
    assert.equal(growthMultiplier(2, 4, 3, 3).multiplier, 0.5);
  });
});

describe('rank — unique users, never submission counts', () => {
  test('one user filing twenty times loses to twenty users filing once', () => {
    // The spam surface of any public feedback tool, closed by construction.
    const spammer = {
      id: 'spam',
      members: Array.from({ length: 20 }, () => member({ userId: 'loud' })),
    };
    const crowd = {
      id: 'crowd',
      members: Array.from({ length: 20 }, (_, i) => member({ userId: `u${i}` })),
    };
    const [first, second] = rank([spammer, crowd], { now: NOW });
    assert.equal(first?.id, 'crowd');
    assert.equal(first?.components.uniqueUsers, 20);
    assert.equal(second?.components.uniqueUsers, 1);
  });

  test('re-filing makes a user more recent, never louder', () => {
    const once = { id: 'a', members: [member({ userId: 'u', clientTs: daysAgo(30) })] };
    const twice = {
      id: 'b',
      members: [
        member({ userId: 'u', clientTs: daysAgo(30) }),
        member({ userId: 'u', clientTs: daysAgo(1) }),
      ],
    };
    const ranked = rank([once, twice], { now: NOW });
    const a = ranked.find((r) => r.id === 'a');
    const b = ranked.find((r) => r.id === 'b');
    assert.equal(b?.components.uniqueUsers, 1, 'still one user');
    assert.ok((b?.score as number) > (a?.score as number), 'but counted as recent');
  });

  test('reports submissions alongside unique users, for explainability', () => {
    const c = { id: 'a', members: [member({ userId: 'u' }), member({ userId: 'u' })] };
    const [r] = rank([c], { now: NOW });
    assert.equal(r?.components.uniqueUsers, 1);
    assert.equal(r?.components.submissions, 2);
  });
});

describe('rank — recency', () => {
  test('an older cluster of equal size ranks lower', () => {
    const fresh = { id: 'fresh', members: [member({ userId: 'a', clientTs: daysAgo(1) })] };
    const stale = { id: 'stale', members: [member({ userId: 'b', clientTs: daysAgo(180) })] };
    const [first] = rank([stale, fresh], { now: NOW });
    assert.equal(first?.id, 'fresh');
  });

  test('half-life is configurable', () => {
    const c = { id: 'a', members: [member({ userId: 'u', clientTs: daysAgo(60) })] };
    const slow = rank([c], { now: NOW, halfLifeDays: 600 })[0]?.score as number;
    const fast = rank([c], { now: NOW, halfLifeDays: 6 })[0]?.score as number;
    assert.ok(slow > fast);
  });
});

describe('rank — praise is not work', () => {
  test('praise is excluded from the ranked build list by default', () => {
    const praise = {
      id: 'praise',
      members: Array.from({ length: 50 }, (_, i) => member({ userId: `p${i}`, kind: 'praise' })),
    };
    const work = { id: 'work', members: [member({ userId: 'w' })] };
    const ranked = rank([praise, work], { now: NOW });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]?.id, 'work');
  });

  test('questions are NOT excluded — confusion is real work', () => {
    const questions = {
      id: 'confused',
      members: [member({ userId: 'a', kind: 'question' }), member({ userId: 'b', kind: 'question' })],
    };
    assert.equal(rank([questions], { now: NOW }).length, 1);
  });

  test('a mixed cluster keeps its non-praise members', () => {
    const mixed = {
      id: 'm',
      members: [member({ userId: 'a', kind: 'praise' }), member({ userId: 'b', kind: 'bug' })],
    };
    const [r] = rank([mixed], { now: NOW });
    assert.equal(r?.components.uniqueUsers, 1);
  });

  test('exclusions are configurable', () => {
    const c = { id: 'a', members: [member({ userId: 'u', kind: 'bug' })] };
    assert.equal(rank([c], { now: NOW, excludeKinds: ['bug'] }).length, 0);
    assert.equal(rank([c], { now: NOW, excludeKinds: [] }).length, 1);
  });
});

describe('rank — account weighting in aggregate', () => {
  test('a paying cohort outranks an equal-sized free cohort', () => {
    const paying = {
      id: 'paying',
      members: Array.from({ length: 5 }, (_, i) => member({ userId: `p${i}`, mrr: 5_000 })),
    };
    const free = {
      id: 'free',
      members: Array.from({ length: 5 }, (_, i) => member({ userId: `f${i}` })),
    };
    assert.equal(rank([free, paying], { now: NOW })[0]?.id, 'paying');
  });

  test('but a single whale does not outrank a real cohort', () => {
    const whale = { id: 'whale', members: [member({ userId: 'w', mrr: 500_000 })] };
    const cohort = {
      id: 'cohort',
      members: Array.from({ length: 6 }, (_, i) => member({ userId: `u${i}` })),
    };
    assert.equal(rank([whale, cohort], { now: NOW })[0]?.id, 'cohort');
  });

  test('meanAccountWeight is reported so a weighted score can be explained', () => {
    const c = { id: 'a', members: [member({ userId: 'u', mrr: 10_000 })] };
    const [r] = rank([c], { now: NOW });
    assert.ok((r?.components.meanAccountWeight as number) > 2.9);
  });
});

describe('rank — output contract', () => {
  test('is sorted by score descending', () => {
    const ranked = rank(
      [
        { id: 'small', members: [member({ userId: 'a' })] },
        { id: 'big', members: [member({ userId: 'b' }), member({ userId: 'c' })] },
      ],
      { now: NOW },
    );
    for (let i = 1; i < ranked.length; i++) {
      assert.ok((ranked[i - 1]?.score as number) >= (ranked[i]?.score as number));
    }
  });

  test('ties break deterministically by id', () => {
    // An unstable ordering is indistinguishable from churn to a reader.
    const a = { id: 'aaa', members: [member({ userId: 'x' })] };
    const b = { id: 'bbb', members: [member({ userId: 'y' })] };
    assert.deepEqual(rank([b, a], { now: NOW }).map((r) => r.id), ['aaa', 'bbb']);
    assert.deepEqual(rank([a, b], { now: NOW }).map((r) => r.id), ['aaa', 'bbb']);
  });

  test('drops clusters left empty after exclusions', () => {
    const c = { id: 'p', members: [member({ userId: 'u', kind: 'praise' })] };
    assert.deepEqual(rank([c], { now: NOW }), []);
  });

  test('handles an empty input', () => {
    assert.deepEqual(rank([], { now: NOW }), []);
  });

  test('requires an explicit clock, so scores are reproducible', () => {
    assert.throws(() => rank([], { now: 'not a date' }), /invalid 'now'/);
  });

  test('rejects an unparseable member timestamp instead of scoring it as epoch', () => {
    const c = { id: 'a', members: [member({ clientTs: 'yesterday' })] };
    assert.throws(() => rank([c], { now: NOW }), /invalid clientTs/);
  });

  test('components fully account for the score', () => {
    const c = {
      id: 'a',
      members: Array.from({ length: 8 }, (_, i) =>
        member({ userId: `u${i}`, clientTs: daysAgo(i < 4 ? 2 : 9) }),
      ),
    };
    const [r] = rank([c], { now: NOW });
    const comp = r!.components;
    assert.ok(
      Math.abs(r!.score - comp.weightedDemand * comp.growthMultiplier) < 1e-9,
      'score must equal weightedDemand × growthMultiplier',
    );
  });
});

describe('explain', () => {
  test('names users, submissions, and demand', () => {
    const c = { id: 'a', members: [member({ userId: 'u' }), member({ userId: 'v' })] };
    const out = explain(rank([c], { now: NOW })[0]!);
    assert.match(out, /2 users/);
    assert.match(out, /2 submissions/);
    assert.match(out, /demand/);
  });

  test('says why growth is missing rather than hiding it', () => {
    const c = { id: 'a', members: [member({ userId: 'u' })] };
    assert.match(explain(rank([c], { now: NOW })[0]!), /growth n\/a \(only 0 prior\)/);
  });

  test('shows the growth ratio when it applies', () => {
    const members = [
      ...Array.from({ length: 8 }, (_, i) => member({ userId: `r${i}`, clientTs: daysAgo(2) })),
      ...Array.from({ length: 4 }, (_, i) => member({ userId: `p${i}`, clientTs: daysAgo(9) })),
    ];
    assert.match(explain(rank([{ id: 'a', members }], { now: NOW })[0]!), /growth ×2\.00/);
  });

  test('singular grammar for a single user', () => {
    const c = { id: 'a', members: [member({ userId: 'u' })] };
    assert.match(explain(rank([c], { now: NOW })[0]!), /1 user,/);
  });
});
