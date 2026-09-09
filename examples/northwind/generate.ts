/**
 * Generate Northwind Analytics' feedback corpus.
 *
 * ```
 * npm run northwind:generate
 * ```
 *
 * Deterministic: one seed in, the same CSV out, byte for byte. That matters
 * more than it sounds — the README quotes numbers computed from this file, and
 * a corpus that drifted between runs would make every figure in it unfalsifiable.
 * The output is committed, so nobody needs to run this to use the demo; it is
 * here so the data can be reviewed and regenerated rather than trusted.
 *
 * ## What is being simulated
 *
 * A B2B analytics product with about 190 customer accounts on a realistic
 * revenue distribution — mostly free and small, a few large — filing feedback
 * over roughly four months through four channels. Two topics are regressions
 * tied to specific releases, several are growing, several are a permanent
 * trickle.
 *
 * The point of the shapes is that the ranked list has to *distinguish* them.
 * A corpus where everything arrived at a uniform rate would make recency and
 * growth weighting look like decoration.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { RELEASES, TOPICS, type Shape, type Topic } from './topics.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** mulberry32 — small, fast, and seeded, so the corpus is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const WINDOW_DAYS = 120;
export const ACCOUNT_COUNT = 190;

export interface Account {
  id: string;
  plan: 'free' | 'starter' | 'team' | 'business' | 'enterprise';
  mrr: number;
}

/**
 * Accounts on a power-law revenue distribution.
 *
 * Not uniform, because uniform revenue would make log-scaled account weighting
 * indistinguishable from no weighting at all — and demonstrating that
 * difference is half of what this corpus is for
 * ([ADR-0015](../../docs/adr/0015-log-scaled-account-weight.md)).
 */
export function buildAccounts(random: () => number, count = ACCOUNT_COUNT): Account[] {
  const tiers: { plan: Account['plan']; share: number; min: number; max: number }[] = [
    { plan: 'free', share: 0.46, min: 0, max: 0 },
    { plan: 'starter', share: 0.24, min: 29, max: 99 },
    { plan: 'team', share: 0.18, min: 120, max: 480 },
    { plan: 'business', share: 0.09, min: 600, max: 2400 },
    { plan: 'enterprise', share: 0.03, min: 3200, max: 11_000 },
  ];

  const accounts: Account[] = [];
  for (let i = 0; i < count; i++) {
    let roll = random();
    let chosen = tiers[tiers.length - 1] as (typeof tiers)[number];
    for (const tier of tiers) {
      if (roll < tier.share) {
        chosen = tier;
        break;
      }
      roll -= tier.share;
    }
    const mrr =
      chosen.max === 0 ? 0 : Math.round((chosen.min + random() * (chosen.max - chosen.min)) / 10) * 10;
    accounts.push({ id: `cust_${String(i + 1).padStart(3, '0')}`, plan: chosen.plan, mrr });
  }
  return accounts;
}

/**
 * When, within the window, a report of this shape arrives.
 *
 * Returns a day offset in `[0, WINDOW_DAYS)`. The distributions are the whole
 * point of the file: `growing` has to actually trip the growth multiplier and
 * `regression` has to produce nothing before its release and a wall after it,
 * or the ranked list cannot be shown distinguishing them.
 */
export function dayFor(shape: Shape, random: () => number, topic: Topic): number {
  switch (shape) {
    case 'steady':
      return random() * WINDOW_DAYS;

    case 'growing':
      // Squared, so density rises toward the present.
      return WINDOW_DAYS * Math.sqrt(random());

    case 'fading':
      return WINDOW_DAYS * (1 - Math.sqrt(random()));

    case 'trickle':
      return random() * WINDOW_DAYS;

    case 'regression': {
      const release = RELEASES.find((r) => r.version === topic.brokenIn);
      const start = release?.day ?? WINDOW_DAYS * 0.6;
      // Clustered just after the release, tailing off as people give up
      // reporting it.
      return Math.min(WINDOW_DAYS - 0.5, start + Math.abs(random() + random() - 1) * 24);
    }
  }
}

/** The release in effect on a given day. */
export function versionOn(day: number): string {
  let current = RELEASES[0] as (typeof RELEASES)[number];
  for (const release of RELEASES) if (release.day <= day) current = release;
  return current.version;
}

