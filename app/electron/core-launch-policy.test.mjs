import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveCoreLaunchPolicy } from "./core-launch-policy.mjs";

test("current Linux target keeps core cwd in HOME and allows filesystem-root scope", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "anchorage-home-policy-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const home = join(temporary, "real-home");
  const alias = join(temporary, "home-link");
  await mkdir(home);
  await symlink(home, alias, "dir");

  const policy = resolveCoreLaunchPolicy({
    platform: "linux",
    environment: { HOME: alias },
  });
  assert.equal(policy.cwd, home);
  assert.equal(policy.allowedCwdRoot, "/");
  assert.deepEqual([...policy.args], ["--allow-cwd", "/"]);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.args), true);
});

test("fails closed for absent, relative, non-directory, and filesystem-root homes", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "anchorage-home-policy-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const file = join(temporary, "not-a-home");
  await writeFile(file, "not a directory");

  for (const environment of [
    {},
    { HOME: "relative/home" },
    { HOME: file },
    { HOME: "/" },
  ]) {
    assert.throws(
      () =>
        resolveCoreLaunchPolicy({
          platform: "linux",
          environment,
        }),
      (error) => error.code === "INVALID_CORE_LAUNCH_POLICY",
    );
  }
});
