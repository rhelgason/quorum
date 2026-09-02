# 0001 — Record architecture decisions

**Status:** Accepted · 2026-09-02

## Context

Quorum's shape was argued out in conversation before any code existed, and
several of those decisions look arbitrary from the outside (why not
`getDisplayMedia`? why not k-means? why build UI at all?). Without a record,
the reasoning is lost and someone — plausibly us, in six months — reverses a
decision without knowing what it cost.

Several of these choices are also load-bearing for each other. "Redact by
default" is only affordable because we serialize the DOM rather than capture
pixels. "BYO-model" is only possible because the clustering core is
deterministic. Those dependencies are invisible in code.

## Decision

Keep numbered, immutable ADRs in `docs/adr/`. One decision per record.
Accepted records are never edited — they're superseded by a new record.

Each records not just the decision but **what would make us change our mind**,
so a future reversal is a judgment about evidence rather than a rediscovery
from scratch.

## Consequences

- Every non-obvious architectural choice costs ~15 minutes of writing.
- Onboarding and outside contributors get the reasoning, not just the result —
  which matters disproportionately for an open-core project.
- Reversals become deliberate and visible in git history.

## Reversal cost

Trivial. Stop writing them.
