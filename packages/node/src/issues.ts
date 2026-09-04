/**
 * The read API: stored submissions in, a defensible ranked list out.
 *
 * This is the claim `docs/ROADMAP.md` opens with — *a team's first session with
 * Quorum must end with a ranked list* — reduced to one pure function. It runs
 * the whole deterministic pipeline with no model anywhere in it:
 *
 * ```
 * cluster (online, leader-follower)
 *   → consolidate (offline, average linkage)
 *   → label (medoid, verbatim)
 *   → rank (unique users × account weight × recency × growth)
 *   → explain
 * ```
 *
 * Two properties are deliberate and worth stating, because they constrain
 * everything above.
 *
 * **Pure and clock-free.** `now` is required, nothing here reads the system
 * clock, and the same submissions always produce the same list. A ranked list
 * you cannot reproduce is one you cannot debug when a customer disputes it.
 *
 * **Evidence is mandatory, not a detail.** Every issue carries the verbatim
 * submissions behind it and the component breakdown behind its score. Per
 * ADR-0012 the ranked list *is* the product, and a reader who cannot see why
 * item #3 is #3 has no reason to believe any of it.
 */

import {
  clusterDocs,
  medoid,
  type ClusterOptions,
  type Doc,
} from '../../aggregate/src/cluster.ts';
import {
  applyMerges,
  proposeMerges,
  type ClusterView,
  type Linkage,
} from '../../aggregate/src/consolidate.ts';
import {
  DEFAULT_EXCLUDED_KINDS,
  explain,
  rank,
  type RankableCluster,
  type RankMember,
  type RankOptions,
  type ScoreComponents,
} from '../../aggregate/src/rank.ts';
import { tokenize, type TokenizeOptions } from '../../aggregate/src/text.ts';
import { buildIdf, vectorize, type SparseVector } from '../../aggregate/src/vector.ts';
import type { Submission, SubmissionKind, SubmissionSource } from './submission.ts';

/**
 * Defaults follow ADR-0018's tuning direction — **a high online threshold plus
 * aggressive offline consolidation**, rather than one carefully-balanced
 * number. The high online threshold buys stable, order-robust assignments; the
 * offline pass recovers the recall it costs.
 *
 * These are a starting point, emphatically not tuned values. ADR-0018 measured
 * adjacent cells swinging between 3/10 and 6/10 on 161 synthetic items, so
 * only the direction is trustworthy. Sweep them against your own data.
 */
export const DEFAULT_ONLINE_THRESHOLD = 0.25;
export const DEFAULT_CONSOLIDATE_THRESHOLD = 0.03;

export interface ConsolidateSettings {
  /** Linkage similarity required to merge. Default {@link DEFAULT_CONSOLIDATE_THRESHOLD}. */
  threshold?: number;
  /** Default `'average'`. Single linkage chains catastrophically — see ADR-0018. */
  linkage?: Linkage;
  /** Refuse merges where one side is this many times larger. Default 0 (off). */
  maxSizeRatio?: number;
  /**
   * Proposal keys a human already declined.
   *
   * Nothing persists these yet, but the parameter exists now so the merge
   * review queue has somewhere to plug in without changing this signature.
   */
  rejected?: ReadonlySet<string>;
}

export interface BuildIssuesOptions {
  /** Evaluation time. Required — see "pure and clock-free" above. */
  now: Date | string | number;
  /** Online assignment threshold. Default {@link DEFAULT_ONLINE_THRESHOLD}. */
  threshold?: number;
  /** Set `false` to skip the offline repair pass. */
  consolidate?: ConsolidateSettings | false;
  tokenize?: TokenizeOptions;
  /** Weight on semantic similarity, 0..1. Requires embedded submissions. */
  semanticWeight?: number;
  /** Structural bonus. Default 0 — it helps defects and hurts feature requests (ADR-0013). */
  structuralBonus?: number;
  /** Verbatim quotes attached to each issue. Default 3. */
  quotesPerIssue?: number;
  /** Truncate the list. Applied after ranking. */
  limit?: number;
  /** Passed through to `rank`. `now` comes from this object instead. */
  rank?: Omit<RankOptions, 'now'>;
}

export interface IssueQuote {
  submissionId: string;
  /** Verbatim. This is the point of the drill-down. */
  body: string;
  clientTs: string;
  kind: SubmissionKind;
  source: SubmissionSource;
  /** True for the submission used as the issue title. */
  isLabel: boolean;
}

