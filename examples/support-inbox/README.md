# Support-inbox demo

The v0.1 claim, executable:

```bash
npm run demo      # no install required
```

A team exports their support inbox, pipes it through
[`@quorum/node`](../../packages/node/README.md), and gets a defensible top ten
back. No widget, no database, no LLM, no network.

Nothing here is a mock. It calls the same public API a customer would, on a CSV
with the column names real helpdesk exports actually use.

## What it demonstrates

**Import, and re-import.** 45 tickets land; running the identical export a
second time inserts 0 and reports 45 duplicates. Ids are derived from content,
so the weekly re-export someone regenerates doesn't quietly double every
issue's evidence ([ADR-0020](../../docs/adr/0020-identity-is-never-guessed.md)).

**Four inbound paths, one store.** The demo adds three backend exceptions and
one widget submission over the wire protocol on top of the import. The widget
submission clusters straight into the dark-mode issue alongside support
tickets — which is the entire argument for one canonical-issue store.

**A ranked list with its reasoning attached.** Every row carries its component
breakdown, a one-line explanation, and the verbatim quotes behind it. Titles
are the medoid submission: a real sentence a real user wrote, no generation
involved.

**Ranking opinions, visible.** The slow-dashboard cluster tops the list on
growth (`×1.50`, 6 users this week from 4 the week before), not raw volume. The
SAML SSO cluster reaches #3 on 3 users because their average account weight is
2.82 — revenue orders the list without dominating it
([ADR-0015](../../docs/adr/0015-log-scaled-account-weight.md)). Praise never
appears in the build list.

**Exceptions that behave.** Three crashes with different order ids in the
message group into one issue on their stack, and count as one user because none
was attributed — a retry loop can't out-vote a human
([ADR-0021](../../docs/adr/0021-unattributed-reports-underrank.md)).

## The part that isn't flattering

Section 4 of the output measures the offline consolidation tier both ways on
this corpus: **17 issues without it, 8 with it**, and the largest issue goes
from 6 unique users to 10. Fragmentation is what destroys a ranked list, so
that is the tier earning its complexity.

It also prints what that costs — two clusters that absorbed an unrelated
singleton, visible as a mixed `kinds` breakdown (a praise ticket inside "mobile
app crashes"). Aggressive average linkage pulls in low-information items that
share incidental vocabulary.

[ADR-0018](../../docs/adr/0018-two-tier-clustering-validated.md) proposed
`maxSizeRatio` as the guard for exactly this. **Measured here, it does not
help** — capping the ratio changes greedy merge order and yields a worse list,
splitting the dark-mode cluster and pulling a praise item into the dashboard
cluster instead. Left at the default and flagged for a proper sweep rather than
tuned against 46 rows.

## About this data

`inbox.csv` is **written, not collected** — 45 rows across five themes with
plausible dates, MRR values, and phrasing. It is illustrative, not evidence.
The same caveat that governs `packages/eval` applies harder here: it validates
that the implementation works end to end, not that the approach is right on
real feedback.

The clock is fixed at `2026-09-01`, so the output is byte-identical on every
run.

If you have a real export, that's the interesting experiment:

```ts
const quorum = new Quorum({ projectId: 'your-project' })
await quorum.importCsv(yourCsv, { source: 'support_inbox' })
console.log(await quorum.issues({ now: new Date(), limit: 10 }))
```

Columns are auto-detected (`description`/`body`/`text`, `created_at`/`date`,
`requester_id`/`customer_id`, `mrr`, `page`, `type`) and overridable per field.
If your export has no user column, you'll be asked to say what an unattributed
row means rather than have it guessed — `{ unattributed: 'per-record' }` is
usually right for a ticket export.
