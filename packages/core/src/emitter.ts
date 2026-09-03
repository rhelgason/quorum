/**
 * A tiny typed event emitter.
 *
 * `quorum.on(event, handler)` is public API, so this is the shape every layer
 * above core subscribes through — the web component re-dispatches these as
 * composed DOM events, and `@quorum/react` wraps them as callbacks.
 *
 * Two properties matter more than features here, and both exist because this
 * code runs inside somebody else's production application:
 *
 * **A throwing handler cannot break the emitter.** A customer's analytics
 * callback that throws must not abort the remaining listeners or unwind into
 * the middle of a state transition. Handler errors are isolated and reported
 * through `onListenerError`, never rethrown.
 *
 * **Mutating listeners during a dispatch is safe.** Handlers commonly call
 * `off()` on themselves, or `on()` for a follow-up. Iterating the live set
 * would skip or double-invoke; a snapshot is taken per emit.
 */

export type Listener<T> = (payload: T) => void;

export interface EmitterOptions {
  /**
   * Called when a listener throws. Defaults to reporting on the console —
   * swallowing it entirely would make a customer's broken handler invisible,
   * which is its own support burden.
   */
  onListenerError?: (error: unknown, event: string) => void;
}

export class Emitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();
  readonly #onListenerError: (error: unknown, event: string) => void;

  constructor(options: EmitterOptions = {}) {
    this.#onListenerError =
      options.onListenerError ??
      ((error, event): void => {
        console.error(`[quorum] listener for "${event}" threw`, error);
      });
  }

  /** Returns an unsubscribe function, so callers need not retain the handler. */
  on<K extends keyof Events>(event: K, handler: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(handler as Listener<never>);
    return () => {
      this.off(event, handler);
    };
  }

  /** Fires at most once, and unsubscribes before the handler runs. */
  once<K extends keyof Events>(event: K, handler: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, handler: Listener<Events[K]>): void {
    const set = this.#listeners.get(event);
    if (set === undefined) return;
    set.delete(handler as Listener<never>);
    if (set.size === 0) this.#listeners.delete(event);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (set === undefined) return;

    // Snapshot: a handler that unsubscribes itself or adds another must not
    // corrupt this dispatch.
    for (const handler of [...set]) {
      try {
        (handler as Listener<Events[K]>)(payload);
      } catch (error) {
        this.#onListenerError(error, String(event));
      }
    }
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  removeAll(): void {
    this.#listeners.clear();
  }
}
