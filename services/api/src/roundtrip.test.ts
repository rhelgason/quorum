/**
 * The web client against the real service, over a real socket.
 *
 * This file exists because of a bug it would have caught on day one. The
 * browser transport posted to `/v0/events`; the service served `/v0/ingest`.
 * Both halves had thorough tests and both suites were green for a week,
 * because the client's tests inject a fake `fetch` and assert on the request
 * body while the server's tests call the router directly. Nothing in the repo
 * ever put the two on opposite ends of one connection.
 *
 * So the rule these tests encode: **the seam between two components is a
 * component.** Everything here is real — a real `node:http` server, a real
 * `QuorumClient`, real `fetch`, a real durable queue — and nothing asserts on
 * an internal call. The only things injected are the clock and the id source,
 * so the ranked output is reproducible.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createMemoryStorage, OfflineQueue } from '../../../packages/core/src/queue.ts';
import { Transport } from '../../../packages/core/src/transport.ts';
import { Quorum } from '../../../packages/node/src/client.ts';
import { QuorumClient } from '../../../packages/web/src/client.ts';
import { createApiServer } from './server.ts';
import { createRateLimiter } from './rate-limit.ts';

const NOW = new Date('2026-09-08T12:00:00.000Z');

let server: Server;
let base: string;
let quorum: Quorum;

before(async () => {
  quorum = new Quorum({ projectId: 'p1', now: () => NOW });
  server = createApiServer({ quorum, now: () => NOW });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A browser client pointed at the live service. Only time and ids are fake. */
function browserClient(options: { anonId?: string | null; idPrefix?: string } = {}): QuorumClient {
  const queue = new OfflineQueue({ storage: createMemoryStorage() });
  let counter = 0;

  return new QuorumClient({
    project: 'pk_live_1',
    endpoint: base,
    queue,
    anonId: options.anonId === undefined ? 'anon-round' : options.anonId,
    now: () => NOW,
    newId: () => `01JROUND${options.idPrefix ?? 'A'}${String(++counter).padStart(4, '0')}`,
    route: () => '/dashboard',
    transport: new Transport({ endpoint: base, project: 'pk_live_1', queue }),
  });
}

