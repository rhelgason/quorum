/**
 * Offline consolidation — repairing fragmentation the online pass caused.
 *
 * Leader-follower assignment is stable by construction, and it pays for that
 * with order dependence and a conservative threshold: an item that arrives
 * before its natural cluster exists seeds a rival cluster, and the two never
 * reconcile. [ADR-0014](../../../docs/adr/0014-rank-agreement-is-the-eval-target.md)
 * measured what that costs — splitting one issue into four pure fragments
 * barely dents ARI, but divides its demand by four and drops every fragment
 * off the ranked list.
 *
 * This module is the repair pass. Two rules govern it:
 *
 * **It proposes; it never applies.** Auto-applied merges silently undo human
 * curation, and a PM who loses an afternoon's work to a nightly job stops
 * trusting the tool permanently
 * ([ADR-0005](../../../docs/adr/0005-deterministic-core-llm-at-render-edge.md)).
 * Every proposal carries the evidence a reviewer needs to disagree with it.
 *
 * **Average linkage, never single linkage.** This is the difference between
 * repairing fragmentation and destroying the clustering — see below.
 */

import { cosine, type SparseVector } from './vector.ts';

export interface ClusterView {
  id: string;
  /** Member vectors. Linkage is computed over these, not over a centroid. */
  vectors: readonly SparseVector[];
  /** Human-curated. Never proposed for change. */
  locked?: boolean;
}

export type Linkage = 'average' | 'complete' | 'single';

export interface MergeProposal {
  /** Clusters to merge, sorted for a stable identity. */
  clusterIds: string[];
  /** Linkage similarity at the moment the merge was proposed. */
  similarity: number;
  /** Member counts, aligned with `clusterIds`. */
  sizes: number[];
  /**
   * Stable key for remembering a rejection. The nightly job must not
   * re-propose a merge a human already declined — that trains people to
   * ignore the queue, which is worse than not having one.
   */
  key: string;
}

export interface ConsolidateOptions {
  /**
   * Linkage similarity required to propose a merge.
   *
   * Deliberately separate from the online assignment threshold, and normally
   * *lower*. Cluster-to-cluster evidence is far stronger than the
   * item-to-centroid evidence the online pass has: ten items agreeing with ten
   * items is not the same claim as one item agreeing with a centroid.
   */
  threshold: number;
  /** Default `'average'`. See the linkage note. */
  linkage?: Linkage;
  /**
   * Refuse to merge when one side is this many times larger than the other.
   * Default 0 (off).
   *
   * A 40-member cluster absorbing a singleton is usually swallowing noise
   * rather than reuniting a fragment, and it is the merge a reviewer is least
   * able to sanity-check.
   */
  maxSizeRatio?: number;
  /** Proposal keys a human already rejected. */
  rejected?: ReadonlySet<string>;
  /** Cap on merges per run, so a review queue stays reviewable. Default 0 (unlimited). */
  maxProposals?: number;
}

function proposalKey(ids: readonly string[]): string {
  return [...ids].sort().join('+');
}

/**
 * Similarity between two groups of vectors.
 *
 * - `single` — the best pair. **Chains catastrophically**: A~B and B~C merges
 *   A with C even when A and C share nothing, so one vague submission can
 *   bridge two unrelated issues. The corpus has a `vague-bridge` trap built
 *   for exactly this.
 * - `average` — the mean over all cross pairs. One accidental near-match
 *   cannot carry a merge, so it resists the bridge while still recognising
 *   genuine fragments. The default.
 * - `complete` — the worst pair. Very conservative; useful when precision
 *   matters more than repair.
 */
export function linkageSimilarity(
  a: readonly SparseVector[],
  b: readonly SparseVector[],
  linkage: Linkage,
): number {
  if (a.length === 0 || b.length === 0) return 0;

  let sum = 0;
  let best = -Infinity;
  let worst = Infinity;

  for (const va of a) {
    for (const vb of b) {
      const s = cosine(va, vb);
      sum += s;
      if (s > best) best = s;
      if (s < worst) worst = s;
    }
  }

  if (linkage === 'single') return best;
  if (linkage === 'complete') return worst;
  return sum / (a.length * b.length);
}

