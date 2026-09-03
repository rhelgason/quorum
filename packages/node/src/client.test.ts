import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Quorum } from './client.ts';
import { PROTOCOL_VERSION, type CaptureEnvelope } from '../../core/src/protocol.ts';

const CLOCK = '2026-09-03T12:00:00.000Z';

function quorum(): Quorum {
  return new Quorum({ projectId: 'p1', now: () => new Date(CLOCK) });
}

describe('construction', () => {
  test('a project id is required', () => {
    assert.throws(() => new Quorum({ projectId: '' }), /projectId/);
  });

  test('a store is provided by default', () => {
    assert.ok(new Quorum({ projectId: 'p1' }).store);
  });

  test('the system clock is used when none is injected', async () => {
    const before = Date.now();
    const { submission } = await new Quorum({ projectId: 'p1' }).capture({
      body: 'x',
      user: { externalId: 'u' },
    });
    const stamped = Date.parse(submission.receivedAt);
    assert.ok(stamped >= before && stamped <= Date.now());
  });
});

describe('capture', () => {
  test('stores an attributed submission', async () => {
    const q = quorum();
    const { submission, stored } = await q.capture({
      body: 'please add dark mode',
      user: { externalId: 'u_1' },
    });
    assert.equal(stored, true);
    assert.equal(submission.userId, 'u:u_1');
    assert.equal(submission.attributed, true);
    assert.equal((await q.submissions()).length, 1);
  });

  test('body is stored verbatim and drives clustering by default', async () => {
    const { submission } = await quorum().capture({ body: '  Add Dark Mode!  ', user: { externalId: 'u' } });
    assert.equal(submission.body, '  Add Dark Mode!  ');
    assert.equal(submission.clusterText, submission.body);
  });

  test('an empty body is rejected', async () => {
    await assert.rejects(quorum().capture({ body: '   ', user: { externalId: 'u' } }), /non-empty body/);
  });

  test('defaults are feature_request via the api source', async () => {
    const { submission } = await quorum().capture({ body: 'x', user: { externalId: 'u' } });
    assert.equal(submission.kind, 'feature_request');
    assert.equal(submission.source, 'api');
  });

  test('an unattributed capture refuses rather than guessing', async () => {
    // A backend integration nearly always knows whose ticket it is, and a
    // silent bucket would corrupt the unique-user count ranking depends on.
    await assert.rejects(quorum().capture({ body: 'x' }), /no user identity/);
  });

  test('an explicit fallback key is accepted and marked unattributed', async () => {
    const { submission } = await quorum().capture({ body: 'x', fallbackKey: 'batch:7' });
    assert.equal(submission.userId, 'batch:7');
    assert.equal(submission.attributed, false);
  });

  test('the same capture twice is one submission', async () => {
    // Derived ids make a retried write idempotent without the caller tracking
    // ids themselves.
    const q = quorum();
    await q.capture({ body: 'dark mode', user: { externalId: 'u' } });
    const second = await q.capture({ body: 'dark mode', user: { externalId: 'u' } });
    assert.equal(second.stored, false);
    assert.equal((await q.submissions()).length, 1);
  });

  test('a duplicate returns the originally stored record', async () => {
    const q = quorum();
    const first = await q.capture({ body: 'dark mode', user: { externalId: 'u' }, id: 'fixed' });
    const second = await q.capture({ body: 'different text', user: { externalId: 'u' }, id: 'fixed' });
    assert.equal(second.stored, false);
    assert.equal(second.submission.body, first.submission.body);
  });

  test('clientTs defaults to the injected clock', async () => {
    const { submission } = await quorum().capture({ body: 'x', user: { externalId: 'u' } });
    assert.equal(submission.clientTs, CLOCK);
    assert.equal(submission.receivedAt, CLOCK);
  });

  test('an unparseable clientTs is rejected', async () => {
    await assert.rejects(
      quorum().capture({ body: 'x', user: { externalId: 'u' }, clientTs: 'last tuesday' }),
      /not a parseable timestamp/,
    );
  });

  test('context fields are stored as first-class columns', async () => {
    const { submission } = await quorum().capture({
      body: 'x',
      user: { externalId: 'u' },
      context: { route: '/checkout', appVersion: '4.12.0', platform: 'web' },
    });
    assert.equal(submission.route, '/checkout');
    assert.equal(submission.appVersion, '4.12.0');
    assert.equal(submission.platform, 'web');
  });

  test('mrr from traits reaches the submission', async () => {
    const { submission } = await quorum().capture({
      body: 'x',
      user: { externalId: 'u', traits: { plan: 'enterprise', mrr: 4000 } },
    });
    assert.equal(submission.mrr, 4000);
  });
});

