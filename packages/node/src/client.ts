/**
 * `Quorum` — the server-side entry point.
 *
 * Four ways in (a single `capture`, a thrown exception, a bulk import, a
 * protocol envelope from an SDK client) and one way out (`issues`). All four
 * inbound paths converge on the same `Submission` record and the same store,
 * which is the whole point: a support ticket, a backend crash, and a widget
 * submission cluster against each other rather than living in three products.
 *
 * Everything is `async` even though `MemoryStore` is synchronous. The store
 * interface is Postgres-shaped by intent (`store.ts`), and making that swap a
 * breaking change to every caller would be a self-inflicted wound.
 */

import { PROTOCOL_VERSION, type CaptureEnvelope, type CaptureEvent, type IngestAccepted } from '../../core/src/protocol.ts';
import { parseCsvRecords, type CsvOptions } from './csv.ts';
import {
  describeThrowable,
  exceptionClusterText,
  exceptionFallbackKey,
  fingerprint,
} from './exception.ts';
import { buildIssues, type BuildIssuesOptions, type Issue } from './issues.ts';
import { MemoryStore, type SubmissionStore } from './store.ts';
import {
  derivedId,
  resolveUserId,
  type Identity,
  type Submission,
  type SubmissionKind,
  type SubmissionSource,
} from './submission.ts';

/**
 * What to do with a record nobody can attribute to a user.
 *
 * There is no safe default that fits every path, so each method picks one and
 * says why. See `resolveUserId` for the failure this exists to prevent.
 *
 * - `'error'` — refuse. The caller has to decide what the record means.
 * - `'per-record'` — every record is a distinct user. Correct for a ticket
 *   export where each row is a different customer; wrong, and inflationary, if
 *   one person can produce many records.
 * - `'per-day'` — one bucket per day. Caps how much a machine can inflate the
 *   list, at the cost of undercounting real volume.
 * - `{ key }` — a fixed bucket. Everything counts as one user.
 */
export type UnattributedPolicy = 'error' | 'per-record' | 'per-day' | { key: string };

export interface QuorumOptions {
  /** Scopes every write and read. Ids are unique within it, not globally. */
  projectId: string;
  /** Defaults to an in-process `MemoryStore`. */
  store?: SubmissionStore;
  /** Injectable clock, for tests and reproducible imports. */
  now?: () => Date;
}

export interface CaptureContext {
  route?: string;
  appVersion?: string;
  platform?: string;
}

export interface CaptureInput {
  body: string;
  /** Default `'feature_request'` — the default flow asks what the user would change. */
  kind?: SubmissionKind;
  /** Default `'api'`. Set `'support_inbox'` when piping tickets; ranking reads it. */
  source?: SubmissionSource;
  user?: Identity;
  context?: CaptureContext;
  /**
   * When the user said it. Defaults to now, which is only correct for feedback
   * arriving live — anything historical must pass the real timestamp.
   */
  clientTs?: string;
  /** Supply to make a retry idempotent. Otherwise derived from the content. */
  id?: string;
  /** Grouping key when `user` carries no identity. */
  fallbackKey?: string;
}

export interface CaptureResult {
  submission: Submission;
  /** False when this id was already stored — success, not an error. */
  stored: boolean;
}

export interface ExceptionOptions {
  user?: Identity;
  context?: CaptureContext;
  clientTs?: string;
  /** Default `'bug'`. */
  kind?: SubmissionKind;
  /** Default `'api'`. */
  source?: SubmissionSource;
}

export interface ImportRow {
  body: string;
  /**
   * **Required, and deliberately not defaulted.**
   *
   * Ranking decays on client time and detects growth on it. Stamping an
   * import with the wall clock makes a five-year backlog look like it all
   * arrived this morning: every item is maximally recent, and the whole
   * corpus reads as one enormous growth spike. The resulting list is
   * confident and meaningless, and nothing downstream can detect it. A
   * missing timestamp is a data problem to fix at the source, not one to
   * paper over here.
   */
  clientTs: string;
  id?: string;
  kind?: SubmissionKind;
  source?: SubmissionSource;
  user?: Identity;
  context?: CaptureContext;
}

export interface ImportOptions {
  /** Default `'import'`. Use `'support_inbox'` for a helpdesk export. */
  source?: SubmissionSource;
  /** Default `'error'` — a bulk load is the worst place to guess at identity. */
  unattributed?: UnattributedPolicy;
}

export interface ImportResult {
  total: number;
  inserted: number;
  /** Already present. Re-running an import should land almost entirely here. */
  duplicate: number;
}

/** Column names to read each field from. Omitted fields are auto-detected. */
export interface CsvColumns {
  body?: string;
  clientTs?: string;
  id?: string;
  externalId?: string;
  mrr?: string;
  kind?: string;
  route?: string;
  appVersion?: string;
}

