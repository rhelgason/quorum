# 0025 — The online threshold clears the guard; the offline pass dominates

**Status:** Accepted · 2026-09-09
**Closes:** the open question in [0024](0024-consolidation-threshold-retuned.md)

## Context

[ADR-0024](0024-consolidation-threshold-retuned.md) found the consolidation
threshold had been chosen by maximising top-`k` rank agreement, a metric that
pays for over-merging, and raised it from 0.03 to 0.10. Its consequences
section said the general lesson applied to any threshold picked the same way,
and named one that had not been re-checked: **the online assignment threshold,
0.25.**

Leaving that flagged and unmeasured would have been the same mistake twice.

## The measurement

Both corpora, consolidation at its new default, online threshold swept:

| online | eval issues | eval top-10 | eval precision | eval F1 | NW issues | NW precision | NW F1 | NW largest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.10 | 52 | 5/10 | 34.9% | 31.8% | 54 | 39.2% | 28.0% | 29 |
| 0.15 | 64 | 5/10 | 45.4% | **34.8%** | 58 | 48.5% | 31.1% | 29 |
| 0.20 | 67 | 4/10 | 46.8% | 34.1% | 60 | 54.9% | 33.1% | 25 |
| **0.25** | 67 | **6/10** | 45.2% | 31.2% | 61 | 57.7% | 32.8% | **18** |
| 0.30 | 67 | 5/10 | 42.9% | 30.4% | 61 | 60.7% | **33.8%** | 18 |
| 0.35 | 68 | 5/10 | 43.9% | 29.1% | 63 | 61.5% | 33.3% | 18 |

## Decision

**Keep 0.25.** It passes the test 0.03 failed.

The question ADR-0024 raised was whether the default's rank agreement was
bought by conflating. Here it plainly is not: at 0.25 the largest cluster is
**18 members — the smallest of any setting tried** — and precision sits
mid-range rather than collapsing. Where 0.03 reached 6/10 with 23% precision
and a 53-member blob, 0.25 reaches 6/10 with 45% precision and no blob at all.
It is the best rank agreement available *and* among the least conflating, which
is the combination the guard exists to require.

It is not the F1 optimum on either corpus — 0.15 wins on the eval corpus, 0.30
on the larger one — but both margins are inside the noise these synthetic
corpora can resolve, and they point in opposite directions, which is itself
evidence that no single value is being identified.

## The more useful finding

**Above 0.20 the online threshold barely matters.** Issue counts sit at 67–68
on the eval corpus and 60–63 on the larger one across the whole upper range,
and F1 moves by two points. The offline consolidation pass dominates the final
grouping; the online tier mostly decides how much work it has to do.

That is a good property and it was the design intent —
[ADR-0018](0018-two-tier-clustering-validated.md) chose a high online threshold
for order-robust, stable assignments precisely so the offline pass could own
recall. It is now measured rather than assumed, and it explains why 0.03 was so
damaging while 0.25 versus 0.30 is nearly invisible: **the tier that decides
grouping quality is the one whose threshold had never been checked.**

The practical consequence for anyone tuning this: spend the effort on the
consolidation threshold, and expect the online one to be insensitive.

## What would change our mind

- **Real labeled data**, as ever. Both corpora are synthetic and the two
  disagree about the F1 optimum, which is roughly what "not enough signal to
  choose" looks like.
- **Embeddings landing.** Semantic similarity raises every pairwise score, so
  a threshold calibrated on lexical cosine will not transfer —
  `packages/eval`'s sweep grids both dimensions together for exactly this
  reason, and the whole question reopens the day a real model is measured.
