/**
 * Backend exceptions as feedback.
 *
 * A thrown error is a user telling you something is broken without filing a
 * ticket, so it belongs in the same canonical-issue store as everything else.
 * Two things have to be got right first, and both are easy to get wrong in
 * ways that produce a plausible-looking, wrong ranked list.
 *
 * **Grouping must key on the stack, not the message.** Messages embed
 * identifiers, so text similarity puts every occurrence in its own cluster and
 * a crash affecting thousands never ranks at all. The stack is the stable
 * identity of a defect and it is what `fingerprint` is computed from.
 *
 * **Attribution is the caller's job, and unattributed crashes underrank by
 * design.** See `exceptionFallbackKey`.
 */

import { derivedId, scrubVariableData } from './submission.ts';

/** How many frames make up the identity of a defect. */
const FINGERPRINT_FRAMES = 5;

export interface ParsedFrame {
  /** Function or method name; `<anonymous>` when the frame has none. */
  fn: string;
  /** File basename. Absolute paths differ per deploy and per machine. */
  file: string;
}

/**
 * Pull normalized frames out of a `stack` string.
 *
 * Everything that varies between two occurrences of the same bug is discarded:
 *
 * - **Absolute paths** — `/app/src/cart.js` in the container,
 *   `/Users/me/src/cart.js` locally, `/var/task/...` on Lambda. Same file.
 * - **Line and column numbers** — these move on every unrelated edit to the
 *   file. Keeping them means a defect's identity changes when someone adds a
 *   comment above it, and the ranked list shows the same crash twice.
 * - **Runtime-internal frames** — `node:internal/...` is the same for every
 *   error ever thrown and contributes nothing but false similarity.
 */
export function parseFrames(stack: string | undefined): ParsedFrame[] {
  if (stack === undefined || stack === '') return [];

  const frames: ParsedFrame[] = [];
  for (const line of stack.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) continue;

    const body = trimmed.slice(3).trim();
    if (body.startsWith('node:')) continue;

    // Two shapes: `fn (location)` and a bare `location`.
    const withFn = /^(.*?)\s+\((.*)\)$/.exec(body);
    const fn = withFn?.[1]?.trim() ?? '<anonymous>';
    const location = withFn?.[2] ?? body;
    if (location.startsWith('node:')) continue;

    // V8 emits synthetic frames whose "location" is not a path at all —
    // `at async Promise.all (index 0)`. The index varies with unrelated
    // concurrency, so keeping them would make a defect's identity depend on
    // how many promises happened to be in flight.
    if (!/[\\/.]/.test(location)) continue;

    frames.push({ fn: fn === '' ? '<anonymous>' : fn, file: basename(stripPosition(location)) });
  }
  return frames;
}

/** Drop a trailing `:line:col`, tolerating Windows drive letters. */
function stripPosition(location: string): string {
  return location.replace(/:\d+:\d+$/, '').replace(/:\d+$/, '');
}

function basename(path: string): string {
  const cleaned = path.replace(/^.*[\\/]/, '');
  // `file:///app/src/cart.js` and query-suffixed bundles both show up.
  return cleaned.split('?')[0] ?? cleaned;
}

/**
 * Stable identity for a defect.
 *
 * Falls back to the scrubbed message when there is no usable stack — a
 * transport error crossing a process boundary often arrives as message only.
 * Weaker, but it still groups occurrences that a raw message never would.
 */
export function fingerprint(name: string, message: string, stack?: string): string {
  const frames = parseFrames(stack).slice(0, FINGERPRINT_FRAMES);
  const parts =
    frames.length > 0
      ? [name, ...frames.map((f) => `${f.fn}@${f.file}`)]
      : [name, scrubVariableData(message)];
  return derivedId(parts).replace(/^im_/, 'ex_');
}

/**
 * Text the clusterer sees for an exception.
 *
 * The verbatim message stays in `body`; this is the derived form. Scrubbing
 * removes per-occurrence identifiers, and the top frames are appended because
 * two different bugs can share a generic message ("Request failed") and be
 * told apart only by where they were thrown.
 */
export function exceptionClusterText(name: string, message: string, stack?: string): string {
  const frames = parseFrames(stack).slice(0, 2);
  const head = `${name}: ${scrubVariableData(message)}`;
  return frames.length === 0 ? head : `${head} ${frames.map((f) => `${f.fn} ${f.file}`).join(' ')}`;
}

/**
 * Grouping key for an exception nobody could attribute to a user.
 *
 * There is no correct answer here, only a choice of which way to be wrong.
 *
 * One key per defect means a crash hitting five thousand users counts as one
 * user and sits near the bottom. One key per occurrence means a retry loop
 * hammering the same endpoint counts as five thousand users and owns the top
 * of the roadmap. Both are wrong; they are not equally wrong.
 *
 * **Unattributed exceptions are bucketed per defect per day.** A bug present
 * for three weeks accrues twenty-one units of demand; a retry storm inside one
 * afternoon accrues one. Volume within a day is deliberately discarded,
 * because a machine can generate unbounded volume and a human cannot, and a
 * ranked list a machine can inflate is worthless.
 *
 * The bias is toward underranking, chosen on purpose: a crash that ranks too
 * low still gets corrected by the humans who file about it, whereas a retry
 * loop at position one is unrecoverable garbage that discredits the whole
 * list. Pass `user` to `captureException` and none of this applies — real
 * attribution beats every heuristic here.
 */
export function exceptionFallbackKey(fp: string, clientTs: string): string {
  const day = clientTs.slice(0, 10);
  return `x:${fp}:${day}`;
}

/** Name, message, and stack off an unknown throwable. Non-`Error` throws happen. */
export function describeThrowable(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name === '' ? 'Error' : err.name,
      message: err.message,
      ...(err.stack !== undefined && { stack: err.stack }),
    };
  }
  if (typeof err === 'string') return { name: 'Error', message: err };
  // `throw { code: 'X' }` is legal and does happen in the wild.
  return { name: 'Error', message: safeStringify(err) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular structures, or a toJSON that throws.
    return String(value);
  }
}