export interface ImportCsvOptions extends ImportOptions, CsvOptions {
  columns?: CsvColumns;
}

/**
 * Header names tried, in order, when a column is not named explicitly.
 *
 * Auto-detection is a convenience for "point it at your export and see", not a
 * contract. An import that guessed wrong is worse than one that refused, so a
 * missing `body` or `clientTs` is an error listing what was actually in the
 * file rather than a silent skip.
 */
const CSV_ALIASES: Record<keyof CsvColumns, readonly string[]> = {
  body: ['body', 'description', 'text', 'comment', 'message', 'feedback', 'subject'],
  clientTs: ['clientts', 'client_ts', 'created_at', 'created', 'date', 'timestamp', 'submitted_at'],
  id: ['id', 'ticket_id', 'external_id'],
  externalId: ['user_id', 'customer_id', 'requester_id', 'requester', 'email', 'account_id'],
  mrr: ['mrr', 'revenue', 'monthly_revenue', 'arr'],
  kind: ['kind', 'type', 'category'],
  route: ['route', 'page', 'url', 'path', 'screen'],
  appVersion: ['app_version', 'appversion', 'version'],
};

const VALID_KINDS: ReadonlySet<string> = new Set([
  'feature_request',
  'bug',
  'praise',
  'question',
  'rage',
]);

export class Quorum {
  readonly projectId: string;
  readonly store: SubmissionStore;
  readonly #now: () => Date;

  constructor(options: QuorumOptions) {
    if (options.projectId === '') throw new Error('projectId is required');
    this.projectId = options.projectId;
    this.store = options.store ?? new MemoryStore();
    this.#now = options.now ?? ((): Date => new Date());
  }

