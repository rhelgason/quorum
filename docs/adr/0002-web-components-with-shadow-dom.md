# 0002 — Web Components + shadow DOM, thin framework wrappers

**Status:** Accepted · 2026-09-02

## Context

Quorum must drop into React, Vue, Svelte, Angular, Rails, Django, WordPress,
and plain HTML. The obvious alternatives:

1. **One UI per framework.** Best-in-class ergonomics, N codebases, N release
   processes, N bug queues, and inevitable drift in behavior between them.
2. **iframe widget.** Perfect isolation, but it can't read the host DOM — which
   kills the element picker, DOM snapshotting, and frustration detection, i.e.
   the entire product.
3. **Plain JS + injected `<div>`.** Simple, and it will be broken by the host's
   CSS in thousands of unpredictable ways.

## Decision

One implementation as a custom element with `attachShadow({ mode: 'open' })`,
plus paper-thin per-framework wrappers (~100 lines each: prop→attribute,
event→callback).

`mode: 'open'` rather than `closed` so customers can debug and, in a pinch,
reach in. A closed root buys us nothing real — anyone determined can patch
`attachShadow` — and costs support tickets.

## Consequences

- Style isolation runs **both directions**: their CSS can't break our widget,
  ours can't break their app. For a widget landing in thousands of unknown
  codebases this is the difference between "it just works" and an unbounded
  support queue of "your button is 400px wide in my app."
- We maintain **one UI and N adapters**, not N UIs. That ratio is the whole
  argument.
- The same bundle works as a one-line `<script>` tag — a large slice of the
  market this product category serves has no build step at all.
- Costs: theming must go through custom properties and `::part()`
  ([0004](0004-css-custom-properties-for-theming.md)); SSR needs care (the
  element is client-only and must not shift layout on hydration); some older
  form-association and a11y patterns are fiddlier inside a shadow root.
- Focus management and `aria-*` references across the shadow boundary need
  explicit handling. Not hard, but not free either.

## Reversal cost

High. Every wrapper, every themed customer deployment, and the entire capture
surface assume this boundary.

## What would change our mind

Discovering that shadow DOM makes the element picker or accessible focus
handling materially worse than a plain-`<div>` approach — the picker is the
web's killer feature and we would not trade it for style isolation.
