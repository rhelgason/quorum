/**
 * The hybrid sweep, and specifically its conflation guard.
 *
 * The guard exists because of a measured failure, not a hypothetical one. On
 * the bundled corpus the highest-scoring cell in the first version of this
 * sweep produced **17 clusters against a truth of 50** and beat a
 * configuration that got the cluster count almost exactly right. Top-`k`
 * recall has a degenerate zone just above `k`: merge hard enough and each
 * surviving blob is likely to carry a top truth issue as its plurality label,
 * so the metric pays for conflation.
 *
 * A sweep that picked that cell would hand back a "tuned" configuration whose
 * first ranked row is four unrelated topics in a trench coat — and would have
 * made any real embedding model look better than it is.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadCorpus, truthLabels } from './corpus.ts';
import { toDocs, withVectors } from './adapt.ts';
import { createHashingEmbedder } from '../../aggregate/src/embed-cache.ts';
import { formatSweep, sweep, type SweepResult } from './sweep.ts';

const corpus = loadCorpus();
const docs = toDocs(corpus.submissions);
const NOW = '2026-09-01T00:00:00Z';

const embedder = createHashingEmbedder();
const vectors = await embedder.embed(corpus.submissions.map((s) => s.body));
const embedded = withVectors(docs, vectors);

function run(overrides: Record<string, unknown> = {}): SweepResult {
  return sweep(corpus, embedded, 'stand-in', { now: NOW, ...overrides });
}

/**
 * The default grid, computed once.
 *
 * 25 cells over 161 documents is about a second, and most tests here ask about
 * the same grid. Recomputing it per test made this the slowest file in the
 * suite by an order of magnitude for no added coverage — the sweep is a pure
 * function of the corpus.
 */
const DEFAULT = run();

describe('the grid', () => {
  it('covers every combination', () => {
    const result = run({ semanticWeights: [0, 0.5], thresholds: [0.1, 0.2, 0.3] });
    assert.equal(result.cells.length, 6);
  });

  it('always reports the ceiling from perfect clustering', () => {
    assert.equal(DEFAULT.ceiling, 10);
  });

  it('knows how many clusters the corpus really has', () => {
    assert.equal(DEFAULT.truthClusters, new Set(truthLabels(corpus)).size);
  });

  it('records precision and cluster count per cell', () => {
    for (const cell of DEFAULT.cells) {
      assert.ok(cell.precision >= 0 && cell.precision <= 1);
      assert.ok(cell.clusters > 0);
    }
  });

  it('is reproducible', () => {
    assert.deepEqual(
      run().cells.map((c) => c.hits),
      DEFAULT.cells.map((c) => c.hits),
    );
  });
});

describe('the conflation guard', () => {
  it('flags cells that merge far past the truth', () => {
    const result = DEFAULT;
    const overMerged = result.cells.filter((c) => c.clusters < result.truthClusters / 2);

    assert.ok(overMerged.length > 0, 'the grid should reach into the degenerate zone');
    for (const cell of overMerged) {
      assert.equal(cell.degenerate, true, `${String(cell.clusters)} clusters should be flagged`);
    }
  });

  it('never picks a degenerate cell as best', () => {
    const result = DEFAULT;
    assert.equal(result.best.degenerate, false);
  });

  it('refuses a higher raw score that came from over-merging', () => {
    const result = DEFAULT;
    const topRaw = [...result.cells].sort((a, b) => b.hits - a.hits)[0];

    // The measured case: the raw winner scores higher than the reported best,
    // and is rejected. If this stops being true the guard has gone slack.
    assert.ok(topRaw !== undefined);
    assert.ok(topRaw.hits > result.best.hits, 'expected the degenerate zone to outscore honest cells');
    assert.equal(topRaw.degenerate, true);
    assert.ok(result.disqualified > 0);
  });

  it('measures against the lexical control, not a magic number', () => {
    // A tolerance of 1.0 puts the floor at zero, so nothing can be worse than
    // it and every cell becomes eligible again.
    const permissive = run({ precisionTolerance: 1 });
    assert.equal(permissive.disqualified, 0);
    assert.ok(permissive.best.hits >= DEFAULT.best.hits);
  });

  it('keeps the lexical control eligible', () => {
    // The control cannot be disqualified for conflating more than itself.
    const result = DEFAULT;
    assert.equal(result.lexicalBaseline.degenerate, false);
  });

  it('falls back to the raw best rather than returning nothing', () => {
    // If every cell were somehow disqualified, a sweep still has to answer.
    const result = run({ semanticWeights: [1], thresholds: [0.1] });
    assert.ok(result.best !== undefined);
  });
});

describe('choosing between equals', () => {
  it('prefers less semantic weight when scores tie', () => {
    const result = run({ semanticWeights: [0, 0.25], thresholds: [0.1] });
    const [lexical, hybrid] = result.cells;

    if (lexical?.hits === hybrid?.hits && hybrid?.degenerate === false) {
      // Same answer with no model dependency is a better answer.
      assert.equal(result.best.semanticWeight, 0);
    }
  });
});

describe('formatSweep', () => {
  const text = formatSweep(DEFAULT);

  it('shows all three grids, because one of them is a trap', () => {
    assert.match(text, /top-10 agreement/);
    assert.match(text, /clusters found \(truth has 50\)/);
    assert.match(text, /pairwise precision/);
  });

  it('marks disqualified cells inline', () => {
    assert.match(text, /!/);
    assert.match(text, /over-merged/);
  });

  it('states the comparison against lexical explicitly', () => {
    // "the embedder is worth +N" is the sentence a reader takes away, so it
    // has to be in the output rather than inferred from two tables.
    assert.match(text, /lexical-only best is \d+\/10, so the embedder is worth [+-]\d/);
  });

  it('reports the stand-in as worth nothing', () => {
    // The documented invariant: a hash function encodes roughly what TF-IDF
    // already encodes, so it should not move the number. When it appeared to,
    // it was over-merging.
    assert.match(text, /the embedder is worth \+0/);
  });
});
