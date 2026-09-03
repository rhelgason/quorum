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

import { loadCorpus, truthLabels, validate } from './corpus.ts';
import {
  formatDiagnosis,
  formatRankedList,
  formatRankTable,
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
import { toDocs } from './adapt.ts';
import { clusterDocs } from '../../aggregate/src/cluster.ts';

/** Fixed evaluation clock, so the report is reproducible across runs. */
const EVAL_NOW = '2026-09-01T00:00:00Z';

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

// ---------------------------------------------------------------------------
// Rank agreement — the headline metric. ADR-0014.
// ---------------------------------------------------------------------------

const docs = toDocs(corpus.submissions);
const lexical = (threshold: number, bigrams = false) => () =>
  clusterDocs(docs, { threshold, tokenize: { bigrams } }).labels;

console.log('\n  top-10 rank agreement (what the product actually delivers):');
console.log(
  formatRankTable(corpus, EVAL_NOW, [
    ['perfect clustering', () => truthLabels(corpus)],
    ['all-singletons', () => allSingletons(corpus.submissions)],
    ['structural (7d)', () => structural()(corpus.submissions)],
    ['lexical t=0.10', lexical(0.1)],
    ['lexical t=0.15', lexical(0.15)],
    ['lexical t=0.20', lexical(0.2)],
    ['lexical+bigrams t=0.10', lexical(0.1, true)],
  ]),
);
console.log(
  '\n  Note: best ARI (t=0.15) is NOT best top-10. Tuning on ARI picks the\n' +
    '  worse configuration — see docs/adr/0014-rank-agreement-is-the-eval-target.md',
);

// ---------------------------------------------------------------------------
// The actual product output: a ranked list with evidence.
// ---------------------------------------------------------------------------

console.log('\n  ── Ranked backlog from perfect clustering (the target) ──\n');
console.log(formatRankedList(corpus, truthLabels(corpus), EVAL_NOW, 10));

console.log('\n  ── Same list from lexical clustering (what we can build today) ──\n');
console.log(formatRankedList(corpus, lexical(0.1)(), EVAL_NOW, 10));
console.log();
