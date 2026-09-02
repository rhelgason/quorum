/**
 * The Quorum capture protocol — the wire contract between every client (web,
 * iOS, Android, server-side) and ingest.
 *
 * This is the one contract that outlives individual packages, so it is
 * versioned independently of them. See `docs/PROTOCOL.md` for the rationale
 * behind each rule; the short version:
 *
 *  1. One envelope, every platform. Platforms differ only in which optional
 *     blocks they populate, so ingest has exactly one parser.
 *  2. Additive-only within a major. Clients in the wild are old clients.
 *  3. Redaction happens on-device, before serialization. A payload should
 *     never have contained the secret in the first place.
 *  4. Structural fields are first-class, never `metadata` soup — `route` and
 *     `appVersion` drive clustering, and burying them in a free-form bag
 *     guarantees inconsistent keys across customers.
 */

/** Bumped only for removals and retypes. New optional fields ship freely. */
export const PROTOCOL_VERSION = 0 as const;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type Platform = 'web' | 'ios' | 'android' | 'server';

export type SubmissionKind =
  | 'feature_request'
  | 'bug'
  | 'praise'
  | 'question'
  /** Shake or high frustration with no text — still a signal. */
  | 'rage';

/**
 * How the submission was initiated.
 *
 * Not cosmetic: `frustration_prompt` submissions have systematically different
 * quality than `nub` ones, and both ranking and clustering read this.
 */
export type SubmissionSource =
  | 'nub'
  | 'shortcut'
  | 'picker'
  | 'selection'
  | 'frustration_prompt'
  | 'shake'
  | 'api'
  | 'import'
  | 'support_inbox';

/** Passive web signals that feed the frustration score. */
export type FrustrationSignal =
  | 'dead_click'
  | 'rage_click'
  | 'nav_thrash'
  | 'scroll_thrash'
  | 'form_error_repeat'
  | 'reload'
  | 'console_error_spike'
  | 'escape_mash';

// ---------------------------------------------------------------------------
// Event blocks
// ---------------------------------------------------------------------------

export interface UserBlock {
  /** From `quorum.identify()`. Absent when the user is anonymous. */
  externalId?: string;
  /** First-party, per-project, trivially clearable. Never a fingerprint. */
  anonId?: string;
  /**
   * Feeds `account_weight` and therefore ranking. Without this, prioritization
   * degrades to a raw popularity contest.
   */
  traits?: Record<string, string | number | boolean | null>;
}

export interface ContextBlock {
  /** `/checkout/payment` on web, `CheckoutViewController` on mobile. */
  route?: string;
  appVersion?: string;
  sdkVersion?: string;
  platform?: Platform;
  osVersion?: string;
  device?: string;
  locale?: string;
  /** `[width, height]` in CSS pixels. */
  viewport?: [number, number];
  /** Caller-supplied, from `quorum.open({ context })`. */
  custom?: Record<string, unknown>;
}

/**
 * Element picker output. This is the web's killer capture: not a screenshot
 * but a jump-to-line.
 */
export interface ElementBlock {
  selector: string;
  /** `[x, y, width, height]`, viewport-relative at capture time. */
  bbox?: [number, number, number, number];
  /** Read off framework internals where available, e.g. React fiber. */
  component?: string;
  /** Only properties relevant to why it might be broken. */
  computed?: Record<string, string>;
}

export interface FrustrationBlock {
  /** Normalized 0–1. */
  score: number;
  /** Signal name to observed count, e.g. `{ dead_click: 3, reload: 2 }`. */
  signals: Partial<Record<FrustrationSignal, number>>;
}

/**
 * What redaction actually did. Shipped on every envelope so a customer audit
 * can verify the policy that was applied, rather than trusting our word.
 */
export interface RedactionBlock {
  rules: string[];
  maskedCount: number;
}

// ---------------------------------------------------------------------------
// Event & envelope
// ---------------------------------------------------------------------------

export interface CaptureEvent {
  /**
   * Client-generated ULID. Doubles as the idempotency key — ingest treats
   * `(project, id)` as unique and returns 200 on replay, which is what makes
   * the offline queue safely retryable.
   */
  id: string;
  kind: SubmissionKind;
  source: SubmissionSource;

  /**
   * When the user actually submitted. May precede `receivedAt` by days after
   * an offline flush.
   *
   * Recency decay and burst detection must key on this, not on server receipt
   * time — otherwise a backlog flush is misread as a spike.
   */
  clientTs: string;

  /** Verbatim. Never rewritten, never normalized in place. */
  body?: string;

  user?: UserBlock;
  context?: ContextBlock;
  element?: ElementBlock;
  frustration?: FrustrationBlock;
  redaction?: RedactionBlock;

  /**
   * Client-generated reference to a capture uploaded out of band. The
   * submission is durable once the envelope is ACKed, whether or not the
   * capture ever arrives.
   */
  captureRef?: string;
}

export interface CaptureEnvelope {
  v: typeof PROTOCOL_VERSION;
  sentAt: string;
  /** Public key. Safe to embed in a client bundle; it can only write. */
  project: string;
  /** Batched — an offline flush may carry many. */
  events: CaptureEvent[];
}

// ---------------------------------------------------------------------------
// Capture payload (uploaded separately from the envelope)
// ---------------------------------------------------------------------------

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  /** Milliseconds relative to capture time; negative values are in the past. */
  ts: number;
  message: string;
}

export interface NetworkEntry {
  method: string;
  /** Path only. Query values are stripped; keys are retained. */
  url: string;
  status?: number;
  durationMs?: number;
}

/**
 * Bodies are never included — see `docs/PRIVACY.md`. On web, `dom` is an
 * rrweb-format snapshot rather than an image; on mobile it is a screenshot
 * redacted before the buffer left the process.
 */
export interface CapturePayload {
  v: typeof PROTOCOL_VERSION;
  id: string;
  dom?: string;
  /** Last ~15s. Opt-in, off by default. */
  replay?: string;
  /** Mobile only. */
  screenshot?: string;
  console?: ConsoleEntry[];
  network?: NetworkEntry[];
  /** From the customer-provided state snapshot hook. */
  appState?: unknown;
}

// ---------------------------------------------------------------------------
// Ingest responses
// ---------------------------------------------------------------------------

export interface IngestAccepted {
  accepted: string[];
  /** Already-seen ids. Success, not failure — dequeue them. */
  duplicate: string[];
}

export interface IngestError {
  error: string;
  message: string;
  /** Present on 429. */
  retryAfterMs?: number;
}
