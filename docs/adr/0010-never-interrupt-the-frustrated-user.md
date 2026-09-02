# 0010 — Never interrupt the frustrated user

**Status:** Accepted · 2026-09-02

## Context

Quorum detects frustration passively on the web — dead clicks, rage clicks,
navigation thrash, scroll oscillation, repeated form validation failures,
reload mashing, console error spikes, escape mashing. Once you have that
signal, the obvious move is to act on it: pop a modal asking "Having trouble?"
at the exact moment the user is struggling. Submission volume would go up.

## Decision

At threshold, the nub **pulses and gently expands** — "Something not working?"
Non-modal, dismissible, focus never stolen, at most once per session. If
dismissed, the session is done nudging.

`frustration="detect"` (record signals silently, no UI) is a supported mode and
`frustration="off"` disables collection entirely.

## Consequences

- **A feedback tool that interrupts an already-frustrated user makes them
  angrier.** The submission you capture is one the customer paid for in user
  goodwill, and the customer will eventually rip the widget out — losing all
  submissions, not just that one.
- Volume will be lower than an interrupting design. This is a deliberate trade:
  we optimize for the customer keeping the widget installed for years, not for
  a good number in month one.
- The frustration signal remains valuable even when nobody responds to the
  nudge, because it's attached to *every* submission and feeds ranking. Rage
  intensity is a behavioral signal, which beats inferred sentiment.
- Once-per-session with a sticky dismissal means the detector must persist
  state across route changes in an SPA — the nub is long-lived, so this is
  cheap, but it has to be deliberate.
- Accessibility: the nudge must not move focus or trap it, and must be
  announced politely (`aria-live="polite"`) rather than assertively. An
  interruption is worse, not better, for screen reader users.

## Reversal cost

Low mechanically, high in trust. Turning the nudge into a modal is a few lines;
customers who chose us partly for this posture would notice.

## What would change our mind

Customer-configurable aggressiveness is defensible — some internal tools and
beta programs genuinely want the modal, and it's their users. If we add it, the
default stays non-modal and the aggressive mode is explicitly opt-in with the
tradeoff documented at the config site.
