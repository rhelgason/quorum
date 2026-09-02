/**
 * `@quorum/core` — headless core.
 *
 * Currently exports the capture protocol and configuration contract only.
 * Transport, offline queue, capture, and the state machine implementation land
 * in v0.1; see `docs/ROADMAP.md`.
 *
 * Zero runtime dependencies, and it stays that way — core plus the nub have a
 * 15KB gzipped budget that CI enforces.
 */

export { PROTOCOL_VERSION } from './protocol.js';

export type {
  CaptureEnvelope,
  CaptureEvent,
  CapturePayload,
  ConsoleEntry,
  ContextBlock,
  ElementBlock,
  FrustrationBlock,
  FrustrationSignal,
  IngestAccepted,
  IngestError,
  NetworkEntry,
  Platform,
  RedactionBlock,
  SubmissionKind,
  SubmissionSource,
  UserBlock,
} from './protocol.js';

export type {
  CaptureConfig,
  FrustrationMode,
  OpenOptions,
  QueueConfig,
  QuorumConfig,
  RedactConfig,
} from './config.js';

export type {
  PanelState,
  QuorumEventMap,
  QuorumEventName,
} from './state.js';
