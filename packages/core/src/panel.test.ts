import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PanelMachine, type PanelEvent, type PanelOptions } from './panel.ts';
import type { PanelState } from './state.ts';

const ELEMENT = { selector: 'div.cart > button', component: 'CheckoutSubmitButton' };

/** Drive the machine to a state through the ordinary happy path. */
function machineAt(state: PanelState, options: PanelOptions = {}): PanelMachine {
  const m = new PanelMachine(options);
  const path: PanelEvent[] = [
    { type: 'open' },
    { type: 'ready' },
    { type: 'edit', draft: 'the pay button does nothing' },
    { type: 'submit', id: '01J' },
    { type: 'captured' },
    { type: 'accepted' },
  ];
  for (const event of path) {
    if (m.state === state) return m;
    m.send(event);
  }
  return m;
}

describe('the happy path', () => {
  test('walks idle → opening → composing → capturing → submitting → done', () => {
    const m = new PanelMachine();
    const states: PanelState[] = [m.state];
    m.on('stateChange', ({ to }) => states.push(to));

    m.send({ type: 'open' });
    m.send({ type: 'ready' });
    m.send({ type: 'edit', draft: 'please add dark mode' });
    m.send({ type: 'submit', id: '01J' });
    m.send({ type: 'captured' });
    m.send({ type: 'accepted' });

    assert.deepEqual(states, ['idle', 'opening', 'composing', 'capturing', 'submitting', 'done']);
  });

  test('capture disabled skips straight to submitting', () => {
    // A headless integration should not pass through a state that does nothing.
    const m = new PanelMachine({ capture: false });
    m.send({ type: 'open' });
    m.send({ type: 'ready' });
    m.send({ type: 'edit', draft: 'x' });
    m.send({ type: 'submit', id: '01J' });
    assert.equal(m.state, 'submitting');
  });

  test('an offline submit lands in queued, not error', () => {
    const m = machineAt('submitting');
    m.send({ type: 'enqueued', queueDepth: 3 });
    assert.equal(m.state, 'queued');
    assert.equal(m.context.queueDepth, 3);
  });

  test('send reports whether the event applied', () => {
    const m = new PanelMachine();
    assert.equal(m.send({ type: 'open' }), true);
    assert.equal(m.send({ type: 'accepted' }), false);
  });
});

describe('open', () => {
  test('open options seed kind, prefill, and context', () => {
    const m = new PanelMachine();
    m.send({ type: 'open', options: { kind: 'bug', prefill: 'Payment failed on ', context: { orderId: 'A-1' } } });
    assert.equal(m.context.kind, 'bug');
    assert.equal(m.context.draft, 'Payment failed on ');
    assert.deepEqual(m.context.custom, { orderId: 'A-1' });
  });

  test('the configured default kind applies when none is given', () => {
    const m = new PanelMachine({ defaultKind: 'bug' });
    m.send({ type: 'open' });
    assert.equal(m.context.kind, 'bug');
  });

  test('reopening after a submission starts a fresh draft', () => {
    // A user who submits, reads the thanks, then clicks the nub again is
    // starting a new submission — not resuming the old one.
    const m = machineAt('done');
    m.send({ type: 'open' });
    assert.equal(m.state, 'opening');
    assert.equal(m.context.draft, '');
    assert.equal(m.context.submissionId, undefined);
  });

  test('reopening works from queued and error too', () => {
    for (const state of ['queued', 'error'] as const) {
      const m = state === 'queued' ? machineAt('submitting') : new PanelMachine();
      if (state === 'queued') m.send({ type: 'enqueued', queueDepth: 1 });
      else {
        m.send({ type: 'open' });
        m.send({ type: 'failed', error: new Error('x') });
      }
      assert.equal(m.state, state);
      assert.equal(m.send({ type: 'open' }), true);
      assert.equal(m.state, 'opening');
    }
  });

  test('open is ignored while the panel is already open', () => {
    const m = machineAt('composing');
    m.send({ type: 'edit', draft: 'half-written thought' });
    assert.equal(m.send({ type: 'open' }), false);
    assert.equal(m.context.draft, 'half-written thought');
  });
});

describe('close', () => {
  test('closing is legal from every non-idle state', () => {
    for (const state of ['opening', 'composing', 'picking', 'capturing', 'submitting', 'done'] as const) {
      const m = state === 'picking' ? machineAt('composing') : machineAt(state);
      if (state === 'picking') m.send({ type: 'pick' });
      assert.equal(m.state, state, `failed to reach ${state}`);
      assert.equal(m.send({ type: 'close' }), true, `close rejected from ${state}`);
      assert.equal(m.state, 'idle');
    }
  });

  test('closing mid-submit is safe because the queue already persisted it', () => {
    // The machine abandoning the flow does not abandon the submission —
    // queue.ts writes before any network attempt. Without persist-before-send
    // this transition would be a data-loss bug.
    const m = machineAt('submitting');
    m.send({ type: 'close' });
    assert.equal(m.state, 'idle');
  });

  test('closing clears the draft', () => {
    const m = machineAt('composing');
    m.send({ type: 'edit', draft: 'secret' });
    m.send({ type: 'close' });
    assert.equal(m.context.draft, '');
  });

  test('closing from idle is a no-op', () => {
    assert.equal(new PanelMachine().send({ type: 'close' }), false);
  });

  test('the close reason is reported and defaults to user', () => {
    const reasons: string[] = [];
    const m = machineAt('composing');
    m.on('close', ({ reason }) => reasons.push(reason));
    m.send({ type: 'close' });

    const m2 = machineAt('composing');
    m2.on('close', ({ reason }) => reasons.push(reason));
    m2.send({ type: 'close', reason: 'programmatic' });

    assert.deepEqual(reasons, ['user', 'programmatic']);
  });
});

