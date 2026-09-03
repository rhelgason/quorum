import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildIdf, Centroid, cosine, l2Normalize, vectorize } from './vector.ts';

function close(a: number, b: number, msg?: string): void {
  assert.ok(Math.abs(a - b) < 1e-9, msg ?? `expected ${a} ≈ ${b}`);
}

describe('buildIdf', () => {
  test('weights rare terms above common ones', () => {
    const idf = buildIdf([['a', 'b'], ['a', 'c'], ['a', 'd']]);
    assert.ok((idf.get('b') as number) > (idf.get('a') as number));
  });

  test('counts each term once per document', () => {
    const repeated = buildIdf([['a', 'a', 'a'], ['b']]);
    const single = buildIdf([['a'], ['b']]);
    close(repeated.get('a') as number, single.get('a') as number);
  });

  test('smoothing keeps a singleton term finite and bounded', () => {
    // Unsmoothed IDF on a small corpus lets one rare typo dominate a score.
    const idf = buildIdf(Array.from({ length: 161 }, (_, i) => (i === 0 ? ['rare'] : ['common'])));
    const rare = idf.get('rare') as number;
    assert.ok(Number.isFinite(rare));
    assert.ok(rare < 5, `expected bounded weight, got ${rare}`);
  });

  test('handles an empty corpus', () => {
    assert.equal(buildIdf([]).size, 0);
  });
});

describe('vectorize', () => {
  test('produces a unit-length vector', () => {
    const idf = buildIdf([['dark', 'mode'], ['light', 'mode']]);
    const v = vectorize(['dark', 'mode'], idf);
    let sum = 0;
    for (const x of v.values()) sum += x * x;
    close(sum, 1);
  });

  test('uses sublinear term frequency', () => {
    // 'crash crash crash' is not three times more about crashing.
    const idf = buildIdf([['crash', 'other'], ['unrelated']]);
    const once = vectorize(['crash', 'other'], idf);
    const thrice = vectorize(['crash', 'crash', 'crash', 'other'], idf);
    const ratio = (thrice.get('crash') as number) / (once.get('crash') as number);
    assert.ok(ratio < 2.2, `raw counts would give 3x; got ${ratio}`);
    assert.ok(ratio > 1, 'but repetition should still count for something');
  });

  test('skips out-of-vocabulary terms rather than guessing a weight', () => {
    const idf = buildIdf([['known']]);
    const v = vectorize(['known', 'unknown'], idf);
    assert.ok(v.has('known'));
    assert.equal(v.has('unknown'), false);
  });

  test('an all-OOV document produces an empty vector, not a zero-filled one', () => {
    const v = vectorize(['nope'], buildIdf([['known']]));
    assert.equal(v.size, 0);
  });
});

describe('l2Normalize', () => {
  test('scales to unit length', () => {
    const v = l2Normalize(new Map([['a', 3], ['b', 4]]));
    close(v.get('a') as number, 0.6);
    close(v.get('b') as number, 0.8);
  });

  test('leaves a zero vector unchanged instead of dividing by zero', () => {
    const v = l2Normalize(new Map([['a', 0]]));
    assert.equal(v.get('a'), 0);
  });

  test('is idempotent', () => {
    const once = l2Normalize(new Map([['a', 3], ['b', 4]]));
    const twice = l2Normalize(once);
    close(once.get('a') as number, twice.get('a') as number);
  });
});

describe('cosine', () => {
  test('is 1 for identical vectors and 0 for disjoint ones', () => {
    const idf = buildIdf([['a', 'b'], ['c', 'd']]);
    const ab = vectorize(['a', 'b'], idf);
    const cd = vectorize(['c', 'd'], idf);
    close(cosine(ab, ab), 1);
    close(cosine(ab, cd), 0);
  });

  test('is symmetric', () => {
    const idf = buildIdf([['a', 'b'], ['b', 'c']]);
    const x = vectorize(['a', 'b'], idf);
    const y = vectorize(['b', 'c'], idf);
    close(cosine(x, y), cosine(y, x));
  });

  test('partial overlap scores between the extremes', () => {
    const idf = buildIdf([['a', 'b'], ['b', 'c'], ['d', 'e']]);
    const s = cosine(vectorize(['a', 'b'], idf), vectorize(['b', 'c'], idf));
    assert.ok(s > 0 && s < 1, `got ${s}`);
  });

  test('handles empty vectors', () => {
    close(cosine(new Map(), new Map()), 0);
    close(cosine(new Map([['a', 1]]), new Map()), 0);
  });
});

describe('Centroid', () => {
  const idf = buildIdf([['a', 'b'], ['b', 'c'], ['c', 'd']]);
  const va = vectorize(['a', 'b'], idf);
  const vb = vectorize(['b', 'c'], idf);
  const vc = vectorize(['c', 'd'], idf);

  test('starts empty', () => {
    const c = new Centroid();
    assert.equal(c.size, 0);
    assert.equal(c.vector().size, 0);
  });

  test('a single member is its own centroid', () => {
    const c = new Centroid();
    c.add(va);
    close(cosine(c.vector(), va), 1);
  });

  test('sits between its members', () => {
    const c = new Centroid();
    c.add(va);
    c.add(vb);
    const center = c.vector();
    assert.ok(cosine(center, va) > cosine(va, vb));
    assert.ok(cosine(center, vb) > cosine(va, vb));
  });

  test('remove exactly reverses add', () => {
    // The property that makes a human splitting a cluster O(1) instead of a
    // full recompute over every member.
    const c = new Centroid();
    c.add(va);
    c.add(vb);
    const before = c.vector();

    c.add(vc);
    c.remove(vc);

    assert.equal(c.size, 2);
    close(cosine(c.vector(), before), 1);
  });

  test('add/remove cycles do not accumulate drift', () => {
    const c = new Centroid();
    c.add(va);
    const original = c.vector();
    for (let i = 0; i < 500; i++) {
      c.add(vb);
      c.remove(vb);
    }
    assert.equal(c.size, 1);
    close(cosine(c.vector(), original), 1);
  });

  test('removing a member prunes cancelled terms rather than growing the map', () => {
    const c = new Centroid();
    c.add(va);
    c.add(vc);
    const grown = c.vector().size;
    c.remove(vc);
    assert.ok(c.vector().size < grown, 'terms unique to the removed member should be gone');
  });

  test('is order-independent', () => {
    const x = new Centroid();
    x.add(va);
    x.add(vb);
    const y = new Centroid();
    y.add(vb);
    y.add(va);
    close(cosine(x.vector(), y.vector()), 1);
  });

  test('removing from an empty centroid throws rather than corrupting state', () => {
    assert.throws(() => new Centroid().remove(va), /empty centroid/);
  });
});
