# 0009 — Postgres + pgvector, no second datastore

**Status:** Accepted · 2026-09-02

## Context

The aggregation layer needs vector similarity search. The default reflex is a
dedicated vector database (Pinecone, Weaviate, Qdrant, Milvus). We also need
lexical search (BM25) and ordinary relational queries for submissions, users,
clusters, and votes.

## Decision

One Postgres, with `pgvector` for embeddings and `tsvector`/GIN for lexical
search. No second datastore until Postgres demonstrably can't cope.

## Consequences

- **We already need Postgres.** Submissions, users, clusters, votes, and
  proposals are relational and transactional. Adding a vector DB means a second
  system to operate, back up, secure, and keep consistent — for one index.
- **Hybrid similarity wants a join.** Our scoring combines lexical + semantic +
  structural signals. In one database that's a single query; across two systems
  it's application-level fan-out and merge, with the vector store's results
  needing a round trip back to Postgres for the structural filters anyway.
- **Self-host gets dramatically simpler.** "Run this Postgres" is a story an
  enterprise buyer accepts. "Run this Postgres and this vector database and
  keep them in sync" is one they push back on. Self-host is a core part of the
  enterprise answer ([0005](0005-deterministic-core-llm-at-render-edge.md)), so
  operational simplicity is a product requirement, not a preference.
- **Consistency is free.** Cluster membership and embeddings mutate in the same
  transaction. Split-brain between a relational store and a vector store during
  a merge/split is a genuinely nasty class of bug we simply don't have.
- Costs: pgvector's ANN indexes (`ivfflat`, `hnsw`) are good but not
  best-in-class at very large scale, and index builds are heavier than a
  purpose-built engine's. Recall tuning is more manual.
- Per-project partitioning will be needed before scale bites — every similarity
  query is already scoped to one project, which keeps the effective index size
  far below the total row count.

## Reversal cost

Low. Embeddings are derived data; they can be rebuilt into another store from
`submissions` at any time. This is a deliberately cheap decision to reverse,
which is part of why it's safe to make now.

## What would change our mind

Recall or latency degrading past acceptable at realistic per-project volumes
after partitioning and index tuning. Measure before migrating — the eval
harness should cover retrieval quality, not just clustering quality.
