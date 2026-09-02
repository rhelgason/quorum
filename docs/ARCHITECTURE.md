# Quorum — Architecture

> Status: design. Nothing here is load-bearing yet; it exists so the first
> packages get built against a coherent shape instead of accreting one.

## What Quorum is

A drop-in feedback layer for any app. It has three jobs, in order of how hard
they are to copy:

1. **Capture** — get high-quality, structured feedback out of a frustrated
   user with near-zero friction, on web and on mobile.
2. **Aggregate** — collapse thousands of differently-worded reports into a
   stable set of canonical issues, ranked by something better than raw votes.
3. **Close the loop** — hand engineering an actionable spec, and tell the
   users who asked when it ships.

Job 1 is the moat. A feedback API is a Postgres table; the client-side work
(frustration detection, DOM snapshotting, element picking, log ring buffers,
PII redaction, offline queueing) is what nobody wants to build themselves.
Owning the client is also how we protect job 2 — clustering quality is
downstream of capture consistency.

## System shape

```
┌─────────────────────────────── CUSTOMER APP ───────────────────────────────┐
│                                                                             │
│  web:     <script> → <quorum-nub>          mobile:  QuorumSDK (Swift/Kotlin)│
│           @quorum/react | vue | svelte              rage shake, native UI   │
│           @quorum/core   (headless)                                          │
│                                                                             │
│  server:  @quorum/node  ← support tickets, backend exceptions, CSV imports  │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │  Capture Envelope (versioned, see PROTOCOL.md)
                                 ▼
┌──────────────────────────── QUORUM BACKEND ────────────────────────────────┐
│                                                                             │
│  ingest ──► redaction gate ──► submissions (append-only, Postgres)          │
│                                     │                                       │
│                                     ▼                                       │
│                       ┌──── ONLINE TIER (per submission, <100ms) ────┐      │
│                       │  normalize → LSH block → hybrid similarity   │      │
│                       │  → leader-follower assign to canonical issue │      │
│                       └──────────────────────┬───────────────────────┘      │
│                                              ▼                              │
│                                    canonical_issues (+ centroid)            │
│                                              │                              │
│                       ┌──── OFFLINE TIER (nightly, proposes only) ───┐      │
│                       │  HDBSCAN / Leiden over kNN graph             │      │
│                       │  → merge & split proposals for human review  │      │
│                       └──────────────────────┬───────────────────────┘      │
│                                              ▼                              │
│                        deterministic ranking (weighted, see below)          │
│                                              │                              │
│                       ┌──── RENDER EDGE (optional, cached) ──────────┐      │
│                       │  LLM: canonical issue → title + eng spec     │      │
│                       │  keyed on cluster composition hash           │      │
│                       └──────────────────────┬───────────────────────┘      │
└──────────────────────────────────────────────┼──────────────────────────────┘
                                               ▼
                        dashboard · public roadmap · Jira/Linear/GitHub write-back
```

The dashed boundary matters: **everything above the render edge is
deterministic.** If the LLM is unavailable, rate-limited, or forbidden by the
customer, Quorum degrades to medoid labels and still works.

## The five layers of client integration

The tension in "works great out of the box" *and* "integrates into pretty much
any service" is resolved by layering, not by compromise. Most customers land
on L2; the existence of L1 is what stops L2 from being a dealbreaker for teams
with their own design system.

| Layer | Package | Ships | Who uses it |
| --- | --- | --- | --- |
| L0 | `@quorum/core` | Headless TS: transport, offline queue, capture, state machine. Zero runtime deps. | Everyone, transitively |
| L1 | `@quorum/react`, `/vue`, `/svelte` | Unstyled hooks and primitives | Teams with a design system |
| L2 | `@quorum/web` | `<quorum-nub>` — styled, themeable, drop-in | The default path |
| L3 | hosted portal | Public roadmap + changelog, zero code | Non-technical teams |
| L4 | `@quorum/node` | Server-side ingest, no UI | Backends (NestJS, Rails, Django) |

L4 is not an afterthought. A NestJS shop doesn't need a widget — it needs to
pipe support tickets and backend exceptions into the same canonical-issue
store so inbox text clusters alongside widget submissions.

### Why web components

One implementation, universal reach. Shadow DOM gives us style isolation in
both directions: the host's CSS can't break our widget, and ours can't break
their app. For a widget dropping into thousands of unknown codebases that is
the difference between "it just works" and an unbounded support queue. We use
`mode: 'open'` so debugging stays possible.

Framework wrappers are ~100 lines each of prop→attribute and event→callback
marshalling. We maintain one UI and N adapters, not N UIs. Same bundle also
works as a one-line `<script>` tag for Rails/Django/WordPress/static sites.

See [ADR-0002](adr/0002-web-components-with-shadow-dom.md).

### Theming: tokens, not a props API

