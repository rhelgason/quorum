/**
 * Eval CLI entrypoint.
 *
 * ```
 * node packages/eval/src/cli.ts
 * ```
 *
 * Kept separate from `report.ts` so that module stays pure and fully testable;
 * this file is console plumbing and is excluded from coverage thresholds.
 */

import { loadCorpus, validate } from './corpus.ts';
import {
  formatDiagnosis,
  formatSubsetTable,
  formatTable,
  formatTraps,
  run,
  runSubset,
} from './report.ts';
import {
  allOneCluster,
  allSingletons,
  exactMatch,
  structural,
  structuralPlusToken,
} from './baselines.ts';

const corpus = loadCorpus();

const issues = validate(corpus);
if (issues.length > 0) {
  console.error('corpus validation failed:');
  for (const i of issues) console.error(`  [${i.code}] ${i.message}`);
  process.exit(1);
}

console.log(
  `\nQuorum clustering eval — ${corpus.submissions.length} submissions, ` +
    `${new Set(corpus.submissions.map((s) => s.cluster)).size} true clusters, ` +
    `${corpus.hardPairs.length} hard pairs\n`,
);

const results = [
  run(corpus, 'all-one-cluster', allOneCluster),
  run(corpus, 'all-singletons', allSingletons),
  run(corpus, 'exact-match', exactMatch),
  run(corpus, 'structural (7d)', structural()),
  run(corpus, 'structural (3d)', structural({ bucketDays: 3 })),
  run(corpus, 'structural (30d)', structural({ bucketDays: 30 })),
  run(corpus, 'structural+token (7d)', structuralPlusToken()),
];

console.log(formatTable(results));

const best = results.reduce((a, b) => (b.metrics.pairwise.f1 > a.metrics.pairwise.f1 ? b : a));
console.log(`\n  best by pairwise F1: ${best.name}\n`);

// Where structural clustering actually works. The aggregate score buries this:
// bug reports about one defect cluster on a route and a version; feature
// requests about one topic arrive from all over the product.
// See docs/adr/0013-structural-clustering-is-a-regression-detector.md
const burstClusters = new Set(
  corpus.clusters.filter((c) => c.structural === true).map((c) => c.id),
);

console.log('  structural (7d) by slice:');
console.log(
  formatSubsetTable([
    runSubset(corpus, 'bugs only', structural(), (s) => s.kind === 'bug'),
    runSubset(corpus, 'feature requests only', structural(), (s) => s.kind === 'feature_request'),
    runSubset(corpus, 'release-burst clusters', structural(), (s) => burstClusters.has(s.cluster)),
  ]),
);

console.log();
console.log(formatDiagnosis(corpus, structural()));
console.log(`\n  hard-pair traps for '${best.name}':`);
console.log(formatTraps(best));
console.log();
