# 0022 — Verify the DOM layer by driving an installed browser over CDP

**Status:** Accepted · 2026-09-09
**Refines:** [0002](0002-web-components-with-shadow-dom.md) (web components + shadow DOM)

## Context

`@quorum/web` shipped written but unrun. `nub.ts` — shadow root attachment,
event wiring, the keyboard listener, `attributeChangedCallback` — had never
executed once, and the README said so in as many words. Everything testable
without a DOM had been pushed out of it deliberately, which kept the untested
surface small but did not make it zero.

The blocker was environmental, not architectural. `registry.npmjs.org` is
unreachable from the authoring machine, so Playwright and `@web/test-runner`
could not be installed, and neither could a browser be downloaded. The stated
plan was "one `npm install` away from a machine with registry access," which is
true and had already been true for a week.

Three things turned out to be available that were not obvious:

1. **A browser was already installed.** Not downloadable, but present.
2. **Node 24 ships a global `WebSocket`.** The Chrome DevTools Protocol is
   JSON-RPC over one socket.
3. **Node 24 exposes its own type-stripper** as `stripTypeScriptTypes`. Pointed
   at a file rather than a module graph, that is a transpiler.

Together those remove both blockers: (1) and (2) give a browser runner, (3)
gives the thing standing in for a bundler.

**Writing the suite paid for itself before it ran.** Reasoning about what the
element would actually do in a browser turned up a crash that no test in this
repo could have caught: `Transport` stored `globalThis.fetch` on an options
object and called it as `this.options.fetchImpl(...)`, which passes that object
as `this`. Node's `fetch` tolerates it. Every browser throws `TypeError:
Illegal invocation` — on the first flush, in the only environment the transport
ships to. The fix is one bound wrapper; the point is that "tested" and "tested
in the environment it runs in" were measurably different things here.

## Decision

**Drive an already-installed Chromium-family browser over CDP, with a
zero-dependency client, and serve this repo's real sources to it by stripping
types on the fly.**

Three small tools, all dev-only:

- `tools/browser` — a CDP client and a `Page` with six methods: navigate,
  evaluate, wait, press, close, and read back page errors.
- `tools/devserver` — static files, `.ts` served as `text/javascript` with
  types stripped, and a proxy to the ingest API.
- `tools/size` — the 15KB budget, measured by concatenating and gzipping the
  same graph.

The browser tests **skip with a reason** when no browser is found, and
`QUORUM_BROWSER_REQUIRED=1` turns that skip into a failure. CI sets it on the
job that has a browser. Without that flag a broken launch is indistinguishable
from a machine without Chrome, and the DOM layer quietly stops being tested
again — which is the exact failure this ADR exists to end.

## What we gave up

**No selector engine, no auto-waiting, no network interception, no trace
viewer.** Tests evaluate JavaScript in the page and get JSON back. For shadow
DOM that is arguably better — reaching into a shadow root is one expression and
a whole feature in a real driver — but it means no visual debugging and no
video on failure. When that stops being enough, the answer is Playwright from a
machine with registry access, not growing `tools/browser`.

**Whatever browser the developer happens to have.** No pinned version, so a
Chrome update can change behaviour under us, and there is no Firefox or WebKit
coverage at all. For a custom element built on stable platform APIs this is an
acceptable risk; for anything touching layout it would not be.

**The size number is not a bundle.** Nothing is minified, mangled, or tree
shaken, so it is an upper bound rather than a measurement. That is stated
everywhere it is reported, because a size number without its method is a number
people quote.

**Unbundled ES modules only.** The dev server serves one request per module and
inherits the type-stripping constraints the repo already lives under —
`.ts` extensions on relative imports, erasable syntax only. Both were already
true for `node --test`.

## What this does not claim

The module-graph test in `examples/saas-app/graph.test.ts` fetches every module
a browser would load and checks that each resolves and strips clean. **It
executes none of them.** It cannot tell you whether the element renders — only
that the browser would receive all of it, and that what it received is
JavaScript. That is a genuinely weaker claim than the browser suite makes, and
the two are not interchangeable.

## What would change our mind

- **Registry access on the primary machine.** Playwright is better at this than
  anything here will be, and `tools/browser` should be deleted the day it can
  be installed. It is a workaround with a good excuse, not a design.
- **A rendering bug that ships anyway.** If a real defect gets past this
  because there is no cross-browser coverage, the answer is a hosted matrix,
  not more code here.
- **The budget getting tight.** Inside ~2KB of the limit, the upper-bound
  estimate stops being informative and a real bundler becomes necessary to say
  anything useful.
