# 0012 — Prioritization is the product; bug capture is an input

**Status:** Accepted · 2026-09-02
**Amends:** [0003](0003-ship-the-ui-not-just-the-backend.md),
[0005](0005-deterministic-core-llm-at-render-edge.md) (changes their sequencing,
not their substance)

## Context

The original framing led with bug capture — rage shake and the element picker
as the wedge, with aggregation as a later layer that "only becomes valuable at
volume." That produced a build order where ranking arrives in v0.4.

That ordering is wrong for what this is actually for. The question a team has
is *"what's important?"* — not *"what's broken?"* Bugs are one input among
feature requests, confusion, praise, and support tickets.

## Decision

**Quorum answers "what should we build next?"** Capture mechanisms are inputs
to that answer, not the headline.

Concretely:

- Ranking and structural grouping ship in **v0.1**, not v0.4. A team's first
  session must end with a ranked list, not a raw feed.
- The default submission kind is **not** `bug`. The nub asks what the user
  would change; reporting something broken is one path through the flow.
- `@quorum/node` (support-inbox and exception ingest) moves early. Most teams
  have years of signal already sitting in a support inbox, and importing it
  means a ranked list on day one instead of after six months of collection.
- Bug-specific capture (element picker, DOM snapshot, rage shake) stays
  first-class — but it's justified as *ranking signal*, not just as debugging
  evidence.

## Consequences

- **This does not weaken [0003](0003-ship-the-ui-not-just-the-backend.md).**
  The client is still where the defensible engineering is, and the argument is
  now stronger: every field the client captures automatically — route, app
  version, account weight, frustration intensity — is a ranking input that a
  plain feedback form cannot produce. Capture quality *is* prioritization
  quality. Owning the client is how ranking becomes trustworthy.
- **Aggregation can't hide behind "not enough volume."** A team with 200 items
  still doesn't know what's important. Structural grouping (route + version +
  temporal burst) answers that with zero ML, which is why it's v0.1 work.
  Semantic clustering improves the answer later; it doesn't gate having one.
- The demo changes shape. It's no longer "watch me shake my phone and get a
  screenshot" — it's "here are your top ten, here's why each ranks where it
  does, here's the evidence." The second is harder to demo and much harder to
  copy.
- Ranking explainability becomes load-bearing rather than nice-to-have. If the
  ranked list *is* the product, a user who can't see why item #3 is #3 has no
  reason to believe any of it. `issue_scores.components` stops being a debugging
  convenience and becomes a UI requirement.
- Risk we're accepting: the wedge is now a harder sell. "Rage shake, one line
  of code" is instantly legible; "we'll tell you what matters" is a claim that
  has to be proven with the customer's own data. Import-first
  (`@quorum/node`) is the mitigation — prove it on data they already have.

## Reversal cost

Low. This is a sequencing and emphasis decision; no interface changes.

## What would change our mind

If early users consistently install for bug capture and ignore the ranked list,
the market is telling us the wedge really is capture. Watch which surface gets
opened, not what people say in calls.
