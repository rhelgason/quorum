<div align="center">

# Quorum

**Know what's important. Quorum turns scattered user feedback into a ranked, defensible answer to "what should we build next?"**

*enough voices to make a decision legitimate*

</div>

---

> ### Status: early, partially built
>
> **Working today** (712 tests, zero runtime dependencies):
> `@quorum/core` — capture protocol, ULID idempotency keys, a durable bounded
> offline queue, ingest transport with backoff and the full error table, the
> panel state machine, PII redaction, structured logging.
> `@quorum/aggregate` — TF-IDF clustering, offline consolidation, split and
> outlier proposals, SimHash/LSH blocking, explainable ranking,
> provider-agnostic LLM and embedding layers.
> `@quorum/node` — support-inbox/CSV import, exception capture, protocol
> ingest, and the read API that turns them into a ranked list with evidence.
> `@quorum/eval` — labeled corpus, clustering and rank-agreement metrics.
> `npm run eval` prints a ranked backlog from the corpus with no LLM involved.
>
> **Not built yet:** the widget, the framework wrappers, a persistent ingest
> server, and the dashboard. `@quorum/node` stores in memory and recomputes on
> read. The web integration snippets below describe the target API, not working
> software.
>
> Follow [`docs/ROADMAP.md`](docs/ROADMAP.md) for what's shipping and
> [`docs/adr/`](docs/adr/) for why. Three roadmap assumptions have already been
> overturned by measurement rather than argument — ADRs 0013, 0014.

---

## What it does

**Not a bug tracker.** Bugs are one input among feature requests, confusion,
praise, and support tickets — they all feed one ranked answer.

**1. Aggregate and rank.** "Add dark mode," "the app hurts my eyes at night,"
and "why is everything white" are one line item. Ordered by weighted unique
users and growth rate, not by whoever upvoted loudest — and every row shows
*why* it ranks where it does, down to the verbatim quotes.

**2. Capture.** Structured input with near-zero friction: a corner nub, a
keyboard shortcut, an element picker that tells you *which component* is
broken, rage-shake on mobile, plus passive frustration detection that notices
dead clicks and reload-mashing without ever throwing a modal at someone who's
already annoyed.

Capture isn't a separate product — it's what makes the ranking trustworthy.
Route, app version, account weight, and frustration intensity are all ranking
signals a plain feedback form can't produce.

**3. Close the loop.** Open the Linear/Jira/GitHub issue with a synthesized
spec, the verbatim quotes behind it, the affected user count, and repro data
attached. Then tell the people who asked when it ships.

## See it work

You don't need to install anything — or even collect any feedback — to see
value. Point [`@quorum/node`](packages/node/README.md) at a support-inbox
export and get a ranked list out of feedback you already have:

```ts
const quorum = new Quorum({ projectId: 'acme-web' })
await quorum.importCsv(csv, { source: 'support_inbox' })

const issues = await quorum.issues({ now: new Date(), limit: 10 })
```

That's the whole integration. Run it against the bundled example export:

```bash
npm run demo        # no install required
```

```
3. Ranked backlog — top 8, as of 2026-09-01
───────────────────────────────────────────

  1. [ 22.48] dashboard is so slow to load now, it used to be instant
      10 users, 10 submissions, demand 14.99, avg weight 1.61, growth ×1.50 (6→ from 4)
      bug ×10 · /dashboard (100% of members)
      evidence:
      ▸ "dashboard is so slow to load now, it used to be instant"
          T-1033 · 2026-08-22 · support_inbox
        "Dashboard loading slow, timing out on our office wifi"
          T-1040 · 2026-08-30 · support_inbox

  2. [  7.54] dark mode, dark mode, dark mode. Please.
      9 users, 11 submissions, demand 7.54, avg weight 1.32, growth n/a (only 0 prior)
      feature_request ×11 · /dashboard (70% of members)
      evidence:
      ▸ "dark mode, dark mode, dark mode. Please."
          T-1045 · 2026-08-31 · support_inbox
        "dark mode would be amazing, please add dark mode"
          01J8Z9QK4T0000000000000001 · 2026-08-31 · nub

  3. [  5.55] Checking in on SAML SSO timing, procurement is waiting on us
      3 users, 6 submissions, demand 5.55, avg weight 2.82, growth n/a (only 0 prior)
      feature_request ×6 · /settings/security (100% of members)
```

Read what those three rows are actually saying:

- **#1 ranks on growth, not volume** — 6 unique users this week against 4 the
  week before. The second derivative is what a PM wants.
- **#2 mixes sources.** A widget submission arriving over the capture protocol
  clustered straight into the same issue as support tickets. That's the point
  of one canonical-issue store.
- **#3 reaches the top three on 3 users**, because their average account weight
  is 2.82. Revenue orders the list without dominating it.

No LLM was involved. Titles are the medoid submission — a real sentence a real
user wrote — and every number decomposes into inputs you can check.

The demo also prints what the pipeline gets *wrong* on this corpus, because a
ranked list you can't interrogate is one nobody believes. See
[`examples/support-inbox`](examples/support-inbox/README.md).

## Why not just use a feedback board

The structural openings this is built into:

- **Weighted prioritization, not vote counts.** Raw upvotes are a popularity
  contest dominated by whoever's loudest. Join feedback to plan tier, MRR, and
  retention risk and the top items become revenue-weighted.
- **Every input in one place.** Widget submissions, rage shakes, backend
  exceptions, and support-inbox text cluster together. Feedback-board products
  are web-first and treat mobile as an afterthought; crash/bug SDKs own
  shake-to-report but don't rank anything. Nobody is comfortably in the middle.
- **Evidence, not vibes.** Every ranked row and every generated summary drills
  down to the quotes that produced it. A ranked list you can't interrogate is a
  ranked list nobody believes.
