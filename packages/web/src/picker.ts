/**
 * The element picker.
 *
 * "The button doesn't work" costs an engineer twenty minutes of guessing.
 * "`main > form.checkout > button.submit`, 240×40 at (620, 380),
 * `pointer-events: none`" costs them nothing — the answer is in the capture.
 * That is why `docs/PROTOCOL.md` calls this the web's killer capture and why
 * [ADR-0006](../../../docs/adr/0006-dom-serialization-over-screen-capture.md)
 * prefers it to a screenshot.
 *
 * Everything with a rule in it — which identifier to trust, when to climb the
 * tree — lives in `selector.ts` and is tested without a browser. What is here
 * is DOM: reading four facts off an element, finding a React component name,
 * and an overlay that follows the pointer.
 */

import type { ElementBlock } from '../../core/src/protocol.ts';
import { selectorFor, type SelectorNode, type SelectorOptions } from './selector.ts';

/**
 * Computed properties worth capturing.
 *
 * Chosen to answer "why didn't it work", not to describe the design. Each one
 * is a common reason an element is present in the DOM and useless to the
 * person looking at it: invisible, behind something, collapsed, or not
 * accepting clicks. A full style dump would bury these in three hundred
 * properties nobody reads.
 */
export const CAPTURED_PROPERTIES: readonly string[] = [
  'display',
  'visibility',
  'opacity',
  'pointer-events',
  'position',
  'z-index',
  'overflow',
  'cursor',
];

/** Read the facts `selectorFor` needs off a real element. */
export function nodeFrom(element: Element): SelectorNode {
  const parent = element.parentElement;

  let indexOfType: number | undefined;
  let countOfType: number | undefined;
  if (parent !== null) {
    const siblings = [...parent.children].filter((child) => child.tagName === element.tagName);
    countOfType = siblings.length;
    indexOfType = siblings.indexOf(element) + 1;
  }

  const attributes: Record<string, string> = {};
  for (const attribute of element.attributes) {
    if (attribute.name.startsWith('data-')) attributes[attribute.name] = attribute.value;
  }

  return {
    tagName: element.tagName,
    id: element.id === '' ? null : element.id,
    classNames: [...element.classList],
    attributes,
    parent: parent === null ? null : nodeFrom(parent),
    ...(indexOfType !== undefined && { indexOfType }),
    ...(countOfType !== undefined && { countOfType }),
  };
}

/**
 * The React component that rendered this element, if React is present.
 *
 * React attaches its fiber under a key like `__reactFiber$abc123` — the suffix
 * is per-root and unknowable ahead of time, hence the scan. `_debugOwner` only
 * exists in development builds, which is the honest limitation: in production
 * this usually returns nothing, and returning nothing is correct rather than
 * guessing from a minified name that means nothing to anyone.
 *
 * Wrapped in a `try` because it reaches into another library's internals.
 * Whatever React does next, it must not throw inside a picker on somebody
 * else's checkout page.
 */