export interface Issue {
  id: string;
  /**
   * The medoid submission's body, verbatim — a real sentence a real user
   * wrote. No LLM required, ever (ADR-0016). The render edge may later replace
   * this with a generated title; when it is absent or disabled, this is what
   * ships, and it is never blank.
   */
  title: string;
  medoidId: string;
  score: number;
  /** Every input to `score`, so the number is explainable rather than asserted. */
  components: ScoreComponents;
  /** One-line human rendering of `components`. */
  explanation: string;
  /** Members that counted toward the score. See `memberIds`. */
  submissionCount: number;
  uniqueUsers: number;
  /** Kind breakdown across counted members — a mostly-`bug` issue reads differently. */
  kinds: Partial<Record<SubmissionKind, number>>;
  /**
   * Plurality route and the share of members on it. A high share on one route
   * is the regression signal from ADR-0013 — useful for alerting, not ranking.
   */
  topRoute?: { route: string; share: number };
  quotes: IssueQuote[];
  /**
   * Members that produced the score.
   *
   * Excluded kinds — `praise` by default — are absent, so every field on this
   * object describes the same set of submissions. Pass
   * `rank: { excludeKinds: [] }` for the raw cluster, which is what a merge
   * review needs and a build list does not.
   */
  memberIds: string[];
}

export function buildIssues(
  submissions: readonly Submission[],
  options: BuildIssuesOptions,
): Issue[] {
  if (submissions.length === 0) return [];

  const tokenizeOptions = options.tokenize ?? {};
  const quotesPerIssue = options.quotesPerIssue ?? 3;

  const docs = submissions.map(toDoc);

  // One IDF table, computed once and threaded through clustering, medoid
  // selection, and consolidation. Letting each derive its own would score the
  // same text three slightly different ways for no reason.
  const tokenized = docs.map((d) => tokenize(d.text, tokenizeOptions));
  const idf = buildIdf(tokenized);
  const vectors = tokenized.map((t) => vectorize(t, idf));

  const clusterOptions: ClusterOptions = {
    threshold: options.threshold ?? DEFAULT_ONLINE_THRESHOLD,
    tokenize: tokenizeOptions,
    idf,
    ...(options.semanticWeight !== undefined && { semanticWeight: options.semanticWeight }),
    ...(options.structuralBonus !== undefined && { structuralBonus: options.structuralBonus }),
  };

  const { labels } = clusterDocs(docs, clusterOptions);
  const finalLabels = options.consolidate === false
    ? labels
    : consolidateLabels(labels, vectors, options.consolidate ?? {});

  const byCluster = groupBy(submissions, finalLabels);

  const rankable: RankableCluster[] = [...byCluster].map(([id, members]) => ({
    id,
    members: members.map(toRankMember),
  }));

  // `rank` drops clusters whose every member is an excluded kind — praise-only
  // clusters, by default. Those are intentionally absent from a *build* list.
  const ranked = rank(rankable, { ...options.rank, now: options.now });
  const limited = options.limit === undefined ? ranked : ranked.slice(0, options.limit);

  // The same rule ranking applied. Everything below presents an issue, and a
  // presentation layer that filters differently produces a row whose title,
  // evidence, and counts describe submissions that did not contribute to its
  // score. That is not a display nit: it put a praise submission — "the
  // keyboard shortcuts are great" — at the top of a *build* list, which is the
  // exact outcome "praise is not work" exists to prevent.
  const excludedKinds = new Set(options.rank?.excludeKinds ?? DEFAULT_EXCLUDED_KINDS);

  const issues: Issue[] = [];
  for (const entry of limited) {
    const clustered = byCluster.get(entry.id);
    if (clustered === undefined) continue;

    // A ranked row shows exactly the evidence that produced its rank. Callers
    // who want the unfiltered cluster pass `rank: { excludeKinds: [] }`, which
    // is also how the offline tier inspects merge quality.
    const members = clustered.filter((m) => !excludedKinds.has(m.kind));
    if (members.length === 0) continue;

    const memberIds = members.map((m) => m.id);
    const labelId = medoid(memberIds, docs, { ...clusterOptions, threshold: 0 });
    const label = members.find((m) => m.id === labelId) ?? (members[0] as Submission);
    const route = topRoute(members);

    issues.push({
      id: entry.id,
      title: label.body,
      medoidId: label.id,
      score: entry.score,
      components: entry.components,
      explanation: explain(entry),
      submissionCount: members.length,
      uniqueUsers: entry.components.uniqueUsers,
      kinds: countKinds(members),
      ...(route !== undefined && { topRoute: route }),
      quotes: pickQuotes(members, label.id, quotesPerIssue),
      memberIds,
    });
  }
  return issues;
}

function toDoc(s: Submission): Doc {
  return {
    id: s.id,
    // The derived form, not the verbatim body. For ordinary feedback they are
    // identical; for machine-generated text they are very much not.
    text: s.clusterText,
    ...(s.route !== undefined && { route: s.route }),
    ...(s.appVersion !== undefined && { appVersion: s.appVersion }),
    ...(s.platform !== undefined && { platform: s.platform }),
    ...(s.embedding !== undefined && { vector: s.embedding }),
  };
}

