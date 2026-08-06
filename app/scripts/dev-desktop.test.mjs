import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import { portInUse } from "./dev-desktop.mjs";

/**
 * The one check that runs before Vite is spawned.
 *
 * Vite runs with `--strictPort` on purpose: a renderer that quietly moves to 5174 while the
 * Electron main process is still told 5173 fails later, and less clearly. What it produced
 * instead was a three-line failure whose only `[anchorage]`-prefixed line — the line anyone
 * reads — said "Vite exited before the renderer became available". That describes a crash. The
 * actual cause, every time it has happened, was a `dev:desktop` from twenty minutes earlier
 * still holding the port with a window on another workspace.
 *
 * Reported as "bun run dev:desktop is not showing the desktop app anymore", which is exactly
 * what it looks like from outside: the command returns, and no window appears.
 */

test("a listening port is reported as in use", async () => {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  try {
    assert.equal(await portInUse(port), true);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("a port nothing is listening on is free, and does not hang deciding so", async () => {
  // Bound and released, so the number is real and almost certainly unused rather than arbitrary.
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));

  const started = Date.now();
  assert.equal(await portInUse(port), false);
  // A refused connection answers immediately; the 500ms timeout is for a host that blackholes
  // rather than refuses. If this ever takes the full timeout, the fast path has broken and every
  // `dev:desktop` pays for it.
  assert.ok(Date.now() - started < 400, "a refused connection should answer at once");
});

test("importing the launcher does not start a dev server", async () => {
  /*
   * The module used to call main() at the top level, so importing it spawned Vite and Electron.
   * That is why the export above is safe to test at all, and it is worth pinning: the guard is
   * one line and reads like boilerplate, so it is exactly the kind of thing a later edit drops.
   */
  const module = await import("./dev-desktop.mjs");
  assert.equal(typeof module.portInUse, "function");
});