/**
 * Pick an account, biased toward paying ones for topics that skew enterprise.
 *
 * Procurement blockers do not come from the free tier, and pretending they do
 * would flatten the very signal the ranked list is supposed to surface.
 */
function pickAccount(accounts: Account[], bias: number, random: () => number): Account {
  const paying = accounts.filter((a) => a.mrr > 0);
  const pool = random() < bias && paying.length > 0 ? paying : accounts;
  // Within the paying pool, skew further toward the top for high-bias topics.
  if (pool === paying && random() < bias) {
    const ranked = [...paying].sort((a, b) => b.mrr - a.mrr);
    return ranked[Math.floor(random() ** 2 * ranked.length)] as Account;
  }
  return pool[Math.floor(random() * pool.length)] as Account;
}

/** Where a report came in. Mobile topics arrive by shake, not by web nub. */
function pickSource(topic: Topic, random: () => number): string {
  const mobile = topic.route.startsWith('/mobile');
  const roll = random();
  if (mobile) return roll < 0.55 ? 'support_inbox' : roll < 0.9 ? 'shake' : 'nub';
  if (topic.kind === 'question') return roll < 0.8 ? 'support_inbox' : 'nub';
  return roll < 0.62 ? 'support_inbox' : roll < 0.93 ? 'nub' : 'api';
}

export interface Row {
  ticket_id: string;
  requester_id: string;
  created_at: string;
  description: string;
  mrr: string;
  type: string;
  page: string;
  app_version: string;
  source: string;
  topic: string;
}

/**
 * Build the corpus.
 *
 * `endsAt` anchors the window so the newest report is "today" from the
 * generator's point of view; the seeder shifts again at load time so the demo
 * is fresh whenever it is first run.
 */
export function generate(seed = 20260909, endsAt = new Date('2026-09-09T12:00:00Z')): Row[] {
  const random = rng(seed);
  const accounts = buildAccounts(random);
  const rows: Row[] = [];

  for (const topic of TOPICS) {
    // ±20%, so volumes are not suspiciously round.
    const count = Math.max(3, Math.round(topic.volume * (0.8 + random() * 0.4)));

    for (let i = 0; i < count; i++) {
      const day = dayFor(topic.shape, random, topic);
      const account = pickAccount(accounts, topic.enterpriseBias, random);
      const phrasing = topic.phrasings[Math.floor(random() * topic.phrasings.length)] as string;

      const at = new Date(endsAt.getTime() - (WINDOW_DAYS - day) * 86_400_000);
      // Nudge into working hours, so timestamps do not all land at midnight.
      at.setUTCHours(7 + Math.floor(random() * 11), Math.floor(random() * 60), 0, 0);

      // Clamp: the hour nudge can push a report near the end of the window
      // past `endsAt`. A submission dated in the future gets a recency weight
      // above 1.0 and lands in a growth window it does not belong to, which
      // would quietly inflate whatever topic happened to be last.
      if (at.getTime() > endsAt.getTime()) at.setTime(endsAt.getTime() - 60_000);

      rows.push({
        ticket_id: '',
        requester_id: account.id,
        created_at: at.toISOString(),
        description: phrasing,
        mrr: String(account.mrr),
        type: topic.kind,
        page: topic.route,
        app_version: versionOn(day),
        source: pickSource(topic, random),
        topic: topic.id,
      });
    }
  }

  // Chronological, and only then numbered — a ticket id that did not increase
  // with time would look wrong to anyone who opened the file.
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  rows.forEach((row, i) => {
    row.ticket_id = `NW-${String(10_000 + i)}`;
  });

  return rows;
}

const COLUMNS: (keyof Row)[] = [
  'ticket_id',
  'requester_id',
  'created_at',
  'description',
  'mrr',
  'type',
  'page',
  'app_version',
  'source',
  'topic',
];

export function toCsv(rows: readonly Row[]): string {
  const escape = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  return [
    COLUMNS.join(','),
    ...rows.map((row) => COLUMNS.map((column) => escape(row[column])).join(',')),
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const rows = generate();
  const path = join(here, 'feedback.csv');
  writeFileSync(path, `${toCsv(rows)}\n`);

  const topics = new Set(rows.map((r) => r.topic));
  console.log(`\n  ${String(rows.length)} rows across ${String(topics.size)} topics → ${path}`);
  console.log(`  ${String(new Set(rows.map((r) => r.requester_id)).size)} accounts, ${String(WINDOW_DAYS)} days\n`);
}
