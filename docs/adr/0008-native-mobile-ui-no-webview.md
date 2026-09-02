# 0008 — Native mobile UI, no webview

**Status:** Accepted · 2026-09-02

## Context

We're already building a polished web widget. The tempting reuse: wrap it in a
webview and ship the same UI on iOS and Android for near-zero incremental cost.

## Decision

Native UI on mobile — SwiftUI on iOS, Compose on Android. Share the protocol
and the state machine, not the rendering.

## Consequences

- **A webview modal feels wrong on a phone.** Scroll physics, keyboard
  handling, safe areas, haptics, system font scaling, and the back gesture are
  all subtly off, and users notice even when they can't name why. A feedback
  widget that feels cheap gets fewer submissions, which is the only thing it
  exists to produce.
- **Rage shake needs native accelerometer access anyway.** The SDK is already
  native; the webview only saves the panel UI, which is the small part.
- **Screenshot redaction must happen in-process, before the image buffer is
  written anywhere** ([0007](0007-redact-by-default.md)). Routing capture
  through a webview adds a boundary at exactly the wrong place.
- Cost: two more UI codebases, two more release processes, two more OS-version
  churn treadmills. This is real, and it's why iOS ships in v0.6 and Android
  waits for iOS to prove the shape.
- Consistency across platforms comes from the shared state machine in
  `@quorum/core`'s protocol — same states, same fields, same events — rather
  than from shared pixels.

## Reversal cost

Low, in the sense that a webview fallback could be added for React
Native/Flutter if the native path proves too expensive to maintain. But doing
so for first-party iOS/Android would visibly cheapen the product.

## What would change our mind

If cross-platform demand (React Native, Flutter) dominates native demand, a
shared-webview panel for *those* runtimes only — with native shake detection
and native screenshot redaction still outside the webview — is a reasonable
compromise. It is not one we'd make for first-party SDKs.
