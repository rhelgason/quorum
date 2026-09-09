# @quorum/web

The `<quorum-nub>` custom element for [Quorum](../../README.md), and the
browser client behind it. Shadow DOM, three presets, CSS custom property
theming. Zero runtime dependencies.

> ### Status: written, wired, and testable in a real browser — but not yet run in one here
>
> The pure modules — attribute parsing, presets and stylesheet generation,
> shortcut matching, panel copy, the client, storage adapters — are tested
> (107 tests).
>
> `nub.ts` now has a browser suite: 20 tests that drive an installed Chrome
> over CDP and cover every line of the old "what is not verified" list. **They
> have not been executed in the authoring environment**, because Chrome cannot
> launch from it — a macOS Mach bootstrap denial, unrelated to Quorum, that
> stops the browser before it prints a DevTools endpoint. On a normal machine:
>
> ```bash
> npm run test:browser
> ```
>
> What *has* been verified without a browser: every module the browser would
> load resolves, type-strips clean, and imports no Node builtin
> (`examples/saas-app/graph.test.ts`), and the whole write path works end to
> end against the real HTTP service (`services/api/src/roundtrip.test.ts`).
> That is delivery and wiring, not rendering. See
> [ADR-0022](../../docs/adr/0022-verify-the-dom-layer-over-cdp.md).

## Usage

```html
<quorum-nub
  project="pk_live_a1b2c3"
  version="4.12.0"
  preset="soft"
  position="bottom-right"
  label="Feedback"
  shortcut="mod+shift+k"
></quorum-nub>
```

```ts
import { defineQuorumNub } from '@quorum/web'
defineQuorumNub()
```

Importing the module does **not** register the element. A library that
registers a global custom element as an import side effect is unusable inside
anything doing its own bundling.

| Attribute | Default | Notes |
| --- | --- | --- |
| `project` | — | Required. Without it the element renders nothing. |
| `endpoint` | same-origin | Ingest origin. Must be an absolute `http(s)` origin; a relative value would resolve against whatever page it is on. |
| `version` | — | The host app's version. A structural clustering signal, not diagnostics. |
| `kind` | `feature_request` | The default flow asks what you'd *change*. Bugs are one path through it, not the entry point ([ADR-0012](../../docs/adr/0012-prioritization-is-the-product.md)). |
| `preset` | `soft` | `minimal` · `soft` · `sharp` |
| `position` | `bottom-right` | Four corners, or `hidden` to bring your own trigger |
| `offset` | `24` | Pixels from the edge. Clamped to 0–200. |
| `label` | `Feedback` | |
| `shortcut` | `mod+shift+k` | `off` disables. `mod` is ⌘ on macOS, Ctrl elsewhere. |
| `frustration` | `detect` | `off` · `detect` (silent) · `prompt` (nudges) |
| `picker` | `on` | |
| `replay` | `off` | Off deliberately ([ADR-0007](../../docs/adr/0007-redact-by-default.md)) |

## Identity

One call, and it is the one that makes ranking revenue-weighted rather than a
head count ([ADR-0015](../../docs/adr/0015-log-scaled-account-weight.md)):

```js
document.querySelector('quorum-nub').identify('cust_027', {
  plan: 'enterprise',
  mrr: 9400,
})
```

`mrr` is the trait ranking reads. Everything else rides along for whoever is
reading the evidence later. Call `reset()` on logout.

Calling `identify()` before the element has built its client is safe — it is
held and replayed. A host calling it from its own bootstrap routinely beats
the first submission, and dropping that call would silently cost account weight
on everything until the next login.

Identity is **not** applied retroactively to queued events. Rewriting them
would let an offline flush attribute a submission to whoever happened to log in
afterwards.

## Events

All composed, so a host listens on `document` rather than reaching into the
shadow root:

```js
document.addEventListener('quorum:submit', (e) => e.detail.id)
document.addEventListener('quorum:queued', (e) => e.detail.queueDepth)
```

`quorum:submitrequest` is **cancelable**, and that is the extension point: call
`preventDefault()` and the built-in transport stays out of the way, so a host
can send submissions through its own backend. Do nothing and the widget works,
which is the case that has to be effortless.

