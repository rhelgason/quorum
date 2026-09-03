import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildIssues } from './issues.ts';
import type { Submission } from './submission.ts';

const NOW = '2026-09-03T00:00:00.000Z';

function sub(over: Partial<Submission> & Pick<Submission, 'id' | 'body' | 'userId'>): Submission {
  return {
    projectId: 'p1',
    kind: 'feature_request',
    source: 'support_inbox',
    clusterText: over.body,
    attributed: true,
    clientTs: '2026-09-01T00:00:00.000Z',
    receivedAt: NOW,
    ...over,
  };
}

/** Two topics with no shared vocabulary, so clustering is unambiguous. */
function twoTopics(): Submission[] {
  return [
    sub({ id: 'd1', body: 'please add dark mode', userId: 'u:1' }),
    sub({ id: 'd2', body: 'dark mode would be great', userId: 'u:2' }),
    sub({ id: 'd3', body: 'add dark mode support', userId: 'u:3' }),
    sub({ id: 'e1', body: 'csv export is broken', userId: 'u:4', kind: 'bug' }),
    sub({ id: 'e2', body: 'the csv export fails', userId: 'u:5', kind: 'bug' }),
  ];
}

describe('the ranked list', () => {
  test('an empty corpus produces no issues', () => {
    assert.deepEqual(buildIssues([], { now: NOW }), []);
  });

  test('two topics become two issues', () => {
    const issues = buildIssues(twoTopics(), { now: NOW });
    assert.equal(issues.length, 2);
  });

  test('the issue with more unique users ranks first', () => {
    const issues = buildIssues(twoTopics(), { now: NOW });
    assert.equal(issues[0]?.uniqueUsers, 3);
    assert.equal(issues[1]?.uniqueUsers, 2);
  });

  test('unique users beat submission volume', () => {
    // rank.ts Opinion 3, end to end: one motivated person filing five times
    // must not outrank three people filing once each. This is the entire spam
    // surface of a feedback product.
    const loud = Array.from({ length: 5 }, (_, i) =>
      sub({ id: `loud${i}`, body: 'csv export is broken', userId: 'u:99', kind: 'bug' }),
    );
    const issues = buildIssues([...twoTopics().slice(0, 3), ...loud], { now: NOW });
    assert.equal(issues[0]?.uniqueUsers, 3);
    assert.equal(issues[0]?.submissionCount, 3);
  });

  test('scores are ordered descending', () => {
    const issues = buildIssues(twoTopics(), { now: NOW });
    assert.ok((issues[0]?.score ?? 0) >= (issues[1]?.score ?? 0));
  });

  test('the same input always produces the same list', () => {
    // A ranked list you cannot reproduce is one you cannot defend when a
    // customer disputes it.
    assert.deepEqual(buildIssues(twoTopics(), { now: NOW }), buildIssues(twoTopics(), { now: NOW }));
  });

  test('limit truncates after ranking, keeping the top', () => {
    const issues = buildIssues(twoTopics(), { now: NOW, limit: 1 });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.uniqueUsers, 3);
  });
});

