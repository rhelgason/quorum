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
import { DEFAULT_ONLINE_THRESHOLD } from '../../../packages/node/src/issues.ts';
import { FileStore } from '../../../packages/node/src/file-store.ts';
import { rebuildIndex } from '../../../packages/node/src/rebuild.ts';
import { createApiServer } from './server.ts';
import { createRateLimiter } from './rate-limit.ts';

const port = Number(process.env['QUORUM_PORT'] ?? 8787);
const dataPath = process.env['QUORUM_DATA'] ?? './data/quorum.jsonl';
const projectId = process.env['QUORUM_PROJECT'] ?? 'default';
const projectKey = process.env['QUORUM_PROJECT_KEY'];

// On by default, unlike most things here. The write key is public by design —
// it ships in every page that loads the widget — so an unlimited ingest is
// open to anyone who reads the page source. `0` disables it.
const rateLimit = Number(process.env['QUORUM_RATE_LIMIT'] ?? 120);
const rateWindowMs = Number(process.env['QUORUM_RATE_WINDOW_MS'] ?? 60_000);

const store = new FileStore({
  path: dataPath,
  durable: process.env['QUORUM_FSYNC'] === '1',
  onCorruptLine: (line) => {
    console.warn(`[quorum] skipping unparseable line ${String(line)} in ${dataPath}`);
  },
});

// Clusters are assigned once, on write, and the index is rebuilt by replaying
// the log at boot rather than persisted beside it. The replay is exact —
// leader-follower is deterministic and an append-only log preserves order — so
// there is no second copy of derived state to fall out of sync. It costs a
// pass over the corpus at startup, which is the right trade until it isn't.
const threshold = Number(process.env['QUORUM_THRESHOLD'] ?? DEFAULT_ONLINE_THRESHOLD);
const rebuilt = await rebuildIndex(store, projectId, { threshold });

const quorum = new Quorum({ projectId, store, index: rebuilt.index });

const server = createApiServer({
  quorum,
  now: () => new Date(),
  ...(Number.isFinite(rateLimit) && rateLimit > 0
    ? { rateLimiter: createRateLimiter({ limit: rateLimit, windowMs: rateWindowMs }) }
    : {}),
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
  console.log(
    `  clusters  ${String(rebuilt.clusters)} from ${String(rebuilt.submissions)} submissions, ` +
      `assigned on write (threshold ${String(threshold)})`,
  );
  console.log(`  auth      ${projectKey === undefined ? 'open — set QUORUM_PROJECT_KEY to require one' : 'project key required'}`);
  console.log(
    `  writes    ${
      Number.isFinite(rateLimit) && rateLimit > 0
        ? `${String(rateLimit)} per ${String(Math.round(rateWindowMs / 1000))}s per address`
        : 'unlimited — QUORUM_RATE_LIMIT=0'
    }`,
  );
  console.log('\n  POST /v0/ingest          GET /v0/issues');
  console.log('  GET  /v0/issues/:id      GET /v0/issues/:id/submissions');
  console.log('  GET  /v0/health\n');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
