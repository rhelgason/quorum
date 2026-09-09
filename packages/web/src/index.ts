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

export { QuorumClient, SDK_VERSION } from './client.ts';
export type { QuorumClientOptions, SubmitInput, SubmitOutcome } from './client.ts';

export {
  countBursts,
  DEFAULT_WEIGHTS,
  detectSignals,
  FrustrationTracker,
  PROMPT_THRESHOLD,
  scoreFrustration,
} from './frustration.ts';
export type {
  FrustrationEvent,
  FrustrationOptions,
  FrustrationSnapshot,
  SignalCounts,
} from './frustration.ts';

export { listenForFrustration } from './frustration-dom.ts';
export type { FrustrationListener, FrustrationListenerOptions } from './frustration-dom.ts';

export { CAPTURED_PROPERTIES, describeElement, nodeFrom, reactComponentName, startPicking } from './picker.ts';
export type { DescribeOptions, PickerHandle, PickerOptions } from './picker.ts';

export {
  DEFAULT_TEST_ID_ATTRIBUTES,
  escapeIdentifier,
  looksGenerated,
  segmentFor,
  selectorFor,
  stableClasses,
} from './selector.ts';
export type { SelectorNode, SelectorOptions } from './selector.ts';

export { anonIdFor, createWebQueueStorage, webStorage } from './storage.ts';
export type { WebStorageLike } from './storage.ts';

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
