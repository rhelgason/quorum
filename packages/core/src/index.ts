/**
 * `@quorum/core` — headless core.
 *
 * Implemented: the capture protocol contract, PII pattern redaction, and
 * structured logging. Transport, offline queue, capture, and the state machine
 * implementation land in v0.1; see `docs/ROADMAP.md`.
 *
 * Zero runtime dependencies, and it stays that way — core plus the nub have a
 * 15KB gzipped budget that CI enforces.
 */

export { PROTOCOL_VERSION } from './protocol.ts';

export {
  cap,
  DEFAULT_RULES,
  luhn,
  MARKER_PREFIX,
  scan,
} from './redact.ts';

export type {
  RedactionKind,
  RedactionRule,
  ScanResult,
} from './redact.ts';

export {
  consoleSink,
  createLogger,
  createRingSink,
  noopSink,
} from './log.ts';

export type {
  Logger,
  LoggerOptions,
  LogFields,
  LogLevel,
  LogRecord,
  LogSink,
  RingSink,
} from './log.ts';

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
} from './protocol.ts';

export type {
  CaptureConfig,
  FrustrationMode,
  OpenOptions,
  QueueConfig,
  QuorumConfig,
  RedactConfig,
} from './config.ts';

export type {
  PanelState,
  QuorumEventMap,
  QuorumEventName,
} from './state.ts';
