# @quorum/node

Server-side ingest and the read API for [Quorum](../../README.md). Zero runtime
dependencies.

No UI, and the fastest path to value: point it at a support inbox and get a
ranked list out of feedback you already have, without installing a widget.

> **Status: working, not publishable.** Every path below runs and is tested.
> The package is `private` because it is a client for an ingest service that
> does not exist yet — see [Why this isn't published](#why-this-isnt-published).

## The claim, in one snippet

```ts
import { Quorum } from '@quorum/node'

const quorum = new Quorum({ projectId: 'acme-web' })

await quorum.importCsv(await readFile('zendesk-export.csv', 'utf8'), {
  source: 'support_inbox',
})

const issues = await quorum.issues({ now: new Date(), limit: 10 })

for (const issue of issues) {
  console.log(issue.title)          // a verbatim user sentence, no LLM
  console.log(issue.explanation)    // "14 users, 22 submissions, demand 9.31, growth ×1.8 (9→ from 5)"
  console.log(issue.quotes)         // the evidence, drillable
}
```

Column names are auto-detected from what real exports actually use
(`description`/`body`/`text`, `created_at`/`date`, `requester_id`/`customer_id`,
`mrr`, `page`, `type`), and overridable per field.

## Four ways in, one store

| Method | For |
| --- | --- |
| `capture(input)` | One piece of feedback your backend can see — a ticket, a call note, an NPS comment |
| `captureException(err, opts)` | A thrown error, grouped by stack |
| `import(rows)` / `importCsv(text)` | Bulk historical load |
| `ingest(envelope)` | The server side of [PROTOCOL.md](../../docs/PROTOCOL.md) — batched events from a web or mobile SDK |

They converge on the same `Submission` record and the same store on purpose: a
support ticket, a backend crash, and a widget submission about the same thing
are **one** issue, not three products.

## What it will refuse to do

Most of the design here is about failures that produce a confidently wrong
ranked list rather than an error. Those are the expensive ones — nothing
downstream can detect them.

**It will not invent a user identity.** Ranking counts unique users so that one
person filing twenty tickets cannot outrank twenty people filing once. A random
id per unattributed record turns that into submission counting silently. So an
unattributed record needs an explicit policy — `'error'`, `'per-record'`,
`'per-day'`, or a fixed key — and the caller has to mean it
([ADR-0020](../../docs/adr/0020-identity-is-never-guessed.md)).

**It will not default a timestamp on import.** `clientTs` is required per row.
Stamping an import with the wall clock makes a five-year backlog look like it
arrived this morning: every item maximally recent, the whole corpus reading as
one enormous growth spike.

**It will not accept a ragged CSV row.** A stray unescaped quote shifts every
column, and the result is a successful import where `body` holds timestamps.
A row whose field count disagrees with the header is an error naming the row.

**It will not let a retry loop own the roadmap.** Unattributed exceptions
bucket per defect per day, so machine-generated volume cannot inflate the list
([ADR-0021](../../docs/adr/0021-unattributed-reports-underrank.md)).

## Idempotency

Ids not supplied are derived from content, so re-running an import is a no-op
rather than a silent doubling of every issue's evidence. Replayed protocol
envelopes come back as `duplicate`, which the wire contract treats as success.

```ts
await quorum.importCsv(csv)  // { total: 400, inserted: 400, duplicate: 0 }
await quorum.importCsv(csv)  // { total: 400, inserted: 0,   duplicate: 400 }
```

## The read pipeline

`issues()` is a pure function over the store: cluster → consolidate → label →
rank → explain. It takes an explicit `now` and never reads the system clock,
because a ranked list you cannot reproduce is one you cannot defend when a
customer disputes it.

Defaults follow [ADR-0018](../../docs/adr/0018-two-tier-clustering-validated.md):
a **high** online threshold (0.25) with **aggressive** offline consolidation
(0.03), rather than one carefully-balanced number. These are a starting point,
not tuned values — adjacent cells in that ADR's table swing between 3/10 and
6/10 on synthetic data. Sweep them against your own corpus.

Embeddings are supported (`Submission.embedding` + `semanticWeight`) but
nothing here populates them. Wiring the `@quorum/aggregate` embedder into
ingest is still open, as is measuring a real model
([ADR-0019](../../docs/adr/0019-embedding-quality-bar.md)).

## Not implemented

- **Persistence.** `MemoryStore` is the only store. The interface is
  Postgres-shaped — async, project-scoped, idempotent on `(projectId, id)` — so
  the swap is a new class, not a rewrite.
- **Cluster identity across runs.** Clusters are recomputed on read. Insertion
  order is stable and leader-follower never reassigns, so ids are stable as
  feedback is appended — but the IDF table shifts as the corpus grows, which
  can move an early assignment on a full recompute. Assignment at write time
  fixes it and belongs to the ingest service.
- **Webhooks** (`issue.ranked`, `issue.shipped`) and the write-side
  Jira/Linear/GitHub integration. That's v0.5.
- **Captures.** Envelope `captureRef` is accepted; blob upload is not.

## Why this isn't published

It imports `@quorum/core` and `@quorum/aggregate` sources by deep relative
path. That is what lets `node --test` run the whole package with an empty
`node_modules`, and it is illegal across TypeScript project references — so the
package is `noEmit` and outside the build graph, exactly like
[`@quorum/eval`](../eval/README.md). See
[TESTING.md](../../docs/TESTING.md).

It flips to a composite build when the ingest service it fronts exists.
Publishing an SDK for a service that doesn't exist would be shipping a client
to nowhere, so there is nothing lost by waiting.
