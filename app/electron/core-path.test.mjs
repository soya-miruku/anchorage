import assert from "node:assert/strict";
import test from "node:test";

import { resolveCoreBinaryPath } from "./core-path.mjs";

test("resolves deterministic development and packaged core paths", () => {
  assert.equal(
    resolveCoreBinaryPath({
      isPackaged: false,
      repositoryRoot: "/workspace/anchorage",
      environment: {},
      platform: "linux",
    }),
    "/workspace/anchorage/core/bin/anchorage-core",
  );

  assert.equal(
    resolveCoreBinaryPath({
      isPackaged: true,
      resourcesPath: "/opt/Anchorage/resources",
      environment: {},
      platform: "win32",
    }),
    "/opt/Anchorage/resources/core/anchorage-core.exe",
  );
});

test("core binary override is development-only and absolute", () => {
  assert.throws(
    () =>
      resolveCoreBinaryPath({
        isPackaged: true,
        resourcesPath: "/opt/app",
        environment: { ANCHORAGE_CORE_BINARY: "/tmp/core" },
        verifyOverride: false,
      }),
    /disabled/u,
  );
  assert.throws(
    () =>
      resolveCoreBinaryPath({
        isPackaged: false,
        environment: { ANCHORAGE_CORE_BINARY: "relative/core" },
        verifyOverride: false,
      }),
    /absolute/u,
  );
});