describe('browser client → HTTP service', () => {
  it('a submission from the widget lands in the ranked list', async () => {
    const client = browserClient({ idPrefix: 'B' });
    client.identify('u_round_1', { plan: 'pro', mrr: 400 });

    const outcome = await client.submit({
      draft: 'the dashboard takes forever to load',
      kind: 'bug',
    });
    assert.equal(outcome.status, 'accepted', 'the client and the service agree on the path');

    const res = await fetch(`${base}/v0/issues`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { issues: { title: string; quotes: { body: string }[] }[] };
    const found = body.issues.find((issue) =>
      issue.quotes.some((quote) => quote.body.includes('dashboard takes forever')),
    );
    assert.ok(found !== undefined, 'the submission never reached the read API');
  });

  it('the transport posts to the path the service serves', async () => {
    // The regression test for the original bug, stated directly rather than
    // inferred from a ranked list two layers away.
    const client = browserClient({ idPrefix: 'C' });
    assert.equal((await client.submit({ draft: 'path check', kind: 'bug' })).status, 'accepted');

    // And the wrong path is still wrong, so this test cannot pass by accident
    // if someone makes the router answer everything.
    const wrong = await fetch(`${base}/v0/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 0, sentAt: NOW.toISOString(), project: 'pk_live_1', events: [] }),
    });
    assert.equal(wrong.status, 404);
  });

  it('carries identity and traits far enough to weight the ranking', async () => {
    const client = browserClient({ idPrefix: 'D' });
    client.identify('u_whale', { plan: 'enterprise', mrr: 9000 });
    await client.submit({ draft: 'we need SAML SSO before procurement signs', kind: 'feature_request' });

    const res = await fetch(`${base}/v0/issues`);
    const body = (await res.json()) as {
      issues: { quotes: { body: string }[]; components: { meanAccountWeight: number } }[];
    };
    const issue = body.issues.find((candidate) =>
      candidate.quotes.some((quote) => quote.body.includes('SAML SSO')),
    );

    assert.ok(issue !== undefined);
    // Log-scaled, so 9000 MRR is a multiplier rather than a takeover
    // (ADR-0015). The number matters less than it being above the 1.0 an
    // unidentified user gets — that is the whole revenue-weighting claim.
    assert.ok(
      issue.components.meanAccountWeight > 1,
      `traits never reached ranking: weight was ${String(issue.components.meanAccountWeight)}`,
    );
  });

  it('carries the route through to the stored submission', async () => {
    const client = browserClient({ idPrefix: 'E' });
    client.identify('u_route');
    await client.submit({ draft: 'the export button on this page is dead', kind: 'bug' });

    const stored = (await quorum.submissions()).find((submission) =>
      submission.body.includes('export button on this page'),
    );
    assert.equal(stored?.route, '/dashboard', 'the structural signal was dropped in transit');
  });

  it('replaying the queue is a no-op, not a second vote', async () => {
    const queue = new OfflineQueue({ storage: createMemoryStorage() });
    const client = new QuorumClient({
      project: 'pk_live_1',
      endpoint: base,
      queue,
      anonId: 'anon-replay',
      now: () => NOW,
      newId: () => '01JROUNDREPLAY00001',
      route: () => '/settings',
      transport: new Transport({ endpoint: base, project: 'pk_live_1', queue }),
    });

    await client.submit({ draft: 'billing page shows the wrong currency', kind: 'bug' });

    // Exactly what an offline flush does after the network comes back and the
    // first attempt actually succeeded: the same event, again.
    const replay = await fetch(`${base}/v0/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 0,
        sentAt: NOW.toISOString(),
        project: 'pk_live_1',
        events: [
          {
            id: '01JROUNDREPLAY00001',
            kind: 'bug',
            source: 'nub',
            clientTs: NOW.toISOString(),
            body: 'billing page shows the wrong currency',
            user: { anonId: 'anon-replay' },
          },
        ],
      }),
    });

    assert.equal(replay.status, 202, 'a duplicate is success — it is what the ULID is for');
    const body = (await replay.json()) as { accepted: string[]; duplicate: string[] };
    assert.deepEqual(body.accepted, []);
    assert.deepEqual(body.duplicate, ['01JROUNDREPLAY00001']);

    const matching = (await quorum.submissions()).filter((submission) =>
      submission.body.includes('wrong currency'),
    );
    assert.equal(matching.length, 1, 'the replay was stored a second time');
  });

  it('queues while the service is unreachable and drains when it returns', async () => {
    const queue = new OfflineQueue({ storage: createMemoryStorage() });
    let reachable = false;

    const client = new QuorumClient({
      project: 'pk_live_1',
      endpoint: base,
      queue,
      anonId: 'anon-offline',
      now: () => NOW,
      newId: () => '01JROUNDOFFLINE0001',
      route: () => '/reports',
      transport: new Transport({
        endpoint: base,
        project: 'pk_live_1',
        queue,
        maxRetries: 0,
        sleep: async () => undefined,
        // A real fetch once the "outage" is over, so the drain is a genuine
        // round trip rather than a stub returning 202.
        fetchImpl: ((url: string, init: RequestInit) => {
          if (!reachable) return Promise.reject(new Error('ECONNREFUSED'));
          return fetch(url, init);
        }) as unknown as typeof fetch,
      }),
    });

    const outcome = await client.submit({ draft: 'scheduled reports never arrive', kind: 'bug' });
    assert.equal(outcome.status, 'queued');
    assert.equal(queue.size, 1);

    reachable = true;
    const result = await client.flush();

    assert.equal(result.sent, 1);
    assert.equal(queue.size, 0);

    const stored = (await quorum.submissions()).find((submission) =>
      submission.body.includes('scheduled reports'),
    );
    assert.ok(stored !== undefined, 'the queued event never made it after reconnect');
  });

  it('redacts on the client, so the service never stores the secret', async () => {
    const client = browserClient({ idPrefix: 'F' });
    client.identify('u_leaky');
    await client.submit({
      draft: 'checkout rejected my card 4242 4242 4242 4242, email me at leak@example.com',
      kind: 'bug',
    });

    const stored = (await quorum.submissions()).find((submission) =>
      submission.body.includes('checkout rejected'),
    );

    assert.ok(stored !== undefined);
    // ADR-0007: redaction happens on-device, before serialization. The
    // payload should never have contained it in the first place.
    assert.ok(!stored.body.includes('4242 4242 4242 4242'));
    assert.ok(!stored.body.includes('leak@example.com'));
  });
});

