# 0004 — Theme with CSS custom properties, not a props API

**Status:** Accepted · 2026-09-02

## Context

"Works out of the box with a few design choices" needs a theming story. The
common approach is a configuration object:

```js
Widget.init({ theme: { primaryColor, borderRadius, fontFamily, buttonPadding, ... } })
```

This is how most embeddable widgets do it, and it goes badly: the option list
grows without bound, every new visual detail is a breaking-ish API addition,
and it *still* never covers the specific thing the customer wants to change.

## Decision

~15 CSS custom properties for tokens, `::part()` for structural overrides, and
three named presets (`minimal`, `soft`, `sharp`) as the "few design choices."
No theme object.

```css
quorum-nub {
  --quorum-accent: #7c3aed;
  --quorum-radius: 12px;
  --quorum-font: 'Inter', sans-serif;
}
quorum-nub::part(panel) { /* anything else */ }
```

A fourth preset, `auto`, samples the host page's computed styles — font from
`body`, radius and accent from the nearest `<button>` — and derives tokens.
**Opt-in, never the default.**

## Consequences

- Custom properties pierce shadow DOM by design. This is the sanctioned
  mechanism, not a workaround, and it's the reason [0002](0002-web-components-with-shadow-dom.md)
  is affordable.
- Customers theme with CSS they already know instead of learning our schema.
  Their existing design tokens map straight across.
- Our API surface stays small and the token list is a documentable, versionable
  contract.
- `::part()` is an unbounded escape hatch, which means internal DOM structure
  becomes semi-public for any part we name. Name parts deliberately and
  sparingly — each one is a compatibility promise.
- `preset="auto"` is a stunning demo and a liability as a default: when it
  guesses wrong the widget looks *broken* rather than merely plain. Opt-in
  keeps the failure mode on the customer's terms.

## Reversal cost

Moderate. Adding a props API later is possible but we'd then maintain two
theming paths forever, which is worse than either alone.

## What would change our mind

If real customers can't achieve their design with tokens + parts and keep
forking the component, the token set is wrong — expand the tokens before
reaching for a props object.
