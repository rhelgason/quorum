# 0016 — The LLM is configuration, not code; free must stay possible

**Status:** Accepted · 2026-09-03
**Refines:** [0005](0005-deterministic-core-llm-at-render-edge.md)

## Context

[ADR-0005](0005-deterministic-core-llm-at-render-edge.md) put the LLM at the
render edge and made it optional. Two further constraints came from the project
owner and are treated as requirements:

1. **It must be free during the demo phase.** Paying is acceptable later, at
   scale; it is not acceptable now.
2. **It must not require repo edits when models change.** A new Gemini release
   or a deprecated model should not mean a commit.

Constraint 2 is the harder one, and it is a real operational problem rather
than a preference: model identifiers in this category are deprecated on a
months-long cycle, and a codebase that names one accrues a permanent
maintenance tax.

## Decision

### There is no model identifier anywhere in the source tree

Not a default, not a constant, not a fallback. The model is a config string
(`QUORUM_LLM_MODEL`) passed through verbatim. Tests assert that arbitrary
strings — including deliberately invented future model names — are accepted,
so no allowlist can go stale.

`.env.example` documents providers but **prints no model names**, because
anything written there would be wrong within months. It gives a `curl` that
asks the endpoint what it currently serves.

### One adapter, not one class per vendor

The transport is the OpenAI-compatible `chat/completions` shape, which Groq,
Gemini, OpenRouter, Together, Fireworks, DeepInfra, Ollama, llama.cpp, vLLM,
and LM Studio all expose. Adding a provider is a base URL and a key in the
environment — zero code.

The alternative, a provider class per vendor, means tracking every vendor's SDK
churn forever. Rejected. When a vendor lacks a compatible endpoint, the answer
is a gateway in front of it, not a new class in this repo.

### Model deprecation produces an actionable error

When a request 404s, the provider calls the endpoint's `/models` and reports
what it actually offers:

```
groq request failed with 404. Model 'retired-model' may be unavailable.
Endpoint offers: model-a, model-b, model-c
```

That turns the most likely long-lived-deployment failure from "read the
vendor's changelog" into "copy one of these strings into `.env`".

### The default is `none`, and it fails closed

With no configuration, `providerFromEnv()` returns `nullProvider` and the
product renders medoid labels. A *partial* configuration — provider set but no
model, say — also returns `nullProvider` rather than throwing. Failing closed
matters twice over: a misconfigured deployment degrades quietly instead of
erroring on every render, and an unset environment can never accidentally start
spending money.

### Free tiers, in preference order

1. **Local (Ollama, llama.cpp, LM Studio)** — no key, no account, no limits,
   nothing leaves the machine. Also the strongest answer to the enterprise
   objection in [ADR-0005](0005-deterministic-core-llm-at-render-edge.md), so
   it is listed first on merit, not just on price.
2. **Hosted free tiers** (Groq, Gemini, OpenRouter) — zero cost, rate limited.
   Fine for a demo, and the render cache means spend scales with cluster
   *change* rather than dashboard traffic.
3. **Paid** — never a default, always explicit.

## Consequences

- **No test or CI job ever makes a network call.** Every LLM test injects a
  fake `fetch`. The suite runs offline, free, and fast, and cannot be broken by
  a vendor outage.
- The abstraction is thin by design: `generate()` and an optional
  `listModels()`. No streaming, tool-calling, or structured output yet — the
  render edge needs one prompt in, one spec out, and speculative surface area
  would be surface area to maintain.
- Temperature defaults to 0. Generated specs are cached against a cluster
  composition hash, so they must be reproducible.
- The served model is echoed back from the response and included in the render
  cache key, so a silent provider-side model swap invalidates cached specs
  rather than leaving stale ones attributed to the wrong model.
- Cost: OpenAI-compatibility is a lowest common denominator. Provider-specific
  features are unreachable without an escape hatch. Accepted — the `LlmProvider`
  interface is public, so a bespoke provider can be supplied by a caller
  without changing this package.

## Reversal cost

Low. `LlmProvider` is a two-method interface.

## What would change our mind

A provider worth using that has no OpenAI-compatible endpoint and no viable
gateway. Even then, prefer a second adapter over abandoning the pattern —
and still no model names in code.
