/**
 * Frustration detection.
 *
 * Two kinds of test here, and the second kind matters more. The first checks
 * each signal fires when it should. The second checks it *does not* fire on
 * ordinary use — because this number weights somebody's roadmap, and a
 * detector that reads normal browsing as distress is worse than no detector:
 * it would quietly promote whatever page people use most.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  countBursts,
  DEFAULT_WEIGHTS,
  detectSignals,
  FrustrationTracker,
  PROMPT_THRESHOLD,
  scoreFrustration,
  type FrustrationEvent,
} from './frustration.ts';

const T = 1_000_000;

/** Clicks on one spot, `gap` apart. */
function burst(count: number, gap: number, target = '#send'): FrustrationEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: 'click' as const,
    at: T + i * gap,
    target,
    x: 100,
    y: 100,
  }));
}

describe('countBursts', () => {
  it('counts a full window once', () => {
    assert.equal(countBursts([0, 100, 200], 3, 1000), 1);
  });

  it('does not count a window that never fills', () => {
    assert.equal(countBursts([0, 100], 3, 1000), 0);
  });

  it('counts two separate bursts separately', () => {
    assert.equal(countBursts([0, 100, 200, 5000, 5100, 5200], 3, 1000), 2);
  });

  it('does not re-count the same burst as it slides', () => {
    // Six clicks inside one second is *one* burst, not four and not two. A
    // sliding counter would fire on every event after the third and let one
    // frantic moment dominate the whole score; splitting the window by
    // threshold would report two incidents where a person experienced one.
    assert.equal(countBursts([0, 100, 200, 300, 400, 500], 3, 1000), 1);
  });

  it('starts a new burst once the window has passed', () => {
    // The events that triggered a burst are consumed, so the next window
    // starts after them rather than overlapping.
    assert.equal(countBursts([0, 100, 200, 1500, 1600, 1700], 3, 1000), 2);
  });

  it('is order-insensitive', () => {
    assert.equal(countBursts([200, 0, 100], 3, 1000), 1);
  });

  it('is zero for a nonsense threshold', () => {
    assert.equal(countBursts([0, 1, 2], 0, 1000), 0);
  });
});

describe('signals that should fire', () => {
  it('counts each dead click', () => {
    const events: FrustrationEvent[] = [
      { kind: 'click', at: T, target: '#export', dead: true },
      { kind: 'click', at: T + 2000, target: '#export', dead: true },
    ];
    assert.equal(detectSignals(events).dead_click, 2);
  });

  it('sees a rage click burst on one target', () => {
    assert.equal(detectSignals(burst(4, 150)).rage_click, 1);
  });

  it('sees a rage burst by proximity when there is no target', () => {
    const events: FrustrationEvent[] = [0, 120, 240].map((offset) => ({
      kind: 'click',
      at: T + offset,
      x: 200,
      y: 300,
    }));
    assert.equal(detectSignals(events).rage_click, 1);
  });

  it('counts one burst once, however frantic', () => {
    // Ten clicks in a second is one moment of frustration, not eight.
    assert.equal(detectSignals(burst(10, 90)).rage_click, 1);
  });

  it('sees navigation thrash', () => {
    const events: FrustrationEvent[] = [0, 1000, 2000, 3000].map((offset) => ({
      kind: 'nav',
      at: T + offset,
      target: offset % 2000 === 0 ? '/reports' : '/settings',
    }));
    assert.equal(detectSignals(events).nav_thrash, 1);
  });

  it('sees escape mashing', () => {
    const events: FrustrationEvent[] = [0, 200, 400].map((offset) => ({
      kind: 'escape',
      at: T + offset,
    }));
    assert.equal(detectSignals(events).escape_mash, 1);
  });

  it('counts reloads individually', () => {
    const events: FrustrationEvent[] = [
      { kind: 'reload', at: T },
      { kind: 'reload', at: T + 30_000 },
    ];
    assert.equal(detectSignals(events).reload, 2);
  });

  it('sees a console error spike', () => {
    const events: FrustrationEvent[] = [0, 500, 1000].map((offset) => ({
      kind: 'console_error',
      at: T + offset,
    }));
    assert.equal(detectSignals(events).console_error_spike, 1);
  });

  it('sees one form failing repeatedly', () => {
    const events: FrustrationEvent[] = [
      { kind: 'form_error', at: T, target: 'checkout' },
      { kind: 'form_error', at: T + 5000, target: 'checkout' },
    ];
    // The user is trying to give you something and the product will not take it.
    assert.equal(detectSignals(events).form_error_repeat, 1);
  });

  it('counts scroll direction reversals, not scrolling', () => {
    const events: FrustrationEvent[] = [100, -100, 100, -100, 100].map((delta, i) => ({
      kind: 'scroll',
      at: T + i * 200,
      delta,
    }));
    assert.equal(detectSignals(events).scroll_thrash, 1);
  });
});

