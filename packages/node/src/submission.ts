/**
 * The server-side submission record, and the two things that turn arbitrary
 * inbound text into one: identity resolution and clustering text.
 *
 * `docs/DATA-MODEL.md` states the organizing rule this file exists to enforce —
 * **submissions are append-only facts.** `body` is verbatim and is never
 * rewritten. Everything derived lives in a separate field, so a reader can
 * always get back to what the user actually said.
 */

import type { SubmissionKind, SubmissionSource } from '../../core/src/protocol.ts';
import { normalize } from '../../aggregate/src/text.ts';

export type { SubmissionKind, SubmissionSource };

/**
 * One piece of feedback, as ingest stores it. A trimmed-down `submissions` row
 * from `docs/DATA-MODEL.md` §2 — the columns the deterministic pipeline
 * actually reads, and nothing speculative.
 */
export interface Submission {
  /** Unique within a project. Doubles as the idempotency key. */
  id: string;
  projectId: string;
  kind: SubmissionKind;
  source: SubmissionSource;

  /** Verbatim. Never rewritten, never normalized in place. */
  body: string;

  /**
   * Text the clusterer sees. Defaults to `body`; differs only where raw text
   * would cluster badly, which in practice means machine-generated text —
   * see `scrubVariableData` and `exception.ts`.
   */
  clusterText: string;

  /** Resolved identity key. See `resolveUserId` — this is a load-bearing field. */
  userId: string;
  /** True when the identity came from the caller rather than a fallback. */
  attributed: boolean;
  /** Monthly recurring revenue for the account, when known. Feeds account weight. */
  mrr?: number;

  /**
   * When the user submitted. Ranking keys on this, never on `receivedAt` — an
   * offline flush or a historical import would otherwise read as a spike.
   */
  clientTs: string;
  /** When ingest accepted it. Diagnostics only; never a ranking input. */
  receivedAt: string;

  route?: string;
  appVersion?: string;
  platform?: string;

  /** Stable grouping key for machine-generated reports. See `exception.ts`. */
  fingerprint?: string;

  /**
   * L2-normalized sentence embedding, enabling hybrid similarity.
   *
   * Nothing in this package populates it. The embedder in `@quorum/aggregate`
   * is absent unless configured, embedding is async and batched while
   * clustering is synchronous and per-item, and no real model has been
   * measured yet ([ADR-0019](../../../docs/adr/0019-embedding-quality-bar.md)).
   * A caller who has vectors can set this and pass `semanticWeight`; when it
   * is absent, scoring falls back to lexical-only for that submission rather
   * than penalizing it.
   */
  embedding?: Float64Array;

  /**
   * Fields ingest did not recognize, preserved rather than dropped.
   * `docs/PROTOCOL.md` requires this: a newer client talking to an older
   * self-hosted ingest must not lose data permanently.
   */
  raw?: Record<string, unknown>;
}

/** Caller-supplied identity, mirroring the protocol's `UserBlock`. */
export interface Identity {
  externalId?: string;
  anonId?: string;
  traits?: Record<string, string | number | boolean | null>;
}

export interface ResolvedIdentity {
  userId: string;
  attributed: boolean;
  mrr?: number;
}

/**
 * **Identity resolution is where double-counting bugs live.**
 *
 * Ranking counts *unique users*, which is the single defense against spam and
 * against one motivated person filing twenty tickets
 * (`packages/aggregate/src/rank.ts`, Opinion 3). That defense is only as good
 * as this function.
 *
 * The failure to avoid is subtle and silent: give every unattributed
 * submission a fresh random id and unique-user counting quietly degrades into
 * submission counting. Nothing throws, no test fails, and the ranked list is
 * wrong in exactly the way the design was built to prevent. So there is no
 * random fallback here at all — an unattributed submission must be handed a
 * caller-chosen grouping key, and the caller has to have thought about what
 * that key means.
 *
 * `externalId` wins over `anonId` because a user who files anonymously and
 * later identifies is one user, not two. (Retroactively relinking the earlier
 * anonymous submissions is the ingest service's job — see DATA-MODEL §1 — and
 * is not implemented here.)
 */
