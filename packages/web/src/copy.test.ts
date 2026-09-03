import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { copyFor } from './copy.ts';
import type { PanelState } from '../../core/src/state.ts';
import type { SubmissionKind } from '../../core/src/protocol.ts';

const STATES: PanelState[] = [
  'idle',
  'opening',
  'composing',
  'picking',
  'capturing',
  'submitting',
  'queued',
  'done',
  'error',
];

const KINDS: SubmissionKind[] = ['feature_request', 'bug', 'praise', 'question', 'rage'];

describe('completeness', () => {
  test('every state and kind produces usable copy', () => {
    // A missing case renders a blank panel, which is unrecoverable for a user.
    for (const state of STATES) {
      for (const kind of KINDS) {
        const copy = copyFor(state, kind);
        assert.ok(copy.heading.length > 0, `${state}/${kind} heading`);
        assert.ok(copy.submit.length > 0, `${state}/${kind} submit`);
        assert.ok(copy.cancel.length > 0, `${state}/${kind} cancel`);
      }
    }
  });
});

describe('the default flow asks what to change', () => {
  test('feature_request does not ask what is broken', () => {
    // ADR-0012: bugs are one input, not the entry point.
    const copy = copyFor('composing', 'feature_request');
    assert.match(copy.heading, /would you change/i);
  });

  test('bug and rage ask what is not working', () => {
    assert.match(copyFor('composing', 'bug').heading, /not working/i);
    assert.match(copyFor('composing', 'rage').heading, /not working/i);
  });

  test('rage makes clear that text is optional', () => {
    // PROTOCOL rule 4: a shake with no body is valid and useful.
    assert.match(copyFor('composing', 'rage').placeholder, /optional/i);
  });
});

describe('terminal states', () => {
  test('done hides the composer', () => {
    assert.equal(copyFor('done', 'bug').showComposer, false);
  });

  test('queued says what actually happened', () => {
    // "Failed to send" would be a lie and so would "Sent".
    const copy = copyFor('queued', 'bug');
    assert.equal(copy.showComposer, false);
    assert.match(copy.heading, /online/i);
  });

  test('done implies a human will see it', () => {
    // A thank-you that implies nothing happens next teaches people not to
    // bother a second time.
    assert.match(copyFor('done', 'bug').heading, /logged/i);
  });
});

describe('in-flight and error states', () => {
  test('submitting and capturing both read as sending', () => {
    for (const state of ['capturing', 'submitting'] as const) {
      assert.match(copyFor(state, 'bug').submit, /sending/i);
    }
  });

  test('error offers a retry and promises the text survived', () => {
    const copy = copyFor('error', 'bug');
    assert.match(copy.submit, /try again/i);
    assert.match(copy.status, /still here/i);
    assert.equal(copy.showComposer, true);
  });

  test('picking explains how to get out', () => {
    assert.match(copyFor('picking', 'bug').status, /escape/i);
  });

  test('composing has no status line to clutter the panel', () => {
    assert.equal(copyFor('composing', 'bug').status, '');
  });
});
