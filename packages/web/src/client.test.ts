/**
 * The browser client.
 *
 * Two groups. The first builds envelopes and asserts on their contents — this
 * is where the ranking signals are either produced or silently lost. The
 * second runs `submit()` against a fake ingest and checks that each protocol
 * outcome maps to the right answer for the panel to show, because `queued`
 * being reported as a failure is the difference between "we saved your
 * feedback" and "throw it away and retype it later."
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMemoryStorage, OfflineQueue } from '../../core/src/queue.ts';
import { Transport } from '../../core/src/transport.ts';
import { QuorumClient, SDK_VERSION, type QuorumClientOptions } from './client.ts';

const NOW = new Date('2026-09-08T12:00:00.000Z');

/** A client with everything nondeterministic pinned. */
function makeClient(
  overrides: Partial<QuorumClientOptions> = {},
): { client: QuorumClient; queue: OfflineQueue; sent: unknown[] } {
  const queue = new OfflineQueue({ storage: createMemoryStorage() });
  const sent: unknown[] = [];

  let counter = 0;
  const client = new QuorumClient({
    project: 'pk_test',
    queue,
    anonId: 'anon-1',
    now: () => NOW,
    newId: () => `01J${++counter}`,
    route: () => '/dashboard',
    transport: new Transport({
      endpoint: '',
      project: 'pk_test',
      queue,
      fetchImpl: (async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ accepted: [], duplicate: [] }), { status: 202 });
      }) as unknown as typeof fetch,
    }),
    ...overrides,
  });

  return { client, queue, sent };
}

describe('buildEvent', () => {
  it('produces a protocol-shaped event', () => {
    const { client } = makeClient();
    const event = client.buildEvent({ draft: 'add dark mode', kind: 'feature_request' });

    assert.equal(event.id, '01J1');
    assert.equal(event.kind, 'feature_request');
    assert.equal(event.source, 'nub');
    assert.equal(event.body, 'add dark mode');
    assert.equal(event.clientTs, NOW.toISOString());
  });

  it('accepts a caller-supplied id', () => {
    // The panel machine reports the id before the send, so the caller has to
    // be able to choose it.
    const { client } = makeClient();
    assert.equal(client.buildEvent({ id: 'chosen', draft: 'x', kind: 'bug' }).id, 'chosen');
  });

  it('carries route, version, platform and sdk version', () => {
    const { client } = makeClient({ appVersion: '4.12.0' });
    const context = client.buildEvent({ draft: 'x', kind: 'bug' }).context;

    // PROTOCOL rule 4: structural fields are first-class, never metadata soup.
    assert.equal(context?.route, '/dashboard');
    assert.equal(context?.appVersion, '4.12.0');
    assert.equal(context?.platform, 'web');
    assert.equal(context?.sdkVersion, SDK_VERSION);
  });

  it('omits an empty route rather than sending one', () => {
    const { client } = makeClient({ route: () => undefined });
    assert.equal(client.buildEvent({ draft: 'x', kind: 'bug' }).context?.route, undefined);
  });

  it('attaches the anonymous id when nobody has identified', () => {
    const { client } = makeClient();
    assert.deepEqual(client.buildEvent({ draft: 'x', kind: 'bug' }).user, { anonId: 'anon-1' });
  });

  it('attaches externalId and traits after identify', () => {
    const { client } = makeClient();
    client.identify('u_42', { plan: 'enterprise', mrr: 4000 });

    const user = client.buildEvent({ draft: 'x', kind: 'bug' }).user;
    assert.equal(user?.externalId, 'u_42');
    assert.equal(user?.anonId, 'anon-1');
    // The trait that changes the ranked list. Without it accountWeight is 1.0
    // for everyone and prioritization is a head count (ADR-0015).
    assert.equal(user?.traits?.['mrr'], 4000);
  });

  it('keeps the anonymous id alongside the external one', () => {
    // A user who files anonymously and later signs in is one user, and ingest
    // needs both keys present to ever join them (DATA-MODEL §1).
    const { client } = makeClient();
    client.identify('u_42');
    assert.equal(client.buildEvent({ draft: 'x', kind: 'bug' }).user?.anonId, 'anon-1');
  });

  it('drops identity on reset', () => {
    const { client } = makeClient();
    client.identify('u_42', { mrr: 100 });
    client.reset();
    assert.deepEqual(client.buildEvent({ draft: 'x', kind: 'bug' }).user, { anonId: 'anon-1' });
  });

  it('sends no user block when there is no identity and no anon id', () => {
    const { client } = makeClient({ anonId: null });
    assert.equal(client.buildEvent({ draft: 'x', kind: 'bug' }).user, undefined);
  });

  it('redacts before the event exists anywhere', () => {
    const { client } = makeClient();
    const event = client.buildEvent({
      draft: 'my card is 4242 4242 4242 4242 and email is a@b.com',
      kind: 'bug',
    });

    assert.ok(!event.body?.includes('4242 4242 4242 4242'), 'card number survived');
    assert.ok(!event.body?.includes('a@b.com'), 'email survived');
    assert.ok((event.redaction?.maskedCount ?? 0) >= 2);
  });

  it('reports the redaction policy even when nothing matched', () => {
    // ADR-0007: an audit should see the policy that ran, not infer it from an
    // absence.
    const { client } = makeClient();
    const event = client.buildEvent({ draft: 'nothing sensitive', kind: 'bug' });
    assert.equal(event.redaction?.maskedCount, 0);
    assert.ok((event.redaction?.rules.length ?? 0) > 0);
  });

  it('can be turned off, and then says nothing about redaction', () => {
    const { client } = makeClient({ redact: false });
    const event = client.buildEvent({ draft: 'a@b.com', kind: 'bug' });
    assert.equal(event.body, 'a@b.com');
    assert.equal(event.redaction, undefined);
  });

  it('omits an empty body rather than sending an empty string', () => {
    // A rage report with no text is valid (PROTOCOL rule 4), and `body?` means
    // absent, not blank.
    const { client } = makeClient();
    assert.equal(client.buildEvent({ draft: '', kind: 'rage' }).body, undefined);
  });

  it('passes per-submission context through as custom', () => {
    const { client } = makeClient();
    const event = client.buildEvent({ draft: 'x', kind: 'bug', context: { orderId: 'A-1' } });
    assert.deepEqual(event.context?.custom, { orderId: 'A-1' });
  });
});