No `theme={{...}}` object with 200 keys — unbounded API surface, versioning
nightmare, never covers the case the customer wants. Instead ~15 CSS custom
properties (which pierce shadow DOM by design) plus `::part()` for structural
overrides:

```css
quorum-nub {
  --quorum-accent:  #7c3aed;
  --quorum-radius:  12px;
  --quorum-font:    'Inter', sans-serif;
  --quorum-surface: #fff;
  --quorum-text:    #111;
  --quorum-shadow:  0 4px 24px rgb(0 0 0 / 0.12);
}
quorum-nub::part(panel) { /* full escape hatch */ }
```

Three presets (`minimal`, `soft`, `sharp`) make "a few design choices" a single
attribute. A fourth, `auto`, samples the host page's computed styles — font off
`body`, radius and accent off the nearest `<button>` — and derives tokens. It
is a stunning demo moment and it is **opt-in, never the default**, because when
it guesses wrong it looks broken rather than plain.

See [ADR-0004](adr/0004-css-custom-properties-for-theming.md).

## Entrypoints

Rage shake is one gesture because phones have one. The web doesn't need an
analogue — it needs several entrypoints, because web users have more ways to
express frustration and more contexts to report from.

| # | Entrypoint | Platform | Notes |
| --- | --- | --- | --- |
| 1 | **Bug nub** | web | Default. 32–40px corner affordance. `position="hidden"` renders nothing so customers can wire their own trigger. |
| 2 | **Keyboard shortcut** | web | `Cmd/Ctrl+Shift+K`. Invisible, costs nothing, highest value-per-line in the product. |
| 3 | **Programmatic** | all | `quorum.open({ type, context })`. What serious customers hang off their own Help menu. First-class. |
| 4 | **Text-selection annotation** | web | Select text → floating comment affordance. Kills for docs, dashboards, reports. |
| 5 | **Element picker** | web | Click the broken thing. See below. |
| 6 | **Rage shake** | mobile | Accelerometer threshold + debounce → capture. |

### The element picker is the web's killer feature

Mobile rage shake yields a PNG. The element picker yields *"the
`<CheckoutSubmitButton>` at `div.cart > form > button:nth-child(3)`, disabled,
inside `PaymentForm`."* That is a jump-to-line, not a screenshot. We read the
component name off React fiber internals / the devtools global hook where
available. It is strictly more actionable than what shake produces on mobile
and it is web-only. Lead with it.

### Frustration score — the real web analogue of rage shake

Passive, composed of cheap signals:

- **Dead clicks** — click with no DOM mutation or navigation within ~1s. The
  single strongest signal that something is broken.
- **Rage clicks** — 3+ on the same element inside 500ms
- Navigation thrash (rapid back/forward oscillation)
- Scroll oscillation (violent up-down hunting)
- Repeated validation failures on the same form field
- Hard reload mashing
- Console error / unhandled rejection spikes
- Escape mashing

**When the score crosses threshold, we do not interrupt.** The nub pulses and
gently expands: *"Something not working?"* Non-modal, dismissible, at most once
per session. A feedback tool that throws a modal at an already-frustrated user
makes them angrier, and the customer rips it out.

## Capture

**No `getDisplayMedia`.** It fires a browser screen-share permission prompt
that will destroy conversion. Non-starter. We serialize the DOM instead
(rrweb-style), which is replayable rather than flat, inspectable, diffable, and
roughly an order of magnitude smaller than a PNG. Alongside it:

- console ring buffer (last ~50 entries)
- network log via `fetch`/XHR wrapping
- optional state-snapshot hook (Redux/Zustand/etc.)
- last ~15s of session replay, customer opt-in

See [ADR-0006](adr/0006-dom-serialization-over-screen-capture.md) and
[PRIVACY.md](PRIVACY.md) — redaction is a default, not a setting.

### Bundle budget

**core + nub ≤ 15KB gzipped**, panel UI and snapshot machinery lazy-loaded on
first interaction. This is a product requirement, not an optimization.
Frontend teams reject widgets on bundle size, and "15KB" is a line on the
landing page that wins deals against heavier incumbents. CI fails the build on
regression.

## Aggregation

Full detail in [DATA-MODEL.md](DATA-MODEL.md). The shape:

**Sentence embeddings are not LLM intervention.** A ~90MB MiniLM-class model
running locally is deterministic, free, offline, and sub-millisecond. It is a
numerical similarity function. Semantic clustering with no agent in the loop is
entirely achievable; the LLM is needed only for the last mile.

1. **Normalize, then block.** MinHash/SimHash LSH over character shingles as a
   cheap first pass — catches near-duplicates for almost nothing and shrinks
   the candidate set. Character n-grams give typo tolerance free, which matters
   a lot with thumb-typed mobile feedback.
2. **Hybrid similarity.** Lexical (BM25) + semantic (embedding cosine) +
   structural. Lexical alone misses paraphrase; embeddings alone over-merge
   (they will happily fuse "dark mode" and "light mode").