  /**
   * One piece of feedback from anywhere your backend can see it — a support
   * ticket, a sales call note, an NPS free-text field.
   *
   * Unattributed input throws. A backend integration nearly always knows whose
   * ticket it is, and silently bucketing it would corrupt the unique-user
   * count that ranking depends on.
   */
  async capture(input: CaptureInput): Promise<CaptureResult> {
    if (input.body.trim() === '') throw new Error('capture() needs a non-empty body');

    const receivedAt = this.#now().toISOString();
    const clientTs = input.clientTs ?? receivedAt;
    assertTimestamp(clientTs, 'clientTs');

    const source = input.source ?? 'api';
    const identity = resolve(input.user, input.fallbackKey ?? '', 'capture()');

    const body = input.body;
    const id =
      input.id ??
      derivedId([this.projectId, source, identity.userId, clientTs, body]);

    return this.#put({
      id,
      projectId: this.projectId,
      kind: input.kind ?? 'feature_request',
      source,
      body,
      clusterText: body,
      userId: identity.userId,
      attributed: identity.attributed,
      ...(identity.mrr !== undefined && { mrr: identity.mrr }),
      clientTs,
      receivedAt,
      ...contextFields(input.context),
    });
  }

  /**
   * A thrown error as feedback.
   *
   * Grouping keys on the stack rather than the message, and unattributed
   * crashes are bucketed per defect per day — both explained in
   * `exception.ts`. Pass `user` whenever the request context has one; it is
   * the difference between a crash ranking on real reach and ranking on a
   * heuristic.
   */
  async captureException(err: unknown, options: ExceptionOptions = {}): Promise<CaptureResult> {
    const { name, message, stack } = describeThrowable(err);
    const receivedAt = this.#now().toISOString();
    const clientTs = options.clientTs ?? receivedAt;
    assertTimestamp(clientTs, 'clientTs');

    const fp = fingerprint(name, message, stack);
    const identity = resolveUserId(options.user, exceptionFallbackKey(fp, clientTs));
    const body = message === '' ? name : `${name}: ${message}`;
    const source = options.source ?? 'api';

    return this.#put({
      // The fingerprint is in the id, so the same defect from the same bucket
      // on the same day collapses instead of accumulating identical rows.
      id: derivedId([this.projectId, source, fp, identity.userId, clientTs]),
      projectId: this.projectId,
      kind: options.kind ?? 'bug',
      source,
      body,
      clusterText: exceptionClusterText(name, message, stack),
      userId: identity.userId,
      attributed: identity.attributed,
      ...(identity.mrr !== undefined && { mrr: identity.mrr }),
      clientTs,
      receivedAt,
      fingerprint: fp,
      ...contextFields(options.context),
    });
  }

  /**
   * Bulk historical load — the shortest path to a ranked list, and the reason
   * `@quorum/node` is first in v0.1 rather than last. A team gets a defensible
   * top ten from feedback they already have, before installing anything.
   *
   * Rows are inserted in **chronological order**, not file order. Clustering
   * is order-dependent by construction, so replaying history in the order it
   * happened reproduces what the online pass would have produced had the
   * feedback arrived live. File order is an artifact of whoever wrote the
   * export.
   */
  async import(rows: readonly ImportRow[], options: ImportOptions = {}): Promise<ImportResult> {
    const policy = options.unattributed ?? 'error';
    const source = options.source ?? 'import';
    const receivedAt = this.#now().toISOString();

    rows.forEach((row, i) => {
      if (row.body.trim() === '') throw new Error(`import row ${i + 1}: empty body`);
      assertTimestamp(row.clientTs, `import row ${i + 1}: clientTs`);
    });

    const ordered = [...rows].sort(
      (a, b) => Date.parse(a.clientTs) - Date.parse(b.clientTs),
    );

    let inserted = 0;
    let duplicate = 0;

    for (let i = 0; i < ordered.length; i++) {
      const row = ordered[i] as ImportRow;
      const rowSource = row.source ?? source;
      const identity = resolve(
        row.user,
        fallbackFor(policy, `import:${i}`, row.clientTs),
        'import()',
      );

      const result = await this.#put({
        id: row.id ?? derivedId([this.projectId, rowSource, identity.userId, row.clientTs, row.body]),
        projectId: this.projectId,
        kind: row.kind ?? 'feature_request',
        source: rowSource,
        body: row.body,
        clusterText: row.body,
        userId: identity.userId,
        attributed: identity.attributed,
        ...(identity.mrr !== undefined && { mrr: identity.mrr }),
        clientTs: row.clientTs,
        receivedAt,
        ...contextFields(row.context),
      });
      if (result.stored) inserted++;
      else duplicate++;
    }

    return { total: rows.length, inserted, duplicate };
  }

  /** `import`, over a CSV or TSV export. */
  async importCsv(text: string, options: ImportCsvOptions = {}): Promise<ImportResult> {
    const records = parseCsvRecords(text, options.delimiter === undefined ? {} : { delimiter: options.delimiter });
    if (records.length === 0) return { total: 0, inserted: 0, duplicate: 0 };

    const present = Object.keys(records[0] as Record<string, string>);
    const pick = (field: keyof CsvColumns): string | undefined =>
      options.columns?.[field] ?? CSV_ALIASES[field].find((alias) => present.includes(alias));

    const bodyCol = pick('body');
    const tsCol = pick('clientTs');
    if (bodyCol === undefined) throw new Error(`no body column found; saw [${present.join(', ')}]`);
    if (tsCol === undefined) throw new Error(`no timestamp column found; saw [${present.join(', ')}]`);

    const idCol = pick('id');
    const userCol = pick('externalId');
    const mrrCol = pick('mrr');
    const kindCol = pick('kind');
    const routeCol = pick('route');
    const versionCol = pick('appVersion');

    const rows: ImportRow[] = records.map((record, i) => {
      const raw = record[tsCol] ?? '';
      const clientTs = normalizeTimestamp(raw);
      if (clientTs === undefined) {
        throw new Error(`csv row ${i + 2}: column "${tsCol}" is not a parseable date (${JSON.stringify(raw)})`);
      }

      const externalId = userCol === undefined ? undefined : emptyToUndefined(record[userCol]);
      const mrr = mrrCol === undefined ? undefined : emptyToUndefined(record[mrrCol]);
      const kind = kindCol === undefined ? undefined : record[kindCol]?.trim().toLowerCase();
      const route = routeCol === undefined ? undefined : emptyToUndefined(record[routeCol]);
      const appVersion = versionCol === undefined ? undefined : emptyToUndefined(record[versionCol]);
      const id = idCol === undefined ? undefined : emptyToUndefined(record[idCol]);

      return {
        body: record[bodyCol] ?? '',
        clientTs,
        ...(id !== undefined && { id }),
        // An unrecognized kind is ignored rather than rejected: "Feature
        // Request", "question", and "Escalation" all show up in one export,
        // and losing the import over the third is not worth it.
        ...(kind !== undefined && VALID_KINDS.has(kind) && { kind: kind as SubmissionKind }),
        ...((externalId !== undefined || mrr !== undefined) && {
          user: {
            ...(externalId !== undefined && { externalId }),
            ...(mrr !== undefined && { traits: { mrr } }),
          },
        }),
        ...((route !== undefined || appVersion !== undefined) && {
          context: {
            ...(route !== undefined && { route }),
            ...(appVersion !== undefined && { appVersion }),
          },
        }),
      };
    });

    return this.import(rows, options);
  }

  /**
   * The server side of `docs/PROTOCOL.md` — a batched envelope from a web or
   * mobile SDK.
   *
   * Returns the protocol's `{ accepted, duplicate }`. Both lists mean dequeue:
   * a duplicate is a replayed offline flush, which is success and is exactly
   * what the client's idempotency key exists to make safe.
   *
   * Unattributed events bucket per day rather than erroring. A wire event that
   * lost its anon id — cleared storage, private browsing — is still real
   * feedback, and dropping it would be a `400` for something the protocol
   * considers valid.
   */
  async ingest(
    envelope: CaptureEnvelope,
    options: { unattributed?: UnattributedPolicy } = {},
  ): Promise<IngestAccepted> {
    if (envelope.v !== PROTOCOL_VERSION) {
      throw new Error(`unsupported protocol version ${String(envelope.v)}; this ingest speaks v${PROTOCOL_VERSION}`);
    }
    const policy = options.unattributed ?? 'per-day';
    const receivedAt = this.#now().toISOString();

    const accepted: string[] = [];
    const duplicate: string[] = [];

    for (const event of envelope.events) {
      const submission = this.#fromEvent(event, receivedAt, policy);
      const result = await this.#put(submission);
      if (result.stored) accepted.push(event.id);
      else duplicate.push(event.id);
    }
    return { accepted, duplicate };
  }

  /** The ranked list. See `issues.ts`. */
  async issues(options: BuildIssuesOptions): Promise<Issue[]> {
    return buildIssues(await this.store.list(this.projectId), options);
  }

  /** Every stored submission, in insertion order. */
  async submissions(): Promise<readonly Submission[]> {
    return this.store.list(this.projectId);
  }

  #fromEvent(event: CaptureEvent, receivedAt: string, policy: UnattributedPolicy): Submission {
    assertTimestamp(event.clientTs, `event ${event.id}: clientTs`);

    const identity = resolve(
      event.user,
      fallbackFor(policy, `event:${event.id}`, event.clientTs),
      'ingest()',
    );

    // A rage shake with no text is valid and useful (PROTOCOL rule 4). It
    // carries no clustering signal, so it seeds its own cluster and ranks on
    // structure — which is the honest outcome, not a bug to paper over.
    const body = event.body ?? '';

    return {
      id: event.id,
      projectId: this.projectId,
      kind: event.kind,
      source: event.source,
      body,
      clusterText: body,
      userId: identity.userId,
      attributed: identity.attributed,
      ...(identity.mrr !== undefined && { mrr: identity.mrr }),
      clientTs: event.clientTs,
      receivedAt,
      ...contextFields(event.context),
    };
  }

  async #put(submission: Submission): Promise<CaptureResult> {
    const stored = await this.store.put(submission);
    if (stored) return { submission, stored };
    // Return what is already there, so a caller reading the result of a retry
    // sees the original record rather than the one that lost the race.
    const existing = await this.store.get(submission.projectId, submission.id);
    return { submission: existing ?? submission, stored: false };
  }
}

