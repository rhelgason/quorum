# 0007 — Redact by default, unmask by allowlist

**Status:** Accepted · 2026-09-02

## Context

Quorum captures DOM snapshots, console output, network logs, and mobile
screenshots from inside production applications. Every one of those is a PII
vector. The convenient design is to capture everything and let customers
configure what to exclude — it produces better debugging data and a better demo.

## Decision

Nothing sensitive is captured unless explicitly allowed. All input values,
`contenteditable` text, image content, request/response bodies, auth headers,
and URL query values are masked or dropped by default. Customers opt *in* to
capturing a specific field with `data-quorum-unmask`.

A regex pattern scan (card numbers with Luhn check, emails, JWT/bearer tokens,
API key prefixes, national IDs, IBANs) runs on-device as a second net, before
serialization, replacing matches with typed markers like `[redacted:card]`.

## Consequences

- **A capture pipeline that is safe only when correctly configured is unsafe**,
  because it will be misconfigured. Defaults are the only setting most
  customers will ever have.
- The first customer who finds a credit card number in a stored DOM snapshot is
  the last customer. This is not a hypothetical failure mode; it's the standard
  one for this product category.
- Captures are worse out of the box. A masked form is less useful than a filled
  one, and support burden shifts to "how do I see what the user typed" —
  which is a *good* trade, because the answer is a one-line attribute the
  customer adds deliberately.
- Typed redaction markers rather than silent removal: a developer looking at a
  capture can see *something was there* and what kind. Silent removal makes
  captures maddening to debug.
- Server-side re-scan as a backstop against stale SDKs, logging (without
  content) when it catches something the client should have — that's how we
  find bad SDK versions in the wild.
- This work will consume more engineering time than the clustering and LLM work
  combined. It is a feature with a budget, not end-of-project hardening.

## Reversal cost

Effectively infinite in the unsafe direction. Loosening a default that has
already shipped means every existing deployment silently starts capturing more
than it did yesterday — that is a breach, not a release.

## What would change our mind

Nothing about the default. The tunable question is whether *pattern scanning*
becomes per-project configurable: customers with unusual identifier formats
will want it, and every knob is also a way to turn safety off. Leaning toward
allowing additions but never subtractions.
