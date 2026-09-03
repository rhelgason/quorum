/**
 * Ingest transport.
 *
 * Implements the error table in `PROTOCOL.md` literally, because each row is a
 * decision about whose resources get burned when something goes wrong:
 *
 * | status | meaning        | behaviour                                      |
 * | ------ | -------------- | ---------------------------------------------- |
 * | 202    | accepted       | dequeue                                        |
 * | 200    | duplicate id   | dequeue — this is success, not failure         |
 * | 400    | malformed      | **dequeue and drop permanently**               |
 * | 401    | bad key        | disable the SDK for the session, log once      |
 * | 413    | too large      | strip captures, retry the envelope alone       |
 * | 429    | rate limited   | honour `Retry-After`, then backoff with jitter |
 * | 5xx    | server         | backoff and retry, capped                      |
 *
 * The `400` row is the one people get wrong. A client that retries a malformed
 * event forever drains the user's battery and our ingest capacity, and nobody
 * ever notices because there is no human in the loop. Poison events are
 * dropped, counted, and reported.
 *
 * Backoff uses **full jitter**. Fixed backoff synchronises every client that
 * went offline during the same outage into a thundering herd the moment
 * connectivity returns — the retry storm then extends the outage it was
 * reacting to.
 */

import { PROTOCOL_VERSION, type CaptureEnvelope, type CaptureEvent } from './protocol.ts';
import type { OfflineQueue } from './queue.ts';
import type { Logger } from './log.ts';

export interface TransportOptions {
  endpoint: string;
  /** Public key. Write-only; safe in a client bundle. */
  project: string;
  queue: OfflineQueue;
  /** Events per request. Default 20. */
  batchSize?: number;
  /** Retries before an event is left for the next flush. Default 4. */
  maxRetries?: number;
  /** First backoff step in ms. Default 1000. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 30_000. */
  maxDelayMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1). Injectable so backoff is testable. */
  random?: () => number;
  logger?: Logger;
}

export interface FlushResult {
  sent: number;
  /** Events ingest had already seen. Counted as success. */
  duplicates: number;
  /** Permanently discarded as malformed. */
  dropped: number;
  /** Left in the queue for a later flush. */
  remaining: number;
  /** True when a 401 disabled the transport for this session. */
  disabled: boolean;
}

/** Full jitter: `random() * min(cap, base * 2^attempt)`. */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * exponential);
}

