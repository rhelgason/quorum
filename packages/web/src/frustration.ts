/**
 * Passive frustration detection.
 *
 * The argument for this existing at all: a plain feedback form is answered by
 * people who are calm enough to fill in a form. The users who are actually
 * stuck leave. Behavioural signals — clicking the same dead button four times,
 * reloading twice, bouncing between two pages — are evidence of trouble from
 * people who will never type anything, and they are a *ranking* input, not
 * telemetry ([ADR-0012](../../../docs/adr/0012-prioritization-is-the-product.md)).
 *
 * **Behaviour, not inferred sentiment.** Nothing here guesses at mood from
 * text. A dead click is a fact about the DOM; "the user seems annoyed" is a
 * guess, and a guess that would end up weighting somebody's roadmap.
 *
 * ## The rule that constrains the whole design
 *
 * [ADR-0010](../../../docs/adr/0010-never-interrupt-the-frustrated-user.md):
 * never interrupt the frustrated user. Detection is silent by default. Someone
 * mashing a broken button does not want a modal asking how their day is going
 * — that is the single most reliable way to convert frustration into
 * uninstallation. `detect` records; `prompt` is opt-in, non-modal, and fires
 * at most once per session.
 *
 * ## Why this file has no DOM in it
 *
 * The detector takes timestamped events and returns counts and a score. Every
 * rule — what counts as a rage click, how long a burst window is, when
 * navigation becomes thrash — is arithmetic over a list, and arithmetic is
 * worth testing without a browser. `frustration-dom.ts` does the listening.
 */

import type { FrustrationSignal } from '../../core/src/protocol.ts';

export type { FrustrationSignal };

/** A raw observation. Timestamps are milliseconds from any consistent epoch. */
export interface FrustrationEvent {
  kind: 'click' | 'nav' | 'reload' | 'escape' | 'scroll' | 'form_error' | 'console_error';
  at: number;
  /**
   * Stable key for the thing acted on — a selector, a form name, a route.
   * Repeats on the same key are what distinguish frustration from activity.
   */
  target?: string;
  /** Viewport coordinates, for clustering repeated clicks by location. */
  x?: number;
  y?: number;
  /**
   * True when a click changed nothing observable: no navigation, no DOM
   * mutation, no focus change. Decided by the DOM layer, which is the only
   * part that can see it.
   */
  dead?: boolean;
  /** Scroll delta, signed. Direction reversals are the thrash signal. */
  delta?: number;
}

export interface FrustrationOptions {
  /** Clicks on one spot within the window before it counts as rage. Default 3. */
  rageClicks?: number;
  rageWindowMs?: number;
  /** Pixels within which repeated clicks count as the same spot. Default 30. */
  rageRadius?: number;
  /** Navigations within the window before it counts as thrash. Default 4. */
  navThrash?: number;
  navWindowMs?: number;
  /** Escape presses within the window before it counts as mashing. Default 3. */
  escapeMash?: number;
  escapeWindowMs?: number;
  /** Direction reversals within the window before scrolling counts as searching. Default 4. */
  scrollThrash?: number;
  scrollWindowMs?: number;
  /** Console errors within the window before it counts as a spike. Default 3. */
  consoleSpike?: number;
  consoleWindowMs?: number;
  /** Repeats of one form error before it counts. Default 2. */
  formErrorRepeats?: number;
  /** Per-signal contribution to the score. */
  weights?: Partial<Record<FrustrationSignal, number>>;
}

export type SignalCounts = Partial<Record<FrustrationSignal, number>>;

/**
 * Default weights.
 *
 * Ordered by how strongly each implies "something is broken" rather than "this
 * person is busy". A dead click is nearly unambiguous — the user expected an
 * effect and got none. Scrolling a lot is barely evidence of anything, and is
 * weighted so it can never reach the threshold alone.
 */