describe('evidence', () => {
  test('every issue carries verbatim quotes', () => {
    // ADR-0012: the ranked list is the product, and a row with no drill-down
    // gets distrusted the first time it is subtly wrong.
    for (const issue of buildIssues(twoTopics(), { now: NOW })) {
      assert.ok(issue.quotes.length > 0);
      for (const quote of issue.quotes) assert.ok(quote.body.length > 0);
    }
  });

  test('the title is a verbatim member body, not a synthesis', () => {
    const corpus = twoTopics();
    for (const issue of buildIssues(corpus, { now: NOW })) {
      assert.ok(corpus.some((s) => s.body === issue.title));
    }
  });

  test('the labelling quote comes first and is flagged', () => {
    const issues = buildIssues(twoTopics(), { now: NOW });
    const first = issues[0]?.quotes[0];
    assert.equal(first?.isLabel, true);
    assert.equal(first?.submissionId, issues[0]?.medoidId);
  });

  test('only one quote is flagged as the label', () => {
    for (const issue of buildIssues(twoTopics(), { now: NOW })) {
      assert.equal(issue.quotes.filter((q) => q.isLabel).length, 1);
    }
  });

  test('non-label quotes are newest first', () => {
    const corpus = [
      sub({ id: 'a', body: 'dark mode please', userId: 'u:1', clientTs: '2026-08-01T00:00:00.000Z' }),
      sub({ id: 'b', body: 'dark mode please', userId: 'u:2', clientTs: '2026-08-20T00:00:00.000Z' }),
      sub({ id: 'c', body: 'dark mode please', userId: 'u:3', clientTs: '2026-08-10T00:00:00.000Z' }),
    ];
    const rest = buildIssues(corpus, { now: NOW })[0]?.quotes.filter((q) => !q.isLabel) ?? [];
    const times = rest.map((q) => q.clientTs);
    assert.deepEqual(times, [...times].sort().reverse());
  });

  test('quotesPerIssue caps the evidence', () => {
    const issue = buildIssues(twoTopics(), { now: NOW, quotesPerIssue: 1 })[0];
    assert.equal(issue?.quotes.length, 1);
  });

  test('quotesPerIssue of zero yields no quotes', () => {
    assert.deepEqual(buildIssues(twoTopics(), { now: NOW, quotesPerIssue: 0 })[0]?.quotes, []);
  });

  test('memberIds lists every submission behind the issue', () => {
    const issues = buildIssues(twoTopics(), { now: NOW });
    const total = issues.reduce((n, i) => n + i.memberIds.length, 0);
    assert.equal(total, 5);
  });

  test('the score explanation names its inputs', () => {
    const issue = buildIssues(twoTopics(), { now: NOW })[0];
    assert.match(issue?.explanation ?? '', /users/);
    assert.match(issue?.explanation ?? '', /demand/);
  });

  test('components expose every ranking input', () => {
    const c = buildIssues(twoTopics(), { now: NOW })[0]?.components;
    assert.equal(typeof c?.weightedDemand, 'number');
    assert.equal(typeof c?.growthMultiplier, 'number');
    assert.equal(typeof c?.meanAccountWeight, 'number');
  });

  test('kinds are broken down per issue', () => {
    const issues = buildIssues(twoTopics(), { now: NOW });
    const bugIssue = issues.find((i) => i.kinds.bug !== undefined);
    assert.equal(bugIssue?.kinds.bug, 2);
  });
});

describe('praise', () => {
  const withPraise = [
    ...twoTopics(),
    sub({ id: 'p1', body: 'the scanner is absolute magic', userId: 'u:6', kind: 'praise' }),
    sub({ id: 'p2', body: 'scanner is magic thank you', userId: 'u:7', kind: 'praise' }),
  ];

  test('praise-only clusters are absent from the build list', () => {
    // rank.ts Opinion 4: "the scanner is magic" topping the roadmap is a bug.
    const issues = buildIssues(withPraise, { now: NOW });
    assert.equal(issues.some((i) => i.kinds.praise !== undefined), false);
  });

  test('praise appears when the caller asks for it', () => {
    const issues = buildIssues(withPraise, { now: NOW, rank: { excludeKinds: [] } });
    assert.ok(issues.some((i) => i.kinds.praise !== undefined));
  });
});

