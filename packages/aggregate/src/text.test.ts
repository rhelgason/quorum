import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalize, stem, STOPWORDS, tokenize } from './text.ts';

describe('normalize', () => {
  test('casefolds, strips punctuation, collapses whitespace', () => {
    assert.equal(normalize('  Add DARK-mode, please!!  '), 'add dark mode please');
  });

  test('keeps digits, which carry meaning in version and error reports', () => {
    assert.equal(normalize('crashes on 4.12.0 with a 500'), 'crashes on 4 12 0 with a 500');
  });

  test('handles empty and punctuation-only input', () => {
    assert.equal(normalize(''), '');
    assert.equal(normalize('!!! ???'), '');
  });
});

describe('stem', () => {
  test('collapses the inflections that matter in feedback', () => {
    assert.equal(stem('crashes'), 'crash');
    assert.equal(stem('crashing'), 'crash');
    assert.equal(stem('crashed'), 'crash');
    assert.equal(stem('exports'), 'export');
    assert.equal(stem('notifications'), 'notification');
  });

  test('handles doubled consonants before -ing and -ed', () => {
    assert.equal(stem('running'), 'run');
    assert.equal(stem('dropped'), 'drop');
  });

  test('handles -ies plurals', () => {
    assert.equal(stem('categories'), 'category');
    assert.equal(stem('currencies'), 'currency');
  });

  test('leaves short words alone', () => {
    assert.equal(stem('css'), 'css');
    assert.equal(stem('ios'), 'ios');
    assert.equal(stem('is'), 'is');
  });

  test('does not strip -ss or -us', () => {
    // 'access' -> 'acces' would be wrong and would collide with other stems.
    assert.equal(stem('access'), 'access');
    assert.equal(stem('status'), 'status');
  });

  test('is idempotent', () => {
    for (const w of ['crashes', 'running', 'categories', 'export', 'access']) {
      assert.equal(stem(stem(w)), stem(w), `not idempotent for ${w}`);
    }
  });

  test('does not over-conflate the way a full Porter stemmer would', () => {
    // The reason for a conservative stemmer: these must stay distinct.
    assert.notEqual(stem('universal'), stem('universe'));
    assert.notEqual(stem('organization'), stem('organ'));
  });
});

describe('tokenize', () => {
  test('drops stopwords and short tokens, and stems the rest', () => {
    assert.deepEqual(tokenize('Please add the dark mode to my app'), ['dark', 'mode']);
  });

  test('strips feedback boilerplate that carries no topical signal', () => {
    // 'please', 'need', 'add', 'feature', 'support' appear across a large
    // fraction of requests; leaving them in makes everything look similar.
    for (const word of ['please', 'need', 'add', 'want', 'feature', 'support', 'app']) {
      assert.ok(STOPWORDS.has(word), `expected '${word}' to be a stopword`);
    }
    assert.deepEqual(tokenize('please add support for the feature'), []);
  });

  test('makes paraphrases share tokens', () => {
    const a = new Set(tokenize('the CSV export is broken'));
    const b = new Set(tokenize('exporting to csv breaks'));
    const shared = [...a].filter((t) => b.has(t));
    assert.ok(shared.includes('csv'));
    assert.ok(shared.includes('export'));
  });

  test('bigrams distinguish the feature-vs-bug trap that unigrams cannot', () => {
    // Unigram overlap between these is total; the ordering is the only signal.
    const feature = new Set(tokenize('export expenses to csv', { bigrams: true }));
    const bug = new Set(tokenize('csv export missing last row', { bigrams: true }));
    const sharedBigrams = [...feature].filter((t) => t.includes('_') && bug.has(t));
    assert.equal(sharedBigrams.length, 0, 'no shared bigrams despite shared unigrams');
  });

  test('bigrams are emitted alongside unigrams, not instead of them', () => {
    const tokens = tokenize('dark mode setting', { bigrams: true });
    assert.ok(tokens.includes('dark'));
    assert.ok(tokens.includes('dark_mode'));
  });

  test('options can be disabled individually', () => {
    assert.deepEqual(tokenize('the crashes', { removeStopwords: false, applyStemming: false }), [
      'the',
      'crashes',
    ]);
    assert.deepEqual(tokenize('crashes', { applyStemming: false }), ['crashes']);
  });

  test('minLength is respected', () => {
    assert.deepEqual(tokenize('ab abc abcd', { minLength: 4, applyStemming: false }), ['abcd']);
  });

  test('an all-stopword string tokenizes to nothing', () => {
    // This is the case cluster.ts must handle: a doc with no signal must not
    // match everything at zero similarity.
    assert.deepEqual(tokenize('please can you add this thing'), []);
  });
});
