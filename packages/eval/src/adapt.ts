/**
 * Adapters between the corpus schema and `@quorum/aggregate` inputs.
 *
 * Kept in one place so the aggregation core never depends on the eval package
 * or on the corpus JSON shape — real ingest will build the same structures
 * from Postgres rows.
 */

import type { Doc } from '../../aggregate/src/cluster.ts';
import type { RankableCluster, RankMember, SubmissionKind } from '../../aggregate/src/rank.ts';
import type { Submission } from './corpus.ts';

export function toDocs(submissions: readonly Submission[]): Doc[] {
  return submissions.map((s) => ({
    id: s.id,
    text: s.body,
    route: s.route,
    appVersion: s.appVersion,
    platform: s.platform,
  }));
}

/**
 * Attach precomputed vectors to docs, index-aligned.
 *
 * Separate from {@link toDocs} because embedding is async and batched while
 * `toDocs` is neither, and because a sweep reuses one set of vectors across
 * every configuration it tries.
 *
 * Throws on a length mismatch rather than zipping what it can. A short vector
 * array would silently leave the tail of the corpus lexical-only, and the
 * result would look like a model that helps less than it does.
 */
export function withVectors(docs: readonly Doc[], vectors: readonly Float64Array[]): Doc[] {
  if (docs.length !== vectors.length) {
    throw new Error(
      `expected one vector per doc: got ${String(vectors.length)} for ${String(docs.length)} docs`,
    );
  }
  return docs.map((doc, i) => ({ ...doc, vector: vectors[i] as Float64Array }));
}

export function toRankMember(s: Submission): RankMember {
  return { userId: s.userId, kind: s.kind as SubmissionKind, clientTs: s.clientTs };
}

/** Group submissions by predicted label into rankable clusters. */
export function toRankableClusters(
  submissions: readonly Submission[],
  labels: readonly string[],
): RankableCluster[] {
  const groups = new Map<string, RankMember[]>();
  for (let i = 0; i < submissions.length; i++) {
    const label = labels[i] as string;
    const member = toRankMember(submissions[i] as Submission);
    const bucket = groups.get(label);
    if (bucket === undefined) groups.set(label, [member]);
    else bucket.push(member);
  }
  return [...groups.entries()].map(([id, members]) => ({ id, members }));
}

/** Cluster label → member submission ids, for pulling evidence quotes. */
export function groupSubmissionIds(
  submissions: readonly Submission[],
  labels: readonly string[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (let i = 0; i < submissions.length; i++) {
    const label = labels[i] as string;
    const bucket = groups.get(label);
    if (bucket === undefined) groups.set(label, [(submissions[i] as Submission).id]);
    else bucket.push((submissions[i] as Submission).id);
  }
  return groups;
}