## What happens on submit

Redact → persist → send, in that order, each for a reason:

1. **Redact first**, so a secret is never at rest even in `localStorage`
   ([ADR-0007](../../docs/adr/0007-redact-by-default.md)). The rules are
   `@quorum/core`'s, not a copy — a second list would drift, and the failure
   mode of drifting redaction rules is a secret in someone's database.
2. **Persist before any network attempt**, so closing the tab mid-submit cannot
   lose the submission.
3. **Send**, and let the transport implement the protocol's error table.

Three outcomes, three different things to say:

| Outcome | Panel says | Why it matters |
| --- | --- | --- |
| `accepted` | Thanks — that's logged. | |
| `queued` | Saved — we'll send it when you're back online. | **Not an error.** The event is durable and flushes on the `online` event. |
| `failed` | That didn't send. Your text is still here. | Permanent rejection, or a project key ingest refused. The draft survives for retry. |

A rejected project key reports `failed`, not `queued`, even though the event is
still sitting in the queue — a `401` disables the transport for the session, so
it is never going out, and "we'll send it when you're back online" would be a
lie told to someone whose feedback is going nowhere.

## Theming

CSS custom properties and `::part()`, never a theme object
([ADR-0004](../../docs/adr/0004-css-custom-properties-for-theming.md)):

```css
quorum-nub {
  --quorum-accent: #7c3aed;
  --quorum-radius: 12px;
}
quorum-nub::part(trigger) { letter-spacing: 0.02em; }
```

Tokens are declared on `:host`, so a rule on the element from the page wins
over our defaults. That is why they aren't set inline — and it is one of the
things the browser suite asserts.

There is no `auto` preset. Sampling the host's design language produces
something that looks *almost* right, which is worse than something that clearly
belongs to a different tool.

## Design notes

**Nothing in attribute parsing throws.** This is a third-party script tag on
someone else's checkout flow. A typo falls back to the default and logs a
warning; failing loudly is a luxury we don't have.

**Booleans are `on`/`off`, not presence.** HTML's convention would make
`replay="off"` mean *enabled*, since the attribute is present. Silently turning
on a session recorder someone tried to disable is the wrong direction to be
wrong in.

**Shortcut modifiers match exactly, not as a subset.** Permissive matching is
how two widgets on one page end up fighting over a keystroke. Keystrokes are
also ignored while the user is typing in an input, textarea, select, or
contenteditable.

**Importing is safe without a DOM.** The element class is built on first call
to `nubClass()` rather than at module scope, because `class extends
HTMLElement` dereferences `HTMLElement` at evaluation time — which throws a
`ReferenceError` in every SSR framework that imports client modules on the
server. `defineQuorumNub()` is an inert no-op where there's no `customElements`
registry.

**`localStorage` is never touched at import or connect time.** The client is
built on first need — the first `identify()`, the first submission, or a read
of `.client` — so a page that merely carries the tag touches no storage at all.
Every access is then wrapped: Safari in private mode threw on write for years,
a partitioned third-party frame throws on *access*, and a full quota throws on
the write that fills it. All three degrade to "keep working, lose durability".

**The anonymous id is stable or absent, never fresh.** A new id per submission
would turn unique-user ranking into submission counting with nothing failing
anywhere ([ADR-0020](../../docs/adr/0020-identity-is-never-guessed.md)). Where
there is nowhere to persist one, none is sent — ingest can bucket unattributed
submissions honestly, but it cannot un-inflate a user count.

## Size

```bash
npm run size
```

**12.2KB gzipped against the 15KB budget**, for core + nub together. That
number is an upper bound: no minification, no mangling, no tree shaking. See
[`tools/size`](../../tools/README.md#size--the-15kb-budget) for what it does
and does not mean.

## Still not built

The element picker, frustration detection, DOM capture, and the console and
network ring buffers. All four attach to the `captureRef` field the client
currently leaves empty, and all four are v0.2/v0.3.

Cross-browser coverage. The browser suite drives whatever Chromium-family
browser is installed — no pinned version, no Firefox, no WebKit.
