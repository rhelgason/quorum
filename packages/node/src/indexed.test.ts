/**
 * Write-time assignment, through the public API.
 *
 * The claim being tested is narrow and important: turning the index on changes
 * *what a read costs*, not *what a row means*. If the two paths disagreed, the
 * eval harness would be measuring one clusterer while the service shipped
 * another, and every number in `packages/eval` would stop describing the
 * product.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ClusterIndex } from '../../aggregate/src/cluster-index.ts';
import { Quorum } from './client.ts';
import { buildIssues } from './issues.ts';
import { rebuildIndex } from './rebuild.ts';
import type { ImportRow } from './client.ts';

const NOW = new Date('2026-09-09T00:00:00.000Z');

const ROWS: ImportRow[] = [
  { body: 'the csv export spins forever and never downloads', clientTs: '2026-08-01T00:00:00Z', user: { externalId: 'u1' }, kind: 'bug', context: { route: '/reports' } },
  { body: 'csv export is broken, nothing happens when I click', clientTs: '2026-08-02T00:00:00Z', user: { externalId: 'u2' }, kind: 'bug', context: { route: '/reports' } },
  { body: 'export to csv still broken today', clientTs: '2026-08-03T00:00:00Z', user: { externalId: 'u3' }, kind: 'bug', context: { route: '/reports' } },
  { body: 'please add a dark mode', clientTs: '2026-08-04T00:00:00Z', user: { externalId: 'u4' }, context: { route: '/settings' } },
  { body: 'dark mode would be lovely, please add dark mode', clientTs: '2026-08-05T00:00:00Z', user: { externalId: 'u5' }, context: { route: '/settings' } },
  { body: 'we need SAML SSO before we can roll out', clientTs: '2026-08-06T00:00:00Z', user: { externalId: 'u6' }, context: { route: '/security' } },
];

/** A Quorum with an index, loaded with the same rows. */
async function indexed(threshold = 0.25): Promise<Quorum> {
  const quorum = new Quorum({
    projectId: 'p',
    now: () => NOW,
    index: new ClusterIndex({ threshold }),
  });
  await quorum.import(ROWS, { source: 'support_inbox' });
  return quorum;
}

async function unindexed(): Promise<Quorum> {
  const quorum = new Quorum({ projectId: 'p', now: () => NOW });
  await quorum.import(ROWS, { source: 'support_inbox' });
  return quorum;
}

describe('an indexed read and an unindexed read', () => {
  it('produce the same ranked list', async () => {
    const withIndex = await (await indexed()).issues({ now: NOW });
    const without = await (await unindexed()).issues({ now: NOW });

    // Cluster ids are internal and may differ; everything a reader sees must
    // not.
    assert.deepEqual(
      withIndex.map((i) => [i.title, i.uniqueUsers, i.submissionCount, i.score.toFixed(6)]),
      without.map((i) => [i.title, i.uniqueUsers, i.submissionCount, i.score.toFixed(6)]),
    );
  });

  it('agree on the evidence behind each row', async () => {
    const withIndex = await (await indexed()).issues({ now: NOW });
    const without = await (await unindexed()).issues({ now: NOW });

    assert.deepEqual(
      withIndex.map((i) => i.quotes.map((q) => q.body)),
      without.map((i) => i.quotes.map((q) => q.body)),
    );
  });
});