describe('captureException', () => {
  test('an error becomes a bug submission with a fingerprint', async () => {
    const { submission } = await quorum().captureException(new TypeError('boom'));
    assert.equal(submission.kind, 'bug');
    assert.match(submission.body, /^TypeError: boom/);
    assert.match(submission.fingerprint ?? '', /^ex_/);
  });

  test('the message is verbatim while clusterText is scrubbed', async () => {
    const { submission } = await quorum().captureException(new Error('Timeout after 30012ms'));
    assert.match(submission.body, /30012ms/);
    // The placeholder shape does not matter; what matters is that the varying
    // part is gone, so two occurrences produce identical clustering text.
    assert.equal(submission.clusterText.includes('30012'), false);
    assert.match(submission.clusterText, /<[a-z]+>/);
  });

  test('two occurrences of one defect count as one user that day', async () => {
    // A retry loop must not out-vote humans by generating volume.
    const q = quorum();
    const err = new Error('Request failed');
    await q.captureException(err, { clientTs: '2026-09-03T01:00:00.000Z' });
    await q.captureException(err, { clientTs: '2026-09-03T09:00:00.000Z' });
    const users = new Set((await q.submissions()).map((s) => s.userId));
    assert.equal(users.size, 1);
  });

  test('the same defect on another day is another bucket', async () => {
    const q = quorum();
    const err = new Error('Request failed');
    await q.captureException(err, { clientTs: '2026-09-03T01:00:00.000Z' });
    await q.captureException(err, { clientTs: '2026-09-04T01:00:00.000Z' });
    assert.equal(new Set((await q.submissions()).map((s) => s.userId)).size, 2);
  });

  test('an attributed exception uses the real user', async () => {
    const { submission } = await quorum().captureException(new Error('x'), {
      user: { externalId: 'u_5' },
    });
    assert.equal(submission.userId, 'u:u_5');
    assert.equal(submission.attributed, true);
  });

  test('a non-Error throwable is still recorded', async () => {
    const { submission } = await quorum().captureException({ code: 'E_LIMIT' });
    assert.match(submission.body, /E_LIMIT/);
  });

  test('an error with no message keeps a usable body', async () => {
    const { submission } = await quorum().captureException(new Error(''));
    assert.equal(submission.body, 'Error');
  });

  test('request context is attached', async () => {
    const { submission } = await quorum().captureException(new Error('x'), {
      context: { route: '/api/checkout', platform: 'server' },
    });
    assert.equal(submission.route, '/api/checkout');
  });
});

