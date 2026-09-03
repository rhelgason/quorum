/**
 * Offline split proposals — the other half of the repair pass.
 *
 * `consolidate.ts` only merges, and that asymmetry is a real hole:
 * over-splitting is repairable and over-merging is not. Once two genuinely
 * different issues share a cluster, every downstream number is wrong in a way
 * nothing can detect. Their demand is summed, so the merged cluster outranks
 * both; the medoid label describes one of them, so the row *reads* coherent;
 * and the evidence quotes are drawn from both, so a reader skimming the top
 * three sees nothing amiss. A silent, plausible, wrong answer.
 *
 * The demo corpus produces exactly this — a praise ticket absorbed into
 * "mobile app crashes" by aggressive average linkage.
 *
 * Same two rules as merging, for the same reasons:
 *
 * **It proposes; it never applies.** `proposeSplits` and `applySplits` are
 * separate functions so automatic proposing and human acceptance are not
 * reachable through one call (ADR-0018).
 *
 * **Locked clusters are untouchable.** A human who curated a cluster does not
 * get it taken apart by a nightly job.
 */

import { linkageSimilarity } from './consolidate.ts';
import { cosine, type SparseVector } from './vector.ts';

export interface SplitMember {
  id: string;
  vector: SparseVector;
}

export interface SplittableCluster {
  id: string;
  members: readonly SplitMember[];
  /** Human-curated. Never proposed for change. */
  locked?: boolean;
}

export interface SplitProposal {
  clusterId: string;
  /** The two proposed groups. Sorted internally and against each other. */
  groups: [string[], string[]];
  /**
   * Average similarity across the two groups. Low is the evidence: these
   * members are not talking about the same thing.
   */
  crossLinkage: number;
  /** Each group's internal cohesion, aligned with `groups`. */
  withinLinkage: [number, number];
  key: string;
}

export interface SplitOptions {
  /**
   * Propose a split when cross-group average linkage falls below this.
   *
   * Deliberately *lower* than the merge threshold. Splitting a real cluster is
   * more damaging than failing to split a bad one: fragmentation divides
   * demand and drops every piece off the ranked list (ADR-0014), whereas an
   * un-split cluster is at least visible and can be reported. Bias toward
   * leaving things alone.
   */
  threshold: number;
  /** Minimum members on each side. Default 2. */
  minGroupSize?: number;
  /**
   * Require each side to be more cohesive internally than the two are to each
   * other, by at least this margin. Default 0.05.
   *
   * Without it, a cluster of uniformly unrelated items — everything near zero
   * to everything else — splits arbitrarily into two equally incoherent
   * halves. That is noise, not a discovered boundary.
   */
  minCohesionGain?: number;
  /** Proposal keys a human already rejected. */
  rejected?: ReadonlySet<string>;
  /** Cap per run, so a review queue stays reviewable. Default 0 (unlimited). */
  maxProposals?: number;
}

function splitKey(clusterId: string, groups: [string[], string[]]): string {
  return `split:${clusterId}:${groups[0].join(',')}|${groups[1].join(',')}`;
}

/**
 * The two least similar members of a cluster.
 *
 * Seeding on the diameter rather than at random is what makes this
 * deterministic — the same cluster always proposes the same split, so a
 * reviewer who declines one is not shown a slightly different version of it
 * tomorrow. Ties break on id for the same reason.
 */
export function diameterPair(
  members: readonly SplitMember[],
): [SplitMember, SplitMember] | undefined {
  if (members.length < 2) return undefined;

  let worst = Infinity;
  let pair: [SplitMember, SplitMember] | undefined;

  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i] as SplitMember;
      const b = members[j] as SplitMember;
      const similarity = cosine(a.vector, b.vector);
      if (similarity < worst) {
        worst = similarity;
        pair = [a, b];
      }
    }
  }
  return pair;
}

/**
 * Divisive two-way partition: seed on the diameter, assign every member to the
 * nearer seed, then judge the result.
 *
 * One pass, not iterated to convergence. A k-means-style refinement loop would
 * find a *better* boundary, but the question here is not "what is the best
 * split" — it is "is there a boundary obvious enough to show a human". One
 * pass from the extremes answers that, and a proposal a reviewer cannot
 * immediately see the sense of is a proposal that wastes their time.
 */
