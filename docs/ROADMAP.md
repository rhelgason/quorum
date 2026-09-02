# Quorum — Roadmap

> Status: design. Ordering is a claim about risk, not about effort.

The sequencing principle: **build the thing that is hard to copy first, and
defer the thing that only gets valuable at volume.** Clustering forty feedback
items is pointless — a tag filter beats it. The capture client is defensible on
day one.

## v0.1 — Prove the wedge

Goal: a real app can install Quorum in one line and a real engineer can act on
what comes out.

- [ ] `@quorum/core` — types, protocol, offline queue, transport, state machine
- [ ] `@quorum/web` — `<quorum-nub>`, three presets, shadow DOM, ≤15KB gzipped
- [ ] Entrypoints: nub, keyboard shortcut, programmatic `open()`
- [ ] DOM snapshot capture + console ring buffer + network log
- [ ] Redaction: mask-by-default, `data-quorum-redact`, pattern scan
- [ ] Ingest service + `submissions` table + presigned capture upload
- [ ] Minimal dashboard: list, filter by route/version, read a submission

Explicitly **not** in v0.1: clustering, LLM, voting, public roadmap, mobile.

## v0.2 — The web's killer feature

- [ ] Element picker (selector, bbox, computed styles, React component name)
- [ ] Text-selection annotation
- [ ] Frustration score: dead clicks, rage clicks, nav thrash, reload mashing
- [ ] Non-modal nudge at threshold, once per session, dismissible
- [ ] `@quorum/react` wrapper + hooks
- [ ] `identify()` and account weighting plumbed end to end

## v0.3 — Aggregation, the cheap half

Deliberately no text ML. Structural clustering alone is useful and it is what
tells us whether the ML is even needed.

- [ ] Route + version + temporal-burst grouping
- [ ] Regression detection: clusters on one screen *and* one version
- [ ] LSH near-duplicate collapse (SimHash over character shingles)
- [ ] Deterministic ranking: unique users × account weight × recency × growth
- [ ] Medoid labels + TF-IDF tags
- [ ] `@quorum/node` for support-inbox and exception ingest

## v0.4 — Aggregation, the real half

Gated on having a few hundred hand-labeled submissions. Do not start before
the eval set exists.

- [ ] Hand-labeled eval set + ARI / V-measure / pairwise-F1 harness
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
- [ ] Ship → auto-notify subscribers → changelog

## v0.6 — Mobile

- [ ] Native iOS SDK: rage shake, native UI, screenshot redaction pre-buffer
- [ ] Offline queue on device
- [ ] Android after iOS proves the shape

## Later, on demand only

Vue/Svelte/Angular wrappers, React Native, Flutter, hosted public roadmap,
Helm chart, data residency regions, Slack/Teams surfaces.

These are demand-driven on purpose. Thin framework wrappers are also exactly
the kind of well-scoped contribution outside developers submit to an open-core
project, so shipping them ourselves may be actively wasteful.

---

## The failure mode to watch

Web components + four framework wrappers + iOS + Android + React Native +
Flutter + hosted portal is a staggering surface, each with its own release
process and OS-version churn. Spreading thin across platforms before the
capture wedge is proven on one is the single most likely way this dies. **v1 is
web components + React + native iOS.** Everything else waits for someone to ask.
