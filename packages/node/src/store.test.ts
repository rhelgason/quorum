import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStore } from './store.ts';
import type { Submission } from './submission.ts';

function submission(id: string, overrides: Partial<Submission> = {}): Submission {
  return {
    id,
    projectId: 'p1',
    kind: 'feature_request',
    source: 'import',
    body: `body ${id}`,
    clusterText: `body ${id}`,
    userId: `u:${id}`,
    attributed: true,
    clientTs: '2026-09-01T00:00:00.000Z',
    receivedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('idempotency', () => {
  test('a repeated id is reported as a duplicate, not stored twice', () => {
    const store = new MemoryStore();
    return store.put(submission('a')).then(async (first) => {
      assert.equal(first, true);
      assert.equal(await store.put(submission('a')), false);
      assert.equal(await store.count('p1'), 1);
    });
  });

  test('the first write wins; a duplicate does not overwrite it', async () => {
    // A retried import must not replace the original record with a re-derived
    // one — submissions are append-only facts.
    const store = new MemoryStore();
    await store.put(submission('a', { body: 'original' }));
    await store.put(submission('a', { body: 'replacement' }));
    assert.equal((await store.get('p1', 'a'))?.body, 'original');
  });

  test('the same id in two projects is two records', async () => {
    // Ids are unique within a project, not globally — DATA-MODEL §2.
    const store = new MemoryStore();
    await store.put(submission('a'));
    await store.put(submission('a', { projectId: 'p2' }));
    assert.equal(await store.count('p1'), 1);
    assert.equal(await store.count('p2'), 1);
  });
});

describe('ordering', () => {
  test('list returns insertion order', async () => {
    // Leader-follower clustering is order-dependent, so an unstable iteration
    // order would reshuffle cluster ids between two reads of unchanged data.
    const store = new MemoryStore();
    for (const id of ['c', 'a', 'b']) await store.put(submission(id));
    assert.deepEqual((await store.list('p1')).map((s) => s.id), ['c', 'a', 'b']);
  });

  test('appending does not disturb existing order', async () => {
    const store = new MemoryStore();
    for (const id of ['a', 'b']) await store.put(submission(id));
    const before = (await store.list('p1')).map((s) => s.id);
    await store.put(submission('c'));
    assert.deepEqual((await store.list('p1')).map((s) => s.id).slice(0, 2), before);
  });

  test('mutating the returned list cannot corrupt the log', async () => {
    // The append-only guarantee is what the whole audit story rests on.
    const store = new MemoryStore();
    await store.put(submission('a'));
    (await store.list('p1') as Submission[]).length = 0;
    assert.equal(await store.count('p1'), 1);
  });
});

describe('reads on an unknown project', () => {
  test('list is empty rather than throwing', async () => {
    assert.deepEqual(await new MemoryStore().list('nope'), []);
  });

  test('count is zero', async () => {
    assert.equal(await new MemoryStore().count('nope'), 0);
  });

  test('get is undefined', async () => {
    assert.equal(await new MemoryStore().get('nope', 'a'), undefined);
  });

  test('get is undefined for an unknown id in a known project', async () => {
    const store = new MemoryStore();
    await store.put(submission('a'));
    assert.equal(await store.get('p1', 'zzz'), undefined);
  });
});
