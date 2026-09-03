# 0017 — The deterministic core is TypeScript; Python only where the models are

**Status:** Accepted · 2026-09-03
**Supersedes:** the "Aggregation → Python" row of
[ARCHITECTURE.md](../ARCHITECTURE.md#stack)

## Context

The original stack table put the whole aggregation layer in Python, on the
reasoning that "the ML ecosystem lives there". Building it revealed that the
reasoning applies to a much smaller slice than the table implied.

## Decision

The deterministic core — normalization, TF-IDF, cosine, incremental centroids,
leader-follower assignment, ranking, medoid selection — is TypeScript, shipped
as `@quorum/aggregate` with zero runtime dependencies.

Python is reserved for what actually needs it: **model inference**, behind a
network or subprocess boundary. Offline HDBSCAN/Leiden consolidation is the
other candidate, since those algorithms have no good JS implementations and
run as a nightly batch where a language boundary costs nothing.

## Consequences

**Why this is the right split:**

- **The online path shares a process with ingest.** Leader-follower assignment
  runs per submission with a sub-100ms budget
  ([DATA-MODEL.md](../DATA-MODEL.md)). A cross-language hop on the hot path
  buys serialization overhead and an extra failure mode for no benefit.
- **The data model would have to exist twice.** Ingest, the SDK, and the
  protocol are TypeScript. A Python aggregator means maintaining a second copy
  of `Submission`, `CaptureEvent`, and the cluster schema, kept in sync by
  discipline. That is exactly the seam bugs live in.
- **None of the core is ML.** TF-IDF, cosine, and a running centroid sum are
  arithmetic. Reaching for numpy to compute a dot product over a sparse map is
  not using the ML ecosystem, it's importing a runtime.
- **It halved the eval loop.** The harness, the corpus, the clusterer, and the
  metrics are one language with one test command and no install step. Three
  roadmap assumptions were overturned by measurement in two days, which
  depended on that loop being fast.
- **Embeddings do not change this.** A MiniLM-class model runs via ONNX
  Runtime in-process, or behind a small Python service, or via any
  OpenAI-compatible embeddings endpoint. That's a pluggable `Embedder`
  interface — the same shape as the LLM provider in
  [ADR-0016](0016-llm-is-config-not-code.md) — not a reason to move clustering.

**What we give up:**

- scikit-learn's metrics as a dependency. We reimplemented ARI, V-measure, and
  pairwise F1 — about 200 lines, pinned against scikit-learn's documented
  outputs in tests. Cheap, and it made the metrics runnable in CI with no
  install.
- HDBSCAN and Leiden. These are genuinely better in Python and we are not
  reimplementing them; the offline tier will cross the boundary.
- Access to the Python data-science workflow for exploratory analysis. Real
  loss, and the mitigation is that the corpus and results are plain JSON that a
  notebook can read.

## Reversal cost

Moderate. The core is pure functions over plain data structures, so porting is
mechanical — but every caller and the test suite would move with it.

## What would change our mind

If the offline consolidation tier grows large enough that most of the
aggregation logic ends up in Python anyway, the split becomes arbitrary and the
online path should follow. Watch the ratio.
