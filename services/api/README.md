# @quorum/api

Ingest and the read API. Zero runtime dependencies — `node:http`, and nothing
else.

```bash
npm run serve
QUORUM_DATA=./data/quorum.jsonl QUORUM_PORT=8787 npm run serve
```

```
POST /v0/ingest                  the capture protocol, batched
GET  /v0/issues?limit=20         ranked, with score components and quotes
GET  /v0/issues/:id              one issue
GET  /v0/issues/:id/submissions  the verbatim evidence
GET  /v0/health
```

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `QUORUM_PORT` | `8787` | |
| `QUORUM_DATA` | `./data/quorum.jsonl` | Append-only log |
| `QUORUM_PROJECT` | `default` | Project scope for stored submissions |
| `QUORUM_PROJECT_KEY` | — | When set, an envelope naming a different project gets `401` |
| `QUORUM_FSYNC` | — | `1` to fsync every append |
| `QUORUM_ALLOW_ORIGIN` | `*` | Set this before exposing the read API |

The path `/v0/ingest` is pinned in
[`docs/PROTOCOL.md`](../../docs/PROTOCOL.md#endpoints) and shared with the
client as `INGEST_PATH` in `@quorum/core`. It was wrong for a week — the
browser transport posted to `/v0/events` — and nothing caught it, because no
test had ever put a real client and this server on one socket.
[`src/roundtrip.test.ts`](src/roundtrip.test.ts) now does.

## The status codes are the contract

[`docs/PROTOCOL.md`](../../docs/PROTOCOL.md) publishes an error table that every
SDK's retry logic is written against. Returning the wrong code doesn't produce
an error here — it produces a client that loops forever, or one that silently
discards a user's feedback.

| Code | When | What a client does |
| --- | --- | --- |
| `202` | Accepted, with `{ accepted, duplicate }` | Dequeue both lists |
| `400` | Malformed envelope, bad version, unparseable timestamp | **Drop permanently** |
| `401` | Project key mismatch | Disable for the session |
| `413` | Body over `maxBodyBytes` | Strip the capture, retry the envelope |
| `405` | Wrong method | — |
| `429` | Over the write rate limit, with `Retry-After` | Wait exactly that long, then retry |
| `500` | Anything unanticipated | Back off and retry |

A duplicate is `202`, not an error. It is what the client's idempotency key
exists to make safe, and treating a replayed offline flush as a failure would
make the queue look broken every time it worked.

### The write path is rate limited; the read path is not

A sliding window, 120 writes per minute per address by default, applied before
the body is parsed — a limiter that first parses the payload it is about to
reject is doing the work an attacker wanted done. The response carries
`Retry-After` in whole seconds (rounded **up**, because `Retry-After: 0` reads
as "retry immediately") and the exact milliseconds in the body, so a client can
use either.

This closed a hole that was client-side-only: `@quorum/core`'s transport has
always implemented the `429` row in full, parsing `Retry-After` in both seconds
and HTTP-date form, and no server had ever sent one. That retry path is now
exercised against a real server in
[`src/roundtrip.test.ts`](src/roundtrip.test.ts).

**Reads are not limited.** They are the expensive ones — clusters are
recomputed per request — but they are not the untrusted surface: the write key
is public by design and ships in every page that loads the widget. Limiting
reads needs its own key and its own number, and guessing at both is worse than
leaving it off and saying so here.

**The counters are per process.** Two instances behind a load balancer each
enforce the limit separately. Sharing them means Redis or the database, and
neither is in this service yet.

## Persistence: honest about what it is

`FileStore` is an append-only JSONL log, not Postgres.
[`docs/DATA-MODEL.md`](../../docs/DATA-MODEL.md) still specifies Postgres +
pgvector and that is still the target; there was no database available, and a
half-mocked one would be worse than a real simpler thing.

It is a real simpler thing: it survives restarts, it is inspectable with
`tail`, it deduplicates on `(projectId, id)` across restarts, and a line
truncated by a crash mid-append is skipped rather than preventing startup
forever.

Append-only isn't a limitation here — it's the data model. DATA-MODEL's
organizing rule is that submissions are immutable facts and canonical issues
are mutable interpretations. A file you only append to enforces the first half
at the storage layer, which is stronger than an `UPDATE` you have merely
promised not to write.

**What it is not:** safe across concurrent processes, indexed for anything but
id lookup, or suitable for a million rows — the whole log lives in memory. The
`SubmissionStore` interface is the seam, so swapping in Postgres is a new class
rather than a rewrite of anything above it.

## Clusters are assigned on write

They used to be recomputed on every read, which cost O(corpus) per request and
— because the IDF table shifts as the corpus grows — meant a recompute could
move an assignment a reader had already seen. A ranked list that quietly
reorganises between two page loads is not one anybody trusts.

Now `ClusterIndex` assigns each submission once, at ingest, and a read ranks
stored groups. A write is O(clusters); a read no longer re-derives anything.

**The index is rebuilt by replaying the log at boot, not persisted beside it.**
The replay is exact rather than approximate — leader-follower is deterministic,
term statistics evolve identically, and an append-only log preserves order — so
it produces the assignments ingest originally made, member for member. That
removes an entire category of bug: a persisted index is a second copy of
derived state that can be stale, truncated, or written by a build with
different defaults, and each of those shows up as a ranked list that is subtly
wrong with nothing to compare it against. A rebuilt one cannot disagree with
the log, because it *is* the log.

The cost is a pass over the corpus at startup. For thousands of submissions
that is milliseconds. `ClusterIndex.toJSON()` exists and is tested for when it
stops being — the change is then to load it and replay only the tail.

Set `QUORUM_THRESHOLD` to override the online assignment threshold. Offline
consolidation still runs per read; that tier is where over-splitting is
repaired ([ADR-0018](../../docs/adr/0018-two-tier-clustering-validated.md)) and
it is cheap because it works over clusters rather than submissions.

## The real remaining gap

**Not Postgres, and no pgvector.** Everything above still lives in one process
with a JSONL log behind it.

That, plus pgvector for embeddings, is what `canonical_issues` in DATA-MODEL is
for and what remains genuinely unbuilt.

Also not here: presigned capture upload, webhooks, and any authentication
beyond the optional project key.