describe('what ordinary use must not trigger', () => {
  it('a person clicking around a working app', () => {
    const events: FrustrationEvent[] = [
      { kind: 'click', at: T, target: '#reports' },
      { kind: 'nav', at: T + 200, target: '/reports' },
      { kind: 'click', at: T + 4000, target: '#export' },
      { kind: 'click', at: T + 9000, target: '#settings' },
      { kind: 'nav', at: T + 9200, target: '/settings' },
    ];
    assert.deepEqual(detectSignals(events), {});
    assert.equal(scoreFrustration(detectSignals(events)), 0);
  });

  it('a double click', () => {
    // Two fast clicks is a double click, not rage. The threshold is three.
    assert.equal(detectSignals(burst(2, 80)).rage_click, undefined);
  });

  it('deliberate clicks on the same button, spread out', () => {
    // "Next page" five times over half a minute is someone using the product.
    assert.equal(detectSignals(burst(5, 6000)).rage_click, undefined);
  });

  it('reading a long page', () => {
    const events: FrustrationEvent[] = Array.from({ length: 20 }, (_, i) => ({
      kind: 'scroll' as const,
      at: T + i * 300,
      delta: 120,
    }));
    // All one direction. Distance is not frustration.
    assert.equal(detectSignals(events).scroll_thrash, undefined);
  });

  it('a single form error', () => {
    const events: FrustrationEvent[] = [{ kind: 'form_error', at: T, target: 'signup' }];
    // Mistyping an email once is not distress.
    assert.equal(detectSignals(events).form_error_repeat, undefined);
  });

  it('two different forms each failing once', () => {
    const events: FrustrationEvent[] = [
      { kind: 'form_error', at: T, target: 'signup' },
      { kind: 'form_error', at: T + 100, target: 'billing' },
    ];
    assert.equal(detectSignals(events).form_error_repeat, undefined);
  });

  it('clicks in different places within the window', () => {
    const events: FrustrationEvent[] = [
      { kind: 'click', at: T, x: 10, y: 10 },
      { kind: 'click', at: T + 100, x: 400, y: 300 },
      { kind: 'click', at: T + 200, x: 800, y: 600 },
    ];
    // Fast, but moving. That is a person who knows where they are going.
    assert.equal(detectSignals(events).rage_click, undefined);
  });
});

describe('scoreFrustration', () => {
  it('is zero with nothing recorded', () => {
    assert.equal(scoreFrustration({}), 0);
  });

  it('is bounded by one, however much happens', () => {
    // The exponential asymptote reaches 1.0 exactly in floating point, which
    // is a fine value to mean "maximally frustrated" — the property that
    // matters is that nothing can exceed it and blow past the protocol's
    // normalized 0–1 range.
    const score = scoreFrustration({ dead_click: 500, rage_click: 500, reload: 500 });
    assert.ok(score <= 1 && score > 0.99, `got ${String(score)}`);
  });

  it('saturates rather than accumulating linearly', () => {
    const three = scoreFrustration({ dead_click: 3 });
    const thirty = scoreFrustration({ dead_click: 30 });
    // Thirty dead clicks is the same person still stuck, not ten times worse.
    assert.ok(thirty > three);
    assert.ok(thirty - three < three);
  });

  it('is monotone in every signal', () => {
    for (const signal of Object.keys(DEFAULT_WEIGHTS) as (keyof typeof DEFAULT_WEIGHTS)[]) {
      assert.ok(
        scoreFrustration({ [signal]: 2 }) > scoreFrustration({ [signal]: 1 }),
        `${signal} is not monotone`,
      );
    }
  });

  it('cannot reach the prompt threshold on scrolling alone', () => {
    // Weighted so the weakest evidence can never, by itself, interrupt anyone.
    assert.ok(scoreFrustration({ scroll_thrash: 3 }) < PROMPT_THRESHOLD);
  });

  it('reaches the threshold on a handful of dead clicks', () => {
    assert.ok(scoreFrustration({ dead_click: 2, rage_click: 1 }) >= PROMPT_THRESHOLD);
  });

  it('honours overridden weights', () => {
    assert.equal(scoreFrustration({ dead_click: 1 }, { dead_click: 0 }), 0);
  });

  it('ignores zero and negative counts', () => {
    assert.equal(scoreFrustration({ dead_click: 0, reload: -3 }), 0);
  });
});

describe('FrustrationTracker', () => {
  it('accumulates and scores', () => {
    const tracker = new FrustrationTracker();
    for (const event of burst(4, 150)) tracker.record(event);

    const snapshot = tracker.snapshot();
    assert.equal(snapshot.signals.rage_click, 1);
    assert.ok(snapshot.score > 0);
  });

  it('is bounded, because it lives as long as the page does', () => {
    const tracker = new FrustrationTracker({ maxEvents: 10 });
    for (let i = 0; i < 100; i++) {
      tracker.record({ kind: 'click', at: T + i * 5000, target: `#b${String(i)}` });
    }
    // An unbounded array of every click a user makes is a memory leak with a
    // plausible excuse.
    assert.equal(tracker.eventCount, 10);
  });

  it('only suggests prompting past the threshold', () => {
    const tracker = new FrustrationTracker();
    assert.equal(tracker.shouldPrompt(), false);

    for (const event of burst(4, 120)) tracker.record({ ...event, dead: true });
    assert.equal(tracker.shouldPrompt(), true);
  });

  it('forgets on reset', () => {
    const tracker = new FrustrationTracker();
    for (const event of burst(4, 150)) tracker.record(event);
    tracker.reset();

    assert.equal(tracker.eventCount, 0);
    assert.equal(tracker.snapshot().score, 0);
  });
});
