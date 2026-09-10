/**
 * A fake OpenAI-compatible `/embeddings` endpoint.
 *
 * ```
 * npm run mock-model            # serves on :11500
 * ```
 *
 * ## What this is for, and what it is not
 *
 * `QUORUM_EMBED_PROVIDER=stand-in` exercises the hybrid blend in-process. It
 * never makes an HTTP request, so it cannot tell you whether your
 * `QUORUM_EMBED_BASE_URL` is right, whether the endpoint speaks the shape the
 * adapter expects, or whether your key is being sent. Every one of those is a
 * way to lose twenty minutes before a real model has said anything.
 *
 * This closes that gap: a real server, on a real port, speaking the real wire
 * format, so `npm run eval` can be pointed at it exactly as it would be
 * pointed at Ollama. If a sweep works against this and fails against your
 * model, the problem is the model or the URL — not the plumbing.
 *
 * **The vectors are a hash function, not semantics.** Any quality number that
 * comes out of a sweep against this endpoint is meaningless in the same way
 * the stand-in's numbers are, and for the same reason. See `embed-cache.ts`.
 */

import { createServer } from 'node:http';

import { createHashingEmbedder } from '../../aggregate/src/embed-cache.ts';

export interface MockModelOptions {
  port?: number;
  /** Vector width. 384 matches several small sentence models. */
  dimensions?: number;
  /** Log each request. Default true. */
  verbose?: boolean;
}

export function createMockModelServer(options: MockModelOptions = {}) {
  const embedder = createHashingEmbedder({ dimensions: options.dimensions ?? 384 });
  const verbose = options.verbose ?? true;

  return createServer((req, res) => {
    void (async () => {
      let body = '';
      for await (const chunk of req) body += chunk as string;

      let payload: { input?: unknown; model?: string } = {};
      try {
        payload = JSON.parse(body === '' ? '{}' : body) as typeof payload;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid json' } }));
        return;
      }

      // The OpenAI shape allows a bare string or an array, and real endpoints
      // accept both — so an adapter that only ever sends arrays should still
      // be tested against a server that tolerates either.
      const texts = Array.isArray(payload.input)
        ? (payload.input as string[])
        : typeof payload.input === 'string'
          ? [payload.input]
          : [];

      const vectors = await embedder.embed(texts);
      if (verbose) {
        console.error(`  POST ${req.url ?? ''}  model=${payload.model ?? '(none)'}  ${String(texts.length)} inputs`);
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          model: payload.model ?? 'mock',
          data: vectors.map((vector, index) => ({
            object: 'embedding',
            index,
            embedding: [...vector],
          })),
        }),
      );
    })();
  });
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const port = Number(process.env['QUORUM_MOCK_PORT'] ?? 11500);
  createMockModelServer({ port }).listen(port, '127.0.0.1', () => {
    console.error(`\n  mock embeddings endpoint on http://127.0.0.1:${String(port)}/v1\n`);
    console.error('  Point the eval at it, in another shell:\n');
    console.error('    QUORUM_EMBED_PROVIDER=mock \\');
    console.error(`    QUORUM_EMBED_BASE_URL=http://127.0.0.1:${String(port)}/v1 \\`);
    console.error('    QUORUM_EMBED_MODEL=whatever npm run eval\n');
    console.error('  The vectors are a hash, not semantics — this proves the wiring only.\n');
  });
}
