/**
 * `@quorum/web` — the `<quorum-nub>` custom element.
 *
 * One UI, N thin adapters (ADR-0002). The framework wrappers are prop→attribute
 * and event→callback shims over this, not reimplementations.
 *
 * Importing this module does **not** register the element. Call
 * `defineQuorumNub()`, or use the IIFE build, which does it for you. A library
 * that registers a global custom element as a side effect of being imported is
 * unusable inside anything that does its own bundling.
 */

export { defineQuorumNub, nubClass } from './nub.ts';
export type { QuorumNubElement } from './nub.ts';

export { DEFAULTS, parseAttributes } from './attributes.ts';
export type {
  AttributeReader,
  NubConfig,
  ParsedAttributes,
  Position,
  Preset,
} from './attributes.ts';

export { copyFor } from './copy.ts';
export type { PanelCopy } from './copy.ts';

export {
  formatShortcut,
  isTypingTarget,
  matchesShortcut,
  parseShortcut,
} from './shortcut.ts';
export type { Chord, KeyLike, TargetLike } from './shortcut.ts';

export { anchorRules, PRESETS, presetTokens, stylesheet } from './styles.ts';
