# examples/northwind — the pipeline at scale

428 pieces of feedback from 161 accounts over 120 days and 6 releases, run
through the real pipeline. This is where the README's figures come from.

```bash
npm run northwind            # run the pipeline, print the report, write the figures
npm run northwind:generate   # regenerate feedback.csv (committed, so rarely needed)
npm run app                  # the demo product, seeded with this corpus
```

## It is synthetic, and that bounds what it can show

Every sentence in [`topics.ts`](topics.ts) was written to populate a demo. The
generator knows which topic each one belongs to; the pipeline does not.

That makes this **evidence the system runs at scale, and not evidence that it
clusters accurately** — the corpus and the answer key came from the same hand.
Quality is measured separately in [`packages/eval`](../../packages/eval), whose
README is equally blunt that replacing *its* corpus with real labeled data is
the highest-leverage task in that track.

What it is legitimately good for: compression, the long tail, revenue weighting
reordering a list, a regression appearing after a release, and the shape of the
failure modes. It has already earned its keep by finding one — see below.

## What the pipeline does with it

```
submissions               428
accounts                  161 (89 paying)
issues found              59
compression               7.3× — 428 pieces of feedback into 59 decisions
assign on write           29ms for all 428
rank + explain            352ms
```

Assignment happens once per submission; a read ranks stored groups. The 352ms
is the offline consolidation pass and the ranking, which still run per request.

## What it gets wrong

The report prints this itself, because a demo that only shows its good side is
an advertisement.

Three of the top ten are fragments of one topic:

```
"dashboard-slow" reached the top 10 as 3 separate rows:
    · Everything hangs for ages before the charts appear.
    · I make a coffee while the home screen loads.
    · Performance has fallen off a cliff in the last month.
```

Those three sentences share no content words. TF-IDF cosine cannot bring them
together at any threshold, and no amount of tuning fixes it — which is the
whole argument for embeddings being in v0.1
([ADR-0019](../../docs/adr/0019-embedding-quality-bar.md)). The corpus is built
to expose this: every topic includes at least one phrasing with no lexical
overlap with its siblings.

Over-splitting overall: 59 issues against 25 true topics.

## It changed a default

Running this corpus is what caught
[ADR-0024](../../docs/adr/0024-consolidation-threshold-retuned.md). At the old
consolidation threshold of 0.03 the pass produced a single 53-member cluster
and dropped pairwise precision to 32%. Measuring the same thing on the eval
corpus — which nobody had done — showed the shipped default reaching its
headline 6/10 with 23% precision, from 36 clusters against a truth of 50.

That is the degenerate zone
[ADR-0023](../../docs/adr/0023-rank-agreement-needs-a-conflation-guard.md)
describes, sitting in the shipped default. The threshold is now 0.10, which
matches the rank agreement, nearly doubles the precision, and scores better on
F1 on both corpora.

**A second corpus found in an afternoon what one corpus had hidden for a week.**
That is the argument for this directory existing.

## The data

[`feedback.csv`](feedback.csv) is committed so the demo needs no build step, and
checked against the generator in the tests so the two cannot silently disagree.

| column | notes |
| --- | --- |
| `ticket_id` | `NW-10000`+, chronological |
| `requester_id` | one of 161 accounts |
| `created_at` | within a 120-day window |
| `description` | the feedback |
| `mrr` | account revenue; power-law distributed |
| `type` | `bug` · `feature_request` · `question` · `praise` |
| `page` | route, a structural clustering signal |
| `app_version` | one of 6 releases |
| `source` | `support_inbox` · `nub` · `shake` · `api` |
| `topic` | **the answer key** — the pipeline never sees it |

`topic` exists only so the report can grade itself. Nothing in the product
reads it.

## The figures

Written to `docs/img/` in light and dark variants, from the same run that
prints the report — so a number in the README and a number in a chart cannot
drift apart. They are static SVG because GitHub strips scripts from embedded
SVG, which removes the hover layer a chart would normally carry; every figure
therefore has direct labels and a table beside it in the README instead.

Colours come from a validated palette, checked for colour-vision separation and
surface contrast in both modes before anything was drawn.
