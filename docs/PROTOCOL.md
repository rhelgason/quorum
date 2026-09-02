# Quorum — Capture Protocol

> Status: design, `v0`. The wire format between every client (web, iOS,
> Android, server-side) and ingest. It is the one contract that outlives
> individual packages, so it is versioned independently of them.

## Design rules

1. **One envelope, every platform.** A web nub submission and an iOS rage shake
   differ only in which optional blocks are populated. Ingest has one parser.
2. **Additive-only within a major.** Clients in the wild are old clients.
   Removing or retyping a field is a `v1`.
3. **Redaction happens before serialization**, on-device. Ingest still
   re-checks, but the payload should never have contained the secret. See
   [PRIVACY.md](PRIVACY.md).
4. **Every block is optional except `body` or a capture.** A submission with no
   text but a rage-shake capture is valid and useful. So is text with nothing else.
5. **Structural fields are first-class, not `metadata` soup.** `route` and
   `app_version` drive clustering; burying them in a free-form bag guarantees
   inconsistent keys across customers and poisons the aggregation layer.

## Envelope

```jsonc
{
  "v": 0,
  "sent_at": "2026-09-02T22:14:03.221Z",
  "project": "pk_live_a1b2c3",          // public key, safe in client bundles
  "events": [                            // batched; offline queue may flush many
    {
      "id": "01J...",                    // ULID, client-generated → idempotency key
      "kind": "bug",                     // feature_request|bug|praise|question|rage
      "source": "picker",                // see table below
      "client_ts": "2026-09-02T22:11:58.004Z",

      "body": "the pay button does nothing when i have a promo code",

      "user": {
        "external_id": "u_8812",         // null when anonymous
        "anon_id": "qa_7f3c...",         // first-party, localStorage/Keychain
        "traits": { "plan": "pro", "mrr": 240 }
      },

      "context": {
        "route": "/checkout/payment",
        "app_version": "4.12.0",
        "sdk_version": "0.1.0",
        "platform": "web",               // web|ios|android
        "os_version": "macOS 15.2",
        "device": "MacIntel",
        "locale": "en-US",
        "viewport": [1440, 900],
        "custom": { "orderId": "A-4471" } // from quorum.open({ context })
      },

      "element": {                        // element picker only
        "selector": "div.cart > form > button:nth-child(3)",
        "bbox": [412, 688, 180, 44],
        "component": "CheckoutSubmitButton",
        "computed": { "disabled": "true", "pointer-events": "none" }
      },

      "frustration": {
        "score": 0.82,
        "signals": ["dead_click:3", "rage_click:1", "reload:2"]
      },

      "capture_ref": "cap_01J...",        // uploaded separately, see below
      "redaction": {
        "rules": ["inputs:auto", "subtree:data-quorum-redact"],
        "masked_count": 7
      }
    }
  ]
}
```

### `source` values

| Value | Platform | Meaning |
| --- | --- | --- |
| `nub` | web | Clicked the corner affordance |
| `shortcut` | web | `Cmd/Ctrl+Shift+K` |
| `picker` | web | Element picker flow |
| `selection` | web | Text-selection annotation |
| `frustration_prompt` | web | Accepted the passive "Something not working?" nudge |
| `shake` | mobile | Rage shake |
| `api` | any | `quorum.open()` / server-side `capture()` |
| `import` | server | CSV / historical backfill |
| `support_inbox` | server | Piped from Zendesk/Intercom/email |

Source is not cosmetic. `frustration_prompt` submissions have systematically
different quality than `nub` ones, and a submission from `shake` with no body
still carries a strong signal. Ranking and clustering both read it.

## Capture upload

Captures are large and slow; the envelope is small and must land immediately.
So they're decoupled:

1. Client POSTs the envelope with a `capture_ref` it generated.
2. Ingest ACKs — **the submission is durable at this point**, capture or not.
3. Client requests a presigned URL and uploads the capture blob out of band.
4. Ingest links it when it arrives; if it never arrives, nothing is lost but
   the attachment.

This ordering means a user on a flaky connection who submits and immediately
closes the tab still gets their feedback recorded. Reversing it loses the
submission to save the screenshot, which is backwards.

```jsonc
// capture blob (compressed, uploaded separately)
{
  "v": 0,
  "id": "cap_01J...",
  "dom": "<rrweb full-snapshot>",       // web
  "replay": "<rrweb incremental, ~15s>",// web, opt-in
  "screenshot": "<base64 png>",         // mobile
  "console": [{ "lvl": "error", "ts": 0, "msg": "..." }],   // ring buffer, ~50
  "network": [{ "method": "POST", "url": "...", "status": 500, "ms": 1204 }],
  "app_state": { }                       // customer-provided snapshot hook
}
```

## Idempotency & the offline queue

The client generates `id` as a ULID and persists the queue before attempting
send. Ingest treats `(project, id)` as a unique key and returns `200` on
replay. This makes the whole path safely retryable, which the offline queue
depends on — a mobile user files from a subway and the flush happens twenty
minutes later, possibly twice.

Consequences worth naming:
- `client_ts` and `received_at` can differ by **days**. Recency decay must use
  `client_ts`; burst detection must use `client_ts`. Anything keyed on
  `received_at` will misattribute a backlog flush as a spike.
- ULIDs are time-sortable, which makes them a decent ordering fallback but also
  means they leak submission time. Acceptable; they're already carrying it.
- Queue is bounded (default 100 events / 1MB) with oldest-dropped eviction, and
  it drops *captures* before it drops *envelopes*.

## Errors

| Status | Meaning | Client behavior |
| --- | --- | --- |
| `202` | Accepted | Dequeue |
| `200` | Duplicate `id` | Dequeue — this is success |
| `400` | Malformed | Dequeue and drop. Never retry-loop a poison event. |
| `401` | Bad project key | Disable the SDK for the session, log once |
| `413` | Too large | Strip capture, retry envelope alone |
| `429` | Rate limited | Honor `Retry-After`, exponential backoff + jitter |
| `5xx` | Server | Backoff and retry, capped |

The `400`-drops-permanently rule matters: a client that retries a malformed
event forever burns the user's battery and our ingest capacity, and no human
will ever notice.

## Versioning

`v` is on the envelope, not per event. Ingest supports the current major and
one behind. The version is bumped for removals and retypes only; new optional
fields ship freely. Server-side, unknown fields are preserved into
`submissions.raw` rather than dropped, so a newer client talking to an older
self-hosted ingest loses nothing permanently.
