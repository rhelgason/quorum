import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Emitter } from './emitter.ts';

interface Events {
  ping: { n: number };
  pong: { s: string };
}

describe('subscription', () => {
  test('a handler receives its payload', () => {
    const emitter = new Emitter<Events>();
    const seen: number[] = [];
    emitter.on('ping', (p) => seen.push(p.n));
    emitter.emit('ping', { n: 1 });
    assert.deepEqual(seen, [1]);
  });

  test('handlers only receive their own event', () => {
    const emitter = new Emitter<Events>();
    let pongs = 0;
    emitter.on('pong', () => pongs++);
    emitter.emit('ping', { n: 1 });
    assert.equal(pongs, 0);
  });

  test('emitting with no listeners is a no-op', () => {
    assert.doesNotThrow(() => new Emitter<Events>().emit('ping', { n: 1 }));
  });

  test('on returns an unsubscribe function', () => {
    const emitter = new Emitter<Events>();
    let calls = 0;
    const off = emitter.on('ping', () => calls++);
    off();
    emitter.emit('ping', { n: 1 });
    assert.equal(calls, 0);
  });

  test('off removes a specific handler', () => {
    const emitter = new Emitter<Events>();
    let a = 0;
    let b = 0;
    const handlerA = (): void => void a++;
    emitter.on('ping', handlerA);
    emitter.on('ping', () => b++);
    emitter.off('ping', handlerA);
    emitter.emit('ping', { n: 1 });
    assert.equal(a, 0);
    assert.equal(b, 1);
  });

  test('off on an unknown event is harmless', () => {
    assert.doesNotThrow(() => new Emitter<Events>().off('ping', () => {}));
  });

  test('the same handler added twice fires once', () => {
    // Set semantics: a component that re-subscribes on re-render must not
    // double-fire the customer's callback.
    const emitter = new Emitter<Events>();
    let calls = 0;
    const handler = (): void => void calls++;
    emitter.on('ping', handler);
    emitter.on('ping', handler);
    emitter.emit('ping', { n: 1 });
    assert.equal(calls, 1);
  });

  test('once fires exactly once', () => {
    const emitter = new Emitter<Events>();
    let calls = 0;
    emitter.once('ping', () => calls++);
    emitter.emit('ping', { n: 1 });
    emitter.emit('ping', { n: 2 });
    assert.equal(calls, 1);
  });

  test('once can be cancelled before it fires', () => {
    const emitter = new Emitter<Events>();
    let calls = 0;
    emitter.once('ping', () => calls++)();
    emitter.emit('ping', { n: 1 });
    assert.equal(calls, 0);
  });

  test('listenerCount reflects subscriptions and removals', () => {
    const emitter = new Emitter<Events>();
    assert.equal(emitter.listenerCount('ping'), 0);
    const off = emitter.on('ping', () => {});
    assert.equal(emitter.listenerCount('ping'), 1);
    off();
    assert.equal(emitter.listenerCount('ping'), 0);
  });

  test('removeAll clears every event', () => {
    const emitter = new Emitter<Events>();
    emitter.on('ping', () => {});
    emitter.on('pong', () => {});
    emitter.removeAll();
    assert.equal(emitter.listenerCount('ping'), 0);
    assert.equal(emitter.listenerCount('pong'), 0);
  });
});

describe('isolation', () => {
  test('a throwing handler does not stop the others', () => {
    // This runs inside a customer's app. One broken analytics callback must
    // not silently disable every other listener.
    const errors: unknown[] = [];
    const emitter = new Emitter<Events>({ onListenerError: (e) => errors.push(e) });
    let reached = false;
    emitter.on('ping', () => {
      throw new Error('boom');
    });
    emitter.on('ping', () => {
      reached = true;
    });
    emitter.emit('ping', { n: 1 });
    assert.equal(reached, true);
    assert.equal(errors.length, 1);
  });

  test('a throwing handler does not escape emit', () => {
    // Escaping would unwind into the middle of a state transition.
    const emitter = new Emitter<Events>({ onListenerError: () => {} });
    emitter.on('ping', () => {
      throw new Error('boom');
    });
    assert.doesNotThrow(() => emitter.emit('ping', { n: 1 }));
  });

  test('the error reporter is told which event failed', () => {
    const seen: string[] = [];
    const emitter = new Emitter<Events>({ onListenerError: (_e, event) => seen.push(event) });
    emitter.on('pong', () => {
      throw new Error('boom');
    });
    emitter.emit('pong', { s: 'x' });
    assert.deepEqual(seen, ['pong']);
  });
});

describe('mutation during dispatch', () => {
  test('a handler unsubscribing itself does not skip the next one', () => {
    // Iterating the live set would advance past a sibling when one is removed.
    const emitter = new Emitter<Events>();
    const order: string[] = [];
    const off = emitter.on('ping', () => {
      order.push('first');
      off();
    });
    emitter.on('ping', () => order.push('second'));
    emitter.emit('ping', { n: 1 });
    assert.deepEqual(order, ['first', 'second']);
  });

  test('a handler added during dispatch does not fire in that dispatch', () => {
    // Otherwise a handler that subscribes on every event loops forever.
    const emitter = new Emitter<Events>();
    let added = 0;
    emitter.on('ping', () => {
      emitter.on('ping', () => added++);
    });
    emitter.emit('ping', { n: 1 });
    assert.equal(added, 0);
  });
});
