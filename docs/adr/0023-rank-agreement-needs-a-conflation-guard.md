# 0023 — Rank agreement needs a conflation guard

**Status:** Accepted · 2026-09-09
**Refines:** [0014](0014-rank-agreement-is-the-eval-target.md) (rank agreement is the eval target)

## Context

[ADR-0014](0014-rank-agreement-is-the-eval-target.md) established top-10 rank
agreement as the metric, because tuning on ARI picks a measurably worse ranked
list. That is still true. What it did not establish is that rank agreement has
a degenerate region of its own, and the first hybrid sweep walked straight into
it.

The sweep grids `semanticWeight` × `threshold` and reports top-10 agreement per
cell. Run against a deliberately non-semantic stand-in embedder, its best cell
scored **7/10 against a lexical baseline of 5/10** — an apparent two-point win
from a hash function that cannot bridge paraphrase and was documented as unable
to help.

It was not helping. That cell produced **17 clusters against a corpus truth of
50**, with pairwise precision of 0.06 versus lexical's 0.33.

The mechanism is straightforward once seen. `topKAgreement` labels each
predicted cluster by the truth cluster holding a plurality of its members. Merge
aggressively and each surviving blob absorbs several truth clusters, so its
plurality label is very likely to *be* one of the top-ranked truth issues.
Between roughly `k` and `2k` clusters the metric pays for conflation. Below `k`
it collapses again — with one cluster you can score at most 1/10 — which is why
the failure hides: the obvious degenerate case is already excluded, so the
metric looks safe.

A ranked list built from that configuration has a first row that is four
unrelated topics sharing a title.

## Decision

**A cell that conflates more than the lexical control cannot win a sweep.**

Concretely: every cell records pairwise precision. The floor is the lexical
control's precision minus a tolerance (10% by default). Cells below it are
marked degenerate and excluded from `best` — but still printed, marked with
`!`, because "the highest score came from a cell we refuse to use" is the
finding, not a detail to hide.

The floor is relative, not absolute. The right precision for a corpus is not
knowable in advance, and a fixed number would be exactly the arbitrary constant
this project keeps trying not to invent. But *worse than the thing you are
replacing* always disqualifies, and that comparison needs no tuning.

The report also prints two grids alongside the score — clusters found against
truth, and pairwise precision — so over-merging is visible rather than inferred.

## Consequences

The stand-in embedder now scores **+0** against lexical, which is what its own
documentation predicted. That agreement between a prediction and a measurement
is the reason to trust the guard.

**This changes what a future embedding measurement means.** Without it, the
first real model run would have reported an inflated number, and the roadmap
would have been steered by a metric rewarding the opposite of what the product
needs. ADR-0019's quality bar has to be cleared *without* conflating, which is
a strictly harder bar than the one that was implied.

## What we gave up

**A single number.** A sweep now reports three grids and a disqualification
count. That is more to read, and the alternative is a headline that can be
gamed by a configuration nobody would ship.

**Some legitimate configurations, possibly.** A model good enough to merge
correctly *and* aggressively would take a precision hit against a lexical
baseline that fragments, and could be disqualified for being right. The
tolerance exists for that case and `precisionTolerance` can be raised — but the
burden is on the person raising it to look at the clusters and say why.

## What would change our mind

- **A real model that lands just under the floor.** If a genuinely good model is
  disqualified, the guard is mis-calibrated and the answer is per-cluster purity
  on the top-k specifically, rather than corpus-wide pairwise precision.
- **A labeled corpus with realistic cluster-size skew.** The bundled corpus is
  synthetic and its 50 clusters are more even than real feedback. The degenerate
  zone's width depends on that distribution, and the roadmap already calls
  replacing this corpus the highest-leverage task in the clustering track.
