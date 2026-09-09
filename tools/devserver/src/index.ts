/**
 * `@quorum/devserver` — static files, TypeScript stripped on the fly, and a
 * proxy to the ingest API.
 *
 * Development only, and the example app's whole build step.
 */

export { contentType, createDevServer, resolvePath } from './serve.ts';
export type { DevServerOptions } from './serve.ts';

export { StripCache, stripSource } from './strip.ts';