describe('submit', () => {
  it('persists before sending', async () => {
    const queue = new OfflineQueue({ storage: createMemoryStorage() });
    let queuedAtSendTime = 0;

    const client = new QuorumClient({
      project: 'pk_test',
      queue,
      anonId: 'anon-1',
      transport: new Transport({
        endpoint: '',
        project: 'pk_test',
        queue,
        fetchImpl: (async () => {
          // The event must already be durable by the time the request goes
          // out — closing the tab mid-submit is the case this protects.
          queuedAtSendTime = queue.size;
          return new Response(JSON.stringify({ accepted: [], duplicate: [] }), { status: 202 });
        }) as unknown as typeof fetch,
      }),
    });

    await client.submit({ draft: 'x', kind: 'bug' });
    assert.equal(queuedAtSendTime, 1);
  });

  it('reports accepted and drains the queue', async () => {
    const { client, queue, sent } = makeClient();
    const outcome = await client.submit({ draft: 'add dark mode', kind: 'feature_request' });

    assert.equal(outcome.status, 'accepted');
    assert.equal(queue.size, 0);
    assert.equal((sent[0] as { events: unknown[] }).events.length, 1);
  });

  it('reports queued when the network is down, and keeps the event', async () => {
    const queue = new OfflineQueue({ storage: createMemoryStorage() });
    const client = new QuorumClient({
      project: 'pk_test',
      queue,
      anonId: 'anon-1',
      transport: new Transport({
        endpoint: '',
        project: 'pk_test',
        queue,
        maxRetries: 0,
        sleep: async () => undefined,
        fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
      }),
    });

    const outcome = await client.submit({ draft: 'x', kind: 'bug' });

    // Not a failure. The panel says "saved, we'll send it when you're back
    // online", which is what actually happened.
    assert.equal(outcome.status, 'queued');
    assert.equal(outcome.status === 'queued' && outcome.queueDepth, 1);
    assert.equal(queue.size, 1);
  });

  it('reports failed when ingest calls the event malformed', async () => {
    const queue = new OfflineQueue({ storage: createMemoryStorage() });
    const client = new QuorumClient({
      project: 'pk_test',
      queue,
      anonId: 'anon-1',
      transport: new Transport({
        endpoint: '',
        project: 'pk_test',
        queue,
        fetchImpl: (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch,
      }),
    });

    const outcome = await client.submit({ draft: 'x', kind: 'bug' });

    // A 400 is permanent, so the event is gone from the queue. Reporting
    // success because the queue drained would be a lie.
    assert.equal(outcome.status, 'failed');
    assert.equal(queue.size, 0);
  });

  it('reports failed when the project key is rejected', async () => {
    const queue = new OfflineQueue({ storage: createMemoryStorage() });
    const client = new QuorumClient({
      project: 'pk_wrong',
      queue,
      anonId: 'anon-1',
      transport: new Transport({
        endpoint: '',
        project: 'pk_wrong',
        queue,
        fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
      }),
    });

    const outcome = await client.submit({ draft: 'x', kind: 'bug' });

    // The event is still in the queue, but a 401 disables the transport for
    // the session, so it will never go out. Reporting `queued` here would show
    // "we'll send it when you're back online" to someone whose feedback is
    // going nowhere — the one lie this function must not tell.
    assert.equal(outcome.status, 'failed');
    assert.match(
      outcome.status === 'failed' ? outcome.error.message : '',
      /project key/,
    );
    assert.equal(queue.size, 1, 'the event is kept — the key may be fixed and a reload retries');
  });

  it('keeps reporting failed once the session is disabled', async () => {
    const queue = new OfflineQueue({ storage: createMemoryStorage() });
    let calls = 0;
    const client = new QuorumClient({
      project: 'pk_wrong',
      queue,
      anonId: 'anon-1',
      transport: new Transport({
        endpoint: '',
        project: 'pk_wrong',
        queue,
        fetchImpl: (async () => {
          calls++;
          return new Response('{}', { status: 401 });
        }) as unknown as typeof fetch,
      }),
    });

    assert.equal((await client.submit({ draft: 'one', kind: 'bug' })).status, 'failed');
    assert.equal((await client.submit({ draft: 'two', kind: 'bug' })).status, 'failed');

    // And it stops asking. A disabled transport that kept retrying a rejected
    // key would hammer ingest for the rest of the session.
    assert.equal(calls, 1);
  });

  it('flushes what an earlier failure left behind', async () => {
    const queue = new OfflineQueue({ storage: createMemoryStorage() });
    let online = false;

    const client = new QuorumClient({
      project: 'pk_test',
      queue,
      anonId: 'anon-1',
      transport: new Transport({
        endpoint: '',
        project: 'pk_test',
        queue,
        maxRetries: 0,
        sleep: async () => undefined,
        fetchImpl: (async () => {
          if (!online) throw new Error('offline');
          return new Response(JSON.stringify({ accepted: [], duplicate: [] }), { status: 202 });
        }) as unknown as typeof fetch,
      }),
    });

    assert.equal((await client.submit({ draft: 'first', kind: 'bug' })).status, 'queued');
    assert.equal((await client.submit({ draft: 'second', kind: 'bug' })).status, 'queued');
    assert.equal(queue.size, 2);

    online = true;
    await client.flush();
    assert.equal(queue.size, 0, 'both went out on reconnect');
  });

  it('never throws, whatever the transport does', async () => {
    const queue = new OfflineQueue({ storage: createMemoryStorage() });
    const client = new QuorumClient({
      project: 'pk_test',
      queue,
      anonId: 'anon-1',
      transport: {
        flush: () => Promise.reject(new Error('catastrophe')),
      } as unknown as Transport,
    });

    // A widget that throws into a host page's click handler is a widget that
    // gets removed.
    const outcome = await client.submit({ draft: 'x', kind: 'bug' });
    assert.equal(outcome.status, 'queued');
  });
});

describe('watchConnectivity', () => {
  it('flushes on the online event and detaches cleanly', async () => {
    const target = new EventTarget();
    const { client, queue } = makeClient();

    queue.enqueue({ id: 'stranded', kind: 'bug', source: 'nub', clientTs: NOW.toISOString() });
    const detach = client.watchConnectivity(target);

    target.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(queue.size, 0);

    detach();
    queue.enqueue({ id: 'later', kind: 'bug', source: 'nub', clientTs: NOW.toISOString() });
    target.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(queue.size, 1, 'detached listener must not keep flushing');
  });

  it('is a no-op where there is no event target', () => {
    const { client } = makeClient();
    assert.doesNotThrow(() => client.watchConnectivity(undefined)());
  });
});
