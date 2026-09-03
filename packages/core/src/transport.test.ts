import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { backoffDelay, parseRetryAfter, Transport } from './transport.ts';
import { OfflineQueue } from './queue.ts';
import { createLogger } from './log.ts';
import type { CaptureEvent } from './protocol.ts';

function event(id: string, overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    id,
    kind: 'bug',
    source: 'nub',
    clientTs: '2026-09-01T00:00:00.000Z',
    body: 'the checkout button does nothing',
    ...overrides,
  };
}

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Scripted fetch. No test here touches the network. */
function scripted(replies: Reply[] | ((n: number) => Reply)) {
  const calls: { body: unknown }[] = [];
  let n = 0;
  const impl = (async (_url: string, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    const reply = typeof replies === 'function' ? replies(n) : (replies[n] ?? replies.at(-1)!);
    n++;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: (k: string) => reply.headers?.[k.toLowerCase()] ?? null },
      json: async () => reply.body ?? {},
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function harness(replies: Reply[] | ((n: number) => Reply), ids = ['a', 'b']) {
  const queue = new OfflineQueue();
  for (const id of ids) queue.enqueue(event(id));
  const { impl, calls } = scripted(replies);
  const slept: number[] = [];
  const transport = new Transport({
    endpoint: 'https://ingest.example/',
    project: 'pk_test',
    queue,
    fetchImpl: impl,
    now: () => 1_000_000,
    sleep: async (ms) => {
      slept.push(ms);
    },
    random: () => 0.5,
  });
  return { queue, transport, calls, slept };
}

const OK = (ids: string[]): Reply => ({ status: 202, body: { accepted: ids, duplicate: [] } });

describe('happy path', () => {
  test('accepted events are dequeued', async () => {
    const { queue, transport } = harness([OK(['a', 'b'])]);
    const r = await transport.flush();
    assert.equal(r.sent, 2);
    assert.equal(queue.size, 0);
  });

  test('sends a versioned envelope with the project key', async () => {
    const { transport, calls } = harness([OK(['a', 'b'])]);
    await transport.flush();
    const body = calls[0]?.body as { v: number; project: string; events: unknown[] };
    assert.equal(body.v, 0);
    assert.equal(body.project, 'pk_test');
    assert.equal(body.events.length, 2);
  });

  test('duplicates count as success and are dequeued', async () => {
    // 200 means ingest already has it. Retrying would loop forever.
    const { queue, transport } = harness([{ status: 200, body: { accepted: [], duplicate: ['a', 'b'] } }]);
    const r = await transport.flush();
    assert.equal(r.duplicates, 2);
    assert.equal(queue.size, 0);
  });

  test('batches across multiple requests', async () => {
    const queue = new OfflineQueue();
    for (let i = 0; i < 5; i++) queue.enqueue(event(`e${i}`));
    const { impl, calls } = scripted((n) => OK([`e${n * 2}`, `e${n * 2 + 1}`]));
    const transport = new Transport({
      endpoint: 'https://x',
      project: 'p',
      queue,
      batchSize: 2,
      fetchImpl: impl,
      sleep: async () => {},
      random: () => 0,
    });
    await transport.flush();
    assert.ok(calls.length >= 3, `expected several batches, got ${calls.length}`);
  });

  test('a 202 naming no ids still settles the batch', async () => {
    // Regression: treating an id-less 202 as "nothing accepted" left every
    // event queued and re-sent on every future flush, forever, with no error
    // anywhere to show for it.
    const { queue, transport } = harness([{ status: 202, body: {} }]);
    const r = await transport.flush();
    assert.equal(queue.size, 0);
    assert.equal(r.sent, 2, 'assumed accepted rather than looping');
  });

  test('a 2xx with an unreadable body settles rather than looping', async () => {
    const queue = new OfflineQueue();
    queue.enqueue(event('a'));
    const impl = (async () => ({
      ok: true,
      status: 202,
      headers: { get: () => null },
      json: async () => {
        throw new Error('not json');
      },
    })) as unknown as typeof fetch;
    const transport = new Transport({
      endpoint: 'https://x',
      project: 'p',
      queue,
      fetchImpl: impl,
      sleep: async () => {},
      random: () => 0,
    });
    assert.equal((await transport.flush()).sent, 1);
    assert.equal(queue.size, 0);
  });

  test('an empty queue makes no request', async () => {
    const { transport, calls } = harness([OK([])], []);
    const r = await transport.flush();
    assert.equal(calls.length, 0);
    assert.equal(r.sent, 0);
  });
});

describe('the error table', () => {
  test('400 drops permanently instead of retrying forever', async () => {
    // A client that retries a poison event drains the user's battery and our
    // ingest capacity, and no human ever notices.
    const { queue, transport, calls } = harness([{ status: 400 }]);
    const r = await transport.flush();
    assert.equal(r.dropped, 2);
    assert.equal(queue.size, 0);
    assert.equal(calls.length, 1, 'exactly one attempt');
  });

  test('401 disables the transport for the session and stops flushing', async () => {
    const { queue, transport, calls } = harness([{ status: 401 }]);
    const r = await transport.flush();
    assert.equal(r.disabled, true);
    assert.equal(transport.isDisabled, true);
    assert.equal(queue.size, 2, 'events retained, not discarded');

    await transport.flush();
    assert.equal(calls.length, 1, 'no further requests once disabled');
  });

  test('403 is treated like 401', async () => {
    const { transport } = harness([{ status: 403 }]);
    assert.equal((await transport.flush()).disabled, true);
  });

  test('413 retries without captures before giving up', async () => {
    const queue = new OfflineQueue();
    queue.enqueue(event('a', { captureRef: 'cap_1' }));
    const { impl, calls } = scripted((n) => (n === 0 ? { status: 413 } : OK(['a'])));
    const transport = new Transport({
      endpoint: 'https://x',
      project: 'p',
      queue,
      fetchImpl: impl,
      sleep: async () => {},
      random: () => 0,
    });
    const r = await transport.flush();
    assert.equal(r.sent, 1);
    const retried = (calls[1]?.body as { events: CaptureEvent[] }).events;
    assert.equal(retried[0]?.captureRef, undefined, 'capture stripped on retry');
  });

  test('413 on a single capture-less event drops it rather than looping', async () => {
    const queue = new OfflineQueue();
    queue.enqueue(event('big', { body: 'x'.repeat(50) }));
    const { impl, calls } = scripted([{ status: 413 }]);
    const transport = new Transport({
      endpoint: 'https://x',
      project: 'p',
      queue,
      fetchImpl: impl,
      sleep: async () => {},
      random: () => 0,
    });
    const r = await transport.flush();
    assert.equal(r.dropped, 1);
    assert.equal(queue.size, 0);
    assert.ok(calls.length < 5, 'did not spin');
  });

  test('413 halves an over-large capture-less batch and retries', async () => {
    // Splitting rather than dropping: a batch too large as a whole may be
    // perfectly acceptable in halves, and the events are still good.
    const queue = new OfflineQueue();
    for (const id of ['a', 'b', 'c', 'd']) queue.enqueue(event(id));
    const { impl, calls } = scripted((n) => (n === 0 ? { status: 413 } : OK(['a', 'b'])));
    const transport = new Transport({
      endpoint: 'https://x',
      project: 'p',
      queue,
      maxRetries: 1,
      batchSize: 4,
      fetchImpl: impl,
      sleep: async () => {},
      random: () => 0,
    });
    await transport.flush();
    const second = (calls[1]?.body as { events: CaptureEvent[] }).events;
    assert.equal(second.length, 2, 'batch halved');
  });

  test('a response echoing unknown ids terminates instead of spinning', async () => {
    // Regression: progress was measured from the response rather than from the
    // queue, so an ingest returning stale ids looped forever.
    const queue = new OfflineQueue();
    queue.enqueue(event('a'));
    const { impl, calls } = scripted([{ status: 202, body: { accepted: ['not-in-queue'], duplicate: [] } }]);
    const transport = new Transport({
      endpoint: 'https://x',
      project: 'p',
      queue,
      fetchImpl: impl,
      sleep: async () => {},
      random: () => 0,
    });
    await transport.flush();
    assert.ok(calls.length <= 2, `expected termination, made ${calls.length} requests`);
    assert.equal(queue.size, 1, 'the event is retained for a later flush');
  });

  test('a logger receives transport diagnostics without leaking bodies', async () => {
    const records: { message: string }[] = [];
    const queue = new OfflineQueue();
    queue.enqueue(event('a', { body: 'contact me at user@example.com' }));
    const { impl } = scripted([{ status: 400 }]);
    const logger = createLogger({
      level: 'debug',
      sink: (r) => records.push({ message: r.message }),
      now: () => 0,
    });
    const transport = new Transport({
      endpoint: 'https://x',
      project: 'p',
      queue,
      fetchImpl: impl,
      sleep: async () => {},
      random: () => 0,
      logger,
    });
    await transport.flush();
    assert.ok(records.some((r) => /malformed/.test(r.message)));
    assert.ok(!records.some((r) => /user@example\.com/.test(r.message)), 'no PII in logs');
  });

  test('429 honours Retry-After in seconds', async () => {
    const { transport, slept } = harness((n) =>
      n === 0 ? { status: 429, headers: { 'retry-after': '7' } } : OK(['a', 'b']),
    );
    await transport.flush();
    assert.equal(slept[0], 7000);
  });

  test('5xx retries with backoff, then leaves the queue intact', async () => {
    const { queue, transport, calls } = harness([{ status: 503 }]);
    const r = await transport.flush();
    assert.equal(r.sent, 0);
    assert.equal(queue.size, 2, 'nothing lost to a server outage');
    assert.equal(calls.length, 5, 'initial attempt plus four retries');
  });

  test('a network failure is retried and never loses events', async () => {
    const queue = new OfflineQueue();
    queue.enqueue(event('a'));
    const impl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const transport = new Transport({
      endpoint: 'https://x',
      project: 'p',
      queue,
      maxRetries: 2,
      fetchImpl: impl,
      sleep: async () => {},
      random: () => 0,
    });
    const r = await transport.flush();
    assert.equal(r.sent, 0);
    assert.equal(queue.size, 1, 'the whole point of the queue');
  });

  test('recovers on a later flush after a transient outage', async () => {
    let failing = true;
    const queue = new OfflineQueue();
    queue.enqueue(event('a'));
    const impl = (async () => {
      if (failing) throw new Error('offline');
      return { ok: true, status: 202, headers: { get: () => null }, json: async () => ({ accepted: ['a'], duplicate: [] }) };
    }) as unknown as typeof fetch;
    const transport = new Transport({
      endpoint: 'https://x',
      project: 'p',
      queue,
      maxRetries: 0,
      fetchImpl: impl,
      sleep: async () => {},
      random: () => 0,
    });
    await transport.flush();
    assert.equal(queue.size, 1);
    failing = false;
    await transport.flush();
    assert.equal(queue.size, 0);
  });
});

describe('re-entrancy', () => {
  test('concurrent flushes do not double-send', async () => {
    // Idempotency makes this harmless at ingest, but it doubles request volume
    // for nothing — and on mobile that is the user's battery.
    const queue = new OfflineQueue();
    queue.enqueue(event('a'));
    let inFlight = 0;
    let maxConcurrent = 0;
    const impl = (async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, status: 202, headers: { get: () => null }, json: async () => ({ accepted: ['a'], duplicate: [] }) };
    }) as unknown as typeof fetch;
    const transport = new Transport({ endpoint: 'https://x', project: 'p', queue, fetchImpl: impl });
    await Promise.all([transport.flush(), transport.flush(), transport.flush()]);
    assert.equal(maxConcurrent, 1);
  });
});

