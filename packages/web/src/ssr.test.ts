import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The one thing about the DOM layer that *is* verifiable without a DOM: that
 * importing the package in an environment which has none does not explode.
 *
 * Every SSR framework imports client modules on the server. A feedback widget
 * that throws a ReferenceError during a Next.js render is not shippable, and
 * the naive `export class QuorumNub extends HTMLElement` at module scope does
 * exactly that — `HTMLElement` is dereferenced the moment the module is
 * evaluated. This file is the regression test for that mistake.
 */
describe('importing without a DOM', () => {
  test('the package entry point imports cleanly in Node', async () => {
    assert.equal(typeof globalThis.HTMLElement, 'undefined', 'precondition: no DOM here');
    const mod = await import('./index.ts');
    assert.equal(typeof mod.defineQuorumNub, 'function');
  });

  test('registration is an inert no-op with no customElements registry', async () => {
    const { defineQuorumNub } = await import('./index.ts');
    let registered: boolean | undefined;
    assert.doesNotThrow(() => {
      registered = defineQuorumNub();
    });
    assert.equal(registered, false);
  });

  test('the pure modules are usable server-side', async () => {
    // A framework wrapper doing SSR still wants to validate props.
    const { parseAttributes, copyFor } = await import('./index.ts');
    assert.equal(parseAttributes(() => 'pk_1').config.project, 'pk_1');
    assert.ok(copyFor('composing', 'bug').heading.length > 0);
  });

  test('the class is only built when asked for', async () => {
    // Deferring construction is the whole mechanism; if `nubClass` were
    // evaluated eagerly the import above would already have thrown.
    const { nubClass } = await import('./index.ts');
    assert.throws(() => nubClass(), ReferenceError);
  });
});
