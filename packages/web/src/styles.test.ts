import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { anchorRules, PRESETS, presetTokens, stylesheet } from './styles.ts';
import type { Position, Preset } from './attributes.ts';

const ALL_PRESETS: Preset[] = ['minimal', 'soft', 'sharp'];

describe('presets', () => {
  test('every preset defines the same token set', () => {
    // A preset missing a token renders an unstyled control rather than an
    // ugly one, because the var() has no fallback to fall back to.
    const expected = Object.keys(PRESETS.soft).sort();
    for (const preset of ALL_PRESETS) {
      assert.deepEqual(Object.keys(PRESETS[preset]).sort(), expected, preset);
    }
  });

  test('tokens are emitted as CSS custom properties', () => {
    const css = presetTokens('soft');
    assert.match(css, /--quorum-accent: #7c3aed;/);
    assert.match(css, /--quorum-radius: 12px;/);
  });

  test('each preset is a distinct stance, not a shade of the same one', () => {
    const radii = ALL_PRESETS.map((p) => PRESETS[p]['--quorum-radius']);
    assert.equal(new Set(radii).size, 3);
  });

  test('every token name is namespaced', () => {
    // These land on the host element, where a collision with the customer's
    // own custom properties would be invisible and maddening.
    for (const preset of ALL_PRESETS) {
      for (const name of Object.keys(PRESETS[preset])) {
        assert.match(name, /^--quorum-/, `${preset}: ${name}`);
      }
    }
  });
});

describe('anchoring', () => {
  test('each corner anchors to its two edges', () => {
    assert.match(anchorRules('bottom-right', 24), /bottom: 24px;/);
    assert.match(anchorRules('bottom-right', 24), /right: 24px;/);
    assert.match(anchorRules('top-left', 8), /top: 8px;/);
    assert.match(anchorRules('top-left', 8), /left: 8px;/);
  });

  test('hidden renders nothing at all', () => {
    // "bring your own trigger" — not a positioned but invisible button.
    assert.match(anchorRules('hidden', 24), /display: none;/);
  });

  test('the offset is applied verbatim', () => {
    assert.match(anchorRules('bottom-left', 0), /bottom: 0px;/);
  });
});

describe('stylesheet', () => {
  test('tokens are declared on :host so an outside rule wins', () => {
    // `quorum-nub { --quorum-accent: … }` from the page must override our
    // defaults. Setting them inline instead would break that cascade.
    const css = stylesheet('soft', 'bottom-right', 24);
    assert.match(css, /:host \{[\s\S]*--quorum-accent/);
  });

  test('every preset and position produces a stylesheet', () => {
    const positions: Position[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'hidden'];
    for (const preset of ALL_PRESETS) {
      for (const position of positions) {
        assert.ok(stylesheet(preset, position, 16).length > 0, `${preset}/${position}`);
      }
    }
  });

  test('reduced motion is honoured', () => {
    // A user who told their OS to stop animating things has already answered.
    assert.match(stylesheet('soft', 'bottom-right', 24), /prefers-reduced-motion: reduce/);
  });

  test('the z-index is high enough to sit above app chrome', () => {
    assert.match(stylesheet('soft', 'bottom-right', 24), /z-index: 2147483000/);
  });

  test('parts are styleable from outside', () => {
    // ::part() is the other half of the theming contract (ADR-0004).
    const css = stylesheet('soft', 'bottom-right', 24);
    for (const selector of ['.trigger', '.panel', '.field', '.submit']) {
      assert.ok(css.includes(selector), selector);
    }
  });

  test('a disabled submit is visibly disabled', () => {
    assert.match(stylesheet('soft', 'bottom-right', 24), /\.submit\[disabled\]/);
  });
});
