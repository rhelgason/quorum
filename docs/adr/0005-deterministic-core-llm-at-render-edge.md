# 0005 — Deterministic clustering core, LLM at the render edge

**Status:** Accepted · 2026-09-02

## Context

The aggregation layer is the product's second differentiator, and the obvious
build is "throw every submission at an LLM and ask for the top themes." That
approach is expensive, non-reproducible, unauditable, and unsellable to any
enterprise that can't send customer feedback to a third party.

The important reframe: **sentence embeddings are not LLM intervention.** A
~90MB MiniLM-class model running locally is deterministic, free, offline, and
sub-millisecond — a numerical similarity function. Semantic clustering with no
agent in the loop is entirely achievable.

But there is a genuine gap that similarity cannot close. The medoid of a
cluster gives you *"the app hurts my eyes at night."* Engineering needs
*"Implement a dark theme across settings, feed, and detail surfaces,
respecting the OS-level appearance setting."* That's abstraction lift +
imperative voice + spec structure — a generation problem, not a similarity
problem.

## Decision

Everything up to and including ranking is deterministic. The LLM is called
once per canonical issue to render title + summary + eng spec, cached and
versioned against a hash of the cluster's member set.

- Clustering: LSH blocking → hybrid similarity (BM25 + embedding cosine +
  structural) → online leader-follower assignment → nightly HDBSCAN/Leiden
  re-consolidation that *proposes* merges and splits for human approval.
- Ranking: `Σ_users(account_weight × recency_decay) × growth_multiplier`. No
  model.
- Labels without an LLM: the **medoid** — the real submission closest to the
  centroid. Human-written, free, inherently auditable.
- Renders regenerate only when composition shifts past ~20% new members.
- Every generated line carries `quote_refs` back to verbatim submissions.

## Consequences

- **Reproducible output.** The same cluster renders the same spec. A top-items
  list that churns week to week is one no PM trusts, and re-clustering from
  scratch every run is the usual cause.
- **Bounded cost.** Spend scales with cluster *change*, not cluster count or
  dashboard traffic.
- **Clean BYO-model / self-host story.** The LLM is at the edge, so removing it
  degrades the product to medoid labels rather than breaking it. This directly
  answers the objection that kills enterprise deals in this category.
- **Auditable.** Mandatory drill-down to quotes. LLM output with no drill-down
  gets distrusted the first time it's subtly wrong, and it will eventually be
  subtly wrong.
- Cost: more moving parts than "ask the model," and the deterministic pipeline
  has thresholds that must be tuned against a hand-labeled eval set. Without
  that eval set every knob is unfalsifiable — this is the highest-leverage day
  on the ML side and it must precede tuning, not follow it.

### Rejected alternatives

- **k-means** — k is unknown, feedback clusters aren't spherical or
  equally sized, and there's no outlier concept. A lot of feedback genuinely is
  a singleton and should be labeled noise, which HDBSCAN does natively.
- **Threshold + connected components** — single-linkage chains
  catastrophically: A~B, B~C, C~D and suddenly "dark mode" and "font size" are
  one cluster via a bridge of vague complaints. Leiden on the weighted kNN
  graph optimizes modularity instead of transitively closing edges.
- **Embeddings alone** — over-merges. It will happily fuse "dark mode" and
  "light mode" because they're semantically adjacent. Lexical signal is needed
  precisely because users reuse product nouns.
- **Auto-applying offline merges** — quietly undoes human curation; users stop
  trusting the tool permanently. Propose, never apply.

## Reversal cost

Moderate. The render edge could be pushed deeper, but the caching, audit trail,
and self-host story all unwind with it.

## What would change our mind

If eval shows the deterministic pipeline plateaus well below an LLM-clustered
baseline on real data, revisit — but push the model into *scoring candidate
pairs* (still cacheable, still auditable) before letting it own clustering.
