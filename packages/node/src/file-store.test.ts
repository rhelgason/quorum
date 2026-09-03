import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStore } from './file-store.ts';
import type { Submission } from './submission.ts';

const dirs: string[] = [];

function tempPath(name = 'log.jsonl'): string {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-store-'));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function submission(id: string, over: Partial<Submission> = {}): Submission {
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
    ...over,
  };
}

describe('durability', () => {
  test('submissions survive a restart', async () => {
    const path = tempPath();
    const first = new FileStore({ path });
    await first.put(submission('a'));
    await first.put(submission('b'));

    const second = new FileStore({ path });
    assert.deepEqual((await second.list('p1')).map((s) => s.id), ['a', 'b']);
  });

  test('the log is append-only JSONL, one submission per line', async () => {
    // Inspectable with `tail`, and enforcing at the storage layer the rule
    // that submissions are immutable facts.
    const path = tempPath();
    const store = new FileStore({ path });
    await store.put(submission('a'));
    await store.put(submission('b'));

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0] as string).id, 'a');
  });

  test('a duplicate is not appended a second time', async () => {
    const path = tempPath();
    const store = new FileStore({ path });
    assert.equal(await store.put(submission('a')), true);
    assert.equal(await store.put(submission('a')), false);
    assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1);
  });

  test('a duplicate across restarts is still a duplicate', async () => {
    // This is what makes a re-run of an import safe against a durable store,
    // not just an in-memory one.
    const path = tempPath();
    await new FileStore({ path }).put(submission('a'));
    assert.equal(await new FileStore({ path }).put(submission('a')), false);
  });

  test('the first write wins after a restart', async () => {
    const path = tempPath();
    await new FileStore({ path }).put(submission('a', { body: 'original' }));
    const reopened = new FileStore({ path });
    await reopened.put(submission('a', { body: 'replacement' }));
    assert.equal((await reopened.get('p1', 'a'))?.body, 'original');
  });

  test('durable mode still writes readable lines', async () => {
    const path = tempPath();
    const store = new FileStore({ path, durable: true });
    await store.put(submission('a'));
    assert.equal((await new FileStore({ path }).list('p1')).length, 1);
  });

  test('a missing file is an empty store, not an error', async () => {
    assert.deepEqual(await new FileStore({ path: tempPath() }).list('p1'), []);
  });

  test('nested directories are created', async () => {
    const path = join(tempPath('x'), 'deep', 'nested', 'log.jsonl');
    const store = new FileStore({ path });
    await store.put(submission('a'));
    assert.equal((await store.count('p1')), 1);
  });
});

describe('corrupt input never bricks startup', () => {
  test('a truncated final line is skipped, not thrown', () => {
    // A crash mid-append leaves exactly this. Throwing would mean one badly
    // timed power cut permanently prevents the service from starting.
    const path = tempPath();
    writeFileSync(path, `${JSON.stringify(submission('a'))}\n{"id":"b","proj`);

    let store: FileStore | undefined;
    assert.doesNotThrow(() => {
      store = new FileStore({ path });
    });
    assert.ok(store !== undefined);
  });

  test('the good rows before a corrupt one are kept', async () => {
    const path = tempPath();
    writeFileSync(path, `${JSON.stringify(submission('a'))}\nnot json\n${JSON.stringify(submission('c'))}\n`);
    const store = new FileStore({ path });
    assert.deepEqual((await store.list('p1')).map((s) => s.id), ['a', 'c']);
  });

  test('a row missing required fields is skipped', async () => {
    const path = tempPath();
    writeFileSync(path, `{"id":"x"}\n${JSON.stringify(submission('a'))}\n`);
    assert.deepEqual((await new FileStore({ path }).list('p1')).map((s) => s.id), ['a']);
  });

  test('corrupt lines are reported with their line number', () => {
    const path = tempPath();
    writeFileSync(path, `${JSON.stringify(submission('a'))}\nbroken\n`);
    const seen: number[] = [];
    new FileStore({ path, onCorruptLine: (line) => seen.push(line) });
    assert.deepEqual(seen, [2]);
  });

  test('blank lines are not corruption', async () => {
    const path = tempPath();
    writeFileSync(path, `${JSON.stringify(submission('a'))}\n\n\n`);
    let corrupt = 0;
    const store = new FileStore({ path, onCorruptLine: () => corrupt++ });
    assert.equal(corrupt, 0);
    assert.equal(await store.count('p1'), 1);
  });

  test('an unknown extra field is preserved, not rejected', async () => {
    // PROTOCOL is additive-only: a row written by a newer version must not be
    // discarded by an older reader.
    const path = tempPath();
    writeFileSync(path, `${JSON.stringify({ ...submission('a'), futureField: 42 })}\n`);
    const stored = (await new FileStore({ path }).list('p1'))[0] as unknown as Record<string, unknown>;
    assert.equal(stored['futureField'], 42);
  });
});

describe('the SubmissionStore contract', () => {
  test('insertion order is preserved', async () => {
    const path = tempPath();
    const store = new FileStore({ path });
    for (const id of ['c', 'a', 'b']) await store.put(submission(id));
    assert.deepEqual((await store.list('p1')).map((s) => s.id), ['c', 'a', 'b']);
  });

  test('projects are isolated', async () => {
    const path = tempPath();
    const store = new FileStore({ path });
    await store.put(submission('a'));
    await store.put(submission('a', { projectId: 'p2' }));
    assert.equal(await store.count('p1'), 1);
    assert.equal(await store.count('p2'), 1);
    assert.deepEqual(store.projects().sort(), ['p1', 'p2']);
  });

  test('reads on an unknown project are empty rather than throwing', async () => {
    const store = new FileStore({ path: tempPath() });
    assert.deepEqual(await store.list('nope'), []);
    assert.equal(await store.count('nope'), 0);
    assert.equal(await store.get('nope', 'a'), undefined);
  });

  test('get returns undefined for an unknown id', async () => {
    const store = new FileStore({ path: tempPath() });
    await store.put(submission('a'));
    assert.equal(await store.get('p1', 'zzz'), undefined);
  });

  test('mutating the returned list cannot corrupt the log', async () => {
    const store = new FileStore({ path: tempPath() });
    await store.put(submission('a'));
    (await store.list('p1') as Submission[]).length = 0;
    assert.equal(await store.count('p1'), 1);
  });
});
