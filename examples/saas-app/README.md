# examples/saas-app — the whole loop, running

A fake B2B product with the widget in it, the real ingest service behind it,
and the ranked backlog it produces. Every layer is this repo's actual code;
nothing is stubbed.

```bash
npm run app     # no install required
```

```
Northwind Analytics   http://localhost:4173
Product backlog       http://localhost:4173/backlog
```

## What to try

1. **Send something.** Press <kbd>⌘⇧K</kbd> or click the nub. Then open the
   backlog. Your submission is clustered against 45 seeded support tickets —
   type something about dark mode and watch it land in the existing dark-mode
   issue rather than creating a new row.
2. **Change who you are.** The switcher in the top right calls
   `nub.identify(id, { mrr })`. File the same feedback as Priya (enterprise,
   $9,400/mo) and as Dana (free), and compare where it lands. One enterprise
   voice outranks several free ones — by a few multiples, not by orders of
   magnitude, because weighting is logarithmic
   ([ADR-0015](../../docs/adr/0015-log-scaled-account-weight.md)).
3. **Go offline.** DevTools → Network → Offline, then submit. The panel says
   *saved, we'll send it when you're back online*, because that is what
   happened — the event is durable in `localStorage` before any network attempt.
   Come back online and it flushes on the `online` event.
4. **Submit the same thing twice.** The second one is a `duplicate` in the
   ingest response and changes no score. That is what the client-generated
   ULID is for.
5. **Expand a backlog row.** Every score decomposes into unique users, weighted
   demand, mean account weight, and growth — down to the verbatim quotes. A
   ranked list you cannot interrogate is one nobody believes
   ([ADR-0012](../../docs/adr/0012-prioritization-is-the-product.md)).

## What is actually running

```
:4173  tools/devserver   the app, this repo's .ts type-stripped on the fly,
                         and a proxy for /v0/* → :8787
:8787  services/api      real ingest + read API over node:http,
                         backed by an append-only log in ./data/
```

**There is no build step.** The browser loads `packages/web/src/nub.ts` and its
real imports as ES modules; the dev server strips types per request using
Node's own stripper. Edit `nub.ts`, reload, see it. That is also why the app
proves something a bundled demo would not: the modules the browser executes are
the files in the repo.

**The page and the API share an origin**, so the widget posts to `/v0/ingest`
with no CORS configuration and no endpoint baked into the markup — which is
what a self-hosted deployment looks like. The entire integration is:

```html
<quorum-nub project="pk_demo_northwind" version="4.12.0"></quorum-nub>
```

```js
import { defineQuorumNub } from '/packages/web/src/index.ts'
defineQuorumNub()
document.querySelector('quorum-nub').identify('cust_027', { mrr: 9400 })
```

## The seeded data

45 tickets from [`../support-inbox/inbox.csv`](../support-inbox/inbox.csv),
loaded on first boot into `./data/quorum.jsonl`. Delete that file to reseed.

The timestamps are **translated forward** so the newest ticket lands on the
moment you first ran it, preserving every interval between tickets. Without
that, ranking's recency decay flattens a four-month-old corpus to nothing and
one submission you type today outranks all of it. The intervals are preserved
rather than compressed because growth is measured over fixed windows, and
squashing the timeline would invent a spike that is not in the data.

`data/` is gitignored. Nothing here writes outside this directory.

## What is not in this example

The nub renders, sends, queues, retries, and reports honestly. It does **not**
yet do element picking, DOM capture, console or network buffering, or
frustration detection — those are v0.2/v0.3 and attach to the `captureRef`
field the client currently leaves empty.

The backlog page is read-only. Merge and split review, which
[`@quorum/aggregate`](../../packages/aggregate) already computes proposals for,
has no UI.

## Tests

```bash
npm test                    # includes the two below
npm run test:browser        # needs a Chromium-family browser
```

- [`graph.test.ts`](graph.test.ts) fetches every module a browser would load
  and asserts it resolves, strips clean, and pulls in no Node builtins. It
  executes none of them — it proves delivery, not behaviour.
- [`seed.test.ts`](seed.test.ts) covers the date shift, which silently rewrites
  every timestamp the ranking reads.
- [`../../packages/web/src/nub.browser.test.ts`](../../packages/web/src/nub.browser.test.ts)
  is the one that runs the element in a real browser.
