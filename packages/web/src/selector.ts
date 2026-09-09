/**
 * Generating a selector for a picked element.
 *
 * `docs/PROTOCOL.md` calls the element picker the web's killer capture: **not
 * a screenshot but a jump-to-line**. A screenshot tells an engineer something
 * looks wrong; `main > form.checkout button.submit` tells them where to open
 * their editor. That only holds if the selector is still true tomorrow, which
 * is the entire difficulty.
 *
 * ## What makes a selector last
 *
 * Preference order, most durable first:
 *
 *  1. **A test id.** `data-testid` and friends exist precisely to be a stable
 *     handle and are the only attribute a team has promised not to churn.
 *  2. **A hand-written `id`.** Stable when a human chose it, worthless when a
 *     framework generated it — hence {@link looksGenerated}.
 *  3. **Tag plus hand-written classes.** Same caveat, doubly so: CSS-in-JS and
 *     utility frameworks emit classes that change on every build.
 *  4. **A structural path**, as a last resort, because it breaks the moment
 *     anyone reorders a list.
 *
 * ## Why this file has no DOM in it
 *
 * The algorithm is tree and string manipulation over four facts about a node:
 * tag, id, classes, attributes. Written against a structural interface rather
 * than `Element`, all of it is testable in Node — and that is not a shim
 * pretending to be a browser, it is the actual contract the code needs.
 * `picker.ts` adapts a real `Element` to it in a dozen lines, and the browser
 * suite checks the property that genuinely cannot be faked: that the selector
 * this produces finds the element it came from.
 */

/** The four facts a selector needs, plus a parent link. */
export interface SelectorNode {
  tagName: string;
  id?: string | null;
  classNames?: readonly string[];
  attributes?: Readonly<Record<string, string | null | undefined>>;
  parent?: SelectorNode | null | undefined;
  /** 1-based position among siblings sharing this tag. */
  indexOfType?: number;
  /** How many siblings share this tag. 1 means the path segment needs no index. */
  countOfType?: number;
}

export interface SelectorOptions {
  /** Attributes treated as stable handles, in order. */
  testIdAttributes?: readonly string[];
  /** Path segments before giving up and accepting a shallower selector. Default 5. */
  maxDepth?: number;
}

export const DEFAULT_TEST_ID_ATTRIBUTES: readonly string[] = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-qa',
  'data-cy',
];

/**
 * Does this identifier look machine-generated?
 *
 * Getting this wrong is expensive in one direction only. Treating a generated
 * id as stable produces a selector that is *specific and wrong* — it resolves
 * today and silently matches nothing after the next deploy, so the capture
 * looks precise and is worthless. Treating a stable id as generated only costs
 * a slightly longer path. So the patterns below are deliberately eager.
 *
 * What they catch, in order: React's `useId` (`:r0:`), Emotion and
 * styled-components (`css-1x2y3z`, `sc-AxjAm`), CSS modules
 * (`Button_root__a1b2c`), long hex or base-36 blobs, and anything ending in a
 * long run of digits.
 */
export function looksGenerated(value: string): boolean {
  if (value === '') return true;
  return (
    /^:r[0-9a-z]*:?$/i.test(value) ||
    /^(css|sc|emotion|jsx|svelte|v-)-[0-9a-z]{4,}$/i.test(value) ||
    /__[0-9a-z]{5,}$/i.test(value) ||
    /\b[0-9a-f]{8,}\b/i.test(value) ||
    /\d{5,}$/.test(value) ||
    // Mixed-case alphanumeric soup with no word boundary, e.g. `a1B2c3D4`.
    (/^[a-z0-9]{8,}$/i.test(value) && /\d/.test(value) && !/^[a-z]+\d{1,3}$/i.test(value))
  );
}

/** CSS-escape an identifier enough for `querySelector`. */
export function escapeIdentifier(value: string): string {
  return value.replace(/([^\w-])/g, '\\$1').replace(/^(\d)/, '\\3$1 ');
}

function testId(
  node: SelectorNode,
  attributes: readonly string[],
): { name: string; value: string } | undefined {
  for (const name of attributes) {
    const value = node.attributes?.[name];
    if (value !== undefined && value !== null && value !== '') return { name, value };
  }
  return undefined;
}

/** Classes worth putting in a selector: hand-written, and not too many. */
export function stableClasses(node: SelectorNode): string[] {
  return (node.classNames ?? [])
    .filter((name) => name !== '' && !looksGenerated(name))
    // Two is enough to disambiguate and few enough to survive a restyle. A
    // selector listing eight utility classes breaks when anyone adjusts
    // padding.
    .slice(0, 2);
}

/** One path segment for a node, without its ancestors. */
export function segmentFor(node: SelectorNode, options: SelectorOptions = {}): string {
  const tag = node.tagName.toLowerCase();
  const attributes = options.testIdAttributes ?? DEFAULT_TEST_ID_ATTRIBUTES;

  const handle = testId(node, attributes);
  if (handle !== undefined) return `${tag}[${handle.name}="${handle.value}"]`;

  if (node.id !== undefined && node.id !== null && node.id !== '' && !looksGenerated(node.id)) {
    return `${tag}#${escapeIdentifier(node.id)}`;
  }

  const classes = stableClasses(node);
  const base = classes.length > 0 ? `${tag}.${classes.map(escapeIdentifier).join('.')}` : tag;

  // An index only when the tag is genuinely ambiguous among its siblings.
  // Emitting `:nth-of-type(1)` on an only child adds fragility for nothing.
  const count = node.countOfType ?? 1;
  if (count > 1 && node.indexOfType !== undefined) {
    return `${base}:nth-of-type(${String(node.indexOfType)})`;
  }
  return base;
}

/**
 * Build a selector, walking up until it is specific enough.
 *
 * Stops early on a test id or a stable id, because an ancestor path adds
 * nothing to an already-unique handle and only creates more ways to break.
 */
export function selectorFor(node: SelectorNode, options: SelectorOptions = {}): string {
  const attributes = options.testIdAttributes ?? DEFAULT_TEST_ID_ATTRIBUTES;
  const maxDepth = options.maxDepth ?? 5;

  const first = segmentFor(node, options);
  if (testId(node, attributes) !== undefined) return first;
  if (first.includes('#')) return first;

  const parts = [first];
  let current = node.parent ?? undefined;
  let depth = 1;

  while (current !== undefined && current !== null && depth < maxDepth) {
    const tag = current.tagName.toLowerCase();
    // `html` and `body` are on every page and identify nothing.
    if (tag === 'html' || tag === 'body') break;

    const segment = segmentFor(current, options);
    parts.unshift(segment);

    // An ancestor with a real handle anchors the whole path; nothing above it
    // can make the selector more findable.
    if (segment.includes('[') || segment.includes('#')) break;

    current = current.parent ?? undefined;
    depth++;
  }

  return parts.join(' > ');
}
