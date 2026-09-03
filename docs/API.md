# Quorum — Public API Surface

> Status: design, unimplemented. This is the target the packages get built
> toward. Types here should end up mirrored in `packages/core/src/types`.

Guiding constraint: **the five-minute integration must be one line, and the
five-hour integration must not require forking us.** Everything below is
either the one line or an escape hatch.

---

## The one line

```html
<script src="https://cdn.quorum.dev/v0/quorum.js" data-project="pk_live_a1b2c3" defer></script>
```

That gives you the nub, the keyboard shortcut, frustration detection, the
element picker, redaction, and the offline queue. No build step, no framework.
Works in Rails, Django, WordPress, static HTML.

---

## L2 — `@quorum/web` (the custom element)

```html
<quorum-nub
  project="pk_live_a1b2c3"
  preset="soft"           <!-- minimal | soft | sharp | auto -->
  position="bottom-right" <!-- ... | hidden -->
  offset="24"
  label="Feedback"
  shortcut="mod+shift+k"
  frustration="prompt"    <!-- off | detect | prompt -->
  picker="on"
  replay="off"
  locale="en"
></quorum-nub>
```

| Attribute | Default | Notes |
| --- | --- | --- |
| `project` | — | Required. Public key. |
| `kind` | `feature_request` | Default flow asks what the user would change. Reporting something broken is one path through it, not the entry point. |
| `preset` | `soft` | `auto` samples host styles; opt-in only, never default |
| `position` | `bottom-right` | `hidden` renders nothing — bring your own trigger |
| `frustration` | `detect` | `detect` records signals silently; `prompt` also nudges |
| `picker` | `on` | Element picker in the bug flow |
| `replay` | `off` | Last ~15s session replay. Off by default, deliberately. |

Events bubble out of the shadow root, composed:

```js
document.addEventListener('quorum:open',    e => {})
document.addEventListener('quorum:submit',  e => e.detail.id)
document.addEventListener('quorum:error',   e => {})
document.addEventListener('quorum:frustration', e => e.detail.score)
```

