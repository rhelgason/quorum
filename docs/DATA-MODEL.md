# Quorum — Data Model

> Status: design. Postgres + pgvector. Table sketches are illustrative, not
> migrations; column types will get pinned when `services/api` is real.

The organizing principle: **submissions are append-only facts, canonical issues
are mutable interpretations.** We never edit or delete what a user wrote. Every
merge, split, and re-label is a change to the interpretation layer and is
reversible. This is what lets a PM disagree with the clustering without losing
data, and it's what makes the whole pipeline auditable.

---

## 1. Tenancy & identity

```sql
projects (
  id              uuid pk,
  slug            text unique,          -- 'acme-web'
  name            text,
  public_key      text unique,          -- safe to embed in the client bundle
  settings        jsonb,                -- capture policy, redaction, thresholds
  created_at      timestamptz
)

end_users (                              -- the customer's users, not ours
  id              uuid pk,
  project_id      uuid fk,
  external_id     text,                  -- from quorum.identify(), nullable
  anon_id         text,                  -- first-party localStorage fallback
  traits          jsonb,                 -- { plan, mrr, signup_date, ... }
  account_weight  numeric,               -- DERIVED from traits; see §5
  first_seen_at   timestamptz,
  last_seen_at    timestamptz,
  unique (project_id, external_id),
  unique (project_id, anon_id)
)
```

`account_weight` is materialized rather than computed at query time because
ranking reads it for every submission in every cluster on every dashboard load.
Recomputed on `identify()` and on a nightly sweep.

**Anonymous → identified merge.** A user files anonymously, then logs in.
On `identify()` we relink that session's submissions from the `anon_id` row to
the `external_id` row and tombstone the anon row. Getting this wrong
double-counts users and corrupts the "unique users" ranking input, so it's a
transaction with a uniqueness guard, not a best-effort background job.

---

## 2. Submissions (append-only)

```sql
submissions (
  id              uuid pk,
  project_id      uuid fk,
  end_user_id     uuid fk null,
  kind            text,        -- feature_request | bug | praise | question | rage
  source          text,        -- nub | shortcut | picker | selection | shake
                               -- | frustration_prompt | api | import | support_inbox
  body            text,        -- verbatim. never rewritten.
  body_normalized text,        -- lowercased, punctuation-stripped, for lexical match
  lang            text,
  received_at     timestamptz,
  client_ts       timestamptz, -- may differ wildly; offline queue can be days late

  -- structural signals — often better clustering evidence than the text
  route           text,        -- '/checkout/payment' or 'CheckoutViewController'
  app_version     text,
  sdk_version     text,
  platform        text,        -- web | ios | android
  os_version      text,
  device          text,
  locale          text,
  element_ref     jsonb,       -- selector, bbox, component name (element picker)

  frustration     jsonb,       -- { score, signals: [dead_click, rage_click, ...] }
  capture_id      uuid fk null,
  redaction       jsonb,       -- what was masked, and by which rule
  dedup_hash      text,        -- SimHash of body_normalized, for LSH blocking
  embedding       vector(384)  -- local MiniLM-class model
)
```

Indexes that matter: `ivfflat`/`hnsw` on `embedding`, GIN on
`to_tsvector(body_normalized)` for BM25, btree on
`(project_id, route, app_version, received_at)` for the structural path, and
btree on `dedup_hash` for blocking.

Note there is no `title` column. Users don't write titles; asking for one is
friction and they'd write a bad one. Titles are a property of the cluster.

```sql
captures (                       -- heavy payloads, separable storage
  id              uuid pk,
  submission_id   uuid fk,
  dom_snapshot    bytea,         -- rrweb-format, compressed
  replay          bytea null,    -- last ~15s, opt-in
  console_log     jsonb,         -- ring buffer, last ~50
  network_log     jsonb,
  app_state       jsonb null,    -- Redux/Zustand hook
  screenshot      bytea null,    -- mobile only
  retention_until timestamptz    -- captures expire independently of submissions
)
```

Captures carry the PII risk and the storage cost. Keeping them in a separate
table with their own retention clock means a customer can say "delete all
captures after 30 days, keep the feedback forever" — which is exactly what
they'll ask for.

---

## 3. Canonical issues (the interpretation layer)

```sql
canonical_issues (
  id                 uuid pk,
  project_id         uuid fk,
  centroid           vector(384),
  member_count       int,           -- denormalized
  unique_user_count  int,           -- denormalized; the one that matters
  medoid_id          uuid fk,       -- submission closest to centroid = free label
  status             text,          -- open | planned | in_progress | shipped | declined
  linked_issue_url   text null,     -- Jira/Linear/GitHub write-back
  merged_into        uuid fk null,  -- soft-merge; never delete a cluster
  locked             boolean,       -- human pinned it; offline tier may not touch
  created_at         timestamptz,
  updated_at         timestamptz
)

issue_members (
  issue_id        uuid fk,
  submission_id   uuid fk,
  similarity      numeric,     -- score at assignment time
  assigned_by     text,        -- online | offline | human
  assigned_at     timestamptz,
  primary key (issue_id, submission_id)
)
```

### Incremental centroid update

Online assignment must not re-read the cluster. Store the running sum and
divide:

```
sum   := sum + embedding(new)
n     := n + 1
centroid := sum / n            -- normalize before comparison
```

Storing `sum` alongside `centroid` also makes *removal* exact when a human
splits a cluster — subtract and decrement — instead of forcing a full
recompute over every member.

