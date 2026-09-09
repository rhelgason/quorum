/**
 * The browser client: identity, context, redaction, and the send.
 *
 * `@quorum/core` has had the durable queue and the ingest transport since the
 * first week, fully tested, and nothing was calling them. This is the file
 * that connects the element to them, and it is where three of the ranking
 * signals the README claims actually get produced:
 *
 *  - **`identify()` with traits** — `mrr` in the traits bag is what makes the
 *    ranked list revenue-weighted instead of a popularity contest. Without it
 *    `accountWeight` returns 1.0 for everyone and the product degrades to
 *    counting heads (ADR-0015).
 *  - **route and app version** — the structural signal. `docs/PROTOCOL.md`
 *    rule 4 makes these first-class fields rather than `metadata` soup,
 *    because burying them guarantees inconsistent keys across customers.
 *  - **a stable anonymous id** — see `storage.ts`.
 *
 * ## The order of operations is the design
 *
 * Redact, then persist, then send. Redaction happens before the event is
 * written anywhere, so a secret is never at rest even in `localStorage`
 * (ADR-0007). Persistence happens before the network attempt, so closing the
 * tab mid-submit cannot lose the submission (`queue.ts`). Everything after
 * that is the transport's problem, and it already implements the protocol's
 * error table.
 *
 * ## What this does not do
 *
 * No DOM snapshot, no console ring buffer, no network log, no element picker,
 * no frustration detection. Those are v0.2/v0.3 and they attach to the
 * `captureRef` field this deliberately leaves empty.
 */

import { OfflineQueue, type QueueStorage } from '../../core/src/queue.ts';
import { DEFAULT_RULES, scan, type RedactionRule } from '../../core/src/redact.ts';
import { Transport, type FlushResult } from '../../core/src/transport.ts';
import { ulid } from '../../core/src/ulid.ts';
import type {
  CaptureEvent,
  ContextBlock,
  ElementBlock,
  SubmissionKind,
  SubmissionSource,
  UserBlock,
} from '../../core/src/protocol.ts';
import { anonIdFor, createWebQueueStorage } from './storage.ts';

/** SDK version, reported in every envelope's context block. */
export const SDK_VERSION = '0.0.0';

export interface QuorumClientOptions {
  /** Public write key. */
  project: string;
  /**
   * Ingest origin. Default `''`, meaning same-origin — the transport posts to
   * `/v0/ingest` relative to the page.
   *
   * Same-origin is the right default for the self-host case the whole project
   * is built around, and it is the only one that works without the operator
   * configuring CORS.
   */
  endpoint?: string;
  /** Reported as `context.appVersion`, and a structural clustering signal. */
  appVersion?: string;
  /** Injected for tests; defaults to a `localStorage`-backed queue. */
  storage?: QueueStorage;
  queue?: OfflineQueue;
  transport?: Transport;
  /** Stable anonymous id. Pass `null` to send none. */
  anonId?: string | null;
  /** `false` disables client-side redaction. Strongly discouraged; ADR-0007. */
  redact?: boolean | readonly RedactionRule[];
  /** Current route. Default `location.pathname`. */
  route?: () => string | undefined;
  now?: () => Date;
  newId?: () => string;
  fetchImpl?: typeof fetch;
}

export interface SubmitInput {
  /**
   * Pre-generated ULID.
   *
   * The panel state machine reports the id in its `submit` event *before* the
   * network round trip, so a caller driving that machine has to know the id
   * first. Omitted, one is generated here.
   */
  id?: string;
  draft: string;
  kind: SubmissionKind;
  source?: SubmissionSource;
  /** Per-submission context from `open({ context })`. */
  context?: Record<string, unknown>;
  element?: ElementBlock;
}

/**
 * What happened to one submission.
 *
 * `queued` is not a failure and must not be presented as one. It means the
 * event is durable locally and will go out on a later flush, which for an
 * offline user is the system working exactly as designed.
 */
export type SubmitOutcome =
  | { status: 'accepted'; id: string }
  | { status: 'queued'; id: string; queueDepth: number }
  | { status: 'failed'; id: string; error: Error };

export class QuorumClient {
  readonly #queue: OfflineQueue;
  readonly #transport: Transport;
  readonly #appVersion: string | undefined;
  readonly #anonId: string | undefined;
  readonly #rules: readonly RedactionRule[] | undefined;
  readonly #route: () => string | undefined;
  readonly #now: () => Date;
  readonly #newId: () => string;
  #user: UserBlock | undefined;
  #detachOnline: (() => void) | undefined;

