/**
 * Deterministic, explainable ranking.
 *
 * ```
 * score = Σ_uniqueUsers( accountWeight(u) × recencyDecay(t_u) ) × growthMultiplier
 * ```
 *
 * No model anywhere in this file. Every number a user sees can be traced to
 * inputs, which is required rather than nice: if the ranked list *is* the
 * product (`docs/adr/0012-prioritization-is-the-product.md`), a reader who
 * can't see why item #3 is #3 has no reason to believe any of it.
 *
 * Four opinions are baked in, each of which changes what the product optimizes
 * for. They are stated here because they are judgment calls, not derivations.
 */

export type SubmissionKind = 'feature_request' | 'bug' | 'praise' | 'question' | 'rage';

export interface RankMember {
  userId: string;
  kind: SubmissionKind;
  /** ISO timestamp. Must be client time, not server receipt time. */
  clientTs: string;
  /** Monthly recurring revenue for the account, if known. */
  mrr?: number;
}

export interface RankableCluster {
  id: string;
  members: readonly RankMember[];
}

export interface ScoreComponents {
  /** Distinct users, not submissions. */
  uniqueUsers: number;
  submissions: number;
  /** Sum of per-user weight × decay. */
  weightedDemand: number;
  growthMultiplier: number;
  /** Unique users in the trailing window. */
  recentUsers: number;
  /** Unique users in the window before that. */
  priorUsers: number;
  /** True when growth was suppressed for lack of volume. */
  growthSuppressed: boolean;
  meanAccountWeight: number;
  newestTs: string;
  oldestTs: string;
}

export interface RankedCluster {
  id: string;
  score: number;
  components: ScoreComponents;
}

export interface RankOptions {
  /** Evaluation time. Required — ranking must be reproducible, so no implicit clock. */
  now: Date | string | number;
  /** Days for demand to halve. Default 60. */
  halfLifeDays?: number;
  /** Trailing window for growth, in days. Default 7. */
  growthWindowDays?: number;
  /**
   * Minimum unique users in the prior window before growth applies. Default 3.
   * See "volume floor" below.
   */
  growthMinVolume?: number;
  /** Growth is clamped to this. Default 3. */
  maxGrowth?: number;
  /** MRR producing one extra unit of weight per decade. Default 100. */
  mrrBaseline?: number;
  /**
   * Kinds excluded from the ranked build list. Default `['praise']`.
   * See "praise is not work" below.
   */
  excludeKinds?: readonly SubmissionKind[];
}

const DAY_MS = 86_400_000;

/**
 * Kinds kept out of the ranked build list by default. See "praise is not work".
 *
 * Exported because anything *presenting* a ranked issue has to apply the same
 * rule ranking did. A presentation layer that filters differently will show a
 * title, an evidence quote, or a member count drawn from submissions that were
 * excluded from the score — numbers and words that disagree with each other in
 * the same row.
 */
export const DEFAULT_EXCLUDED_KINDS: readonly SubmissionKind[] = ['praise'];

/**
 * **Opinion 1 — account weight is logarithmic, not linear.**
 *
 * Linear MRR weighting makes the product answer "what does our biggest
 * customer want", not "what's important". One $10k/month account would
 * outvote a hundred free users, and a roadmap tool that always returns the
 * whale's request is one nobody needs to run.
 *
 * `1 + log10(1 + mrr / baseline)`: $0 → 1.0, $100 → 1.30, $1k → 2.04,
 * $10k → 3.00, $100k → 4.00. Revenue still orders the list, but a whale counts
 * as roughly three users rather than a hundred, so it takes a genuine cohort
 * to outweigh a large group of small accounts. Ordering is preserved;
 * domination is not.
 */
export function accountWeight(mrr: number | undefined, baseline = 100): number {
  if (mrr === undefined || mrr <= 0) return 1;
  return 1 + Math.log10(1 + mrr / baseline);
}

