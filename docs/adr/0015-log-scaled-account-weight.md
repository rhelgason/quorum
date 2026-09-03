# 0015 — Account weight is logarithmic, and praise is not work

**Status:** Accepted · 2026-09-03
**Refines:** [0012](0012-prioritization-is-the-product.md)

## Context

[ADR-0012](0012-prioritization-is-the-product.md) made revenue-weighted ranking
the differentiator: join feedback to plan tier and MRR so the top items reflect
value rather than volume. It did not say *how* to weight, and the obvious
implementation — multiply by MRR — quietly changes what the product is for.

## Decision

Four opinions, now implemented in `packages/aggregate/src/rank.ts` and pinned
by tests.

### 1. Account weight is logarithmic

`weight(u) = 1 + log10(1 + mrr / baseline)`, baseline $100/mo.

| MRR | weight |
| --- | --- |
| $0 | 1.00 |
| $100 | 1.30 |
| $1,000 | 2.04 |
| $10,000 | 3.00 |
| $1,000,000 | 5.00 |

Linear MRR weighting makes the product answer *"what does our biggest customer
want"*, not *"what's important"*. A single $10k/month account would outvote a
hundred free users, and the ranked list would return that account's request
every week — which nobody needs a tool to compute.

Log scaling keeps revenue as the ordering signal while capping its reach: a
$10k account counts as about three users, and even a $1M account loses to six
free ones. Ordering is preserved; domination is not. The tests assert both
halves, because either one alone is the wrong product.

### 2. Growth has a volume floor

The second derivative is what a PM wants — a cluster that tripled this week
beats a bigger one flat for six months. But unguarded ratios are pure noise at
small n: one user last week and three this week is "200% growth" on evidence of
three people, and clusters like that would occupy the entire top of the list.

Growth applies only once the prior window has at least 3 unique users. Below
that the multiplier is exactly 1 and `growthSuppressed` is reported, so the UI
can say *"growth n/a (only 2 prior)"* rather than showing an unexplained
number. Growth is also clamped at 3× so one runaway week can't own the list
forever.

### 3. Unique users, never submission counts

A user's weight comes from their *most recent* submission in a cluster.
Re-filing makes someone more recent, never louder.

This closes the entire spam surface by construction rather than by moderation,
and it fixes the more common non-adversarial case: the motivated power user who
files twenty tickets is one person, and a tool that ranks them above twenty
separate people is broken.

### 4. Praise is excluded from the ranked list

Praise clusters and ranks like anything else, but it is filtered from the build
list by default. *"The receipt scanner is magic"* topping the roadmap is a bug,
not a delightful surprise; it belongs on its own surface.

`question` is deliberately **not** excluded. Confusion is real work — usually
docs or UX rather than engineering, but work. Dropping it would hide an entire
class of cheap, high-impact fixes, and the corpus contains two such clusters
(`confusion-where-currency-setting`, `confusion-submitted-vs-approved`) that a
team would genuinely want to see.

## Consequences

- Every one of these is a defensible-but-arguable judgment call, which is why
  each is a named option with a default rather than a constant: `mrrBaseline`,
  `growthMinVolume`, `maxGrowth`, `halfLifeDays`, `excludeKinds`.
- `ScoreComponents` exposes every input to the score, and `explain()` renders
  it in one line. Required by
  [ADR-0012](0012-prioritization-is-the-product.md): if the ranked list is the
  product, a reader who can't see why item #3 is #3 has no reason to believe
  any of it.
- Ranking takes an explicit `now`. No implicit clock, so a score is
  reproducible and a disputed ranking can be recomputed exactly.
- The log curve is a guess. It is a *defensible* guess, but nobody has
  validated the shape against a real customer's sense of fairness.

## Reversal cost

Low — one function, fully covered by tests.

## What would change our mind

Real customers reporting that the list under-weights their large accounts. The
knob to turn first is `mrrBaseline` (a lower baseline steepens the curve), not
a switch to linear. If linear is ever genuinely wanted, it should be an
explicit `weighting: 'linear'` mode with this ADR's warning in the docs beside
it.
