import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import test from "node:test";

/**
 * The built core answers only the verbs it was compiled with.
 *
 * `core/bin/anchorage-core` is a build artefact that the desktop dev launcher runs directly.
 * When a new RPC lands in the Go source and the binary is not rebuilt, the renderer gets
 * `method_not_found` from a verb that plainly exists in the tree — which reads as a broken
 * feature rather than a stale file. That happened once already with `compose.config`.
 *
 * This does not compile anything; it compares timestamps, which is enough to catch the case.
 */
test("the built core is not older than the Go sources it was built from", () => {
  const binary = new URL("../../core/bin/anchorage-core", import.meta.url);
  let built;
  try {
    built = statSync(binary).mtimeMs;
  } catch {
    // Not every checkout has run a build yet; that is a different problem from a stale one.
    return;
  }

  const sourceDir = new URL("../../core/internal/core/", import.meta.url);
  const newest = readdirSync(sourceDir)
    .filter((name) => name.endsWith(".go") && !name.endsWith("_test.go"))
    .map((name) => statSync(new URL(name, sourceDir)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);

  assert.ok(
    built >= newest,
    "core/bin/anchorage-core is older than core/internal/core/*.go — run `go build -o bin/anchorage-core ./cmd/anchorage-core` in core/, or the app will answer new verbs with method_not_found",
  );
});
