/**
 * The example app: a product with the widget in it, and the ranked backlog it
 * produces.
 *
 * ```
 * npm run app
 * ```
 *
 * Two servers, both from this repo, no install:
 *
 *  - `services/api` on `:8787` — the real ingest and read API, backed by a
 *    real append-only file store under `examples/saas-app/data/`.
 *  - `tools/devserver` on `:4173` — the app, plus this repo's TypeScript
 *    type-stripped on the fly, plus a proxy for `/v0/*`.
 *
 * The proxy is the point. The page and the API share an origin, so the widget
 * posts to `/v0/ingest` with no CORS configuration and no endpoint baked into
 * the markup — which is how a self-hosted deployment actually looks.
 *
 * Console plumbing only. Everything with a rule in it lives in `seed.ts`,
 * `services/api`, or `tools/devserver`.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { Quorum } from '../../packages/node/src/client.ts';
import { DEFAULT_ONLINE_THRESHOLD } from '../../packages/node/src/issues.ts';
import { FileStore } from '../../packages/node/src/file-store.ts';
import { rebuildIndex } from '../../packages/node/src/rebuild.ts';
import { createApiServer } from '../../services/api/src/server.ts';
import { createRateLimiter } from '../../services/api/src/rate-limit.ts';
import { createDevServer } from '../../tools/devserver/src/serve.ts';
import { seed } from './seed.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

const apiPort = Number(process.env['QUORUM_API_PORT'] ?? 8787);
const appPort = Number(process.env['QUORUM_APP_PORT'] ?? 4173);
const projectId = 'northwind';

const dataDir = join(here, 'data');
mkdirSync(dataDir, { recursive: true });
const dataPath = join(dataDir, 'quorum.jsonl');
const fresh = !existsSync(dataPath);

const store = new FileStore({ path: dataPath });
const quorum = new Quorum({ projectId, store });

// Seed once, into an empty store. Re-seeding every boot would be idempotent —
// the ticket ids collide — but the timestamps are shifted relative to "now" at
// seed time, so doing it repeatedly would leave the corpus dated from whenever
// the store was first created while pretending otherwise.
if (fresh) {
  // Northwind's own corpus — 428 submissions across 25 topics — rather than
  // the 45-row inbox `npm run demo` uses. The demo is a thirty-second read;
  // this is the one the README's figures are computed from, and the one that
  // shows the ranked list doing something a person could not do by hand.
  const result = await seed(quorum, join(here, '../northwind/feedback.csv'), { now: new Date() });
  console.log(`\n  seeded ${String(result.inserted)} support tickets into ${dataPath}`);
} else {
  console.log(`\n  using existing data in ${dataPath} (delete it to reseed)`);
}

// Rebuild the cluster index from the log, then hand the API a Quorum that
// assigns on write. Same code path as `npm run serve`, so the demo exercises
// what a self-hoster runs rather than a simplified version of it.
const { index, clusters } = await rebuildIndex(store, projectId, {
  threshold: DEFAULT_ONLINE_THRESHOLD,
});
const indexed = new Quorum({ projectId, store, index });
console.log(`  ${String(clusters)} clusters indexed on write\n`);

const api = createApiServer({
  quorum: indexed,
  now: () => new Date(),
  // The same defaults `npm run serve` uses. Far above anything a human
  // clicking a widget will reach, and present so the demo exercises the write
  // path a self-hoster actually gets rather than an unprotected version of it.
  rateLimiter: createRateLimiter({ limit: 120, windowMs: 60_000 }),
});
await new Promise<void>((ready) => api.listen(apiPort, '127.0.0.1', ready));

const app = createDevServer({
  root: join(here, 'public'),
  // The app loads this repo's real sources, unbundled and untranspiled on
  // disk. An edit to `nub.ts` is visible on reload with no build step.
  mounts: { '/packages': join(repoRoot, 'packages') },
  apiOrigin: `http://127.0.0.1:${String(apiPort)}`,
  spa: 'index.html',
});
await new Promise<void>((ready) => app.listen(appPort, '127.0.0.1', ready));

console.log(`
  Northwind Analytics   http://localhost:${String(appPort)}
  Product backlog       http://localhost:${String(appPort)}/backlog
  API (proxied)         http://127.0.0.1:${String(apiPort)}

  Try: open the app, switch user in the top right, press ⌘⇧K, send something,
  then reload the backlog. Go offline first and it queues instead.
`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close();
    api.close(() => process.exit(0));
  });
}
