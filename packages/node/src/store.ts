/**
 * The persistence seam.
 *
 * `MemoryStore` is the whole implementation today, which is honest about where
 * the project is: `services/api` and the Postgres schema in
 * `docs/DATA-MODEL.md` are still design. What matters is that the interface is
 * the shape Postgres will implement — async, project-scoped, idempotent on
 * `(projectId, id)` — so the swap is a new class rather than a rewrite of
 * everything upstream of it.
 *
 * Two guarantees the rest of the package leans on, both load-bearing:
 *
 * **Idempotency.** `put` returning `false` for an id already present is what
 * makes the whole ingest path retryable, which `docs/PROTOCOL.md` requires of
 * the offline queue and which import re-runs depend on
 * (`derivedId` in `submission.ts`).
 *
 * **Stable ordering.** `list` returns insertion order, always. Leader-follower
 * clustering is order-dependent by design
 * (`packages/aggregate/src/cluster.ts`), so an unstable iteration order would
 * reshuffle cluster ids between two reads of unchanged data — indistinguishable
 * from churn to anyone reading the ranked list, and the precise failure
 * ADR-0005 exists to prevent. Append-only insertion order keeps existing
 * assignments fixed as new feedback arrives.
 */

import type { Submission } from './submission.ts';

export interface SubmissionStore {
  /**
   * Append one submission. Returns `false` when `(projectId, id)` is already
   * present — a duplicate, which is success, not an error.
   */
  put(submission: Submission): Promise<boolean>;
  /** Every submission for a project, in insertion order. */
  list(projectId: string): Promise<readonly Submission[]>;
  get(projectId: string, id: string): Promise<Submission | undefined>;
  count(projectId: string): Promise<number>;
}

/**
 * In-process store. Suitable for a CLI import, an eval run, a test, or a
 * single-process self-host with modest volume — not for anything that needs to
 * survive a restart.
 */
export class MemoryStore implements SubmissionStore {
  // Per-project insertion-ordered lists, plus an id index so `put` stays O(1).
  // A Map's iteration order is insertion order, so the index alone would do —
  // but relying on that for the *ordering guarantee* rather than just for
  // lookup would make it easy to break by switching to a plain object later.
  readonly #byProject = new Map<string, Submission[]>();
  readonly #ids = new Map<string, Set<string>>();

  put(submission: Submission): Promise<boolean> {
    const { projectId, id } = submission;

    let ids = this.#ids.get(projectId);
    if (ids === undefined) {
      ids = new Set();
      this.#ids.set(projectId, ids);
      this.#byProject.set(projectId, []);
    }
    if (ids.has(id)) return Promise.resolve(false);

    ids.add(id);
    this.#byProject.get(projectId)?.push(submission);
    return Promise.resolve(true);
  }

  list(projectId: string): Promise<readonly Submission[]> {
    // A copy, so a caller mutating the result cannot corrupt the append-only
    // log — the one property the whole audit story rests on.
    return Promise.resolve([...(this.#byProject.get(projectId) ?? [])]);
  }

  get(projectId: string, id: string): Promise<Submission | undefined> {
    if (this.#ids.get(projectId)?.has(id) !== true) return Promise.resolve(undefined);
    return Promise.resolve(this.#byProject.get(projectId)?.find((s) => s.id === id));
  }

  count(projectId: string): Promise<number> {
    return Promise.resolve(this.#byProject.get(projectId)?.length ?? 0);
  }
}
