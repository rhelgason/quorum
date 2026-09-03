/**
 * `node:http` glue over the router.
 *
 * Deliberately thin — everything with a rule in it lives in `router.ts`, which
 * is testable as data. What is left here is reading a body, catching what the
 * router did not, and setting headers.
 *
 * Zero dependencies, including no HTTP framework. Express or Fastify would buy
 * middleware and routing this does not need, at the cost of the property the
 * whole repo is built on: `node --test` with an empty `node_modules`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { createRouter, type ApiRequest, type RouterOptions } from './router.ts';

export interface ServerOptions extends RouterOptions {
  /**
   * Reject bodies over this many bytes with 413. Default 1 MiB.
   *
   * Matches the client queue's `maxBytes`, and the protocol's 413 row tells a
   * client to strip the capture and retry the envelope alone — so this is a
   * recoverable limit by design, not a hard failure.
   */
  maxBodyBytes?: number;
  /**
   * Allowed CORS origin. Default `*`.
   *
   * The write path takes a public key that is already embedded in client
   * bundles and can only write, so a permissive default costs nothing an
   * attacker could not do by reading the page source. Set it for the read API,
   * which is a different matter — that one exposes customer feedback.
   */
  allowOrigin?: string;
}

export function createApiServer(options: ServerOptions): Server {
  const route = createRouter(options);
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  const allowOrigin = options.allowOrigin ?? '*';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, route, maxBodyBytes, allowOrigin);
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  route: ReturnType<typeof createRouter>,
  maxBodyBytes: number,
  allowOrigin: string,
): Promise<void> {
  const send = (status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'access-control-allow-origin': allowOrigin,
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      // Every response is computed fresh; caching a ranked list would show a
      // reader yesterday's priorities with today's timestamp.
      'cache-control': 'no-store',
    });
    res.end(payload);
  };

  try {
    if (req.method === 'OPTIONS') {
      send(204, {});
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const { body, tooLarge } = await readBody(req, maxBodyBytes);

    const request: ApiRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      ...(body !== undefined && { body }),
      ...(tooLarge && { tooLarge }),
    };

    const response = await route(request);
    send(response.status, response.body);
  } catch (error) {
    // A 500 tells a conforming client to back off and retry, which is right
    // for something we did not anticipate — unlike a 400, which would make it
    // drop a user's feedback over our bug.
    send(500, {
      error: 'internal',
      message: error instanceof Error ? error.message : 'unexpected error',
    });
  }
}

/**
 * Read and parse a JSON body.
 *
 * Stops reading once the cap is exceeded rather than buffering the whole
 * payload and then rejecting it — a size limit that first accumulates the
 * oversized thing in memory is not a limit, it is an invitation.
 *
 * An unparseable body is passed through as `undefined` rather than throwing;
 * the router decides the status, because only it knows whether a body was
 * required for that route.
 */
async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ body: unknown; tooLarge: boolean }> {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') {
    return { body: undefined, tooLarge: false };
  }

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) {
      req.destroy();
      return { body: undefined, tooLarge: true };
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return { body: undefined, tooLarge: false };

  try {
    return { body: JSON.parse(raw), tooLarge: false };
  } catch {
    return { body: undefined, tooLarge: false };
  }
}