describe('import', () => {
  const rows = [
    { body: 'dark mode please', clientTs: '2026-08-02T00:00:00.000Z', user: { externalId: 'u_1' } },
    { body: 'add dark mode', clientTs: '2026-08-01T00:00:00.000Z', user: { externalId: 'u_2' } },
  ];

  test('rows are inserted in chronological order, not file order', async () => {
    // Clustering is order-dependent, so replaying history in the order it
    // happened reproduces what live ingest would have produced. File order is
    // an artifact of whoever wrote the export.
    const q = quorum();
    await q.import(rows);
    const stored = await q.submissions();
    assert.deepEqual(stored.map((s) => s.clientTs), [
      '2026-08-01T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
    ]);
  });

  test('the source defaults to import', async () => {
    const q = quorum();
    await q.import(rows);
    assert.equal((await q.submissions())[0]?.source, 'import');
  });

  test('re-running an import inserts nothing', async () => {
    // The failure this prevents: a weekly export re-run silently doubling
    // every issue's member count and evidence.
    const q = quorum();
    const first = await q.import(rows);
    const second = await q.import(rows);
    assert.deepEqual(first, { total: 2, inserted: 2, duplicate: 0 });
    assert.deepEqual(second, { total: 2, inserted: 0, duplicate: 2 });
    assert.equal((await q.submissions()).length, 2);
  });

  test('unattributed rows are refused by default', async () => {
    await assert.rejects(
      quorum().import([{ body: 'x', clientTs: CLOCK }]),
      /no user identity/,
    );
  });

  test('per-record treats every row as a distinct user', async () => {
    const q = quorum();
    await q.import(
      [
        { body: 'dark mode', clientTs: '2026-08-01T00:00:00.000Z' },
        { body: 'dark mode too', clientTs: '2026-08-02T00:00:00.000Z' },
      ],
      { unattributed: 'per-record' },
    );
    assert.equal(new Set((await q.submissions()).map((s) => s.userId)).size, 2);
  });

  test('a fixed key buckets everything as one user', async () => {
    const q = quorum();
    await q.import(
      [
        { body: 'a thing', clientTs: '2026-08-01T00:00:00.000Z' },
        { body: 'another thing', clientTs: '2026-08-02T00:00:00.000Z' },
      ],
      { unattributed: { key: 'legacy' } },
    );
    assert.equal(new Set((await q.submissions()).map((s) => s.userId)).size, 1);
  });

  test('per-day buckets by calendar day', async () => {
    const q = quorum();
    await q.import(
      [
        { body: 'a thing', clientTs: '2026-08-01T01:00:00.000Z' },
        { body: 'another thing', clientTs: '2026-08-01T20:00:00.000Z' },
        { body: 'a third thing', clientTs: '2026-08-02T01:00:00.000Z' },
      ],
      { unattributed: 'per-day' },
    );
    assert.equal(new Set((await q.submissions()).map((s) => s.userId)).size, 2);
  });

  test('a missing or unparseable timestamp fails the import', async () => {
    // Stamping an import with the wall clock makes a five-year backlog read as
    // one enormous growth spike, and nothing downstream can detect it.
    await assert.rejects(
      quorum().import([{ body: 'x', clientTs: '', user: { externalId: 'u' } }]),
      /row 1: clientTs/,
    );
  });

  test('an empty body fails the import by row number', async () => {
    await assert.rejects(
      quorum().import([
        { body: 'ok', clientTs: CLOCK, user: { externalId: 'u' } },
        { body: '  ', clientTs: CLOCK, user: { externalId: 'u' } },
      ]),
      /row 2: empty body/,
    );
  });

  test('validation runs before anything is written', async () => {
    // A half-applied import is worse than a refused one: the caller cannot
    // tell how far it got, and re-running is only safe because of derived ids.
    const q = quorum();
    await assert.rejects(
      q.import([
        { body: 'ok', clientTs: CLOCK, user: { externalId: 'u' } },
        { body: '', clientTs: CLOCK, user: { externalId: 'u' } },
      ]),
    );
    assert.equal((await q.submissions()).length, 0);
  });

  test('a per-row source overrides the batch default', async () => {
    const q = quorum();
    await q.import([{ body: 'x', clientTs: CLOCK, user: { externalId: 'u' }, source: 'support_inbox' }]);
    assert.equal((await q.submissions())[0]?.source, 'support_inbox');
  });

  test('an empty import is a no-op', async () => {
    assert.deepEqual(await quorum().import([]), { total: 0, inserted: 0, duplicate: 0 });
  });
});

