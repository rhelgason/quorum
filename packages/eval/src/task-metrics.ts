/**
 * Task-level evaluation: does the **ranked list** come out right?
 *
 * ARI, F1, and V-measure score a clustering. They are not what the product
 * delivers. A team opens Quorum and reads a top ten, so the honest question is
 * "how much of the correct top ten survives this clustering", and that is not
 * a monotone function of ARI.
 *
 * The failure mode this exists to catch is **fragmentation**. Splitting
 * `dark-mode` into four clusters of two or three barely dents precision — each
 * fragment is internally pure — but it divides that issue's demand by four and
 * drops all four fragments off the front page. The team never sees the thing
 * most users asked for. Aggregate clustering metrics rate that outcome as
 * middling; the product is simply wrong.
 *
 * So: optimize this, and use the clustering metrics as diagnostics for *why*
 * it moved.
 */

import type { Corpus } from './corpus.ts';
import { rank, type RankableCluster, type RankMember, type SubmissionKind } from '../../aggregate/src/rank.ts';

export interface TopKReport {
  k: number;
  /** Truth top-k cluster ids, best first. */
  truthTop: string[];
  /**
   * Predicted top-k, each labeled by the truth cluster holding a plurality of
   * its members — the fairest reading of "what issue is this cluster about".
   */
  predictedTop: string[];
  /** Truth top-k issues that appear anywhere in the predicted top-k. */
  hits: string[];
  misses: string[];
  /** |hits| / k. The headline number. */
  recallAtK: number;
  /**
   * Fraction of the truth issue's members captured by the single predicted
   * cluster that represents it, averaged over hits. Low values mean the issue
   * surfaced but badly fragmented, so its rank is understated.
   */
  meanCapture: number;
}

function toMembers(corpus: Corpus, ids: readonly string[]): RankMember[] {
  const byId = new Map(corpus.submissions.map((s) => [s.id, s]));
  const out: RankMember[] = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (s === undefined) continue;
    out.push({ userId: s.userId, kind: s.kind as SubmissionKind, clientTs: s.clientTs });
  }
  return out;
}

function groupIds(labels: readonly string[], ids: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < labels.length; i++) {
    const key = labels[i] as string;
    const bucket = out.get(key);
    if (bucket === undefined) out.set(key, [ids[i] as string]);
    else bucket.push(ids[i] as string);
  }
  return out;
}

/**
 * @param now  evaluation time; ranking requires an explicit clock so results
 *             are reproducible across runs
 */
export function topKAgreement(
  corpus: Corpus,
  predicted: readonly string[],
  k: number,
  now: string,
): TopKReport {
  if (predicted.length !== corpus.submissions.length) {
    throw new Error(
      `predicted labels must align with submissions: got ${predicted.length}, expected ${corpus.submissions.length}`,
    );
  }

  const ids = corpus.submissions.map((s) => s.id);
  const truthLabel = new Map(corpus.submissions.map((s) => [s.id, s.cluster]));

  const truthGroups = groupIds(corpus.submissions.map((s) => s.cluster), ids);
  const predGroups = groupIds(predicted, ids);

  const toRankable = (groups: Map<string, string[]>): RankableCluster[] =>
    [...groups.entries()].map(([id, members]) => ({ id, members: toMembers(corpus, members) }));

  const truthRanked = rank(toRankable(truthGroups), { now });
  const predRanked = rank(toRankable(predGroups), { now });

  const truthTop = truthRanked.slice(0, k).map((r) => r.id);

  // Identify each predicted cluster by the truth cluster holding a plurality
  // of its members. Ties break by name so the report is stable across runs.
  const identify = (clusterId: string): string => {
    const members = predGroups.get(clusterId) ?? [];
    const counts = new Map<string, number>();
    for (const id of members) {
      const t = truthLabel.get(id);
      if (t !== undefined) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    let bestLabel = '';
    let bestCount = -1;
    for (const [label, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (count > bestCount) {
        bestCount = count;
        bestLabel = label;
      }
    }
    return bestLabel;
  };

  const predictedTop = predRanked.slice(0, k).map((r) => identify(r.id));
  const predictedTopSet = new Set(predictedTop);

  const hits = truthTop.filter((t) => predictedTopSet.has(t));
  const misses = truthTop.filter((t) => !predictedTopSet.has(t));

  // Capture: of the truth issue's members, what share landed in the single
  // biggest predicted cluster representing it.
  let captureSum = 0;
  for (const t of hits) {
    const truthMembers = truthGroups.get(t) ?? [];
    if (truthMembers.length === 0) continue;
    const spread = new Map<string, number>();
    for (const id of truthMembers) {
      const p = predicted[ids.indexOf(id)] as string;
      spread.set(p, (spread.get(p) ?? 0) + 1);
    }
    captureSum += Math.max(...spread.values()) / truthMembers.length;
  }

  return {
    k,
    truthTop,
    predictedTop,
    hits,
    misses,
    recallAtK: truthTop.length === 0 ? 1 : hits.length / truthTop.length,
    meanCapture: hits.length === 0 ? 0 : captureSum / hits.length,
  };
}
