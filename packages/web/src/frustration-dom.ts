/**
 * Turning browser events into frustration observations.
 *
 * All the judgement lives in `frustration.ts`, which is arithmetic over a list
 * and testable without a browser. This file only listens, and it has exactly
 * one interesting decision in it: what makes a click *dead*.
 *
 * ## Deciding a click did nothing
 *
 * A dead click is the strongest signal here, so a loose definition would poison
 * the score. Ours: within `deadClickMs` of the click, nothing observable
 * changed — no DOM mutation, no navigation, no change of focus, no scroll.
 *
 * All four are needed. Watching mutations alone flags every link that
 * navigates away before the observer fires; watching navigation alone misses
 * the ordinary case of a button that opens a menu. And a modifier-clicked link
 * that opened a background tab changes nothing in this document, which is why
 * those are ignored outright.
 *
 * Everything is passive and capture-phase, so nothing here can interfere with
 * the host page's own handlers — this runs on somebody else's checkout flow.
 */

import { FrustrationTracker, type FrustrationOptions } from './frustration.ts';

export interface FrustrationListenerOptions extends FrustrationOptions {
  /** Grace period before a click with no visible effect counts as dead. */
  deadClickMs?: number;
  maxEvents?: number;
  document?: Document;
  window?: Window;
}

export interface FrustrationListener {
  readonly tracker: FrustrationTracker;
  detach(): void;
}

/** Key used to group repeated clicks. Cheap, and stable enough for a burst. */
function targetKey(element: Element | null): string | undefined {
  if (element === null) return undefined;
  const id = element.id === '' ? '' : `#${element.id}`;
  return `${element.tagName.toLowerCase()}${id}`;
}

/**
 * Attach listeners and start recording.
 *
 * Returns a `detach` that removes every one of them. A widget that leaks
 * document listeners across route changes in a single-page app ends up with a
 * dozen copies of itself counting the same click.
 */
export function listenForFrustration(
  options: FrustrationListenerOptions = {},
): FrustrationListener {
  const doc = options.document ?? document;
  const win = options.window ?? globalThis.window;
  const tracker = new FrustrationTracker(options);
  const deadClickMs = options.deadClickMs ?? 600;

  const cleanups: (() => void)[] = [];
  const on = <K extends keyof DocumentEventMap>(
    target: Document | Window,
    type: K | string,
    handler: (event: never) => void,
  ): void => {
    target.addEventListener(type, handler as EventListener, { capture: true, passive: true });
    cleanups.push(() => target.removeEventListener(type, handler as EventListener, true));
  };

  // -- clicks, and whether they did anything ---------------------------------

  on(doc, 'click', (event: MouseEvent) => {
    // A modifier click opens a background tab and legitimately changes nothing
    // in this document. Counting it as dead would flag every power user.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('quorum-nub, [data-quorum-picker]') != null) return;

    const at = Date.now();
    const key = targetKey(target);
    const before = {
      url: win?.location.href,
      focus: doc.activeElement,
      scroll: win?.scrollY,
    };

    let changed = false;
    const observer = new MutationObserver(() => {
      changed = true;
    });
    observer.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    setTimeout(() => {
      observer.disconnect();
      const moved =
        changed ||
        win?.location.href !== before.url ||
        doc.activeElement !== before.focus ||
        win?.scrollY !== before.scroll;

      tracker.record({
        kind: 'click',
        at,
        ...(key !== undefined && { target: key }),
        x: event.clientX,
        y: event.clientY,
        ...(moved ? {} : { dead: true }),
      });
    }, deadClickMs);
  });

  // -- keyboard, scrolling, navigation ---------------------------------------

  on(doc, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') tracker.record({ kind: 'escape', at: Date.now() });
  });

  let lastScroll = win?.scrollY ?? 0;
  on(doc, 'scroll', () => {
    const now = win?.scrollY ?? 0;
    const delta = now - lastScroll;
    lastScroll = now;
    if (delta !== 0) tracker.record({ kind: 'scroll', at: Date.now(), delta });
  });

  if (win !== undefined) {
    on(win, 'popstate', () => {
      tracker.record({ kind: 'nav', at: Date.now(), target: win.location.pathname });
    });

    // pushState is how a single-page app navigates, and it fires no event.
    // Patching it is intrusive, so instead the route is sampled — a poll that
    // costs nothing and cannot break the host's router.
    let route = win.location.pathname;
    const timer = setInterval(() => {
      if (win.location.pathname === route) return;
      route = win.location.pathname;
      tracker.record({ kind: 'nav', at: Date.now(), target: route });
    }, 500);
    cleanups.push(() => clearInterval(timer));

    // A reload is only visible via the navigation timing entry, and only once
    // per page load — so it is recorded at attach rather than listened for.
    try {
      const [entry] = win.performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      if (entry?.type === 'reload') tracker.record({ kind: 'reload', at: Date.now() });
    } catch {
      // Not every environment implements the navigation timing API.
    }
  }

  // -- failures the page reports itself --------------------------------------

  on(doc, 'invalid', (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    const form = target?.closest('form');
    tracker.record({
      kind: 'form_error',
      at: Date.now(),
      target: form?.getAttribute('name') ?? form?.id ?? 'form',
    });
  });

  if (win !== undefined) {
    on(win, 'error', () => {
      tracker.record({ kind: 'console_error', at: Date.now() });
    });
    on(win, 'unhandledrejection', () => {
      tracker.record({ kind: 'console_error', at: Date.now() });
    });
  }

  return {
    tracker,
    detach: () => {
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
    },
  };
}
