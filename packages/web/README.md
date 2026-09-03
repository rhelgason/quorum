# @quorum/web

The `<quorum-nub>` custom element for [Quorum](../../README.md). Shadow DOM,
three presets, CSS custom property theming. Zero runtime dependencies.

> ### Status: written, and the DOM layer is unverified
>
> The pure modules — attribute parsing, presets and stylesheet generation,
> shortcut matching, panel copy — are fully tested (73 tests, 100% coverage).
>
> **`nub.ts` itself has never run.** There is no DOM, no browser test runner,
> and no bundler in the environment this was authored in, so the element has
> not been rendered once. It is excluded from the coverage gate, the way
> `cli.ts` is, and unlike `cli.ts` it is substantial enough that you should
> treat it as a draft until someone runs it in a browser. See
> [What is not verified](#what-is-not-verified).

## Usage

```html
<quorum-nub
  project="pk_live_a1b2c3"
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
| `kind` | `feature_request` | The default flow asks what you'd *change*. Bugs are one path through it, not the entry point ([ADR-0012](../../docs/adr/0012-prioritization-is-the-product.md)). |
| `preset` | `soft` | `minimal` · `soft` · `sharp` |
| `position` | `bottom-right` | Four corners, or `hidden` to bring your own trigger |
| `offset` | `24` | Pixels from the edge. Clamped to 0–200. |
| `label` | `Feedback` | |
| `shortcut` | `mod+shift+k` | `off` disables. `mod` is ⌘ on macOS, Ctrl elsewhere. |
| `frustration` | `detect` | `off` · `detect` (silent) · `prompt` (nudges) |
| `picker` | `on` | |
| `replay` | `off` | Off deliberately ([ADR-0007](../../docs/adr/0007-redact-by-default.md)) |

Events bubble out of the shadow root, composed:

```js
document.addEventListener('quorum:submit', (e) => e.detail.id)
document.addEventListener('quorum:queued', (e) => e.detail.queueDepth)
```

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
over our defaults. That is why they aren't set inline.

There is no `auto` preset. Sampling the host's design language produces
something that looks *almost* right, which is worse than something that
clearly belongs to a different tool.

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
server. `defineQuorumNub()` is an inert no-op where there's no
`customElements` registry. This one *is* tested (`ssr.test.ts`).

## What is not verified

Everything below needs a browser and has never been executed:

- Rendering, shadow root attachment, and the stylesheet actually applying
- Event wiring: clicks, input, and the composed re-dispatch of core events
- The keyboard listener being attached and cleaned up on disconnect
- `attributeChangedCallback` re-render behaviour
- Focus management and screen-reader behaviour beyond the roles being set
- **The 15KB gzipped budget.** No bundler here, so it is unmeasured. The `size`
  CI job is still `if: false`.

What's needed: a browser test runner (`@web/test-runner` or Playwright) and a
bundler for the size gate. Both are one `npm install` away from a machine with
registry access, and neither can be faked convincingly — a hand-written DOM
shim would give false confidence, which is worse than an honest gap.

Also not built yet: the element picker, frustration detection, DOM capture, and
the transport wiring that would make `quorum:submitrequest` actually send. The
element drives `PanelMachine` correctly but nothing is connected to ingest —
`@quorum/core`'s `Transport` and `OfflineQueue` exist and are tested, they are
simply not plumbed in here.
