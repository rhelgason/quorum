/**
 * Browser discovery and launch arguments.
 *
 * Every case injects both the platform and the existence check, so the darwin
 * list is testable from Linux CI and the whole file passes on a machine with
 * no browser installed at all — which is the machine this was written on.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { candidatePaths, isExecutable, locateBrowser } from './locate.ts';
import { chromeArgs, parseEndpoint } from './browser.ts';

describe('candidatePaths', () => {
  it('puts CHROME_PATH first on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const paths = candidatePaths(platform, { CHROME_PATH: '/custom/chrome' });
      assert.equal(paths[0], '/custom/chrome', `${platform} must honour the override`);
      assert.ok(paths.length > 1, 'the override does not replace the fallbacks');
    }
  });

  it('ignores an empty CHROME_PATH', () => {
    // An unset variable read from a shell script often arrives as "". Treating
    // that as a path makes the error "no such file: " instead of finding Chrome.
    const paths = candidatePaths('darwin', { CHROME_PATH: '' });
    assert.ok(paths[0]?.includes('Google Chrome'));
  });

  it('lists macOS application bundles', () => {
    const paths = candidatePaths('darwin', {});
    assert.ok(paths.some((p) => p.includes('Google Chrome.app')));
    assert.ok(paths.some((p) => p.includes('Chromium.app')));
    assert.ok(paths.every((p) => p.startsWith('/Applications')));
  });

  it('expands the Windows program directories from the environment', () => {
    const paths = candidatePaths('win32', { PROGRAMFILES: 'D:\\Apps' });
    assert.ok(paths.includes('D:\\Apps\\Google\\Chrome\\Application\\chrome.exe'));
  });

  it('falls back to the Linux list for anything unrecognised', () => {
    assert.deepEqual(candidatePaths('freebsd', {}), candidatePaths('linux', {}));
  });
});

describe('locateBrowser', () => {
  it('returns the first candidate that exists', () => {
    const found = locateBrowser('linux', {}, (path) => path === '/usr/bin/chromium');
    assert.equal(found, '/usr/bin/chromium');
  });

  it('prefers the earlier candidate when several exist', () => {
    const found = locateBrowser('linux', {}, () => true);
    assert.equal(found, '/usr/bin/google-chrome');
  });

  it('returns undefined rather than throwing when there is no browser', () => {
    // The whole skip-instead-of-fail posture depends on this being undefined.
    assert.equal(locateBrowser('linux', {}, () => false), undefined);
  });
});

describe('isExecutable', () => {
  it('is false for a path that does not exist', () => {
    assert.equal(isExecutable('/definitely/not/a/browser'), false);
  });

  it('is true for something that is', () => {
    assert.equal(isExecutable(process.execPath), true);
  });
});

describe('chromeArgs', () => {
  it('always isolates the profile', () => {
    // Without this Chrome may hand the command line to a running instance and
    // exit, printing no endpoint — a launch that times out with empty stderr.
    const args = chromeArgs('/tmp/profile', true);
    assert.ok(args.includes('--user-data-dir=/tmp/profile'));
  });

  it('lets the kernel pick the debugging port', () => {
    assert.ok(chromeArgs('/tmp/p', true).includes('--remote-debugging-port=0'));
  });

  it('omits the headless flag when asked for a visible browser', () => {
    assert.ok(chromeArgs('/tmp/p', true).includes('--headless=new'));
    assert.ok(!chromeArgs('/tmp/p', false).some((a) => a.startsWith('--headless')));
  });
});

describe('parseEndpoint', () => {
  it('pulls the websocket url out of the startup banner', () => {
    const stderr = [
      '[0908/134244.036761:ERROR:something noisy]',
      'DevTools listening on ws://127.0.0.1:51234/devtools/browser/9f0e-4a',
      '',
    ].join('\n');
    assert.equal(parseEndpoint(stderr), 'ws://127.0.0.1:51234/devtools/browser/9f0e-4a');
  });

  it('is undefined until the banner arrives', () => {
    assert.equal(parseEndpoint(''), undefined);
    assert.equal(parseEndpoint('DevTools listening on ws'), undefined);
  });

  it('waits for the end of the line rather than matching a partial url', () => {
    // stderr arrives in chunks and a boundary lands mid-url often enough to
    // matter. Matching early yields a truncated port and a connection failure
    // nowhere near the actual cause.
    const partial = 'DevTools listening on ws://127.0.0.1:512';
    assert.equal(parseEndpoint(partial), undefined);
    assert.equal(parseEndpoint(`${partial}34/devtools/browser/abc\n`), 'ws://127.0.0.1:51234/devtools/browser/abc');
  });
});

describe('CI flags', () => {
  it('always disables the shared-memory heuristic', () => {
    // Containers give /dev/shm 64MB, and Chrome hangs rather than failing when
    // it runs out. That cost a CI run that sat in progress until it was
    // cancelled by hand, which is why this is unconditional.
    assert.ok(chromeArgs('/tmp/p', true, {}).includes('--disable-dev-shm-usage'));
  });

  it('drops the sandbox only under CI', () => {
    // Most runners have no user namespace, so the sandbox cannot start.
    // Switching it off on someone's own machine should be a decision.
    assert.ok(!chromeArgs('/tmp/p', true, {}).includes('--no-sandbox'));
    assert.ok(chromeArgs('/tmp/p', true, { CI: 'true' }).includes('--no-sandbox'));
    assert.ok(!chromeArgs('/tmp/p', true, { CI: '' }).includes('--no-sandbox'));
  });
});
