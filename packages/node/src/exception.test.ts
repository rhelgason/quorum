import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeThrowable,
  exceptionClusterText,
  exceptionFallbackKey,
  fingerprint,
  parseFrames,
} from './exception.ts';

const STACK_A = `TypeError: Cannot read properties of undefined (reading 'total')
    at computeTotal (/app/src/cart.js:42:18)
    at checkout (/app/src/checkout.js:11:5)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)`;

// Same defect, different deploy: different absolute paths and shifted lines.
const STACK_A_ELSEWHERE = `TypeError: Cannot read properties of undefined (reading 'total')
    at computeTotal (/var/task/src/cart.js:57:22)
    at checkout (/var/task/src/checkout.js:13:5)
    at node:internal/main/run_main_module:23:47`;

const STACK_B = `TypeError: Cannot read properties of undefined (reading 'total')
    at renderInvoice (/app/src/invoice.js:8:3)`;

describe('frame parsing', () => {
  test('function name and file basename are kept', () => {
    assert.deepEqual(parseFrames(STACK_A)[0], { fn: 'computeTotal', file: 'cart.js' });
  });

  test('absolute paths are reduced to a basename', () => {
    // /app/src/cart.js in a container, /var/task/... on Lambda. Same file.
    assert.equal(parseFrames(STACK_A_ELSEWHERE)[0]?.file, 'cart.js');
  });

  test('line and column numbers are dropped', () => {
    // Otherwise a defect changes identity when someone adds a comment above it.
    assert.equal(parseFrames(STACK_A)[0]?.file, 'cart.js');
    assert.equal(parseFrames(STACK_A_ELSEWHERE)[0]?.file, 'cart.js');
  });

  test('runtime-internal frames are excluded', () => {
    // They are identical for every error ever thrown and add false similarity.
    const files = parseFrames(STACK_A).map((f) => f.file);
    assert.equal(files.some((f) => f.includes('task_queues')), false);
  });

  test('a bare location frame with no function name is anonymous', () => {
    const frames = parseFrames('Error: x\n    at /app/src/handler.js:3:1');
    assert.deepEqual(frames[0], { fn: '<anonymous>', file: 'handler.js' });
  });

  test('a file:// url frame is reduced to the basename', () => {
    const frames = parseFrames('Error: x\n    at run (file:///app/src/main.js:1:1)');
    assert.equal(frames[0]?.file, 'main.js');
  });

  test('a bundle query suffix is stripped', () => {
    const frames = parseFrames('Error: x\n    at run (/app/bundle.js?v=3:1:1)');
    assert.equal(frames[0]?.file, 'bundle.js');
  });

  test('synthetic V8 frames with no path are excluded', () => {
    // `at async Promise.all (index 0)` — the index varies with unrelated
    // concurrency, so a defect's identity would depend on how many promises
    // happened to be in flight when it threw.
    const frames = parseFrames('Error: x\n    at async Promise.all (index 0)\n    at run (/app/a.js:1:1)');
    assert.deepEqual(frames.map((f) => f.file), ['a.js']);
  });

  test('no stack yields no frames', () => {
    assert.deepEqual(parseFrames(undefined), []);
    assert.deepEqual(parseFrames(''), []);
  });

  test('the message line is not mistaken for a frame', () => {
    assert.equal(parseFrames(STACK_B).length, 1);
  });
});

