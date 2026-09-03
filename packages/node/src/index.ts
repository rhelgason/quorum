/**
 * `@quorum/node` — server-side ingest and the read API.
 *
 * No UI, and the fastest path to value: point it at a support inbox and get a
 * ranked list out of feedback you already have, without installing a widget.
 * It is also how an Express/Fastify/NestJS backend participates — piping
 * exceptions and tickets into the same canonical-issue store the widget writes
 * to, so they cluster against each other.
 *
 * Zero runtime dependencies, like everything else in this repo.
 */

export { Quorum } from './client.ts';
export type {
  CaptureContext,
  CaptureInput,
  CaptureResult,
  CsvColumns,
  ExceptionOptions,
  ImportCsvOptions,
  ImportOptions,
  ImportResult,
  ImportRow,
  QuorumOptions,
  UnattributedPolicy,
} from './client.ts';

export {
  buildIssues,
  DEFAULT_CONSOLIDATE_THRESHOLD,
  DEFAULT_ONLINE_THRESHOLD,
} from './issues.ts';
export type {
  BuildIssuesOptions,
  ConsolidateSettings,
  Issue,
  IssueQuote,
} from './issues.ts';

export { MemoryStore } from './store.ts';
export type { SubmissionStore } from './store.ts';

export { FileStore } from './file-store.ts';
export type { FileStoreOptions } from './file-store.ts';

export { derivedId, dedupKey, resolveUserId, scrubVariableData } from './submission.ts';
export type {
  Identity,
  ResolvedIdentity,
  Submission,
  SubmissionKind,
  SubmissionSource,
} from './submission.ts';

export {
  describeThrowable,
  exceptionClusterText,
  exceptionFallbackKey,
  fingerprint,
  parseFrames,
} from './exception.ts';
export type { ParsedFrame } from './exception.ts';

export { parseCsv, parseCsvRecords } from './csv.ts';
export type { CsvOptions } from './csv.ts';
