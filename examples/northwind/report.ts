/**
 * Run the real pipeline over Northwind's feedback and report what it found.
 *
 * ```
 * npm run northwind
 * ```
 *
 * Prints a README-ready summary and writes the figures to `docs/img/`. Every
 * number here comes from `quorum.issues()` — there is no arithmetic in this
 * file that the product does not already do, which is the only reason the
 * figures are worth putting in a README.
 *
 * **Synthetic data.** See `topics.ts`. This shows the pipeline running at
 * scale; it is not evidence that clustering is accurate, because the corpus
 * and the answer key were written by the same hand.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { ClusterIndex } from '../../packages/aggregate/src/cluster-index.ts';
import { accountWeight } from '../../packages/aggregate/src/rank.ts';
import { Quorum } from '../../packages/node/src/client.ts';
import { parseCsvRecords } from '../../packages/node/src/csv.ts';
import { DEFAULT_ONLINE_THRESHOLD } from '../../packages/node/src/issues.ts';
import type { Issue } from '../../packages/node/src/issues.ts';
import { hbar, text, THEMES, wrap, type Theme } from './chart.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const imgDir = join(repoRoot, 'docs/img');

/** Fixed, so every figure and every quoted number is reproducible. */
const NOW = new Date('2026-09-09T12:00:00Z');

const records = parseCsvRecords(readFileSync(join(here, 'feedback.csv'), 'utf8'));

const quorum = new Quorum({
  projectId: 'northwind',
  now: () => NOW,
  index: new ClusterIndex({ threshold: DEFAULT_ONLINE_THRESHOLD }),
});

const startImport = performance.now();
await quorum.import(
  records.map((r) => ({
    body: r['description'] as string,
    clientTs: r['created_at'] as string,
    id: r['ticket_id'] as string,
    kind: r['type'] as 'bug',
    source: r['source'] as 'support_inbox',
    user: { externalId: r['requester_id'] as string, traits: { mrr: r['mrr'] as string } },
    context: { route: r['page'] as string, appVersion: r['app_version'] as string },
  })),
  { source: 'support_inbox' },
);
const importMs = performance.now() - startImport;

const startRank = performance.now();
const issues = await quorum.issues({ now: NOW });
const rankMs = performance.now() - startRank;

/**
 * The same pipeline with revenue weighting switched off.
 *
 * A baseline of 10^12 drives `1 + log10(1 + mrr / baseline)` to 1.0 for every
 * account this side of a national economy, so recency, growth and unique-user
 * counting all still apply and *only* the revenue term is neutralised. That is
 * what makes the comparison below attributable: ranking by raw head count
 * instead would have folded recency and growth into a difference labelled as
 * revenue.
 */
const unweighted = await quorum.issues({ now: NOW, rank: { mrrBaseline: 1e12 } });

const submissions = await quorum.submissions();
const accounts = new Set(submissions.map((s) => s.userId));
const paying = new Set(submissions.filter((s) => (s.mrr ?? 0) > 0).map((s) => s.userId));

// ---------------------------------------------------------------------------
// Terminal summary
// ---------------------------------------------------------------------------

const line = (label: string, value: string): string => `  ${label.padEnd(26)}${value}`;

console.log('\nNorthwind Analytics — synthetic feedback, real pipeline\n');
console.log(line('submissions', String(submissions.length)));
console.log(line('accounts', `${String(accounts.size)} (${String(paying.size)} paying)`));
console.log(line('window', '120 days, 6 releases'));
console.log(line('issues found', String(issues.length)));
console.log(
  line('compression', `${(submissions.length / issues.length).toFixed(1)}× — ${String(submissions.length)} pieces of feedback into ${String(issues.length)} decisions`),
);
console.log(line('assign on write', `${importMs.toFixed(0)}ms for all ${String(submissions.length)}`));
console.log(line('rank + explain', `${rankMs.toFixed(0)}ms`));