export function proposeSplits(
  clusters: readonly SplittableCluster[],
  options: SplitOptions,
): SplitProposal[] {
  const minGroupSize = options.minGroupSize ?? 2;
  const minCohesionGain = options.minCohesionGain ?? 0.05;
  const rejected = options.rejected ?? new Set<string>();
  const maxProposals = options.maxProposals ?? 0;

  const proposals: SplitProposal[] = [];

  for (const cluster of clusters) {
    if (cluster.locked === true) continue;
    if (cluster.members.length < minGroupSize * 2) continue;

    const seeds = diameterPair(cluster.members);
    if (seeds === undefined) continue;

    const [seedA, seedB] = seeds;
    const groupA: SplitMember[] = [];
    const groupB: SplitMember[] = [];

    for (const member of cluster.members) {
      const toA = cosine(member.vector, seedA.vector);
      const toB = cosine(member.vector, seedB.vector);
      // Ties go to A, so the partition does not depend on iteration order.
      if (toA >= toB) groupA.push(member);
      else groupB.push(member);
    }

    if (groupA.length < minGroupSize || groupB.length < minGroupSize) continue;

    const vectorsA = groupA.map((m) => m.vector);
    const vectorsB = groupB.map((m) => m.vector);

    const crossLinkage = linkageSimilarity(vectorsA, vectorsB, 'average');
    if (crossLinkage >= options.threshold) continue;

    const withinA = selfLinkage(vectorsA);
    const withinB = selfLinkage(vectorsB);
    if (Math.min(withinA, withinB) < crossLinkage + minCohesionGain) continue;

    // Order the two groups so the key is independent of which seed was found
    // first — a rejection must survive a re-run.
    const idsA = groupA.map((m) => m.id).sort();
    const idsB = groupB.map((m) => m.id).sort();
    const flip = (idsB[0] ?? '') < (idsA[0] ?? '');
    const groups: [string[], string[]] = flip ? [idsB, idsA] : [idsA, idsB];
    const within: [number, number] = flip ? [withinB, withinA] : [withinA, withinB];

    const key = splitKey(cluster.id, groups);
    if (rejected.has(key)) continue;

    proposals.push({ clusterId: cluster.id, groups, crossLinkage, withinLinkage: within, key });
  }

  // Most clearly separable first — lowest cross-linkage is the strongest
  // evidence that a reviewer is looking at two different things.
  proposals.sort((a, b) => a.crossLinkage - b.crossLinkage || a.key.localeCompare(b.key));
  return maxProposals > 0 ? proposals.slice(0, maxProposals) : proposals;
}

export interface OutlierProposal {
  clusterId: string;
  memberId: string;
  /** Mean similarity to every other member. The evidence it does not belong. */
  meanSimilarity: number;
  key: string;
}

export interface OutlierOptions {
  /** Extract a member whose mean similarity to the rest falls below this. */
  maxMeanSimilarity: number;
  /** Never shrink a cluster below this. Default 2. */
  minClusterSize?: number;
  rejected?: ReadonlySet<string>;
  maxProposals?: number;
}

/**
 * Members that do not belong, proposed for extraction one at a time.
 *
 * **This is a different failure from the one `proposeSplits` handles**, and
 * conflating them is why a two-way split alone is not enough. A split assumes
 * the cluster is really *two things*, and requires both sides to be cohesive.
 * The commoner over-merge is one real topic plus a couple of low-information
 * stragglers that shared incidental vocabulary — and those stragglers are
 * unrelated to *each other*, so they are not a second topic and a split
 * correctly refuses to propose one.
 *
 * The demo corpus produces exactly this: a bulk-edit request and an audit-log
 * request both absorbed into "mobile app crashes". Grouping them together
 * would be a third wrong answer; each simply needs to leave.
 *
 * Extracted members become their own single-member clusters, which is the
 * honest representation — one person asked for one thing, and until someone
 * else asks it stays a cluster of one.
 */
