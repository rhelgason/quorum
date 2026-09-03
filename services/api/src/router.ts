/**
 * The read and write API, as a pure function from request to response.
 *
 * No `node:http` in this file. Routing, validation, and status-code choice are
 * the parts with rules worth testing, and separating them from the socket
 * means they can be tested as data — which is also what makes the server file
 * beneath this one thin enough to trust.
 *
 * The status codes are not incidental. `docs/PROTOCOL.md` publishes an error
 * table that every SDK's retry logic is written against: a `400` makes a
 * client drop the event permanently, a `429` makes it back off, a `5xx` makes
 * it retry. Returning the wrong one does not produce an error here — it
 * produces a client that loops forever, or one that silently discards a user's
 * feedback. This file is the server half of that contract.
 */

import { PROTOCOL_VERSION, type CaptureEnvelope } from '../../../packages/core/src/protocol.ts';
import type { Quorum } from '../../../packages/node/src/client.ts';
import type { BuildIssuesOptions, Issue } from '../../../packages/node/src/issues.ts';

export interface ApiRequest {
  method: string;
  /** Path only, no query string. */
  path: string;
  query: URLSearchParams;
  /** Parsed JSON body, or undefined. */
  body?: unknown;
  /** Set when the body exceeded the configured limit. */
  tooLarge?: boolean;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface RouterOptions {
  quorum: Quorum;
  /** Evaluation clock. Injected so responses are reproducible under test. */
  now: () => Date;
  /**
   * Expected public key. When set, an envelope naming a different project is
   * rejected with 401 — the protocol's "disable the SDK for this session"
   * signal, which a client must not retry.
   */
  projectKey?: string;
  /** Defaults applied to every issues query. */
  issueDefaults?: Partial<Omit<BuildIssuesOptions, 'now'>>;
}

export type Router = (request: ApiRequest) => Promise<ApiResponse>;

const MAX_LIMIT = 200;

export function createRouter(options: RouterOptions): Router {
  return async (request) => {
    const segments = request.path.split('/').filter((s) => s !== '');

    // `/v0/...` on everything. The version is in the path rather than a header
    // because it has to survive being typed into a browser and pasted into a
    // support ticket.
    if (segments[0] !== 'v0') return notFound();

    const rest = segments.slice(1);

    if (rest.length === 1 && rest[0] === 'health') {
      return methodGuard(request, 'GET', async () => ({
        status: 200,
        body: { status: 'ok', protocol: PROTOCOL_VERSION, submissions: (await options.quorum.submissions()).length },
      }));
    }

    if (rest.length === 1 && rest[0] === 'ingest') {
      return methodGuard(request, 'POST', () => ingest(request, options));
    }

    if (rest.length === 1 && rest[0] === 'issues') {
      return methodGuard(request, 'GET', () => listIssues(request, options));
    }

    if (rest.length === 2 && rest[0] === 'issues') {
      return methodGuard(request, 'GET', () => getIssue(rest[1] as string, options));
    }

    if (rest.length === 3 && rest[0] === 'issues' && rest[2] === 'submissions') {
      return methodGuard(request, 'GET', () => getEvidence(rest[1] as string, options));
    }

    return notFound();
  };
}

async function methodGuard(
  request: ApiRequest,
  allowed: string,
  handle: () => Promise<ApiResponse>,
): Promise<ApiResponse> {
  if (request.method.toUpperCase() !== allowed) {
    return { status: 405, body: { error: 'method_not_allowed', message: `use ${allowed}` } };
  }
  return handle();
}

function notFound(): ApiResponse {
  return { status: 404, body: { error: 'not_found', message: 'no such endpoint' } };
}

/**
 * The write path.
 *
 * `202` and `200` both mean dequeue, and this returns 202 with both lists so a
 * client never has to guess which of a batch landed. A duplicate is success —
 * it is what the client's idempotency key exists to make safe, and treating it
 * as an error would make every replayed offline flush look like a failure.
 */
async function ingest(request: ApiRequest, options: RouterOptions): Promise<ApiResponse> {
  // 413 before parsing: the point of the cap is to not hold the payload.
  if (request.tooLarge === true) {
    return {
      status: 413,
      body: { error: 'too_large', message: 'strip the capture and retry the envelope alone' },
    };
  }

  const envelope = request.body;
  if (!isEnvelopeShaped(envelope)) {
    // 400 makes a conforming client drop the event permanently, so it is only
    // correct for something no retry could fix. A malformed envelope qualifies.
    return { status: 400, body: { error: 'malformed', message: 'expected { v, sentAt, project, events[] }' } };
  }

  if (options.projectKey !== undefined && envelope.project !== options.projectKey) {
    return { status: 401, body: { error: 'bad_project', message: 'unknown project key' } };
  }

  try {
    const result = await options.quorum.ingest(envelope);
    return { status: 202, body: result };
  } catch (error) {
    // A version mismatch or a bad timestamp is the client's problem and
    // retrying will not fix it.
    return {
      status: 400,
      body: { error: 'rejected', message: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function listIssues(request: ApiRequest, options: RouterOptions): Promise<ApiResponse> {
  const limit = parseLimit(request.query.get('limit'));
  if (limit instanceof Error) {
    return { status: 400, body: { error: 'bad_request', message: limit.message } };
  }

  const issues = await options.quorum.issues({
    ...options.issueDefaults,
    now: options.now(),
    ...(limit !== undefined && { limit }),
  });

  return {
    status: 200,
    body: {
      issues: issues.map(summary),
      // Stated rather than implied: the caller should know these are computed
      // now rather than read from a table, because it bounds how fresh they
      // are and how much they cost.
      computedAt: options.now().toISOString(),
      total: issues.length,
    },
  };
}

async function getIssue(id: string, options: RouterOptions): Promise<ApiResponse> {
  const issue = (await allIssues(options)).find((candidate) => candidate.id === id);
  if (issue === undefined) return notFound();
  return { status: 200, body: issue };
}

/**
 * The verbatim evidence behind an issue.
 *
 * A separate endpoint rather than a bigger issue payload: a cluster can have
 * thousands of members, and the list view must not carry them. Every ranked
 * row is still drillable, which is the requirement (ADR-0012) — it just costs
 * a second request.
 */
async function getEvidence(id: string, options: RouterOptions): Promise<ApiResponse> {
  const issue = (await allIssues(options)).find((candidate) => candidate.id === id);
  if (issue === undefined) return notFound();

  const members = new Set(issue.memberIds);
  const submissions = (await options.quorum.submissions())
    .filter((submission) => members.has(submission.id))
    .map((submission) => ({
      id: submission.id,
      body: submission.body,
      kind: submission.kind,
      source: submission.source,
      clientTs: submission.clientTs,
      userId: submission.userId,
      attributed: submission.attributed,
      ...(submission.route !== undefined && { route: submission.route }),
    }));

  return { status: 200, body: { issueId: id, total: submissions.length, submissions } };
}

function allIssues(options: RouterOptions): Promise<Issue[]> {
  return options.quorum.issues({ ...options.issueDefaults, now: options.now() });
}

/** The list view: everything needed to render a row, without the full evidence. */
function summary(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    title: issue.title,
    score: issue.score,
    // The components ride along on the list, not just the detail view. A
    // ranked row a reader cannot interrogate is one nobody believes, and
    // making them fetch each row to find out why is the same thing as hiding it.
    components: issue.components,
    explanation: issue.explanation,
    uniqueUsers: issue.uniqueUsers,
    submissionCount: issue.submissionCount,
    kinds: issue.kinds,
    ...(issue.topRoute !== undefined && { topRoute: issue.topRoute }),
    quotes: issue.quotes,
  };
}

function parseLimit(raw: string | null): number | undefined | Error {
  if (raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return new Error(`limit must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  // Clamped rather than rejected: an over-large limit is a caller being
  // optimistic, not a caller being wrong.
  return Math.min(value, MAX_LIMIT);
}

function isEnvelopeShaped(value: unknown): value is CaptureEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Record<string, unknown>;
  return (
    typeof envelope['v'] === 'number' &&
    typeof envelope['project'] === 'string' &&
    Array.isArray(envelope['events'])
  );
}