describe('account weighting', () => {
  test('a higher-revenue cohort outranks an equally sized free one', () => {
    const corpus = [
      sub({ id: 'a1', body: 'dark mode please', userId: 'u:1', mrr: 8000 }),
      sub({ id: 'a2', body: 'add dark mode', userId: 'u:2', mrr: 8000 }),
      sub({ id: 'b1', body: 'csv export broken', userId: 'u:3' }),
      sub({ id: 'b2', body: 'the csv export fails', userId: 'u:4' }),
    ];
    const issues = buildIssues(corpus, { now: NOW });
    assert.ok((issues[0]?.components.meanAccountWeight ?? 0) > 1);
  });

  test('one whale does not outrank a cohort', () => {
    // Log-scaled weighting (ADR-0015): revenue orders the list, it does not
    // dominate it. A $10k account counts as roughly three users, not a hundred.
    const corpus = [
      sub({ id: 'w1', body: 'dark mode please', userId: 'u:whale', mrr: 100_000 }),
      ...Array.from({ length: 6 }, (_, i) =>
        sub({ id: `f${i}`, body: 'csv export broken', userId: `u:free${i}` }),
      ),
    ];
    const issues = buildIssues(corpus, { now: NOW });
    assert.equal(issues[0]?.uniqueUsers, 6);
  });
});

describe('clustering inputs', () => {
  test('clusterText drives clustering, body stays verbatim', () => {
    // Two crash reports whose messages share no words, but whose derived
    // clusterText is identical. They must land in one issue while the ranked
    // list still shows what was actually thrown.
    const corpus = [
      sub({
        id: 'x1',
        body: 'Error: Timeout after 30012ms fetching order A-4471',
        clusterText: 'Error: Timeout after <num> fetching order <id>',
        userId: 'u:1',
        kind: 'bug',
      }),
      sub({
        id: 'x2',
        body: 'Error: Timeout after 28004ms fetching order B-9982',
        clusterText: 'Error: Timeout after <num> fetching order <id>',
        userId: 'u:2',
        kind: 'bug',
      }),
    ];
    const issues = buildIssues(corpus, { now: NOW });
    assert.equal(issues.length, 1);
    assert.match(issues[0]?.title ?? '', /30012ms|28004ms/);
  });

  test('the plurality route is reported with its share', () => {
    const corpus = [
      sub({ id: 'r1', body: 'csv export broken', userId: 'u:1', route: '/reports' }),
      sub({ id: 'r2', body: 'the csv export fails', userId: 'u:2', route: '/reports' }),
      sub({ id: 'r3', body: 'csv export is broken', userId: 'u:3', route: '/billing' }),
    ];
    const issue = buildIssues(corpus, { now: NOW })[0];
    assert.equal(issue?.topRoute?.route, '/reports');
    assert.ok((issue?.topRoute?.share ?? 0) > 0.6);
  });

  test('share counts only members that reported a route', () => {
    // Otherwise a route looks weak purely because server-side imports carry
    // none, and the regression signal reads as noise.
    const corpus = [
      sub({ id: 'r1', body: 'csv export broken', userId: 'u:1', route: '/reports' }),
      sub({ id: 'r2', body: 'the csv export fails', userId: 'u:2' }),
    ];
    assert.equal(buildIssues(corpus, { now: NOW })[0]?.topRoute?.share, 1);
  });

  test('no route means no topRoute field', () => {
    assert.equal(buildIssues(twoTopics(), { now: NOW })[0]?.topRoute, undefined);
  });

  test('embeddings bridge feedback that shares no vocabulary', () => {
    // The case lexical clustering provably cannot reach (ADR-0018): "dark
    // mode" and "destroys my eyes at night" have no content word in common, so
    // no amount of cluster-level evidence connects them. An identical vector
    // does.
    const vector = new Float64Array([1, 0, 0]);
    const corpus = [
      sub({ id: 'v1', body: 'please add dark mode', userId: 'u:1', embedding: vector }),
      sub({ id: 'v2', body: 'the app destroys my eyes at night', userId: 'u:2', embedding: vector }),
    ];
    assert.equal(buildIssues(corpus, { now: NOW, consolidate: false }).length, 2);
    assert.equal(
      buildIssues(corpus, { now: NOW, consolidate: false, semanticWeight: 1 }).length,
      1,
    );
  });

  test('a submission without an embedding is not penalised', () => {
    // Treating a missing vector as similarity 0 would push unembedded
    // submissions out of clusters they lexically belong in.
    const corpus = [
      sub({ id: 'v1', body: 'csv export broken', userId: 'u:1', embedding: new Float64Array([1, 0]) }),
      sub({ id: 'v2', body: 'csv export broken', userId: 'u:2' }),
    ];
    assert.equal(buildIssues(corpus, { now: NOW, semanticWeight: 0.5 }).length, 1);
  });

  test('a structural bonus can be opted into for a bug pass', () => {
    // Off by default: structural signal is a regression detector and actively
    // hurts feature requests (ADR-0013).
    const corpus = [
      sub({ id: 's1', body: 'it fails', userId: 'u:1', kind: 'bug', route: '/scan', appVersion: '4.1' }),
      sub({ id: 's2', body: 'broken here', userId: 'u:2', kind: 'bug', route: '/scan', appVersion: '4.1' }),
    ];
    const plain = buildIssues(corpus, { now: NOW, consolidate: false });
    const structural = buildIssues(corpus, { now: NOW, consolidate: false, structuralBonus: 1 });
    assert.equal(plain.length, 2);
    assert.equal(structural.length, 1);
  });
});

