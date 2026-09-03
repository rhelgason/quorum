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
| `500` | Anything unanticipated | Back off and retry |

A duplicate is `202`, not an error. It is what the client's idempotency key
exists to make safe, and treating a replayed offline flush as a failure would
make the queue look broken every time it worked.

`429` is not implemented — there is no rate limiter. That is a real gap in
front of an untrusted internet.

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

## The real remaining gap

**Clusters are still recomputed on every read.** This service persists
*submissions*, not *cluster assignments*, so `GET /v0/issues` runs the whole
pipeline each time. Two consequences:

- Cost is O(corpus) per request rather than O(new submissions). Fine for a
  self-host with thousands of items; not fine beyond that.
- Cluster ids are stable as feedback is appended, because leader-follower never
  reassigns and insertion order is preserved — but the IDF table shifts as the
  corpus grows, so a full recompute can move an early assignment. That is the
  churn ADR-0005 warns about, and write-time assignment with persisted
  centroids is what actually fixes it.

That, plus pgvector for embeddings, is what `canonical_issues` in DATA-MODEL is
for and what remains genuinely unbuilt.

Also not here: presigned capture upload, webhooks, and any authentication
beyond the optional project key.
