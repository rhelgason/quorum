/**
 * Finding a Chromium-family browser that is already on the machine.
 *
 * The constraint this whole tool exists under: `registry.npmjs.org` is not
 * reachable from the authoring environment, so Playwright and
 * `@web/test-runner` — the obvious answers — cannot be installed, and neither
 * can a browser be downloaded. What *is* available is whatever the developer
 * already has in `/Applications`.
 *
 * So this never downloads anything and never fails the build when it comes up
 * empty. A missing browser means the DOM tests skip, loudly, which is the same
 * posture the rest of the repo takes toward things it cannot verify: say so
 * rather than fake it.
 *
 * The lookup is split into a pure candidate list and an injected existence
 * check so it can be tested on a machine with no browser at all, and so the
 * darwin list can be tested from Linux CI.
 */

import { accessSync, constants } from 'node:fs';

export type BrowserPlatform = 'darwin' | 'linux' | 'win32';

/**
 * Where each platform keeps a Chromium-family browser, most-preferred first.
 *
 * `CHROME_PATH` wins over everything. It is the escape hatch for a CI image
 * that has a browser somewhere unusual, and it is the documented way to point
 * these tests at a specific build.
 *
 * Chrome comes before Chromium and Edge not out of preference but because it
 * is the one most likely to be a current release; the protocol surface used
 * here is ancient and stable, so any of them works.
 */
export function candidatePaths(
  platform: string,
  env: Record<string, string | undefined> = {},
): string[] {
  const override = env['CHROME_PATH'];
  const explicit = override !== undefined && override !== '' ? [override] : [];

  if (platform === 'darwin') {
    return [
      ...explicit,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }

  if (platform === 'win32') {
    const programFiles = env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const programFilesX86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    return [
      ...explicit,
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ];
  }

  // Linux, and anything else that looks enough like it to be worth trying.
  return [
    ...explicit,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ];
}

/** True when the path exists and is executable by this process. */
export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first usable browser, or `undefined`.
 *
 * Undefined rather than a throw: every caller here turns "no browser" into a
 * skipped test, and making that an exception would mean each one has to catch
 * it to do the right thing.
 */
export function locateBrowser(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = isExecutable,
): string | undefined {
  return candidatePaths(platform, env).find(exists);
}