describe('the submit guard', () => {
  test('an empty draft cannot be submitted', () => {
    const m = machineAt('composing');
    assert.equal(m.canSubmit, false);
    assert.equal(m.send({ type: 'submit', id: '01J' }), false);
    assert.equal(m.state, 'composing');
  });

  test('whitespace is not content', () => {
    const m = machineAt('composing');
    m.send({ type: 'edit', draft: '   \n  ' });
    assert.equal(m.canSubmit, false);
  });

  test('a picked element is submittable with no text', () => {
    // "This button is broken" needs no prose — the selector is the report.
    const m = machineAt('composing');
    m.send({ type: 'pick' });
    m.send({ type: 'picked', element: ELEMENT });
    assert.equal(m.canSubmit, true);
  });

  test('a rage report is submittable with no text', () => {
    // PROTOCOL rule 4: a shake with no body is valid and useful.
    const m = machineAt('composing');
    m.send({ type: 'setKind', kind: 'rage' });
    assert.equal(m.canSubmit, true);
  });

  test('canSubmit is false outside composing', () => {
    assert.equal(new PanelMachine().canSubmit, false);
    assert.equal(machineAt('done').canSubmit, false);
  });

  test('a double-clicked send button submits once', () => {
    // A routine race in a real UI. It must not throw and must not double-send.
    const m = machineAt('composing');
    m.send({ type: 'edit', draft: 'x' });
    const ids: string[] = [];
    m.on('submit', ({ id }) => ids.push(id));
    assert.equal(m.send({ type: 'submit', id: '01J' }), true);
    assert.equal(m.send({ type: 'submit', id: '01K' }), false);
    assert.deepEqual(ids, ['01J']);
  });
});

describe('the element picker detour', () => {
  test('picking preserves the draft', () => {
    const m = machineAt('composing');
    m.send({ type: 'edit', draft: 'this thing is broken' });
    m.send({ type: 'pick' });
    assert.equal(m.state, 'picking');
    m.send({ type: 'picked', element: ELEMENT });
    assert.equal(m.state, 'composing');
    assert.equal(m.context.draft, 'this thing is broken');
    assert.deepEqual(m.context.element, ELEMENT);
  });

  test('cancelling the picker returns to composing with no element', () => {
    const m = machineAt('composing');
    m.send({ type: 'pick' });
    m.send({ type: 'pickCancelled' });
    assert.equal(m.state, 'composing');
    assert.equal(m.context.element, undefined);
  });

  test('editing is ignored while picking', () => {
    const m = machineAt('composing');
    m.send({ type: 'edit', draft: 'kept' });
    m.send({ type: 'pick' });
    assert.equal(m.send({ type: 'edit', draft: 'lost' }), false);
    assert.equal(m.context.draft, 'kept');
  });
});

describe('failure handling', () => {
  test('a failed capture still submits', () => {
    // PROTOCOL decouples them: the envelope must land, the attachment is
    // best-effort. Throwing away a written submission to save a screenshot is
    // backwards.
    const m = machineAt('capturing');
    m.send({ type: 'captureFailed', error: new Error('canvas tainted') });
    assert.equal(m.state, 'submitting');
  });

  test('a failed capture is not reported as an error to the host', () => {
    const m = machineAt('capturing');
    let errors = 0;
    m.on('error', () => errors++);
    m.send({ type: 'captureFailed', error: new Error('x') });
    assert.equal(errors, 0);
  });

  test('a failed submit keeps the draft for retry', () => {
    // Losing a paragraph of typed feedback to a network blip is the fastest
    // way to never receive that feedback again.
    const m = machineAt('composing');
    m.send({ type: 'edit', draft: 'a long carefully written report' });
    m.send({ type: 'submit', id: '01J' });
    m.send({ type: 'captured' });
    m.send({ type: 'failed', error: new Error('offline') });

    assert.equal(m.state, 'error');
    m.send({ type: 'retry' });
    assert.equal(m.state, 'composing');
    assert.equal(m.context.draft, 'a long carefully written report');
  });

  test('retry clears the previous error', () => {
    const m = machineAt('submitting');
    m.send({ type: 'failed', error: new Error('offline') });
    assert.ok(m.context.error !== undefined);
    m.send({ type: 'retry' });
    assert.equal(m.context.error, undefined);
  });

  test('a submit failure is recoverable by default, an open failure is not', () => {
    const seen: boolean[] = [];

    const submitting = machineAt('submitting');
    submitting.on('error', ({ recoverable }) => seen.push(recoverable));
    submitting.send({ type: 'failed', error: new Error('x') });

    const opening = new PanelMachine();
    opening.send({ type: 'open' });
    opening.on('error', ({ recoverable }) => seen.push(recoverable));
    opening.send({ type: 'failed', error: new Error('bad project key') });

    assert.deepEqual(seen, [true, false]);
  });

  test('an explicit recoverable flag wins', () => {
    const m = machineAt('submitting');
    const seen: boolean[] = [];
    m.on('error', ({ recoverable }) => seen.push(recoverable));
    m.send({ type: 'failed', error: new Error('400'), recoverable: false });
    assert.deepEqual(seen, [false]);
  });
});