/** Parse `Retry-After`, which may be seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export class Transport {
  private readonly options: Required<
    Omit<TransportOptions, 'logger' | 'fetchImpl'>
  > & { logger: Logger | undefined; fetchImpl: typeof fetch };
  private disabled = false;
  private flushing = false;

  constructor(options: TransportOptions) {
    this.options = {
      endpoint: options.endpoint.replace(/\/+$/, ''),
      project: options.project,
      queue: options.queue,
      batchSize: options.batchSize ?? 20,
      maxRetries: options.maxRetries ?? 4,
      baseDelayMs: options.baseDelayMs ?? 1000,
      maxDelayMs: options.maxDelayMs ?? 30_000,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: options.random ?? Math.random,
      logger: options.logger,
    };
  }

  /** True once a 401 has disabled this transport for the session. */
  get isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * Drain the queue.
   *
   * Re-entrant calls return immediately rather than queueing up. Two
   * concurrent flushes would send the same events twice — harmless at ingest
   * thanks to idempotency, but it doubles request volume for no benefit, and
   * on mobile that is the user's battery.
   */
  async flush(): Promise<FlushResult> {
    const result: FlushResult = {
      sent: 0,
      duplicates: 0,
      dropped: 0,
      remaining: this.options.queue.size,
      disabled: this.disabled,
    };
    if (this.disabled || this.flushing) return result;

    this.flushing = true;
    try {
      for (;;) {
        const batch = this.options.queue.peek(this.options.batchSize);
        if (batch.length === 0) break;

        const outcome = await this.sendWithRetry(batch);

        if (outcome.kind === 'disabled') {
          this.disabled = true;
          result.disabled = true;
          break;
        }
        if (outcome.kind === 'give-up') break;

        const sizeBefore = this.options.queue.size;
        this.options.queue.acknowledge(outcome.settled);
        result.sent += outcome.accepted;
        result.duplicates += outcome.duplicates;
        result.dropped += outcome.dropped;

        // Progress is measured by the queue shrinking, never by what the
        // response claimed. An ingest that echoes stale or unknown ids would
        // otherwise spin this loop forever — burning the user's battery and
        // bandwidth with no error anywhere to show for it.
        if (this.options.queue.size >= sizeBefore) break;
      }
    } finally {
      this.flushing = false;
      result.remaining = this.options.queue.size;
    }
    return result;
  }

  private buildEnvelope(events: readonly CaptureEvent[]): CaptureEnvelope {
    return {
      v: PROTOCOL_VERSION,
      sentAt: new Date(this.options.now()).toISOString(),
      project: this.options.project,
      events: [...events],
    };
  }

  private async sendWithRetry(batch: CaptureEvent[]): Promise<
    | { kind: 'ok'; settled: string[]; accepted: number; duplicates: number; dropped: number }
    | { kind: 'disabled' }
    | { kind: 'give-up' }
  > {
    let payload = batch;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.options.fetchImpl(`${this.options.endpoint}/v0/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(this.buildEnvelope(payload)),
        });
      } catch (error) {
        // Offline. Not an error worth reporting — it is the expected state the
        // queue exists for.
        this.options.logger?.debug('flush failed, will retry', {
          attempt,
          reason: error instanceof Error ? error.message : 'network',
        });
        if (attempt === this.options.maxRetries) return { kind: 'give-up' };
        await this.options.sleep(
          backoffDelay(attempt, this.options.baseDelayMs, this.options.maxDelayMs, this.options.random),
        );
        continue;
      }

      const status = response.status;

      if (status === 202 || status === 200) {
        let accepted: string[] = [];
        let duplicate: string[] = [];
        try {
          const body = (await response.json()) as { accepted?: string[]; duplicate?: string[] };
          accepted = body.accepted ?? [];
          duplicate = body.duplicate ?? [];
        } catch {
          // Unreadable body. Fall through to the settle-everything rule below.
        }

        // A 2xx that names no ids still means ingest took the batch — that is
        // what 202 means in PROTOCOL.md. Treating it as "nothing accepted"
        // would leave every event queued and re-sent on every future flush,
        // forever, with no error anywhere to show for it.
        if (accepted.length === 0 && duplicate.length === 0) {
          accepted = payload.map((e) => e.id);
        }

        return {
          kind: 'ok',
          settled: [...accepted, ...duplicate],
          accepted: accepted.length,
          duplicates: duplicate.length,
          dropped: 0,
        };
      }

      if (status === 400) {
        // Poison. Never retried.
        this.options.logger?.warn('dropping malformed events', { count: payload.length });
        return {
          kind: 'ok',
          settled: payload.map((e) => e.id),
          accepted: 0,
          duplicates: 0,
          dropped: payload.length,
        };
      }

      if (status === 401 || status === 403) {
        this.options.logger?.error('ingest rejected the project key; disabling for this session');
        return { kind: 'disabled' };
      }

      if (status === 413) {
        const stripped = payload.map(({ captureRef: _ignored, ...rest }) => rest);
        const changed = stripped.some((e, i) => e !== payload[i]);
        if (changed && payload.some((e) => e.captureRef !== undefined)) {
          this.options.logger?.debug('payload too large, retrying without captures');
          payload = stripped;
          continue;
        }
        // Already stripped and still too large: splitting is the caller's
        // job via batchSize, so give up rather than loop.
        if (payload.length > 1) {
          payload = payload.slice(0, Math.ceil(payload.length / 2));
          continue;
        }
        this.options.logger?.warn('single event exceeds ingest limit, dropping');
        return {
          kind: 'ok',
          settled: payload.map((e) => e.id),
          accepted: 0,
          duplicates: 0,
          dropped: payload.length,
        };
      }

      if (attempt === this.options.maxRetries) return { kind: 'give-up' };

      const retryAfter =
        status === 429
          ? parseRetryAfter(response.headers?.get?.('retry-after') ?? null, this.options.now())
          : undefined;

      await this.options.sleep(
        retryAfter ??
          backoffDelay(attempt, this.options.baseDelayMs, this.options.maxDelayMs, this.options.random),
      );
    }

    return { kind: 'give-up' };
  }
}
