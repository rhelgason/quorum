/**
 * Service entrypoint.
 *
 * ```
 * npm run serve
 * QUORUM_DATA=./data/quorum.jsonl QUORUM_PORT=8787 npm run serve
 * ```
 *
 * Console plumbing over `createApiServer`, and excluded from coverage for the
 * same reason `packages/eval/src/cli.ts` is: it holds no logic that
 * `server.ts` and `router.ts` do not already expose and test.
 */

import { Quorum } from '../../../packages/node/src/client.ts';
import { FileStore } from '../../../packages/node/src/file-store.ts';
import { createApiServer } from './server.ts';

const port = Number(process.env['QUORUM_PORT'] ?? 8787);
const dataPath = process.env['QUORUM_DATA'] ?? './data/quorum.jsonl';
const projectId = process.env['QUORUM_PROJECT'] ?? 'default';
const projectKey = process.env['QUORUM_PROJECT_KEY'];

const store = new FileStore({
  path: dataPath,
  durable: process.env['QUORUM_FSYNC'] === '1',
  onCorruptLine: (line) => {
    console.warn(`[quorum] skipping unparseable line ${String(line)} in ${dataPath}`);
  },
});

const quorum = new Quorum({ projectId, store });

const server = createApiServer({
  quorum,
  now: () => new Date(),
  ...(projectKey !== undefined && { projectKey }),
  ...(process.env['QUORUM_ALLOW_ORIGIN'] !== undefined && {
    allowOrigin: process.env['QUORUM_ALLOW_ORIGIN'],
  }),
});

server.listen(port, () => {
  const count = store.projects().reduce((n, p) => n + (p === projectId ? 1 : 0), 0);
  console.log(`\nquorum api on http://localhost:${String(port)}`);
  console.log(`  data      ${dataPath}${count > 0 ? '' : ' (new)'}`);
  console.log(`  project   ${projectId}`);
  console.log(`  auth      ${projectKey === undefined ? 'open — set QUORUM_PROJECT_KEY to require one' : 'project key required'}`);
  console.log('\n  POST /v0/ingest          GET /v0/issues');
  console.log('  GET  /v0/issues/:id      GET /v0/issues/:id/submissions');
  console.log('  GET  /v0/health\n');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
