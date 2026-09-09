/**
 * A sliding-window rate limiter for the write path.
 *
 * `docs/PROTOCOL.md` publishes a `429` row, and `@quorum/core`'s transport
 * implements it in full — it parses `Retry-After` in both seconds and HTTP-date
 * form and backs off with jitter. The server had never sent one. An entire row
 * of the error table was client-side-only, which means the most carefully
 * written retry path in the repo had never been exercised against the thing it
 * was written for.
 *
 * It is also a real gap in front of an untrusted internet: the ingest key is
 * public by design, embedded in every page that loads the widget, and can only
 * write. "Can only write" is not much comfort when the write is unbounded.
 *
 * ## Sliding window, not a token bucket
 *
 * Both are defensible; this one is chosen because the number it enforces is
 * the number an operator configured. A token bucket with a burst allowance
 * lets through more than `limit` requests in some windows, which is fine
 * behaviour and a bad support conversation. A sliding window can say exactly
 * when the caller may return, which is what `Retry-After` has to carry.
 *
 * ## What it is not
 *
 * Not distributed. The counters live in one process's memory, so two instances
 * behind a load balancer each enforce the limit separately. Making it shared
 * means Redis or the database, and neither is in this service yet — so the
 * honest description is "protects a self-hosted single process", and it is
 * written down here rather than discovered later.
 */

export interface RateLimitOptions {
  /** Requests permitted per window, per key. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  now?: () => number;
  /**
   * Distinct keys tracked before the oldest are evicted. Default 10,000.
   *
   * A bound is not optional: the key is caller-controlled, so an unbounded map
   * turns the limiter into the memory-exhaustion vector it exists to prevent.
   */
  maxKeys?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** Milliseconds until the caller may retry. Zero when allowed. */
  retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string): RateLimitDecision;
  /** Tracked keys. Exposed for tests and diagnostics. */
  readonly size: number;
}

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const { limit, windowMs } = options;

  // Insertion-ordered, so evicting the oldest key is `keys().next()`.
  const hits = new Map<string, number[]>();

  return {
    check(key) {
      const at = now();
      const cutoff = at - windowMs;

      const previous = hits.get(key) ?? [];
      // Timestamps are appended in order, so the expired ones are a prefix.
      let start = 0;
      while (start < previous.length && (previous[start] as number) <= cutoff) start++;
      const recent = start === 0 ? previous : previous.slice(start);

      if (recent.length >= limit) {
        hits.set(key, recent);
        // The oldest request in the window is the one whose expiry frees a
        // slot. Rounded up, so a client that obeys exactly is never rejected
        // a second time for being one millisecond early.
        const retryAfterMs = Math.max(1, Math.ceil((recent[0] as number) + windowMs - at));
        return { allowed: false, remaining: 0, retryAfterMs };
      }

      recent.push(at);
      hits.set(key, recent);

      if (hits.size > maxKeys) {
        const oldest = hits.keys().next();
        if (!oldest.done) hits.delete(oldest.value);
      }

      return { allowed: true, remaining: limit - recent.length, retryAfterMs: 0 };
    },

    get size() {
      return hits.size;
    },
  };
}

/**
 * `Retry-After` accepts whole seconds, and rounds **up**.
 *
 * Rounding down produces a header saying `0`, which conforming clients read as
 * "retry immediately" — so the tightest possible limit would invite exactly
 * the hammering it was set to stop. The body carries the unrounded
 * milliseconds for clients that prefer it.
 */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