export function resolveUserId(
  identity: Identity | undefined,
  fallbackKey: string,
): ResolvedIdentity {
  const mrr = readMrr(identity?.traits);

  if (identity?.externalId !== undefined && identity.externalId !== '') {
    return { userId: `u:${identity.externalId}`, attributed: true, ...(mrr !== undefined && { mrr }) };
  }
  if (identity?.anonId !== undefined && identity.anonId !== '') {
    return { userId: `a:${identity.anonId}`, attributed: true, ...(mrr !== undefined && { mrr }) };
  }
  if (fallbackKey === '') {
    throw new Error('unattributed submission needs a non-empty fallback identity key');
  }
  return { userId: fallbackKey, attributed: false, ...(mrr !== undefined && { mrr }) };
}

/**
 * MRR out of the traits bag, tolerating the string forms a CSV export or a
 * JSON column will hand over ("4000", "$4,000").
 *
 * Anything unparseable is dropped rather than coerced to 0 — an account whose
 * MRR we failed to read is an account of unknown value, and `accountWeight`
 * already treats absent as 1.0. Coercing to 0 would say something we don't know.
 */
function readMrr(traits: Identity['traits']): number | undefined {
  const raw = traits?.['mrr'];
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const parsed = Number(raw.replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Replace values that vary per occurrence with placeholders.
 *
 * Only ever applied to `clusterText`, never to `body`.
 *
 * The problem it solves: machine-generated text embeds identifiers.
 * "Timeout after 30012ms fetching order A-4471" and "Timeout after 28004ms
 * fetching order B-9982" are the same defect, but to a bag-of-words clusterer
 * they share no distinguishing terms with each other and every occurrence is a
 * singleton. A crash hitting five thousand users becomes five thousand
 * clusters of one and never appears on the ranked list at all — the exact
 * failure that makes people say clustering "doesn't work" on operational data.
 *
 * Ordering matters here: longer, more structured patterns are consumed before
 * bare numbers, or `<num>` eats the digits inside a UUID and the shape is lost.
 */
export function scrubVariableData(text: string): string {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hash>')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<ts>')
    .replace(/\b(?:0x)[0-9a-f]+\b/gi, '<hex>')
    // Identifier-shaped tokens: at least one digit welded to at least one
    // letter or separator, e.g. `A-4471`, `user_882`, `v4.12.0`.
    .replace(/\b(?=[\w.-]*\d)(?=[\w.-]*[A-Za-z_.-])[\w.-]{2,}\b/g, '<id>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<num>');
}

/**
 * Deterministic id for a record that did not arrive with one.
 *
 * **Re-running an import must not multiply demand.** A support-inbox export is
 * a file someone regenerates — weekly, or twice because the first run looked
 * wrong. With random ids, the second run inserts a parallel copy of every
 * ticket under a *new* id but the *same* user, and unique-user counting holds
 * the line on the score while member counts and evidence quotes silently
 * double. With ids derived from content, the second run collides with the
 * first and ingest drops it as the duplicate it is.
 *
 * The hash covers everything that makes the record distinct. `clientTs` is in
 * there deliberately: the same user writing the same sentence twice, months
 * apart, is two pieces of feedback and re-filing should make them look more
 * recent (rank.ts, Opinion 3).
 *
 * FNV-1a over two offset bases. Not cryptographic and doesn't need to be —
 * nothing here is adversarial, it just needs collisions to be rarer than the
 * data. `node:crypto` is deliberately avoided so this file stays runnable
 * anywhere the rest of the pipeline is.
 */
export function derivedId(parts: readonly string[]): string {
  const joined = parts.join(' ');
  return `im_${fnv1a(joined, 0x811c9dc5)}${fnv1a(joined, 0x01000193)}`;
}

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range via Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

/**
 * Normalized form used for near-duplicate detection.
 *
 * Not clustering: this is the cheap exact-match pass that collapses "Add dark
 * mode" and "add dark mode please!!" before either reaches the vectorizer.
 */
export function dedupKey(text: string): string {
  return normalize(text);
}
