/**
 * Structured logging for `@quorum/core`.
 *
 * Three constraints make this different from a general-purpose logger, and all
 * three come from the fact that we run *inside someone else's application*:
 *
 *  1. **Silent by default.** A third-party SDK writing to a customer's console
 *     is a support ticket. Operational failures reach the customer through the
 *     public `error` event (see `state.ts`), which they opt into. The logger is
 *     for people debugging Quorum itself.
 *
 *  2. **Always redacted, no opt-out that isn't loud.** Logs flow into the
 *     customer's own observability pipeline, which is entirely outside our
 *     privacy controls — a leaked value there is unrecoverable. Every message
 *     and every string field goes through the same pattern scan as captured
 *     content (`redact.ts`). See `docs/adr/0007-redact-by-default.md`.
 *
 *  3. **Cheap when disabled.** The level check happens before any formatting,
 *     redaction, or object allocation, so a disabled `debug()` call costs one
 *     integer comparison. This matters for the 15KB/hot-path budget.
 */

import { cap, scan } from './redact.ts';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/** Scalars only. Anything richer is a sign user content is about to leak in. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface LogRecord {
  ts: number;
  level: Exclude<LogLevel, 'silent'>;
  /** Dot-joined, e.g. `quorum:queue:flush`. */
  namespace: string;
  message: string;
  fields: LogFields;
  /** Redaction hits across the message and all fields. 0 in the common case. */
  redactedCount: number;
}

export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  level?: LogLevel;
  namespace?: string;
  sink?: LogSink;
  /** Message and string-field length cap. Default 512. */
  maxLength?: number;
  /**
   * Disable pattern redaction. Named to be uncomfortable to type and to grep
   * for. Intended for local development against synthetic data only; it must
   * never be set in a shipped build.
   */
  unsafeDisableRedaction?: boolean;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /** Derive a namespaced logger sharing this one's level, sink, and clock. */
  child(namespace: string): Logger;
  /** Whether a level would currently emit. Guard expensive field construction. */
  isEnabled(level: Exclude<LogLevel, 'silent'>): boolean;
  readonly level: LogLevel;
  readonly namespace: string;
}

const DEFAULT_MAX_LENGTH = 512;

/**
 * Buffers the most recent `size` records, oldest evicted first.
 *
 * Used to attach recent SDK activity to an error report without ever having
 * written it to the customer's console.
 */
export type RingSink = LogSink & { records(): LogRecord[]; clear(): void };

export function createRingSink(size: number): RingSink {
  const buf: LogRecord[] = [];
  return Object.assign(
    (record: LogRecord): void => {
      buf.push(record);
      if (buf.length > size) buf.shift();
    },
    {
      records: (): LogRecord[] => buf.slice(),
      clear: (): void => {
        buf.length = 0;
      },
    },
  );
}

/** Emits to the host console. Never installed by default. */
export const consoleSink: LogSink = (record) => {
  const fields = Object.keys(record.fields).length > 0 ? record.fields : '';
  const line = `[${record.namespace}] ${record.message}`;
  if (record.level === 'error') console.error(line, fields);
  else if (record.level === 'warn') console.warn(line, fields);
  else console.log(line, fields);
};

/** Discards everything. The default. */
export const noopSink: LogSink = () => {};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'silent';
  const namespace = options.namespace ?? 'quorum';
  const sink = options.sink ?? noopSink;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const redactEnabled = options.unsafeDisableRedaction !== true;
  const now = options.now ?? Date.now;
  const threshold = LEVEL_ORDER[level];

  function clean(value: string): { text: string; hits: number } {
    // Cap first: pathological input shouldn't be scanned in full, and a value
    // long enough to need truncation is already suspect.
    const capped = cap(value, maxLength);
    if (!redactEnabled) return { text: capped, hits: 0 };
    const result = scan(capped);
    return { text: result.text, hits: result.total };
  }

  function emit(
    recordLevel: Exclude<LogLevel, 'silent'>,
    message: string,
    fields: LogFields | undefined,
  ): void {
    // Early return before any allocation — see constraint 3.
    if (LEVEL_ORDER[recordLevel] > threshold) return;

    const cleanedMessage = clean(message);
    let redactedCount = cleanedMessage.hits;

    const out: LogFields = {};
    if (fields !== undefined) {
      for (const key of Object.keys(fields)) {
        const value = fields[key];
        if (typeof value === 'string') {
          const cleaned = clean(value);
          out[key] = cleaned.text;
          redactedCount += cleaned.hits;
        } else {
          out[key] = value;
        }
      }
    }

    sink({
      ts: now(),
      level: recordLevel,
      namespace,
      message: cleanedMessage.text,
      fields: out,
      redactedCount,
    });
  }

  const logger: Logger = {
    level,
    namespace,
    error: (message, fields) => emit('error', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    info: (message, fields) => emit('info', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
    isEnabled: (l) => LEVEL_ORDER[l] <= threshold,
    child: (childNamespace) =>
      createLogger({
        ...options,
        level,
        namespace: `${namespace}:${childNamespace}`,
        sink,
        maxLength,
        now,
      }),
  };

  return logger;
}
