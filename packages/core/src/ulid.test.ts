import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createUlidFactory, isUlid, MAX_ULID_TIME, ulid, ulidTime } from './ulid.ts';

/** Deterministic byte source, so ids are reproducible in tests. */
function seededBytes(seed = 0): (into: Uint8Array) => void {
  let n = seed;
  return (into) => {
    for (let i = 0; i < into.length; i++) into[i] = (n = (n * 1103515245 + 12345) & 0x7fffffff) & 0xff;
  };
}

describe('format', () => {
  test('is 26 Crockford base32 characters', () => {
    const id = createUlidFactory({ now: () => 1_700_000_000_000, randomBytes: seededBytes() })();
    assert.equal(id.length, 26);
    assert.ok(isUlid(id));
  });

  test('excludes the ambiguous letters I, L, O and U', () => {
    // So an id read aloud from a support ticket is unambiguous.
    const factory = createUlidFactory({ randomBytes: seededBytes(7) });
    for (let i = 0; i < 200; i++) {
      for (const ch of factory()) {
        assert.ok(!'ILOU'.includes(ch), `found '${ch}' in a ULID`);
      }
    }
  });

  test('the real factory produces valid ids', () => {
    assert.ok(isUlid(ulid()));
  });

  test('isUlid rejects wrong lengths and bad characters', () => {
    assert.equal(isUlid(''), false);
    assert.equal(isUlid('0123456789'), false);
    assert.equal(isUlid('I'.repeat(26)), false);
  });
});

describe('time encoding', () => {
  test('round-trips a timestamp', () => {
    const now = 1_756_000_000_000;
    const id = createUlidFactory({ now: () => now, randomBytes: seededBytes() })();
    assert.equal(ulidTime(id), now);
  });

  test('handles the epoch and the maximum', () => {
    assert.equal(ulidTime(createUlidFactory({ now: () => 0, randomBytes: seededBytes() })()), 0);
    assert.equal(
      ulidTime(createUlidFactory({ now: () => MAX_ULID_TIME, randomBytes: seededBytes() })()),
      MAX_ULID_TIME,
    );
  });

  test('rejects out-of-range timestamps rather than emitting a corrupt id', () => {
    assert.throws(() => createUlidFactory({ now: () => -1, randomBytes: seededBytes() })(), /out of range/);
    assert.throws(
      () => createUlidFactory({ now: () => MAX_ULID_TIME + 1, randomBytes: seededBytes() })(),
      /out of range/,
    );
  });

  test('ulidTime rejects an invalid character', () => {
    assert.throws(() => ulidTime('I'.repeat(26)), /invalid ULID character/);
  });
});

describe('sortability', () => {
  test('ids sort lexicographically by time', () => {
    let now = 1_000_000;
    const factory = createUlidFactory({ now: () => now, randomBytes: seededBytes() });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(factory());
      now += 1000;
    }
    assert.deepEqual(ids, [...ids].sort(), 'a flushed backlog reconstructs its order');
  });
});

describe('monotonicity within a millisecond', () => {
  test('ids in the same tick are unique and increasing', () => {
    // A collision here is silently swallowed by ingest as a duplicate — the
    // worst failure mode available, because it looks like success.
    const factory = createUlidFactory({ now: () => 12345, randomBytes: seededBytes() });
    const ids = Array.from({ length: 5000 }, () => factory());
    assert.equal(new Set(ids).size, ids.length, 'no collisions');
    assert.deepEqual(ids, [...ids].sort(), 'strictly increasing');
  });

  test('a backwards clock does not produce an id that sorts earlier', () => {
    // NTP corrections and users changing device time are routine on phones.
    // Monotonic ids matter more than agreement with the wall clock.
    let now = 5_000_000;
    const factory = createUlidFactory({ now: () => now, randomBytes: seededBytes() });
    const first = factory();
    now = 4_000_000;
    const second = factory();
    const third = factory();
    assert.ok(second > first, 'held the previous timestamp');
    assert.ok(third > second);
  });

  test('a fresh random component is drawn when the clock advances', () => {
    let now = 1000;
    const factory = createUlidFactory({ now: () => now, randomBytes: seededBytes() });
    const a = factory();
    now = 2000;
    const b = factory();
    assert.notEqual(a.slice(10), b.slice(10));
  });

  test('overflow throws rather than silently repeating an id', () => {
    // Needs 32^16 ids in one millisecond, so it will never happen — but
    // wrapping would emit a duplicate and therefore drop a submission.
    const maxBytes = (into: Uint8Array) => into.fill(31);
    const factory = createUlidFactory({ now: () => 1, randomBytes: maxBytes });
    factory();
    assert.throws(() => factory(), /overflowed/);
  });
});

describe('isolation', () => {
  test('factories keep independent monotonic state', () => {
    // Two SDK instances on one page must not share a counter. Each factory
    // gets its own seeded source, so identical inputs must give identical
    // first ids no matter what the other factory has done.
    const make = () => createUlidFactory({ now: () => 999, randomBytes: seededBytes(3) });
    const a = make();
    const firstFromA = a();
    a();
    a();
    assert.equal(make()(), firstFromA, 'B is unaffected by A advancing');
  });
});
