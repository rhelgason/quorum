import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStorage, OfflineQueue, type QueueStorage } from './queue.ts';
import type { CaptureEvent } from './protocol.ts';

function event(id: string, overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    id,
    kind: 'feature_request',
    source: 'nub',
    clientTs: '2026-09-01T00:00:00.000Z',
    body: 'please add dark mode',
    ...overrides,
  };
}

describe('durability', () => {
  test('an enqueued event is persisted immediately', () => {
    // Before any network attempt: a user who submits and closes the tab must
    // not lose their feedback.
    const storage = createMemoryStorage();
    new OfflineQueue({ storage }).enqueue(event('a'));
    assert.ok(storage.read()?.includes('"a"'));
  });

  test('a new queue restores what the previous one persisted', () => {
    const storage = createMemoryStorage();
    new OfflineQueue({ storage }).enqueue(event('a'));
    assert.deepEqual(new OfflineQueue({ storage }).peek().map((e) => e.id), ['a']);
  });

  test('acknowledging persists the removal', () => {
    const storage = createMemoryStorage();
    const q = new OfflineQueue({ storage });
    q.enqueue(event('a'));
    q.enqueue(event('b'));
    q.acknowledge(['a']);
    assert.deepEqual(new OfflineQueue({ storage }).peek().map((e) => e.id), ['b']);
  });

  test('corrupt storage is discarded, not thrown', () => {
    // A malformed queue must never brick the SDK on every startup for the rest
    // of that user's life.
    for (const junk of ['not json', '{"not":"an array"}', '[1,2,3]', '']) {
      const storage = createMemoryStorage(junk);
      assert.doesNotThrow(() => {
        const q = new OfflineQueue({ storage });
        assert.equal(q.size, 0);
      }, `failed on ${junk}`);
    }
  });

  test('partially malformed storage keeps the valid events', () => {
    const storage = createMemoryStorage(JSON.stringify([{ id: 'good' }, null, { noId: true }]));
    assert.deepEqual(new OfflineQueue({ storage }).peek().map((e) => e.id), ['good']);
  });
});

describe('idempotency', () => {
  test('re-enqueuing the same id is a no-op', () => {
    // A retry path that appends again would inflate the submission counts
    // ranking depends on.
    const q = new OfflineQueue();
    q.enqueue(event('a'));
    q.enqueue(event('a'));
    assert.equal(q.size, 1);
  });

  test('acknowledge removes by id, not by position', () => {
    // Positional removal races with an enqueue during an in-flight request.
    const q = new OfflineQueue();
    q.enqueue(event('a'));
    q.enqueue(event('b'));
    q.enqueue(event('c'));
    q.acknowledge(['b']);
    assert.deepEqual(q.peek().map((e) => e.id), ['a', 'c']);
  });

  test('acknowledging unknown ids is harmless', () => {
    const q = new OfflineQueue();
    q.enqueue(event('a'));
    q.acknowledge(['nope']);
    assert.equal(q.size, 1);
  });

  test('acknowledging nothing does not rewrite storage', () => {
    let writes = 0;
    const inner = createMemoryStorage();
    const storage: QueueStorage = {
      read: inner.read,
      write: (v) => {
        writes++;
        inner.write(v);
      },
      clear: inner.clear,
    };
    const q = new OfflineQueue({ storage });
    q.enqueue(event('a'));
    const before = writes;
    q.acknowledge([]);
    assert.equal(writes, before);
  });
});

describe('bounded eviction', () => {
  test('evicts oldest first when over the event cap', () => {
    // Feedback loses value with age, and dropping the newest would discard
    // what the user just typed.
    const q = new OfflineQueue({ maxEvents: 3 });
    for (const id of ['a', 'b', 'c', 'd']) q.enqueue(event(id));
    assert.deepEqual(q.peek().map((e) => e.id), ['b', 'c', 'd']);
  });

  test('reports drops so data loss is measurable', () => {
    const dropped: string[] = [];
    const q = new OfflineQueue({ maxEvents: 1, onDrop: (e) => dropped.push(e.id) });
    q.enqueue(event('a'));
    q.enqueue(event('b'));
    assert.deepEqual(dropped, ['a']);
    assert.equal(q.stats().dropped, 1);
  });

  test('detaches captures before dropping any event', () => {
    // An event without its screenshot is degraded; a lost event is gone.
    const q = new OfflineQueue({ maxBytes: 400 });
    for (const id of ['a', 'b', 'c']) {
      q.enqueue(event(id, { captureRef: `cap_${'x'.repeat(60)}` }));
    }
    const kept = q.peek();
    assert.ok(kept.length >= 2, 'events survived');
    assert.ok(
      kept.some((e) => e.captureRef === undefined),
      'captures were shed first',
    );
  });

  test('drops events only after every capture is gone', () => {
    const reasons: string[] = [];
    const q = new OfflineQueue({
      maxBytes: 200,
      onDrop: (_e, reason) => reasons.push(reason),
    });
    for (const id of ['a', 'b', 'c', 'd']) {
      q.enqueue(event(id, { captureRef: `cap_${'y'.repeat(80)}` }));
    }
    assert.ok(q.peek().every((e) => e.captureRef === undefined));
    if (reasons.length > 0) assert.ok(reasons.every((r) => r === 'bytes'));
  });

  test('a lowered bound is applied on restore', () => {
    const storage = createMemoryStorage();
    const big = new OfflineQueue({ storage, maxEvents: 10 });
    for (const id of ['a', 'b', 'c', 'd', 'e']) big.enqueue(event(id));
    assert.equal(new OfflineQueue({ storage, maxEvents: 2 }).size, 2);
  });

  test('a single oversized event does not loop forever', () => {
    const q = new OfflineQueue({ maxBytes: 10 });
    q.enqueue(event('huge', { body: 'x'.repeat(500) }));
    assert.equal(q.size, 0, 'dropped rather than hung');
  });
});

describe('inspection', () => {
  test('peek returns a copy, so callers cannot corrupt the queue', () => {
    const q = new OfflineQueue();
    q.enqueue(event('a'));
    q.peek().push(event('injected'));
    assert.equal(q.size, 1);
  });

  test('peek respects a limit and returns oldest first', () => {
    const q = new OfflineQueue();
    for (const id of ['a', 'b', 'c']) q.enqueue(event(id));
    assert.deepEqual(q.peek(2).map((e) => e.id), ['a', 'b']);
  });

  test('stats report count and byte size', () => {
    const q = new OfflineQueue();
    q.enqueue(event('a'));
    const s = q.stats();
    assert.equal(s.events, 1);
    assert.ok(s.bytes > 0);
  });

  test('clear empties both memory and storage', () => {
    const storage = createMemoryStorage();
    const q = new OfflineQueue({ storage });
    q.enqueue(event('a'));
    q.clear();
    assert.equal(q.size, 0);
    assert.equal(storage.read(), null);
  });
});
