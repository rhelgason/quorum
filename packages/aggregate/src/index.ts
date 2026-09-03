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

export { applyOutliers, applySplits, diameterPair, proposeOutliers, proposeSplits } from './split.ts';
export type {
  OutlierOptions,
  OutlierProposal,
  SplitMember,
  SplitOptions,
  SplitProposal,
  SplittableCluster,
} from './split.ts';

export {
  bandKeys,
  candidateBlocks,
  hammingDistance,
  nearDuplicateGroups,
  shingles,
  simhash,
  simhashSimilarity,
  SIMHASH_BITS,
} from './lsh.ts';
export type { BlockOptions, LshDoc, NearDuplicateOptions } from './lsh.ts';

export { applyMerges, linkageSimilarity, proposeMerges } from './consolidate.ts';
export type {
  ClusterView,
  ConsolidateOptions,
  Linkage,
  MergeProposal,
} from './consolidate.ts';
export type { ClusterAssignment, ClusterOptions, ClusterResult, Doc } from './cluster.ts';

export {
  createOpenAICompatibleEmbedder,
  DenseCentroid,
  denseCosine,
  embedderFromEnv,
  normalizeDense,
  QuorumEmbedError,
} from './embed.ts';
export type { EmbedEnv, Embedder, OpenAICompatibleEmbedderConfig } from './embed.ts';

export {
  createOpenAICompatibleProvider,
  nullProvider,
  providerFromEnv,
  QuorumLlmError,
} from './llm.ts';
export type {
  GenerateRequest,
  GenerateResult,
  LlmEnv,
  LlmProvider,
  OpenAICompatibleConfig,
} from './llm.ts';

export { accountWeight, explain, growthMultiplier, rank, recencyDecay } from './rank.ts';
export type {
  RankableCluster,
  RankedCluster,
  RankMember,
  RankOptions,
  ScoreComponents,
  SubmissionKind,
} from './rank.ts';
