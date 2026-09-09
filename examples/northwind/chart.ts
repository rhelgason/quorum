/**
 * Minimal SVG chart helpers for the README.
 *
 * ## Why static SVG and not a charting library
 *
 * The README is the product here — nothing is hosted — so the charts have to
 * render on GitHub, which strips `<script>` and most external styling from
 * embedded SVG. That removes the hover layer a chart would normally ship, so
 * every figure below carries **direct labels and a table beside it in the
 * README** instead. That is the documented substitute, not an omission.
 *
 * Light and dark are emitted as separate files and selected with `<picture>`,
 * because `prefers-color-scheme` inside an SVG referenced by `<img>` does not
 * apply — the SVG has no browsing context of its own. Dark is a **selected**
 * palette stepped for the dark surface, not an inverted light one.
 *
 * Colours come from the validated reference palette; the pairs in use were run
 * through the validator in both modes before anything was drawn.
 */

export interface Theme {
  name: 'light' | 'dark';
  surface: string;
  primary: string;
  secondary: string;
  muted: string;
  grid: string;
  axis: string;
  /** Sequential blue, light → dark. Ordinal-safe steps only. */
  ramp: string[];
  up: string;
  down: string;
}

export const LIGHT: Theme = {
  name: 'light',
  surface: '#fcfcfb',
  primary: '#0b0b0b',
  secondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  // Starts at step 250 — the ordinal floor on the light surface, so the
  // smallest bar still reads as a mark rather than fading into the paper.
  ramp: ['#86b6ef', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95'],
  up: '#2a78d6',
  down: '#e34948',
};

export const DARK: Theme = {
  name: 'dark',
  surface: '#1a1a19',
  primary: '#ffffff',
  secondary: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  // Reversed and bounded at step 600, the ordinal floor on the dark surface.
  ramp: ['#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#86b6ef'],
  up: '#3987e5',
  down: '#e66767',
};

export const THEMES: Theme[] = [LIGHT, DARK];

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

export function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface TextOptions {
  anchor?: 'start' | 'middle' | 'end';
  size?: number;
  weight?: number;
  fill?: string;
  mono?: boolean;
}

export function text(x: number, y: number, content: string, theme: Theme, options: TextOptions = {}): string {
  const family = options.mono === true
    ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
    : FONT;
  return (
    `<text x="${String(x)}" y="${String(y)}" font-family="${family}" ` +
    `font-size="${String(options.size ?? 12)}" font-weight="${String(options.weight ?? 400)}" ` +
    `text-anchor="${options.anchor ?? 'start'}" fill="${options.fill ?? theme.secondary}" ` +
    `>${escapeText(content)}</text>`
  );
}

/**
 * A bar with rounded ends only at the data end.
 *
 * Square against the baseline, rounded where the value stops — so the mark
 * reads as measured from zero rather than floating.
 */
export function hbar(x: number, y: number, width: number, height: number, fill: string): string {
  const r = Math.min(4, width, height / 2);
  if (width <= r) return `<rect x="${String(x)}" y="${String(y)}" width="${String(Math.max(width, 1))}" height="${String(height)}" fill="${fill}"/>`;
  return (
    `<path d="M${String(x)} ${String(y)} H${String(x + width - r)} a${String(r)} ${String(r)} 0 0 1 ${String(r)} ${String(r)} ` +
    `V${String(y + height - r)} a${String(r)} ${String(r)} 0 0 1 ${String(-r)} ${String(r)} H${String(x)} Z" fill="${fill}"/>`
  );
}

/**
 * Black or white, whichever reads on `fill`.
 *
 * A label sitting *inside* a coloured mark is the one place text cannot wear a
 * text token — it has to contrast with the fill under it. Picking by hand is
 * how a label ends up at 2.6:1 on the lighter end of a ramp, which is what the
 * first version of the pipeline figure did on its dark variant.
 *
 * WCAG relative luminance, thresholded where the two candidates cross.
 */
export function onFill(fill: string): string {
  const channel = (hex: string): number => {
    const c = parseInt(hex, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l =
    0.2126 * channel(fill.slice(1, 3)) +
    0.7152 * channel(fill.slice(3, 5)) +
    0.0722 * channel(fill.slice(5, 7));

  // Contrast against white is (1.05)/(l+0.05); against black, (l+0.05)/0.05.
  return (1.05) / (l + 0.05) >= (l + 0.05) / 0.05 ? '#ffffff' : '#0b0b0b';
}

export function wrap(
  width: number,
  height: number,
  theme: Theme,
  title: string,
  subtitle: string,
  body: string,
): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" ` +
      `viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="${escapeText(`${title}. ${subtitle}`)}">`,
    `<rect width="${String(width)}" height="${String(height)}" fill="${theme.surface}"/>`,
    text(20, 28, title, theme, { size: 15, weight: 600, fill: theme.primary }),
    text(20, 47, subtitle, theme, { size: 11.5, fill: theme.muted }),
    body,
    '</svg>',
  ].join('\n');
}