/** Exponential decay on client time. 1.0 at now, 0.5 at one half-life. */
export function recencyDecay(ageDays: number, halfLifeDays: number): number {
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * **Opinion 2 — growth needs a volume floor.**
 *
 * The second derivative is what a PM actually wants: a cluster that tripled
 * this week beats a bigger one flat for six months. But unguarded ratios are
 * dominated by noise at small n — one user last week and three this week is
 * "200% growth" on evidence of three people, and those clusters would occupy
 * the entire top of the list.
 *
 * So growth only applies once the prior window clears `growthMinVolume`.
 * Below that the multiplier is exactly 1 and `growthSuppressed` is reported,
 * so the UI can say why rather than showing an unexplained number.
 */
export function growthMultiplier(
  recentUsers: number,
  priorUsers: number,
  minVolume: number,
  maxGrowth: number,
): { multiplier: number; suppressed: boolean } {
  if (priorUsers < minVolume) return { multiplier: 1, suppressed: true };
  const raw = recentUsers / priorUsers;
  return { multiplier: Math.min(raw, maxGrowth), suppressed: false };
}

/**
 * **Opinion 3 — unique users, never submission counts.**
 *
 * Counting submissions means one motivated person filing twenty tickets
 * outranks twenty people filing one each. That is backwards, and it is also
 * the entire spam surface of a public feedback tool. A user's weight is taken
 * from their *most recent* submission in the cluster, so re-filing makes
 * someone more recent, never louder.
 *
 * **Opinion 4 — praise is not work.**
 *
 * Praise clusters and ranks like anything else, but it is excluded from the
 * build list by default. "The scanner is magic" topping the roadmap is a bug,
 * not a delightful surprise. It belongs on its own surface. `question` is
 * *not* excluded: confusion is real work, just usually docs or UX rather than
 * engineering.
 */
export function rank(
  clusters: readonly RankableCluster[],
  options: RankOptions,
): RankedCluster[] {
  const now = new Date(options.now).getTime();
  if (Number.isNaN(now)) throw new Error(`invalid 'now': ${String(options.now)}`);

  const halfLifeDays = options.halfLifeDays ?? 60;
  const growthWindowDays = options.growthWindowDays ?? 7;
  const growthMinVolume = options.growthMinVolume ?? 3;
  const maxGrowth = options.maxGrowth ?? 3;
  const mrrBaseline = options.mrrBaseline ?? 100;
  const excluded = new Set(options.excludeKinds ?? DEFAULT_EXCLUDED_KINDS);

  const ranked: RankedCluster[] = [];

  for (const cluster of clusters) {
    const members = cluster.members.filter((m) => !excluded.has(m.kind));
    if (members.length === 0) continue;

    // Latest submission per user: weight follows the freshest evidence.
    const latestByUser = new Map<string, RankMember>();
    for (const m of members) {
      const ts = Date.parse(m.clientTs);
      if (Number.isNaN(ts)) throw new Error(`invalid clientTs on cluster ${cluster.id}: ${m.clientTs}`);
      const existing = latestByUser.get(m.userId);
      if (existing === undefined || ts > Date.parse(existing.clientTs)) {
        latestByUser.set(m.userId, m);
      }
    }

    let weightedDemand = 0;
    let weightSum = 0;
    let recentUsers = 0;
    let priorUsers = 0;
    let newest = -Infinity;
    let oldest = Infinity;

    for (const m of latestByUser.values()) {
      const ts = Date.parse(m.clientTs);
      const ageDays = (now - ts) / DAY_MS;
      const weight = accountWeight(m.mrr, mrrBaseline);

      weightedDemand += weight * recencyDecay(ageDays, halfLifeDays);
      weightSum += weight;

      if (ageDays >= 0 && ageDays < growthWindowDays) recentUsers++;
      else if (ageDays >= growthWindowDays && ageDays < growthWindowDays * 2) priorUsers++;

      if (ts > newest) newest = ts;
      if (ts < oldest) oldest = ts;
    }

    const uniqueUsers = latestByUser.size;
    const growth = growthMultiplier(recentUsers, priorUsers, growthMinVolume, maxGrowth);

    ranked.push({
      id: cluster.id,
      score: weightedDemand * growth.multiplier,
      components: {
        uniqueUsers,
        submissions: members.length,
        weightedDemand,
        growthMultiplier: growth.multiplier,
        recentUsers,
        priorUsers,
        growthSuppressed: growth.suppressed,
        meanAccountWeight: uniqueUsers === 0 ? 0 : weightSum / uniqueUsers,
        newestTs: new Date(newest).toISOString(),
        oldestTs: new Date(oldest).toISOString(),
      },
    });
  }

  // Ties broken by id so the list is stable across runs — an unstable ordering
  // is indistinguishable from churn to anyone reading it.
  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return ranked;
}

/** One-line human explanation of a score. Every term traceable to an input. */
export function explain(entry: RankedCluster): string {
  const c = entry.components;
  const parts = [
    `${c.uniqueUsers} user${c.uniqueUsers === 1 ? '' : 's'}`,
    `${c.submissions} submission${c.submissions === 1 ? '' : 's'}`,
    `demand ${c.weightedDemand.toFixed(2)}`,
  ];
  if (c.meanAccountWeight > 1.001) parts.push(`avg weight ${c.meanAccountWeight.toFixed(2)}`);
  parts.push(
    c.growthSuppressed
      ? `growth n/a (only ${c.priorUsers} prior)`
      : `growth ×${c.growthMultiplier.toFixed(2)} (${c.recentUsers}→ from ${c.priorUsers})`,
  );
  return parts.join(', ');
}
