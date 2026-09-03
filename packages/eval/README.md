# @quorum/eval

Clustering evaluation harness: metrics, a labeled corpus, adversarial pairs,
and baseline clusterers.

```bash
npm run eval    # baselines, rank agreement, and a ranked backlog
npm test        # metrics, corpus integrity, baselines, clustering
```

## Read this before trusting a number

**The corpus is synthetic.** Every one of the 161 submissions was hand-written
for this repository. That has a specific consequence:

> This corpus can validate an **implementation**. It cannot validate an
> **approach**.

Because the same judgment authored both the items and the cluster labels, any
method built on the intuitions behind those items will look better here than
it will on real feedback. Scores are a regression signal and a floor, not
evidence that clustering works.

Known ways it is unrepresentative:

- **No verbatim duplicates.** Real feedback contains a meaningful share of
  literal repeats; every item here was written separately. This is why the
  `exact-match` baseline degenerates to singletons — in production it wouldn't.
- **No true multilingual content, no spam, no empty submissions, no
  keyboard-mash.** Real ingest is dirtier.
- **Clean cluster boundaries.** Real feedback contains genuinely ambiguous
  items where two careful people would disagree. Everything here has a defensible
  single answer, which flatters any method.
- **Uniform prose quality.** No corpus-wide house style in real data; here
  there is one author's ear.
- **One fictional product.** Vocabulary and route structure are internally
  consistent in a way a real multi-tenant corpus is not.

What it is genuinely good for: catching regressions, proving the metric code is
correct, establishing a floor, and — through the hard-pair set — pinning
specific named failure modes so a change points at a cause instead of a number.

**Replacing it with real data is the highest-leverage task in the ML track.**
The schema is designed for that: drop real submissions into
`corpus/submissions.json`, label them, and everything downstream works
unchanged.

## Layout

```
corpus/
  clusters.json      30 canonical issues with difficulty ratings and notes
  submissions.json   161 labeled items across 30 clusters + 20 singletons
  hard-pairs.json    20 adversarial pairs, each naming a specific trap
src/
  metrics.ts         ARI, pairwise P/R/F1, V-measure, diagnose()
  corpus.ts          loader + integrity validation
  hard-pairs.ts      per-trap scoring
  baselines.ts       degenerate floors + structural clusterers
  consolidation.test.ts  does the offline tier repair fragmentation?
  task-metrics.ts    topKAgreement — the headline metric
  adapt.ts           corpus -> @quorum/aggregate input shapes
  report.ts          runners and text formatting (pure)
  cli.ts             console entrypoint
```

Lexical clustering itself lives in
[`@quorum/aggregate`](../aggregate/), not here — this package only measures.

## The corpus is built around traps

Aggregate metrics hide the failures that matter. A pipeline can score ARI 0.85
while merging every feature request with its own bug report, because those
pairs are individually tiny — and they are exactly what a user notices. So the
corpus deliberately contains adversarial neighbours:

| Trap | Example | Why it's hard |
| --- | --- | --- |
| `paraphrase-no-overlap` | "add dark mode" ↔ "the app destroys my eyes at night" | Zero content-word overlap. Lexical methods must fail it. |
| `feature-vs-bug-same-nouns` | "export all expenses to CSV" ↮ "CSV export is missing the last row" | Maximum lexical *and* semantic overlap, same route, same version, completely different work. |
| `capability-vs-discoverability` | "we need GBP support" ↮ "where do I change the currency?" | One is engineering, one is UX. Almost always merged. |
| `same-surface-different-defect` | OCR accuracy ↮ scanner crash | Identical route, platform, version. Structural clustering *must* merge these. |
| `shared-symptom` | dark mode ↮ larger text | Both eye-strain complaints on the same screen. Embeddings over-merge. |
| `vague-bridge` | "why is everything so white" ↮ "the statuses are confusing" | Two low-information items. Single-linkage chains unrelated clusters through pairs like this. |
| `praise-vs-complaint` | "the scanner is magic" ↮ "the scanner reads the tip as the total" | Same topic, opposite sentiment. Burying a complaint in a praise cluster is actively harmful. |
| `same-user-different-need` | one user, one screen, two unrelated requests | Same user and route is not evidence of the same issue. |

## Baselines, as measured

