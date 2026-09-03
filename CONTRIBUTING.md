# Contributing to Quorum

Quorum is in the design phase. The most useful contribution right now is
argument: read [`docs/adr/`](docs/adr/) and tell us where the reasoning is
wrong. Every ADR ends with "what would change our mind" — that section is an
invitation.

## Setup

```bash
nvm use            # Node 24, pinned in .nvmrc
npm test           # needs no dependencies at all — Node runs the TypeScript
npm install        # only needed for typecheck/build
npm run typecheck
npm run build      # run this too — it catches what typecheck cannot
npm run eval       # clustering baselines + a ranked backlog
```

**There is no committed lockfile yet** — see
[TESTING.md](docs/TESTING.md#typecheck-needs-dependencies-tests-dont). If you
have registry access, running `npm install` and committing
`package-lock.json` (plus flipping CI back to `npm ci`) is a genuinely useful
first contribution.

## Ground rules

These aren't style preferences; each one is a decision with an ADR behind it,
and a PR that violates one will be sent back with a link rather than a debate.

- **`@quorum/core` has zero runtime dependencies.** Core + nub have a 15KB
  gzipped budget and CI fails on regression.
- **Protocol changes are additive-only** within a major version. Clients in the
  wild are old clients. Removing or retyping a field is a version bump, and it
  needs an ADR.
- **Never loosen a redaction default.** Loosening a default that already
  shipped means every existing deployment silently starts capturing more than
  it did yesterday — that's a breach, not a release. Adding an opt-in unmask
  path is fine.
- **No interrupting UI.** The frustration nudge is non-modal, dismissible, once
  per session, and never steals focus.
- **No new datastore.** Postgres + pgvector until measurements say otherwise.
- **Offline clustering proposes, never applies.** Auto-applied merges undo
  human curation and permanently destroy trust in the tool.
- **Clustering changes come with eval numbers.** Run `npm run eval` before and
  after. A change that improves aggregate ARI while losing hard pairs is a
  regression, not an improvement.

## Where help is most welcome

Framework wrappers (Vue, Svelte, Angular) are thin, well-scoped, and
deliberately not on our roadmap — see
[ROADMAP.md](docs/ROADMAP.md). They're the ideal outside contribution.

**Real labeled feedback data** is the highest-leverage contribution in the
project. [`packages/eval`](packages/eval/README.md) has a working harness and a
161-item corpus, but that corpus is synthetic — the same judgment wrote both
the items and the labels, so it can validate an implementation and not an
approach. Real data drops into the same schema and everything downstream works
unchanged.

## Commits and ADRs

Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`), scoped to a package
where it applies (`feat(core):`).

If your change reverses or complicates an accepted ADR, don't edit that ADR —
add a new one that supersedes it and update the table in
[`docs/adr/README.md`](docs/adr/README.md).
