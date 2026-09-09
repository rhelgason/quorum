/**
 * A Chrome DevTools Protocol client, in about two hundred lines and zero
 * dependencies.
 *
 * Node 24 ships a global `WebSocket`, and CDP is a JSON-RPC dialect over one
 * socket. That is the entire trick: the reason a browser driver normally
 * arrives as a large dependency is the *capability* surface — selectors,
 * auto-waiting, network interception, video — none of which is needed to
 * answer the only question this repo has, which is "does `<quorum-nub>`
 * actually render and respond to a click."
 *
 * Deliberately not built here: element handles, selector engines, waiting
 * strategies, or anything resembling a page object. Tests evaluate expressions
 * in the page and get JSON back. When that stops being enough, the answer is
 * Playwright from a machine with registry access, not growing this file.
 *
 * ## Sessions
 *
 * Connecting to the browser endpoint gives a connection that can talk *about*
 * targets but not *to* them. `Target.attachToTarget` with `flatten: true`
 * returns a session id which then rides on every message for that page. All
 * the page-scoped methods below carry it; the browser-scoped ones do not.
 */

/** A CDP method call awaiting its reply. */
interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export type CdpListener = (event: CdpEvent) => void;

/**
 * The part of `WebSocket` this uses.
 *
 * Narrowed to an interface so the framing logic — id correlation, error
 * mapping, timeouts, the rejection of everything in flight when the socket
 * dies — is testable without a browser or a WebSocket server, neither of which
 * Node provides. That logic is where the bugs would be; the socket is not.
 */
export interface SocketLike {
  addEventListener(type: string, listener: (event: unknown) => void, options?: { once?: boolean }): void;
  send(data: string): void;
  close(): void;
}

/**
 * One WebSocket to a DevTools endpoint.
 *
 * Every send is timed out. A CDP call that never returns is the single most
 * common way a browser-driving test suite hangs a CI runner for its full
 * wall-clock limit, and the failure is undiagnosable after the fact because
 * the process is killed rather than reporting anything.
 */
export class CdpConnection {
  readonly #socket: SocketLike;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<CdpListener>();
  readonly #timeoutMs: number;
  #nextId = 1;
  #closed: Error | undefined;

  private constructor(socket: SocketLike, timeoutMs: number) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;

    socket.addEventListener('message', (event) => {
      this.#receive(String((event as { data: unknown }).data));
    });
    socket.addEventListener('close', () => {
      this.#fail(new Error('devtools connection closed'));
    });
    socket.addEventListener('error', () => {
      this.#fail(new Error('devtools connection errored'));
    });
  }

  /** Wrap an already-open socket. The seam the framing tests use. */
  static attach(socket: SocketLike, timeoutMs = 10_000): CdpConnection {
    return new CdpConnection(socket, timeoutMs);
  }

  /** Open a connection, resolving once the socket is actually usable. */
  static connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`timed out connecting to ${url}`));
      }, timeoutMs);

      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new CdpConnection(socket as SocketLike, timeoutMs));
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error(`could not connect to ${url}`));
        },
        { once: true },
      );
    });
  }

  /**
   * Call a CDP method.
   *
   * A protocol-level `error` is rethrown with the method name attached.
   * CDP's own messages are things like "Cannot find context with specified
   * id", which is unattributable without knowing what asked.
   */
  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.#closed !== undefined) throw this.#closed;

    const id = this.#nextId++;
    const message = JSON.stringify({
      id,
      method,
      params,
      ...(sessionId !== undefined && { sessionId }),
    });

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);

      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.#socket.send(message);
    });
  }

  /** Subscribe to every event on the connection. Returns an unsubscribe. */
  on(listener: CdpListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Wait for one matching event.
   *
   * Used for the handful of genuinely asynchronous browser facts — page load,
   * mainly. Everything else is a request/response and does not need this.
   */
  once(method: string, timeoutMs = this.#timeoutMs): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);

      const off = this.on((event) => {
        if (event.method !== method) return;
        clearTimeout(timer);
        off();
        resolve(event);
      });
    });
  }

  close(): void {
    this.#fail(new Error('connection closed by caller'));
    try {
      this.#socket.close();
    } catch {
      // Already closing. Nothing to do and nothing worth reporting.
    }
  }

  #receive(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const id = message['id'];
    if (typeof id === 'number') {
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);

      const error = message['error'] as { message?: string; data?: string } | undefined;
      if (error !== undefined) {
        const detail = error.data === undefined ? '' : ` (${error.data})`;
        pending.reject(new Error(`${error.message ?? 'cdp error'}${detail}`));
        return;
      }
      pending.resolve((message['result'] as Record<string, unknown>) ?? {});
      return;
    }

    const method = message['method'];
    if (typeof method !== 'string') return;

    const event: CdpEvent = {
      method,
      params: (message['params'] as Record<string, unknown>) ?? {},
      ...(typeof message['sessionId'] === 'string' && { sessionId: message['sessionId'] }),
    };
    // A listener that throws must not take down the socket's message pump and
    // strand every other in-flight call.
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Reported by whatever the listener was feeding, not here.
      }
    }
  }

  /** Reject everything in flight. A dead socket will never answer any of it. */
  #fail(error: Error): void {
    if (this.#closed !== undefined) return;
    this.#closed = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#listeners.clear();
  }
}
