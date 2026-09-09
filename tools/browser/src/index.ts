/**
 * `@quorum/browser` — a zero-dependency CDP driver.
 *
 * Exists for exactly one reason: `@quorum/web` cannot be verified without a
 * real DOM, and no browser test runner can be installed here. See
 * `docs/adr/0022-verify-the-dom-layer-over-cdp.md`.
 */

export { Browser, chromeArgs, MODIFIER, Page, parseEndpoint } from './browser.ts';
export type { LaunchOptions, PageError } from './browser.ts';

export { CdpConnection } from './cdp.ts';
export type { CdpEvent, CdpListener, SocketLike } from './cdp.ts';

export { candidatePaths, isExecutable, locateBrowser } from './locate.ts';
export type { BrowserPlatform } from './locate.ts';