3. **Structural signals may be the best ones we have.** Route/screen, app
   version, OS, device, temporal burst, co-voting. Ten rage shakes from
   `/checkout/payment` is a cluster before anyone reads a word. Feedback that
   clusters on one screen *and* one version is a regression, not a feature
   request — classifiable with zero NLP. **If we shipped only route + version +
   burst clustering and no text analysis at all, we'd have something useful.
   That is v1.**
4. **Two-tier clustering.** Online leader-follower assignment against stored
   centroids (O(1) per item, stable by construction, real-time); offline
   HDBSCAN/Leiden re-consolidation that *proposes* merges and splits for human
   approval and never auto-applies. Re-clustering from scratch each run is what
   makes a top-items list churn week to week until no PM trusts it.
   - Not k-means: k is unknown, clusters aren't spherical or equally sized, and
     there's no outlier concept — but a lot of feedback genuinely is a singleton.
   - Not naive threshold + connected components: single-linkage chains
     catastrophically. Leiden on the weighted kNN graph resists this.
5. **Deterministic ranking.**
   `score = Σ_users(account_weight × recency_decay) × growth_multiplier`
   Unique users, not submissions (kills spam and the one-guy-twenty-tickets
   problem). Growth rate, not just size — the second derivative is what a PM
   actually wants. Account weight from `identify()` is the differentiator:
   revenue-weighted beats volume-weighted, and that's what turns this from a
   nice-to-have into a budget line item.
6. **Free labels via medoid.** Pick the real submission closest to the
   centroid. Human-written, zero cost, inherently auditable. This is the
   no-LLM fallback and it is genuinely decent.

### Where the LLM is irreplaceable

The medoid gives you *"the app hurts my eyes at night."* Engineering needs
*"Implement a dark theme across settings, feed, and detail surfaces,
respecting the OS-level appearance setting."* That gap is abstraction lift +
imperative voice + spec structure. It's a generation problem, not a similarity
problem; no clustering produces it.

So the LLM sits at the render edge, called once per canonical issue, output
cached and versioned against a cluster-composition hash, regenerated only when
composition shifts past ~20%. That buys reproducible output, a clean
BYO-model/self-host story, and an auditable chain from every generated spec
back to the verbatim quotes behind it. Every AI summary drills down to the
quotes — LLM output with no drill-down gets distrusted the first time it's
subtly wrong.

See [ADR-0005](adr/0005-deterministic-core-llm-at-render-edge.md).

### The unglamorous prerequisite

Hand-label a few hundred real submissions into ground-truth clusters *before*
tuning anything, and measure with adjusted Rand index / V-measure / pairwise
F1. Every knob above — LSH threshold, lexical:semantic weighting,
leader-follower cutoff, HDBSCAN `min_cluster_size` — is unfalsifiable without
it, and threshold choice decides whether this feels magical or broken. It's the
highest-leverage day on the ML side.

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Client core | TypeScript, zero deps | Bundle budget |
| Widget | Web Components + Lit-sized runtime | One UI, N adapters |
| Backend | TypeScript (ingest/API) | Shares protocol types with the SDK |
| Aggregation | Python | The ML ecosystem lives there |
| Store | Postgres + pgvector | Already need Postgres; don't add a second datastore |
| Embeddings | local sentence-transformer | Deterministic, offline, free |
| Offline clustering | HDBSCAN, Leiden as alternate | No k, handles density, labels noise |
| Keyphrases | spaCy | Noun-phrase → tag lattice |
| LSH | datasketch | Blocking |

Everything except the final spec rendering runs on CPU with no external API call.

## Scope discipline

Web components + four framework wrappers + native iOS + native Android + React
Native + Flutter + hosted portal is a staggering surface for a small team, each
with its own release process and OS-version churn. **This is the single most
likely way Quorum dies.**

v1 is **web components + React wrapper + native iOS**. Full stop. That proves
both the nub and the shake and is demoable. Everything else waits on actual
customer demand — and open-core helps here, because thin framework wrappers are
exactly the contribution outside developers will submit themselves.

Mobile UI is written natively, not in a webview. A webview modal feels wrong on
a phone and shake needs native accelerometer access regardless. It costs more
and it's the right call. See [ADR-0008](adr/0008-native-mobile-ui-no-webview.md).

## Open questions

- npm scope `@quorum/*` availability is **unverified** — no network at time of
  writing. Fallbacks: `@quorumhq/*`, `@usequorum/*`, `quorum-sdk`.
- Self-host packaging: single Docker Compose, or Helm chart too?
- Does the hosted public roadmap (L3) belong in v1, or is it a distraction from
  the capture wedge?
- Anonymous identity: first-party `localStorage` ID is trivially cleared. Do we
  care enough to do anything smarter, given the privacy posture?