Theming is CSS custom properties + `::part()`; see
[ARCHITECTURE.md](ARCHITECTURE.md#theming-tokens-not-a-props-api). There is no
theme object, on purpose.

---

## L0 — `@quorum/core` (headless)

```ts
import { createQuorum } from '@quorum/core'

const quorum = createQuorum({
  project: 'pk_live_a1b2c3',
  endpoint: 'https://ingest.quorum.dev',  // or your self-hosted URL
  capture: {
    dom: true,
    console: 50,
    network: true,
    replay: false,
    state: () => store.getState(),         // your snapshot hook
  },
  redact: {
    selectors: ['.pii'],
    unmask: ['#search'],
    patterns: 'default',                   // 'default' | 'off' | RegExp[]
  },
  queue: { maxEvents: 100, maxBytes: 1_000_000 },
})
```

### Methods

```ts
quorum.identify(userId, traits?)   // feeds account-weighted ranking
quorum.reset()                     // logout: relink to a fresh anon id
quorum.open(opts?)                 // programmatic entry — first-class
quorum.close()
quorum.submit(input)               // bypass UI entirely
quorum.capture()                   // snapshot now, attach later
quorum.setContext(partial)         // merged into every subsequent event
quorum.on(event, handler)
quorum.flush()                     // force-drain the queue
```

```ts
quorum.open({
  kind: 'bug',
  context: { orderId: 'A-4471' },   // app-specific, lands in context.custom
  prefill: 'Payment failed on ',
})
```

`identify()` deliberately mirrors the Segment/Intercom convention — it's the
API every frontend developer already has muscle memory for, and this is the
hook that makes ranking revenue-weighted instead of a popularity contest.
Without it we're back to counting upvotes.

### State machine

The panel is a state machine in core, not in the view. Both the web component
and native mobile drive the same states, which is how the UX stays consistent
across platforms without sharing rendering code.

```
idle → opening → composing → [picking] → capturing → submitting → done
                     ↑___________|            |
                                        queued (offline)
```

---

## L1 — `@quorum/react` (primitives)

For teams with a design system. Logic only, zero styles, zero markup opinions.

```tsx
import { QuorumProvider, useQuorum, useFrustration } from '@quorum/react'

<QuorumProvider project="pk_live_a1b2c3">
  <App />
</QuorumProvider>

function HelpMenu() {
  const { open, submit, state } = useQuorum()
  const { score, signals } = useFrustration()
  return <MyButton onClick={() => open({ kind: 'bug' })}>Report a problem</MyButton>
}
```

Also exported: `useElementPicker()`, `useCapture()`, `useIdentify()`.

The styled `<QuorumNub />` from `@quorum/react` is a ~100-line wrapper over the
custom element — prop→attribute, event→callback. We maintain one UI and N
adapters, not N UIs.

---

## L3 — `@quorum/node` (server-side ingest)

No UI, and the fastest path to value: point it at a support inbox and get a
ranked list from feedback you already have, without installing a widget. This
is also how a NestJS/Express/Fastify backend participates.

> **Implemented**, minus webhooks — see
> [`packages/node`](../packages/node/README.md). `secretKey` and `endpoint`
> arrive with the ingest service; today it is a `projectId` and a pluggable
> store.

```ts
import { Quorum } from '@quorum/node'
const quorum = new Quorum({ projectId: 'acme-web' })

// pipe a support ticket into the same canonical-issue store
await quorum.capture({
  kind: 'feature_request',
  source: 'support_inbox',
  body: ticket.body,
  user: { externalId: ticket.customerId, traits: { plan: 'enterprise', mrr: 4000 } },
  context: { route: ticket.page, appVersion: ticket.version },
})

// backend exception → bug submission, grouped by stack rather than message
await quorum.captureException(err, {
  context: { route: req.path },
  user: { externalId: req.user.id },
})

// bulk historical import — clientTs is required per row, deliberately
await quorum.import(rows, { source: 'import' })
await quorum.importCsv(csv, { source: 'support_inbox' })

// the server side of PROTOCOL.md, for SDK clients
await quorum.ingest(envelope)   // → { accepted, duplicate }

// and the ranked list
const issues = await quorum.issues({ now: new Date(), limit: 10 })
```

An unattributed record needs an explicit policy rather than a guessed identity
([ADR-0020](adr/0020-identity-is-never-guessed.md)):

```ts
await quorum.importCsv(csv, { unattributed: 'per-record' })
```

Outbound webhooks for the write-side integration (**not implemented**, v0.5):

```ts
quorum.webhooks.on('issue.ranked',  ({ issue }) => createLinearIssue(issue))
quorum.webhooks.on('issue.shipped', ({ issue }) => notifySubscribers(issue))
```

Write-side integration is the point. Don't just show a list — open the
Jira/Linear/GitHub issue with the synthesized spec, linked verbatim quotes,
affected user count, and repro data attached, then close the loop
automatically when it ships.

---

## Read API (dashboard, or your own UI)

> The HTTP surface below needs `services/api`. The **in-process equivalent is
> implemented**: `quorum.issues({ now, limit })` returns ranked issues carrying
> their score components, a one-line explanation, and the verbatim quotes
> behind each row. The HTTP layer is a serialization of it, not new logic.

```
GET  /v0/issues?sort=score&status=open&limit=20
GET  /v0/issues/:id                  → includes render + quote_refs
GET  /v0/issues/:id/submissions      → the verbatim evidence
POST /v0/issues/:id/vote
POST /v0/issues/:id/subscribe
GET  /v0/changelog
```

Every issue response carries its evidence, including the scoring components
behind its rank. A customer can build a completely custom prioritization UI on
this and never touch our components — the truly-headless promise, and the thing
that keeps sophisticated teams from bouncing off L2.

We don't ship a public end-user voting board on top of this
([ADR-0011](adr/0011-no-public-roadmap.md)), but the endpoints are here if a
customer wants to build one.

---

## Non-goals

- No `theme` object. Tokens only.
- No jQuery/AMD/UMD-era build targets. ESM plus one IIFE for the script tag.
- No React version below 18. Hooks and concurrent-safe subscriptions only.
- No client-side API secret. Public key writes; the secret key is server-only.
