/**
 * The dev server: path resolution, content types, mounts, and the API proxy.
 *
 * Path resolution gets the most attention because it is the one part with a
 * security property, even in a development tool — a static server that will
 * read anything above its root is a file exfiltration primitive the moment
 * anyone runs it on a shared machine.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { contentType, createDevServer, resolvePath } from './serve.ts';

describe('resolvePath', () => {
  it('resolves a normal path under the root', () => {
    assert.equal(resolvePath('/srv/app', '/index.html'), '/srv/app/index.html');
  });

  it('refuses to climb out of the root', () => {
    assert.equal(resolvePath('/srv/app', '/../../etc/passwd'), undefined);
    assert.equal(resolvePath('/srv/app', '/a/b/../../../secrets'), undefined);
  });

  it('refuses percent-encoded traversal', () => {
    // Checked after decoding, not by scanning the raw path — the interesting
    // attacks are the encodings you did not think to scan for.
    assert.equal(resolvePath('/srv/app', '/%2e%2e/%2e%2e/etc/passwd'), undefined);
  });

  it('refuses a malformed escape rather than passing it through', () => {
    assert.equal(resolvePath('/srv/app', '/%zz'), undefined);
  });

  it('refuses an embedded NUL', () => {
    assert.equal(resolvePath('/srv/app', '/index.html\0.png'), undefined);
  });

  it('allows the root itself', () => {
    assert.equal(resolvePath('/srv/app', '/'), '/srv/app');
  });

  it('allows a sibling directory whose name starts with the root name', () => {
    // `/srv/app-secrets` is not under `/srv/app`, but a naive prefix check
    // would say it is.
    assert.equal(resolvePath('/srv/app', '/../app-secrets/key'), undefined);
  });
});

describe('contentType', () => {
  it('serves .ts as javascript, which is the entire trick', () => {
    assert.equal(contentType('/packages/web/src/nub.ts'), 'text/javascript; charset=utf-8');
  });

  it('knows the handful of types the example app uses', () => {
    assert.equal(contentType('/index.html'), 'text/html; charset=utf-8');
    assert.equal(contentType('/app.css'), 'text/css; charset=utf-8');
    assert.equal(contentType('/data.json'), 'application/json; charset=utf-8');
    assert.equal(contentType('/logo.svg'), 'image/svg+xml');
  });

  it('falls back to octet-stream', () => {
    assert.equal(contentType('/thing.bin'), 'application/octet-stream');
  });
});

describe('the server', () => {
  let root: string;
  let server: Server;
  let base: string;
  const upstream: { url: string; method: string; body: string }[] = [];

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'quorum-devserver-'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>hi</title>');
    await writeFile(join(root, 'mod.ts'), 'export const answer: number = 42;\n');
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'nested', 'index.html'), '<!doctype html><title>nested</title>');
    await mkdir(join(root, 'lib'), { recursive: true });
    await writeFile(join(root, 'lib', 'helper.ts'), 'export const help = (): string => "ok";\n');

    server = createDevServer({
      root,
      mounts: { '/vendor': join(root, 'lib') },
      apiOrigin: 'http://api.invalid',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        upstream.push({
          url: String(url),
          method: init?.method ?? 'GET',
          body: init?.body === undefined ? '' : String(init.body),
        });
        return new Response(JSON.stringify({ accepted: ['01J'], duplicate: [] }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  });

  it('serves a static file', async () => {
    const res = await fetch(`${base}/index.html`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await res.text(), /<title>hi<\/title>/);
  });

  it('serves the index for a directory', async () => {
    assert.match(await (await fetch(`${base}/nested/`)).text(), /nested/);
    assert.match(await (await fetch(`${base}/`)).text(), /hi/);
  });

  it('strips types and labels .ts as javascript', async () => {
    const res = await fetch(`${base}/mod.ts`);
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');

    const body = await res.text();
    assert.ok(!body.includes('number'), 'the annotation survived');
    assert.match(body, /export const answer\s+= 42;/);
  });

  it('never caches, so an edit is one reload away', async () => {
    assert.equal((await fetch(`${base}/index.html`)).headers.get('cache-control'), 'no-store');
  });

  it('serves mounted directories under their prefix', async () => {
    const res = await fetch(`${base}/vendor/helper.ts`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /export const help/);
  });

  it('404s a missing file', async () => {
    assert.equal((await fetch(`${base}/nope.html`)).status, 404);
  });

  it('falls back to the SPA document for an extensionless path', async () => {
    const spa = createDevServer({ root, spa: 'index.html' });
    await new Promise<void>((ready) => spa.listen(0, '127.0.0.1', ready));
    const spaBase = `http://127.0.0.1:${(spa.address() as { port: number }).port}`;

    // Real URLs rather than hash routes, so `location.pathname` is a usable
    // clustering signal.
    assert.match(await (await fetch(`${spaBase}/reports`)).text(), /<title>hi<\/title>/);
    assert.match(await (await fetch(`${spaBase}/settings/security`)).text(), /<title>hi<\/title>/);

    // But a missing asset stays a 404. Serving HTML for a bad `.ts` import
    // turns a typo into "unexpected token <" from somewhere unrelated.
    assert.equal((await fetch(`${spaBase}/missing.ts`)).status, 404);
    assert.equal((await fetch(`${spaBase}/missing.css`)).status, 404);

    await new Promise<void>((done) => spa.close(() => done()));
  });

  it('403s an encoded-slash climb out of the root', async () => {
    // The vector that reaches `resolvePath` at all. WHATWG URL parsing already
    // collapses `%2e%2e` into `..` segments and removes them, but it leaves
    // `%2f` encoded — so this arrives as one long path segment and only
    // becomes traversal after `decodeURIComponent`.
    const res = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    assert.equal(res.status, 403);
  });

  it('does not serve a file above the root by any spelling', async () => {
    for (const path of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd']) {
      const res = await fetch(`${base}${path}`);
      assert.ok(res.status === 403 || res.status === 404, `${path} returned ${res.status}`);
      assert.ok(!(await res.text()).includes('root:'), `${path} leaked a file`);
    }
  });

  it('forwards /v0/ requests to the API, method and body intact', async () => {
    upstream.length = 0;
    const res = await fetch(`${base}/v0/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 0, project: 'pk', events: [] }),
    });

    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: ['01J'], duplicate: [] });
    assert.equal(upstream[0]?.url, 'http://api.invalid/v0/ingest');
    assert.equal(upstream[0]?.method, 'POST');
    assert.match(upstream[0]?.body ?? '', /"project":"pk"/);
  });

  it('forwards the query string', async () => {
    upstream.length = 0;
    await fetch(`${base}/v0/issues?limit=5`);
    assert.equal(upstream[0]?.url, 'http://api.invalid/v0/issues?limit=5');
  });

  it('forwards the upstream response headers, not just its content type', async () => {
    const withHeaders = createDevServer({
      root,
      apiOrigin: 'http://api.invalid',
      fetchImpl: (async () =>
        new Response('{"error":"rate_limited"}', {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '60',
            'access-control-expose-headers': 'retry-after',
          },
        })) as unknown as typeof fetch,
    });
    await new Promise<void>((ready) => withHeaders.listen(0, '127.0.0.1', ready));
    const base429 = `http://127.0.0.1:${(withHeaders.address() as { port: number }).port}`;

    const res = await fetch(`${base429}/v0/ingest`, { method: 'POST', body: '{}' });

    // Dropping these silently breaks a contract the client depends on: a 429
    // whose Retry-After is stripped makes the transport fall back to its own
    // jittered backoff and ignore the number the server just computed.
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
    assert.equal(res.headers.get('access-control-expose-headers'), 'retry-after');

    await new Promise<void>((done) => withHeaders.close(() => done()));
  });

  it('recomputes content-length rather than forwarding a stale one', async () => {
    const stale = createDevServer({
      root,
      apiOrigin: 'http://api.invalid',
      fetchImpl: (async () =>
        // A length that does not match the body. Forwarding it would truncate
        // the response or hang the connection.
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': '9999' },
        })) as unknown as typeof fetch,
    });
    await new Promise<void>((ready) => stale.listen(0, '127.0.0.1', ready));
    const staleBase = `http://127.0.0.1:${(stale.address() as { port: number }).port}`;

    const res = await fetch(`${staleBase}/v0/issues`);
    assert.deepEqual(await res.json(), { ok: true });

    await new Promise<void>((done) => stale.close(() => done()));
  });

  it('answers 502 with a usable message when the API is down', async () => {
    const down = createDevServer({
      root,
      apiOrigin: 'http://api.invalid',
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
    });
    await new Promise<void>((ready) => down.listen(0, '127.0.0.1', ready));
    const downBase = `http://127.0.0.1:${(down.address() as { port: number }).port}`;

    const res = await fetch(`${downBase}/v0/issues`);
    // 502 rather than 500: the dev server is fine, and the usual cause is
    // forgetting to start the API — so the message says so.
    assert.equal(res.status, 502);
    assert.match((await res.json()).message, /npm run serve/);

    await new Promise<void>((done) => down.close(() => done()));
  });
});
