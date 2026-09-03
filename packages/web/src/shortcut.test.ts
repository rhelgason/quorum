import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatShortcut,
  isTypingTarget,
  matchesShortcut,
  parseShortcut,
  type Chord,
  type KeyLike,
} from './shortcut.ts';

function press(key: string, mods: Partial<Omit<KeyLike, 'key'>> = {}): KeyLike {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods };
}

/** Parse or fail the test outright — these specs are all known-good. */
function chordFor(spec: string): Chord {
  const parsed = parseShortcut(spec);
  if (parsed === undefined) throw new Error(`unparseable test chord: ${spec}`);
  return parsed;
}

describe('parsing', () => {
  test('a full chord', () => {
    assert.deepEqual(parseShortcut('mod+shift+k'), {
      key: 'k',
      mod: true,
      ctrl: false,
      meta: false,
      shift: true,
      alt: false,
    });
  });

  test('a bare key', () => {
    assert.equal(parseShortcut('/')?.key, '/');
  });

  test('modifier aliases', () => {
    assert.equal(parseShortcut('control+k')?.ctrl, true);
    assert.equal(parseShortcut('cmd+k')?.meta, true);
    assert.equal(parseShortcut('command+k')?.meta, true);
    assert.equal(parseShortcut('option+k')?.alt, true);
  });

  test('whitespace and case are tolerated', () => {
    assert.deepEqual(parseShortcut(' Mod + Shift + K '), parseShortcut('mod+shift+k'));
  });

  test('two non-modifier keys is a typo, not a chord to guess at', () => {
    assert.equal(parseShortcut('k+j'), undefined);
  });

  test('modifiers with no key are rejected', () => {
    assert.equal(parseShortcut('mod+shift'), undefined);
  });

  test('empty input is rejected rather than throwing', () => {
    // A bad attribute disables the shortcut; it does not break the host page.
    assert.equal(parseShortcut(''), undefined);
    assert.equal(parseShortcut('+++'), undefined);
  });
});

describe('matching', () => {
  const chord = chordFor('mod+shift+k');

  test('mod is Command on macOS', () => {
    assert.equal(matchesShortcut(chord, press('k', { metaKey: true, shiftKey: true }), true), true);
    assert.equal(matchesShortcut(chord, press('k', { ctrlKey: true, shiftKey: true }), true), false);
  });

  test('mod is Control everywhere else', () => {
    assert.equal(matchesShortcut(chord, press('k', { ctrlKey: true, shiftKey: true }), false), true);
    assert.equal(matchesShortcut(chord, press('k', { metaKey: true, shiftKey: true }), false), false);
  });

  test('the key must match', () => {
    assert.equal(matchesShortcut(chord, press('j', { metaKey: true, shiftKey: true }), true), false);
  });

  test('key comparison is case-insensitive', () => {
    // Shift is held, so the browser reports "K".
    assert.equal(matchesShortcut(chord, press('K', { metaKey: true, shiftKey: true }), true), true);
  });

  test('extra modifiers do not match', () => {
    // Permissive matching is how two widgets on one page fight over a keystroke.
    assert.equal(
      matchesShortcut(chord, press('k', { metaKey: true, shiftKey: true, altKey: true }), true),
      false,
    );
  });

  test('missing modifiers do not match', () => {
    assert.equal(matchesShortcut(chord, press('k'), true), false);
  });

  test('an explicit ctrl chord ignores the platform', () => {
    const ctrlChord = chordFor('ctrl+k');
    assert.equal(matchesShortcut(ctrlChord, press('k', { ctrlKey: true }), true), true);
    assert.equal(matchesShortcut(ctrlChord, press('k', { ctrlKey: true }), false), true);
  });
});

describe('typing targets', () => {
  test('inputs, textareas, and selects are protected', () => {
    // Otherwise a shortcut steals characters out of the customer's own forms.
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
      assert.equal(isTypingTarget({ tagName }), true, tagName);
    }
  });

  test('contenteditable is protected', () => {
    assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  });

  test('ordinary elements are not', () => {
    assert.equal(isTypingTarget({ tagName: 'DIV' }), false);
    assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false);
  });

  test('a null target is not a typing target', () => {
    assert.equal(isTypingTarget(null), false);
    assert.equal(isTypingTarget(undefined), false);
    assert.equal(isTypingTarget({}), false);
  });
});

describe('formatting', () => {
  test('macOS uses symbols with no separator', () => {
    const chord = chordFor('mod+shift+k');
    assert.equal(formatShortcut(chord, true), '⇧⌘K');
  });

  test('other platforms spell the modifiers out', () => {
    const chord = chordFor('mod+shift+k');
    assert.equal(formatShortcut(chord, false), 'Ctrl+Shift+K');
  });

  test('a named key keeps its name', () => {
    const chord = chordFor('mod+enter');
    assert.equal(formatShortcut(chord, false), 'Ctrl+enter');
  });

  test('alt is included', () => {
    const chord = chordFor('alt+k');
    assert.equal(formatShortcut(chord, true), '⌥K');
  });
});
