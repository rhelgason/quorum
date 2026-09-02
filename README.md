<div align="center">

# Quorum

**A drop-in feedback layer for any app — capture what users want, cluster it, and hand engineering a spec.**

*enough voices to make a decision legitimate*

</div>

---

> ### ⚠️ Status: design phase
>
> **Nothing is implemented yet.** This repository currently contains the
> architecture, the data model, the wire protocol, and the decision records
> that the first packages will be built against. Code examples below describe
> the target API, not working software.
>
> Follow [`docs/ROADMAP.md`](docs/ROADMAP.md) for what's actually shipping.

---

## What it does

Three jobs, in order of how hard they are to copy:

**1. Capture** — get structured feedback out of a frustrated user with near-zero
friction. A corner nub, a keyboard shortcut, an element picker that tells you
*which component* is broken, and rage-shake on mobile. Plus passive frustration
detection that notices dead clicks and reload-mashing without ever throwing a
modal at someone who's already annoyed.

**2. Aggregate** — collapse thousands of differently-worded reports into a
stable set of canonical issues. "Add dark mode," "the app hurts my eyes at
night," and "why is everything white" are one line item. Ranked by weighted
unique users and growth rate, not by whoever upvoted loudest.

**3. Close the loop** — open the Linear/Jira/GitHub issue with a synthesized
spec, the verbatim quotes behind it, the affected user count, and repro data
attached. Then tell the users who asked when it ships.

## Why not just use a feedback board

The structural openings this is built into:

- **Bug capture and roadmap aggregation in one SDK.** Feedback-board products
  are web-first and treat mobile as an afterthought; crash/bug SDKs own
  shake-to-report but don't do prioritization. Nobody is comfortably in the
  middle.
- **Weighted prioritization, not vote counts.** Raw upvotes are a popularity
  contest. Join feedback to plan tier, MRR, and retention risk and "top ticket
  items" becomes revenue-weighted — a budget line item rather than a
  nice-to-have.
- **Write-side integrations.** Don't show a list. Open the ticket.
- **Bring-your-own-model and self-host.** The clustering core is fully
  deterministic and the LLM sits at the render edge, so "we can't send customer
  feedback to a third party" stops being a dealbreaker.
- **Truly headless option.** Batteries-included widget *and* the primitives to
  build your own on our backend.
- **Evidence, not vibes.** Every generated summary drills down to the quotes
  that produced it.

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
  core/          @quorum/core   — headless TS: protocol, queue, capture, state machine
  web/           @quorum/web    — <quorum-nub> web component (planned)
  react/         @quorum/react  — hooks + wrapper (planned)
  node/          @quorum/node   — server-side ingest (planned)
services/
  api/           ingest + read API (planned)
  aggregator/    Python: embeddings, clustering, ranking (planned)
examples/        integration demos (planned)
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

The four decisions that shape everything else:

- [Ship the UI, not just the backend](docs/adr/0003-ship-the-ui-not-just-the-backend.md) — the moat is client-side
- [Web Components + shadow DOM](docs/adr/0002-web-components-with-shadow-dom.md) — one UI, N thin adapters
- [Deterministic core, LLM at the render edge](docs/adr/0005-deterministic-core-llm-at-render-edge.md) — reproducible, auditable, self-hostable
- [Redact by default](docs/adr/0007-redact-by-default.md) — a pipeline that's safe only when configured correctly is unsafe

## Constraints we hold ourselves to

- **≤15KB gzipped** for core + nub, panel and snapshot machinery lazy-loaded.
  CI fails on regression.
- **No screen-share permission prompt.** Ever. We serialize the DOM.
- **No interrupting modals** at frustration threshold.
- **The product works with the LLM turned off.** It degrades to medoid labels.
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
- Does the hosted public roadmap belong in v1, or is it a distraction?
- Self-host packaging: Docker Compose only, or a Helm chart too?

## License

MIT. See [LICENSE](LICENSE).
