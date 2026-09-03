# Quorum — Roadmap

> Status: design. Ordering is a claim about risk, not about effort.

The sequencing principle, per
[ADR-0012](adr/0012-prioritization-is-the-product.md): **a team's first session
with Quorum must end with a ranked list.** Not a feed of submissions, not a
screenshot inbox — an ordered answer to "what should we build next," with the
evidence behind each row.

That rules out the tempting build order where aggregation waits for volume. A
team with 200 pieces of feedback still doesn't know what's important.

> **Revised twice, both times by measurement.**
>
> Structural grouping (route + version + burst) turned out to be a precise
> regression detector and useless for feature requests — ARI 0.023 on the
> majority of what ranking is for
> ([ADR-0013](adr/0013-structural-clustering-is-a-regression-detector.md)).
>
> Lexical clustering, built to replace it, is 2.3× better but still recovers
> only 5 of the correct top 10. **Embeddings move into v0.1 and the "v1 with no
> ML" plan is dead.** The eval target also changed: tuning on ARI picks a
> *worse* ranked list than tuning on rank agreement
> ([ADR-0014](adr/0014-rank-agreement-is-the-eval-target.md)).

## v0.1 — A ranked list from data you already have

Goal: a team imports their support inbox and gets a defensible top ten. No
widget required to see value.

- [ ] `@quorum/core` — types, protocol, offline queue, transport, state machine
- [ ] `@quorum/node` — support-inbox, exception, and CSV ingest. **First**, not last.
- [ ] Ingest service + `submissions` table + presigned capture upload
- [ ] LSH near-duplicate collapse (SimHash over character shingles)
- [x] **Lexical clustering (TF-IDF cosine + leader-follower)** — shipped in
      `@quorum/aggregate`. Necessary, not sufficient: 5/10 rank agreement.
- [ ] **Local sentence embeddings + hybrid similarity** — promoted from v0.4.
      Lexical cannot bridge "add dark mode" ↔ "the app destroys my eyes at
      night", and `dark-mode` is the largest issue in the corpus.
- [ ] Pluggable embedder interface, absent-by-default like the LLM provider
- [x] Offline consolidation to repair online over-splitting — raises the
      lexical ceiling from 5/10 to 6/10 and makes a high online threshold the
      right default ([ADR-0018](adr/0018-two-tier-clustering-validated.md))
- [ ] Structural grouping shipped as **regression alerting**, not as ranking:
      "12 reports from /receipts/scan, iOS 4.12.0, in 72 hours"
- [x] Deterministic ranking: unique users × account weight × recency × growth,
      with log-scaled weighting and a growth volume floor
      ([ADR-0015](adr/0015-log-scaled-account-weight.md))
- [x] Medoid labels — no LLM required, ever
      ([ADR-0016](adr/0016-llm-is-config-not-code.md))
- [ ] Ranked dashboard with **score explainability** — every row shows why it
      ranks where it does, and drills into the verbatim submissions

Import-first is deliberate. It proves the claim on the customer's own data
instead of asking them to collect for six months first.

That open risk has now been measured and it landed on the bad side: lexical
clustering underperformed, so embeddings are in v0.1 and the "no ML in v1"
simplification is gone.

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

## v0.4 — Clustering quality

Embeddings moved to v0.1. What remains here is the offline tier and the
consolidation loop.

The harness exists ([`packages/eval`](../packages/eval/README.md)) but its
corpus is synthetic, which validates implementations rather than approaches.
**Replacing it with real labeled data is the highest-leverage task in this
track** — do not treat any threshold as tuned until that lands.

- [ ] pgvector persistence for embeddings
- [ ] Hybrid weights (lexical : semantic : structural) tuned on rank agreement
- [x] Online leader-follower assignment with incremental centroids
- [x] Offline consolidation: agglomerative merge proposals, average linkage,
      human-gated, with rejection memory and `locked` clusters respected
      ([ADR-0018](adr/0018-two-tier-clustering-validated.md))
- [ ] HDBSCAN/Leiden as an alternative offline pass (Python)
- [ ] Split proposals — only merges are implemented
- [ ] Merge/split review UI

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
