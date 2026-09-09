/**
 * The rate limiter.
 *
 * Time is injected everywhere, so nothing here sleeps and the window
 * boundaries are exact. A limiter tested with real timers is a limiter tested
 * approximately.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRateLimiter, retryAfterSeconds } from './rate-limit.ts';

/** A limiter with a hand-cranked clock. */
function limiterAt(limit: number, windowMs: number, start = 1_000_000) {
  let clock = start;
  const limiter = createRateLimiter({ limit, windowMs, now: () => clock });
  return {
    limiter,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('createRateLimiter', () => {
  it('allows up to the limit and then refuses', () => {
    const { limiter } = limiterAt(3, 1000);

    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('a').allowed, false);
  });

  it('counts down the remaining allowance', () => {
    const { limiter } = limiterAt(3, 1000);
    assert.equal(limiter.check('a').remaining, 2);
    assert.equal(limiter.check('a').remaining, 1);
    assert.equal(limiter.check('a').remaining, 0);
  });

  it('keeps keys independent', () => {
    const { limiter } = limiterAt(1, 1000);
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('b').allowed, true);
    assert.equal(limiter.check('a').allowed, false);
  });

  it('slides rather than resetting on a fixed boundary', () => {
    const { limiter, advance } = limiterAt(2, 1000);

    limiter.check('a');
    advance(600);
    limiter.check('a');
    advance(100);
    // Both are still inside the window.
    assert.equal(limiter.check('a').allowed, false);

    // The first expires at t+1000, freeing exactly one slot — a fixed-window
    // limiter would have freed both and allowed a burst of 2×limit across the
    // boundary.
    advance(400);
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('a').allowed, false);
  });

  it('says when the caller may return, and is right', () => {
    const { limiter, advance } = limiterAt(1, 1000);

    limiter.check('a');
    advance(250);

    const refused = limiter.check('a');
    assert.equal(refused.allowed, false);
    assert.equal(refused.retryAfterMs, 750);

    // Obeying the number exactly must work, or a conforming client gets
    // refused twice and backs off further for having done the right thing.
    advance(750);
    assert.equal(limiter.check('a').allowed, true);
  });

  it('never advises a zero-millisecond wait', () => {
    const { limiter } = limiterAt(1, 1);
    limiter.check('a');
    assert.ok(limiter.check('a').retryAfterMs >= 1);
  });

  it('lets an idle key recover fully', () => {
    const { limiter, advance } = limiterAt(2, 1000);
    limiter.check('a');
    limiter.check('a');
    advance(1001);

    assert.equal(limiter.check('a').remaining, 1);
  });

  it('bounds the number of tracked keys', () => {
    // The key is caller-controlled. An unbounded map turns the limiter into
    // the memory-exhaustion vector it exists to prevent.
    const limiter = createRateLimiter({ limit: 10, windowMs: 1000, maxKeys: 3 });
    for (let i = 0; i < 50; i++) limiter.check(`key-${String(i)}`);
    assert.ok(limiter.size <= 3, `tracked ${String(limiter.size)} keys`);
  });

  it('does not grow without bound for one busy key', () => {
    const { limiter, advance } = limiterAt(2, 1000);
    for (let i = 0; i < 100; i++) {
      limiter.check('a');
      advance(100);
    }
    assert.equal(limiter.size, 1);
  });
});

describe('retryAfterSeconds', () => {
  it('rounds up', () => {
    // Rounding down yields `Retry-After: 0`, which a conforming client reads
    // as "retry immediately" — inviting the hammering the limit exists to stop.
    assert.equal(retryAfterSeconds(1), 1);
    assert.equal(retryAfterSeconds(999), 1);
    assert.equal(retryAfterSeconds(1001), 2);
  });

  it('is never zero', () => {
    assert.equal(retryAfterSeconds(0), 1);
  });
});
