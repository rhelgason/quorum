# tools/ — the dev toolchain, written rather than installed

Three dev-only workspaces. None of them ships, none has a dependency, and all
three exist for one reason: `registry.npmjs.org` is unreachable from the
machine this was authored on, so Playwright, a bundler, and a size checker
could not be installed. See
[ADR-0022](../docs/adr/0022-verify-the-dom-layer-over-cdp.md).

They are workarounds with a good excuse, not designs. Each one names the real
tool it stands in for, and should be deleted the day that tool can be
installed.

| Tool | Stands in for | Lines |
| --- | --- | --- |
| [`browser`](browser) | Playwright / `@web/test-runner` | ~450 |
| [`devserver`](devserver) | Vite / esbuild serve | ~250 |
| [`size`](size) | `esbuild --minify` + `gzip-size` | ~200 |

## `browser` — a CDP client

Node 24 ships a global `WebSocket`, and the Chrome DevTools Protocol is
JSON-RPC over one socket. That is the whole trick. The surface is deliberately
six methods — navigate, evaluate, wait, press, close, read errors — because
the only question this repo has is whether `<quorum-nub>` renders and responds
to a click.

```ts
const browser = await Browser.launch()          // finds an installed Chrome
const page = await browser.newPage(url)
await page.evaluate(`document.querySelector('quorum-nub').open()`)
page.assertClean()                              // throws if the page errored
```

No selector engine and no auto-waiting. For shadow DOM that is arguably an
improvement: reaching into a shadow root is one expression here and a whole
feature in a real driver.

`locateBrowser()` returns `undefined` rather than throwing when there is no
browser, because every caller turns that into a skipped test.

## `devserver` — TypeScript on the fly

Node 24 exposes its own type-stripper as `stripTypeScriptTypes`. Pointed at a
file instead of a module graph, it is a transpiler: types out, everything else
untouched, line numbers preserved because removed spans are blanked rather
than deleted.

So the browser loads the *real* module graph — `nub.ts` importing
`../../core/src/panel.ts` — with no build step and stack traces that point at
real lines in real files. It also serves static files and proxies `/v0/*` to
the ingest API, which is what lets the example app run on one origin.

Development only. No auth, no rate limiting, and it will read anything under
its root.

## `size` — the 15KB budget

Walks the runtime module graph, strips types and comments, concatenates,
gzips.

**The number is an upper bound, not a measurement.** Nothing is minified,
mangled, or tree shaken, so a real bundler can only make it smaller. A gate
that can only be wrong in the pessimistic direction is still a useful gate —
but inside ~2KB of the limit it stops being informative, and the answer then is
a real bundler rather than relaxing this.

```bash
npm run size
```

Two things it gets right that a naive version does not: it reads imports off
the *stripped* source, so type-only modules that ship zero bytes are not
counted, and it removes comments, which every minifier does unconditionally and
which are the majority of this repo by weight.

## Testing them

The pure layers are unit tested like anything else — CDP framing against a fake
socket, path resolution and traversal, the comment stripper, the module walk.
What cannot be tested here is the part that needs a browser, and that is
`Browser`/`Page`, which is excluded from the coverage gate for the same reason
every `cli.ts` is.
