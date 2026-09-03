/**
 * Scoring against the adversarial pair set.
 *
 * Aggregate metrics hide these. A pipeline can score ARI 0.85 while getting
 * every hard pair wrong, because each pair is individually tiny — but those
 * pairs are precisely the failures a user notices, since they are the ones
 * where the tool confidently merges a feature request with a bug report.
 *
 * The per-trap breakdown is the point. "Hard pairs: 12/20" is a number;
 * "feature-vs-bug-same-nouns: 0/2" tells you what to fix.
 */

import type { Corpus, HardPair } from './corpus.ts';

export interface PairOutcome {
  pair: HardPair;
  expected: boolean;
  actual: boolean;
  correct: boolean;
}

export interface TrapScore {
  trap: string;
  correct: number;
  total: number;
}

export interface HardPairReport {
  correct: number;
  total: number;
  accuracy: number;
  /** Wrongly merged: the pipeline joined two things that are different work. */
  falseMerges: PairOutcome[];
  /** Wrongly split: the pipeline missed a genuine paraphrase. */
  falseSplits: PairOutcome[];
  byTrap: TrapScore[];
}

/**
 * @param corpus  the labeled corpus
 * @param predicted  predicted cluster labels, index-aligned with `corpus.submissions`
 */
export function scoreHardPairs(corpus: Corpus, predicted: readonly string[]): HardPairReport {
  if (predicted.length !== corpus.submissions.length) {
    throw new Error(
      `predicted labels must align with submissions: got ${predicted.length}, expected ${corpus.submissions.length}`,
    );
  }

  const labelById = new Map<string, string>();
  corpus.submissions.forEach((s, i) => labelById.set(s.id, predicted[i] as string));

  const outcomes: PairOutcome[] = [];
  for (const pair of corpus.hardPairs) {
    const a = labelById.get(pair.a);
    const b = labelById.get(pair.b);
    if (a === undefined || b === undefined) {
      throw new Error(`hard pair (${pair.a}, ${pair.b}) references an unknown submission`);
    }
    const actual = a === b;
    outcomes.push({ pair, expected: pair.sameCluster, actual, correct: actual === pair.sameCluster });
  }

  const trapTotals = new Map<string, TrapScore>();
  for (const o of outcomes) {
    const existing = trapTotals.get(o.pair.trap);
    if (existing === undefined) {
      trapTotals.set(o.pair.trap, { trap: o.pair.trap, correct: o.correct ? 1 : 0, total: 1 });
    } else {
      existing.total++;
      if (o.correct) existing.correct++;
    }
  }

  const correct = outcomes.filter((o) => o.correct).length;

  return {
    correct,
    total: outcomes.length,
    accuracy: outcomes.length === 0 ? 1 : correct / outcomes.length,
    falseMerges: outcomes.filter((o) => !o.correct && o.actual),
    falseSplits: outcomes.filter((o) => !o.correct && !o.actual),
    // Worst traps first, ties broken by name so reports diff cleanly.
    byTrap: [...trapTotals.values()].sort(
      (x, y) => x.correct / x.total - y.correct / y.total || x.trap.localeCompare(y.trap),
    ),
  };
}