describe('the 429 path, end to end', () => {
  let limited: Server;
  let limitedBase: string;

  before(async () => {
    const quorum429 = new Quorum({ projectId: 'p429', now: () => NOW });
    limited = createApiServer({
      quorum: quorum429,
      now: () => NOW,
      // Two writes per window, so the third is refused deterministically.
      rateLimiter: createRateLimiter({ limit: 2, windowMs: 60_000, now: () => NOW.getTime() }),
    });
    await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
    limitedBase = `http://127.0.0.1:${String((limited.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => limited.close(() => resolve()));
  });

  function envelope(id: string): string {
    return JSON.stringify({
      v: 0,
      sentAt: NOW.toISOString(),
      project: 'pk_live_1',
      events: [{ id, kind: 'bug', source: 'nub', clientTs: NOW.toISOString(), body: 'x' }],
    });
  }

  async function post(id: string): Promise<Response> {
    return fetch(`${limitedBase}/v0/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: envelope(id),
    });
  }

  it('answers 429 with a Retry-After a client can act on', async () => {
    assert.equal((await post('01JLIMIT0000000001')).status, 202);
    assert.equal((await post('01JLIMIT0000000002')).status, 202);

    const refused = await post('01JLIMIT0000000003');
    assert.equal(refused.status, 429);

    // The header rounds up to whole seconds; the body carries the exact
    // milliseconds. A client may use either, so both have to be right.
    assert.equal(refused.headers.get('retry-after'), '60');
    const body = (await refused.json()) as { error: string; retryAfterMs: number };
    assert.equal(body.error, 'rate_limited');
    assert.ok(body.retryAfterMs > 0 && body.retryAfterMs <= 60_000);
  });

  it('exposes Retry-After across origins', async () => {
    // Without this a browser client reads a 429 with no visible header and
    // falls back to its own backoff — overriding the number the server just
    // took the trouble to compute.
    const refused = await post('01JLIMIT0000000004');
    assert.match(refused.headers.get('access-control-expose-headers') ?? '', /retry-after/i);
  });

  it('the transport honours it instead of hammering', async () => {
    const queue = new OfflineQueue({ storage: createMemoryStorage() });
    const slept: number[] = [];

    const client = new QuorumClient({
      project: 'pk_live_1',
      endpoint: limitedBase,
      queue,
      anonId: 'anon-429',
      now: () => NOW,
      newId: () => '01JLIMITCLIENT00001',
      route: () => '/reports',
      transport: new Transport({
        endpoint: limitedBase,
        project: 'pk_live_1',
        queue,
        maxRetries: 1,
        // Recorded rather than performed — the assertion is about what the
        // client decided to wait, not about waiting.
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
    });

    const outcome = await client.submit({ draft: 'rate limited please wait', kind: 'bug' });

    // The whole point of the protocol's 429 row: the client backs off by the
    // server's number rather than its own jittered guess, and the submission
    // stays queued rather than being dropped. This is the first time that path
    // has been exercised against a server that actually sends one.
    assert.equal(outcome.status, 'queued');
    assert.equal(queue.size, 1);
    assert.ok(slept.length > 0, 'the client did not back off at all');
    assert.equal(slept[0], 60_000, `expected the server's Retry-After, got ${String(slept[0])}`);
  });
});
