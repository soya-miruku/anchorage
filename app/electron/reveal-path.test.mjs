import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateRevealPath } from "./reveal-path.mjs";

/**
 * The renderer can ask the desktop to open a location, so this is where that request stops being
 * a string and becomes a filesystem action. Compose file paths originate from a Docker daemon,
 * which on a remote context is not this machine and not necessarily trusted.
 */
const directory = mkdtempSync(join(tmpdir(), "anchorage-reveal-"));
const file = join(directory, "compose.yaml");
writeFileSync(file, "services: {}\n");

test("accepts a real file and a real directory, normalised", () => {
  assert.equal(validateRevealPath(file), file);
  assert.equal(validateRevealPath(directory), directory);
  assert.equal(validateRevealPath(`${directory}/./compose.yaml`), file);
});

test("refuses a relative path, which would resolve against the main process cwd", () => {
  assert.throws(() => validateRevealPath("compose.yaml"), /absolute/u);
  assert.throws(() => validateRevealPath("./compose.yaml"), /absolute/u);
});

test("refuses a path that does not exist rather than asking the desktop to guess", () => {
  assert.throws(() => validateRevealPath(join(directory, "absent.yaml")), /does not exist/u);
});

test("refuses an empty or non-string request", () => {
  assert.throws(() => validateRevealPath(""), /required/u);
  assert.throws(() => validateRevealPath("   "), /required/u);
  assert.throws(() => validateRevealPath(undefined), /required/u);
  assert.throws(() => validateRevealPath(42), /required/u);
});

test("refuses a null byte, which truncates the path for whatever reads it next", () => {
  assert.throws(() => validateRevealPath(`${file}\0.txt`), /null byte/u);
});

test("refuses anything that is not a file or directory", () => {
  // A socket or device is not something a file manager can show, and handing one to the desktop
  // is a good way to discover what it does instead.
  const fake = () => ({ isFile: () => false, isDirectory: () => false });
  assert.throws(
    () => validateRevealPath("/dev/null", { stat: fake }),
    /file or directory/u,
  );
});
