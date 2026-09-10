# Contributing to Quorum

The most useful contribution is still argument: read [`docs/adr/`](docs/adr/)
and tell us where the reasoning is wrong. Every ADR ends with "what would
change our mind" — that section is an invitation, and six of them have been
overturned by someone taking it seriously (with a measurement, usually).

## Setup

Nothing to install to run or test it. Node 24 executes the TypeScript directly.

```bash
nvm use               # Node 24, pinned in .nvmrc
npm test              # 1,156 tests, empty node_modules
npm run app           # the demo product + ingest + ranked backlog
npm run demo          # a support-inbox CSV in, a ranked backlog out
npm run northwind     # the pipeline over 428 submissions; regenerates the figures
npm run eval          # clustering baselines + rank agreement
npm run size          # the 15KB budget
```

Two things do need dependencies or hardware:

```bash
npm install && npm run typecheck && npm run build   # needs the registry
npm run test:browser                                # needs a Chromium-family browser
```

**Run `npm run build`, not just `typecheck`.** They exercise different compiler
graphs and each catches what the other misses — see
[TESTING.md](docs/TESTING.md).

**There is no committed lockfile.** The environment this was written in has no
registry access, so one could not be generated honestly. If you have network,
running `npm install`, committing `package-lock.json` and flipping CI back to
`npm ci` is a genuinely useful first contribution.

## Ground rules

Not style preferences. Each has an ADR behind it, and a PR that violates one
gets a link rather than a debate.

- **`@quorum/core` has zero runtime dependencies.** Core + nub have a 15KB
  gzipped budget and CI fails on regression. If something pushes past it, the
  answer is usually `import()` rather than a bigger budget.
- **Protocol changes are additive-only** within a major version. Clients in the
  wild are old clients. Removing or retyping a field needs an ADR.
- **Never loosen a redaction default.** Loosening one that already shipped means
  every existing deployment silently starts capturing more than it did
  yesterday — that is a breach, not a release. An opt-in unmask path is fine.
- **No interrupting UI.** The frustration nudge is an event, not a modal: once
  per session, never stealing focus
  ([ADR-0010](docs/adr/0010-never-interrupt-the-frustrated-user.md)).
- **Offline clustering proposes, never applies.** Auto-applied merges undo human
  curation and permanently destroy trust in the tool.
- **No new datastore.** Postgres + pgvector until measurements say otherwise.

### Clustering changes come with numbers — and the right ones

Run `npm run eval` before and after. Two rules about *which* numbers, both
learned the hard way:

- **Do not tune on ARI.** Measured: the configuration with the best ARI produces
  a worse ranked list
  ([ADR-0014](docs/adr/0014-rank-agreement-is-the-eval-target.md)). Top-10 rank
  agreement is the target.
- **Do not tune on rank agreement alone either.** It pays for over-merging
  between roughly *k* and 2*k* clusters, so a change can raise it by conflating
  unrelated topics. Check the cluster count and pairwise precision beside it;
  the sweep prints all three and disqualifies cells that conflate more than the
  lexical control
  ([ADR-0023](docs/adr/0023-rank-agreement-needs-a-conflation-guard.md)).

That second rule shipped inside a default for a week before anyone noticed
([ADR-0024](docs/adr/0024-consolidation-threshold-retuned.md)). A change that
improves the headline while the largest cluster triples is a regression.

### Test the seam, not just the sides

Two bugs survived ~900 passing tests because each side was tested against a
mock of the other: an ingest path the client and server disagreed about, and a
`fetch` call that worked in Node and threw in every browser. If a change spans
a boundary, add a test that runs both halves for real —
[`services/api/src/roundtrip.test.ts`](services/api/src/roundtrip.test.ts) is
the pattern.

For anything touching `@quorum/web`'s DOM layer, `npm run test:browser` drives
a real browser over CDP
([ADR-0022](docs/adr/0022-verify-the-dom-layer-over-cdp.md)). It skips with a
reason where there is no browser, so a green `npm test` does **not** mean the
element renders.

## Where help is most welcome

**Real labeled feedback data** is the highest-leverage contribution in the
project. [`packages/eval`](packages/eval/README.md) has a working harness and a
161-item corpus, but that corpus is synthetic — the same judgment wrote the
items and the labels, so it validates an implementation and not an approach.
Real data drops into the same schema and everything downstream works unchanged.

**Measuring an embedding model.** The sweep is built and has never been run
against a real one; it is the open question that decides whether the ranked
list is trustworthy. About five minutes with Ollama —
[instructions](packages/eval/README.md#unblocking-this-in-five-minutes).

**Framework wrappers** (Vue, Svelte, Angular) are thin, well-scoped, and
deliberately off the roadmap — see [ROADMAP.md](docs/ROADMAP.md). They are the
ideal outside contribution.

## Commits and ADRs

Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`), scoped to a package
where it applies (`feat(core):`).

If your change reverses or complicates an accepted ADR, do not edit that ADR —
add a new one that supersedes or amends it, and update the table in
[`docs/adr/README.md`](docs/adr/README.md). The record of having been wrong is
the most useful thing in that directory.