describe('the index itself', () => {
  it('assigns on write, not on read', async () => {
    const quorum = await indexed();

    assert.equal(quorum.index?.docCount, ROWS.length);
    assert.ok((quorum.index?.clusterCount ?? 0) > 0);
    // Every stored submission has a home before anyone asks for the list.
    for (const submission of await quorum.submissions()) {
      assert.notEqual(quorum.index?.labelFor(submission.id), undefined);
    }
  });

  it('groups the obvious things', async () => {
    const quorum = await indexed(0.2);
    const submissions = await quorum.submissions();
    const label = (needle: string): string | undefined =>
      quorum.index?.labelFor(submissions.find((s) => s.body.includes(needle))?.id ?? '');

    assert.equal(label('csv export spins'), label('csv export is broken'));
    assert.notEqual(label('csv export spins'), label('add a dark mode'));
  });

  it('does not re-index a duplicate', async () => {
    const quorum = await indexed();
    const before = quorum.index?.docCount;

    const again = await quorum.import(ROWS, { source: 'support_inbox' });

    assert.equal(again.inserted, 0);
    // A re-run import must not double a cluster's weight.
    assert.equal(quorum.index?.docCount, before);
  });

  it('keeps earlier assignments stable as the corpus grows', async () => {
    const quorum = await indexed();
    const before = quorum.index?.assignments() as Map<string, string>;

    await quorum.import(
      Array.from({ length: 15 }, (_, i) => ({
        body: `an unrelated piece of feedback number ${String(i)}`,
        clientTs: '2026-08-20T00:00:00Z',
        user: { externalId: `later-${String(i)}` },
      })),
      { source: 'support_inbox' },
    );

    // The property the service README asks for: a ranked list that does not
    // quietly reorganise between two page loads.
    for (const [id, cluster] of before) {
      assert.equal(quorum.index?.labelFor(id), cluster, `${id} moved`);
    }
  });
});

describe('a partially indexed store', () => {
  it('still returns every submission', async () => {
    // An index file lost, or rows imported before indexing existed. Dropping
    // the unindexed ones would silently shrink the ranked list.
    const quorum = await unindexed();
    const submissions = await quorum.submissions();

    const partial = new Map<string, string>();
    partial.set(submissions[0]?.id as string, 'known-cluster');

    const issues = buildIssues([...submissions], { now: NOW, assignments: partial });
    const counted = issues.reduce((sum, issue) => sum + issue.submissionCount, 0);

    assert.equal(counted, submissions.length);
  });

  it('never collides a recovered id with a stored one', async () => {
    const quorum = await unindexed();
    const submissions = await quorum.submissions();

    // A stored cluster literally named `c0` — the same shape the recovery
    // clusterer generates. Without a prefix these merge and the list gains
    // members nobody wrote.
    const partial = new Map<string, string>([[submissions[0]?.id as string, 'c0']]);
    const issues = buildIssues([...submissions], { now: NOW, assignments: partial, consolidate: false });

    const first = issues.find((issue) =>
      issue.quotes.some((q) => q.submissionId === submissions[0]?.id),
    );
    assert.equal(first?.submissionCount, 1, 'the stored assignment absorbed recovered rows');
  });
});

describe('rebuilding from the log', () => {
  it('reproduces the assignments ingest made', async () => {
    const quorum = await indexed();
    const original = quorum.index?.assignments() as Map<string, string>;

    const { index, submissions, clusters } = await rebuildIndex(quorum.store, 'p', {
      threshold: 0.25,
    });

    // Exact, not approximate. Leader-follower is deterministic, term
    // statistics evolve identically, and an append-only log preserves order —
    // so a replay is the same computation, not a similar one. That is what
    // lets the service treat the index as a cache instead of as state.
    assert.deepEqual(index.assignments(), original);
    assert.equal(submissions, ROWS.length);
    assert.equal(clusters, quorum.index?.clusterCount);
  });

  it('is stable across repeated rebuilds', async () => {
    const quorum = await indexed();
    const first = await rebuildIndex(quorum.store, 'p', { threshold: 0.25 });
    const second = await rebuildIndex(quorum.store, 'p', { threshold: 0.25 });

    assert.deepEqual(first.index.assignments(), second.index.assignments());
  });

  it('produces the same ranked list after a rebuild', async () => {
    const quorum = await indexed();
    const before = await quorum.issues({ now: NOW });

    const { index } = await rebuildIndex(quorum.store, 'p', { threshold: 0.25 });
    const restarted = new Quorum({ projectId: 'p', now: () => NOW, store: quorum.store, index });

    // What a restart must not do: change what anyone sees.
    assert.deepEqual(
      (await restarted.issues({ now: NOW })).map((i) => [i.title, i.score.toFixed(6)]),
      before.map((i) => [i.title, i.score.toFixed(6)]),
    );
  });

  it('is empty for a project with nothing in it', async () => {
    const quorum = await indexed();
    const { index, submissions } = await rebuildIndex(quorum.store, 'other', { threshold: 0.25 });
    assert.equal(submissions, 0);
    assert.equal(index.clusterCount, 0);
  });
});
