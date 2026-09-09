/**
 * `<quorum-nub>`, in an actual browser.
 *
 * Every assertion here covers a line from the README's "What is not verified"
 * list. The pure modules around this element have had full coverage since the
 * day they were written; this file exists because none of that says whether a
 * shadow root gets attached or whether a click reaches a listener, and those
 * are the only failures a user would ever see.
 *
 * ## Why these tests can skip
 *
 * There is no browser to install here — the registry is unreachable — so this
 * drives whatever Chromium-family browser is already on the machine over CDP
 * (`docs/adr/0022-verify-the-dom-layer-over-cdp.md`). When there is none, these
 * skip with a reason rather than fail, the same way the repo treats everything
 * else it cannot verify: say so out loud.
 *
 * **Set `QUORUM_BROWSER_REQUIRED=1` to turn a skip into a failure.** CI does,
 * on the job that has a browser. Without that, a broken launch would look
 * exactly like a machine without Chrome, and the DOM layer would quietly stop
 * being tested again.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Browser, MODIFIER, type Page } from '../../../tools/browser/src/browser.ts';
import { locateBrowser } from '../../../tools/browser/src/locate.ts';
import { createDevServer } from '../../../tools/devserver/src/serve.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE = '/packages/web/test/blank.html';

const executablePath = locateBrowser();
const skip =
  executablePath === undefined
    ? 'no Chromium-family browser found — set CHROME_PATH to run the DOM tests'
    : false;

describe('<quorum-nub> in a real browser', { skip }, () => {
  let server: Server;
  let browser: Browser | undefined;
  let base = '';
  let launchError: Error | undefined;

  before(async () => {
    server = createDevServer({ root: REPO_ROOT });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      browser = await Browser.launch({ executablePath: executablePath as string });
    } catch (error) {
      launchError = error instanceof Error ? error : new Error(String(error));
    }
  });

  after(async () => {
    await browser?.close();
    await new Promise<void>((done) => server.close(() => done()));
  });

  /**
   * One fresh page per test.
   *
   * Not an optimization to skip: the element registers a listener on
   * `document`, so a shared page would let one test's shortcut binding answer
   * another test's keystroke, and the suite would pass for the wrong reason.
   */
  function browserTest(name: string, run: (page: Page) => Promise<void>): void {
    it(name, async (t: TestContext) => {
      if (browser === undefined) {
        const reason = `browser found but would not launch: ${launchError?.message ?? 'unknown'}`;
        if (process.env['QUORUM_BROWSER_REQUIRED'] === '1') throw launchError ?? new Error(reason);
        t.skip(reason);
        return;
      }

      const page = await browser.newPage(`${base}${FIXTURE}`);
      try {
        await run(page);
        // A test that asserted the right thing while the page threw during
        // module evaluation has not proven what it claims.
        page.assertClean();
      } finally {
        await page.close();
      }
    });
  }

  /**
   * Register the element and mount one, the way a host page would.
   *
   * The explicit `waitFor` after the evaluate is not redundant belt-and-braces
   * — it is the assertion that the mount actually finished. The first run of
   * this suite failed 19 of 20 tests because the driver returned before the
   * dynamic `import()` resolved, and every test then asserted against a
   * document with no element in it. The driver bug is fixed; this makes the
   * failure impossible to reintroduce silently, and turns "the element never
   * appeared" into one clear timeout instead of twenty null dereferences.
   */
  async function mountNub(page: Page, attributes: Record<string, string>): Promise<void> {
    const attrs = JSON.stringify(attributes);
    await page.evaluate(`
      (async () => {
        const mod = await import('/packages/web/src/index.ts');
        mod.defineQuorumNub();
        const el = document.createElement('quorum-nub');
        for (const [name, value] of Object.entries(${attrs})) el.setAttribute(name, value);
        document.body.append(el);
        await customElements.whenDefined('quorum-nub');
        return true;
      })()
    `);
    await page.waitFor(`document.querySelector('quorum-nub')`, 5_000);
  }

  const NUB = "document.querySelector('quorum-nub')";
  const ROOT = `${NUB}.shadowRoot`;

  // -- rendering ------------------------------------------------------------

  browserTest('attaches an open shadow root and renders the trigger', async (page) => {
    await mountNub(page, { project: 'pk_test_1', label: 'Tell us' });

    const result = await page.evaluate<{
      mode: string | null;
      label: string;
      part: string | null;
      expanded: string | null;
      popup: string | null;
    }>(`
      (() => {
        const root = ${ROOT};
        const button = root.querySelector('button');
        return {
          mode: root ? 'open' : null,
          label: button.textContent,
          part: button.getAttribute('part'),
          expanded: button.getAttribute('aria-expanded'),
          popup: button.getAttribute('aria-haspopup'),
        };
      })()
    `);

    assert.equal(result.mode, 'open', 'shadow root must be open for ::part() theming');
    assert.equal(result.label, 'Tell us');
    assert.equal(result.part, 'trigger');
    assert.equal(result.expanded, 'false');
    assert.equal(result.popup, 'dialog');
  });

  browserTest('the generated stylesheet actually applies', async (page) => {
    await mountNub(page, { project: 'pk_test_1' });

    // Computed style, not the presence of a <style> tag. The failure worth
    // catching is a stylesheet that parses but selects nothing.
    const style = await page.evaluate<{ position: string; radius: string }>(`
      (() => {
        const button = ${ROOT}.querySelector('button');
        const computed = getComputedStyle(button);
        return { position: computed.position, radius: computed.borderRadius };
      })()
    `);

    assert.equal(style.position, 'fixed', 'the trigger anchors to the viewport');
    assert.notEqual(style.radius, '0px', 'the preset sets a radius');
  });

  browserTest('a page-level custom property wins over the default token', async (page) => {
    await mountNub(page, { project: 'pk_test_1' });
    await page.evaluate(`
      (() => {
        const sheet = document.createElement('style');
        sheet.textContent = 'quorum-nub { --quorum-radius: 3px }';
        document.head.append(sheet);
      })()
    `);

    const radius = await page.evaluate<string>(
      `getComputedStyle(${ROOT}.querySelector('button')).borderRadius`,
    );
    // ADR-0004: tokens live on :host so a host page rule beats them. If they
    // were set inline this would silently be unthemeable.
    assert.equal(radius, '3px');
  });

  browserTest('renders nothing without a project key', async (page) => {
    await mountNub(page, { label: 'Feedback' });
    const count = await page.evaluate<number>(`${ROOT}.childElementCount`);
    assert.equal(count, 0, 'a button that cannot send anywhere is worse than no button');
  });

  browserTest('position=hidden renders no trigger but still opens', async (page) => {
    await mountNub(page, { project: 'pk_test_1', position: 'hidden' });

    assert.equal(await page.evaluate<number>(`${ROOT}.querySelectorAll('button').length`), 0);

    await page.evaluate(`${NUB}.open()`);
    assert.equal(await page.evaluate<string>(`${NUB}.state`), 'composing');
    assert.equal(await page.evaluate<boolean>(`!!${ROOT}.querySelector('.panel')`), true);
  });

  // -- interaction ----------------------------------------------------------

  browserTest('clicking the trigger opens the panel, clicking again closes it', async (page) => {
    await mountNub(page, { project: 'pk_test_1' });

    const opened = await page.evaluate<{ state: string; role: string; expanded: string }>(`
      (() => {
        ${ROOT}.querySelector('button').click();
        const panel = ${ROOT}.querySelector('.panel');
        return {
          state: ${NUB}.state,
          role: panel.getAttribute('role'),
          expanded: ${ROOT}.querySelector('.trigger').getAttribute('aria-expanded'),
        };
      })()
    `);

    assert.equal(opened.state, 'composing');
    assert.equal(opened.role, 'dialog');
    assert.equal(opened.expanded, 'true');

    const closed = await page.evaluate<{ state: string; panel: boolean }>(`
      (() => {
        ${ROOT}.querySelector('.trigger').click();
        return { state: ${NUB}.state, panel: !!${ROOT}.querySelector('.panel') };
      })()
    `);

    assert.equal(closed.state, 'idle');
    assert.equal(closed.panel, false);
  });

  browserTest('submit enables only once there is something to send', async (page) => {
    await mountNub(page, { project: 'pk_test_1' });
    await page.evaluate(`${NUB}.open()`);

    assert.equal(
      await page.evaluate<boolean>(`${ROOT}.querySelector('.submit').disabled`),
      true,
      'an empty feature request has nothing to submit',
    );

    const enabled = await page.evaluate<boolean>(`
      (() => {
        const field = ${ROOT}.querySelector('.field');
        field.value = 'dark mode please';
        field.dispatchEvent(new Event('input'));
        return !${ROOT}.querySelector('.submit').disabled;
      })()
    `);
    assert.equal(enabled, true);

    const disabledAgain = await page.evaluate<boolean>(`
      (() => {
        const field = ${ROOT}.querySelector('.field');
        field.value = '   ';
        field.dispatchEvent(new Event('input'));
        return ${ROOT}.querySelector('.submit').disabled;
      })()
    `);
    assert.equal(disabledAgain, true, 'whitespace is not feedback');
  });

  browserTest('events escape the shadow root, composed, onto document', async (page) => {
    await mountNub(page, { project: 'pk_test_1' });

    const seen = await page.evaluate<string[]>(`
      (async () => {
        const seen = [];
        for (const name of ['open', 'close', 'submitrequest']) {
          document.addEventListener('quorum:' + name, () => seen.push(name));
        }
        const root = ${ROOT};
        root.querySelector('.trigger').click();
        const field = root.querySelector('.field');
        field.value = 'the export button does nothing';
        field.dispatchEvent(new Event('input'));
        root.querySelector('.submit').click();
        ${NUB}.close();
        return seen;
      })()
    `);

    // The documented integration is a listener on `document`. If these did not
    // cross the shadow boundary, every host would have to reach into the root.
    assert.deepEqual(seen, ['open', 'submitrequest', 'close']);
  });

  browserTest('the submitrequest detail carries the draft and kind', async (page) => {
    await mountNub(page, { project: 'pk_test_1', kind: 'bug' });

    const detail = await page.evaluate<{ draft: string; kind: string }>(`
      (() => {
        let detail;
        document.addEventListener('quorum:submitrequest', (e) => { detail = e.detail });
        ${NUB}.open();
        const field = ${ROOT}.querySelector('.field');
        field.value = 'checkout 500s on Safari';
        field.dispatchEvent(new Event('input'));
        ${ROOT}.querySelector('.submit').click();
        return detail;
      })()
    `);

    assert.equal(detail.draft, 'checkout 500s on Safari');
    assert.equal(detail.kind, 'bug');
  });

  // -- keyboard -------------------------------------------------------------

  browserTest('the keyboard shortcut opens the panel', async (page) => {
    await mountNub(page, { project: 'pk_test_1', shortcut: 'mod+shift+k' });

    const isMac = await page.evaluate<boolean>(`/mac/i.test(navigator.platform || navigator.userAgent)`);
    await page.press('k', {
      code: 'KeyK',
      modifiers: MODIFIER.shift | (isMac ? MODIFIER.meta : MODIFIER.ctrl),
    });

    await page.waitFor(`${NUB}.state === 'composing'`, 2_000);
  });

  browserTest('the shortcut is ignored while the user is typing', async (page) => {
    await mountNub(page, { project: 'pk_test_1', shortcut: 'mod+shift+k' });
    await page.evaluate(`
      (() => {
        const input = document.createElement('input');
        input.id = 'host-field';
        document.body.append(input);
        input.focus();
      })()
    `);

    const isMac = await page.evaluate<boolean>(`/mac/i.test(navigator.platform || navigator.userAgent)`);
    await page.press('k', {
      code: 'KeyK',
      modifiers: MODIFIER.shift | (isMac ? MODIFIER.meta : MODIFIER.ctrl),
    });

    assert.equal(
      await page.evaluate<string>(`${NUB}.state`),
      'idle',
      'stealing a keystroke mid-sentence is how two widgets fight over a chord',
    );
  });

  browserTest('shortcut=off binds nothing', async (page) => {
    await mountNub(page, { project: 'pk_test_1', shortcut: 'off' });
    await page.press('k', { code: 'KeyK', modifiers: MODIFIER.shift | MODIFIER.meta });
    assert.equal(await page.evaluate<string>(`${NUB}.state`), 'idle');
  });

  // -- lifecycle ------------------------------------------------------------

  browserTest('attributeChangedCallback re-renders', async (page) => {
    await mountNub(page, { project: 'pk_test_1', label: 'Feedback' });

    const label = await page.evaluate<string>(`
      (() => {
        ${NUB}.setAttribute('label', 'Report a bug');
        return ${ROOT}.querySelector('.trigger').textContent;
      })()
    `);
    assert.equal(label, 'Report a bug');
  });

  browserTest('disconnecting removes the document keydown listener', async (page) => {
    await mountNub(page, { project: 'pk_test_1', shortcut: 'mod+shift+k' });
    await page.evaluate(`
      (() => {
        const el = ${NUB};
        el.remove();
        window.__detached = el;
      })()
    `);

    const isMac = await page.evaluate<boolean>(`/mac/i.test(navigator.platform || navigator.userAgent)`);
    await page.press('k', {
      code: 'KeyK',
      modifiers: MODIFIER.shift | (isMac ? MODIFIER.meta : MODIFIER.ctrl),
    });

    // A listener surviving disconnect is the classic custom-element leak: a
    // SPA that mounts and unmounts this a dozen times ends up with a dozen
    // handlers, all opening panels on one keystroke.
    assert.equal(await page.evaluate<string>(`window.__detached.state`), 'idle');
  });

  browserTest('"Try again" is clickable after a failure', async (page) => {
    await mountNub(page, { project: 'pk_test_1' });

    const state = await page.evaluate<{ label: string; disabled: boolean; draft: string }>(`
      (async () => {
        const el = ${NUB};
        // Fail the send by pointing the client at something that refuses.
        el.open();
        const field = ${ROOT}.querySelector('.field');
        field.value = 'the export button is dead';
        field.dispatchEvent(new Event('input'));

        // Drive the machine to error the way a permanent rejection would,
        // through the element's own submit path with ingest answering 400.
        const realFetch = window.fetch;
        window.fetch = async () => new Response('{}', { status: 400 });
        ${ROOT}.querySelector('.submit').click();
        await new Promise((r) => setTimeout(r, 100));
        window.fetch = realFetch;

        const submit = ${ROOT}.querySelector('.submit');
        return {
          label: submit.textContent,
          disabled: submit.disabled,
          draft: ${ROOT}.querySelector('.field').value,
        };
      })()
    `);

    assert.equal(state.label, 'Try again');
    // Wiring this straight to the machine's `canSubmit` left it permanently
    // disabled, so the retry the copy promises could never be clicked.
    assert.equal(state.disabled, false);
    assert.equal(state.draft, 'the export button is dead', 'the draft must survive a failure');
  });

  browserTest('editing after a failure keeps the revision', async (page) => {
    await mountNub(page, { project: 'pk_test_1' });

    const draft = await page.evaluate<string>(`
      (async () => {
        const el = ${NUB};
        el.open();
        const field = ${ROOT}.querySelector('.field');
        field.value = 'first attempt';
        field.dispatchEvent(new Event('input'));

        const realFetch = window.fetch;
        window.fetch = async () => new Response('{}', { status: 400 });
        ${ROOT}.querySelector('.submit').click();
        await new Promise((r) => setTimeout(r, 100));
        window.fetch = realFetch;

        const after = ${ROOT}.querySelector('.field');
        after.value = 'revised attempt';
        after.dispatchEvent(new Event('input'));
        return el.state === 'composing' ? 'composing:' + ${ROOT}.querySelector('.field').value : el.state;
      })()
    `);

    // The machine ignores `edit` in `error`, so without an implicit retry the
    // user's revision goes nowhere and the retry sends the old text.
    assert.equal(draft, 'composing:revised attempt');
  });

  browserTest('changing the project builds a new client', async (page) => {
    await mountNub(page, { project: 'pk_one' });

    const swapped = await page.evaluate<boolean>(`
      (() => {
        const el = ${NUB};
        const first = el.client;
        el.setAttribute('project', 'pk_two');
        return el.client !== first;
      })()
    `);

    // Keeping the old client would send the next submission to the old
    // endpoint under the old key, and strand the durable queue — which is
    // keyed on the project — under a name nothing reads again.
    assert.equal(swapped, true);
  });

  browserTest('identify() before the client exists is not lost', async (page) => {
    await mountNub(page, { project: 'pk_test_1' });

    const traits = await page.evaluate<{ externalId: string; mrr: number }>(`
      (() => {
        const el = ${NUB};
        el.identify('u_early', { mrr: 4000 });
        const user = el.client.user;
        return { externalId: user.externalId, mrr: user.traits.mrr };
      })()
    `);

    // A host calling identify() from its own bootstrap routinely beats the
    // first submission. Dropping the call would silently cost account weight
    // on everything until the next login.
    assert.equal(traits.externalId, 'u_early');
    assert.equal(traits.mrr, 4000);
  });

  browserTest('preventDefault on submitrequest suppresses the built-in send', async (page) => {
    await mountNub(page, { project: 'pk_test_1' });

    const state = await page.evaluate<string>(`
      (() => {
        document.addEventListener('quorum:submitrequest', (e) => e.preventDefault());
        ${NUB}.open();
        const field = ${ROOT}.querySelector('.field');
        field.value = 'handled by the host';
        field.dispatchEvent(new Event('input'));
        ${ROOT}.querySelector('.submit').click();
        return ${NUB}.state;
      })()
    `);

    // The host said it would handle this, so the machine must not advance —
    // otherwise the panel says "Sending…" for a request nobody sent.
    assert.equal(state, 'composing');
  });

  browserTest('a bad attribute warns and falls back instead of throwing', async (page) => {
    await mountNub(page, { project: 'pk_test_1', preset: 'nonsense', offset: 'banana' });

    const rendered = await page.evaluate<boolean>(`!!${ROOT}.querySelector('.trigger')`);
    assert.equal(rendered, true, 'a typo must not break the page this is embedded in');
  });
});
