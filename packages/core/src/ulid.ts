/**
 * ULID generation.
 *
 * `PROTOCOL.md` makes the event id do double duty as the idempotency key:
 * ingest treats `(project, id)` as unique and returns 200 on replay, which is
 * what lets the offline queue retry safely. That imposes two requirements a
 * plain UUID does not meet as well:
 *
 *  - **Time-sortable.** A backlog flushed out of order still reconstructs its
 *    original sequence, and the id itself is a usable tiebreak.
 *  - **Monotonic within a millisecond.** Two submissions in the same tick must
 *    not collide, or the second is silently swallowed as a duplicate — the
 *    worst possible failure, because it looks like success.
 *
 * Crockford base32: no `I`, `L`, `O`, or `U`, so an id read aloud from a
 * support ticket or copied out of a log is unambiguous.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** 2^48 - 1 ms, i.e. the year 10889. */
export const MAX_ULID_TIME = 281_474_976_710_655;

export interface UlidOptions {
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Fills a byte array with random values. Defaults to `crypto.getRandomValues`.
   * Injectable so tests are deterministic without patching globals.
   */
  randomBytes?: (into: Uint8Array) => void;
}

function defaultRandomBytes(into: Uint8Array): void {
  globalThis.crypto.getRandomValues(into);
}

function encodeTime(time: number): string {
  if (!Number.isFinite(time) || time < 0 || time > MAX_ULID_TIME) {
    throw new Error(`ULID timestamp out of range: ${time}`);
  }
  let remaining = Math.floor(time);
  let out = '';
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = remaining % ENCODING_LEN;
    out = ENCODING[mod] + out;
    remaining = (remaining - mod) / ENCODING_LEN;
  }
  return out;
}

/**
 * Creates a ULID factory with monotonic guarantees.
 *
 * Each factory keeps its own state, so tests never share a counter and two
 * SDK instances in one page cannot interfere.
 */
export function createUlidFactory(options: UlidOptions = {}): () => string {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;

  /** `undefined` until the first id, so no real timestamp can collide with the sentinel. */
  let lastTime: number | undefined;
  /** Random component of the previous id, as base32 char indices. */
  let lastRandom: number[] = [];

  function freshRandom(): number[] {
    const bytes = new Uint8Array(RANDOM_LEN);
    randomBytes(bytes);
    // One byte per character, reduced to the 32-symbol alphabet. Slight modulo
    // bias is irrelevant here: this is a collision-avoidance nonce inside a
    // millisecond bucket, not a security token.
    return Array.from(bytes, (b) => b % ENCODING_LEN);
  }

  /**
   * Increment the previous random component as a base32 big integer.
   *
   * This is what makes ids issued in the same millisecond strictly increasing.
   * Overflow (all characters at max) is astronomically unlikely — it needs
   * 32^16 ids in one millisecond — but if it happened, silently wrapping would
   * produce a duplicate id and therefore a dropped submission. Throwing is the
   * safe failure.
   */
  function incrementRandom(previous: number[]): number[] {
    if (previous.length === 0) return freshRandom();
    const next = [...previous];
    for (let i = next.length - 1; i >= 0; i--) {
      if ((next[i] as number) < ENCODING_LEN - 1) {
        next[i] = (next[i] as number) + 1;
        return next;
      }
      next[i] = 0;
    }
    throw new Error('ULID random component overflowed within a single millisecond');
  }

  return function ulid(): string {
    const time = now();
    // Validate before any branching, so a bad clock reports the real problem
    // rather than surfacing as a spurious overflow further down.
    if (!Number.isFinite(time) || time < 0 || time > MAX_ULID_TIME) {
      throw new Error(`ULID timestamp out of range: ${time}`);
    }

    if (lastTime !== undefined && time === lastTime) {
      lastRandom = incrementRandom(lastRandom);
    } else if (lastTime !== undefined && time < lastTime) {
      // The clock moved backwards — NTP correction, or a user changing the
      // device time, which is common on phones. Monotonicity of ids matters
      // more than their agreement with the wall clock, so hold the previous
      // timestamp and keep incrementing rather than emitting an id that sorts
      // before one already sent.
      lastRandom = incrementRandom(lastRandom);
      return encodeTime(lastTime) + lastRandom.map((i) => ENCODING[i]).join('');
    } else {
      lastTime = time;
      lastRandom = freshRandom();
    }

    return encodeTime(lastTime) + lastRandom.map((i) => ENCODING[i]).join('');
  };
}

/** Convenience factory using the real clock and crypto. */
export const ulid: () => string = createUlidFactory();

/** Extract the millisecond timestamp encoded in a ULID. */
export function ulidTime(id: string): number {
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const index = ENCODING.indexOf(id[i] as string);
    if (index === -1) throw new Error(`invalid ULID character at position ${i}: ${id[i]}`);
    time = time * ENCODING_LEN + index;
  }
  return time;
}

export function isUlid(value: string): boolean {
  if (value.length !== TIME_LEN + RANDOM_LEN) return false;
  for (const ch of value) {
    if (!ENCODING.includes(ch)) return false;
  }
  return true;
}
