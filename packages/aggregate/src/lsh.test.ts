import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  bandKeys,
  candidateBlocks,
  hammingDistance,
  nearDuplicateGroups,
  shingles,
  simhash,
  simhashSimilarity,
  SIMHASH_BITS,
} from './lsh.ts';
import { normalize } from './text.ts';

describe('shingles', () => {
  test('overlapping character trigrams', () => {
    assert.deepEqual(shingles('abcd'), ['abc', 'bcd']);
  });

  test('text shorter than the window is one shingle, not none', () => {
    // Returning nothing would fingerprint every short submission identically,
    // silently collapsing "yes" and "no".
    assert.deepEqual(shingles('ab'), ['ab']);
    assert.deepEqual(shingles('abc'), ['abc']);
  });

  test('empty text yields no shingles', () => {
    assert.deepEqual(shingles('   '), []);
  });

  test('the window size is configurable', () => {
    assert.deepEqual(shingles('abcd', 2), ['ab', 'bc', 'cd']);
  });
});

describe('simhash', () => {
  test('identical text fingerprints identically', () => {
    assert.equal(simhash('please add dark mode'), simhash('please add dark mode'));
  });

  test('case and punctuation alone cost nothing', () => {
    assert.equal(simhash(normalize('Add Dark Mode')), simhash(normalize('add dark mode!!')));
  });

  test('a word inserted into a full sentence stays within a few bits', () => {
    const a = simhash(normalize('csv export is broken, I click download and nothing happens'));
    const b = simhash(normalize('csv export is broken and I click download and nothing happens'));
    assert.ok(hammingDistance(a, b) <= 6, `distance was ${String(hammingDistance(a, b))}`);
  });

  test('distance scales inversely with length — the documented weakness', () => {
    // The same typo costs 6 bits in a twenty-character phrase and ~18 in a
    // nine-character one, because a short string has few shingles and each
    // moves more bits. Near-duplicate detection is weakest on the shortest
    // submissions, which on mobile is a lot of them.
    const long = hammingDistance(simhash('please add dark mode'), simhash('please add dakr mode'));
    const short = hammingDistance(simhash('dark mode'), simhash('dakr mode'));
    assert.ok(long < short, `long ${String(long)} should be under short ${String(short)}`);
    assert.ok(long <= 6);
  });

  test('a typo survives, because shingles are characters not words', () => {
    // "dark mode" and "dakr mode" share no word token at all.
    const a = simhash('dark mode');
    const b = simhash('dakr mode');
    assert.ok(simhashSimilarity(a, b) > 0.6);
  });

  test('unrelated text is far apart', () => {
    const a = simhash('please add dark mode to the settings screen');
    const b = simhash('the csv export from reports downloads an empty file');
    assert.ok(hammingDistance(a, b) > 12, `distance was ${String(hammingDistance(a, b))}`);
  });

  test('empty text fingerprints to zero', () => {
    assert.equal(simhash(''), 0n);
  });

  test('the fingerprint uses the full 64-bit width', () => {
    // A hash that only ever sets low bits would collide constantly. Check that
    // the high half carries information across a corpus.
    let sawHighBit = false;
    for (let i = 0; i < 200; i++) {
      if (simhash(`submission number ${String(i)} about something`) >> 32n > 0n) sawHighBit = true;
    }
    assert.equal(sawHighBit, true);
  });

  test('the two halves are independent', () => {
    // Correlated halves would halve the effective fingerprint width. If high
    // always equalled low, this would fail immediately.
    let identicalHalves = 0;
    for (let i = 0; i < 100; i++) {
      const fp = simhash(`feedback item ${String(i)}`);
      if ((fp >> 32n) === (fp & 0xffffffffn)) identicalHalves++;
    }
    assert.ok(identicalHalves < 3, `${String(identicalHalves)} of 100 had identical halves`);
  });
});

describe('hamming distance', () => {
  test('zero for identical fingerprints', () => {
    assert.equal(hammingDistance(0b1011n, 0b1011n), 0);
  });

  test('counts differing bits', () => {
    assert.equal(hammingDistance(0b1010n, 0b0001n), 3);
  });

  test('similarity maps distance onto 0..1', () => {
    assert.equal(simhashSimilarity(5n, 5n), 1);
    assert.equal(simhashSimilarity(0n, (1n << 64n) - 1n), 0);
  });
});

