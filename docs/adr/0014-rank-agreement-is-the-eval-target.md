# 0014 — Rank agreement is the eval target; embeddings are required for v0.1

**Status:** Accepted · 2026-09-03
**Amends:** [0012](0012-prioritization-is-the-product.md),
[0013](0013-structural-clustering-is-a-regression-detector.md)
**Evidence:** [`packages/eval`](../../packages/eval/README.md)

## Context

[ADR-0013](0013-structural-clustering-is-a-regression-detector.md) found that
structural clustering cannot rank feature requests, and left v0.1 resting on an
untested assumption: that lexical similarity (TF-IDF cosine + leader-follower)
would carry the ranked list, keeping v1 free of any ML.

`@quorum/aggregate` now implements that pipeline, so the assumption is testable.

## Evidence

Measured on the 161-item corpus. `top10` is how many of the correct top ten
canonical issues appear in the produced top ten; `capture` is the share of a
found issue's submissions that landed in the single cluster representing it.

| method | ARI | top10 | capture |
| --- | --- | --- | --- |
| perfect clustering | 1.000 | 10/10 | 1.00 |
| all-singletons (useless) | 0.000 | 3/10 | 0.14 |
| structural (ADR-0013) | 0.092 | 4/10 | 0.56 |
| **lexical t=0.10** | 0.297 | **5/10** | 0.63 |
| lexical t=0.15 | **0.316** | **3/10** | 0.58 |
| lexical t=0.20 | 0.284 | 5/10 | 0.44 |
| lexical + bigrams t=0.10 | 0.278 | 4/10 | 0.52 |

Lexical clustering is a genuine improvement on structural — roughly 2.3× the
ARI, and it works on feature requests where structural scored 0.023. It is
still not good enough.

## Decision 1 — the eval target is rank agreement, not ARI

Look at the two bolded rows. **The best-ARI configuration produces the worst
top ten.** Tuning on ARI would have selected t=0.15 (3/10) over t=0.10 (5/10) —
a configuration barely better than shattering the corpus into singletons.

The mechanism is fragmentation. Splitting `dark-mode` into four clusters of two
or three barely dents ARI, because each fragment is internally pure. But it
divides that issue's demand by four and drops every fragment off the front
page. The team never sees the thing most users asked for. Clustering metrics
rate that outcome as middling; the product is simply wrong.

So `topKAgreement` becomes the headline number, and ARI, F1, and V-measure
become diagnostics for *why* it moved. This reverses the emphasis the harness
shipped with earlier the same day.

Caveat: on a 161-item corpus the exact ordering of nearby thresholds is noisy,
and we are not claiming ARI and rank agreement are inversely related. The claim
is narrower and sufficient: **ARI does not reliably track the thing the product
delivers, so it must not be the tuning objective.**

## Decision 2 — embeddings move into v0.1

Best-case lexical recovers 5 of 10 correct top items, with capture between 0.43
and 0.63 even on the ones it finds. A ranked list that is half wrong, with the
right answers understated by fragmentation, does not meet the v0.1 promise from
[ADR-0012](0012-prioritization-is-the-product.md) — that a team's first session
ends with a defensible top ten.

The plan of a v1 with no ML is therefore dead. Local sentence embeddings move
from v0.4 into v0.1.

Two findings point the same way:

- **Lexical cannot close a paraphrase gap.** "add dark mode" and "the app
  destroys my eyes at night" share no content words. No lexical method joins
  them, and `dark-mode` is the single largest issue in the corpus. This is
  precisely what embeddings are for.
- **Bigrams help precision and hurt the list.** They solve the corpus's hardest
  designed trap — separating `csv-export` from "CSV export is missing the last
  row", where unigram overlap is total — but they add sparsity and drive
  aggregate recall down, costing a top-ten slot. Both effects are pinned in
  tests. They stay available, off by default, and a hybrid should revisit them
  once embeddings carry recall.

The embedding model stays local and deterministic — a ~90MB MiniLM-class model
is a numerical similarity function, not an agent. This does **not** weaken
[ADR-0005](0005-deterministic-core-llm-at-render-edge.md): the deterministic
core is still deterministic, still offline, still free, and the LLM is still
only at the render edge.

## Consequences

- ROADMAP v0.1 gains local embeddings and hybrid similarity. Ship them
  behind the same threshold sweep, and tune on rank agreement.
- Lexical clustering is not wasted. It is the fallback when no embedding model
  is present, and the lexical half of the planned hybrid score.
- `@quorum/aggregate` needs a pluggable embedder interface so the model is
  swappable and absent-by-default, exactly as the LLM provider is.
- The harness has now overturned two roadmap assumptions in two days. That is
  the argument for building it before tuning, not after.

## Reversal cost

Low. This changes sequencing and a tuning objective; no interfaces break.

## What would change our mind

Real labeled data where lexical clustering reaches 8/10 rank agreement — most
plausible for a narrow single-purpose product whose users share vocabulary. The
corpus here is synthetic, so magnitudes are untrustworthy; the *mechanism*
(paraphrase gaps and fragmentation) is not. Re-measure per customer.