export function reactComponentName(element: Element): string | undefined {
  try {
    const key = Object.keys(element).find(
      (name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'),
    );
    if (key === undefined) return undefined;

    let fiber = (element as unknown as Record<string, unknown>)[key] as
      | { _debugOwner?: unknown; return?: unknown; elementType?: unknown; type?: unknown }
      | undefined;

    // Walk up to the nearest fiber whose type is a function or class — the
    // host fibers in between are `div`, `span`, and so on, which the selector
    // already says.
    for (let depth = 0; fiber !== undefined && depth < 12; depth++) {
      const type = (fiber.elementType ?? fiber.type) as
        | { displayName?: string; name?: string }
        | string
        | undefined;

      if (typeof type === 'function' || (typeof type === 'object' && type !== null)) {
        const named = type as { displayName?: string; name?: string };
        const name = named.displayName ?? named.name;
        if (name !== undefined && name !== '') return name;
      }

      fiber = (fiber._debugOwner ?? fiber.return) as typeof fiber;
    }
  } catch {
    // Reaching into a framework's internals is best effort by definition.
  }
  return undefined;
}

export interface DescribeOptions extends SelectorOptions {
  /** Override which computed properties are read. */
  properties?: readonly string[];
}

/** Everything the protocol's `ElementBlock` wants about one element. */
export function describeElement(element: Element, options: DescribeOptions = {}): ElementBlock {
  const selector = selectorFor(nodeFrom(element), options);

  const rect = element.getBoundingClientRect();
  const bbox: [number, number, number, number] = [
    Math.round(rect.x),
    Math.round(rect.y),
    Math.round(rect.width),
    Math.round(rect.height),
  ];

  const computed: Record<string, string> = {};
  const styles = getComputedStyle(element);
  for (const property of options.properties ?? CAPTURED_PROPERTIES) {
    const value = styles.getPropertyValue(property);
    if (value !== '') computed[property] = value;
  }

  const component = reactComponentName(element);

  return {
    selector,
    bbox,
    computed,
    ...(component !== undefined && { component }),
  };
}

export interface PickerHandle {
  /** Stop picking without selecting anything. */
  cancel(): void;
  readonly active: boolean;
}

export interface PickerOptions extends DescribeOptions {
  /** Called once, with the chosen element. */
  onPick: (element: Element, described: ElementBlock) => void;
  onCancel?: () => void;
  document?: Document;
  /** Highlight colour. Defaults to the accent token, falling back to violet. */
  accent?: string;
}

/**
 * Start picking.
 *
 * The overlay is a single absolutely-positioned box that follows the pointer,
 * rather than mutating the hovered element. Setting an outline on the page's
 * own elements would fight the host's styles, trigger its transitions, and —
 * on anything with a layout-affecting hover rule — move the thing the user is
 * trying to click.
 *
 * `pointer-events: none` on the overlay is what makes that work: the box is
 * drawn over the page but every event passes through to the real element
 * underneath, so `elementFromPoint` is not needed and the click lands where
 * the user aimed.
 */
export function startPicking(options: PickerOptions): PickerHandle {
  const doc = options.document ?? document;
  const accent = options.accent ?? '#7c3aed';

  const overlay = doc.createElement('div');
  overlay.setAttribute('data-quorum-picker', '');
  overlay.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    `border:2px solid ${accent}`,
    `background:${accent}1a`,
    'border-radius:3px',
    'z-index:2147483001',
    'transition:all 60ms ease',
    'display:none',
  ].join(';');
  doc.body.append(overlay);

  let active = true;
  let hovered: Element | undefined;

  const draw = (element: Element): void => {
    const rect = element.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = `${String(rect.left)}px`;
    overlay.style.top = `${String(rect.top)}px`;
    overlay.style.width = `${String(rect.width)}px`;
    overlay.style.height = `${String(rect.height)}px`;
  };

  const onMove = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // Never highlight our own furniture.
    if (target.closest('[data-quorum-picker], quorum-nub') !== null) return;
    hovered = target;
    draw(target);
  };

  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-quorum-picker], quorum-nub') !== null) return;

    // The host page must not also receive this click. Picking a "Delete
    // account" button should describe it, not press it.
    event.preventDefault();
    event.stopPropagation();

    const chosen = hovered ?? target;
    teardown();
    options.onPick(chosen, describeElement(chosen, options));
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    teardown();
    options.onCancel?.();
  };

  function teardown(): void {
    if (!active) return;
    active = false;
    doc.removeEventListener('mousemove', onMove, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
  }

  // Capture phase throughout, so the host page's own handlers never see the
  // click that selects an element.
  doc.addEventListener('mousemove', onMove, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKeydown, true);

  return {
    cancel: () => {
      teardown();
      options.onCancel?.();
    },
    get active() {
      return active;
    },
  };
}
