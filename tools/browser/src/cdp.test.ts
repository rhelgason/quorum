/**
 * The CDP framing layer, tested against a fake socket.
 *
 * These are the parts that can be wrong in ways a browser would not reveal
 * quickly: a reply matched to the wrong call, a protocol error surfacing as a
 * resolved promise, or — the one that actually costs an afternoon — a dead
 * socket leaving every in-flight call pending until the test runner's global
 * timeout kills the process with no useful output.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CdpConnection, type SocketLike } from './cdp.ts';

/** A socket that records what was sent and lets a test push frames back. */
class FakeSocket implements SocketLike {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.#listeners.get(type) ?? [];
    existing.push(listener);
    this.#listeners.set(type, existing);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
  }

  /** Deliver a frame from the "browser". */
  receive(message: unknown): void {
    this.receiveRaw(JSON.stringify(message));
  }

  /** Deliver bytes the browser would never send, to prove they are survivable. */
  receiveRaw(data: string): void {
    for (const listener of this.#listeners.get('message') ?? []) listener({ data });
  }

  emit(type: 'close' | 'error'): void {
    for (const listener of this.#listeners.get(type) ?? []) listener({});
  }

  /** The most recent call's id, for replying to it. */
  get lastId(): number {
    return this.sent[this.sent.length - 1]?.['id'] as number;
  }
}

describe('CdpConnection framing', () => {
  it('sends a method call and resolves with its result', async () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket);

    const pending = connection.send('Runtime.evaluate', { expression: '1 + 1' });
    assert.deepEqual(socket.sent[0], {
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: '1 + 1' },
    });

    socket.receive({ id: 1, result: { result: { value: 2 } } });
    assert.deepEqual(await pending, { result: { value: 2 } });
  });

  it('rides a session id when one is given', async () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket);

    const pending = connection.send('Page.enable', {}, 'session-abc');
    assert.equal(socket.sent[0]?.['sessionId'], 'session-abc');

    socket.receive({ id: socket.lastId, result: {} });
    await pending;
  });

  it('matches replies by id, not by arrival order', async () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket);

    const first = connection.send('A');
    const second = connection.send('B');

    // Out of order on purpose: CDP makes no ordering promise across calls, and
    // a client that assumes one returns another call's answer.
    socket.receive({ id: 2, result: { which: 'B' } });
    socket.receive({ id: 1, result: { which: 'A' } });

    assert.deepEqual(await first, { which: 'A' });
    assert.deepEqual(await second, { which: 'B' });
  });

  it('turns a protocol error into a rejection naming the method', async () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket);

    const pending = connection.send('Runtime.evaluate');
    socket.receive({
      id: 1,
      error: { code: -32000, message: 'Cannot find context with specified id', data: 'ctx 7' },
    });

    await assert.rejects(pending, /Cannot find context with specified id \(ctx 7\)/);
  });

  it('resolves with an empty object when a reply carries no result', async () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket);

    const pending = connection.send('Target.closeTarget');
    socket.receive({ id: 1 });
    assert.deepEqual(await pending, {});
  });

  it('delivers events to listeners', () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket);

    const seen: string[] = [];
    connection.on((event) => seen.push(event.method));

    socket.receive({ method: 'Page.loadEventFired', params: { timestamp: 1 } });
    socket.receive({ method: 'Runtime.consoleAPICalled', params: { type: 'error' } });

    assert.deepEqual(seen, ['Page.loadEventFired', 'Runtime.consoleAPICalled']);
  });

  it('carries the session id through to the listener', () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket);

    let sessionId: string | undefined;
    connection.on((event) => {
      sessionId = event.sessionId;
    });

    socket.receive({ method: 'Runtime.exceptionThrown', params: {}, sessionId: 's1' });
    assert.equal(sessionId, 's1');
  });

  it('keeps pumping messages when a listener throws', () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket);

    const seen: string[] = [];
    connection.on(() => {
      throw new Error('listener blew up');
    });
    connection.on((event) => seen.push(event.method));

    socket.receive({ method: 'Page.loadEventFired', params: {} });
    // One bad listener must not strand every other subscriber, nor the
    // request/response correlation that shares this pump.
    assert.deepEqual(seen, ['Page.loadEventFired']);
  });

  it('ignores frames that are not JSON, and frames with no id or method', async () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket);
    connection.on(() => assert.fail('should not have dispatched an event'));

    socket.receiveRaw('<html>not the protocol</html>');
    socket.receive({ nonsense: true });

    // Still working afterwards: a junk frame must not poison the pump.
    const pending = connection.send('Runtime.evaluate');
    socket.receive({ id: socket.lastId, result: { ok: true } });
    assert.deepEqual(await pending, { ok: true });
  });

  it('ignores a reply to a call that already timed out', async () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket, 10);

    await assert.rejects(connection.send('A'), /timed out/);
    // Late arrival for a call nobody is waiting on. Dropped, not thrown.
    socket.receive({ id: 1, result: { late: true } });
  });

  it('once() resolves on the first matching event', async () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket);

    const loaded = connection.once('Page.loadEventFired');
    socket.receive({ method: 'Page.domContentEventFired', params: {} });
    socket.receive({ method: 'Page.loadEventFired', params: { timestamp: 42 } });

    assert.equal((await loaded).params['timestamp'], 42);
  });

  it('once() rejects on timeout rather than hanging', async () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket, 10);
    await assert.rejects(connection.once('Page.loadEventFired'), /timed out waiting for/);
  });

  it('times out a call rather than leaving it pending forever', async () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket, 10);
    await assert.rejects(connection.send('Runtime.evaluate'), /Runtime.evaluate timed out after 10ms/);
  });

  it('rejects everything in flight when the socket closes', async () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket);

    const first = connection.send('A');
    const second = connection.send('B');
    socket.emit('close');

    await assert.rejects(first, /devtools connection closed/);
    await assert.rejects(second, /devtools connection closed/);
  });

  it('rejects everything in flight when the socket errors', async () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket);

    const pending = connection.send('A');
    socket.emit('error');
    await assert.rejects(pending, /devtools connection errored/);
  });

  it('refuses to send on a closed connection', async () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket);

    connection.close();
    assert.equal(socket.closed, true);
    await assert.rejects(connection.send('A'), /closed by caller/);
  });

  it('unsubscribes cleanly', () => {
    const socket = new FakeSocket();
    const connection = CdpConnection.attach(socket);

    const seen: string[] = [];
    const off = connection.on((event) => seen.push(event.method));
    socket.receive({ method: 'One', params: {} });
    off();
    socket.receive({ method: 'Two', params: {} });

    assert.deepEqual(seen, ['One']);
  });
});