```
  method                     clusters     ARI      F1   preP   preR    hom   comp   pairs
  ---------------------------------------------------------------------------------------
   all-one-cluster                 1  0.000  0.045 0.023 1.000 0.000 1.000     7/20
   all-singletons                161  0.000  0.000 1.000 0.000 1.000 0.725    13/20
   exact-match                   161  0.000  0.000 1.000 0.000 1.000 0.725    13/20
   structural (7d)                62  0.092  0.110 0.132 0.094 0.740 0.692    11/20
   structural (3d)                92  0.063  0.074 0.142 0.050 0.836 0.703    11/20
   structural (30d)               38  0.138  0.162 0.135 0.201 0.640 0.695     9/20
   structural+token (7d)         155  0.006  0.007 0.167 0.003 0.988 0.723    13/20
```

Note the hard-pair column: `all-singletons` scores 13/20 while being a
completely useless clusterer, because most traps are "these should *not*
merge". Never read that column alone.

### Rank agreement — the headline metric

ARI scores a clustering; it is not what the product delivers. A team reads a
top ten, so the number that matters is how much of the correct top ten
survives:

```
  method                        ARI   top10  capture
  --------------------------------------------------
  perfect clustering          1.000   10/10     1.00
  all-singletons (useless)    0.000    3/10     0.14
  structural (7d)             0.092    4/10     0.56
  lexical t=0.10              0.297    5/10     0.63
  lexical t=0.15              0.316    3/10     0.58   <-- best ARI, worst list
  lexical t=0.20              0.284    5/10     0.44
```

**Tuning on ARI picks t=0.15, which is barely better than shattering the corpus
into singletons.** The mechanism is fragmentation: splitting `dark-mode` into
four pure clusters of two barely dents ARI, but divides its demand by four and
drops all four off the front page. Optimize `topKAgreement`; use the clustering
metrics to explain why it moved. See
[ADR-0014](../../docs/adr/0014-rank-agreement-is-the-eval-target.md).

### Offline consolidation

Fragmentation is the diagnosed failure, so the offline tier targets it
directly. Top-ten agreement, online threshold × offline consolidation
threshold (average linkage):

```
  online          none   c=0.03  c=0.05  c=0.07
  ------------------------------------------------
  t=0.15           3/10     5       6       6
  t=0.16           4/10     6       6       6
  t=0.25           5/10     6       5       4
```

Best single-pass was 5/10; best two-tier is 6/10, reached from several
starting points. Consolidation specifically rescues over-split configurations,
which is what the online pass systematically produces — so **set the online
threshold high and let the offline pass recover recall**.

Adjacent cells swing between 3 and 6. On 161 items one cluster crossing the
top-ten boundary moves the score by a whole point, so treat the direction and
the ceiling as real and the exact values as noise. The tests assert ranges for
that reason. See
[ADR-0018](../../docs/adr/0018-two-tier-clustering-validated.md).

### The finding that changed the roadmap

Sliced by kind, structural clustering is not one method — it's two:

```
  slice                        items  clusters     ARI      F1   preP   preR
  --------------------------------------------------------------------------
   bugs only                     52        31  0.340  0.365 0.568 0.269
   feature requests only         86        48  0.023  0.046 0.083 0.032
   release-burst clusters        17         7  0.547  0.633 1.000 0.463
```

On release-burst bug clusters it has **precision 1.000** — when it groups two
things, it is never wrong. On feature requests it is indistinguishable from
noise, because a request for dark mode arrives from every screen in the product
while a crash arrives from exactly one.

This contradicted the original v0.1 plan, which assumed structural grouping
alone would produce a useful ranked list. See
[ADR-0013](../../docs/adr/0013-structural-clustering-is-a-regression-detector.md).

Caveat, stated again: this is synthetic data, so the *magnitude* is not
trustworthy. The *mechanism* — feature requests being route-diffuse and defects
being route-concentrated — is a property of how software feedback works, not of
how this corpus was written, which is why the finding was acted on.

## Extending the corpus

1. Add items to `corpus/submissions.json`.
2. Declare any new cluster in `corpus/clusters.json` with a `difficulty`.
3. Run `npm test` — `validate()` catches undeclared clusters, duplicate ids,
   singletons that grew a second member, and hard pairs that contradict the
   labels.

That last check matters most: relabeling a submission without updating the
adversarial set leaves the set asserting the opposite of the truth, and
everything downstream still produces a confident-looking number.
