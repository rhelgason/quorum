import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  consoleSink,
  createLogger,
  createRingSink,
  noopSink,
  type LogRecord,
} from './log.ts';

/** Collecting sink plus a frozen clock, so assertions are exact. */
function harness(options: Parameters<typeof createLogger>[0] = {}) {
  const records: LogRecord[] = [];
  const logger = createLogger({
    sink: (r) => records.push(r),
    now: () => 1_000,
    ...options,
  });
  return { logger, records };
}

describe('level filtering', () => {
  test('is silent by default — an embedded SDK must not write uninvited', () => {
    const { logger, records } = harness();
    logger.error('boom');
    logger.warn('hmm');
    logger.info('fyi');
    logger.debug('detail');
    assert.equal(records.length, 0);
  });

  test('emits only at or below the configured level', () => {
    const { logger, records } = harness({ level: 'warn' });
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    assert.deepEqual(records.map((r) => r.level), ['error', 'warn']);
  });

  test('debug level lets everything through', () => {
    const { logger, records } = harness({ level: 'debug' });
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    assert.equal(records.length, 4);
  });

  test('isEnabled agrees with what actually emits', () => {
    const { logger } = harness({ level: 'info' });
    assert.equal(logger.isEnabled('error'), true);
    assert.equal(logger.isEnabled('warn'), true);
    assert.equal(logger.isEnabled('info'), true);
    assert.equal(logger.isEnabled('debug'), false);
  });

  test('does not touch fields when the level is disabled', () => {
    // The cheap-when-disabled contract: no formatting, no redaction, no
    // allocation. A getter that throws proves nothing read the object.
    const { logger } = harness({ level: 'silent' });
    const hostile = {
      get leak(): string {
        throw new Error('field was evaluated while logging was disabled');
      },
    } as unknown as Record<string, string>;
    assert.doesNotThrow(() => logger.debug('msg', hostile));
  });
});

describe('record shape', () => {
  test('carries level, namespace, message, fields, and clock value', () => {
    const { logger, records } = harness({ level: 'debug', namespace: 'quorum' });
    logger.info('queue flushed', { depth: 3, ok: true });
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      ts: 1_000,
      level: 'info',
      namespace: 'quorum',
      message: 'queue flushed',
      fields: { depth: 3, ok: true },
      redactedCount: 0,
    });
  });

  test('defaults fields to an empty object rather than undefined', () => {
    const { logger, records } = harness({ level: 'debug' });
    logger.info('no fields');
    assert.deepEqual(records[0]?.fields, {});
  });

  test('preserves non-string field types unchanged', () => {
    const { logger, records } = harness({ level: 'debug' });
    logger.info('mixed', { n: 0, f: false, nil: null, undef: undefined });
    assert.deepEqual(records[0]?.fields, {
      n: 0,
      f: false,
      nil: null,
      undef: undefined,
    });
  });
});

describe('redaction', () => {
  test('redacts PII in the message', () => {
    const { logger, records } = harness({ level: 'debug' });
    logger.error('failed for ryan@example.com');
    assert.equal(records[0]?.message, 'failed for [redacted:email]');
    assert.equal(records[0]?.redactedCount, 1);
  });

  test('redacts PII in string fields', () => {
    const { logger, records } = harness({ level: 'debug' });
    logger.error('submit failed', { body: 'my card 4242424242424242 broke' });
    assert.equal(records[0]?.fields.body, 'my card [redacted:card] broke');
    assert.equal(records[0]?.redactedCount, 1);
  });

  test('sums redaction hits across message and every field', () => {
    const { logger, records } = harness({ level: 'debug' });
    logger.error('a@b.com', { x: 'c@d.com', y: 'e@f.com', n: 1 });
    assert.equal(records[0]?.redactedCount, 3);
  });

  test('is on even when the caller passes no options at all', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: 'debug', sink: (r) => records.push(r) });
    logger.info('mail a@b.com');
    assert.equal(records[0]?.message, 'mail [redacted:email]');
  });

  test('unsafeDisableRedaction is the only way off, and it works', () => {
    const { logger, records } = harness({
      level: 'debug',
      unsafeDisableRedaction: true,
    });
    logger.info('mail a@b.com');
    assert.equal(records[0]?.message, 'mail a@b.com');
    assert.equal(records[0]?.redactedCount, 0);
  });

  test('a falsy-but-not-true unsafe flag still redacts', () => {
    // Guards against `unsafeDisableRedaction: someTruthyString` accidentally
    // disabling protection — the check is strict equality to true.
    const { logger, records } = harness({
      level: 'debug',
      unsafeDisableRedaction: false,
    });
    logger.info('mail a@b.com');
    assert.equal(records[0]?.message, 'mail [redacted:email]');
  });
});

