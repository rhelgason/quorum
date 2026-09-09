/**
 * Selector generation.
 *
 * The failure to design against is a selector that is *specific and wrong*: it
 * resolves today, silently matches nothing after the next deploy, and the
 * capture looks precise the whole time. So most of these tests are about
 * refusing to trust an identifier a build tool invented.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  escapeIdentifier,
  looksGenerated,
  segmentFor,
  selectorFor,
  stableClasses,
  type SelectorNode,
} from './selector.ts';

/** Build a parent chain from outermost to innermost. */
function chain(...nodes: SelectorNode[]): SelectorNode {
  for (let i = 1; i < nodes.length; i++) (nodes[i] as SelectorNode).parent = nodes[i - 1];
  return nodes[nodes.length - 1] as SelectorNode;
}

describe('looksGenerated', () => {
  it('accepts identifiers a human plausibly typed', () => {
    for (const name of ['submit', 'checkout-form', 'nav_primary', 'btn2', 'h1Title', 'col-md-6']) {
      assert.equal(looksGenerated(name), false, `${name} should be treated as stable`);
    }
  });

  it('rejects framework-generated ids', () => {
    for (const name of [':r0:', ':R2ab:', 'css-1x2y3z', 'sc-AxjAm', 'Button_root__a1b2c']) {
      assert.equal(looksGenerated(name), true, `${name} should be treated as generated`);
    }
  });

  it('rejects hashes and long digit runs', () => {
    for (const name of ['a3f9c2e18b', 'item-1024567', 'deadbeefcafe']) {
      assert.equal(looksGenerated(name), true, `${name} should be treated as generated`);
    }
  });

  it('rejects the empty string', () => {
    assert.equal(looksGenerated(''), true);
  });
});

describe('stableClasses', () => {
  it('drops generated classes and keeps written ones', () => {
    const node: SelectorNode = {
      tagName: 'button',
      classNames: ['css-1a2b3c', 'submit', 'sc-XyZab', 'primary'],
    };
    assert.deepEqual(stableClasses(node), ['submit', 'primary']);
  });

  it('caps at two, because a long class list breaks on any restyle', () => {
    const node: SelectorNode = {
      tagName: 'div',
      classNames: ['flex', 'items-center', 'gap-2', 'rounded', 'border'],
    };
    assert.equal(stableClasses(node).length, 2);
  });

  it('is empty when everything is generated', () => {
    assert.deepEqual(stableClasses({ tagName: 'div', classNames: ['css-9z8y7x'] }), []);
  });
});

describe('segmentFor', () => {
  it('prefers a test id over everything', () => {
    const node: SelectorNode = {
      tagName: 'BUTTON',
      id: 'send',
      classNames: ['submit'],
      attributes: { 'data-testid': 'checkout-submit' },
    };
    // The only attribute a team has promised not to churn.
    assert.equal(segmentFor(node), 'button[data-testid="checkout-submit"]');
  });

  it('honours the test id attribute order', () => {
    const node: SelectorNode = {
      tagName: 'div',
      attributes: { 'data-qa': 'second', 'data-testid': 'first' },
    };
    assert.equal(segmentFor(node), 'div[data-testid="first"]');
  });

  it('uses a hand-written id next', () => {
    assert.equal(segmentFor({ tagName: 'form', id: 'checkout' }), 'form#checkout');
  });

  it('ignores a generated id and falls back to classes', () => {
    const node: SelectorNode = { tagName: 'div', id: ':r7:', classNames: ['panel'] };
    assert.equal(segmentFor(node), 'div.panel');
  });

  it('adds an index only when the tag is ambiguous', () => {
    assert.equal(segmentFor({ tagName: 'li', indexOfType: 1, countOfType: 1 }), 'li');
    assert.equal(segmentFor({ tagName: 'li', indexOfType: 3, countOfType: 6 }), 'li:nth-of-type(3)');
  });

  it('lowercases the tag', () => {
    assert.equal(segmentFor({ tagName: 'SECTION' }), 'section');
  });
});

describe('selectorFor', () => {
  it('stops at a test id without climbing', () => {
    const target = chain(
      { tagName: 'main' },
      { tagName: 'form', classNames: ['checkout'] },
      { tagName: 'button', attributes: { 'data-testid': 'pay' } },
    );
    // An ancestor path adds nothing to a unique handle and only creates more
    // ways to break.
    assert.equal(selectorFor(target), 'button[data-testid="pay"]');
  });

  it('stops at a stable id without climbing', () => {
    const target = chain({ tagName: 'main' }, { tagName: 'button', id: 'pay-now' });
    assert.equal(selectorFor(target), 'button#pay-now');
  });

  it('builds a path when the element has no handle', () => {
    const target = chain(
      { tagName: 'main' },
      { tagName: 'form', classNames: ['checkout'] },
      { tagName: 'button', classNames: ['submit'] },
    );
    assert.equal(selectorFor(target), 'main > form.checkout > button.submit');
  });

  it('anchors on the first ancestor that has a handle', () => {
    const target = chain(
      { tagName: 'main' },
      { tagName: 'section', id: 'billing' },
      { tagName: 'div' },
      { tagName: 'button', classNames: ['submit'] },
    );
    assert.equal(selectorFor(target), 'section#billing > div > button.submit');
  });

  it('never includes html or body', () => {
    const target = chain(
      { tagName: 'html' },
      { tagName: 'body' },
      { tagName: 'div', classNames: ['app'] },
      { tagName: 'p' },
    );
    // They are on every page and identify nothing.
    const selector = selectorFor(target);
    assert.ok(!selector.includes('html'));
    assert.ok(!selector.includes('body'));
  });

  it('bounds how far it climbs', () => {
    let node: SelectorNode = { tagName: 'div' };
    for (let i = 0; i < 20; i++) node = { tagName: 'div', parent: node };

    const segments = selectorFor(node, { maxDepth: 3 }).split(' > ');
    assert.equal(segments.length, 3);
  });

  it('handles an orphan node', () => {
    assert.equal(selectorFor({ tagName: 'button', classNames: ['submit'] }), 'button.submit');
  });

  it('produces something for a node with nothing distinctive at all', () => {
    // Worse than useless would be an empty string; a bare tag is at least
    // truthful about how little it knows.
    assert.equal(selectorFor({ tagName: 'span' }), 'span');
  });
});

describe('escapeIdentifier', () => {
  it('escapes characters that would break a selector', () => {
    assert.equal(escapeIdentifier('foo:bar'), 'foo\\:bar');
    assert.equal(escapeIdentifier('a/b'), 'a\\/b');
  });

  it('leaves ordinary identifiers alone', () => {
    assert.equal(escapeIdentifier('checkout-form_2'), 'checkout-form_2');
  });

  it('escapes a leading digit, which CSS forbids', () => {
    assert.match(escapeIdentifier('2col'), /^\\3/);
  });
});
