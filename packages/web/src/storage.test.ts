/**
 * `localStorage` adapters.
 *
 * Every test here is about a throw. `localStorage` is the API people assume
 * cannot fail and which fails constantly in the exact conditions a
 * third-party widget runs in: private browsing, partitioned third-party
 * frames, and a full quota.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { anonIdFor, createWebQueueStorage, webStorage, type WebStorageLike } from './storage.ts';

/** An in-memory `localStorage`, optionally hostile. */
function fakeStorage(
  behaviour: { throwOnSet?: boolean; throwOnGet?: boolean; throwOnRemove?: boolean } = {},
): WebStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => {
      if (behaviour.throwOnGet === true) throw new Error('SecurityError');
      return map.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (behaviour.throwOnSet === true) throw new Error('QuotaExceededError');
      map.set(key, value);
    },
    removeItem: (key) => {
      if (behaviour.throwOnRemove === true) throw new Error('SecurityError');
      map.delete(key);
    },
  };
}

describe('webStorage', () => {
  it('is undefined when there is no localStorage at all', () => {
    // Which is the case in Node, and in every SSR render.
    assert.equal(webStorage(), undefined);
  });
});

describe('createWebQueueStorage', () => {
  it('reads and writes through to the underlying key', () => {
    const backing = fakeStorage();
    const storage = createWebQueueStorage('quorum.queue.pk', backing);

    assert.equal(storage.read(), null);
    storage.write('[]');
    assert.equal(backing.map.get('quorum.queue.pk'), '[]');
    assert.equal(storage.read(), '[]');

    storage.clear();
    assert.equal(storage.read(), null);
  });

  it('falls back to memory when storage is unavailable', () => {
    const storage = createWebQueueStorage('k', undefined);
    storage.write('[1]');
    // Degraded — this no longer survives a reload — but working. The
    // alternative is a widget that throws on a page where storage is blocked.
    assert.equal(storage.read(), '[1]');
  });

  it('swallows a quota error on write', () => {
    const storage = createWebQueueStorage('k', fakeStorage({ throwOnSet: true }));
    assert.doesNotThrow(() => storage.write('[]'));
  });

  it('reads null rather than throwing when access is denied', () => {
    const storage = createWebQueueStorage('k', fakeStorage({ throwOnGet: true }));
    assert.equal(storage.read(), null);
  });

  it('swallows a throw on clear', () => {
    const storage = createWebQueueStorage('k', fakeStorage({ throwOnRemove: true }));
    assert.doesNotThrow(() => storage.clear());
  });
});

describe('anonIdFor', () => {
  it('generates an id once and reuses it', () => {
    const backing = fakeStorage();
    let generated = 0;
    const generate = (): string => `id-${++generated}`;

    const first = anonIdFor('pk_live', backing, generate);
    const second = anonIdFor('pk_live', backing, generate);

    // The whole point. A fresh id per call would silently turn unique-user
    // ranking into submission counting, with nothing failing anywhere
    // (ADR-0020).
    assert.equal(first, 'id-1');
    assert.equal(second, 'id-1');
    assert.equal(generated, 1);
  });

  it('scopes the id per project', () => {
    const backing = fakeStorage();
    let n = 0;
    const generate = (): string => `id-${++n}`;

    assert.notEqual(anonIdFor('pk_a', backing, generate), anonIdFor('pk_b', backing, generate));
    assert.ok(backing.map.has('quorum.anon.pk_a'));
    assert.ok(backing.map.has('quorum.anon.pk_b'));
  });

  it('is undefined when there is nowhere to persist it', () => {
    // An id that cannot be stable is worse than no id: ingest can bucket
    // unattributed submissions honestly, but it cannot un-inflate a count.
    assert.equal(anonIdFor('pk', undefined), undefined);
  });

  it('is undefined when storage throws', () => {
    assert.equal(anonIdFor('pk', fakeStorage({ throwOnGet: true })), undefined);
    assert.equal(anonIdFor('pk', fakeStorage({ throwOnSet: true })), undefined);
  });

  it('replaces an empty stored value', () => {
    const backing = fakeStorage();
    backing.map.set('quorum.anon.pk', '');
    assert.equal(anonIdFor('pk', backing, () => 'fresh'), 'fresh');
  });
});
