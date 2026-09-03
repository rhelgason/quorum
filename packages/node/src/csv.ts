/**
 * A CSV reader, because "export your support inbox" produces a CSV and
 * `@quorum/node` refuses to make that a dependency install.
 *
 * RFC 4180 with the deviations real exports actually contain: a UTF-8 BOM from
 * Excel, CRLF line endings, and — the one that breaks naive splitters — quoted
 * fields containing commas and newlines, which every support ticket body does.
 *
 * The deliberate strictness is ragged rows. A stray unescaped quote shifts
 * every subsequent column by one, and the result is a successful import where
 * `body` holds timestamps and `mrr` holds prose. Nothing downstream can detect
 * that; it just produces a confidently wrong ranked list. So a row whose field
 * count disagrees with the header is an error naming the row number, not a
 * best-effort guess.
 */

export interface CsvOptions {
  /** Default `,`. Set to `\t` for the TSV that Zendesk and Intercom emit. */
  delimiter?: string;
}

/** Parse to raw rows, header included. */
export function parseCsv(text: string, options: CsvOptions = {}): string[][] {
  const delimiter = options.delimiter ?? ',';
  if (delimiter.length !== 1) throw new Error(`delimiter must be one character, got ${JSON.stringify(delimiter)}`);

  // Excel prefixes a BOM. Left in place it becomes part of the first header
  // name, so `id` silently stops matching and every row loses its id.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  // Distinguishes "no content yet" from "one empty field", so a trailing
  // newline does not append a phantom row.
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;

    if (quoted) {
      if (ch !== '"') {
        field += ch;
        continue;
      }
      if (input[i + 1] === '"') {
        // Doubled quote: an escaped literal quote inside a quoted field.
        field += '"';
        i++;
        continue;
      }
      quoted = false;
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      started = true;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
      continue;
    }
    field += ch;
    started = true;
  }

  if (quoted) throw new Error('unterminated quoted field: the file ends inside a quote');
  if (started || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Parse to header-keyed records.
 *
 * Header names are trimmed and lowercased, so `Customer ID` and `customer id`
 * are the same column — exports are not consistent about this and a case
 * mismatch would silently drop the field.
 */
export function parseCsvRecords(
  text: string,
  options: CsvOptions = {},
): Record<string, string>[] {
  const rows = parseCsv(text, options);
  const header = rows[0];
  if (header === undefined) return [];

  const keys = header.map((h) => h.trim().toLowerCase());
  const duplicate = keys.find((k, i) => keys.indexOf(k) !== i);
  if (duplicate !== undefined) {
    throw new Error(`duplicate column "${duplicate}": one would silently overwrite the other`);
  }

  const records: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as string[];
    // A wholly empty trailing line is padding, not a malformed record.
    if (row.length === 1 && row[0] === '') continue;
    if (row.length !== keys.length) {
      throw new Error(
        `row ${i + 1} has ${row.length} field${row.length === 1 ? '' : 's'}, header has ${keys.length}` +
          ' — a shifted column is worse than a failed import',
      );
    }
    const record: Record<string, string> = {};
    for (let c = 0; c < keys.length; c++) record[keys[c] as string] = row[c] as string;
    records.push(record);
  }
  return records;
}