Drift caveat: a cluster that grows over months walks its centroid away from
where it started, silently widening what it accepts. The nightly offline tier
is partly there to catch exactly that.

### `locked` is load-bearing

Once a human has curated a cluster, the offline tier may propose changes to it
but may never apply them. Without this the nightly job quietly undoes a PM's
afternoon of work and they stop trusting the tool permanently.

---

## 4. Cluster proposals (offline tier, human-gated)

```sql
cluster_proposals (
  id              uuid pk,
  project_id      uuid fk,
  kind            text,        -- merge | split | reassign
  payload         jsonb,       -- issue ids, submission ids, target shape
  evidence        jsonb,       -- similarity stats, shared terms, shared route
  confidence      numeric,
  state           text,        -- pending | accepted | rejected | expired
  created_at      timestamptz,
  decided_by      uuid null,
  decided_at      timestamptz
)
```

**Nothing here auto-applies.** Rejected proposals are remembered so the nightly
job doesn't re-propose the same merge every single night — that's the fastest
way to train a user to ignore the queue.

---

## 5. Ranking

Deterministic, no model in the loop:

```
score(issue) = Σ_over_unique_users( account_weight(u) × recency_decay(t_u) )
               × growth_multiplier(issue)
```

- **Unique users, not submissions.** Kills spam and the one-person-twenty-tickets
  problem in a single stroke.
- **`recency_decay`** — exponential, half-life configurable per project
  (default ~60d). Fast-moving consumer apps want a shorter half-life than
  enterprise tools.
- **`account_weight`** — derived from `identify()` traits. Default 1.0 for
  anonymous. This is the differentiator: revenue-weighted beats volume-weighted,
  and it's what makes Quorum a budget line item rather than a nice-to-have.
- **`growth_multiplier`** — ratio of last-7d to prior-7d unique users. The
  second derivative is what a PM actually wants: a cluster that tripled this
  week beats a bigger one flat for six months.
- **Sentiment** comes from a lexicon (VADER) or, better, from frustration score
  and rage-shake intensity — behavioral signal beats inferred signal.

```sql
issue_scores (
  issue_id     uuid fk,
  computed_at  timestamptz,
  score        numeric,
  components   jsonb,       -- every input, so the number is explainable
  primary key (issue_id, computed_at)
)
```

Snapshotting the components rather than just the score means the dashboard can
answer "why did this jump to #1 this week" without recomputation, and we can
diff ranking changes when we tune weights.

---

## 6. Generated content (the render edge)

```sql
issue_renders (
  issue_id         uuid fk,
  composition_hash text,        -- see below
  title            text,
  summary          text,
  eng_spec         text,        -- imperative voice, acceptance criteria
  quote_refs       uuid[],      -- submissions the LLM was shown
  model            text,        -- 'claude-sonnet-5', 'local:llama-3.1-8b', ...
  prompt_version   text,
  generated_at     timestamptz,
  primary key (issue_id, composition_hash)
)
```

**`composition_hash`** = stable hash over the sorted member submission IDs. It
is the cache key and the invalidation rule in one: regenerate only when
composition shifts past a threshold (~20% new members). Consequences:

- The same cluster always renders the same spec — no churn under a PM's feet.
- Cost is bounded by cluster *change*, not cluster count or dashboard traffic.
- `model` + `prompt_version` in the key path means switching providers or
  editing a prompt is a visible, diffable migration.

`quote_refs` is mandatory, not optional. Every generated line drills down to
the verbatim feedback behind it. LLM output with no drill-down gets distrusted
the first time it's subtly wrong, and it will eventually be subtly wrong.

**Fallback path:** when no render row exists — LLM disabled, self-host without
a model, generation failed — the UI shows the medoid submission verbatim as the
title plus TF-IDF top terms as tags. Degraded, still useful, never blank.

---

## 7. Loop closure

```sql
issue_subscribers (            -- who to notify when it ships
  issue_id      uuid fk,
  end_user_id   uuid fk,
  notified_at   timestamptz null,
  primary key (issue_id, end_user_id)
)

votes (
  issue_id      uuid fk,
  end_user_id   uuid fk,
  weight        numeric,       -- snapshot of account_weight at vote time
  created_at    timestamptz,
  primary key (issue_id, end_user_id)
)
```

Snapshotting `weight` at vote time keeps historical scores reproducible when a
customer's plan tier changes.

Co-voting on this table is also a similarity signal in its own right — "users
who upvoted X also upvoted Y" surfaces latent themes that text similarity never
will.

---

## 8. Evaluation

Not optional, and it lives in the schema so it doesn't rot in someone's
notebook:

```sql
eval_labels (
  project_id      uuid fk,
  submission_id   uuid fk,
  truth_cluster   text,        -- hand-assigned
  labeled_by      text,
  labeled_at      timestamptz,
  primary key (project_id, submission_id)
)

eval_runs (
  id            uuid pk,
  config        jsonb,         -- every threshold and weight
  ari           numeric,       -- adjusted Rand index
  v_measure     numeric,
  pairwise_f1   numeric,
  ran_at        timestamptz
)
```

Every knob in the pipeline is unfalsifiable without this.

---

## Open questions

- Multi-language: one embedding space, or per-language models and
  cross-language cluster linking? Affects `submissions.lang` handling.
- Cross-project clustering for the same customer (web + iOS + support inbox) —
  one canonical issue store per project, or per org with a project facet?
- Capture retention default. 30d is the safe answer; is it the useful one?
- Do we need a `submissions.superseded_by` for the same user re-filing a better
  description of the same thing?
