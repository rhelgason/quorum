# 0021 — Machine-generated reports group by stack and underrank by design

**Status:** Accepted · 2026-09-03
**Refines:** [0020](0020-identity-is-never-guessed.md) (identity is never guessed)
**Amends:** [0012](0012-prioritization-is-the-product.md) (bugs are one input among many)

## Context

`captureException` puts backend crashes into the same canonical-issue store as
support tickets and widget submissions, so they cluster and rank against each
other. That is the whole argument for one store
([0012](0012-prioritization-is-the-product.md)) — but a crash differs from a
human submission in two ways that break the pipeline's assumptions.

**Its text is generated, and it embeds identifiers.** "Timeout after 30012ms
fetching order A-4471" and "Timeout after 28004ms fetching order B-9982" are
one defect that shares no distinguishing term. A bag-of-words clusterer makes
each occurrence a singleton, so a crash hitting thousands of users produces
thousands of clusters of one and never reaches the ranked list at all.

**Its volume is unbounded and not proportional to reach.** A retry loop
produces five thousand records from one broken deploy in an afternoon. A human
cannot do that.

## Decision 1 — group on the stack, keep the message verbatim

`body` stays exactly what was thrown, per the append-only rule in
`docs/DATA-MODEL.md`. Grouping reads two derived fields instead:

- **`fingerprint`** — the error class plus the top five normalized frames.
  Absolute paths reduce to a basename (`/app/src/cart.js` in a container,
  `/var/task/...` on Lambda, same file), line and column numbers are dropped
  (otherwise a defect changes identity when someone adds a comment above it),
  and runtime-internal frames are excluded (identical for every error ever
  thrown, so they only add false similarity). V8's synthetic frames — `at async
  Promise.all (index 0)` — are dropped too: the index varies with unrelated
  concurrency.
- **`clusterText`** — the scrubbed message plus the top two frames. Scrubbing
  replaces uuids, hashes, timestamps, hex, and identifier-shaped tokens with
  placeholders. The frames are appended because two unrelated defects can share
  a generic message ("Request failed") and only the throw site tells them apart.

`clusterText` defaults to `body` for everything else. Human feedback is never
scrubbed.

## Decision 2 — an unattributed crash counts once per defect per day

There is no correct answer here, only a choice of which way to be wrong.

One key per defect: a crash hitting five thousand users counts as one user and
sits at the bottom. One key per occurrence: a retry loop counts as five
thousand users and owns the top of the roadmap. Both are wrong. They are not
equally wrong.

**We bucket per defect per calendar day.** A bug present for three weeks
accrues twenty-one units of demand; a retry storm inside one afternoon accrues
one. Volume within a day is discarded on purpose, because a machine can
generate unbounded volume and a human cannot, and a ranked list a machine can
inflate is worth nothing.

The bias is toward underranking, chosen deliberately. A crash that ranks too
low still gets corrected by the humans who file about it. A retry loop at
position one is unrecoverable garbage that discredits the entire list, and
discrediting the list is the only unrecoverable failure this product has.

None of this applies when the caller passes `user` — real attribution beats
every heuristic here, and `captureException(err, { user })` is the documented
path.

## Consequences

- A high-volume crash with no attribution will rank below a feature request
  with a handful of identified users. That is intended and it is stated in the
  API docs rather than hidden.
- Day bucketing keys on `clientTs`, so a backfill of historical exceptions
  spreads across real days instead of collapsing into the import date.
- Fingerprinting is heuristic. Two genuinely different bugs sharing a top frame
  will merge; a stack that changes shape across runtimes will split. Neither is
  silent — `fingerprint` is on the record and inspectable.
- Exceptions with no stack fall back to the scrubbed message. Weaker, but it
  still groups occurrences a raw message never would.

## Reversal cost

Low. Both are derived fields computed at write time, so changing the rules
means recomputing `clusterText` and `fingerprint` over stored rows — the
verbatim `body` is untouched and nothing is lost.

## What would change our mind

Session-level attribution reaching the server. If ingest can see a real session
or user id on the request that threw, the day bucket becomes unnecessary and
crashes should rank on genuine reach. That is the right answer; it needs the
ingest service, which does not exist yet.
