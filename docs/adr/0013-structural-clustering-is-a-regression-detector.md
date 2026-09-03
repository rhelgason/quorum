# 0013 — Structural clustering is a regression detector, not a ranker

**Status:** Accepted · 2026-09-02
**Amends:** [0012](0012-prioritization-is-the-product.md) (corrects a v0.1 assumption)
**Evidence:** [`packages/eval`](../../packages/eval/README.md)

## Context

[ADR-0012](0012-prioritization-is-the-product.md) moved ranking into v0.1 on
the strength of a claim made without evidence:

> If we shipped only route + version + burst clustering with no text analysis
> at all, we'd have something useful. That is v1.

The eval harness now exists, so the claim is testable. It does not hold in the
form it was stated.

## Evidence

Measured on the 161-item labeled corpus, structural clustering
(route + platform + version + time bucket, no text analysis):

| Slice | items | ARI | pairwise F1 | precision | recall |
| --- | --- | --- | --- | --- | --- |
| **All submissions** | 161 | 0.092 | 0.110 | 0.132 | 0.094 |
| Bugs only | 52 | 0.340 | 0.365 | 0.568 | 0.269 |
| **Release-burst clusters** | 17 | 0.547 | 0.633 | **1.000** | 0.463 |
| **Feature requests only** | 86 | 0.023 | 0.046 | 0.083 | 0.032 |

Overall ARI of 0.09 is barely distinguishable from chance. But the aggregate
hides two different methods wearing one name.

## Decision

Treat structural clustering as a **high-precision regression detector**, and
stop treating it as the v0.1 ranking mechanism.

Concretely:

- Ship it in v0.1 as **regression alerting**: "12 reports from
  `/receipts/scan`, iOS, 4.12.0, in 72 hours" is a correct and valuable output.
  Precision 1.000 on that slice means when it groups, it is right — exactly the
  property an alert needs.
- Do **not** ship it as the ranked list. On feature requests, which are 53% of
  the corpus and the majority of what prioritization is for, it is noise
  (ARI 0.023).
- v0.1's ranked list must therefore come from **imported support-inbox text
  plus lexical similarity**, or accept semantic clustering earlier than
  planned. The `@quorum/node` import-first path from ADR-0012 becomes more
  important, not less — but it needs real text clustering behind it.

## Why the asymmetry is real and not a corpus artifact

A defect lives at one place in the product: a crash on the receipt scanner is
reported from the receipt scanner, on the version that broke it, within days of
that release. Route, version, and time are near-perfect proxies for identity.

A *want* has no such location. Dark mode is requested from the dashboard, the
settings page, the expense list, and the scanner, across every version, for
months. The structural signal that identifies a defect is precisely the signal
a feature request lacks.

That is a property of how software feedback works, not of how this corpus was
written — which is why the finding was acted on despite the corpus being
synthetic.

## Consequences

- The v0.1 promise in [ROADMAP.md](../ROADMAP.md) is narrowed and made honest:
  structural grouping ships as regression detection; the ranked list needs text.
- Two mitigations for the low recall (0.463) on burst clusters, both deferred:
  fixed epoch-anchored buckets split a burst that straddles a boundary — a
  sliding window or a proper burst-detection pass would fix it, and fixed
  buckets never will. There's a test pinning that artifact so it isn't
  rediscovered.
- The eval harness has already paid for itself once. That is the argument for
  writing it before tuning anything, not after.
- **Caveat carried forward:** the corpus is synthetic, so the magnitudes above
  are not trustworthy, only the direction. Re-run this analysis against real
  labeled data before treating any threshold here as tuned.

## Reversal cost

Low. This narrows a claim; no interfaces change.

## What would change our mind

Real labeled data showing structural clustering performing acceptably on
feature requests — which would most likely mean a product where feedback is
strongly route-associated (a single-purpose tool rather than a broad suite).
Worth re-measuring per customer rather than assuming the general answer.