/**
 * Greedy agglomerative merging: repeatedly join the most similar pair, then
 * recompute against the merged group, until nothing clears the threshold.
 *
 * Recomputing after each merge is what keeps average linkage honest. Scoring
 * every pair once up front and merging them all would let two clusters join
 * transitively without their combined similarity ever being checked — single
 * linkage by the back door.
 */
export function proposeMerges(
  clusters: readonly ClusterView[],
  options: ConsolidateOptions,
): MergeProposal[] {
  const linkage = options.linkage ?? 'average';
  const maxSizeRatio = options.maxSizeRatio ?? 0;
  const rejected = options.rejected ?? new Set<string>();
  const maxProposals = options.maxProposals ?? 0;

  // Locked clusters are excluded entirely: the offline tier may not touch what
  // a human has curated.
  const open = clusters.filter((c) => c.locked !== true && c.vectors.length > 0);

  interface Group {
    ids: string[];
    vectors: SparseVector[];
  }
  let groups: Group[] = open.map((c) => ({ ids: [c.id], vectors: [...c.vectors] }));

  const proposals: MergeProposal[] = [];

  for (;;) {
    let bestScore = -Infinity;
    let bestPair: [number, number] | undefined;

    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const gi = groups[i] as Group;
        const gj = groups[j] as Group;

        if (maxSizeRatio > 0) {
          const large = Math.max(gi.vectors.length, gj.vectors.length);
          const small = Math.min(gi.vectors.length, gj.vectors.length);
          if (large / small > maxSizeRatio) continue;
        }

        const merged = proposalKey([...gi.ids, ...gj.ids]);
        if (rejected.has(merged)) continue;

        const score = linkageSimilarity(gi.vectors, gj.vectors, linkage);
        if (score > bestScore) {
          bestScore = score;
          bestPair = [i, j];
        }
      }
    }

    if (bestPair === undefined || bestScore < options.threshold) break;

    const [i, j] = bestPair;
    const gi = groups[i] as Group;
    const gj = groups[j] as Group;
    const ids = [...gi.ids, ...gj.ids].sort();

    proposals.push({
      clusterIds: ids,
      similarity: bestScore,
      sizes: [gi.vectors.length, gj.vectors.length],
      key: proposalKey(ids),
    });

    groups = groups.filter((_, idx) => idx !== i && idx !== j);
    groups.push({ ids, vectors: [...gi.vectors, ...gj.vectors] });

    if (maxProposals > 0 && proposals.length >= maxProposals) break;
  }

  // Strongest evidence first, so a reviewer working top-down spends their
  // attention where it is most likely to be well spent.
  proposals.sort((a, b) => b.similarity - a.similarity || a.key.localeCompare(b.key));
  return proposals;
}

/**
 * Apply accepted proposals to a label array.
 *
 * Separate from `proposeMerges` on purpose: proposing is automatic, applying
 * is a human decision, and the two must not be reachable through one call.
 * Merged clusters take the alphabetically first id so the result is stable.
 */
export function applyMerges(
  labels: readonly string[],
  accepted: readonly MergeProposal[],
): string[] {
  // Union-find over cluster ids, so overlapping proposals compose correctly
  // instead of the last one winning.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (p === undefined || p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Lower id wins, keeping output independent of proposal order.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (const proposal of accepted) {
    const [first, ...rest] = proposal.clusterIds;
    if (first === undefined) continue;
    if (!parent.has(first)) parent.set(first, first);
    for (const id of rest) {
      if (!parent.has(id)) parent.set(id, id);
      union(first, id);
    }
  }

  return labels.map((l) => find(l));
}
