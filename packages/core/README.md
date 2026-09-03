# @quorum/core

Headless core for [Quorum](../../README.md). Zero runtime dependencies.

> **Status: partially implemented.** The protocol, ULID ids, the bounded
> offline queue, ingest transport, the panel state machine, redaction, and
> logging all work and are tested. DOM capture is the remaining piece — see
> [ROADMAP](../../docs/ROADMAP.md).

## What lives here

| Module | Contents |
| --- | --- |
| `protocol.ts` | The wire contract — envelope, event blocks, capture payload, ingest responses |
| `ulid.ts` | Time-sortable, monotonic event ids that double as idempotency keys |
| `queue.ts` | Bounded, durable offline queue; drops captures before envelopes |
| `transport.ts` | Ingest transport implementing PROTOCOL.md's error table, with jittered backoff |
| `redact.ts` | PII pattern scanning |
| `log.ts` | Structured logging and the console ring buffer |
| `panel.ts` | The panel state machine — one flow, driven by web and native alike |
| `emitter.ts` | Typed event emitter behind `quorum.on()`; isolates throwing handlers |
| `config.ts` | `QuorumConfig` and friends. Every default is the safe default. |
| `state.ts` | Panel state and the public event map |

## Why the protocol lives in core

It's the one contract shared by the web component, the framework wrappers, the
native iOS and Android SDKs, the server-side ingest package, and the backend.
Versioning it independently of any package means an old client in the wild
stays valid: changes are additive-only within a major.

The state machine is here for the same reason. Both `@quorum/web` and the
native mobile UIs drive the same states, which is how the flow stays consistent
across platforms without sharing rendering code.

## The 15KB budget

Core plus the nub must stay under 15KB gzipped, with the panel UI and snapshot
machinery lazy-loaded on first interaction. That's a product requirement, not
an optimization — frontend teams reject widgets on bundle size. Adding a
runtime dependency to this package needs a very good reason.
