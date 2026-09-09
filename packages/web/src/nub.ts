/**
 * `<quorum-nub>` — the custom element.
 *
 * **This is the only DOM-bound file in the repo, and it is deliberately the
 * dumbest.** Attribute validation lives in `attributes.ts`, theming in
 * `styles.ts`, shortcut rules in `shortcut.ts`, wording in `copy.ts`, and the
 * flow itself in `@quorum/core`'s `PanelMachine`. Everything listed there is
 * pure and tested; what remains here is wiring.
 *
 * That split is not only for tidiness. This package cannot be tested in the
 * authoring environment — there is no DOM and no browser runner — so the
 * honest response is to leave as little untested logic here as possible and
 * say plainly which part is unverified. See the README.
 *
 * Shadow DOM in `open` mode (ADR-0002): closed would block the `::part()`
 * theming the design depends on, and buys nothing, since a hostile page can
 * reach the element either way.
 */

import { PanelMachine } from '../../core/src/panel.ts';
import type { PanelState } from '../../core/src/state.ts';
import type { UserBlock } from '../../core/src/protocol.ts';
import { ulid } from '../../core/src/ulid.ts';
import { parseAttributes, type NubConfig } from './attributes.ts';
import { QuorumClient } from './client.ts';
import { copyFor } from './copy.ts';
import { matchesShortcut, isTypingTarget, parseShortcut, type Chord } from './shortcut.ts';
import { stylesheet } from './styles.ts';

const OBSERVED = ['project', 'endpoint', 'version', 'kind', 'preset', 'position', 'offset', 'label', 'shortcut', 'picker', 'replay', 'locale', 'frustration'];

/** The element's public surface, nameable without a DOM present. */
export interface QuorumNubElement extends HTMLElement {
  open(options?: { kind?: NubConfig['kind']; prefill?: string; context?: Record<string, unknown> }): void;
  close(): void;
  /**
   * Attach the signed-in user. `traits.mrr` is what makes the ranked list
   * revenue-weighted rather than a head count (ADR-0015).
   */
  identify(externalId: string, traits?: UserBlock['traits']): void;
  /** Forget the identified user. Call on logout. */
  reset(): void;
  readonly state: PanelState;
  readonly client: QuorumClient | undefined;
}

let cached: CustomElementConstructor | undefined;

/**
 * The class, built on first call rather than at module load.
 *
 * `class extends HTMLElement` evaluates `HTMLElement` the moment the module is
 * evaluated, so defining it at the top level makes this package throw a
 * `ReferenceError` on import in any environment without a DOM. That is not a
 * hypothetical: every SSR framework imports client modules on the server, and
 * a feedback widget that crashes a Next.js render is not shippable.
 */