describe('emitted events', () => {
  test('submit reports the id before the network round trip', () => {
    // The id is client-generated, so a host can correlate immediately rather
    // than waiting for an ack that may never come.
    const m = machineAt('composing');
    m.send({ type: 'edit', draft: 'x' });
    const ids: string[] = [];
    m.on('submit', ({ id }) => ids.push(id));
    m.send({ type: 'submit', id: '01JABC' });
    assert.deepEqual(ids, ['01JABC']);
  });

  test('queued reports the id and depth', () => {
    const m = machineAt('submitting');
    const seen: { id: string; queueDepth: number }[] = [];
    m.on('queued', (p) => seen.push(p));
    m.send({ type: 'enqueued', queueDepth: 7 });
    assert.deepEqual(seen, [{ id: '01J', queueDepth: 7 }]);
  });

  test('open reports the kind', () => {
    const m = new PanelMachine();
    const kinds: (string | undefined)[] = [];
    m.on('open', ({ kind }) => kinds.push(kind));
    m.send({ type: 'open', options: { kind: 'bug' } });
    assert.deepEqual(kinds, ['bug']);
  });

  test('stateChange fires only on an actual change', () => {
    // `edit` re-enters composing; a view re-rendering on every keystroke
    // because of a self-transition is a performance bug in the host.
    const m = machineAt('composing');
    let changes = 0;
    m.on('stateChange', () => changes++);
    m.send({ type: 'edit', draft: 'a' });
    m.send({ type: 'edit', draft: 'ab' });
    assert.equal(changes, 0);
  });

  test('an ignored event emits nothing', () => {
    const m = new PanelMachine();
    let events = 0;
    for (const name of ['open', 'close', 'submit', 'queued', 'error', 'stateChange'] as const) {
      m.on(name, () => events++);
    }
    m.send({ type: 'accepted' });
    assert.equal(events, 0);
  });

  test('off unsubscribes', () => {
    const m = new PanelMachine();
    let calls = 0;
    const handler = (): void => void calls++;
    m.on('open', handler);
    m.off('open', handler);
    m.send({ type: 'open' });
    assert.equal(calls, 0);
  });
});

describe('illegal transitions are ignored, never thrown', () => {
  test('an out-of-order event in any state is refused without throwing', () => {
    // Opinion 1. This runs inside somebody else's production app: a late ack
    // arriving after the user closed, or a stray retry, is a routine race.
    const states: PanelState[] = ['idle', 'opening', 'composing', 'capturing', 'submitting', 'done'];
    const nonsense: PanelEvent[] = [
      { type: 'ready' },
      { type: 'picked', element: ELEMENT },
      { type: 'pickCancelled' },
      { type: 'captured' },
      { type: 'accepted' },
      { type: 'retry' },
      { type: 'enqueued', queueDepth: 1 },
    ];

    for (const state of states) {
      for (const event of nonsense) {
        const m = machineAt(state);
        const applied = (): boolean => m.send(event);
        assert.doesNotThrow(applied, `${event.type} threw in ${state}`);
        // Whatever the outcome, the machine is never left in an invalid state.
        assert.ok(states.includes(m.state) || m.state === 'picking' || m.state === 'queued' || m.state === 'error');
      }
    }
  });

  test('a picked event outside the picker is ignored', () => {
    const m = machineAt('composing');
    assert.equal(m.send({ type: 'picked', element: ELEMENT }), false);
    assert.equal(m.context.element, undefined);
  });

  test('retry outside the error state is ignored', () => {
    assert.equal(machineAt('composing').send({ type: 'retry' }), false);
  });

  test('a terminal state ignores everything but open and close', () => {
    for (const state of ['done', 'queued'] as const) {
      const m = state === 'done' ? machineAt('done') : machineAt('submitting');
      if (state === 'queued') m.send({ type: 'enqueued', queueDepth: 1 });
      assert.equal(m.send({ type: 'ready' }), false);
      assert.equal(m.send({ type: 'accepted' }), false);
      assert.equal(m.state, state);
    }
  });
});

describe('context is not reachable from outside', () => {
  test('mutating the returned context does not affect the machine', () => {
    const m = machineAt('composing');
    m.send({ type: 'edit', draft: 'original' });
    const stolen = m.context;
    stolen.draft = 'tampered';
    assert.equal(m.context.draft, 'original');
  });
});