describe('band keys', () => {
  test('the default is eight bands', () => {
    assert.equal(bandKeys(123n).length, 8);
  });

  test('identical fingerprints produce identical keys', () => {
    assert.deepEqual(bandKeys(987654321n), bandKeys(987654321n));
  });

  test('the band index is part of the key', () => {
    // Without it, the same bit pattern in two positions is a false candidate.
    const keys = bandKeys(0n);
    assert.equal(new Set(keys).size, keys.length);
  });

  test('a fingerprint differing in one band still shares the others', () => {
    const a = 0n;
    const b = 1n; // flips one bit, so only band 0 differs
    const shared = bandKeys(a).filter((k) => bandKeys(b).includes(k));
    assert.equal(shared.length, 7);
  });

  test('band counts that do not divide 64 are rejected', () => {
    assert.throws(() => bandKeys(1n, 7), /divide 64/);
  });

  test('nonsense band counts are rejected', () => {
    for (const bad of [0, -1, 65, 1.5]) {
      assert.throws(() => bandKeys(1n, bad), /bands must be/);
    }
  });
});

describe('blocking', () => {
  const docs = [
    { id: 'a', text: 'please add dark mode to the app' },
    { id: 'b', text: 'please add dark mode to the app!!' },
    { id: 'c', text: 'the csv export from reports downloads an empty file' },
  ];

  test('near-duplicates land in each other', () => {
    const blocks = candidateBlocks(docs);
    assert.ok(blocks.get('a')?.has('b'));
  });

  test('every document gets an entry, even with no candidates', () => {
    const blocks = candidateBlocks(docs);
    assert.equal(blocks.size, 3);
    assert.ok(blocks.get('c') !== undefined);
  });

  test('two identical documents are still found', () => {
    // Regression: the obvious "skip a bucket holding the whole corpus" guard
    // discards exactly this case, because identical documents share every
    // band. The one pair blocking exists to find would be thrown away.
    const identical = [
      { id: 'a', text: 'the csv export is broken' },
      { id: 'b', text: 'the csv export is broken' },
    ];
    assert.ok(candidateBlocks(identical).get('a')?.has('b'));
  });

  test('a pathologically large bucket is skipped', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `d${String(i)}`, text: 'identical text' }));
    let pairs = 0;
    for (const set of candidateBlocks(many, { maxBucketSize: 10 }).values()) pairs += set.size;
    assert.equal(pairs, 0);
  });

  test('blocking is far cheaper than all pairs on varied text', () => {
    // Genuinely varied feedback, not the same sentence with a number swapped —
    // near-identical text *should* all collide, so it proves nothing.
    const subjects = ['dark mode', 'csv export', 'saml sso', 'photo upload', 'dashboard speed', 'audit log'];
    const verbs = ['is broken for', 'never finishes for', 'confuses', 'crashes on', 'times out for'];
    const many: { id: string; text: string }[] = [];
    for (let i = 0; i < 300; i++) {
      const subject = subjects[i % subjects.length] as string;
      const verb = verbs[(i * 7) % verbs.length] as string;
      many.push({ id: `d${String(i)}`, text: `${subject} ${verb} account ${String(i)} on the web client` });
    }
    let directed = 0;
    for (const set of candidateBlocks(many).values()) directed += set.size;
    const allPairs = (300 * 299) / 2;
    assert.ok(directed / 2 < allPairs / 2, `blocking produced ${String(directed / 2)} of ${String(allPairs)} pairs`);
  });
});

describe('near-duplicate groups', () => {
  test('restatements of one sentence group together', () => {
    const groups = nearDuplicateGroups([
      { id: 'a', text: normalize('Add dark mode') },
      { id: 'b', text: normalize('add dark mode') },
      { id: 'c', text: normalize('ADD DARK MODE!!') },
      { id: 'd', text: normalize('the csv export is broken') },
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0], ['a', 'b', 'c']);
  });

  test('distinct feedback is not grouped', () => {
    const groups = nearDuplicateGroups([
      { id: 'a', text: 'please add dark mode to the settings screen' },
      { id: 'b', text: 'the csv export from reports downloads an empty file' },
    ]);
    assert.deepEqual(groups, []);
  });

  test('singletons are omitted rather than returned as groups of one', () => {
    const groups = nearDuplicateGroups([{ id: 'a', text: 'a lone piece of feedback' }]);
    assert.deepEqual(groups, []);
  });

  test('groups are returned in input order', () => {
    const groups = nearDuplicateGroups([
      { id: 'z', text: 'the csv export is broken' },
      { id: 'a', text: 'the csv export is broken' },
    ]);
    assert.deepEqual(groups[0], ['z', 'a']);
  });

  test('a tighter threshold groups less', () => {
    const docs = [
      { id: 'a', text: normalize('add dark mode') },
      { id: 'b', text: normalize('add dark mode please') },
    ];
    // 16 bits apart: inside a loose threshold, outside the default.
    assert.equal(nearDuplicateGroups(docs, { maxDistance: 20 }).length, 1);
    assert.equal(nearDuplicateGroups(docs).length, 0);
  });

  test('an empty corpus yields no groups', () => {
    assert.deepEqual(nearDuplicateGroups([]), []);
  });
});

describe('constants', () => {
  test('the fingerprint width is 64 bits', () => {
    assert.equal(SIMHASH_BITS, 64);
  });
});
