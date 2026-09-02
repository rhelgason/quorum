# Quorum — Privacy & Capture Safety

> Status: design. This document is a set of constraints, not aspirations.
> Where it says "must", CI or code review should enforce it.

## Why this is a first-order concern

Quorum captures DOM snapshots, console output, network logs, and screenshots
from inside production applications. That machinery hoovers up PII by default
unless deliberately stopped. **The first customer who finds a credit card
number in a stored DOM snapshot is the last customer.**

It is also, empirically, the part of this product that will consume more
engineering time than the clustering and LLM work combined. Budget for it as a
feature, not as hardening at the end.

## The rule

**Redact by default. Unmask by allowlist. Never the reverse.**

A capture pipeline that is safe only when correctly configured is unsafe,
because it will be misconfigured. See
[ADR-0007](adr/0007-redact-by-default.md).

## Web defaults (all on, no configuration required)

| Target | Default |
| --- | --- |
| `<input>`, `<textarea>`, `<select>` values | masked to `•` of equal length |
| `<input type="password">` | value dropped entirely, not masked |
| `contenteditable` text | masked |
| Attributes `value`, `placeholder`, `alt`, `title` | masked |
| `<img>` / `<canvas>` / `<video>` content | replaced with a dimension placeholder |
| Request/response **bodies** in the network log | dropped; method, URL path, status, and duration kept |
| Query strings and URL fragments | stripped of values, keys retained |
| `Authorization`, `Cookie`, `Set-Cookie` headers | dropped |
| `document.cookie`, `localStorage`, `sessionStorage` | never read |
| Console arguments | pattern-scanned (see below) before buffering |

### Opt-outs and opt-ins

```html
<!-- nuke an entire subtree from any capture -->
<div data-quorum-redact>...</div>

<!-- explicitly allow a field to be captured in the clear -->
<input data-quorum-unmask name="search-query">

<!-- block the element picker from targeting this -->
<div data-quorum-ignore>...</div>
```

Config-level equivalents (`redact.selectors`, `unmask.selectors`) exist for
teams that can't touch markup, but the attribute form is preferred because it
lives next to the sensitive field and survives refactors.

### Pattern scanning

On-device regex sweep over captured text and console args, before anything is
serialized: credit-card-shaped digit runs (with Luhn check to cut false
positives), common national ID formats, email addresses, bearer/JWT-shaped
tokens, `sk_live`/`pk_live`-style API key prefixes, and IBAN-shaped strings.

Matches are replaced with `[redacted:card]`, `[redacted:email]`, etc. — typed,
so a developer looking at a capture knows *something was there* and what kind.
Silent removal makes debugging captures maddening.

This is a net, not a guarantee. It is the last line, after structural
redaction, not a substitute for it.

## Mobile defaults

Screenshots are the hard case — there's no DOM to walk.

- **iOS**: `UITextField.isSecureTextEntry` fields are excluded by the OS-level
  snapshot path; additionally, any view tagged `quorumRedact` is filled with an
  opaque rect before the snapshot is taken, and `UITextField`/`UITextView`
  contents are blurred by default.
- **Android**: views flagged `FLAG_SECURE`, plus anything tagged
  `R.id.quorum_redact`, are masked pre-capture. `EditText` contents blurred by
  default.
- Redaction happens **before the image buffer leaves the process.** There is no
  moment where an unredacted screenshot exists in memory that could be written
  to disk by the offline queue.

## Server-side posture

- Ingest re-runs pattern scanning. Client-side redaction can be defeated by a
  stale SDK; the server is the backstop, and it logs (without content) when it
  catches something the client should have, so we can find bad SDK versions.
- Captures live in a separate table with an independent `retention_until`
  clock. A customer can keep feedback text forever and drop captures at 30
  days — which is what they will ask for.
- Deletion is real deletion, including from object storage and any derived
  embedding, and it must cascade from an end-user erasure request.

## What we owe enterprise buyers

These are the objections that kill deals in this category, and each has a
concrete answer:

| Objection | Answer |
| --- | --- |
| "We can't send customer feedback to a third-party LLM." | BYO-model. The LLM sits at the render edge and is optional; the product degrades to medoid labels. Self-host runs a local model or none. |
| "Our data can't leave the EU." | Data residency per project; self-host as the ultimate answer. |
| "We need to prove what you collect." | Capture policy is declarative and inspectable, and `redaction.rules` ships on every envelope, so an audit can see what was applied. |
| "Our users must be able to be forgotten." | End-user erasure cascades to submissions, captures, embeddings, and cluster membership. Cluster centroids are recomputed from the running sum by subtraction. |
| "We don't want a session recorder in prod." | Replay is opt-in and off by default. The default capture is a single snapshot. |

## Non-goals, stated plainly

- Quorum does not do fingerprinting or cross-site tracking. Anonymous IDs are
  first-party, per-project, and trivially clearable — that's a feature.
- Quorum does not capture keystrokes, clipboard, or continuous audio/video.
- Quorum does not use `getDisplayMedia`. Beyond the conversion problem
  ([ADR-0006](adr/0006-dom-serialization-over-screen-capture.md)), it captures
  whatever else is on screen, including other applications. That is not a risk
  we are willing to carry on a customer's behalf.

## Open questions

- Should pattern scanning be tunable per project? Customers with unusual
  identifier formats will want it; every knob is also a way to turn safety off.
- Do we ever store an unredacted capture behind an explicit, logged,
  per-incident customer opt-in for a hard debugging case? Leaning no.
- How do we handle a customer whose app legitimately displays other users' PII
  (e.g. a healthcare admin console)? Possibly a project-level "capture text
  never" mode: structure and interaction only.
