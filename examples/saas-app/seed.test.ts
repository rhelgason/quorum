/**
 * The seed's date shift.
 *
 * Worth testing rather than eyeballing: this silently rewrites every timestamp
 * in the corpus, ranking decays on those timestamps, and getting it wrong
 * produces a demo that looks fine and ranks nonsense.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Quorum } from '../../packages/node/src/client.ts';
import { seedRows } from './seed.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CSV = readFileSync(join(here, '../support-inbox/inbox.csv'), 'utf8');
const NOW = new Date('2026-09-09T00:00:00.000Z');

describe('seedRows', () => {
  it('reads the whole export', () => {
    const rows = seedRows(CSV, { now: NOW });
    assert.ok(rows.length >= 40, `only got ${String(rows.length)} rows`);
    assert.ok(rows.every((row) => row.body.trim() !== ''));
  });

  it('lands the newest ticket on now', () => {
    const rows = seedRows(CSV, { now: NOW });
    const newest = Math.max(...rows.map((row) => Date.parse(row.clientTs)));
    assert.equal(newest, NOW.getTime());
  });

  it('never places a ticket in the future', () => {
    // Anything after `now` gets a recency weight above 1.0 and a growth window
    // it does not belong in.
    for (const row of seedRows(CSV, { now: NOW })) {
      assert.ok(Date.parse(row.clientTs) <= NOW.getTime(), `${row.clientTs} is in the future`);
    }
  });

  it('preserves the intervals between tickets', () => {
    // Translation, not compression. Growth is measured over fixed windows, so
    // squashing the timeline would invent a spike that is not in the data.
    const original = seedRows(CSV, { now: NOW, shift: false });
    const shifted = seedRows(CSV, { now: NOW });

    for (let i = 1; i < original.length; i++) {
      const before = Date.parse(original[i]!.clientTs) - Date.parse(original[i - 1]!.clientTs);
      const after = Date.parse(shifted[i]!.clientTs) - Date.parse(shifted[i - 1]!.clientTs);
      assert.equal(after, before);
    }
  });

  it('keeps the ticket id, so re-seeding is a no-op', () => {
    const rows = seedRows(CSV, { now: NOW });
    assert.equal(rows[0]?.id, 'T-1001');
  });

  it('carries mrr, kind and route through', () => {
    const rows = seedRows(CSV, { now: NOW });
    const sso = rows.find((row) => row.body.includes('SAML SSO'));

    assert.equal(sso?.user?.traits?.['mrr'], '6200');
    assert.equal(sso?.kind, 'feature_request');
    assert.equal(sso?.context?.route, '/settings/security');
  });

  it('is empty for an empty file', () => {
    assert.deepEqual(seedRows('', { now: NOW }), []);
  });
});

describe('seeding a store', () => {
  it('imports, and re-importing changes nothing', async () => {
    const quorum = new Quorum({ projectId: 'seed-test', now: () => NOW });
    const rows = seedRows(CSV, { now: NOW });

    const first = await quorum.import(rows, { source: 'support_inbox' });
    assert.ok(first.inserted > 40);
    assert.equal(first.duplicate, 0);

    const again = await quorum.import(rows, { source: 'support_inbox' });
    assert.equal(again.inserted, 0);
    assert.equal(again.duplicate, first.inserted);
  });

  it('produces a ranked list with weighted accounts in it', async () => {
    const quorum = new Quorum({ projectId: 'seed-rank', now: () => NOW });
    await quorum.import(seedRows(CSV, { now: NOW }), { source: 'support_inbox' });

    const issues = await quorum.issues({ now: NOW, limit: 5 });

    assert.ok(issues.length > 0, 'the seeded app would open on an empty backlog');
    assert.ok(
      issues.some((issue) => issue.components.meanAccountWeight > 1),
      'no issue carries account weight — mrr never reached ranking',
    );
  });
});