export const DEFAULT_WEIGHTS: Record<FrustrationSignal, number> = {
  dead_click: 0.35,
  rage_click: 0.3,
  form_error_repeat: 0.25,
  reload: 0.2,
  console_error_spike: 0.2,
  nav_thrash: 0.15,
  escape_mash: 0.15,
  scroll_thrash: 0.05,
};

/** Score at or above which `prompt` mode may nudge, once. */
export const PROMPT_THRESHOLD = 0.5;

/**
 * Turn counts into a 0–1 score.
 *
 * Saturating rather than linear: `1 - exp(-Σ wᵢ·nᵢ)`. Frustration is not
 * additive without bound — the difference between three dead clicks and thirty
 * is not ten times more upset, it is the same person still stuck. A linear sum
 * would also let one noisy signal dominate every comparison, which matters
 * because this number is a ranking input and the ranking is the product.
 */
export function scoreFrustration(
  counts: SignalCounts,
  weights: Partial<Record<FrustrationSignal, number>> = {},
): number {
  let total = 0;
  for (const [signal, count] of Object.entries(counts) as [FrustrationSignal, number][]) {
    if (count <= 0) continue;
    const weight = weights[signal] ?? DEFAULT_WEIGHTS[signal];
    total += weight * count;
  }
  return Number((1 - Math.exp(-total)).toFixed(4));
}