function resolve(
  identity: Identity | undefined,
  fallbackKey: string,
  caller: string,
): ReturnType<typeof resolveUserId> {
  const hasIdentity =
    (identity?.externalId !== undefined && identity.externalId !== '') ||
    (identity?.anonId !== undefined && identity.anonId !== '');

  if (!hasIdentity && fallbackKey === '') {
    throw new Error(
      `${caller}: no user identity. Pass user.externalId, user.anonId, or ` +
        'an explicit fallback — unique-user counting is what keeps ranking ' +
        'from becoming a popularity contest, so it will not be guessed at.',
    );
  }
  return resolveUserId(identity, fallbackKey);
}

/** `''` means "no fallback available", which `resolve` turns into an error. */
function fallbackFor(policy: UnattributedPolicy, recordKey: string, clientTs: string): string {
  if (policy === 'error') return '';
  if (policy === 'per-record') return `r:${recordKey}`;
  if (policy === 'per-day') return `d:${clientTs.slice(0, 10)}`;
  return policy.key;
}

function contextFields(context: CaptureContext | undefined): Partial<Submission> {
  return {
    ...(context?.route !== undefined && { route: context.route }),
    ...(context?.appVersion !== undefined && { appVersion: context.appVersion }),
    ...(context?.platform !== undefined && { platform: context.platform }),
  };
}

function assertTimestamp(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is not a parseable timestamp: ${JSON.stringify(value)}`);
  }
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Accept what exports actually contain and re-emit ISO 8601.
 *
 * Unix epochs (seconds and milliseconds) are handled explicitly because
 * `Date.parse` reads a bare number as a year: `1725321600` would silently
 * become the year 1725321600 rather than September 2024.
 */
function normalizeTimestamp(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    // Ten digits is seconds, thirteen is milliseconds. Anything else is not a
    // timestamp we should be guessing at.
    if (trimmed.length === 10) return new Date(n * 1000).toISOString();
    if (trimmed.length === 13) return new Date(n).toISOString();
    return undefined;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}
