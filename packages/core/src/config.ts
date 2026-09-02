/**
 * Configuration surface for `@quorum/core`.
 *
 * Every default here is chosen so that the zero-config path is the safe path:
 * redaction on, replay off, frustration detection silent. See
 * `docs/adr/0007-redact-by-default.md` — a capture pipeline that is safe only
 * when configured correctly is unsafe, because it will be misconfigured.
 */

import type { SubmissionKind } from './protocol.js';

export interface CaptureConfig {
  /** rrweb-style DOM snapshot on web. Default: true. */
  dom?: boolean;
  /** Console ring buffer size, or false to disable. Default: 50. */
  console?: number | false;
  /** Method, path, status, duration. Bodies are never captured. Default: true. */
  network?: boolean;
  /**
   * Last ~15s of session replay. Default: false — deliberately. Customers who
   * want a session recorder in production must say so.
   */
  replay?: boolean;
  /** Customer-provided state snapshot, e.g. `() => store.getState()`. */
  state?: () => unknown;
}

export interface RedactConfig {
  /** Extra subtrees to drop entirely. Equivalent to `data-quorum-redact`. */
  selectors?: string[];
  /**
   * Fields to capture in the clear. This is the only way to *reduce*
   * redaction, and it is an explicit per-field decision by design.
   */
  unmask?: string[];
  /**
   * On-device pattern scan for card numbers, emails, tokens, and API keys.
   * `'default'` uses the built-in set; an array adds to it.
   *
   * `'off'` exists for customers whose content triggers constant false
   * positives, but it disables only the *net*, never the structural masking
   * that runs first.
   */
  patterns?: 'default' | 'off' | RegExp[];
}

export interface QueueConfig {
  /** Oldest-dropped eviction. Default: 100. */
  maxEvents?: number;
  /** Default: 1_000_000. Captures are dropped before envelopes. */
  maxBytes?: number;
}

/**
 * - `off` — collect nothing
 * - `detect` — record signals silently and attach them to submissions
 * - `prompt` — additionally nudge at threshold, non-modally, once per session
 *
 * There is no mode that shows a modal. See
 * `docs/adr/0010-never-interrupt-the-frustrated-user.md`.
 */
export type FrustrationMode = 'off' | 'detect' | 'prompt';

export interface QuorumConfig {
  /** Public key. Write-only; the secret key is server-side and never shipped. */
  project: string;
  /** Override for self-hosted deployments. */
  endpoint?: string;
  capture?: CaptureConfig;
  redact?: RedactConfig;
  queue?: QueueConfig;
  frustration?: FrustrationMode;
  /** Merged into `context.custom` on every subsequent event. */
  context?: Record<string, unknown>;
}

export interface OpenOptions {
  kind?: SubmissionKind;
  /** Lands in `context.custom` for this submission only. */
  context?: Record<string, unknown>;
  prefill?: string;
}
