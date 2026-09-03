# 0018 — The two-tier split is validated; average linkage is the offline rule

**Status:** Accepted · 2026-09-03
**Confirms:** [0005](0005-deterministic-core-llm-at-render-edge.md) (online/offline split, no single linkage)
**Does not change:** [0014](0014-rank-agreement-is-the-eval-target.md) (embeddings still required)

## Context

[ADR-0014](0014-rank-agreement-is-the-eval-target.md) identified fragmentation
as the mechanism destroying rank agreement: splitting one issue into four pure
clusters barely dents ARI but divides its demand by four and drops every
fragment off the ranked list.

`docs/DATA-MODEL.md` already specified an offline consolidation tier to repair
exactly this, and [ADR-0005](0005-deterministic-core-llm-at-render-edge.md)
already asserted — without evidence — that it must use something other than
single linkage. Both claims are now testable.

## Evidence

Top-ten agreement, online leader-follower threshold × offline consolidation
threshold, average linkage:

| online | no consolidation | c=0.03 | c=0.05 | c=0.07 |
| --- | --- | --- | --- | --- |
| t=0.13 | 5/10 | 5 | 5 | 5 |
| t=0.15 | **3/10** | 5 | **6** | **6** |
| t=0.16 | 4/10 | **6** | **6** | **6** |
| t=0.18 | 5/10 | **6** | 5 | 4 |
| t=0.25 | 5/10 | **6** | 5 | 4 |
| t=0.30 | 3/10 | **6** | 4 | 4 |

## Decision 1 — the two-tier split earns its complexity

Best single-pass lexical was 5/10. Best two-tier is 6/10, and it is reached
from many starting points rather than one lucky cell.

The interesting row is `t=0.15`, which ADR-0014 flagged as the best-ARI /
worst-list configuration. It is over-split, and consolidation takes it from
3/10 to 6/10 — the largest improvement in the table. **The offline tier
specifically rescues over-splitting**, which is what it was designed to do and
what the online pass systematically causes.

The practical consequence is a change in how to tune: prefer a **high online
threshold plus aggressive offline consolidation** over a carefully-tuned
single threshold. The high online threshold buys cheap, stable, order-robust
assignments; the offline pass recovers the recall. That is the architecture
justifying itself rather than being asserted.

## Decision 2 — average linkage, and it is safe to run aggressively

Confirmed by direct test. At an offline threshold of 0.03 on real corpus
clusters, average linkage keeps the clustering intact while **single linkage
collapses it to under half the cluster count** — chaining unrelated issues
through low-information bridge items exactly as
[ADR-0005](0005-deterministic-core-llm-at-render-edge.md) predicted. The corpus
carries a `vague-bridge` trap for this, and a unit test now demonstrates the
mechanism on a three-cluster example.

Also settled by construction:

- **Recompute linkage after every merge.** Scoring all pairs once and applying
  them together lets two clusters join transitively without their combined
  similarity ever being checked — single linkage by the back door.
- **Proposals only.** `proposeMerges` and `applyMerges` are separate functions
  so automatic proposing and human acceptance are not reachable through one
  call.
- **Locked clusters are excluded entirely**, and rejected proposals are
  remembered by an order-independent key. Re-proposing a declined merge nightly
  trains reviewers to ignore the queue, which is worse than having none.
- **`maxSizeRatio` guard**, off by default. A 40-member cluster absorbing a
  singleton is usually swallowing noise, and it is the merge a reviewer is
  least able to check.

## Decision 3 — this does not rescue lexical clustering

No combination of online and offline thresholds exceeded 6/10. Consolidation
raises the ceiling; it does not reach a usable list, and
[ADR-0014](0014-rank-agreement-is-the-eval-target.md)'s conclusion stands
unchanged: **embeddings remain required for v0.1.**

The reason is structural rather than a tuning failure. Consolidation reasons
over item-level similarities, so it cannot manufacture a link that is zero at
the item level. "Add dark mode" and "the app destroys my eyes at night" share
no content word, so no amount of cluster-level evidence connects them — and
`dark-mode` is the largest issue in the corpus. A test pins that.

## Consequences

- Two thresholds to tune instead of one, and they interact. Mitigated by the
  finding that the online one can simply be set high.
- `proposeMerges` is O(n²) in clusters per merge round, with a full rescan
  after each. Fine for a nightly batch over thousands of clusters; it is not
  an online path and must not become one.
- **Threshold values here are not tuned and must not be treated as such.**
  Adjacent cells in the table swing between 3 and 6, because on 161 items one
  cluster crossing the top-ten boundary moves the score by a whole point. Only
  the direction and the ceiling are trustworthy. The eval tests assert ranges
  deliberately.
- Still synthetic data. The mechanism generalizes; the magnitudes do not.

## Reversal cost

Low. The offline tier is additive and off unless invoked.

## What would change our mind

Real data where consolidation makes rank agreement *worse* — plausible if a
customer's feedback has many genuinely adjacent issues, where aggressive
merging destroys real distinctions. `maxSizeRatio` and `complete` linkage are
the levers to reach for before abandoning the tier.
