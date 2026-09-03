/**
 * `<quorum-nub>` attributes → a validated config object.
 *
 * Written against a plain getter rather than an `Element` so the whole of it
 * is testable without a DOM. That is not a testing trick: it is the reason
 * this file can hold the validation rules at all, and it keeps the custom
 * element itself down to glue.
 *
 * **Nothing here throws, ever.** A typo in an HTML attribute must not break
 * the page it is embedded in. This is a third-party script tag on somebody
 * else's checkout flow; failing loudly is a luxury we do not have. Invalid
 * values fall back to the default and are reported through `warnings`, which
 * the element logs once.
 */

import type { SubmissionKind } from '../../core/src/protocol.ts';
import type { FrustrationMode } from '../../core/src/config.ts';

export type Preset = 'minimal' | 'soft' | 'sharp';

export type Position =
  | 'bottom-right'
  | 'bottom-left'
  | 'top-right'
  | 'top-left'
  /** Renders no trigger at all — bring your own. */
  | 'hidden';

export interface NubConfig {
  /** Public key. Required; without it the element renders nothing. */
  project: string;
  kind: SubmissionKind;
  preset: Preset;
  position: Position;
  /** Distance from the viewport edge, in CSS pixels. */
  offset: number;
  label: string;
  /** Parsed chord spec, or null when the shortcut is disabled. */
  shortcut: string | null;
  frustration: FrustrationMode;
  picker: boolean;
  replay: boolean;
  locale: string;
}

export interface ParsedAttributes {
  config: NubConfig;
  /** Human-readable problems. Empty when everything parsed cleanly. */
  warnings: string[];
}

const PRESETS: readonly Preset[] = ['minimal', 'soft', 'sharp'];
const POSITIONS: readonly Position[] = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
  'hidden',
];
const KINDS: readonly SubmissionKind[] = ['feature_request', 'bug', 'praise', 'question', 'rage'];
const FRUSTRATION: readonly FrustrationMode[] = ['off', 'detect', 'prompt'];

/**
 * Defaults, and the reasoning where it is not obvious:
 *
 * - `kind` is `feature_request` because the default flow asks what the user
 *   *would change*. Reporting something broken is one path through it, not the
 *   entry point — this product is not a bug tracker (ADR-0012).
 * - `frustration` is `detect`, which records signals silently. `prompt` is
 *   opt-in because nudging is a product decision the customer should make
 *   knowingly (ADR-0010).
 * - `replay` is off. A session recorder that turns itself on is a privacy
 *   incident waiting to happen (ADR-0007).
 */
export const DEFAULTS: Omit<NubConfig, 'project'> = {
  kind: 'feature_request',
  preset: 'soft',
  position: 'bottom-right',
  offset: 24,
  label: 'Feedback',
  shortcut: 'mod+shift+k',
  frustration: 'detect',
  picker: true,
  replay: false,
  locale: 'en',
};

export type AttributeReader = (name: string) => string | null;

export function parseAttributes(get: AttributeReader): ParsedAttributes {
  const warnings: string[] = [];

  const oneOf = <T extends string>(
    name: string,
    allowed: readonly T[],
    fallback: T,
  ): T => {
    const raw = get(name);
    if (raw === null || raw.trim() === '') return fallback;
    const value = raw.trim().toLowerCase();
    if ((allowed as readonly string[]).includes(value)) return value as T;
    warnings.push(`${name}="${raw}" is not one of ${allowed.join(', ')}; using "${fallback}"`);
    return fallback;
  };

  const project = get('project')?.trim() ?? '';
  if (project === '') warnings.push('project is required; the nub will not render without it');

  return {
    config: {
      project,
      kind: oneOf('kind', KINDS, DEFAULTS.kind),
      preset: oneOf('preset', PRESETS, DEFAULTS.preset),
      position: oneOf('position', POSITIONS, DEFAULTS.position),
      offset: parseOffset(get('offset'), warnings),
      label: get('label')?.trim() === '' || get('label') === null ? DEFAULTS.label : (get('label') as string).trim(),
      shortcut: parseShortcutAttribute(get('shortcut')),
      frustration: oneOf('frustration', FRUSTRATION, DEFAULTS.frustration),
      picker: parseBoolean(get('picker'), DEFAULTS.picker, 'picker', warnings),
      replay: parseBoolean(get('replay'), DEFAULTS.replay, 'replay', warnings),
      locale: get('locale')?.trim() === '' || get('locale') === null ? DEFAULTS.locale : (get('locale') as string).trim(),
    },
    warnings,
  };
}

/**
 * `on`/`off` rather than HTML's presence-means-true convention.
 *
 * A boolean attribute would make `picker="off"` mean *enabled*, since the
 * attribute is present. That reads as a bug to everyone who writes it, and
 * silently enabling something a customer tried to disable is the wrong
 * direction to be wrong in for `replay` especially.
 */
function parseBoolean(
  raw: string | null,
  fallback: boolean,
  name: string,
  warnings: string[],
): boolean {
  if (raw === null) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'on' || value === 'true') return true;
  if (value === 'off' || value === 'false') return false;
  warnings.push(`${name}="${raw}" is not on/off; using ${String(fallback)}`);
  return fallback;
}

/** Clamped rather than rejected — an off-screen nub is worse than a moved one. */
function parseOffset(raw: string | null, warnings: string[]): number {
  if (raw === null || raw.trim() === '') return DEFAULTS.offset;
  const value = Number(raw.trim().replace(/px$/i, ''));
  if (!Number.isFinite(value)) {
    warnings.push(`offset="${raw}" is not a number; using ${String(DEFAULTS.offset)}`);
    return DEFAULTS.offset;
  }
  const clamped = Math.min(200, Math.max(0, Math.round(value)));
  if (clamped !== value) warnings.push(`offset="${raw}" clamped to ${String(clamped)}`);
  return clamped;
}

/** `off`, `none`, or empty disables it; anything else is handed to the parser. */
function parseShortcutAttribute(raw: string | null): string | null {
  if (raw === null) return DEFAULTS.shortcut;
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'off' || value === 'none') return null;
  return value;
}
