/**
 * Loader and integrity validation for the labeled corpus.
 *
 * The corpus is hand-authored JSON, which means it will drift — someone adds a
 * submission and forgets to declare its cluster, or renames a cluster and
 * orphans a hard pair. `validate()` catches that in CI. A silently broken
 * corpus is worse than no corpus, because every metric downstream of it still
 * produces a confident-looking number.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus');

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface ClusterSpec {
  id: string;
  title: string;
  kind: string;
  difficulty?: Difficulty;
  /** True when the cluster should be recoverable from route/version/burst alone. */
  structural?: boolean;
  note?: string;
}

export interface Submission {
  id: string;
  /** Ground-truth cluster id. Singletons use `singleton-NNN`. */
  cluster: string;
  kind: string;
  source: string;
  body: string;
  route: string;
  appVersion: string;
  platform: string;
  userId: string;
  clientTs: string;
}

export interface HardPair {
  a: string;
  b: string;
  sameCluster: boolean;
  /** Short slug naming the failure mode, e.g. `feature-vs-bug-same-nouns`. */
  trap: string;
  note?: string;
}

export interface Corpus {
  clusters: ClusterSpec[];
  submissions: Submission[];
  hardPairs: HardPair[];
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(CORPUS_DIR, name), 'utf8'));
}

export function loadCorpus(): Corpus {
  const clustersDoc = readJson('clusters.json') as { clusters: ClusterSpec[] };
  const submissions = readJson('submissions.json') as Submission[];
  const pairsDoc = readJson('hard-pairs.json') as { pairs: HardPair[] };
  return {
    clusters: clustersDoc.clusters,
    submissions,
    hardPairs: pairsDoc.pairs,
  };
}

/** Ground-truth labels, index-aligned with `corpus.submissions`. */
export function truthLabels(corpus: Corpus): string[] {
  return corpus.submissions.map((s) => s.cluster);
}

export interface ValidationIssue {
  code: string;
  message: string;
}

/**
 * Structural integrity of the corpus itself. Returns every problem rather than
 * throwing on the first, so a contributor fixes one batch instead of playing
 * whack-a-mole.
 */
export function validate(corpus: Corpus): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const declared = new Set(corpus.clusters.map((c) => c.id));
  const byId = new Map<string, Submission>();

  for (const s of corpus.submissions) {
    if (byId.has(s.id)) {
      issues.push({ code: 'duplicate-id', message: `submission id ${s.id} appears twice` });
    }
    byId.set(s.id, s);

    const isSingleton = s.cluster.startsWith('singleton-');
    if (!isSingleton && !declared.has(s.cluster)) {
      issues.push({
        code: 'undeclared-cluster',
        message: `${s.id} references cluster '${s.cluster}', which is not in clusters.json`,
      });
    }
    if (s.body.trim() === '') {
      issues.push({ code: 'empty-body', message: `${s.id} has an empty body` });
    }
    if (Number.isNaN(Date.parse(s.clientTs))) {
      issues.push({ code: 'bad-timestamp', message: `${s.id} has unparseable clientTs '${s.clientTs}'` });
    }
  }

  // Sizes: a declared cluster with fewer than two members is a singleton that
  // was mislabeled, and it silently weakens every recall measurement.
  const sizes = new Map<string, number>();
  for (const s of corpus.submissions) {
    sizes.set(s.cluster, (sizes.get(s.cluster) ?? 0) + 1);
  }
  for (const c of corpus.clusters) {
    const size = sizes.get(c.id) ?? 0;
    if (size === 0) {
      issues.push({ code: 'empty-cluster', message: `cluster '${c.id}' is declared but has no members` });
    } else if (size === 1) {
      issues.push({
        code: 'undersized-cluster',
        message: `cluster '${c.id}' has one member; declare it as a singleton-NNN instead`,
      });
    }
  }
  for (const [cluster, size] of sizes) {
    if (cluster.startsWith('singleton-') && size !== 1) {
      issues.push({
        code: 'fat-singleton',
        message: `'${cluster}' is named as a singleton but has ${size} members`,
      });
    }
  }

  // Hard pairs must reference real submissions and must agree with the labels.
  // Disagreement means one of the two was edited without the other.
  for (const p of corpus.hardPairs) {
    const a = byId.get(p.a);
    const b = byId.get(p.b);
    if (a === undefined || b === undefined) {
      issues.push({
        code: 'dangling-pair',
        message: `hard pair (${p.a}, ${p.b}) references a submission that does not exist`,
      });
      continue;
    }
    if (p.a === p.b) {
      issues.push({ code: 'self-pair', message: `hard pair (${p.a}, ${p.b}) pairs a submission with itself` });
      continue;
    }
    const actual = a.cluster === b.cluster;
    if (actual !== p.sameCluster) {
      issues.push({
        code: 'pair-contradicts-labels',
        message: `hard pair (${p.a}, ${p.b}) declares sameCluster=${p.sameCluster} but labels say ${actual}`,
      });
    }
  }

  return issues;
}