function toRankMember(s: Submission): RankMember {
  return {
    userId: s.userId,
    kind: s.kind,
    clientTs: s.clientTs,
    ...(s.mrr !== undefined && { mrr: s.mrr }),
  };
}

/**
 * Run the offline repair pass and apply what it proposes.
 *
 * `proposeMerges` and `applyMerges` are separate functions precisely so that
 * proposing and applying are not reachable through one call (ADR-0018), and
 * this function reaches through both — so it owes an explanation.
 *
 * It is safe *here and only here*: this is a stateless recompute over an
 * append-only log, with no persisted clusters and therefore no human curation
 * to destroy. The rule exists to stop a nightly job silently undoing a PM's
 * afternoon, and there is nothing yet for it to undo.
 *
 * **That stops being true the moment clusters persist.** When
 * `canonical_issues` is real, this call site becomes the proposal queue:
 * propose here, write to `cluster_proposals`, apply only what a human accepts,
 * and respect `locked`. `rejected` is already plumbed through for that day.
 */
function consolidateLabels(
  labels: readonly string[],
  vectors: readonly SparseVector[],
  settings: ConsolidateSettings,
): string[] {
  const views = new Map<string, SparseVector[]>();
  for (let i = 0; i < labels.length; i++) {
    const id = labels[i] as string;
    const bucket = views.get(id);
    if (bucket === undefined) views.set(id, [vectors[i] as SparseVector]);
    else bucket.push(vectors[i] as SparseVector);
  }

  const clusterViews: ClusterView[] = [...views].map(([id, vs]) => ({ id, vectors: vs }));
  const proposals = proposeMerges(clusterViews, {
    threshold: settings.threshold ?? DEFAULT_CONSOLIDATE_THRESHOLD,
    ...(settings.linkage !== undefined && { linkage: settings.linkage }),
    ...(settings.maxSizeRatio !== undefined && { maxSizeRatio: settings.maxSizeRatio }),
    ...(settings.rejected !== undefined && { rejected: settings.rejected }),
  });
  return applyMerges(labels, proposals);
}

function groupBy(
  submissions: readonly Submission[],
  labels: readonly string[],
): Map<string, Submission[]> {
  const groups = new Map<string, Submission[]>();
  for (let i = 0; i < submissions.length; i++) {
    const id = labels[i] as string;
    const bucket = groups.get(id);
    if (bucket === undefined) groups.set(id, [submissions[i] as Submission]);
    else bucket.push(submissions[i] as Submission);
  }
  return groups;
}

function countKinds(members: readonly Submission[]): Partial<Record<SubmissionKind, number>> {
  const counts: Partial<Record<SubmissionKind, number>> = {};
  for (const m of members) counts[m.kind] = (counts[m.kind] ?? 0) + 1;
  return counts;
}

function topRoute(members: readonly Submission[]): { route: string; share: number } | undefined {
  const counts = new Map<string, number>();
  let withRoute = 0;
  for (const m of members) {
    if (m.route === undefined || m.route === '') continue;
    withRoute++;
    counts.set(m.route, (counts.get(m.route) ?? 0) + 1);
  }
  if (withRoute === 0) return undefined;

  let best: { route: string; count: number } | undefined;
  for (const [route, count] of counts) {
    // Ties broken by route name, so the field is stable across runs.
    if (best === undefined || count > best.count || (count === best.count && route < best.route)) {
      best = { route, count };
    }
  }
  if (best === undefined) return undefined;
  // Share is of members that reported a route at all. Reporting it as a share
  // of *all* members would make a route look weak simply because server-side
  // imports carry no route.
  return { route: best.route, share: best.count / withRoute };
}

/**
 * The evidence attached to an issue.
 *
 * The medoid comes first because it is the title, and a reader needs to see
 * the sentence that produced the label. The rest are the most recent, on the
 * grounds that a PM reading a row wants to know what people are saying now
 * rather than what they said a year ago.
 */
function pickQuotes(
  members: readonly Submission[],
  labelId: string,
  limit: number,
): IssueQuote[] {
  if (limit <= 0) return [];

  const rest = members
    .filter((m) => m.id !== labelId)
    .sort((a, b) => b.clientTs.localeCompare(a.clientTs) || a.id.localeCompare(b.id));

  const label = members.find((m) => m.id === labelId);
  const ordered = label === undefined ? rest : [label, ...rest];

  return ordered.slice(0, limit).map((m) => ({
    submissionId: m.id,
    body: m.body,
    clientTs: m.clientTs,
    kind: m.kind,
    source: m.source,
    isLabel: m.id === labelId,
  }));
}
