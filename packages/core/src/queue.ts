/**
 * Bounded, persistent offline queue.
 *
 * The scenario this exists for: a user files feedback from a subway, closes
 * the app, and the flush happens twenty minutes later — possibly twice.
 * `PROTOCOL.md` makes that safe by giving every event a client-generated ULID
 * that doubles as an idempotency key.
 *
 * Three rules, each of which loses data if broken:
 *
 * **Persist before sending.** An event is written to storage before any
 * network attempt. Reversing that loses the submission of anyone who submits
 * and immediately closes the tab, which is a large fraction of frustrated
 * users.
 *
 * **Drop captures before envelopes.** When the queue is over budget, the
 * screenshot goes first and the text survives. A submission without its
 * attachment is degraded; a lost submission is gone.
 *
 * **Oldest-first eviction.** Feedback loses value with age, and a queue that
 * dropped the newest item would discard the thing the user just typed.
 *
 * Storage is injected rather than assumed, so core stays DOM-free: web passes
 * a `localStorage` adapter, iOS a file or Keychain adapter, tests the
 * in-memory one.
 */

import type { CaptureEvent } from './protocol.ts';

/**
 * Minimal synchronous key-value storage.
 *
 * Synchronous on purpose. The queue must be durable before `submit()` returns,
 * and an async write can be interrupted by the page unloading — precisely the
 * moment durability matters most.
 */
export interface QueueStorage {
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

export function createMemoryStorage(initial?: string): QueueStorage {
  let value: string | null = initial ?? null;
  return {
    read: () => value,
    write: (v) => {
      value = v;
    },
    clear: () => {
      value = null;
    },
  };
}

export interface QueueOptions {
  storage?: QueueStorage;
  /** Default 100. */
  maxEvents?: number;
  /** Default 1_000_000. Approximate, measured as serialized JSON length. */
  maxBytes?: number;
  /** Called when an event is evicted, so the caller can count data loss. */
  onDrop?: (event: CaptureEvent, reason: 'count' | 'bytes') => void;
}

export interface QueueStats {
  events: number;
  bytes: number;
  /** Cumulative evictions since construction. Worth reporting as a metric. */
  dropped: number;
}

export class OfflineQueue {
  private events: CaptureEvent[] = [];
  private readonly storage: QueueStorage;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly onDrop: ((event: CaptureEvent, reason: 'count' | 'bytes') => void) | undefined;
  private droppedCount = 0;

  constructor(options: QueueOptions = {}) {
    this.storage = options.storage ?? createMemoryStorage();
    this.maxEvents = options.maxEvents ?? 100;
    this.maxBytes = options.maxBytes ?? 1_000_000;
    this.onDrop = options.onDrop;
    this.restore();
  }

  /**
   * Load persisted events.
   *
   * Corrupt storage is discarded rather than thrown. A malformed queue must
   * not brick the SDK on every startup for the rest of that user's life —
   * losing a backlog is bad, permanently breaking feedback is worse.
   */
  private restore(): void {
    const raw = this.storage.read();
    if (raw === null || raw === '') return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this.storage.clear();
        return;
      }
      this.events = parsed.filter(
        (e): e is CaptureEvent =>
          typeof e === 'object' && e !== null && typeof (e as CaptureEvent).id === 'string',
      );
      // Bounds may have been lowered since this was written.
      this.enforceBounds();
    } catch {
      this.storage.clear();
      this.events = [];
    }
  }

  private persist(): void {
    this.storage.write(JSON.stringify(this.events));
  }

  private byteSize(): number {
    return JSON.stringify(this.events).length;
  }

  /**
   * Bring the queue back within budget.
   *
   * Captures are detached before any event is dropped, so an over-budget queue
   * degrades in quality before it loses submissions.
   */
  private enforceBounds(): void {
    while (this.events.length > this.maxEvents) {
      const dropped = this.events.shift();
      if (dropped !== undefined) {
        this.droppedCount++;
        this.onDrop?.(dropped, 'count');
      }
    }

    if (this.byteSize() <= this.maxBytes) return;

    // Shed capture references oldest-first; each one is a large blob whose
    // absence costs only debugging detail.
    for (const event of this.events) {
      if (this.byteSize() <= this.maxBytes) break;
      if (event.captureRef !== undefined) delete event.captureRef;
    }

    // Still over: now start losing events, oldest first.
    while (this.events.length > 0 && this.byteSize() > this.maxBytes) {
      const dropped = this.events.shift();
      if (dropped !== undefined) {
        this.droppedCount++;
        this.onDrop?.(dropped, 'bytes');
      }
    }
  }

  /**
   * Enqueue and persist.
   *
   * Re-enqueuing an id already present is a no-op rather than a duplicate.
   * A retry path that appends again would send the same event twice and
   * inflate the very submission counts ranking depends on.
   */
  enqueue(event: CaptureEvent): void {
    if (this.events.some((e) => e.id === event.id)) return;
    this.events.push(event);
    this.enforceBounds();
    this.persist();
  }

  /** A copy of the pending events, oldest first. */
  peek(limit?: number): CaptureEvent[] {
    return limit === undefined ? [...this.events] : this.events.slice(0, limit);
  }

  /**
   * Remove events that ingest has accepted.
   *
   * Removal is by id, not by position. Positional removal races with an
   * enqueue that happens during an in-flight request and would discard the
   * wrong event.
   */
  acknowledge(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const done = new Set(ids);
    const before = this.events.length;
    this.events = this.events.filter((e) => !done.has(e.id));
    if (this.events.length !== before) this.persist();
  }

  get size(): number {
    return this.events.length;
  }

  stats(): QueueStats {
    return { events: this.events.length, bytes: this.byteSize(), dropped: this.droppedCount };
  }

  clear(): void {
    this.events = [];
    this.storage.clear();
  }
}
