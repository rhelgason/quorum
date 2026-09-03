/**
 * The v0.1 claim, executable.
 *
 * ```
 * npm run demo
 * ```
 *
 * Imports a support-inbox CSV export through the real `@quorum/node` API and
 * prints the ranked backlog it produces. No widget, no database, no LLM, no
 * network — and nothing in here is a mock: it is the same code path a customer
 * would run against their own export.
 *
 * Console plumbing only. Every number printed comes from `quorum.issues()`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Quorum } from '../../packages/node/src/index.ts';
import type { Issue } from '../../packages/node/src/index.ts';

/** Fixed clock, so the demo output is identical on every run. */
const NOW = '2026-09-01T00:00:00Z';

const here = dirname(fileURLToPath(import.meta.url));

// Respect NO_COLOR, and drop styling when piped to a file.
const styled = process.env['NO_COLOR'] === undefined && process.stdout.isTTY === true;
const bold = (s: string): string => (styled ? `\u001b[1m${s}\u001b[0m` : s);
const dim = (s: string): string => (styled ? `\u001b[2m${s}\u001b[0m` : s);
const cyan = (s: string): string => (styled ? `\u001b[36m${s}\u001b[0m` : s);

function heading(text: string): void {
  console.log(`\n${bold(text)}\n${dim('─'.repeat(text.length))}`);
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function printIssue(issue: Issue, position: number): void {
  const rank = String(position).padStart(2);
  const score = issue.score.toFixed(2).padStart(6);
  console.log(`\n ${bold(`${rank}.`)} ${dim(`[${score}]`)} ${cyan(issue.title)}`);
  console.log(`      ${dim(issue.explanation)}`);

  const kinds = Object.entries(issue.kinds)
    .map(([kind, count]) => `${kind} ×${String(count)}`)
    .join(' · ');
  const route =
    issue.topRoute === undefined
      ? ''
      : ` · ${issue.topRoute.route} (${Math.round(issue.topRoute.share * 100)}% of members)`;
  console.log(`      ${dim(`${kinds}${route}`)}`);

  console.log(`      ${dim('evidence:')}`);
  for (const quote of issue.quotes) {
    const marker = quote.isLabel ? '▸' : ' ';
    console.log(`      ${marker} ${dim(`"${quote.body}"`)}`);
    console.log(`        ${dim(`  ${quote.submissionId} · ${day(quote.clientTs)} · ${quote.source}`)}`);
  }
}

const quorum = new Quorum({ projectId: 'acme-web' });

// ---------------------------------------------------------------------------
// 1. Import feedback the team already has
// ---------------------------------------------------------------------------

const csv = readFileSync(join(here, 'inbox.csv'), 'utf8');
const imported = await quorum.importCsv(csv, { source: 'support_inbox' });

heading('1. Import');
console.log(`\n  ${String(imported.inserted)} tickets imported, ${String(imported.duplicate)} duplicates`);

// Re-running proves idempotency rather than asserting it: a weekly export that
// someone regenerates must not double every issue's evidence.
const rerun = await quorum.importCsv(csv, { source: 'support_inbox' });
console.log(`  re-running the same export: ${String(rerun.inserted)} inserted, ${String(rerun.duplicate)} duplicate`);

const stored = await quorum.submissions();
const customers = new Set(stored.map((s) => s.userId)).size;
const dates = stored.map((s) => s.clientTs).sort();
console.log(
  `  ${dim(`${String(customers)} unique customers · ${day(dates[0] ?? '')} → ${day(dates[dates.length - 1] ?? '')}`)}`,
);

// ---------------------------------------------------------------------------
// 2. Everything else lands in the same store
// ---------------------------------------------------------------------------

heading('2. Other inputs, same canonical-issue store');

// Backend exceptions. Grouped by stack, not by message, so the varying order
// id and duration do not make every occurrence its own issue — and because
// none of them is attributed to a user, all three share one day bucket and
// count once, rather than three retries out-voting a human.
const crashes: [string, string][] = [
  ['A-4471', '2026-08-30T10:00:04Z'],
  ['B-9982', '2026-08-30T10:41:22Z'],
  ['C-1120', '2026-08-30T15:07:51Z'],
];
for (const [orderId, at] of crashes) {
  await quorum.captureException(new Error(`Timeout after 30012ms fetching order ${orderId}`), {
    context: { route: '/api/checkout', platform: 'server' },
    clientTs: at,
  });
}

// A widget submission arriving over the wire protocol.
await quorum.ingest({
  v: 0,
  sentAt: NOW,
  project: 'pk_live_demo',
  events: [
    {
      id: '01J8Z9QK4T0000000000000001',
      kind: 'feature_request',
      source: 'nub',
      clientTs: '2026-08-31T18:00:00Z',
      body: 'dark mode would be amazing, please add dark mode',
      user: { externalId: 'cust_061', traits: { plan: 'pro', mrr: 320 } },
    },
  ],
});

console.log('\n  + 3 backend exceptions (captureException)');
console.log('  + 1 widget submission over the capture protocol (ingest)');
console.log(`  ${dim('all four inbound paths write the same Submission record')}`);

// ---------------------------------------------------------------------------
// 3. The ranked backlog
// ---------------------------------------------------------------------------

const issues = await quorum.issues({ now: NOW, limit: 8, quotesPerIssue: 3 });

heading(`3. Ranked backlog — top ${String(issues.length)}, as of ${day(NOW)}`);
issues.forEach((issue, i) => {
  printIssue(issue, i + 1);
});

// ---------------------------------------------------------------------------
// 4. What this does not do yet
// ---------------------------------------------------------------------------

heading('4. What the offline tier buys, and what it costs');

// The two-tier split from ADR-0018, measured on this corpus rather than
// asserted: a high online threshold fragments, and the offline pass repairs it.
const split = await quorum.issues({ now: NOW, consolidate: false });
const merged = await quorum.issues({ now: NOW });

const biggest = (list: readonly Issue[]): number =>
  list.reduce((max, issue) => Math.max(max, issue.uniqueUsers), 0);

console.log(`\n  online pass only          ${bold(String(split.length).padStart(3))} issues`);
console.log(`  + offline consolidation   ${bold(String(merged.length).padStart(3))} issues`);
console.log(
  `\n  ${dim(`Largest issue goes from ${String(biggest(split))} unique users to ${String(biggest(merged))}. Fragmentation is what`)}\n` +
    `  ${dim('destroys a ranked list: four pure fragments of one issue divide its')}\n` +
    `  ${dim('demand by four and drop every piece off the top ten (ADR-0014).')}`,
);

// The cost, stated rather than hidden. Aggressive average linkage pulls in
// low-information singletons that share incidental vocabulary.
const impure = merged.filter((issue) => Object.keys(issue.kinds).length > 1);
if (impure.length > 0) {
  console.log(`\n  ${dim('The cost — issues that absorbed something unrelated:')}\n`);
  for (const issue of impure) {
    const kinds = Object.entries(issue.kinds)
      .map(([kind, count]) => `${kind} ×${String(count)}`)
      .join(', ');
    console.log(`    · ${issue.title.slice(0, 52)}`);
    console.log(`      ${dim(kinds)}`);
  }
  console.log(
    `\n  ${dim('ADR-0018 proposed maxSizeRatio as the guard for exactly this. On this')}\n` +
      `  ${dim('corpus it does not help: capping the ratio changes greedy merge order')}\n` +
      `  ${dim('and produces a worse list, splitting dark-mode and pulling praise into')}\n` +
      `  ${dim('the dashboard cluster. Left at the default, and flagged for the sweep.')}`,
  );
}

heading('How the numbers were produced');
console.log(
  `\n  ${dim('No LLM, no network, no model of any kind. Titles are the medoid')}\n` +
    `  ${dim('submission — a real sentence a real user wrote. Every score decomposes')}\n` +
    `  ${dim('into unique users × account weight × recency decay × growth, and every')}\n` +
    `  ${dim('row drills down to the verbatim feedback behind it.')}\n`,
);
