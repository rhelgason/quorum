# 0024 — The consolidation threshold was bought with conflation

**Status:** Accepted · 2026-09-09
**Amends:** [0018](0018-two-tier-clustering-validated.md) (two-tier clustering validated)
**Applies:** [0023](0023-rank-agreement-needs-a-conflation-guard.md) (rank agreement needs a conflation guard)

## Context

[ADR-0018](0018-two-tier-clustering-validated.md) validated the two-tier
design and set `DEFAULT_CONSOLIDATE_THRESHOLD = 0.03`, on the strength of the
offline pass raising top-10 rank agreement from 5/10 to 6/10 on the 161-item
eval corpus. It was explicit that the number was a starting point rather than a
tuned value.

[ADR-0023](0023-rank-agreement-needs-a-conflation-guard.md) then established
that top-`k` rank agreement has a degenerate region: between roughly `k` and
`2k` clusters, merging aggressively *raises* the score, because each
over-merged blob is likely to carry a top truth issue as its plurality label.
That guard was applied to the eval sweep. It was not applied to the shipped
default, which had been chosen on the same metric.

A second corpus made the omission visible. 428 synthetic submissions across 25
topics ([`examples/northwind`](../../examples/northwind/README.md)) produced,
at the default:

- **39 issues** against a truth of 25, with a single cluster holding **53
  members**
- pairwise precision of **32%**, against **88%** with consolidation off

The same measurement on the eval corpus, which had never been taken:

| consolidate | clusters | top-10 | precision | recall | F1 |
| --- | --- | --- | --- | --- | --- |
| off | 105 | 5/10 | 59.5% | 15.8% | 24.9% |
| **0.03** | 36 | **6/10** | **23.2%** | 35.6% | 28.1% |
| 0.06 | 50 | 4/10 | 34.1% | 28.5% | 31.1% |
| **0.10** | 67 | **6/10** | **45.2%** | 23.8% | **31.2%** |
| 0.15 | 79 | 4/10 | 50.0% | 21.1% | 29.7% |
| 0.20 | 96 | 5/10 | 60.4% | 19.5% | 29.4% |

0.03 reached its 6/10 with pairwise precision of 23%, from 36 clusters against
a truth of 50. That is the degenerate region, exactly as described — the extra
point was bought by conflating, and the metric paid for it.

## Decision

**`DEFAULT_CONSOLIDATE_THRESHOLD` goes from 0.03 to 0.10.**

This is not a trade. 0.10 matches 0.03's rank agreement on the eval corpus,
nearly doubles its pairwise precision, and scores higher on F1 on **both**
corpora:

| | eval top-10 | eval F1 | eval precision | 428-item F1 | 428-item precision | largest cluster |
| --- | --- | --- | --- | --- | --- | --- |
| 0.03 | 6/10 | 28.1% | 23.2% | 31.1% | 32.2% | 53 |
| 0.10 | 6/10 | 31.2% | 45.2% | 32.8% | 57.7% | 18 |

ADR-0018's substantive claims are unchanged and confirmed: the offline pass
earns its place (F1 rises from 24.9% to 31.2% on the eval corpus), average
linkage is right, and a high online threshold plus offline repair beats one
balanced number. What was wrong was the specific constant, and the reason it
was wrong is that it was selected on a metric that rewards over-merging.

## Consequences

**The guard should have been applied to the default, not only to the sweep.**
ADR-0023 built the tool and pointed it at the wrong thing. Any number in this
repo chosen by maximising top-`k` agreement is now suspect until it has been
re-checked against precision — that is the general lesson, and the online
threshold has not yet had the same scrutiny.

**A constant is probably the wrong shape.** The threshold had to be re-derived
when the corpus grew from 161 to 428 items, because more documents means more
opportunities for spurious average-linkage similarity. A criterion that scales
with corpus size — or one expressed relative to the observed similarity
distribution — would not need retuning per deployment. Both corpora are
synthetic, so this is a direction rather than a design.

## What would change our mind

- **Real labeled data.** Both corpora were written by the same person who wrote
  the answer key. If a real one puts the optimum somewhere else, it wins over
  either of these.
- **A size-relative criterion that holds on both.** That would supersede the
  constant entirely and is the better fix.
- **Evidence that precision is the wrong guard here.** It penalises all merging,
  which is why F1 rather than precision alone decided this. If a configuration
  ever scores better on F1 *and* worse on precision than the control, the rule
  needs restating.