console.log('\n  Top 10\n');
issues.slice(0, 10).forEach((issue, i) => {
  console.log(
    `  ${String(i + 1).padStart(2)}. ${issue.score.toFixed(2).padStart(6)}  ` +
      `${String(issue.uniqueUsers).padStart(3)} users  ${issue.title.slice(0, 58)}`,
  );
});

// ---------------------------------------------------------------------------
// Figure 1 — the ranked list
// ---------------------------------------------------------------------------

function rankedChart(theme: Theme, rows: Issue[]): string {
  const rowHeight = 30;
  const barHeight = 14;
  const labelWidth = 300;
  const left = 20 + labelWidth;
  const plot = 300;
  const top = 76;
  // 104, not 70: the widest label is `26.2  ·  24u` and it overflowed by 15px
  // at the old margin. Measured, not guessed.
  const width = left + plot + 104;
  const height = top + rows.length * rowHeight + 24;
  const max = Math.max(...rows.map((r) => r.score));

  const body: string[] = [];
  rows.forEach((issue, i) => {
    const y = top + i * rowHeight;
    // Darkest step to the top-ranked row: one hue, magnitude by lightness.
    const shade = theme.ramp[Math.min(theme.ramp.length - 1, Math.round((1 - i / rows.length) * (theme.ramp.length - 1)))] as string;
    const w = Math.max(2, (issue.score / max) * plot);

    body.push(text(20, y + barHeight - 2, `${String(i + 1)}. ${issue.title.slice(0, 44)}`, theme, { size: 11.5 }));
    body.push(hbar(left, y, w, barHeight, shade));
    // Direct label on every bar: no hover layer exists on GitHub, so the value
    // has to be on the mark.
    body.push(
      text(left + w + 8, y + barHeight - 2, `${issue.score.toFixed(1)}  ·  ${String(issue.uniqueUsers)}u`, theme, {
        size: 11,
        mono: true,
        fill: theme.muted,
      }),
    );
  });

  body.push(
    `<line x1="${String(left)}" y1="${String(top - 8)}" x2="${String(left)}" y2="${String(top + rows.length * rowHeight - 8)}" stroke="${theme.axis}" stroke-width="1"/>`,
  );

  return wrap(
    width,
    height,
    theme,
    'What Northwind should build next',
    `${String(submissions.length)} submissions → ${String(issues.length)} issues · weighted unique users × recency × growth`,
    body.join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Figure 2 — the regression
// ---------------------------------------------------------------------------

/** Weekly counts for the topic whose reports start at a release. */
function regressionSeries(): { week: number; count: number; label: string }[] {
  const start = new Date(NOW.getTime() - 120 * 86_400_000).getTime();
  const buckets = new Array<number>(17).fill(0);

  for (const record of records) {
    if (record['topic'] !== 'scan-crash-ios') continue;
    const week = Math.floor((Date.parse(record['created_at'] as string) - start) / (7 * 86_400_000));
    if (week >= 0 && week < buckets.length) buckets[week] = (buckets[week] as number) + 1;
  }

  return buckets.map((count, week) => ({
    week,
    count,
    label: week % 4 === 0 ? `wk ${String(week)}` : '',
  }));
}

function regressionChart(theme: Theme): string {
  const series = regressionSeries();
  const width = 700;
  const height = 260;
  const left = 44;
  const right = width - 20;
  const top = 76;
  const bottom = height - 34;
  const max = Math.max(4, ...series.map((s) => s.count));
  const step = (right - left) / series.length;
  const barWidth = Math.max(6, step - 6);

  const body: string[] = [];

  for (let i = 0; i <= 2; i++) {
    const value = Math.round((max / 2) * i);
    const y = bottom - (value / max) * (bottom - top);
    body.push(`<line x1="${String(left)}" y1="${String(y)}" x2="${String(right)}" y2="${String(y)}" stroke="${theme.grid}" stroke-width="1"/>`);
    body.push(text(left - 8, y + 4, String(value), theme, { anchor: 'end', size: 10.5, fill: theme.muted, mono: true }));
  }

  // The release the reports start at. A dashed rule and a label, because the
  // whole claim of the figure is that the two coincide.
  const releaseWeek = 71 / 7;
  const releaseX = left + releaseWeek * step;
  body.push(
    `<line x1="${String(releaseX.toFixed(1))}" y1="${String(top - 10)}" x2="${String(releaseX.toFixed(1))}" y2="${String(bottom)}" stroke="${theme.down}" stroke-width="2" stroke-dasharray="4 4"/>`,
  );
  body.push(text(releaseX + 6, top - 14, '4.12.0 ships', theme, { size: 11, weight: 600, fill: theme.down }));

  series.forEach((point, i) => {
    const x = left + i * step + 3;
    const h = (point.count / max) * (bottom - top);
    if (point.count > 0) body.push(hbar(x, bottom - h, barWidth, h, theme.ramp[4] as string));
    if (point.label !== '') {
      body.push(text(x + barWidth / 2, bottom + 16, point.label, theme, { anchor: 'middle', size: 10.5, fill: theme.muted }));
    }
  });

  body.push(`<line x1="${String(left)}" y1="${String(bottom)}" x2="${String(right)}" y2="${String(bottom)}" stroke="${theme.axis}" stroke-width="1"/>`);

  return wrap(
    width,
    height,
    theme,
    'A regression, and the release that caused it',
    'Weekly reports of the iOS capture crash. Nothing before 4.12.0; a wall of them after.',
    body.join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Figure 3 — revenue weighting
// ---------------------------------------------------------------------------

interface Move {
  title: string;
  byUsers: number;
  byWeight: number;
}

/**
 * Where each issue would sit ranked by head count, against where it sits once
 * account weight is applied.
 *
 * Both orderings come from the same issues; only the sort changes. That is the
 * honest comparison — recomputing the pipeline twice would confound the
 * weighting with clustering noise.
 */
function movements(weighted: Issue[], flat: Issue[]): Move[] {
  const flatRank = new Map(flat.map((issue, i) => [issue.id, i + 1]));

  return weighted.slice(0, 10).map((issue) => ({
    title: issue.title,
    byUsers: flatRank.get(issue.id) ?? weighted.length,
    byWeight: weighted.indexOf(issue) + 1,
  }));
}

function weightingChart(theme: Theme, moves: Move[]): string {
  const width = 700;
  const leftX = 250;
  const rightX = 470;
  const top = 86;
  const rowHeight = 26;
  // Sized from the deepest rank actually plotted, not from the row count. An
  // issue at #12 on the left and #8 on the right needs twelve rows of canvas,
  // and sizing by `moves.length` drew it below the bottom edge.
  const deepest = Math.max(...moves.flatMap((m) => [m.byUsers, m.byWeight]));
  const height = top + deepest * rowHeight + 20;

  const body: string[] = [];
  body.push(text(leftX, top - 18, 'every account equal', theme, { anchor: 'middle', size: 11, weight: 600, fill: theme.muted }));
  body.push(text(rightX, top - 18, 'weighted by revenue', theme, { anchor: 'middle', size: 11, weight: 600, fill: theme.muted }));

  const yFor = (rank: number): number => top + (rank - 1) * rowHeight;

  for (const move of moves) {
    const y1 = yFor(move.byUsers);
    const y2 = yFor(move.byWeight);
    const delta = move.byUsers - move.byWeight;
    // Polarity, so the diverging pair: blue rose, red fell, muted unchanged.
    const colour = delta > 0 ? theme.up : delta < 0 ? theme.down : theme.muted;
    const emphasis = delta === 0 ? 1.5 : 2;

    body.push(
      `<path d="M${String(leftX + 8)} ${String(y1)} C${String(leftX + 90)} ${String(y1)}, ${String(rightX - 90)} ${String(y2)}, ${String(rightX - 8)} ${String(y2)}" ` +
        `fill="none" stroke="${colour}" stroke-width="${String(emphasis)}" opacity="${delta === 0 ? '0.35' : '0.9'}"/>`,
    );
    body.push(`<circle cx="${String(leftX + 8)}" cy="${String(y1)}" r="4" fill="${colour}"/>`);
    body.push(`<circle cx="${String(rightX - 8)}" cy="${String(y2)}" r="4" fill="${colour}"/>`);

    body.push(text(leftX - 4, y1 + 4, `${String(move.byUsers)}. ${move.title.slice(0, 30)}`, theme, { anchor: 'end', size: 11 }));

    const sign = delta > 0 ? `▲ ${String(delta)}` : delta < 0 ? `▼ ${String(-delta)}` : '—';
    body.push(text(rightX + 12, y2 + 4, `${String(move.byWeight)}.`, theme, { size: 11, mono: true, fill: theme.primary }));
    // The arrow is the secondary encoding: direction never rides on hue alone.
    body.push(text(rightX + 36, y2 + 4, sign, theme, { size: 10.5, mono: true, fill: colour }));
  }

  return wrap(
    width,
    height,
    theme,
    'Revenue weighting reorders the list',
    'Same clustering and recency — only the revenue term changes.',
    body.join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

mkdirSync(imgDir, { recursive: true });
const top10 = issues.slice(0, 10);
const moves = movements(issues, unweighted);

for (const theme of THEMES) {
  const suffix = theme.name === 'dark' ? '-dark' : '';
  writeFileSync(join(imgDir, `northwind-ranked${suffix}.svg`), rankedChart(theme, top10));
  writeFileSync(join(imgDir, `northwind-regression${suffix}.svg`), regressionChart(theme));
  writeFileSync(join(imgDir, `northwind-weighting${suffix}.svg`), weightingChart(theme, moves));
}

// -------------------------------------------------------------------------
// What it gets wrong, which is the part worth publishing
// -------------------------------------------------------------------------

const topicOf = new Map(records.map((r) => [r['ticket_id'] as string, r['topic'] as string]));

/** Top-10 rows that are fragments of one true topic. */
const fragments = new Map<string, string[]>();
for (const issue of issues.slice(0, 10)) {
  const topics = issue.memberIds.map((id) => topicOf.get(id)).filter((t): t is string => t !== undefined);
  const counts = new Map<string, number>();
  for (const topic of topics) counts.set(topic, (counts.get(topic) ?? 0) + 1);

  const plurality = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (plurality === undefined) continue;
  fragments.set(plurality, [...(fragments.get(plurality) ?? []), issue.title]);
}

const split = [...fragments].filter(([, titles]) => titles.length > 1);

console.log('\n  What it gets wrong\n');
console.log(
  line('true topics', `${String(new Set(topicOf.values()).size)} — the generator knows; the pipeline does not`),
);
console.log(line('issues produced', `${String(issues.length)} (over-split by ${String(issues.length - new Set(topicOf.values()).size)})`));
for (const [topic, titles] of split) {
  console.log(`\n  "${topic}" reached the top 10 as ${String(titles.length)} separate rows:`);
  for (const title of titles) console.log(`      · ${title.slice(0, 62)}`);
}
console.log(
  '\n  Lexical clustering cannot merge paraphrases with no shared words.\n' +
    '  That is the gap embeddings exist to close, and it is why they are in v0.1.\n',
);

console.log('\n  Movement under revenue weighting\n');
for (const move of moves) {
  const delta = move.byUsers - move.byWeight;
  console.log(
    `  ${String(move.byUsers).padStart(3)} → ${String(move.byWeight).padStart(2)}  ` +
      `${delta > 0 ? `up ${String(delta)}` : delta < 0 ? `down ${String(-delta)}` : '  —'}   ${move.title.slice(0, 46)}`,
  );
}

console.log(`\n  6 figures written to docs/img/\n`);

const weight = (mrr: number): string => `$${String(mrr)}/mo → ×${accountWeight(mrr).toFixed(2)}`;
console.log('  account weight is logarithmic:');
for (const mrr of [0, 100, 1000, 10_000]) console.log(`    ${weight(mrr)}`);
console.log('');
