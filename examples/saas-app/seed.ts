/**
 * Seeding the example app with feedback a team would already have.
 *
 * An empty dashboard proves nothing. The v0.1 claim is that a team's *first*
 * session ends with a ranked list (ADR-0012), and you cannot demonstrate that
 * with a store you have to fill in by hand first.
 *
 * The one non-obvious thing here is the date shift. The bundled inbox spans
 * May to August 2026, and ranking decays on client time — left alone, the
 * whole corpus reads as ancient, every score collapses toward zero, and one
 * submission typed into the widget today outranks a hundred real tickets. So
 * the corpus is translated forward to end at "now", preserving every interval
 * between tickets. Growth and recency stay meaningful, and a submission from
 * the widget lands among the seeded ones instead of on top of them.
 *
 * What is *not* done: stamping every row with the wall clock. `ImportRow`
 * refuses to default `clientTs` for exactly this reason, and flattening the
 * timeline would make the ranked list confident and meaningless.
 */

import { readFileSync } from 'node:fs';

import { parseCsvRecords } from '../../packages/node/src/csv.ts';
import type { ImportResult, ImportRow, Quorum } from '../../packages/node/src/client.ts';
import type { SubmissionKind } from '../../packages/core/src/protocol.ts';

const KINDS: ReadonlySet<string> = new Set(['feature_request', 'bug', 'praise', 'question', 'rage']);

export interface SeedOptions {
  /** The newest ticket is translated to this instant. */
  now: Date;
  /** Set false to import the file's own dates. */
  shift?: boolean;
}

/**
 * Turn the support-inbox export into import rows, shifted forward in time.
 *
 * Pure, and separated from the file read so the shift is testable — an
 * off-by-one here silently changes every score in the demo.
 */
export function seedRows(csv: string, options: SeedOptions): ImportRow[] {
  const records = parseCsvRecords(csv);
  if (records.length === 0) return [];

  const stamps = records.map((record) => Date.parse(record['created_at'] ?? ''));
  const newest = Math.max(...stamps.filter((value) => Number.isFinite(value)));
  const offset = options.shift === false || !Number.isFinite(newest) ? 0 : options.now.getTime() - newest;

  return records.map((record, index) => {
    const stamp = stamps[index];
    const clientTs = new Date((Number.isFinite(stamp) ? (stamp as number) : newest) + offset).toISOString();
    const kind = record['type']?.trim().toLowerCase();
    const mrr = record['mrr']?.trim();

    return {
      body: record['description'] ?? '',
      clientTs,
      // The ticket id keeps the import idempotent: re-seeding an existing
      // store collides on these rather than doubling every issue's evidence.
      ...(record['ticket_id'] !== undefined && { id: record['ticket_id'] }),
      ...(kind !== undefined && KINDS.has(kind) && { kind: kind as SubmissionKind }),
      user: {
        externalId: record['requester_id'] ?? '',
        ...(mrr !== undefined && mrr !== '' && { traits: { mrr } }),
      },
      context: {
        ...(record['page'] !== undefined && record['page'] !== '' && { route: record['page'] }),
      },
    };
  });
}

/** Load the export into the store. Safe to call on every boot. */
export async function seed(
  quorum: Quorum,
  csvPath: string,
  options: SeedOptions,
): Promise<ImportResult> {
  const rows = seedRows(readFileSync(csvPath, 'utf8'), options);
  return quorum.import(rows, { source: 'support_inbox' });
}
