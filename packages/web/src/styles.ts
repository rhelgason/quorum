/**
 * Presets and the stylesheet, as strings.
 *
 * Theming is CSS custom properties and `::part()`, never a theme object
 * (ADR-0004). A props API for styling means we have opinions about every
 * visual decision a customer might want to make, and we will be wrong about
 * most of them. Tokens let someone restyle the widget with CSS they already
 * know, without us shipping an API surface for it.
 *
 * String generation rather than a CSSStyleSheet so the whole file is testable
 * without a DOM, and so the element can adopt it once per instance.
 */

import type { Position, Preset } from './attributes.ts';

/**
 * Preset token sets.
 *
 * Three, not thirty. Each is a coherent stance rather than a knob:
 *
 * - `minimal` — square, monochrome, no shadow. Disappears into dense tooling.
 * - `soft` — rounded, elevated, an accent colour. The default, because it
 *   reads as a deliberate part of the product rather than a debug affordance.
 * - `sharp` — high contrast, hard edges, heavy weight.
 *
 * `auto` (sampling host styles) is deliberately absent. Guessing a host's
 * design language produces something that looks *almost* right, which is worse
 * than something that clearly belongs to a different tool.
 */
export const PRESETS: Record<Preset, Record<string, string>> = {
  minimal: {
    '--quorum-accent': '#111827',
    '--quorum-accent-contrast': '#ffffff',
    '--quorum-surface': '#ffffff',
    '--quorum-text': '#111827',
    '--quorum-muted': '#6b7280',
    '--quorum-border': '#e5e7eb',
    '--quorum-radius': '2px',
    '--quorum-shadow': 'none',
    '--quorum-font': 'inherit',
    '--quorum-weight': '500',
  },
  soft: {
    '--quorum-accent': '#7c3aed',
    '--quorum-accent-contrast': '#ffffff',
    '--quorum-surface': '#ffffff',
    '--quorum-text': '#1f2937',
    '--quorum-muted': '#6b7280',
    '--quorum-border': '#e9e6f5',
    '--quorum-radius': '12px',
    '--quorum-shadow': '0 6px 24px rgba(17, 24, 39, 0.12)',
    '--quorum-font': 'inherit',
    '--quorum-weight': '500',
  },
  sharp: {
    '--quorum-accent': '#000000',
    '--quorum-accent-contrast': '#ffffff',
    '--quorum-surface': '#ffffff',
    '--quorum-text': '#000000',
    '--quorum-muted': '#404040',
    '--quorum-border': '#000000',
    '--quorum-radius': '0px',
    '--quorum-shadow': '4px 4px 0 #000000',
    '--quorum-font': 'inherit',
    '--quorum-weight': '700',
  },
};

/** Anchor rules per corner. `hidden` renders no trigger, so it has none. */
const ANCHORS: Record<Exclude<Position, 'hidden'>, [vertical: string, horizontal: string]> = {
  'bottom-right': ['bottom', 'right'],
  'bottom-left': ['bottom', 'left'],
  'top-right': ['top', 'right'],
  'top-left': ['top', 'left'],
};

export function presetTokens(preset: Preset): string {
  return Object.entries(PRESETS[preset])
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
}

export function anchorRules(position: Position, offset: number): string {
  if (position === 'hidden') return '  display: none;';
  const [vertical, horizontal] = ANCHORS[position];
  return `  ${vertical}: ${String(offset)}px;\n  ${horizontal}: ${String(offset)}px;`;
}

/**
 * The full stylesheet for one instance.
 *
 * Custom properties are declared on `:host` so a customer's
 * `quorum-nub { --quorum-accent: … }` overrides them: an outside rule on the
 * host element wins over the host's own `:host` block, which is exactly the
 * cascade behaviour we want and the reason tokens are not set inline.
 *
 * `prefers-reduced-motion` is honoured rather than offered as an option. A
 * user who has asked their OS to stop animating things has already answered.
 */
export function stylesheet(preset: Preset, position: Position, offset: number): string {
  return `:host {
${presetTokens(preset)}
  position: fixed;
${anchorRules(position, offset)}
  z-index: 2147483000;
  font-family: var(--quorum-font);
  color: var(--quorum-text);
}

:host([hidden]) { display: none; }

.trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border: 1px solid var(--quorum-border);
  border-radius: var(--quorum-radius);
  background: var(--quorum-accent);
  color: var(--quorum-accent-contrast);
  box-shadow: var(--quorum-shadow);
  font: inherit;
  font-weight: var(--quorum-weight);
  cursor: pointer;
  transition: transform 120ms ease, opacity 120ms ease;
}

.trigger:hover { transform: translateY(-1px); }
.trigger:focus-visible { outline: 2px solid var(--quorum-accent); outline-offset: 2px; }

.panel {
  width: min(360px, calc(100vw - 32px));
  margin-bottom: 12px;
  padding: 16px;
  border: 1px solid var(--quorum-border);
  border-radius: var(--quorum-radius);
  background: var(--quorum-surface);
  box-shadow: var(--quorum-shadow);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.panel[data-state="picking"] { display: none; }

.field {
  width: 100%;
  min-height: 96px;
  padding: 8px;
  border: 1px solid var(--quorum-border);
  border-radius: calc(var(--quorum-radius) / 2);
  font: inherit;
  color: var(--quorum-text);
  background: var(--quorum-surface);
  resize: vertical;
  box-sizing: border-box;
}

.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.muted { color: var(--quorum-muted); font-size: 0.85em; }
.actions { display: flex; gap: 8px; justify-content: flex-end; }

.submit {
  padding: 8px 14px;
  border: 0;
  border-radius: calc(var(--quorum-radius) / 2);
  background: var(--quorum-accent);
  color: var(--quorum-accent-contrast);
  font: inherit;
  font-weight: var(--quorum-weight);
  cursor: pointer;
}
.submit[disabled] { opacity: 0.45; cursor: not-allowed; }

.secondary {
  padding: 8px 14px;
  border: 1px solid var(--quorum-border);
  border-radius: calc(var(--quorum-radius) / 2);
  background: transparent;
  color: var(--quorum-text);
  font: inherit;
  cursor: pointer;
}

@media (prefers-reduced-motion: reduce) {
  .trigger { transition: none; }
  .trigger:hover { transform: none; }
}
`;
}
