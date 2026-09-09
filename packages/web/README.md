# @quorum/web

The `<quorum-nub>` custom element for [Quorum](../../README.md), and the
browser client behind it. Shadow DOM, three presets, CSS custom property
theming. Zero runtime dependencies.

> ### Status: run in a real browser, and it found things
>
> The pure modules — attribute parsing, presets and stylesheet generation,
> shortcut matching, panel copy, the client, storage adapters — are tested
> (116 tests). `nub.ts` has a **26-test browser suite** driving an installed
> Chrome over CDP ([ADR-0022](../../docs/adr/0022-verify-the-dom-layer-over-cdp.md)).
>
> ```bash
> npm run test:browser
> ```
>
> **It cannot be run in the environment this was authored in** — Chrome is
> installed and will not start (a macOS Mach bootstrap denial, unrelated to
> Quorum). It has been run elsewhere three times, and the history is the
> reason this section is worth reading:
>
> | Run | Result | What it found |
> | --- | --- | --- |
> | 1 | 1/20 | Two bugs in the CDP driver — `replMode` silently defeating `awaitPromise`, and a navigation wait that could resolve against `about:blank`. |
> | 2 | 17/20 | Two real defects in the element, plus one wrong assertion in the suite itself. |
> | 3 | 20/20 | Green. |
>
> **Six element-picker tests were added after run 3 and have never executed.**
> So: everything the suite covered as of run 3 is verified in a real browser;
> the picker's rendering and event handling are not. That is the current edge
> of what is known, and the next `npm run test:browser` moves it.
>
> What is verified without a browser: every module the browser would load
> resolves, type-strips clean, and imports no Node builtin
> (`examples/saas-app/graph.test.ts`), and the whole write path works end to
> end against the real HTTP service (`services/api/src/roundtrip.test.ts`).
> That is delivery and wiring, not rendering.

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

## What running it in a browser caught

Both of these were invisible to 900-odd passing tests, and neither is exotic.

**`kind` did nothing.** `<quorum-nub kind="bug">` parsed correctly into config
and then opened a feature-request panel — wrong prompt, wrong placeholder,
wrong `kind` on the submission, so a bug report clustered and ranked as a
feature request. The machine accepts a `defaultKind`, but it is constructed
before any attribute has been read, so the parsed value never reached it. It is
now applied per `open()`, which also means flipping the attribute takes effect
on the next open rather than the next reload.

**Typing after a failure was painted over.** The machine only accepts `retry`
from `error`, so a revision typed into the box never reached it. Sending
`retry` first fixed that and introduced something worse: the transition
re-renders the panel and replaces the textarea, and that render happens before
the edit — so the user watched the character they just typed disappear, along
with their cursor, immediately after being told their submission failed. The
input handler now completes the transition, applies the edit, re-renders once
deliberately, and restores the caret.

## The element picker

"The button doesn't work" costs an engineer twenty minutes of guessing.
`main > form.checkout > button.submit`, 240×40 at (620, 380),
`pointer-events: none` costs them nothing. That is why `docs/PROTOCOL.md` calls
this the web's killer capture: **not a screenshot but a jump-to-line.**

```js
await document.querySelector('quorum-nub').pick()
```

The panel collapses while picking — it would otherwise be covering the thing
the user is trying to point at — and the draft survives, because picking is a
detour rather than a restart. Escape cancels.

Selector durability is the whole difficulty, and the preference order is:
a test id (`data-testid` and friends, the only attribute a team has promised
not to churn), then a hand-written `id`, then tag plus hand-written classes,
then a structural path. "Hand-written" is doing real work there — `css-1x2y3z`,
`:r7:` and `Button_root__a1b2c` are rejected, because a selector built on a
generated identifier is *specific and wrong*: it resolves today, matches
nothing after the next deploy, and looks precise the entire time.

The overlay is one fixed box with `pointer-events: none` rather than an outline
on the hovered element, which would fight the host's styles and — on anything
with a layout-affecting hover rule — move the target. The selecting click is
captured and cancelled, so picking "Delete account" describes it rather than
pressing it.

## Frustration detection

The users who are actually stuck do not fill in feedback forms; they leave.
Clicking a dead button four times, reloading twice, bouncing between two pages
— those are evidence from people who will never type anything, and they are a
*ranking* input rather than telemetry.

**Behaviour, not inferred sentiment.** Nothing guesses at mood from text. A
dead click is a fact about the DOM; "seems annoyed" is a guess that would end
up weighting somebody's roadmap.

| Signal | What it takes |
| --- | --- |
| `dead_click` | A click after which nothing changed — no mutation, no navigation, no focus change, no scroll |
| `rage_click` | Three clicks on one spot within a second, counted once per burst |
| `form_error_repeat` | One form failing validation twice |
| `reload` | Each reload |
| `console_error_spike` | Three uncaught errors within five seconds |
| `nav_thrash` | Four navigations within ten seconds |
| `escape_mash` | Three Escapes within two seconds |
| `scroll_thrash` | Four direction reversals within five seconds |

Scored as `1 - exp(-Σ wᵢnᵢ)`, so it saturates: thirty dead clicks is the same
person still stuck, not ten times more upset than three.

**It never interrupts** ([ADR-0010](../../docs/adr/0010-never-interrupt-the-frustrated-user.md)).
`detect` records silently and is the default. `prompt` dispatches a
`quorum:frustrated` event at most once per session — an event, not a modal,
because only the host knows what else is on screen. Someone mashing a broken
button does not want to be asked how their day is going.

Half the test suite for this asserts what does *not* fire: a double click, a
long read, five deliberate clicks on "next page", one mistyped email. A
detector that reads ordinary use as distress is worse than none, because it
would quietly promote whichever page people use most.

## Both are loaded on demand

`import()`, not a static import. Adding them statically took core + nub from
12.2KB to 17.1KB gzipped and the CI size gate refused it — which is exactly
what the README always meant by "panel and snapshot machinery lazy-loaded".

```
gzipped     13.0KB   against a 15.0KB budget

loaded on demand, not counted against the budget:
    2.8KB  packages/web/src/frustration-dom.ts
    2.4KB  packages/web/src/picker.ts
```

## Still not built

DOM capture and the console and network ring buffers. Both attach to the
`captureRef` field the client currently leaves empty, and both need presigned
upload in the service, which does not exist yet.

Cross-browser coverage. The browser suite drives whatever Chromium-family
browser is installed — no pinned version, no Firefox, no WebKit.
