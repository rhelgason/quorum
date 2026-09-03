# Quorum — Testing & Logging

## Testing

**Zero dependencies.** Node 24's built-in test runner and native TypeScript
type-stripping mean there is no framework to install and no build step before
tests run.

```bash
npm test              # node --test, discovers **/*.test.ts
npm run test:watch
npm run test:coverage # enforces line 90 / branch 85 / function 90
npm run check         # typecheck + coverage — what CI runs
npm run eval          # clustering baseline report (packages/eval)
```

CLI entrypoints are excluded from coverage (`**/cli.ts`) and kept as thin
shells over tested pure functions, so the threshold measures logic rather than
console plumbing. `packages/eval/src/cli.ts` is the pattern: it holds no logic
that `report.ts` doesn't expose and test.

That choice isn't only convenience. `@quorum/core` has a hard zero-runtime-deps
rule and a 15KB budget; keeping the dev toolchain equally spare means a
contributor can clone, run tests, and land a fix without resolving a lockfile.
It also removes a class of supply-chain risk from a package that will be
embedded in thousands of production apps.

### Typecheck needs dependencies; tests don't

`npm test` runs with an empty `node_modules`. `npm run typecheck` needs
`typescript` and `@types/node`, so run `npm install` first.

> **No committed lockfile yet.** The environment this was authored in has no
> npm registry access, so `package-lock.json` could not be generated with the
> real dependency tree and an incomplete one would break `npm ci` confusingly.
> CI uses `npm install`. First contributor with network: run `npm install`,
> commit the lockfile, re-add `cache: npm` to the CI setup step, and switch CI
> back to `npm ci`.

### Two constraints from type-stripping

Node erases types rather than compiling them, so:

- **Relative imports need a `.ts` extension.** Node will not remap `./x.js` to
  `./x.ts`. `rewriteRelativeImportExtensions` in `tsconfig.base.json` rewrites
  them to `.js` on emit, so published output is still normal ESM.
- **Only erasable syntax is allowed.** No `enum`, `namespace`, parameter
  properties, or decorators. `erasableSyntaxOnly: true` enforces this at
  typecheck time rather than letting it fail at runtime.

### What we test for

Tests are organized by *contract*, not by function. A `describe` block should
name a promise the module makes, and its tests should be the ways that promise
could break. Some of ours:

- **Behavioral invariants over examples.** `scan()` is tested for idempotency
  and for not leaking `lastIndex` between calls — bugs that no single-input
  example would catch.
- **Negative cases carry equal weight.** Half the redaction suite asserts what
  is *not* matched, because a scanner that redacts everything is useless and a
  scanner nobody trusts gets turned off.
- **Safety defaults get their own tests.** "Silent by default", "redaction on
  when no options are passed", and "a non-`true` unsafe flag still redacts" are
  each a test, because these are the properties an innocent-looking refactor
  breaks.
- **Performance contracts are asserted, not assumed.** The "cheap when
  disabled" claim is tested with a field object whose getter throws — proof
  that nothing evaluated it.
- **Determinism is injected, never mocked globally.** Clocks come in through
  `now: () => number`. No fake timers, no global patching.

## Logging

`createLogger()` in `@quorum/core`. Three properties, each forced by running
inside someone else's application:

**Silent by default.** A third-party SDK writing to a customer's console is a
support ticket. Operational failures reach the customer through the public
`error` event, which they opt into. The logger exists for people debugging
Quorum itself.

**Always redacted.** Every message and every string field goes through the same
pattern scan as captured content. Logs flow into the customer's own
observability pipeline — entirely outside our privacy controls — so a value
leaked there is unrecoverable. `unsafeDisableRedaction` exists, is named to be
uncomfortable to type and easy to grep for, and must never be set in a shipped
build.

**Cheap when disabled.** The level check precedes all formatting, redaction,
and allocation, so a suppressed `debug()` costs one integer comparison.

```ts
import { createLogger, createRingSink } from '@quorum/core'

const ring = createRingSink(50)
const log = createLogger({ level: 'debug', sink: ring, namespace: 'quorum' })

log.child('queue').warn('flush failed', { depth: 12, status: 503 })
// → { ts, level: 'warn', namespace: 'quorum:queue', message: 'flush failed',
//     fields: { depth: 12, status: 503 }, redactedCount: 0 }
```

`redactedCount` on every record is deliberate: a nonzero count in production
means PII is reaching log call sites, which is a bug to fix upstream rather
than a success to celebrate. It's a metric worth alerting on.

### Sinks

| Sink | Use |
| --- | --- |
| `noopSink` | Default. Discards. |
| `consoleSink` | Local debugging. Never installed automatically. |
| `createRingSink(n)` | Buffers the last `n` records for attaching to an error report. Contents are already redacted, since they may leave the device. |

Custom sinks are one function: `(record: LogRecord) => void`. That's the hook
for piping SDK diagnostics into a customer's existing observability stack.
