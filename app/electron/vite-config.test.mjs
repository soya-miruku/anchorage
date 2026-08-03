import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import viteConfig from "../vite.config.mjs";

const sourceHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("production CSP is strict while the Vite-only transform enables local HMR", () => {
  assert.match(sourceHtml, /script-src 'self';/u);
  assert.doesNotMatch(sourceHtml, /script-src 'self' 'unsafe-inline'/u);
  assert.match(sourceHtml, /connect-src 'self';/u);

  const plugin = viteConfig.plugins.find(
    (candidate) => candidate?.name === "anchorage-development-csp",
  );
  assert.equal(plugin?.apply, "serve");
  const developmentHtml = plugin.transformIndexHtml(sourceHtml);

  assert.match(developmentHtml, /script-src 'self' 'unsafe-inline';/u);
  assert.match(
    developmentHtml,
    /connect-src 'self' ws:\/\/127\.0\.0\.1:\* ws:\/\/localhost:\*;/u,
  );
});

test("file builds use relative asset URLs for Electron loadURL", () => {
  assert.equal(viteConfig.base, "./");
  assert.equal(viteConfig.build.outDir, "dist/client");
});
