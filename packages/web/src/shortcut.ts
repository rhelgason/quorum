/**
 * Keyboard shortcut parsing and matching.
 *
 * Pure, and written against a structural subset of `KeyboardEvent` rather than
 * the DOM type, so the matching rules are testable without a browser. The
 * element passes real events straight in.
 */

export interface Chord {
  /** Lowercased single character or named key, e.g. `k`, `enter`, `/`. */
  key: string;
  /** Command on macOS, Control elsewhere. Resolved at match time, not parse time. */
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

/** The parts of a `KeyboardEvent` that matter here. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const MODIFIERS = new Set(['mod', 'ctrl', 'control', 'meta', 'cmd', 'command', 'shift', 'alt', 'option']);

/**
 * Parse `"mod+shift+k"`.
 *
 * Returns `undefined` for anything unparseable rather than throwing — a bad
 * `shortcut` attribute disables the shortcut, it does not break the host page.
 */
export function parseShortcut(spec: string): Chord | undefined {
  const parts = spec
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return undefined;

  const chord: Chord = { key: '', mod: false, ctrl: false, meta: false, shift: false, alt: false };

  for (const part of parts) {
    if (MODIFIERS.has(part)) {
      if (part === 'mod') chord.mod = true;
      else if (part === 'ctrl' || part === 'control') chord.ctrl = true;
      else if (part === 'meta' || part === 'cmd' || part === 'command') chord.meta = true;
      else if (part === 'shift') chord.shift = true;
      else chord.alt = true;
      continue;
    }
    // Two non-modifier keys is a typo, not a chord we should guess at.
    if (chord.key !== '') return undefined;
    chord.key = part;
  }

  if (chord.key === '') return undefined;
  return chord;
}

/**
 * Whether an event satisfies a chord.
 *
 * Modifiers are matched *exactly*, not as a subset. A user pressing
 * `Cmd+Shift+Alt+K` while some other tool listens for that combination should
 * not also trigger us — permissive matching is how two widgets end up fighting
 * over one keystroke on a page that embeds both.
 */
export function matchesShortcut(chord: Chord, event: KeyLike, isMac: boolean): boolean {
  if (event.key.toLowerCase() !== chord.key) return false;

  const wantCtrl = chord.ctrl || (chord.mod && !isMac);
  const wantMeta = chord.meta || (chord.mod && isMac);

  return (
    event.ctrlKey === wantCtrl &&
    event.metaKey === wantMeta &&
    event.shiftKey === chord.shift &&
    event.altKey === chord.alt
  );
}

/** The parts of an event target that decide whether the user is typing. */
export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/**
 * Whether a keystroke should be ignored because the user is typing into
 * something.
 *
 * Without this, a shortcut on a bare letter steals characters out of the
 * customer's own forms. Even with a modifier it matters: `Cmd+Shift+K` is
 * "delete line" in several editors, and a page embedding a code editor would
 * have us hijack it.
 */
export function isTypingTarget(target: TargetLike | null | undefined): boolean {
  if (target === null || target === undefined) return false;
  if (target.isContentEditable === true) return true;
  const tag = target.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

/** Render a chord for display, using the symbols each platform expects. */
export function formatShortcut(chord: Chord, isMac: boolean): string {
  const parts: string[] = [];
  if (chord.ctrl || (chord.mod && !isMac)) parts.push(isMac ? '⌃' : 'Ctrl');
  if (chord.alt) parts.push(isMac ? '⌥' : 'Alt');
  if (chord.shift) parts.push(isMac ? '⇧' : 'Shift');
  if (chord.meta || (chord.mod && isMac)) parts.push(isMac ? '⌘' : 'Win');
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return isMac ? parts.join('') : parts.join('+');
}
