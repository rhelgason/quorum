/**
 * Baseline clusterers.
 *
 * These exist so the harness produces a real number today, and so every future
 * method has a floor to beat. Two of them are deliberately terrible: without
 * `allOneCluster` and `allSingletons` in the table it is hard to tell whether
 * 0.4 is a good score or an embarrassing one.
 *
 * `structural` is the one that matters. It is the v0.1 claim from
 * `docs/ROADMAP.md` — route + version + time bucket, no text analysis at all —
 * and the corpus is built to show both what it gets right (a crash burst after
 * a release) and exactly where it stops working (two different defects on the
 * same screen).
 */

import type { Submission } from './corpus.ts';

export type Clusterer = (submissions: readonly Submission[]) => string[];

/** Degenerate floor: everything is one issue. Full recall, terrible precision. */
export const allOneCluster: Clusterer = (submissions) => submissions.map(() => 'c0');

/** Degenerate floor: nothing is ever merged. Vacuous precision, zero recall. */
export const allSingletons: Clusterer = (submissions) => submissions.map((s) => s.id);

/** Normalize for lexical comparison: casefold, strip punctuation, collapse space. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Exact match after normalization. Catches only true duplicates.
 *
 * On a real corpus this is worth more than it looks — a meaningful share of
 * mobile feedback is verbatim repeats. On this corpus it should score close to
 * `allSingletons`, because every item was written separately.
 */
export const exactMatch: Clusterer = (submissions) =>
  submissions.map((s) => `x:${normalize(s.body)}`);

const DAY_MS = 86_400_000;

export interface StructuralOptions {
  /** Submissions land in the same cluster only if within the same bucket. Default 7 days. */
  bucketDays?: number;
  /** Include app version in the key. Default true — it's what separates a regression from a standing request. */
  useVersion?: boolean;
}

/**
 * Route + platform + version + time bucket. No text analysis.
 *
 * Time bucketing is what makes this a burst detector rather than a route
 * grouper: a crash spike in the three days after a release becomes its own
 * cluster, while a steady trickle of requests from the same screen spreads
 * across buckets.
 *
 * Buckets are anchored to the epoch rather than to the earliest submission, so
 * the output does not change when a new item is prepended to the corpus.
 */
export function structural(options: StructuralOptions = {}): Clusterer {
  const bucketDays = options.bucketDays ?? 7;
  const useVersion = options.useVersion ?? true;
  const bucketMs = bucketDays * DAY_MS;

  return (submissions) =>
    submissions.map((s) => {
      const bucket = Math.floor(Date.parse(s.clientTs) / bucketMs);
      const version = useVersion ? s.appVersion : '*';
      return `st:${s.platform}|${s.route}|${version}|${bucket}`;
    });
}

/**
 * Structural key plus a shared-content-word requirement.
 *
 * The cheapest possible upgrade over pure structure, and a useful reference
 * point: it shows how much of the remaining error is fixable with trivial
 * lexical signal versus how much genuinely needs embeddings.
 */
export function structuralPlusToken(options: StructuralOptions = {}): Clusterer {
  const base = structural(options);
  return (submissions) => {
    const keys = base(submissions);
    return submissions.map((s, i) => {
      const token = topContentWord(s.body);
      return `${keys[i]}|${token}`;
    });
  };
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'my', 'i', 'it', 'this', 'that',
  'we', 'you', 'me', 'have', 'has', 'had', 'do', 'does', 'did', 'not', 'no',
  'can', 'cant', 'could', 'would', 'please', 'pls', 'add', 'need', 'want',
  'there', 's', 't', 'every', 'all', 'any', 'from', 'when', 'what', 'how',
]);

/** Longest non-stopword token; a crude stand-in for a head noun. */
export function topContentWord(body: string): string {
  const words = normalize(body).split(' ').filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (words.length === 0) return '';
  return words.reduce((best, w) => (w.length > best.length ? w : best), '');
}
