/**
 * A JSONL embedding cache on disk.
 *
 * The point is iteration cost. Embedding the corpus against a local model
 * takes long enough that re-running the sweep to change one threshold is
 * annoying, and against a hosted endpoint it costs money each time. Once the
 * vectors are on disk, every subsequent sweep is instant and offline — which
 * also means a sweep can be re-run and its numbers reproduced by someone with
 * no model at all, as long as they have the file.
 *
 * JSONL rather than a binary format, for the same reason `FileStore` is: it is
 * inspectable with `tail`, a line truncated by a crash is skippable, and there
 * is no schema migration story to own. Vectors are a few hundred floats;
 * compactness is not the constraint.
 *
 * Rounded to 6 decimals on write. Cosine similarity of unit vectors is not
 * remotely sensitive at that precision, and it roughly halves the file.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { cacheKey, parseCacheKey, type EmbeddingCache } from '../../aggregate/src/embed-cache.ts';

/** Decimals kept per component. */
const PRECISION = 6;

export interface FileEmbeddingCache extends EmbeddingCache {
  readonly size: number;
  /** Entries appended during this process. */
  readonly written: number;
  /** Lines skipped as unparseable. */
  readonly corrupt: number;
}

interface Line {
  model: string;
  text: string;
  vector: number[];
}

/**
 * Open (or create) a cache at `path`.
 *
 * Read fully into memory on open and appended to on write, which is the same
 * trade `FileStore` makes and acceptable for the same reason: the corpus is
 * hundreds of items, not millions. A later duplicate key wins, so re-embedding
 * with a changed model under the same name updates rather than conflicts.
 */
export function openEmbeddingCache(path: string): FileEmbeddingCache {
  const map = new Map<string, Float64Array>();
  let corrupt = 0;
  let written = 0;

  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as Line;
        if (typeof parsed.model !== 'string' || typeof parsed.text !== 'string') {
          corrupt++;
          continue;
        }
        if (!Array.isArray(parsed.vector)) {
          corrupt++;
          continue;
        }
        map.set(cacheKey(parsed.model, parsed.text), Float64Array.from(parsed.vector));
      } catch {
        // A line truncated by a crash mid-append. Skipping it costs one
        // re-embed; refusing to start would cost the whole file.
        corrupt++;
      }
    }
  }

  return {
    get: (key) => map.get(key),

    set: (key, vector) => {
      map.set(key, vector);

      // Written back as model + text rather than the opaque key, so the file
      // stays greppable — "which of these did the model actually see" is the
      // first question anyone asks of a cache like this. The split goes
      // through parseCacheKey so only one module knows the separator.
      const line: Line = {
        ...parseCacheKey(key),
        vector: [...vector].map((x) => Number(x.toFixed(PRECISION))),
      };

      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(line)}\n`);
      written++;
    },

    get size() {
      return map.size;
    },
    get written() {
      return written;
    },
    get corrupt() {
      return corrupt;
    },
  };
}
