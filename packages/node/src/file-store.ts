/**
 * A durable `SubmissionStore` backed by an append-only JSONL file.
 *
 * Not Postgres. `docs/DATA-MODEL.md` specifies Postgres + pgvector and that is
 * still the target; there is no database in the environment this was written
 * in, and shipping a half-mocked one would be worse than shipping a real
 * simpler thing. This is a real simpler thing: it survives a restart, it is
 * inspectable with `tail`, and it has zero dependencies.
 *
 * **Append-only is not a limitation here, it is the data model.** DATA-MODEL's
 * organizing rule is that submissions are immutable facts and canonical issues
 * are mutable interpretations. A file you only ever append to enforces the
 * first half at the storage layer, which is a stronger guarantee than an
 * `UPDATE` you have merely promised not to write.
 *
 * What it is not: concurrent-safe across processes, indexed for anything but
 * id lookup, or a place to put a million rows. Those are the reasons Postgres
 * is still on the roadmap — see the README.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';

import type { SubmissionStore } from './store.ts';
import type { Submission } from './submission.ts';

export interface FileStoreOptions {
  /** Path to the JSONL log. Parent directories are created. */
  path: string;
  /**
   * `fsync` after every append. Default false.
   *
   * Off by default because it costs a disk round trip per submission and the
   * failure it protects against — losing the last few writes to a power cut,
   * not a process crash — is one most self-hosters will trade away. On is the
   * right answer if this is the only copy of the data.
   */
  durable?: boolean;
  /** Called for each unparseable line found at startup. */
  onCorruptLine?: (lineNumber: number, raw: string) => void;
}

export class FileStore implements SubmissionStore {
  readonly #path: string;
  readonly #durable: boolean;
  // Whole log in memory, mirroring the file. Honest about the scale ceiling:
  // this is a single-process self-host store, not a database.
  readonly #byProject = new Map<string, Submission[]>();
  readonly #ids = new Map<string, Set<string>>();

  constructor(options: FileStoreOptions) {
    this.#path = options.path;
    this.#durable = options.durable ?? false;

    const dir = dirname(this.#path);
    if (dir !== '' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.#load(options.onCorruptLine);
  }

  /**
   * Read the log back into memory.
   *
   * A malformed line is skipped, never thrown. Two reasons, and the second is
   * the one that matters: a crash mid-append leaves a truncated final line, so
   * throwing would mean one badly-timed power cut permanently prevents the
   * service from starting. Same rule as the client-side queue in
   * `@quorum/core` — corrupt storage must not brick the thing that reads it.
   */
  #load(onCorruptLine: FileStoreOptions['onCorruptLine']): void {
    if (!existsSync(this.#path)) return;

    const raw = readFileSync(this.#path, 'utf8');
    const lines = raw.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.trim() === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        onCorruptLine?.(i + 1, line);
        continue;
      }
      if (!isSubmission(parsed)) {
        onCorruptLine?.(i + 1, line);
        continue;
      }
      this.#index(parsed);
    }
  }

  #index(submission: Submission): boolean {
    const { projectId, id } = submission;
    let ids = this.#ids.get(projectId);
    if (ids === undefined) {
      ids = new Set();
      this.#ids.set(projectId, ids);
      this.#byProject.set(projectId, []);
    }
    // A duplicate id already in the log is a replayed write, not corruption.
    // First one wins, matching MemoryStore.
    if (ids.has(id)) return false;
    ids.add(id);
    this.#byProject.get(projectId)?.push(submission);
    return true;
  }

  put(submission: Submission): Promise<boolean> {
    if (!this.#index(submission)) return Promise.resolve(false);

    // Index first, then write: if the write throws, the in-memory view is
    // ahead of disk for this process, which is recoverable. Writing first and
    // indexing second would risk a duplicate line on retry.
    const line = `${JSON.stringify(submission)}\n`;
    if (this.#durable) {
      const fd = openSync(this.#path, 'a');
      try {
        appendFileSync(fd, line);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else {
      appendFileSync(this.#path, line);
    }
    return Promise.resolve(true);
  }

  list(projectId: string): Promise<readonly Submission[]> {
    return Promise.resolve([...(this.#byProject.get(projectId) ?? [])]);
  }

  get(projectId: string, id: string): Promise<Submission | undefined> {
    if (this.#ids.get(projectId)?.has(id) !== true) return Promise.resolve(undefined);
    return Promise.resolve(this.#byProject.get(projectId)?.find((s) => s.id === id));
  }

  count(projectId: string): Promise<number> {
    return Promise.resolve(this.#byProject.get(projectId)?.length ?? 0);
  }

  /** Projects with at least one submission. */
  projects(): string[] {
    return [...this.#byProject.keys()];
  }
}

/**
 * Structural check on a parsed line.
 *
 * Deliberately shallow: it validates the fields the pipeline will dereference,
 * not the whole shape. A stricter check would reject rows written by a newer
 * version that added a field, which is the opposite of what PROTOCOL's
 * additive-only rule promises.
 */
function isSubmission(value: unknown): value is Submission {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row['id'] === 'string' &&
    typeof row['projectId'] === 'string' &&
    typeof row['body'] === 'string' &&
    typeof row['clusterText'] === 'string' &&
    typeof row['userId'] === 'string' &&
    typeof row['clientTs'] === 'string' &&
    typeof row['kind'] === 'string' &&
    typeof row['source'] === 'string'
  );
}