- **Write-side integrations.** Don't show a list. Open the ticket.
- **Bring-your-own-model and self-host.** The clustering and ranking core is
  fully deterministic and the LLM sits at the render edge, so "we can't send
  customer feedback to a third party" stops being a dealbreaker.
- **Truly headless option.** Batteries-included widget *and* the primitives to
  build your own on our backend.

## Target integration

```html
<!-- the entire web integration -->
<script src="https://cdn.quorum.dev/v0/quorum.js" data-project="pk_live_..." defer></script>
```

```tsx
// or, with a design system of your own
import { useQuorum } from '@quorum/react'

const { open } = useQuorum()
<MyButton onClick={() => open({ kind: 'bug', context: { orderId } })} />
```

```ts
// weighted prioritization needs this one call
quorum.identify(user.id, { plan: 'enterprise', mrr: 4000 })
```

Theming is CSS custom properties, not a config object:

```css
quorum-nub { --quorum-accent: #7c3aed; --quorum-radius: 12px; }
```

## Repository layout

```
docs/            architecture, data model, protocol, privacy, ADRs
packages/
  core/          @quorum/core      — protocol, ULID, offline queue, transport, redaction, logging
  aggregate/     @quorum/aggregate — clustering, ranking, LLM provider. Zero deps.
  node/          @quorum/node      — import, exception capture, protocol ingest, ranked read API
  eval/          @quorum/eval      — metrics, labeled corpus, baselines, scoring CLI
  web/           @quorum/web    — <quorum-nub> web component (planned)
  react/         @quorum/react  — hooks + wrapper (planned)
services/
  api/           persistent ingest + HTTP read API (planned)
examples/
  support-inbox/ runnable demo — CSV in, ranked backlog out
```

Tests run on Node's built-in runner with zero dependencies:

```bash
npm test            # 712 tests, no install required
npm run demo        # import an example support inbox, print a ranked backlog
npm run eval        # clustering baselines + rank agreement against the corpus
```

## Design docs

| Doc | What's in it |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System shape, the five integration layers, entrypoints, aggregation pipeline |
| [DATA-MODEL.md](docs/DATA-MODEL.md) | Canonical-issue store, incremental centroids, ranking, render cache |
| [PROTOCOL.md](docs/PROTOCOL.md) | The capture envelope — the contract that outlives the packages |
| [API.md](docs/API.md) | Target public surface for every layer |
| [PRIVACY.md](docs/PRIVACY.md) | Redaction defaults, enterprise posture, non-goals |
| [ROADMAP.md](docs/ROADMAP.md) | Sequencing, and what's deliberately deferred |
| [adr/](docs/adr/) | Decision records — what we chose, what we gave up, what would change our mind |

The decisions that shape everything else:

- [Prioritization is the product](docs/adr/0012-prioritization-is-the-product.md) — the first session ends with a ranked list, not a feed
- [Ship the UI, not just the backend](docs/adr/0003-ship-the-ui-not-just-the-backend.md) — capture quality *is* ranking quality
- [Web Components + shadow DOM](docs/adr/0002-web-components-with-shadow-dom.md) — one UI, N thin adapters
- [Deterministic core, LLM at the render edge](docs/adr/0005-deterministic-core-llm-at-render-edge.md) — reproducible, auditable, self-hostable
- [Redact by default](docs/adr/0007-redact-by-default.md) — a pipeline that's safe only when configured correctly is unsafe
- [No public roadmap](docs/adr/0011-no-public-roadmap.md) — a voting board turns weighted ranking back into a popularity contest
- [Rank agreement is the eval target](docs/adr/0014-rank-agreement-is-the-eval-target.md) — tuning on ARI picks a measurably worse ranked list
- [Account weight is logarithmic](docs/adr/0015-log-scaled-account-weight.md) — linear MRR turns the roadmap into "what the whale wants"
- [The LLM is config, not code](docs/adr/0016-llm-is-config-not-code.md) — free by default, no model names in the repo
- [Identity is never guessed](docs/adr/0020-identity-is-never-guessed.md) — a random id per anonymous record silently turns unique-user ranking into vote counting

## Constraints we hold ourselves to

- **≤15KB gzipped** for core + nub, panel and snapshot machinery lazy-loaded.
  CI fails on regression.
- **Free by default.** No API key, no account, no spend. The LLM is off unless
  configured, and no test ever makes a network call.
- **No model identifier anywhere in the source tree.** Models are config, so a
  deprecation is an `.env` edit, not a commit.
- **Zero runtime dependencies** in `@quorum/core`. Tests use Node's built-in
  runner; there is no test framework to install either.
- **No screen-share permission prompt.** Ever. We serialize the DOM.
- **No interrupting modals** at frustration threshold.
- **The product works with the LLM turned off.** It degrades to medoid labels.
- **Every ranked row is explainable** down to the verbatim quotes.
- **Additive-only protocol changes** within a major version.

## Scope discipline

Web components + four framework wrappers + iOS + Android + React Native +
Flutter + a hosted portal is a staggering surface, each with its own release
process and OS-version churn. Spreading thin before the capture wedge is proven
is the most likely way this project dies.

**v1 is web components + React wrapper + native iOS.** Everything else waits
for someone to ask.

## Open questions

- npm scope `@quorum/*` availability is **unverified**. Fallbacks: `@quorumhq/*`,
  `@usequorum/*`, `quorum-sdk`.
- Self-host packaging: Docker Compose only, or a Helm chart too?
- Ranking depends on `account_weight`, which needs `identify()` with meaningful
  traits. What's the fallback for a team that won't wire revenue data in?

## License

MIT. See [LICENSE](LICENSE).