export function proposeOutliers(
  clusters: readonly SplittableCluster[],
  options: OutlierOptions,
): OutlierProposal[] {
  const minClusterSize = options.minClusterSize ?? 2;
  const rejected = options.rejected ?? new Set<string>();
  const maxProposals = options.maxProposals ?? 0;

  const proposals: OutlierProposal[] = [];

  for (const cluster of clusters) {
    if (cluster.locked === true) continue;
    if (cluster.members.length <= minClusterSize) continue;

    // Scored once against the original cluster, not recomputed after each
    // extraction. Recomputing would cascade — removing the weakest member
    // raises everyone else's mean, which pulls the next-weakest up toward the
    // cutoff and then past it, and the run's outcome starts depending on how
    // many members happened to be borderline. Scoring once is conservative:
    // it can only ever propose fewer extractions than the cascading version.
    const scored = cluster.members.map((member) => ({
      member,
      mean: meanSimilarityToRest(member, cluster.members),
    }));

    // Weakest first, and stop before the cluster would shrink past the floor.
    // Extracting greedily without that check can dismantle a cluster entirely
    // over one run, which is fragmentation by another name.
    scored.sort((a, b) => a.mean - b.mean || a.member.id.localeCompare(b.member.id));

    let remaining = cluster.members.length;
    for (const { member, mean } of scored) {
      if (remaining <= minClusterSize) break;
      if (mean >= options.maxMeanSimilarity) break;

      const key = `outlier:${cluster.id}:${member.id}`;
      if (rejected.has(key)) continue;

      proposals.push({ clusterId: cluster.id, memberId: member.id, meanSimilarity: mean, key });
      remaining--;
    }
  }

  proposals.sort((a, b) => a.meanSimilarity - b.meanSimilarity || a.key.localeCompare(b.key));
  return maxProposals > 0 ? proposals.slice(0, maxProposals) : proposals;
}

/** Apply accepted extractions. Each member becomes its own cluster. */
export function applyOutliers(
  docIds: readonly string[],
  labels: readonly string[],
  accepted: readonly OutlierProposal[],
): string[] {
  const extracted = new Map<string, { from: string; to: string }>();
  for (const proposal of accepted) {
    extracted.set(proposal.memberId, {
      from: proposal.clusterId,
      // Derived and unique, so the new cluster's provenance stays readable.
      to: `${proposal.clusterId}~${proposal.memberId}`,
    });
  }

  return labels.map((label, i) => {
    const docId = docIds[i];
    if (docId === undefined) return label;
    const move = extracted.get(docId);
    return move !== undefined && label === move.from ? move.to : label;
  });
}

function meanSimilarityToRest(member: SplitMember, all: readonly SplitMember[]): number {
  let sum = 0;
  let count = 0;
  for (const other of all) {
    if (other.id === member.id) continue;
    sum += cosine(member.vector, other.vector);
    count++;
  }
  return count === 0 ? 1 : sum / count;
}

/** Average similarity within a group. A single member is perfectly cohesive. */
function selfLinkage(vectors: readonly SparseVector[]): number {
  if (vectors.length < 2) return 1;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      sum += cosine(vectors[i] as SparseVector, vectors[j] as SparseVector);
      pairs++;
    }
  }
  return pairs === 0 ? 1 : sum / pairs;
}

/**
 * Apply accepted splits to a label array.
 *
 * The first group keeps the original cluster id and the second gets a
 * suffixed one. Keeping one side's identity matters: a cluster that has been
 * ranked, linked to a Jira ticket, and subscribed to should not lose its
 * identity because a third of its members moved out. Which side keeps it is
 * decided by the sorted-group ordering, so it is stable rather than arbitrary.
 */
export function applySplits(
  docIds: readonly string[],
  labels: readonly string[],
  accepted: readonly SplitProposal[],
): string[] {
  // docId → { from, to }, built once so application is linear rather than a
  // scan per proposal. `from` is carried explicitly rather than recovered by
  // stripping the suffix off `to`, which would mangle any cluster id that
  // happens to end in a letter.
  const reassigned = new Map<string, { from: string; to: string }>();
  const suffixCount = new Map<string, number>();

  for (const proposal of accepted) {
    const used = suffixCount.get(proposal.clusterId) ?? 0;
    suffixCount.set(proposal.clusterId, used + 1);
    // 'b', 'c', ... for repeated splits of the same cluster.
    const suffix = String.fromCharCode('b'.charCodeAt(0) + used);
    for (const id of proposal.groups[1]) {
      reassigned.set(id, { from: proposal.clusterId, to: `${proposal.clusterId}${suffix}` });
    }
  }

  return labels.map((label, i) => {
    const docId = docIds[i];
    if (docId === undefined) return label;
    const moved = reassigned.get(docId);
    // Only reassign a doc still sitting in the cluster the proposal was made
    // about — a stale proposal must not drag in a doc that has since moved.
    return moved !== undefined && label === moved.from ? moved.to : label;
  });
}
