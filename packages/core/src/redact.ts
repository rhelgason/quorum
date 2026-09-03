/**
 * On-device pattern scanning — the last line of PII defense before anything is
 * serialized.
 *
 * This is a **net, not a guarantee**. It runs after structural redaction (input
 * masking, subtree dropping, body stripping), never instead of it. See
 * `docs/adr/0007-redact-by-default.md`.
 *
 * Two deliberate properties:
 *
 *  - **Typed markers, not silent removal.** A match becomes `[redacted:card]`,
 *    not an empty string. A developer reading a capture can tell that
 *    something was there and what kind — silent removal makes captures
 *    maddening to debug.
 *  - **False positives are cheaper than false negatives.** We would rather
 *    redact an order number that looks like a card than leak a card. Where a
 *    cheap validity check exists (Luhn), we use it to claw back precision
 *    without giving up recall.
 */

export type RedactionKind =
  | 'card'
  | 'email'
  | 'token'
  | 'apikey'
  | 'iban'
  | 'ssn'
  | 'phone';

export interface RedactionRule {
  kind: RedactionKind;
  pattern: RegExp;
  /**
   * Optional second check. Returning false leaves the text untouched, which is
   * how we keep digit-heavy content (order ids, timestamps) readable.
   */
  validate?: (match: string) => boolean;
}

export interface ScanResult {
  text: string;
  /** Count of replacements by kind. Emitted in `RedactionBlock`, never content. */
  counts: Partial<Record<RedactionKind, number>>;
  total: number;
}

/**
 * Luhn checksum. Cuts the false-positive rate on 13–19 digit runs dramatically
 * — order numbers and timestamps almost never validate.
 */
export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const code = digits.charCodeAt(i);
    if (code < 48 || code > 57) return false;
    let d = code - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/**
 * Card-shaped runs, allowing spaces and hyphens as separators. Bounded by
 * non-digit lookarounds so a 25-digit id doesn't match its own prefix.
 */
const CARD = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;

/** Deliberately not RFC 5322. Over-matching here is the safe direction. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** JWTs and bearer tokens. Three base64url segments, or an explicit prefix. */
const TOKEN = /\b(?:Bearer\s+[A-Za-z0-9._~+/-]+=*|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+)/g;

/** Provider key prefixes: Stripe, OpenAI, GitHub, Slack, AWS, Anthropic. */
const APIKEY = /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bsk-ant-[A-Za-z0-9_-]{16,}/g;

const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g;

/** US SSN shape. Other national formats are opt-in per project. */
const SSN = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;

/** E.164 and common separated forms, requiring a separator or + to reduce noise. */
const PHONE = /(?<![\d-])(?:\+\d{1,3}[ -]?)?(?:\(\d{3}\)|\d{3})[ -]\d{3}[ -]\d{4}(?![\d-])/g;

export const DEFAULT_RULES: readonly RedactionRule[] = Object.freeze([
  // Order matters: the most specific and most damaging patterns run first, so
  // an API key is never partially consumed by a looser rule.
  { kind: 'apikey', pattern: APIKEY },
  { kind: 'token', pattern: TOKEN },
  { kind: 'email', pattern: EMAIL },
  { kind: 'iban', pattern: IBAN },
  { kind: 'ssn', pattern: SSN },
  {
    kind: 'card',
    pattern: CARD,
    validate: (m) => luhn(m.replace(/[ -]/g, '')),
  },
  { kind: 'phone', pattern: PHONE },
]);

export const MARKER_PREFIX = '[redacted:';

function marker(kind: RedactionKind): string {
  return `${MARKER_PREFIX}${kind}]`;
}

/**
 * Replace anything matching a rule with a typed marker.
 *
 * Safe to call on already-scanned text: markers contain no characters that any
 * rule matches, so scanning is idempotent.
 */
export function scan(
  input: string,
  rules: readonly RedactionRule[] = DEFAULT_RULES,
): ScanResult {
  if (input === '') return { text: '', counts: {}, total: 0 };

  let text = input;
  const counts: Partial<Record<RedactionKind, number>> = {};
  let total = 0;

  for (const rule of rules) {
    // Rules are module-level and reused across calls; `lastIndex` on a /g regex
    // is mutable state that would otherwise leak between invocations.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    text = text.replace(re, (match) => {
      if (rule.validate && !rule.validate(match)) return match;
      counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
      total++;
      return marker(rule.kind);
    });
  }

  return { text, counts, total };
}

/**
 * Cap a string's length, with an explicit truncation marker.
 *
 * Long strings in a log or a metadata field are overwhelmingly user content
 * that leaked in by accident. Capping bounds the blast radius of that mistake
 * and keeps log lines bounded.
 */
export function cap(input: string, max: number): string {
  if (max <= 0) return '';
  if (input.length <= max) return input;
  return `${input.slice(0, max)}…[+${input.length - max}]`;
}
