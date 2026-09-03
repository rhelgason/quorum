# Quorum — Roadmap

> Status: design. Ordering is a claim about risk, not about effort.

The sequencing principle, per
[ADR-0012](adr/0012-prioritization-is-the-product.md): **a team's first session
with Quorum must end with a ranked list.** Not a feed of submissions, not a
screenshot inbox — an ordered answer to "what should we build next," with the
evidence behind each row.

That rules out the tempting build order where aggregation waits for volume. A
team with 200 pieces of feedback still doesn't know what's important.

> **Revised after measurement.** v0.1 originally assumed structural grouping
> (route + version + burst) alone would produce that ranked list. The eval
> harness says otherwise: precision 1.000 on release-burst bug clusters, but
> ARI 0.023 on feature requests, which are the majority of what ranking is for.
> Structural grouping ships as regression *detection*; the ranked list needs
> text similarity. See
> [ADR-0013](adr/0013-structural-clustering-is-a-regression-detector.md).

## v0.1 — A ranked list from data you already have

Goal: a team imports their support inbox and gets a defensible top ten. No
widget required to see value.

- [ ] `@quorum/core` — types, protocol, offline queue, transport, state machine
- [ ] `@quorum/node` — support-inbox, exception, and CSV ingest. **First**, not last.
- [ ] Ingest service + `submissions` table + presigned capture upload
- [ ] LSH near-duplicate collapse (SimHash over character shingles)
- [ ] **Lexical clustering (BM25 / TF-IDF)** — has to carry the ranked list now
      that structural grouping is known not to
- [ ] Structural grouping shipped as **regression alerting**, not as ranking:
      "12 reports from /receipts/scan, iOS 4.12.0, in 72 hours"
- [ ] Deterministic ranking: unique users × account weight × recency × growth
- [ ] Medoid labels + TF-IDF tags — no LLM, no embeddings
- [ ] Ranked dashboard with **score explainability** — every row shows why it
      ranks where it does, and drills into the verbatim submissions

Import-first is deliberate. It proves the claim on the customer's own data
instead of asking them to collect for six months first.

Open risk: if lexical clustering also underperforms on the eval corpus, local
embeddings move from v0.4 into v0.1 and the "no ML in v1" simplification is
gone. Measure before committing to the simpler story.

## v0.2 — Capture that feeds better ranking

Every item here exists because it produces a ranking signal a plain feedback
form can't.

- [ ] `@quorum/web` — `<quorum-nub>`, three presets, shadow DOM, ≤15KB gzipped
- [ ] Entrypoints: nub, keyboard shortcut, programmatic `open()`
- [ ] `identify()` and account weighting plumbed end to end — this is what makes
      ranking revenue-weighted instead of a popularity contest
- [ ] Route and version tagging on every submission (the structural signal)
- [ ] DOM snapshot + console ring buffer + network log
- [ ] Redaction: mask-by-default, `data-quorum-redact`, pattern scan
- [ ] `@quorum/react` wrapper + hooks

## v0.3 — Sharper signal

- [ ] Element picker (selector, bbox, computed styles, React component name)
- [ ] Text-selection annotation
- [ ] Frustration score: dead clicks, rage clicks, nav thrash, reload mashing
- [ ] Non-modal nudge at threshold, once per session, dismissible
- [ ] Frustration intensity as a ranking input — behavioral signal beats
      inferred sentiment
- [ ] Regression detection: clusters on one screen *and* one version

## v0.4 — Semantic clustering

The harness exists ([`packages/eval`](../packages/eval/README.md)) but its
corpus is synthetic, which validates implementations rather than approaches.
**Replacing it with real labeled data is the highest-leverage task in this
track** — do not treat any threshold as tuned until that lands.

- [ ] Local sentence embeddings + pgvector
- [ ] Hybrid similarity (BM25 + cosine + structural), weights tuned on eval
- [ ] Online leader-follower assignment with incremental centroids
- [ ] Nightly HDBSCAN/Leiden re-consolidation → human-gated proposals
- [ ] Merge/split UI, `locked` clusters

## v0.5 — Close the loop

- [ ] LLM render edge: title + eng spec, cached on composition hash
- [ ] Mandatory quote drill-down on every generated line
- [ ] BYO-model config; graceful degradation to medoid when absent
- [ ] Jira / Linear / GitHub write-back with spec, quotes, user count, repro
- [ ] Ship → notify subscribers → changelog

## v0.6 — Mobile

- [ ] Native iOS SDK: rage shake, native UI, screenshot redaction pre-buffer
- [ ] Offline queue on device
- [ ] Android after iOS proves the shape

## Later, on demand only

Vue/Svelte/Angular wrappers, React Native, Flutter, Helm chart, data residency
regions, Slack/Teams surfaces.

Demand-driven on purpose. Thin framework wrappers are also exactly the kind of
well-scoped contribution outside developers submit to an open-core project, so
shipping them ourselves may be actively wasteful.

## Explicitly not building

- **A public roadmap / end-user voting portal.** See
  [ADR-0011](adr/0011-no-public-roadmap.md) — it's the commodity part of this
  category and it turns weighted prioritization back into a popularity contest.

---

## The failure mode to watch

Web components + four framework wrappers + iOS + Android + React Native +
Flutter is a staggering surface, each with its own release process and
OS-version churn. Spreading thin before the ranked list is proven useful on one
platform is the single most likely way this dies.

**v1 is web components + React + native iOS.** Everything else waits for
someone to ask.
