import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { Quorum } from '../../../packages/node/src/client.ts';
import { PROTOCOL_VERSION } from '../../../packages/core/src/protocol.ts';
import { createApiServer } from './server.ts';

const NOW = new Date('2026-09-03T00:00:00.000Z');

let server: Server;
let base: string;
let quorum: Quorum;

/** A real server on an ephemeral port, driven with real fetch. No mocks. */
before(async () => {
  quorum = new Quorum({ projectId: 'p1', now: () => NOW });

  await quorum.import(
    [
      { body: 'please add dark mode', clientTs: '2026-08-01T00:00:00.000Z', user: { externalId: 'c1' } },
      { body: 'add dark mode to settings', clientTs: '2026-08-02T00:00:00.000Z', user: { externalId: 'c2' } },
      { body: 'dark mode please', clientTs: '2026-08-03T00:00:00.000Z', user: { externalId: 'c3' } },
      { body: 'the csv export is broken', clientTs: '2026-08-04T00:00:00.000Z', user: { externalId: 'c4' }, kind: 'bug' },
    ],
    { source: 'support_inbox' },
  );

  server = createApiServer({ quorum, now: () => NOW, maxBodyBytes: 2048 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function envelope(events: unknown[]): unknown {
  return { v: PROTOCOL_VERSION, sentAt: NOW.toISOString(), project: 'pk_live_1', events };
}

const EVENT = {
  id: '01J8Z9QK4T0000000000000009',
  kind: 'feature_request',
  source: 'nub',
  clientTs: '2026-08-05T00:00:00.000Z',
  body: 'dark mode would be lovely',
  user: { externalId: 'c9' },
};

describe('health', () => {
  test('reports protocol version and stored count', async () => {
    const res = await fetch(`${base}/v0/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; protocol: number; submissions: number };
    assert.equal(body.status, 'ok');
    assert.equal(body.protocol, PROTOCOL_VERSION);
    assert.ok(body.submissions >= 4);
  });
});

describe('the read API', () => {
  test('issues come back ranked with their reasoning attached', async () => {
    const res = await fetch(`${base}/v0/issues`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { issues: { score: number; explanation: string; components: unknown }[] };

    assert.ok(body.issues.length >= 2);
    // A ranked row a reader cannot interrogate is one nobody believes, so the
    // components ride along on the list rather than only the detail view.
    assert.ok(body.issues[0]?.components !== undefined);
    assert.ok((body.issues[0]?.explanation ?? '').length > 0);
    assert.ok((body.issues[0]?.score ?? 0) >= (body.issues[1]?.score ?? 0));
  });

  test('limit truncates', async () => {
    const res = await fetch(`${base}/v0/issues?limit=1`);
    const body = (await res.json()) as { issues: unknown[] };
    assert.equal(body.issues.length, 1);
  });

  test('a nonsense limit is a 400, not a silent default', async () => {
    for (const limit of ['0', '-3', 'abc', '1.5']) {
      const res = await fetch(`${base}/v0/issues?limit=${limit}`);
      assert.equal(res.status, 400, `limit=${limit}`);
    }
  });

  test('a single issue can be fetched by id', async () => {
    const list = (await (await fetch(`${base}/v0/issues`)).json()) as { issues: { id: string }[] };
    const id = list.issues[0]?.id as string;

    const res = await fetch(`${base}/v0/issues/${id}`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { id: string }).id, id);
  });

  test('an unknown issue is a 404', async () => {
    assert.equal((await fetch(`${base}/v0/issues/nope`)).status, 404);
  });

  test('the evidence endpoint returns verbatim submissions', async () => {
    const list = (await (await fetch(`${base}/v0/issues`)).json()) as { issues: { id: string }[] };
    const id = list.issues[0]?.id as string;

    const res = await fetch(`${base}/v0/issues/${id}/submissions`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { submissions: { body: string }[]; total: number };
    assert.ok(body.total > 0);
    assert.ok(body.submissions.every((s) => s.body.length > 0));
  });

  test('evidence for an unknown issue is a 404', async () => {
    assert.equal((await fetch(`${base}/v0/issues/nope/submissions`)).status, 404);
  });

  test('ranked lists are never cached', async () => {
    // Caching would show a reader yesterday's priorities under today's clock.
    const res = await fetch(`${base}/v0/issues`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

describe('the write path', () => {
  test('a valid envelope is accepted with 202', async () => {
    const res = await fetch(`${base}/v0/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope([EVENT])),
    });
    assert.equal(res.status, 202);
    assert.deepEqual((await res.json()) as unknown, { accepted: [EVENT.id], duplicate: [] });
  });

  test('a replay is 202 with the id listed as duplicate, not an error', async () => {
    // A duplicate is what the client's idempotency key exists to make safe.
    // Reporting it as a failure would make every replayed offline flush look
    // broken.
    const res = await fetch(`${base}/v0/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope([EVENT])),
    });
    assert.equal(res.status, 202);
    assert.deepEqual((await res.json()) as unknown, { accepted: [], duplicate: [EVENT.id] });
  });

  test('an ingested widget submission joins the ranked list', async () => {
    // The whole point of one canonical-issue store, verified over the wire.
    const list = (await (await fetch(`${base}/v0/issues`)).json()) as {
      issues: { id: string; quotes: { source: string }[] }[];
    };
    const sources = new Set(list.issues.flatMap((i) => i.quotes.map((q) => q.source)));
    assert.ok(sources.has('nub'));
    assert.ok(sources.has('support_inbox'));
  });

  test('a malformed envelope is 400 so a client drops it permanently', async () => {
    // 400 makes a conforming client stop retrying. It is only correct for
    // something no retry could fix.
    for (const body of ['{}', '{"v":0}', 'null', '[]', 'not json at all']) {
      const res = await fetch(`${base}/v0/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 400, `body: ${body}`);
    }
  });

  test('an unsupported protocol version is 400', async () => {
    const res = await fetch(`${base}/v0/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(envelope([]) as object), v: 99 }),
    });
    assert.equal(res.status, 400);
  });

  test('an oversized body is 413, and the connection is not left holding it', async () => {
    // The protocol's 413 row tells the client to strip the capture and retry
    // the envelope alone, so this is recoverable by design.
    const huge = { ...(envelope([{ ...EVENT, body: 'x'.repeat(5000) }]) as object) };
    const res = await fetch(`${base}/v0/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(huge),
    }).catch(() => undefined);
    // The server destroys the request once the cap trips, so either a 413 or a
    // dropped connection is a correct outcome — what must not happen is a 202.
    if (res !== undefined) assert.equal(res.status, 413);
  });

  test('an empty batch is accepted', async () => {
    const res = await fetch(`${base}/v0/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope([])),
    });
    assert.equal(res.status, 202);
  });
});

describe('routing', () => {
  test('an unknown path is 404', async () => {
    assert.equal((await fetch(`${base}/v0/nope`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 404);
  });

  test('an unversioned path is 404', async () => {
    assert.equal((await fetch(`${base}/issues`)).status, 404);
  });

  test('the wrong method is 405, not 404', async () => {
    // 404 would send someone hunting for a typo in a path that is correct.
    assert.equal((await fetch(`${base}/v0/issues`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/v0/ingest`)).status, 405);
  });

  test('preflight is answered', async () => {
    const res = await fetch(`${base}/v0/issues`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  test('responses are JSON', async () => {
    const res = await fetch(`${base}/v0/health`);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  });
});

describe('unanticipated failures', () => {
  let broken: Server;
  let brokenBase: string;

  before(async () => {
    // A store that fails on read. Stands in for a database outage.
    const failing = {
      put: () => Promise.resolve(true),
      list: () => Promise.reject(new Error('storage is unreachable')),
      get: () => Promise.resolve(undefined),
      count: () => Promise.resolve(0),
    };
    broken = createApiServer({
      quorum: new Quorum({ projectId: 'p3', store: failing, now: () => NOW }),
      now: () => NOW,
    });
    await new Promise<void>((resolve) => broken.listen(0, resolve));
    brokenBase = `http://127.0.0.1:${String((broken.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => broken.close(() => resolve()));
  });

  test('a storage failure is 500, not 400', async () => {
    // 500 tells a conforming client to back off and retry. A 400 would make it
    // drop a user's feedback permanently over a bug on our side.
    const res = await fetch(`${brokenBase}/v0/issues`);
    assert.equal(res.status, 500);
    assert.equal(((await res.json()) as { error: string }).error, 'internal');
  });

  test('the failure does not take the server down', async () => {
    await fetch(`${brokenBase}/v0/issues`).catch(() => undefined);
    // An unknown route still answers, so one bad request did not kill the process.
    assert.equal((await fetch(`${brokenBase}/v0/nope`)).status, 404);
  });
});

describe('project key enforcement', () => {
  let guarded: Server;
  let guardedBase: string;

  before(async () => {
    guarded = createApiServer({
      quorum: new Quorum({ projectId: 'p2', now: () => NOW }),
      now: () => NOW,
      projectKey: 'pk_live_expected',
    });
    await new Promise<void>((resolve) => guarded.listen(0, resolve));
    guardedBase = `http://127.0.0.1:${String((guarded.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => guarded.close(() => resolve()));
  });

  test('a wrong project key is 401', async () => {
    // The protocol's 401 row means "disable the SDK for this session" — a
    // client must not retry it, so it has to be distinguishable from a 5xx.
    const res = await fetch(`${guardedBase}/v0/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope([EVENT])),
    });
    assert.equal(res.status, 401);
  });

  test('the right project key is accepted', async () => {
    const res = await fetch(`${guardedBase}/v0/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(envelope([EVENT]) as object), project: 'pk_live_expected' }),
    });
    assert.equal(res.status, 202);
  });
});
