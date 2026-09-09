/**
 * The development server: static files, TypeScript on the fly, and a proxy to
 * the ingest API.
 *
 * The proxy is not a convenience. `@quorum/web` is a third-party script on
 * somebody else's page, so the interesting integration questions — does the
 * browser send the envelope, does CORS behave, does the offline queue drain on
 * reconnect — only have honest answers when the page and the API are reachable
 * the way they would be in production. Serving the app from one origin and
 * forwarding `/v0/*` to the API gives exactly that, and it means the example
 * app's code contains no localhost port numbers.
 *
 * Development only. There is no auth, no rate limiting, and it will happily
 * read any file under its root.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

import { StripCache } from './strip.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  // The whole point: the browser is told this is JavaScript, and it is, by the
  // time it leaves here.
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface DevServerOptions {
  /** Files are served from here and nowhere above it. */
  root: string;
  /** URL prefix → directory, checked before `root`. */
  mounts?: Record<string, string>;
  /** Requests to `/v0/*` are forwarded here, e.g. `http://127.0.0.1:8787`. */
  apiOrigin?: string;
  /** Served for a request that resolves to a directory. Default `index.html`. */
  index?: string;
  /**
   * Served for an extensionless path that matches no file, e.g. `/reports`.
   *
   * Needed so the example app can use real URLs instead of hash routes. That
   * is not cosmetic: `route` is a first-class clustering signal, and a nub
   * reading `location.pathname` on a hash-routed page would tag every
   * submission `/` and quietly flatten the signal to nothing.
   */
  spa?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Resolve a URL path to a file, or `undefined` if it escapes the root.
 *
 * Traversal is checked *after* resolution rather than by scanning the raw path
 * for `..`, because the raw path is percent-encoded and the interesting
 * attacks are the encodings you did not think to scan for.
 *
 * Note what is deliberately absent: a `normalize()` before resolving.
 * Normalizing an absolute path collapses leading `..` against `/`, which
 * quietly clamps `/../../etc/passwd` to `/etc/passwd` and then reads it from
 * *inside* the root — safe, but it makes the escape check below unreachable
 * and turns a probe into an ordinary 404. Letting `resolve` actually walk the
 * `..` segments is what gives the check something to catch.
 */
export function resolvePath(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // A malformed escape is not a path. Refuse it rather than guess.
    return undefined;
  }

  // A NUL byte truncates the path in some syscalls but not in the check above.
  if (decoded.includes('\0')) return undefined;

  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, `.${decoded}`);
  const rel = relative(absoluteRoot, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`)) return undefined;
  return candidate;
}

export function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export function createDevServer(options: DevServerOptions): Server {
  const root = resolve(options.root);
  const index = options.index ?? 'index.html';
  const mounts = Object.entries(options.mounts ?? {}).map(
    ([prefix, dir]) => [prefix.replace(/\/+$/, ''), resolve(dir)] as const,
  );
  const cache = new StripCache();
  const fetchImpl = options.fetchImpl ?? fetch;

  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      send(res, 500, 'text/plain; charset=utf-8', String(error));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (options.apiOrigin !== undefined && url.pathname.startsWith('/v0/')) {
      await proxy(req, res, options.apiOrigin, url, fetchImpl);
      return;
    }

    // Longest prefix first, so `/packages` and `/packages/web` can coexist.
    const mount = mounts
      .filter(([prefix]) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
      .sort((a, b) => b[0].length - a[0].length)[0];

    const base = mount === undefined ? root : mount[1];
    const rest = mount === undefined ? url.pathname : url.pathname.slice(mount[0].length) || '/';

    const path = resolvePath(base, rest);
    if (path === undefined) {
      send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
      return;
    }

    // Only extensionless paths fall back. A missing `.ts` or `.css` must stay
    // a 404 — serving HTML in its place turns a typo'd import into an opaque
    // "unexpected token <" from somewhere else entirely.
    const fallback =
      options.spa !== undefined && extname(rest) === '' ? resolve(root, options.spa) : undefined;

    serveFile(res, path, index, cache, fallback);
  }
}

function serveFile(
  res: ServerResponse,
  path: string,
  index: string,
  cache: StripCache,
  fallback?: string,
): void {
  let target = path;
  let stat;
  try {
    stat = statSync(target);
    if (stat.isDirectory()) {
      target = join(target, index);
      stat = statSync(target);
    }
  } catch {
    if (fallback !== undefined) {
      serveFile(res, fallback, index, cache);
      return;
    }
    send(res, 404, 'text/plain; charset=utf-8', `not found: ${path}`);
    return;
  }

  const body =
    extname(target) === '.ts'
      ? cache.get(target, stat.mtimeMs, () => readFileSync(target, 'utf8'))
      : readFileSync(target);

  // No caching at all. A dev server that serves a stale module after an edit
  // costs more time than it saves, every time.
  send(res, 200, contentType(target), body);
}

/**
 * Forward a request to the API, body and all.
 *
 * The body is buffered rather than streamed because Node's `fetch` needs
 * `duplex: 'half'` for a stream and this only ever carries capture envelopes,
 * which are kilobytes.
 */
async function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string,
  url: URL,
  fetchImpl: typeof fetch,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);

  const headers: Record<string, string> = {};
  const contentTypeHeader = req.headers['content-type'];
  if (contentTypeHeader !== undefined) headers['content-type'] = contentTypeHeader;

  let upstream: Response;
  try {
    upstream = await fetchImpl(`${origin}${url.pathname}${url.search}`, {
      method: req.method ?? 'GET',
      headers,
      ...(body.length > 0 && { body }),
    });
  } catch (error) {
    // 502, not 500: the dev server is fine, the thing behind it is not. The
    // distinction matters when the usual cause is forgetting to start the API.
    send(
      res,
      502,
      'application/json; charset=utf-8',
      JSON.stringify({
        error: 'upstream_unreachable',
        message: `no API at ${origin} — is \`npm run serve\` running? (${String(error)})`,
      }),
    );
    return;
  }

  const payload = Buffer.from(await upstream.arrayBuffer());

  // Forward the upstream's headers, not just its content type.
  //
  // Dropping them silently breaks contracts the client depends on: a `429`
  // arrived through here with its `Retry-After` stripped, so the transport
  // fell back to its own jittered backoff and ignored the number the server
  // had just computed. Anything the API decided to say, the caller should hear.
  const forwarded: Record<string, string> = {};
  for (const [name, value] of upstream.headers) {
    // Recomputed by `send`, or meaningless once the body has been buffered.
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    forwarded[name] = value;
  }

  send(
    res,
    upstream.status,
    upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    payload,
    forwarded,
  );
}

/** Headers that describe this hop rather than the response. */
const HOP_BY_HOP = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  extra: Record<string, string> = {},
): void {
  const payload = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, {
    'cache-control': 'no-store',
    ...extra,
    // After `extra`, because these two are facts about what is being written
    // here and an upstream's stale values would be wrong.
    'content-type': type,
    'content-length': payload.length,
  });
  res.end(payload);
}