describe('backoffDelay', () => {
  test('grows exponentially and respects the cap', () => {
    assert.equal(backoffDelay(0, 1000, 30_000, () => 1), 1000);
    assert.equal(backoffDelay(1, 1000, 30_000, () => 1), 2000);
    assert.equal(backoffDelay(2, 1000, 30_000, () => 1), 4000);
    assert.equal(backoffDelay(10, 1000, 30_000, () => 1), 30_000);
  });

  test('applies full jitter, so clients do not synchronise after an outage', () => {
    // Fixed backoff turns every client that went offline together into a
    // thundering herd the moment connectivity returns.
    assert.equal(backoffDelay(3, 1000, 30_000, () => 0), 0);
    assert.equal(backoffDelay(3, 1000, 30_000, () => 0.5), 4000);
  });
});

describe('parseRetryAfter', () => {
  test('parses seconds', () => {
    assert.equal(parseRetryAfter('30', 0), 30_000);
    assert.equal(parseRetryAfter('0', 0), 0);
  });

  test('parses an HTTP date relative to now', () => {
    const now = Date.parse('2026-09-01T00:00:00Z');
    assert.equal(parseRetryAfter('Tue, 01 Sep 2026 00:00:10 GMT', now), 10_000);
  });

  test('never returns a negative delay for a past date', () => {
    const now = Date.parse('2026-09-01T00:01:00Z');
    assert.equal(parseRetryAfter('Tue, 01 Sep 2026 00:00:00 GMT', now), 0);
  });

  test('returns undefined for missing or unparseable values', () => {
    assert.equal(parseRetryAfter(null, 0), undefined);
    assert.equal(parseRetryAfter('  ', 0), undefined);
    assert.equal(parseRetryAfter('soon', 0), undefined);
  });
});
