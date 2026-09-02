# 0006 — Serialize the DOM instead of capturing the screen

**Status:** Accepted · 2026-09-02

## Context

A bug report needs visual evidence. On the web there are three ways to get it:

1. `navigator.mediaDevices.getDisplayMedia()` — true pixels
2. `html2canvas`-style DOM→canvas rasterization
3. DOM serialization (rrweb-style) — a replayable snapshot

## Decision

DOM serialization. `getDisplayMedia` is a non-starter.

## Consequences

**Why not `getDisplayMedia`:** it fires a browser screen-share permission
prompt. A user who is already frustrated, mid-bug-report, being asked to grant
screen sharing will abandon — this destroys conversion, which is the only
metric that matters for a feedback widget. It also captures whatever else is on
their screen, including other applications, which is a liability we are not
willing to carry on a customer's behalf ([PRIVACY.md](../PRIVACY.md)).

**Why not html2canvas:** slow on large pages, notoriously wrong on transforms,
shadow DOM, iframes, and web fonts, and it produces a flat image with all the
same drawbacks as pixels.

**What serialization buys:**

- **Replayable, not flat.** An engineer can open devtools on the snapshot,
  inspect the element, and read computed styles. This is qualitatively better
  evidence than a PNG.
- **~10× smaller** than a screenshot, which matters for the offline queue and
  for storage cost.
- **Diffable.** Two reports of the same bug can be compared structurally.
- **Redactable at the right granularity.** You can mask an input's value while
  keeping its layout — impossible with pixels, where you can only black out
  rectangles. This is what makes [0007](0007-redact-by-default.md) affordable.
- Composes with the element picker: the selector captured by the picker
  resolves inside the snapshot.

**Costs:**

- Canvas and WebGL content can't be serialized meaningfully — placeholder only.
- Cross-origin iframes are opaque. Nothing to do about that.
- Fidelity is "close," not exact: fonts, external stylesheets, and
  `::before`/`::after` content need care, and pseudo-element-heavy designs will
  occasionally render subtly differently in replay.
- We depend on a serialization format (rrweb's, or a compatible one) and inherit
  its edge cases.

Mobile is the exception and takes real screenshots — there's no DOM to walk —
which is exactly why mobile redaction has to happen before the image buffer
leaves the process.

## Reversal cost

Moderate. The stored format, the replay viewer, and the redaction
implementation all assume it.

## What would change our mind

Nothing about `getDisplayMedia` — the permission prompt is disqualifying at any
fidelity. If serialization fidelity proves inadequate for a class of app
(heavy canvas/WebGL), the answer is an *optional* rasterized fallback for those
customers, not a default change.
