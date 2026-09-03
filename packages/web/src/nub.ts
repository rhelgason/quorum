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
import { parseAttributes, type NubConfig } from './attributes.ts';
import { copyFor } from './copy.ts';
import { matchesShortcut, isTypingTarget, parseShortcut, type Chord } from './shortcut.ts';
import { stylesheet } from './styles.ts';

const OBSERVED = ['project', 'kind', 'preset', 'position', 'offset', 'label', 'shortcut', 'picker', 'replay', 'locale', 'frustration'];

/** The element's public surface, nameable without a DOM present. */
export interface QuorumNubElement extends HTMLElement {
  open(options?: { kind?: NubConfig['kind']; prefill?: string; context?: Record<string, unknown> }): void;
  close(): void;
  readonly state: PanelState;
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

  #machine = new PanelMachine();
  #config: NubConfig | undefined;
  #chord: Chord | undefined;
  #root: ShadowRoot | undefined;
  #onKeydown: ((event: KeyboardEvent) => void) | undefined;

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
  }

  attributeChangedCallback(): void {
    if (this.#root === undefined) return;
    this.#configure();
    this.#bindShortcut();
    this.#render();
  }

  /** Programmatic entry — the documented escape hatch for a custom trigger. */
  open(options?: { kind?: NubConfig['kind']; prefill?: string; context?: Record<string, unknown> }): void {
    this.#machine.send({ type: 'open', ...(options !== undefined && { options }) });
    this.#machine.send({ type: 'ready' });
  }

  close(): void {
    this.#machine.send({ type: 'close', reason: 'programmatic' });
  }

  get state(): PanelState {
    return this.#machine.state;
  }

  #configure(): void {
    const { config, warnings } = parseAttributes((name) => this.getAttribute(name));
    this.#config = config;
    // Warn once per change, never throw: a typo in an attribute must not break
    // the page this is embedded in.
    for (const warning of warnings) console.warn(`[quorum-nub] ${warning}`);
    this.#chord = config.shortcut === null ? undefined : parseShortcut(config.shortcut);
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
        this.#machine.send({ type: 'edit', draft: field.value });
        submit.disabled = !this.#machine.canSubmit;
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
      submit.disabled = !this.#machine.canSubmit;
      submit.addEventListener('click', () => {
        this.dispatchEvent(
          new CustomEvent('quorum:submitrequest', {
            detail: { draft: this.#machine.context.draft, kind: this.#machine.context.kind },
            bubbles: true,
            composed: true,
          }),
        );
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
