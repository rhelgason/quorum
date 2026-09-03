/**
 * `@quorum/aggregate` — the deterministic aggregation core.
 *
 * Clustering and ranking with no model in the loop and zero runtime
 * dependencies. The LLM sits downstream of everything here, at the render
 * edge, and is optional — see
 * `docs/adr/0005-deterministic-core-llm-at-render-edge.md`.
 */

export { normalize, stem, tokenize, STOPWORDS } from './text.ts';
export type { TokenizeOptions } from './text.ts';

export { buildIdf, Centroid, cosine, l2Normalize, vectorize } from './vector.ts';
export type { IdfTable, SparseVector } from './vector.ts';

export { clusterDocs, medoid } from './cluster.ts';
export type { ClusterAssignment, ClusterOptions, ClusterResult, Doc } from './cluster.ts';

export { accountWeight, explain, growthMultiplier, rank, recencyDecay } from './rank.ts';
export type {
  RankableCluster,
  RankedCluster,
  RankMember,
  RankOptions,
  ScoreComponents,
  SubmissionKind,
} from './rank.ts';