  constructor(options: QuorumClientOptions) {
    this.#appVersion = options.appVersion;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? ulid;
    this.#route = options.route ?? defaultRoute;

    if (options.redact === false) this.#rules = undefined;
    else if (Array.isArray(options.redact)) this.#rules = options.redact as readonly RedactionRule[];
    else this.#rules = DEFAULT_REDACTION;

    this.#anonId =
      options.anonId === null ? undefined : (options.anonId ?? anonIdFor(options.project));

    this.#queue =
      options.queue ??
      new OfflineQueue({
        storage: options.storage ?? createWebQueueStorage(`quorum.queue.${options.project}`),
      });

    this.#transport =
      options.transport ??
      new Transport({
        endpoint: options.endpoint ?? '',
        project: options.project,
        queue: this.#queue,
        ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
        ...(options.now !== undefined && { now: () => this.#now().getTime() }),
      });
  }

  /**
   * Attach the caller's identity to every subsequent submission.
   *
   * `traits.mrr` is the one that changes the ranked list. Everything else
   * rides along for the reader's benefit.
   *
   * Deliberately not retroactive: events already queued keep the identity they
   * were built with. Rewriting them would mean an offline flush could
   * attribute a submission to whoever happened to log in afterwards.
   */
  identify(externalId: string, traits?: UserBlock['traits']): void {
    this.#user = {
      externalId,
      ...(this.#anonId !== undefined && { anonId: this.#anonId }),
      ...(traits !== undefined && { traits }),
    };
  }

  /** Forget the identified user. Call on logout. */
  reset(): void {
    this.#user = undefined;
  }

  get queueDepth(): number {
    return this.#queue.size;
  }

  /** The user block as it would be attached right now. */
  get user(): UserBlock | undefined {
    if (this.#user !== undefined) return this.#user;
    return this.#anonId === undefined ? undefined : { anonId: this.#anonId };
  }

  /**
   * Build the wire event for a submission.
   *
   * Separated from {@link submit} because it is the part with rules in it —
   * redaction, identity, and which context fields are populated — and it is
   * worth testing without a network anywhere near it.
   */
  buildEvent(input: SubmitInput): CaptureEvent {
    const id = input.id ?? this.#newId();
    const redacted = this.#rules === undefined ? undefined : scan(input.draft, this.#rules);
    const body = redacted?.text ?? input.draft;

    return {
      id,
      kind: input.kind,
      source: input.source ?? 'nub',
      clientTs: this.#now().toISOString(),
      ...(body !== '' && { body }),
      ...(this.user !== undefined && { user: this.user }),
      context: this.#context(input.context),
      ...(input.element !== undefined && { element: input.element }),
      // Shipped even when nothing matched, so an audit can see the policy that
      // ran rather than infer it from an absence (ADR-0007).
      ...(redacted !== undefined && {
        redaction: { rules: this.#rules?.map((rule) => rule.kind) ?? [], maskedCount: redacted.total },
      }),
    };
  }

  /**
   * Redact, persist, send.
   *
   * Never throws. A widget that throws into a host page's click handler is a
   * widget that gets removed, and there is nothing a caller could usefully do
   * with the exception anyway — the event is already durable by the time
   * anything can fail.
   */
  async submit(input: SubmitInput): Promise<SubmitOutcome> {
    const event = this.buildEvent(input);

    // Before the network, always. A user who submits and immediately closes
    // the tab is a large fraction of frustrated users.
    this.#queue.enqueue(event);

    let result: FlushResult;
    try {
      result = await this.#transport.flush();
    } catch {
      // The transport is written not to throw, but it takes an injected
      // `fetch` and this runs in someone else's page. `queued` is the honest
      // answer either way: the event is durable and a later flush will retry.
      return { status: 'queued', id: event.id, queueDepth: this.#queue.size };
    }

    // Checked before the queue, and the order matters. A 401 disables the
    // transport for the whole session, so the event *is* still queued — but it
    // will never be sent, and reporting `queued` would put "we'll send it when
    // you're back online" in front of someone whose feedback is never going
    // anywhere. That is the one lie this function must not tell.
    if (result.disabled) {
      return {
        status: 'failed',
        id: event.id,
        error: new Error('ingest rejected the project key; disabled for this session'),
      };
    }

    if (this.#queue.peek().some((queued) => queued.id === event.id)) {
      return { status: 'queued', id: event.id, queueDepth: this.#queue.size };
    }

    // Gone from the queue and something was dropped: the only way that happens
    // to this event is a 400 or an oversized single event, both permanent.
    // Reporting success would be a lie too.
    if (result.dropped > 0) {
      return {
        status: 'failed',
        id: event.id,
        error: new Error('ingest rejected this submission as malformed'),
      };
    }

    return { status: 'accepted', id: event.id };
  }

  /** Drain whatever is queued. Safe to call at any time. */
  flush(): Promise<FlushResult> {
    return this.#transport.flush();
  }

  /**
   * Flush when the browser says it is back online.
   *
   * The whole reason the queue exists, and cheap enough that it is on by
   * default. Returns a detach function; the element calls it on disconnect.
   */
  watchConnectivity(target: EventTarget | undefined = globalThis as EventTarget): () => void {
    if (target === undefined || typeof target.addEventListener !== 'function') return () => undefined;

    const onOnline = (): void => {
      void this.flush();
    };
    target.addEventListener('online', onOnline);

    this.#detachOnline = () => target.removeEventListener('online', onOnline);
    return this.#detachOnline;
  }

  /** Release listeners. */
  destroy(): void {
    this.#detachOnline?.();
    this.#detachOnline = undefined;
  }

  #context(custom: Record<string, unknown> | undefined): ContextBlock {
    const route = this.#route();
    const view = (globalThis as { innerWidth?: number; innerHeight?: number });
    const nav = (globalThis as { navigator?: { language?: string } }).navigator;

    return {
      ...(route !== undefined && route !== '' && { route }),
      ...(this.#appVersion !== undefined && { appVersion: this.#appVersion }),
      sdkVersion: SDK_VERSION,
      platform: 'web',
      ...(nav?.language !== undefined && { locale: nav.language }),
      ...(typeof view.innerWidth === 'number' &&
        typeof view.innerHeight === 'number' && {
          viewport: [view.innerWidth, view.innerHeight] as [number, number],
        }),
      ...(custom !== undefined && { custom }),
    };
  }
}

/**
 * Redaction rules applied by default.
 *
 * Core's list, not a copy. A second list here would drift, and the failure
 * mode of drifting redaction rules is a secret in somebody's database.
 */
const DEFAULT_REDACTION: readonly RedactionRule[] = DEFAULT_RULES;

function defaultRoute(): string | undefined {
  const location = (globalThis as { location?: { pathname?: string } }).location;
  return location?.pathname;
}
