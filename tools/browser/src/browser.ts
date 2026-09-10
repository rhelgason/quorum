/**
 * Launching a headless browser and driving one page in it.
 *
 * The surface here is chosen to be the smallest thing that can honestly verify
 * a custom element: navigate, evaluate, click, type, press a key, and read
 * back whatever went wrong. No selector engine and no auto-waiting — tests
 * evaluate expressions and get JSON, which for shadow DOM is *better* than a
 * selector API, because reaching into a shadow root is one line of JavaScript
 * and a whole feature in a driver.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CdpConnection, type CdpEvent } from './cdp.ts';
import { locateBrowser } from './locate.ts';

/** `Input.dispatchKeyEvent` takes modifiers as a bitmask. */
export const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

export interface LaunchOptions {
  /** Defaults to whatever {@link locateBrowser} finds. */
  executablePath?: string;
  /** Set `false` to watch it happen. Invaluable when a DOM test is lying. */
  headless?: boolean;
  timeoutMs?: number;
}

export interface PageError {
  kind: 'exception' | 'console';
  text: string;
}

/**
 * Flags, and why each one is here.
 *
 * The profile directory is the load-bearing one: without it Chrome may hand
 * the command line to an already-running instance and exit, printing no
 * DevTools endpoint and leaving the launch to time out with no explanation.
 */
export function chromeArgs(
  userDataDir: string,
  headless: boolean,
  env: Record<string, string | undefined> = process.env,
): string[] {
  // Containers give /dev/shm 64MB by default, and Chrome does not fail when it
  // runs out — it *hangs*, which is how this cost a CI run that sat in progress
  // until it was cancelled by hand. Harmless outside a container, so it is
  // unconditional rather than another thing to get wrong.
  const shared = ['--disable-dev-shm-usage'];

  // No user namespace on most CI runners, so the sandbox cannot start. Gated,
  // because switching it off on a developer's own machine should be a decision
  // rather than a default.
  const sandbox = env['CI'] === undefined || env['CI'] === '' ? [] : ['--no-sandbox'];

  return [
    // Port 0 makes the kernel pick, and Chrome prints the real one on stderr.
    // Choosing a port ourselves is a race against every other process.
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    ...(headless ? ['--headless=new'] : []),
    ...shared,
    ...sandbox,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    'about:blank',
  ];
}

/**
 * Pull the endpoint out of Chrome's stderr banner.
 *
 * The trailing newline is required, not decorative. This is called against a
 * buffer that grows one stderr chunk at a time, and a chunk boundary lands
 * mid-URL often enough to matter — without anchoring on the line end, the
 * launch happily connects to `ws://127.0.0.1:512` and fails somewhere far
 * away from the cause.
 */
export function parseEndpoint(stderr: string): string | undefined {
  return /DevTools listening on (ws:\/\/\S+)\r?\n/.exec(stderr)?.[1];
}

export class Browser {
  readonly #process: ChildProcess;
  readonly #connection: CdpConnection;
  readonly #userDataDir: string;
  readonly #timeoutMs: number;

  private constructor(
    process: ChildProcess,
    connection: CdpConnection,
    userDataDir: string,
    timeoutMs: number,
  ) {
    this.#process = process;
    this.#connection = connection;
    this.#userDataDir = userDataDir;
    this.#timeoutMs = timeoutMs;
  }

  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    const executablePath = options.executablePath ?? locateBrowser();
    if (executablePath === undefined) {
      throw new Error('no Chromium-family browser found; set CHROME_PATH');
    }

    const timeoutMs = options.timeoutMs ?? 20_000;
    const userDataDir = await mkdtemp(join(tmpdir(), 'quorum-cdp-'));
    const child = spawn(executablePath, chromeArgs(userDataDir, options.headless ?? true), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let endpoint: string;
    try {
      endpoint = await waitForEndpoint(child, timeoutMs);
    } catch (error) {
      child.kill('SIGKILL');
      await rm(userDataDir, { recursive: true, force: true });
      throw error;
    }

    const connection = await CdpConnection.connect(endpoint, timeoutMs);
    return new Browser(child, connection, userDataDir, timeoutMs);
  }

