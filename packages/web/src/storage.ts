/**
 * `localStorage` as the queue's durable store, and the anonymous id that lives
 * beside it.
 *
 * Both are wrapped rather than used directly, because `localStorage` throws
 * more often than people expect: Safari in private mode historically threw on
 * every write, an iframe on a third-party origin throws on *access* under
 * modern cookie policies, and a full quota throws on the write that fills it.
 * This is a script running on someone else's page, so every one of those has
 * to degrade to "keep working, lose durability" rather than propagate.
 */

import { createMemoryStorage, type QueueStorage } from '../../core/src/queue.ts';
import { ulid } from '../../core/src/ulid.ts';

/** The Web Storage surface actually used here. */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Read `localStorage`, or `undefined` where it is unavailable or forbidden.
 *
 * The access itself is inside the `try`: on a partitioned third-party origin,
 * merely touching `window.localStorage` is what throws.
 */
export function webStorage(): WebStorageLike | undefined {
  try {
    const storage = (globalThis as { localStorage?: WebStorageLike }).localStorage;
    if (storage === undefined || storage === null) return undefined;
    // Prove it is writable now rather than discovering it at submit time,
    // when a throw would cost the user their feedback.
    const probe = '__quorum_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return undefined;
  }
}

/**
 * A {@link QueueStorage} backed by one `localStorage` key.
 *
 * Falls back to memory when storage is unavailable. That is a real downgrade —
 * the queue no longer survives a reload — and it is the right one: the
 * alternative is a widget that throws on a page where storage is blocked.
 */
export function createWebQueueStorage(
  key: string,
  storage: WebStorageLike | undefined = webStorage(),
): QueueStorage {
  if (storage === undefined) return createMemoryStorage();

  return {
    read: () => {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    write: (value) => {
      try {
        storage.setItem(key, value);
      } catch {
        // Quota, most likely. The queue enforces its own byte budget, so the
        // in-memory copy is still correct — only durability is lost, and
        // there is nothing useful to do about it from here.
      }
    },
    clear: () => {
      try {
        storage.removeItem(key);
      } catch {
        // Same.
      }
    },
  };
}

/**
 * A stable per-project anonymous id.
 *
 * First-party storage, one key, trivially clearable, never derived from
 * anything about the device — `docs/PROTOCOL.md` requires all four, and
 * [ADR-0020](../../../docs/adr/0020-identity-is-never-guessed.md) explains
 * what the alternative costs: a fresh id per submission silently turns
 * unique-user ranking into submission counting, with nothing failing anywhere.
 *
 * Returns `undefined` when there is nowhere to persist it. That is deliberate
 * and is the same rule stated differently — an id that cannot be stable is
 * worse than no id at all, because ingest can bucket unattributed submissions
 * honestly but cannot un-inflate a user count.
 */
export function anonIdFor(
  project: string,
  storage: WebStorageLike | undefined = webStorage(),
  generate: () => string = ulid,
): string | undefined {
  if (storage === undefined) return undefined;
  const key = `quorum.anon.${project}`;

  try {
    const existing = storage.getItem(key);
    if (existing !== null && existing !== '') return existing;

    const fresh = generate();
    storage.setItem(key, fresh);
    return fresh;
  } catch {
    return undefined;
  }
}
