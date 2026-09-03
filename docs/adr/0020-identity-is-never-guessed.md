# 0020 — Identity is never guessed, and ingest is idempotent by derived id

**Status:** Accepted · 2026-09-03
**Refines:** [0012](0012-prioritization-is-the-product.md) (prioritization is the product), [0015](0015-log-scaled-account-weight.md) (unique users, not submissions)

## Context

`@quorum/node` opens three new write paths — a single `capture`, a bulk
`import`, and a protocol `ingest` — and each one can be handed a record with no
identifiable user. A support-inbox export often has no customer column at all.

The temptation is a random id per unattributed record. It makes every call
succeed and every test pass.

It is also the most damaging bug available to this codebase. Ranking counts
*unique users* precisely so that one motivated person filing twenty tickets
cannot outrank twenty people filing once
([0015](0015-log-scaled-account-weight.md), Opinion 3). A random id per record
makes every record its own user, so unique-user counting silently becomes
submission counting. Nothing throws. No test fails. The ranked list is simply
wrong, in exactly the way the design exists to prevent, and it is wrong in a
way no downstream check can detect.

The second failure is adjacent. A support export is a file someone regenerates
— weekly, or twice because the first run looked wrong. With random ids the
re-run inserts a parallel copy of every ticket under new ids. Unique-user
counting holds the score steady, which is worse than an obvious break: member
counts and evidence quotes double while the number a PM reads looks fine.

## Decision 1 — there is no automatic fallback identity

`resolveUserId` takes an explicit fallback key and throws on an empty one.
Every caller must state what an unattributed record *means*:

| Policy | Meaning | Correct when |
| --- | --- | --- |
| `error` | Refuse the record | The caller should know who this is |
| `per-record` | Each record is a distinct user | A ticket export where each row is a different customer |
| `per-day` | One bucket per calendar day | Machine-generated volume, see [0021](0021-unattributed-reports-underrank.md) |
| `{ key }` | One fixed bucket | A legacy blob nobody can attribute |

Defaults differ per path, and each is argued rather than inherited:
`capture` and `import` default to `error` (a backend integration knows whose
ticket it is, and a bulk load is the worst place to guess); `ingest` defaults
to `per-day`, because a wire event that lost its anon id to cleared storage is
still real feedback and the protocol does not consider it malformed.

`externalId` beats `anonId`, and the two live in separate key namespaces so an
`anonId` that happens to equal someone's `externalId` cannot merge two people.

## Decision 2 — ids are derived from content when not supplied

`derivedId` hashes project, source, resolved user, client timestamp, and body.
A re-run collides with the first run and is dropped as the duplicate it is.

The timestamp is in the hash deliberately: the same user writing the same
sentence months apart is two pieces of feedback, and re-filing should make
someone more recent rather than louder. Components are joined with a separator
so `['ab','c']` and `['a','bc']` cannot collide.

FNV-1a over two offset bases, not a cryptographic hash. Nothing here is
adversarial — it needs collisions rarer than the data, and `node:crypto` would
tie the file to a runtime the rest of the pipeline does not require.

## Consequences

- Importing an inbox with no user column now requires one line of intent
  (`unattributed: 'per-record'`) instead of working silently. That friction is
  the point; it is a question only the caller can answer.
- `per-record` is still wrong if one person filed twice in the export. It is
  documented as such. Correctly resolving that needs a user column, not a
  cleverer default.
- Import re-runs are safe, so an interrupted import can simply be re-run. That
  is what lets `import` validate the whole batch before writing anything.
- A caller supplying its own `id` bypasses derivation entirely and owns
  idempotency itself.

## Reversal cost

Low for the policy enum — adding a mode is additive. High for the derived-id
scheme once data exists: changing what goes into the hash makes every existing
record un-matchable, so a re-import would duplicate the entire corpus exactly
once. Treat the hash inputs as a wire format.

## What would change our mind

A real customer export where `per-record` measurably distorts a list — many
tickets per person and no id to join on. The fix would be fuzzy identity
resolution on email or name, which is a real feature and not a default.