function distance(a: FrustrationEvent, b: FrustrationEvent): number {
  const dx = (a.x ?? 0) - (b.x ?? 0);
  const dy = (a.y ?? 0) - (b.y ?? 0);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * How many non-overlapping windows of `windowMs` contain `threshold` events.
 *
 * Non-overlapping is the point. A sliding count would fire again on every
 * subsequent event while the window stayed full, so one ten-second burst of
 * reloading would register as seven separate incidents and dominate the score.
 * Consuming the events that triggered a burst means a burst counts once.
 */
export function countBursts(
  timestamps: readonly number[],
  threshold: number,
  windowMs: number,
): number {
  if (threshold <= 0) return 0;
  const at = [...timestamps].sort((a, b) => a - b);

  let bursts = 0;
  let i = 0;
  while (i < at.length) {
    let j = i;
    while (j < at.length && (at[j] as number) - (at[i] as number) < windowMs) j++;

    if (j - i >= threshold) {
      bursts++;
      i = j;
    } else {
      i++;
    }
  }
  return bursts;
}

/**
 * Detect signals in a list of events.
 *
 * Pure, and evaluated over the whole list rather than incrementally, so the
 * same events always yield the same counts regardless of how they arrived.
 * A detector whose output depended on batching would be untestable and would
 * disagree with itself between a live session and a replay.
 */
export function detectSignals(
  events: readonly FrustrationEvent[],
  options: FrustrationOptions = {},
): SignalCounts {
  const counts: SignalCounts = {};
  const bump = (signal: FrustrationSignal, by = 1): void => {
    counts[signal] = (counts[signal] ?? 0) + by;
  };

  const ordered = [...events].sort((a, b) => a.at - b.at);
  const clicks = ordered.filter((e) => e.kind === 'click');

  // Dead clicks: counted individually, because each one is a separate moment
  // of "I pressed it and nothing happened".
  const dead = clicks.filter((e) => e.dead === true).length;
  if (dead > 0) bump('dead_click', dead);

  // Rage clicks: a burst on one spot. Counted once per burst rather than per
  // click, or a single frantic moment would swamp every other signal.
  const rageThreshold = options.rageClicks ?? 3;
  const rageWindow = options.rageWindowMs ?? 1000;
  const rageRadius = options.rageRadius ?? 30;
  const consumed = new Set<number>();

  clicks.forEach((click, index) => {
    if (consumed.has(index)) return;
    const burst = [index];
    for (let j = index + 1; j < clicks.length; j++) {
      const other = clicks[j] as FrustrationEvent;
      if (other.at - click.at > rageWindow) break;
      if (consumed.has(j)) continue;
      const sameSpot =
        other.target !== undefined && other.target === click.target
          ? true
          : distance(click, other) <= rageRadius;
      if (sameSpot) burst.push(j);
    }
    if (burst.length >= rageThreshold) {
      for (const i of burst) consumed.add(i);
      bump('rage_click');
    }
  });

  bump('reload', ordered.filter((e) => e.kind === 'reload').length);
  if (counts.reload === 0) delete counts.reload;

  // Burst signals: counted once per window that crosses its threshold, so a
  // long session cannot accumulate them one stray event at a time.
  const bursts: [FrustrationSignal, FrustrationEvent['kind'], number, number][] = [
    ['nav_thrash', 'nav', options.navThrash ?? 4, options.navWindowMs ?? 10_000],
    ['escape_mash', 'escape', options.escapeMash ?? 3, options.escapeWindowMs ?? 2000],
    ['console_error_spike', 'console_error', options.consoleSpike ?? 3, options.consoleWindowMs ?? 5000],
  ];

  for (const [signal, kind, threshold, windowMs] of bursts) {
    const at = ordered.filter((e) => e.kind === kind).map((e) => e.at);
    bump(signal, countBursts(at, threshold, windowMs));
    if (counts[signal] === 0) delete counts[signal];
  }

  // Scroll thrash is direction *reversals*, not distance. Reading a long page
  // is not frustration; hunting up and down for something is.
  const scrolls = ordered.filter((e) => e.kind === 'scroll' && (e.delta ?? 0) !== 0);
  const reversals: number[] = [];
  for (let i = 1; i < scrolls.length; i++) {
    const previous = Math.sign((scrolls[i - 1] as FrustrationEvent).delta ?? 0);
    const current = scrolls[i] as FrustrationEvent;
    if (previous !== Math.sign(current.delta ?? 0)) reversals.push(current.at);
  }
  bump(
    'scroll_thrash',
    countBursts(reversals, options.scrollThrash ?? 4, options.scrollWindowMs ?? 5000),
  );
  if (counts.scroll_thrash === 0) delete counts.scroll_thrash;

  // The same form failing repeatedly is one of the strongest signals here:
  // the user is trying to give you something and the product will not take it.
  const repeats = options.formErrorRepeats ?? 2;
  const byForm = new Map<string, number>();
  for (const event of ordered) {
    if (event.kind !== 'form_error') continue;
    const key = event.target ?? '';
    byForm.set(key, (byForm.get(key) ?? 0) + 1);
  }
  for (const count of byForm.values()) if (count >= repeats) bump('form_error_repeat');

  return counts;
}

export interface FrustrationSnapshot {
  score: number;
  signals: SignalCounts;
}

/**
 * A live tracker.
 *
 * Bounded by construction: it keeps at most `maxEvents` and drops the oldest.
 * This runs for the whole life of a page in somebody else's application, and
 * an unbounded array of every click a user makes is a memory leak with a
 * plausible excuse.
 */
export class FrustrationTracker {
  readonly #events: FrustrationEvent[] = [];
  readonly #options: FrustrationOptions;
  readonly #maxEvents: number;

  constructor(options: FrustrationOptions & { maxEvents?: number } = {}) {
    this.#options = options;
    this.#maxEvents = options.maxEvents ?? 200;
  }

  record(event: FrustrationEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.#maxEvents) this.#events.shift();
  }

  get eventCount(): number {
    return this.#events.length;
  }

  snapshot(): FrustrationSnapshot {
    const signals = detectSignals(this.#events, this.#options);
    return { score: scoreFrustration(signals, this.#options.weights ?? {}), signals };
  }

  /** Whether `prompt` mode should offer, given it has not already. */
  shouldPrompt(threshold = PROMPT_THRESHOLD): boolean {
    return this.snapshot().score >= threshold;
  }

  reset(): void {
    this.#events.length = 0;
  }
}
