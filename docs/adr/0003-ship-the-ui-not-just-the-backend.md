# 0003 — Ship the UI, not just the backend

**Status:** Accepted · 2026-09-02

## Context

There's a real temptation to be "just the backend and the intelligence" — ship
an API and a clustering engine, let customers build their own capture UI. It's
less surface, no cross-browser work, no design system fights.

## Decision

Build and own the client. Ship UI at four layers (core → primitives →
components → hosted portal) with an escape hatch at every level.

## Consequences

**Backend-only is a trap, for two reasons.**

First, there's no moat. A feedback API is a Postgres table and a POST endpoint;
a competent team clones it in a weekend. The defensible engineering in this
product is almost entirely client-side — frustration detection, DOM
snapshotting, the element picker, log ring buffers, PII redaction, offline
queueing. Giving away the UI means giving away the product and keeping the
commodity.

Second, and less obvious but more durable: **every integration point is a
data-quality gate.** Customers building their own capture UI send inconsistent
metadata — some with route info, some without, different field names, no
version tagging. Clustering quality is downstream of capture consistency.
Owning the client is how we protect the aggregation layer, which is the *other*
differentiator.

**But the escape hatch is mandatory.** Any team with a real design system
rejects third-party components on sight, and those are exactly the
sophisticated customers we want. Hence layering:

| Layer | Package | Who |
| --- | --- | --- |
| L0 | `@quorum/core` | everyone, transitively |
| L1 | `@quorum/react` etc. | teams with a design system |
| L2 | `@quorum/web` | the default path |
| L3 | hosted portal | non-technical teams |
| L4 | `@quorum/node` | backends, no UI |

Most customers land on L2. **The existence of L1 is what stops L2 from being a
dealbreaker.** The read API is fully public so a customer can build a
completely custom roadmap UI and never touch our components.

The cost is real: cross-browser testing, a11y, i18n, design work, and a bundle
budget to defend — on top of the backend and the ML.

## Reversal cost

Low in one direction (we can always stop investing in L2/L3), high in the
other (retrofitting a client is a year of work and by then someone else owns
the wedge).

## What would change our mind

If customers consistently reach for L1 primitives over L2 components, the
styled layer is a demo asset rather than a product, and investment should shift
to primitives + the read API.
