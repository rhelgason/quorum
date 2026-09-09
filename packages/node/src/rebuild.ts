/**
 * Rebuilding a cluster index by replaying the submission log.
 *
 * `ClusterIndex` can serialize itself, and a service could persist it beside
 * the log. This does the other thing, and it is the one to reach for first:
 * **the log is the source of truth, and the index is a cache derived from it.**
 *
 * The replay is exact, not approximate. Leader-follower is deterministic given
 * the same documents in the same order, term statistics evolve identically,
 * and an append-only log preserves order by construction — so replaying
 * produces the assignments ingest originally made, member for member.
 *
 * That buys away an entire category of bug. A persisted index is a second
 * copy of derived state that can be stale, truncated, or written by a build
 * with different defaults, and every one of those failures shows up as a
 * ranked list that is subtly wrong with nothing to compare it against. A
 * rebuilt one cannot disagree with the log because it *is* the log.
 *
 * What it costs is startup time, once, proportional to the corpus. For a
 * self-hosted store of thousands of submissions that is milliseconds. When it
 * stops being, `ClusterIndex.toJSON` is already written and tested and the
 * change is to load it and replay only the tail.
 */

import { ClusterIndex, type ClusterIndexOptions } from '../../aggregate/src/cluster-index.ts';
import { toDoc } from './issues.ts';
import type { SubmissionStore } from './store.ts';

export interface RebuildResult {
  index: ClusterIndex;
  submissions: number;
  clusters: number;
}

/**
 * Replay a project's stored submissions into a fresh index.
 *
 * Order comes from the store, which for an append-only log is arrival order.
 * A store that returned submissions in some other order would still produce a
 * valid clustering, just not the same one — which is why `SubmissionStore.list`
 * documents insertion order as part of its contract rather than an accident.
 */
export async function rebuildIndex(
  store: SubmissionStore,
  projectId: string,
  options: ClusterIndexOptions,
): Promise<RebuildResult> {
  const index = new ClusterIndex(options);
  const submissions = await store.list(projectId);

  for (const submission of submissions) index.add(toDoc(submission));

  return { index, submissions: submissions.length, clusters: index.clusterCount };
}