describe('importCsv', () => {
  const CSV = [
    'id,requester_id,created_at,description,mrr,type,page',
    't1,cust_1,2026-08-01T00:00:00Z,"Please add dark mode, it hurts at night",4000,feature_request,/settings',
    't2,cust_2,2026-08-02T00:00:00Z,"CSV export is broken",120,bug,/reports',
  ].join('\n');

  test('columns are auto-detected from common export headers', async () => {
    const q = quorum();
    const result = await q.importCsv(CSV);
    assert.equal(result.inserted, 2);
    const stored = await q.submissions();
    assert.equal(stored[0]?.userId, 'u:cust_1');
    assert.equal(stored[0]?.mrr, 4000);
    assert.equal(stored[0]?.route, '/settings');
    assert.equal(stored[1]?.kind, 'bug');
  });

  test('the ticket id becomes the submission id, so a re-export is a no-op', async () => {
    const q = quorum();
    await q.importCsv(CSV);
    const again = await q.importCsv(CSV);
    assert.equal(again.duplicate, 2);
  });

  test('explicit column names override detection', async () => {
    const csv = 'who,when,what\nu_9,2026-08-01T00:00:00Z,make it faster';
    const q = quorum();
    await q.importCsv(csv, { columns: { body: 'what', clientTs: 'when', externalId: 'who' } });
    assert.equal((await q.submissions())[0]?.userId, 'u:u_9');
  });

  test('unix epoch seconds are recognized', async () => {
    // Date.parse reads a bare number as a year, so 1725321600 would silently
    // become the year 1725321600.
    const q = quorum();
    await q.importCsv('user_id,date,body\nu_1,1725321600,hello');
    assert.match((await q.submissions())[0]?.clientTs ?? '', /^2024-09-03/);
  });

  test('unix epoch milliseconds are recognized', async () => {
    const q = quorum();
    await q.importCsv('user_id,date,body\nu_1,1725321600000,hello');
    assert.match((await q.submissions())[0]?.clientTs ?? '', /^2024-09-03/);
  });

  test('an ambiguous bare number is rejected rather than guessed', async () => {
    await assert.rejects(
      quorum().importCsv('user_id,date,body\nu_1,12345,hello'),
      /not a parseable date/,
    );
  });

  test('a missing body column names what was actually in the file', async () => {
    await assert.rejects(quorum().importCsv('user_id,date\nu_1,2026-01-01'), /no body column found; saw \[/);
  });

  test('a missing timestamp column is an error', async () => {
    await assert.rejects(quorum().importCsv('user_id,body\nu_1,hello'), /no timestamp column found/);
  });

  test('an unrecognized kind is ignored rather than failing the import', async () => {
    // "Escalation" shows up in real exports alongside valid kinds; losing the
    // whole import over it is not worth it.
    const q = quorum();
    await q.importCsv('user_id,date,body,type\nu_1,2026-08-01T00:00:00Z,hello,Escalation');
    assert.equal((await q.submissions())[0]?.kind, 'feature_request');
  });

  test('a blank user cell falls back rather than becoming an identity', async () => {
    const q = quorum();
    await q.importCsv('user_id,date,body\n,2026-08-01T00:00:00Z,hello', { unattributed: 'per-record' });
    assert.equal((await q.submissions())[0]?.attributed, false);
  });

  test('a tab-delimited export works', async () => {
    const q = quorum();
    await q.importCsv('user_id\tdate\tbody\nu_1\t2026-08-01T00:00:00Z\thello', { delimiter: '\t' });
    assert.equal((await q.submissions()).length, 1);
  });

  test('a header-only file imports nothing', async () => {
    assert.deepEqual(await quorum().importCsv('id,body,date\n'), { total: 0, inserted: 0, duplicate: 0 });
  });
});

describe('ingest', () => {
  function envelope(events: CaptureEnvelope['events']): CaptureEnvelope {
    return { v: PROTOCOL_VERSION, sentAt: CLOCK, project: 'pk_live_1', events };
  }

  const event = {
    id: '01J000000000000000000000AA',
    kind: 'feature_request' as const,
    source: 'nub' as const,
    clientTs: '2026-08-01T00:00:00.000Z',
    body: 'please add dark mode',
    user: { anonId: 'qa_7f3c' },
  };

  test('an envelope is accepted and its ids returned', async () => {
    const result = await quorum().ingest(envelope([event]));
    assert.deepEqual(result, { accepted: [event.id], duplicate: [] });
  });

  test('a replayed flush reports duplicates, not errors', async () => {
    // PROTOCOL: 200 on a duplicate id is success, and it is what makes the
    // offline queue safely retryable.
    const q = quorum();
    await q.ingest(envelope([event]));
    const replay = await q.ingest(envelope([event]));
    assert.deepEqual(replay, { accepted: [], duplicate: [event.id] });
    assert.equal((await q.submissions()).length, 1);
  });

  test('a mixed batch splits accepted from duplicate', async () => {
    const q = quorum();
    await q.ingest(envelope([event]));
    const second = { ...event, id: '01J000000000000000000000BB' };
    const result = await q.ingest(envelope([event, second]));
    assert.deepEqual(result.accepted, [second.id]);
    assert.deepEqual(result.duplicate, [event.id]);
  });

  test('an unsupported protocol version is refused', async () => {
    const bad = { ...envelope([event]), v: 99 } as unknown as CaptureEnvelope;
    await assert.rejects(quorum().ingest(bad), /unsupported protocol version 99/);
  });

  test('the anon id becomes the identity', async () => {
    const q = quorum();
    await q.ingest(envelope([event]));
    assert.equal((await q.submissions())[0]?.userId, 'a:qa_7f3c');
  });

  // Built without the key rather than with an `undefined` one: the protocol
  // types are exactOptionalPropertyTypes, and "absent" is the case under test.
  const anonEvent = {
    id: '01J000000000000000000000DD',
    kind: 'feature_request' as const,
    source: 'nub' as const,
    clientTs: '2026-08-01T00:00:00.000Z',
    body: 'please add dark mode',
  };

  test('an event with no identity is bucketed, not dropped', async () => {
    // Cleared storage or private browsing is still real feedback, and the
    // protocol does not consider a missing anon id malformed.
    const q = quorum();
    const result = await q.ingest(envelope([anonEvent]));
    assert.deepEqual(result.accepted, [anonEvent.id]);
    assert.equal((await q.submissions())[0]?.attributed, false);
  });

  test('the caller can demand attribution instead', async () => {
    await assert.rejects(
      quorum().ingest(envelope([anonEvent]), { unattributed: 'error' }),
      /no user identity/,
    );
  });

  test('a rage shake with no body is valid', async () => {
    // PROTOCOL rule 4: text or a capture, not necessarily both.
    const rage = {
      id: '01J000000000000000000000EE',
      kind: 'rage' as const,
      source: 'shake' as const,
      clientTs: '2026-08-01T00:00:00.000Z',
      user: { anonId: 'qa_7f3c' },
    };
    const q = quorum();
    const result = await q.ingest(envelope([rage]));
    assert.deepEqual(result.accepted, [rage.id]);
    assert.equal((await q.submissions())[0]?.body, '');
  });

  test('an unparseable event timestamp is refused by id', async () => {
    const bad = { ...event, clientTs: 'nope' };
    await assert.rejects(quorum().ingest(envelope([bad])), /event 01J.*clientTs/);
  });

  test('context fields survive the wire', async () => {
    const withContext = { ...event, context: { route: '/checkout', appVersion: '4.12.0', platform: 'web' as const } };
    const q = quorum();
    await q.ingest(envelope([withContext]));
    assert.equal((await q.submissions())[0]?.route, '/checkout');
  });

  test('an empty batch is accepted', async () => {
    assert.deepEqual(await quorum().ingest(envelope([])), { accepted: [], duplicate: [] });
  });
});

describe('end to end', () => {
  test('an inbox export becomes a ranked list with evidence', async () => {
    // The v0.1 claim in one test: import feedback you already have, get a
    // defensible top item back, with the verbatim quotes behind it.
    const q = quorum();
    await q.importCsv(
      [
        'requester_id,created_at,description,mrr',
        'c1,2026-08-01T00:00:00Z,"the app destroys my eyes, please add dark mode",50',
        'c2,2026-08-02T00:00:00Z,"add dark mode please",4000',
        'c3,2026-08-03T00:00:00Z,"dark mode would be great",200',
        'c4,2026-08-04T00:00:00Z,"csv export is broken",100',
      ].join('\n'),
      { source: 'support_inbox' },
    );

    const issues = await q.issues({ now: '2026-09-03T00:00:00.000Z' });
    const top = issues[0];

    assert.equal(top?.uniqueUsers, 3);
    assert.match(top?.title ?? '', /dark mode/);
    assert.ok((top?.quotes.length ?? 0) > 0);
    assert.match(top?.explanation ?? '', /3 users/);
    assert.ok((top?.score ?? 0) > 0);
  });

  test('widget submissions and imported tickets cluster together', async () => {
    // The reason all four inbound paths share one store: a support ticket and
    // a widget submission about the same thing are one issue, not two.
    const q = quorum();
    await q.import(
      [{ body: 'please add dark mode', clientTs: '2026-08-01T00:00:00.000Z', user: { externalId: 'c1' } }],
      { source: 'support_inbox' },
    );
    await q.ingest({
      v: PROTOCOL_VERSION,
      sentAt: CLOCK,
      project: 'pk_live_1',
      events: [
        {
          id: '01J000000000000000000000CC',
          kind: 'feature_request',
          source: 'nub',
          clientTs: '2026-08-05T00:00:00.000Z',
          body: 'add dark mode please',
          user: { externalId: 'c2' },
        },
      ],
    });

    const issues = await q.issues({ now: '2026-09-03T00:00:00.000Z' });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.uniqueUsers, 2);
    const sources = new Set(issues[0]?.quotes.map((quote) => quote.source));
    assert.equal(sources.size, 2);
  });
});
