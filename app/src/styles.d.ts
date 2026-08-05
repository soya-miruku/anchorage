declare module "*.css";

/** Vite's raw text import. Used so a test can assert on a source file's text without
 *  reaching for node:fs, which renderer code has no types for and no business using. */
declare module "*?raw" {
  const content: string;
  export default content;
}

/**
 * Injected by Vite from `app/package.json` (see `vite.config.mjs`), so the titlebar
 * cannot claim a version that was never built.
 */
declare const __ANCHORAGE_VERSION__: string;
