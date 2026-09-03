import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, parseCsvRecords } from './csv.ts';

describe('RFC 4180 shapes', () => {
  test('plain rows', () => {
    assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  });

  test('a quoted field may contain the delimiter', () => {
    assert.deepEqual(parseCsv('a,b\n"x,y",2'), [['a', 'b'], ['x,y', '2']]);
  });

  test('a quoted field may contain newlines', () => {
    // Every multi-line support ticket body. A line-splitting parser turns one
    // ticket into several malformed rows.
    assert.deepEqual(parseCsv('a\n"line one\nline two"'), [['a'], ['line one\nline two']]);
  });

  test('doubled quotes are one literal quote', () => {
    assert.deepEqual(parseCsv('a\n"she said ""no"""'), [['a'], ['she said "no"']]);
  });

  test('CRLF endings are handled', () => {
    assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  });

  test('a trailing newline does not append a phantom row', () => {
    assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  });

  test('empty fields are preserved', () => {
    assert.deepEqual(parseCsv('a,b,c\n1,,3'), [['a', 'b', 'c'], ['1', '', '3']]);
  });

  test('a lone empty quoted field is one empty field', () => {
    assert.deepEqual(parseCsv('a,b\n"",2'), [['a', 'b'], ['', '2']]);
  });

  test('an Excel BOM does not become part of the first header', () => {
    // Left in, `id` stops matching and every row silently loses its id.
    const rows = parseCsv('﻿id,body\n1,hello');
    assert.deepEqual(rows[0], ['id', 'body']);
  });

  test('a tab delimiter works for TSV exports', () => {
    assert.deepEqual(parseCsv('a\tb\n1\t2', { delimiter: '\t' }), [['a', 'b'], ['1', '2']]);
  });

  test('a multi-character delimiter is rejected rather than half-applied', () => {
    assert.throws(() => parseCsv('a', { delimiter: '||' }), /one character/);
  });

  test('an unterminated quote is an error, not a truncated field', () => {
    assert.throws(() => parseCsv('a\n"never closed'), /unterminated/);
  });

  test('the empty string parses to no rows', () => {
    assert.deepEqual(parseCsv(''), []);
  });
});

describe('header-keyed records', () => {
  test('rows become records keyed by lowercased header', () => {
    const records = parseCsvRecords('ID,Body\n1,hello');
    assert.deepEqual(records, [{ id: '1', body: 'hello' }]);
  });

  test('header whitespace is trimmed', () => {
    assert.deepEqual(parseCsvRecords(' id , body \n1,x'), [{ id: '1', body: 'x' }]);
  });

  test('a ragged row is an error naming the row number', () => {
    // The failure this prevents: a shifted column produces a successful import
    // where body holds timestamps. Nothing downstream can detect that.
    assert.throws(() => parseCsvRecords('a,b\n1,2,3'), /row 2 has 3 fields, header has 2/);
  });

  test('a blank trailing line is padding, not a malformed record', () => {
    assert.deepEqual(parseCsvRecords('a,b\n1,2\n\n'), [{ a: '1', b: '2' }]);
  });

  test('duplicate columns are rejected instead of overwriting', () => {
    // One would silently win, and which one depends on column order.
    assert.throws(() => parseCsvRecords('body,body\n1,2'), /duplicate column/);
  });

  test('a case-only difference counts as a duplicate', () => {
    assert.throws(() => parseCsvRecords('Body,body\n1,2'), /duplicate column/);
  });

  test('a header with no data rows yields no records', () => {
    assert.deepEqual(parseCsvRecords('a,b\n'), []);
  });

  test('an empty file yields no records', () => {
    assert.deepEqual(parseCsvRecords(''), []);
  });
});
