# 0019 — Embeddings are worth building, the bar is low, and the blend stays

**Status:** Accepted · 2026-09-03
**Confirms:** [0014](0014-rank-agreement-is-the-eval-target.md) (embeddings required for v0.1)
**Evidence:** oracle ablation in [`packages/eval`](../../packages/eval/README.md)

## Context

[ADR-0014](0014-rank-agreement-is-the-eval-target.md) moved embeddings into
v0.1 on the strength of a ceiling: lexical clustering recovers 5 of the correct
top 10, and [ADR-0018](0018-two-tier-clustering-validated.md) lifted that only
to 6.

Two questions should be answered before building an embedding pipeline, and
neither needs a real model:

1. If the similarity signal were perfect, would everything downstream —
   clustering, consolidation, ranking, medoid labelling — actually deliver a
   correct list? If not, embeddings are not the bottleneck.
2. How good does the model have to be? That is the difference between "any
   small local model will do" and "this needs something large", which changes
   the cost, the latency, and the self-host story.

An **oracle embedder** answers both. It derives vectors from ground-truth
labels, with a `noise` parameter interpolating toward a random direction:
`noise = 0` is perfect knowledge, `noise = 1` is chance. It is useless for
claiming clustering quality — it knows the answer — and ideal for measuring
headroom.

## Evidence

Top-ten agreement (and ARI), by oracle noise and semantic weight `w`:

| noise | w=0.5 hybrid | w=0.8 | w=1.0 pure semantic |
| --- | --- | --- | --- |
| 0.0 | **10/10** (0.92) | **10/10** (0.93) | **10/10** (0.97) |
| 0.2 | 10/10 (0.91) | 10/10 (0.97) | 10/10 (0.97) |
| 0.4 | 9/10 (0.92) | 10/10 (0.96) | 9/10 (0.99) |
| 0.5 | 9/10 (0.90) | 8/10 (0.95) | 9/10 (0.96) |
| 0.6 | 8/10 (0.63) | 7/10 (0.65) | 6/10 (0.37) |
| 0.7 | 5/10 (0.34) | 4/10 (0.12) | 2/10 (0.03) |
| 0.8 | **6/10** (0.18) | 4/10 (0.02) | **3/10** (0.01) |
| 1.0 | 4/10 (0.10) | 3/10 (0.00) | 3/10 (0.00) |

## Decision 1 — build them; the architecture is proven

A perfect signal yields **10/10 and ARI 0.92–0.97**. Same pipeline, same
ranking, same corpus as the 6/10 lexical result — only similarity changed.

That isolates the remaining error precisely: the ceiling is a **similarity
problem, not a design problem**. Leader-follower assignment, incremental
centroids, offline consolidation, log-scaled weighted ranking, and medoid
labelling all work correctly once similarity is good. The embedding investment
pays out, and nothing else needs redesigning first.

Note ARI never reaches 1.0 even with a perfect oracle, and that is correct
rather than a defect: the corpus contains 20 deliberate singletons that a
threshold-based method will always fold or split somewhere. Rank agreement
reaches 10/10 regardless, which is another instance of
[ADR-0014](0014-rank-agreement-is-the-eval-target.md)'s point that ARI is the
wrong headline.

## Decision 2 — the quality bar is low; do not over-invest in the model

The pipeline holds at 8–10/10 with **half the vector replaced by noise**, then
falls off sharply between 0.6 and 0.7.

The practical read: a small local sentence-transformer is enough. There is no
case here for a large model, a hosted embedding API, or a fine-tune. That
keeps embeddings **free and fully local**, which preserves the self-host and
"customer feedback never leaves our infrastructure" story that
[ADR-0005](0005-deterministic-core-llm-at-render-edge.md) and
[ADR-0016](0016-llm-is-config-not-code.md) depend on.

**The important caveat:** oracle noise is isotropic and random. Real embedding
error is *systematic* — a real model confuses "dark mode" and "light mode"
consistently, not occasionally, because they genuinely sit close together in
semantic space. Structured error is harder than random error of the same
magnitude, so the tolerance measured here is an **upper bound**. Treat "half
the signal can be noise" as evidence that the bar is not extreme, not as a
specification. The `shared-symptom` and `feature-vs-bug-same-nouns` traps in
the corpus exist to catch exactly the systematic failures this ablation cannot
model, and they are the ones to watch when a real model lands.

## Decision 3 — keep the lexical half; default `semanticWeight ≈ 0.5`

At noise 0.8 the hybrid scores 6/10 while pure semantic scores 3/10. Lexical
precision on shared product nouns does not degrade just because the model is
bad, so the lexical term acts as a floor.

With a good signal all three weights tie, so blending costs nothing when the
model is fine and protects the product when it is not — a bad model, a wrong
model name, a truncated context, a silently swapped provider endpoint. Cheap
insurance against a failure mode that is otherwise invisible.

Implementation notes now in `cluster.ts`: documents lacking a vector fall back
to lexical-only scoring rather than being treated as similarity 0, so a
partially-embedded batch still clusters; and a document whose lexical vector is
empty but which carries an embedding is now clusterable, where before it was
forced to seed its own cluster.

## Consequences

- `Embedder` is a one-method async interface, absent by default, configured by
  environment exactly like the LLM provider — no model identifier in the source
  tree, one OpenAI-compatible adapter for Ollama, llama.cpp, LM Studio, vLLM,
  and hosted endpoints alike.
- Embedding is async and batched while clustering is synchronous and per-item,
  so callers embed a batch and then cluster. The adapter sorts responses by
  `index` rather than trusting arrival order — an endpoint returning results
  out of order would otherwise attach the wrong vector to a submission and
  corrupt clusters with no visible error.
- **The real model is still unvalidated.** Nothing here measures an actual
  embedding model, because this environment has no network. The first task when
  one is available is to re-run the corpus with it and locate the true position
  on this curve.
- Still synthetic data throughout.

## Reversal cost

Low. `semanticWeight` defaults to 0, so the whole path is inert until enabled.

## What would change our mind

A real model landing well below the 0.6 noise cliff on structured error, which
would mean the systematic-error caveat dominates. The response is not a bigger
model first — it is to check the `shared-symptom` and
`feature-vs-bug-same-nouns` traps, since those failures are better addressed by
the blend weight and by bigrams than by model size.
