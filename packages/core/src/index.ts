/**
 * `@quorum/core` — headless core.
 *
 * Implemented: the capture protocol contract, PII pattern redaction,
 * structured logging, ULID generation, the bounded offline queue, and ingest
 * transport. DOM capture and the panel state machine land next; see
 * `docs/ROADMAP.md`.
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

export { createUlidFactory, isUlid, MAX_ULID_TIME, ulid, ulidTime } from './ulid.ts';
export type { UlidOptions } from './ulid.ts';

export { createMemoryStorage, OfflineQueue } from './queue.ts';
export type { QueueOptions, QueueStats, QueueStorage } from './queue.ts';

export { backoffDelay, parseRetryAfter, Transport } from './transport.ts';
export type { FlushResult, TransportOptions } from './transport.ts';

export { Emitter } from './emitter.ts';
export type { EmitterOptions, Listener } from './emitter.ts';

export { PanelMachine } from './panel.ts';
export type { PanelContext, PanelEvent, PanelOptions } from './panel.ts';

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
