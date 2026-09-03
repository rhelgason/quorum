# 0011 — No public roadmap or end-user portal

**Status:** Accepted · 2026-09-02
**Amends:** [0003](0003-ship-the-ui-not-just-the-backend.md) (removes layer L3)

## Context

[0003](0003-ship-the-ui-not-just-the-backend.md) proposed five layers, with L3
a hosted public portal: a customer-branded page where *their end users* browse
submitted requests, upvote, and read a changelog. It's the most recognizable
feature in this product category and the most requested demo.

## Decision

Cut it. Layers are now L0 core, L1 primitives, L2 components, L3 server ingest
(renumbered from L4).

Quorum's dashboard is for the *team*. There is no surface where a customer's
end users browse a request list.

## Consequences

- **It's the least defensible thing we could build.** A public voting board is
  the commodity part of this category — it's a list with upvote buttons, and
  three open-source clones exist. Building it means competing on the axis where
  we're weakest instead of the one where we're strongest.
- **It actively fights the ranking model.** A public board turns prioritization
  into a popularity contest, which is precisely what
  [weighted ranking](0012-prioritization-is-the-product.md) exists to avoid.
  Once end users can see vote counts, the counts get gamed, brigaded, and
  treated as a promise. The weighted score is the honest signal, and it is not
  a number you can show end users without explaining that some of their votes
  count more than others.
- **It's a large surface with a distinct threat model.** Public pages mean
  custom domains, customer branding, SEO, moderation, spam, abuse reporting,
  and unauthenticated write endpoints. None of that shares code with the SDK
  or the aggregation pipeline.
- We lose the demo moment and a common RFP checkbox. Accepted.
- Loop closure survives without it: `issue_subscribers` still notifies the
  people who asked when something ships, and it does so by email/webhook —
  direct, and it doesn't require a page.
- Anyone who genuinely wants a public board can build one on the read API in a
  weekend. The endpoints are public and documented; that's the truly-headless
  promise doing its job.

## Reversal cost

Low. Nothing depends on it, and the read API already exposes what it would need.

## What would change our mind

Repeated, specific customer demand — and even then, prefer a reference
implementation in `examples/` over a hosted service we operate. The operational
and moderation burden is the real cost, not the UI.