describe('consolidation', () => {
  // Deliberately over-split: a high online threshold puts these in separate
  // clusters, and the offline pass is what reunites them (ADR-0018).
  const fragmented = [
    sub({ id: 'f1', body: 'export to csv is broken', userId: 'u:1', kind: 'bug' }),
    sub({ id: 'f2', body: 'csv download fails silently', userId: 'u:2', kind: 'bug' }),
    sub({ id: 'f3', body: 'downloading the export does nothing', userId: 'u:3', kind: 'bug' }),
  ];

  test('consolidation cannot increase the cluster count', () => {
    const merged = buildIssues(fragmented, { now: NOW, threshold: 0.9 });
    const split = buildIssues(fragmented, { now: NOW, threshold: 0.9, consolidate: false });
    assert.ok(merged.length <= split.length);
  });

  test('a high online threshold plus consolidation recovers fragments', () => {
    const split = buildIssues(fragmented, { now: NOW, threshold: 0.9, consolidate: false });
    const merged = buildIssues(fragmented, { now: NOW, threshold: 0.9, consolidate: { threshold: 0.01 } });
    assert.equal(split.length, 3);
    assert.ok(merged.length < 3);
  });

  test('a rejected merge is not applied', () => {
    // Re-proposing a merge a human already declined trains them to ignore the
    // queue, which is worse than not having one.
    const merged = buildIssues(fragmented, { now: NOW, threshold: 0.9, consolidate: { threshold: 0.01 } });
    const withRejection = buildIssues(fragmented, {
      now: NOW,
      threshold: 0.9,
      consolidate: { threshold: 0.01, rejected: new Set(['c0+c1', 'c0+c1+c2', 'c0+c2', 'c1+c2']) },
    });
    assert.ok(withRejection.length > merged.length);
  });

  test('unrelated topics are not merged even at an aggressive threshold', () => {
    // Average linkage is what stops this becoming a single-linkage chain.
    const issues = buildIssues(twoTopics(), { now: NOW, consolidate: { threshold: 0.03 } });
    assert.equal(issues.length, 2);
  });

  test('complete linkage is available as a conservative lever', () => {
    const issues = buildIssues(fragmented, {
      now: NOW,
      threshold: 0.9,
      consolidate: { threshold: 0.5, linkage: 'complete' },
    });
    assert.equal(issues.length, 3);
  });

  test('maxSizeRatio blocks a large cluster swallowing a singleton', () => {
    const issues = buildIssues(fragmented, {
      now: NOW,
      threshold: 0.9,
      consolidate: { threshold: 0.01, maxSizeRatio: 1 },
    });
    // Pairs of equal size may still merge; a 2-vs-1 absorption may not.
    assert.ok(issues.length >= 2);
  });
});