export function nubClass(): CustomElementConstructor {
  cached ??= class QuorumNub extends HTMLElement {
  static get observedAttributes(): string[] {
    return OBSERVED;
  }

  // `capture: false` because there is no capture step yet. With the default
  // the machine would sit in `capturing` waiting for a `captured` event that
  // nothing sends, and every submission would hang at "Sending…".
  #machine = new PanelMachine({ capture: false });
  #config: NubConfig | undefined;
  #chord: Chord | undefined;
  #root: ShadowRoot | undefined;
  #onKeydown: ((event: KeyboardEvent) => void) | undefined;
  #client: QuorumClient | undefined;
  #detachConnectivity: (() => void) | undefined;
  /** Queued identify() calls, replayed onto the client once it exists. */
  #pendingIdentity: { externalId: string; traits?: UserBlock['traits'] } | undefined;

  connectedCallback(): void {
    this.#root ??= this.attachShadow({ mode: 'open' });
    this.#configure();

    this.#machine.on('stateChange', () => {
      this.#render();
    });
    // Re-dispatch core events as composed DOM events so a host can listen on
    // `document` without reaching into the shadow root.
    for (const name of ['open', 'close', 'submit', 'queued', 'error'] as const) {
      this.#machine.on(name, (detail) => {
        this.dispatchEvent(
          new CustomEvent(`quorum:${name}`, { detail, bubbles: true, composed: true }),
        );
      });
    }

    this.#bindShortcut();
    this.#render();
  }

  disconnectedCallback(): void {
    if (this.#onKeydown !== undefined) {
      document.removeEventListener('keydown', this.#onKeydown, true);
      this.#onKeydown = undefined;
    }
    this.#detachConnectivity?.();
    this.#detachConnectivity = undefined;
    this.#client?.destroy();
    // Deliberately not cleared: the queue is durable, so a remounted element
    // rebuilds a client over the same storage and picks up whatever never
    // went out. Dropping the reference is enough.
    this.#client = undefined;
  }

  attributeChangedCallback(): void {
    if (this.#root === undefined) return;
    this.#configure();
    this.#bindShortcut();
    this.#render();
  }

  /** Programmatic entry — the documented escape hatch for a custom trigger. */
  open(options?: { kind?: NubConfig['kind']; prefill?: string; context?: Record<string, unknown> }): void {
    // The `kind` attribute has to be applied here, not at construction. The
    // machine takes a `defaultKind` but is built before any attribute has been
    // read, so `<quorum-nub kind="bug">` parsed correctly into config and then
    // opened a feature-request panel — a documented attribute that did
    // nothing, and one no test without a DOM could have caught.
    //
    // Reading it per open rather than once also means a host that flips the
    // attribute gets the new kind on the next open instead of the next reload.
    const kind = options?.kind ?? this.#config?.kind;

    this.#machine.send({
      type: 'open',
      options: { ...options, ...(kind !== undefined && { kind }) },
    });
    this.#machine.send({ type: 'ready' });
  }

  close(): void {
    this.#machine.send({ type: 'close', reason: 'programmatic' });
  }

  identify(externalId: string, traits?: UserBlock['traits']): void {
    // Held rather than dropped when the client does not exist yet. A host that
    // calls identify() from its own bootstrap will routinely beat the
    // element's first submission, and losing that call means losing the
    // account weight on every submission until the next login.
    this.#pendingIdentity = { externalId, ...(traits !== undefined && { traits }) };
    this.#ensureClient()?.identify(externalId, traits);
  }

  reset(): void {
    this.#pendingIdentity = undefined;
    this.#client?.reset();
  }

  get state(): PanelState {
    return this.#machine.state;
  }

  get client(): QuorumClient | undefined {
    return this.#ensureClient();
  }

  /**
   * The client, built on first need.
   *
   * Lazy because construction reads `localStorage`, and doing that in
   * `connectedCallback` would mean every page with the tag on it touches
   * storage whether or not anyone ever opens the panel.
   */
  #ensureClient(): QuorumClient | undefined {
    const config = this.#config;
    if (config === undefined || config.project === '') return undefined;

    if (this.#client === undefined) {
      this.#client = new QuorumClient({
        project: config.project,
        endpoint: config.endpoint,
        ...(config.appVersion !== '' && { appVersion: config.appVersion }),
      });
      this.#detachConnectivity = this.#client.watchConnectivity();
      if (this.#pendingIdentity !== undefined) {
        this.#client.identify(this.#pendingIdentity.externalId, this.#pendingIdentity.traits);
      }
    }
    return this.#client;
  }

  /**
   * Run a submission: state machine, send, then state machine again.
   *
   * The three outcomes are three different things to tell the user, and
   * conflating them is the mistake worth avoiding. `queued` is *not* an error
   * — it means the feedback is durable on the device and will go out later,
   * which for someone on a train is the system working.
   */
  async #send(): Promise<void> {
    const client = this.#ensureClient();
    const { draft, kind, custom } = this.#machine.context;
    if (client === undefined) return;

    // "Try again" is the same button. Without this the machine refuses the
    // `submit` below — `error` is not a state it accepts one from — and the
    // retry silently does nothing, which is a worse failure than the original.
    if (this.#machine.state === 'error') this.#machine.send({ type: 'retry' });

    // The id is generated here, not inside the client, because the machine
    // reports it in `quorum:submit` before the request goes out — and because
    // moving to `submitting` first is what stops a double-clicked send button
    // from queueing the same feedback twice.
    const id = ulid();
    if (!this.#machine.send({ type: 'submit', id })) return;

    const outcome = await client.submit({
      id,
      draft,
      kind,
      source: 'nub',
      ...(custom !== undefined && { context: custom }),
    });

    if (outcome.status === 'accepted') this.#machine.send({ type: 'accepted' });
    else if (outcome.status === 'queued') {
      this.#machine.send({ type: 'enqueued', queueDepth: outcome.queueDepth });
    } else this.#machine.send({ type: 'failed', error: outcome.error });
  }

  #configure(): void {
    const previous = this.#config;
    const { config, warnings } = parseAttributes((name) => this.getAttribute(name));
    this.#config = config;
    // Warn once per change, never throw: a typo in an attribute must not break
    // the page this is embedded in.
    for (const warning of warnings) console.warn(`[quorum-nub] ${warning}`);
    this.#chord = config.shortcut === null ? undefined : parseShortcut(config.shortcut);

    // A client is built around its project, endpoint, and version, so a change
    // to any of them makes the existing one wrong. Keeping it would send the
    // next submission to the old endpoint under the old key — and since the
    // queue is keyed on the project too, the durable events would be stranded
    // under a name nothing looks up again.
    const changed =
      previous !== undefined &&
      (previous.project !== config.project ||
        previous.endpoint !== config.endpoint ||
        previous.appVersion !== config.appVersion);

    if (changed) {
      // Flush first, best-effort: whatever is already queued still belongs to
      // the old project and this is the last moment anything will try to send
      // it there.
      void this.#client?.flush().catch(() => undefined);
      this.#detachConnectivity?.();
      this.#detachConnectivity = undefined;
      this.#client?.destroy();
      this.#client = undefined;
    }
  }

  #bindShortcut(): void {
    if (this.#onKeydown !== undefined) {
      document.removeEventListener('keydown', this.#onKeydown, true);
      this.#onKeydown = undefined;
    }
    const chord = this.#chord;
    if (chord === undefined) return;

    const isMac = /mac/i.test(navigator.platform ?? navigator.userAgent);
    this.#onKeydown = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target as { tagName?: string; isContentEditable?: boolean } | null)) return;
      if (!matchesShortcut(chord, event, isMac)) return;
      event.preventDefault();
      this.open();
    };
    document.addEventListener('keydown', this.#onKeydown, true);
  }

  #render(): void {
    const root = this.#root;
    const config = this.#config;
    if (root === undefined || config === undefined) return;

    // Without a project key there is nothing to send to, so render nothing
    // rather than a button that fails on click.
    if (config.project === '') {
      root.replaceChildren();
      return;
    }

    const state = this.#machine.state;
    const context = this.#machine.context;
    const copy = copyFor(state, context.kind);
    const open = state !== 'idle';

    root.replaceChildren();

    const style = document.createElement('style');
    style.textContent = stylesheet(config.preset, config.position, config.offset);
    root.append(style);

    if (open) root.append(this.#panel(copy, state));
    if (config.position !== 'hidden') root.append(this.#trigger(config, open));
  }

  #trigger(config: NubConfig, open: boolean): HTMLElement {
    const button = document.createElement('button');
    button.className = 'trigger';
    button.setAttribute('part', 'trigger');
    button.type = 'button';
    button.textContent = config.label;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => {
      if (this.#machine.state === 'idle') this.open();
      else this.close();
    });
    return button;
  }

  /**
   * Whether the send button should be live.
   *
   * `PanelMachine.canSubmit` is false in `error`, correctly — the machine will
   * not accept a `submit` from there, only a `retry`. But the button in that
   * state is labelled "Try again", and wiring it straight to `canSubmit` left
   * it permanently disabled: the retry the copy promises could never be
   * clicked. So the view adds the one state the machine reaches through a
   * different event, and `#send()` sends that event first.
   */
  #canSend(): boolean {
    if (this.#machine.canSubmit) return true;
    return this.#machine.state === 'error' && this.#machine.context.draft.trim() !== '';
  }

  /**
   * Put focus and the caret back after a re-render replaced the composer.
   *
   * Clamped to the current length because the machine, not the old DOM node,
   * is the source of truth for the draft — if they ever disagree, the caret
   * should land somewhere valid rather than throw.
   */
  #restoreComposer(caret: number): void {
    const field = this.#root?.querySelector('.field');
    if (!(field instanceof HTMLTextAreaElement)) return;
    field.focus();
    const at = Math.min(Math.max(caret, 0), field.value.length);
    field.setSelectionRange(at, at);
  }

  #panel(copy: ReturnType<typeof copyFor>, state: PanelState): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('part', 'panel');
    panel.dataset['state'] = state;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', copy.heading);

    const heading = document.createElement('div');
    heading.className = 'row';
    heading.textContent = copy.heading;
    panel.append(heading);

    if (copy.showComposer) {
      const field = document.createElement('textarea');
      field.className = 'field';
      field.setAttribute('part', 'field');
      field.placeholder = copy.placeholder;
      field.value = this.#machine.context.draft;
      field.addEventListener('input', () => {
        const draft = field.value;
        const caret = field.selectionStart ?? draft.length;

        if (this.#machine.state === 'error') {
          // Typing after a failure is an implicit retry: the machine only
          // accepts `retry` from `error`, so without this the revision never
          // reaches it and the eventual retry sends the text the user had
          // already decided was wrong.
          //
          // The catch, and the reason this is not two lines: `retry` changes
          // state, which re-renders the panel and replaces this textarea —
          // and that render runs *before* the edit below, so it paints the
          // pre-failure draft over the character just typed and drops the
          // caret. Hence the explicit second render and the caret restore.
          // Two renders in one frame, once per failure, in exchange for not
          // eating a keystroke in front of someone whose submission just
          // failed.
          this.#machine.send({ type: 'retry' });
          this.#machine.send({ type: 'edit', draft });
          this.#render();
          this.#restoreComposer(caret);
          return;
        }

        this.#machine.send({ type: 'edit', draft });
        submit.disabled = !this.#canSend();
      });
      panel.append(field);

      const actions = document.createElement('div');
      actions.className = 'actions';

      const cancel = document.createElement('button');
      cancel.className = 'secondary';
      cancel.setAttribute('part', 'cancel');
      cancel.type = 'button';
      cancel.textContent = copy.cancel;
      cancel.addEventListener('click', () => this.close());

      const submit = document.createElement('button');
      submit.className = 'submit';
      submit.setAttribute('part', 'submit');
      submit.type = 'button';
      submit.textContent = copy.submit;
      submit.disabled = !this.#canSend();
      submit.addEventListener('click', () => {
        // Cancelable, and that is the whole extension point: a host that wants
        // to send submissions through its own backend calls
        // `preventDefault()` and the built-in transport stays out of the way.
        // Anyone who does nothing gets a working widget, which is the case
        // that has to be effortless.
        const proceed = this.dispatchEvent(
          new CustomEvent('quorum:submitrequest', {
            detail: { draft: this.#machine.context.draft, kind: this.#machine.context.kind },
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
        if (proceed) void this.#send();
      });

      actions.append(cancel, submit);
      panel.append(actions);
    }

    if (copy.status !== '') {
      const status = document.createElement('div');
      status.className = 'muted';
      status.setAttribute('part', 'status');
      // Announced to screen readers without stealing focus.
      status.setAttribute('role', 'status');
      status.textContent = copy.status;
      panel.append(status);
    }

    return panel;
  }
  };
  return cached;
}

/**
 * Register the element.
 *
 * Idempotent, so a page that loads the script twice does not throw, and a
 * no-op where there is no `customElements` registry at all — importing this
 * package during a server render must be inert rather than fatal.
 *
 * Returns whether the element is registered after the call.
 */
export function defineQuorumNub(tag = 'quorum-nub'): boolean {
  if (typeof customElements === 'undefined') return false;
  if (customElements.get(tag) === undefined) customElements.define(tag, nubClass());
  return true;
}