describe('fingerprint', () => {
  test('the same defect from two deploys fingerprints identically', () => {
    assert.equal(
      fingerprint('TypeError', "Cannot read properties of undefined (reading 'total')", STACK_A),
      fingerprint('TypeError', "Cannot read properties of undefined (reading 'total')", STACK_A_ELSEWHERE),
    );
  });

  test('the same message thrown from a different place is a different defect', () => {
    // The message is identical here; only the stack tells them apart.
    assert.notEqual(
      fingerprint('TypeError', 'same message', STACK_A),
      fingerprint('TypeError', 'same message', STACK_B),
    );
  });

  test('a differing message does not split one defect', () => {
    // Messages embed order ids and durations. Grouping on them would make
    // every occurrence a singleton and the crash would never rank.
    assert.equal(
      fingerprint('Error', 'Timeout after 30012ms on order A-4471', STACK_A),
      fingerprint('Error', 'Timeout after 28004ms on order B-9982', STACK_A),
    );
  });

  test('the error class is part of the identity', () => {
    assert.notEqual(fingerprint('TypeError', 'x', STACK_A), fingerprint('RangeError', 'x', STACK_A));
  });

  test('with no stack it falls back to the scrubbed message', () => {
    assert.equal(
      fingerprint('Error', 'Timeout after 30012ms', undefined),
      fingerprint('Error', 'Timeout after 28004ms', undefined),
    );
    assert.notEqual(
      fingerprint('Error', 'Timeout waiting', undefined),
      fingerprint('Error', 'Connection refused', undefined),
    );
  });

  test('fingerprints are recognizable', () => {
    assert.match(fingerprint('Error', 'x', STACK_A), /^ex_/);
  });
});

describe('cluster text', () => {
  test('per-occurrence identifiers are scrubbed', () => {
    assert.equal(
      exceptionClusterText('Error', 'Timeout after 30012ms on A-4471', STACK_A),
      exceptionClusterText('Error', 'Timeout after 28004ms on B-9982', STACK_A),
    );
  });

  test('a generic message is disambiguated by where it was thrown', () => {
    // "Request failed" from two subsystems is two defects, and only the frames
    // carry that.
    assert.notEqual(
      exceptionClusterText('Error', 'Request failed', STACK_A),
      exceptionClusterText('Error', 'Request failed', STACK_B),
    );
  });

  test('with no stack it is just the scrubbed message', () => {
    assert.equal(exceptionClusterText('Error', 'boom', undefined), 'Error: boom');
  });
});

describe('unattributed fallback key', () => {
  test('the same defect on the same day is one bucket', () => {
    // A retry loop must not out-vote humans by generating volume.
    assert.equal(
      exceptionFallbackKey('ex_1', '2026-09-03T01:00:00.000Z'),
      exceptionFallbackKey('ex_1', '2026-09-03T23:59:00.000Z'),
    );
  });

  test('the same defect on another day is another bucket', () => {
    // A bug present for weeks should accrue demand; one present for an hour
    // should not look like a crisis.
    assert.notEqual(
      exceptionFallbackKey('ex_1', '2026-09-03T00:00:00.000Z'),
      exceptionFallbackKey('ex_1', '2026-09-04T00:00:00.000Z'),
    );
  });

  test('two defects on one day are separate buckets', () => {
    assert.notEqual(
      exceptionFallbackKey('ex_1', '2026-09-03T00:00:00.000Z'),
      exceptionFallbackKey('ex_2', '2026-09-03T00:00:00.000Z'),
    );
  });
});

describe('describing a throwable', () => {
  test('an Error yields name, message, and stack', () => {
    const described = describeThrowable(new TypeError('bad'));
    assert.equal(described.name, 'TypeError');
    assert.equal(described.message, 'bad');
    assert.ok(described.stack !== undefined);
  });

  test('a thrown string is handled', () => {
    assert.deepEqual(describeThrowable('just a string'), { name: 'Error', message: 'just a string' });
  });

  test('a thrown object is serialized rather than becoming [object Object]', () => {
    assert.equal(describeThrowable({ code: 'E_X' }).message, '{"code":"E_X"}');
  });

  test('a circular object does not throw while being described', () => {
    // Failing to record an error because recording it threw is the worst
    // possible outcome for an error pipeline.
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    assert.doesNotThrow(() => describeThrowable(circular));
  });

  test('an error with a blank name still has one', () => {
    const err = new Error('x');
    err.name = '';
    assert.equal(describeThrowable(err).name, 'Error');
  });

  test('undefined and null are described without throwing', () => {
    assert.equal(describeThrowable(undefined).name, 'Error');
    assert.equal(describeThrowable(null).name, 'Error');
  });
});