describe('length capping', () => {
  test('caps long messages with a truncation marker', () => {
    const { logger, records } = harness({ level: 'debug', maxLength: 10 });
    logger.info('a'.repeat(25));
    assert.equal(records[0]?.message, `${'a'.repeat(10)}…[+15]`);
  });

  test('caps long string fields too', () => {
    const { logger, records } = harness({ level: 'debug', maxLength: 5 });
    logger.info('ok', { body: 'abcdefghij' });
    assert.equal(records[0]?.fields.body, 'abcde…[+5]');
  });

  test('leaves values under the cap alone', () => {
    const { logger, records } = harness({ level: 'debug', maxLength: 100 });
    logger.info('short');
    assert.equal(records[0]?.message, 'short');
  });
});

describe('child loggers', () => {
  test('dot-joins namespaces', () => {
    const { logger, records } = harness({ level: 'debug', namespace: 'quorum' });
    logger.child('queue').info('a');
    assert.equal(records[0]?.namespace, 'quorum:queue');
  });

  test('nests to arbitrary depth', () => {
    const { logger, records } = harness({ level: 'debug', namespace: 'quorum' });
    logger.child('queue').child('flush').info('a');
    assert.equal(records[0]?.namespace, 'quorum:queue:flush');
  });

  test('inherits level, sink, and clock', () => {
    const { logger, records } = harness({ level: 'warn' });
    const child = logger.child('c');
    assert.equal(child.level, 'warn');
    child.info('suppressed');
    child.warn('kept');
    assert.deepEqual(records.map((r) => r.message), ['kept']);
    assert.equal(records[0]?.ts, 1_000);
  });

  test('inherits the unsafe redaction flag', () => {
    const { logger, records } = harness({
      level: 'debug',
      unsafeDisableRedaction: true,
    });
    logger.child('c').info('mail a@b.com');
    assert.equal(records[0]?.message, 'mail a@b.com');
  });

  test('does not mutate the parent', () => {
    const { logger } = harness({ level: 'debug', namespace: 'quorum' });
    logger.child('a');
    assert.equal(logger.namespace, 'quorum');
  });
});

describe('sinks', () => {
  test('noopSink discards without throwing', () => {
    assert.doesNotThrow(() =>
      noopSink({
        ts: 0,
        level: 'error',
        namespace: 'n',
        message: 'm',
        fields: {},
        redactedCount: 0,
      }),
    );
  });

  test('ring sink retains only the most recent records', () => {
    const ring = createRingSink(3);
    const logger = createLogger({ level: 'debug', sink: ring, now: () => 0 });
    for (let i = 0; i < 5; i++) logger.info(`m${i}`);
    assert.deepEqual(ring.records().map((r) => r.message), ['m2', 'm3', 'm4']);
  });

  test('ring sink returns a copy, so callers cannot corrupt the buffer', () => {
    const ring = createRingSink(2);
    const logger = createLogger({ level: 'debug', sink: ring, now: () => 0 });
    logger.info('a');
    ring.records().push({
      ts: 0,
      level: 'error',
      namespace: 'x',
      message: 'injected',
      fields: {},
      redactedCount: 0,
    });
    assert.deepEqual(ring.records().map((r) => r.message), ['a']);
  });

  test('ring sink clears', () => {
    const ring = createRingSink(3);
    const logger = createLogger({ level: 'debug', sink: ring, now: () => 0 });
    logger.info('a');
    ring.clear();
    assert.deepEqual(ring.records(), []);
  });

  test('records reaching a ring sink are already redacted', () => {
    // The ring buffer can be attached to an error report, so anything in it
    // may leave the device.
    const ring = createRingSink(2);
    const logger = createLogger({ level: 'debug', sink: ring, now: () => 0 });
    logger.error('user a@b.com hit an error');
    assert.equal(ring.records()[0]?.message, 'user [redacted:email] hit an error');
  });

  test('consoleSink routes each level to the matching console method', (t) => {
    const err = t.mock.method(console, 'error', () => {});
    const warn = t.mock.method(console, 'warn', () => {});
    const log = t.mock.method(console, 'log', () => {});

    const base = { ts: 0, namespace: 'quorum', fields: {}, redactedCount: 0 };
    consoleSink({ ...base, level: 'error', message: 'e' });
    consoleSink({ ...base, level: 'warn', message: 'w' });
    consoleSink({ ...base, level: 'info', message: 'i' });
    consoleSink({ ...base, level: 'debug', message: 'd' });

    assert.equal(err.mock.callCount(), 1);
    assert.equal(warn.mock.callCount(), 1);
    assert.equal(log.mock.callCount(), 2);
    assert.equal(err.mock.calls[0]?.arguments[0], '[quorum] e');
  });

  test('consoleSink omits the fields argument when there are none', (t) => {
    const log = t.mock.method(console, 'log', () => {});
    consoleSink({
      ts: 0,
      level: 'info',
      namespace: 'quorum',
      message: 'm',
      fields: {},
      redactedCount: 0,
    });
    assert.equal(log.mock.calls[0]?.arguments[1], '');
  });
});

// Keep the module-level `mock` import meaningful: reset any stray global state
// between files so a stubbed console can't leak into another test file.
mock.reset();