  /** A fresh page, already navigated and loaded. */
  async newPage(url = 'about:blank'): Promise<Page> {
    const created = await this.#connection.send('Target.createTarget', { url: 'about:blank' });
    const targetId = created['targetId'] as string;

    const attached = await this.#connection.send('Target.attachToTarget', {
      targetId,
      // Without flattening, page messages arrive wrapped inside
      // `Target.receivedMessageFromTarget` and have to be unpacked by hand.
      flatten: true,
    });
    const sessionId = attached['sessionId'] as string;

    const page = new Page(this.#connection, sessionId, targetId, this.#timeoutMs);
    await page.prepare();
    if (url !== 'about:blank') await page.goto(url);
    return page;
  }

  async close(): Promise<void> {
    this.#connection.close();
    this.#process.kill();
    await once(this.#process, 'exit', 5_000).catch(() => this.#process.kill('SIGKILL'));
    await rm(this.#userDataDir, { recursive: true, force: true });
  }
}

export class Page {
  readonly #connection: CdpConnection;
  readonly #sessionId: string;
  readonly #targetId: string;
  readonly #timeoutMs: number;
  readonly #errors: PageError[] = [];

  constructor(connection: CdpConnection, sessionId: string, targetId: string, timeoutMs: number) {
    this.#connection = connection;
    this.#sessionId = sessionId;
    this.#targetId = targetId;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Enable the domains and start collecting failures.
   *
   * Page errors are collected from the first moment rather than polled,
   * because the interesting ones happen during module evaluation — long before
   * a test gets a chance to ask.
   */
  async prepare(): Promise<void> {
    this.#connection.on((event) => this.#record(event));
    await this.#send('Page.enable');
    await this.#send('Runtime.enable');
    await this.#send('Log.enable');
  }

  /** Everything the page reported as broken since it loaded. */
  get errors(): readonly PageError[] {
    return this.#errors;
  }

  /** Throw if the page logged an error. The assertion most DOM bugs fail. */
  assertClean(): void {
    if (this.#errors.length === 0) return;
    const detail = this.#errors.map((e) => `  [${e.kind}] ${e.text}`).join('\n');
    throw new Error(`page reported ${this.#errors.length} error(s):\n${detail}`);
  }

  /**
   * Navigate, and wait for *this* navigation rather than for a load event.
   *
   * Waiting on `Page.loadEventFired` looks right and is racy: the target is
   * created at `about:blank`, and that document's own load event can arrive
   * after `Page.enable` — so the wait resolves against the wrong page, the
   * caller starts evaluating, and the real navigation wipes the DOM out from
   * under it. Asking the page where it actually is cannot get that wrong.
   */
  async goto(url: string): Promise<void> {
    const result = await this.#send('Page.navigate', { url });
    const errorText = result['errorText'];
    if (typeof errorText === 'string') throw new Error(`navigation to ${url} failed: ${errorText}`);

    const deadline = Date.now() + this.#timeoutMs;
    const check = `document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`;

    for (;;) {
      try {
        if (await this.evaluate<boolean>(check)) return;
      } catch {
        // "Cannot find context with specified id" — the execution context is
        // being swapped for the new document. Expected mid-navigation.
      }
      if (Date.now() > deadline) throw new Error(`timed out navigating to ${url}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Evaluate an expression in the page and get the value back as JSON.
   *
   * `awaitPromise` is on, so a test can await something in the page without
   * threading a callback through the protocol. A thrown exception surfaces as
   * a thrown exception here, with the page's stack in the message — otherwise
   * a failing DOM test reports `undefined` and says nothing about why.
   */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.#send('Runtime.evaluate', {
      expression,
      // Both of these are load-bearing, and `replMode` must stay off.
      //
      // With `replMode: true` the expression is evaluated as a console REPL
      // statement and `awaitPromise` stops applying: an `async () => {}` IIFE
      // came back as the *unawaited* Promise, which `returnByValue` serializes
      // to `{}`. Every caller then raced whatever the promise was doing. The
      // symptom was a suite where 19 of 20 tests failed on
      // `document.querySelector('quorum-nub')` being null — the element was
      // appended a few milliseconds after the assertion ran.
      awaitPromise: true,
      returnByValue: true,
    });

    const details = result['exceptionDetails'] as
      | { text?: string; exception?: { description?: string } }
      | undefined;
    if (details !== undefined) {
      throw new Error(details.exception?.description ?? details.text ?? 'evaluation threw');
    }

    return (result['result'] as { value?: T })?.value as T;
  }

  /**
   * Poll an expression until it is truthy.
   *
   * The one concession to asynchrony. Custom element upgrade and module
   * loading are not observable as a single event, so the alternative is a
   * fixed sleep, which is both slower and flakier.
   */
  async waitFor(expression: string, timeoutMs = this.#timeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.evaluate<boolean>(`!!(${expression})`)) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${expression}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Send a key through the browser's real input pipeline.
   *
   * Not a synthesized `KeyboardEvent` from page script: the point of testing
   * the shortcut is to prove a listener on `document` sees what a user's
   * keystroke produces, and a hand-built event with the wrong `code` or a
   * missing modifier flag would pass while the real thing fails.
   */
  async press(key: string, options: { code?: string; modifiers?: number } = {}): Promise<void> {
    const params = {
      key,
      code: options.code ?? `Key${key.toUpperCase()}`,
      modifiers: options.modifiers ?? 0,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    };
    await this.#send('Input.dispatchKeyEvent', { ...params, type: 'keyDown' });
    await this.#send('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
  }

  async close(): Promise<void> {
    await this.#connection.send('Target.closeTarget', { targetId: this.#targetId });
  }

  #send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.#connection.send(method, params, this.#sessionId);
  }

  #record(event: CdpEvent): void {
    if (event.sessionId !== this.#sessionId) return;

    if (event.method === 'Runtime.exceptionThrown') {
      const details = (event.params['exceptionDetails'] ?? {}) as {
        text?: string;
        exception?: { description?: string };
      };
      this.#errors.push({
        kind: 'exception',
        text: details.exception?.description ?? details.text ?? 'unknown exception',
      });
      return;
    }

    if (event.method === 'Runtime.consoleAPICalled' && event.params['type'] === 'error') {
      const args = (event.params['args'] ?? []) as { value?: unknown; description?: string }[];
      this.#errors.push({
        kind: 'console',
        text: args.map((a) => String(a.value ?? a.description ?? '')).join(' '),
      });
    }
  }
}

/** Resolve once Chrome prints its endpoint, or reject with what it printed. */
function waitForEndpoint(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = '';

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`browser did not report a devtools endpoint in ${timeoutMs}ms:\n${stderr}`));
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      stderr += chunk.toString('utf8');
      const endpoint = parseEndpoint(stderr);
      if (endpoint === undefined) return;
      cleanup();
      resolve(endpoint);
    };

    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`browser exited with code ${String(code)} before starting:\n${stderr}`));
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
    };

    child.stderr?.on('data', onData);
    child.on('exit', onExit);
  });
}

function once(emitter: ChildProcess, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    emitter.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
