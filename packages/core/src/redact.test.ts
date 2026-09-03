import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { cap, DEFAULT_RULES, luhn, MARKER_PREFIX, scan } from './redact.ts';

describe('luhn', () => {
  test('accepts known-valid test card numbers', () => {
    // Standard non-issuable test numbers from the payment industry.
    for (const n of [
      '4242424242424242', // Visa
      '5555555555554444', // Mastercard
      '378282246310005', // Amex
      '6011111111111117', // Discover
      '30569309025904', // Diners
    ]) {
      assert.equal(luhn(n), true, `expected ${n} to pass Luhn`);
    }
  });

  test('rejects numbers with a transposed digit', () => {
    assert.equal(luhn('4242424242424243'), false);
    assert.equal(luhn('5555555555554445'), false);
  });

  test('rejects empty and non-digit input', () => {
    assert.equal(luhn(''), false);
    assert.equal(luhn('4242-4242'), false);
    assert.equal(luhn('abcd'), false);
  });
});

describe('scan — detection', () => {
  test('redacts a Luhn-valid card, including separated forms', () => {
    for (const form of [
      '4242424242424242',
      '4242 4242 4242 4242',
      '4242-4242-4242-4242',
    ]) {
      const r = scan(`my card is ${form} ok`);
      assert.equal(r.text, 'my card is [redacted:card] ok');
      assert.equal(r.counts.card, 1);
    }
  });

  test('leaves digit runs that fail Luhn alone', () => {
    // The precision claim in the module doc: order ids stay readable.
    const r = scan('order 1234567890123 shipped');
    assert.equal(r.text, 'order 1234567890123 shipped');
    assert.equal(r.total, 0);
  });

  test('redacts emails', () => {
    const r = scan('contact ryan.h+test@example.co.uk please');
    assert.equal(r.text, 'contact [redacted:email] please');
    assert.equal(r.counts.email, 1);
  });

  test('redacts JWTs and bearer tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP';
    assert.equal(scan(`auth ${jwt}`).text, 'auth [redacted:token]');
    assert.equal(
      scan('Authorization: Bearer abc123def456ghi').text,
      'Authorization: [redacted:token]',
    );
  });

  test('redacts provider API keys', () => {
    const cases = [
      'sk_live_abcdefgh12345678',
      'ghp_abcdefghijklmnopqrstuvwxyz123456',
      'xoxb-1234567890-abcdefg',
      'AKIAIOSFODNN7EXAMPLE',
      'sk-ant-api03-abcdefghijklmnop',
    ];
    for (const key of cases) {
      const r = scan(`key=${key}`);
      assert.equal(r.text, 'key=[redacted:apikey]', `failed on ${key}`);
    }
  });

  test('redacts IBANs and SSNs', () => {
    assert.equal(scan('iban GB82 WEST 1234 5698 7654 32').text, 'iban [redacted:iban]');
    assert.equal(scan('ssn 123-45-6789').text, 'ssn [redacted:ssn]');
  });

  test('rejects structurally invalid SSNs', () => {
    // 000/666/9xx area numbers and 00 group / 0000 serial are never issued.
    for (const bad of ['000-45-6789', '666-45-6789', '900-45-6789', '123-00-6789', '123-45-0000']) {
      assert.equal(scan(`ssn ${bad}`).total, 0, `expected ${bad} to be ignored`);
    }
  });

  test('redacts separated phone numbers but not bare digit runs', () => {
    assert.equal(scan('call 415-555-0134').text, 'call [redacted:phone]');
    assert.equal(scan('call (415) 555-0134').text, 'call [redacted:phone]');
    assert.equal(scan('id 4155550134').total, 0);
  });
});

describe('scan — behavior contracts', () => {
  test('is idempotent: markers are never re-matched', () => {
    const once = scan('ryan@example.com paid with 4242424242424242');
    const twice = scan(once.text);
    assert.equal(twice.text, once.text);
    assert.equal(twice.total, 0);
  });

  test('does not leak regex lastIndex between calls', () => {
    // /g regexes are module-level; a shared lastIndex would make the second
    // call miss a match at the same offset. This is the bug the defensive
    // RegExp copy in scan() exists to prevent.
    const input = 'a@b.com and c@d.com';
    const first = scan(input);
    const second = scan(input);
    assert.equal(first.text, second.text);
    assert.equal(first.counts.email, 2);
    assert.equal(second.counts.email, 2);
  });

  test('counts every occurrence and reports an accurate total', () => {
    const r = scan('a@b.com, c@d.com, card 4242424242424242');
    assert.equal(r.counts.email, 2);
    assert.equal(r.counts.card, 1);
    assert.equal(r.total, 3);
  });

  test('handles multiple kinds in one string without cross-consuming', () => {
    const r = scan('mail a@b.com key sk_live_abcdefgh12345678 card 4242424242424242');
    assert.equal(
      r.text,
      'mail [redacted:email] key [redacted:apikey] card [redacted:card]',
    );
    assert.equal(r.total, 3);
  });

  test('returns clean text untouched with a zero total', () => {
    const r = scan('the checkout button does nothing');
    assert.equal(r.text, 'the checkout button does nothing');
    assert.equal(r.total, 0);
    assert.deepEqual(r.counts, {});
  });

  test('handles empty input', () => {
    const r = scan('');
    assert.equal(r.text, '');
    assert.equal(r.total, 0);
  });

  test('every marker is machine-parseable with the documented prefix', () => {
    const r = scan('a@b.com 4242424242424242 123-45-6789');
    const markers = r.text.match(/\[redacted:[a-z]+\]/g) ?? [];
    assert.equal(markers.length, 3);
    for (const m of markers) assert.ok(m.startsWith(MARKER_PREFIX));
  });

  test('accepts a custom rule set', () => {
    const r = scan('internal id EMP-4471', [
      { kind: 'ssn', pattern: /EMP-\d{4}/g },
    ]);
    assert.equal(r.text, 'internal id [redacted:ssn]');
  });

  test('DEFAULT_RULES is frozen so callers cannot mutate global policy', () => {
    assert.ok(Object.isFrozen(DEFAULT_RULES));
  });
});

describe('cap', () => {
  test('leaves short strings untouched', () => {
    assert.equal(cap('short', 10), 'short');
    assert.equal(cap('exactly10!', 10), 'exactly10!');
  });

  test('truncates and reports how much was dropped', () => {
    assert.equal(cap('abcdefghij', 4), 'abcd…[+6]');
  });

  test('handles a zero or negative cap', () => {
    assert.equal(cap('anything', 0), '');
    assert.equal(cap('anything', -1), '');
  });
});
