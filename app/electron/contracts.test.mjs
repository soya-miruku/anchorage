import assert from "node:assert/strict";
import test from "node:test";

import {
  validateCliRun,
  validateContainerAction,
  validateContainerIdentity,
  validateContainersList,
  validateCoreEventEnvelope,
  validateCoreEventName,
  validateImagesAction,
  validateImagesList,
  validateSessionAck,
  validateSessionCancel,
  validateSessionInput,
  validateSessionResize,
  validateSessionSignal,
  validateSessionStart,
  validateSystemCapabilities,
  validateSystemSnapshot,
  validateVolumesAction,
  validateVolumesList,
  validateWindowBackgroundColor,
  validateRendererEventEnvelope,
} from "./contracts.mjs";

const SESSION_ID = "01234567-89ab-cdef-0123-456789abcdef";
const CONTAINER_ID = "0123456789abcdef".repeat(4);
const IMAGE_ID = `sha256:${"0123456789abcdef".repeat(4)}`;
const TIMESTAMP = "2026-08-02T20:00:00.000Z";

test("normalizes a safe container action without retaining unknown state", () => {
  const result = validateContainerAction({
    context: "default",
    id: "0a12bc34".repeat(8),
    action: "stop",
    options: { timeoutSeconds: 12, force: false },
  });

  assert.deepEqual(result, {
    context: "default",
    id: "0a12bc34".repeat(8),
    action: "stop",
    options: { timeoutSeconds: 12, force: false },
  });
});

test("rejects unknown container actions and options", () => {
  assert.throws(
    () =>
      validateContainerAction({
        context: "default",
        id: "0a12bc34".repeat(8),
        action: "shell",
      }),
    /request\.action/u,
  );
  assert.throws(
    () =>
      validateContainerAction({
        context: "default",
        id: "0a12bc34".repeat(8),
        action: "start",
        options: { command: "rm" },
    }),
    /not supported/u,
  );
  assert.throws(
    () =>
      validateContainerAction({
        context: "default",
        id: "0a12bc34".repeat(8),
        action: "remove",
        options: { force: true },
      }),
    /confirmed must be true/u,
  );
  assert.throws(
    () =>
      validateContainerAction({
        context: "default",
        id: "0a12bc34".repeat(8),
        action: "remove",
        options: {
          timeoutSeconds: 0,
          force: true,
          confirmed: true,
        },
      }),
    /timeoutSeconds is not valid for remove/u,
  );
  assert.throws(
    () =>
      validateContainerAction({
        context: "default",
        id: "0a12bc34".repeat(8),
        action: "remove",
      }),
    /confirmed must be true/u,
  );
});

test("normalizes CLI requests using the exact core protocol field names", () => {
  assert.deepEqual(
    validateCliRun({
      context: "default",
      argv: ["compose", "ps", "--all"],
      cwd: "/srv/project",
      timeoutSeconds: 5,
      env: { DOCKER_DEFAULT_PLATFORM: "linux/amd64" },
    }),
    {
      context: "default",
      argv: ["compose", "ps", "--all"],
      targetMode: "pinned",
      cwd: "/srv/project",
      timeoutSeconds: 5,
      env: { DOCKER_DEFAULT_PLATFORM: "linux/amd64" },
    },
  );

  assert.throws(
    () => validateCliRun({ context: "default", args: ["ps"] }),
    /not supported/u,
  );
  assert.throws(
    () => validateCliRun({ context: "default", argv: ["ps"], cwd: "relative/path" }),
    /absolute path/u,
  );
  assert.throws(
    () => validateCliRun({ context: "default", argv: ["ps"], env: { LD_PRELOAD: "/tmp/x" } }),
    /not permitted/u,
  );
  assert.throws(
    () => validateCliRun({ context: "default", argv: ["--host", "tcp://example:2375", "ps"] }),
    /pinned Docker target/u,
  );
});

test("CLI target mode defaults to pinned and literal mode safely permits Docker target selection", () => {
  const literal = {
    context: "discovery-profile",
    targetMode: "literal",
    argv: [
      "--context",
      "remote",
      "--host=tcp://remote.example:2376",
      "--config",
      "/srv/docker-config",
      "--tls",
      "--tlsverify",
      "--tlscacert=/srv/tls/ca.pem",
      "--tlscert",
      "/srv/tls/cert.pem",
      "--tlskey=/srv/tls/key.pem",
      "ps",
    ],
    env: {
      DOCKER_HOST: "tcp://remote.example:2376",
      DOCKER_CONTEXT: "remote",
      DOCKER_CONFIG: "/srv/docker-config",
      DOCKER_TLS: "1",
      DOCKER_TLS_VERIFY: "1",
      DOCKER_CERT_PATH: "/srv/tls",
    },
  };
  assert.deepEqual(validateCliRun(literal), literal);

  for (const envKey of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ]) {
    assert.throws(
      () =>
        validateCliRun({
          context: "default",
          argv: ["ps"],
          env: { [envKey]: "override" },
        }),
      /not permitted/u,
      `${envKey} must remain blocked when targetMode is omitted`,
    );
  }

  for (const argv of [
    ["-cRemote", "ps"],
    ["-Htcp://remote.example:2375", "ps"],
    ["--tls=true", "ps"],
    ["--tlsverify=true", "ps"],
  ]) {
    assert.throws(
      () => validateCliRun({ context: "default", argv }),
      /pinned Docker target/u,
      `${argv[0]} must remain blocked in pinned mode`,
    );
    assert.deepEqual(
      validateCliRun({
        context: "default",
        targetMode: "literal",
        argv,
      }).argv,
      argv,
      `${argv[0]} must be preserved in literal mode`,
    );
  }

  for (const envKey of [
    "PATH",
    "HOME",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
  ]) {
    assert.throws(
      () =>
        validateCliRun({
          context: "default",
          targetMode: "literal",
          argv: ["ps"],
          env: { [envKey]: "/tmp/injected" },
        }),
      /not permitted/u,
      `${envKey} must remain blocked in literal mode`,
    );
  }

  assert.throws(
    () =>
      validateCliRun({
        context: "default",
        targetMode: "literal",
        argv: ["/tmp/docker", "ps"],
      }),
    /executable path/u,
  );
  assert.throws(
    () =>
      validateCliRun({
        context: "default",
        targetMode: "arbitrary",
        argv: ["ps"],
      }),
    /request\.targetMode/u,
  );
});

test("normalizes context-pinned capability and container list requests", () => {
  assert.deepEqual(validateSystemCapabilities(), {});
  assert.deepEqual(validateSystemCapabilities({ context: " default " }), {
    context: "default",
  });
  assert.deepEqual(validateContainersList({ context: "default", all: true }), {
    context: "default",
    all: true,
  });
  assert.throws(() => validateContainersList({ all: true }), /request\.context/u);
});

test("event subscriptions are allowlisted", () => {
  assert.equal(validateCoreEventName("operation.started"), "operation.started");
  assert.equal(validateCoreEventName("session.output"), "session.output");
  assert.equal(
    validateCoreEventName("session.output.truncated"),
    "session.output.truncated",
  );
  assert.equal(
    validateCoreEventName("reconciliation.required"),
    "reconciliation.required",
  );
  assert.throws(() => validateCoreEventName("arbitrary.event"), /event must be one of/u);
});

test("core event envelopes are discriminated and payload-validated", () => {
  const output = {
    sessionId: SESSION_ID,
    sequence: 1,
    stream: "stdout",
    data: "ok\n",
    encoding: "utf-8",
    bytes: 3,
  };
  assert.deepEqual(validateCoreEventEnvelope("session.output", output), {
    event: "session.output",
    payload: output,
  });
  assert.throws(
    () =>
      validateCoreEventEnvelope("session.output", {
        ...output,
        bytes: 2,
      }),
    /must match the represented data/u,
  );
  assert.throws(
    () =>
      validateCoreEventEnvelope("session.error", {
        ...output,
        code: "bad",
        message: "bad",
      }),
    /not supported/u,
  );

  const reconciliation = {
    operationId: SESSION_ID,
    context: "default",
    domain: "container",
    resourceId: CONTAINER_ID,
    action: "restart",
    reason: "mutation_completed",
  };
  validateCoreEventEnvelope("reconciliation.requested", reconciliation);
  assert.throws(
    () =>
      validateCoreEventEnvelope("reconciliation.required", reconciliation),
    /reason does not match/u,
  );

  const cliStarted = {
    operationId: SESSION_ID,
    method: "cli.run",
    context: "discovery-profile",
    targetMode: "literal",
    argv: ["--context", "remote", "ps"],
    cwd: "/srv/project",
    startedAt: TIMESTAMP,
  };
  validateCoreEventEnvelope("operation.started", cliStarted);
  assert.throws(
    () => {
      const { targetMode: _targetMode, ...missingTargetMode } = cliStarted;
      validateCoreEventEnvelope("operation.started", missingTargetMode);
    },
    /targetMode/u,
  );

  const cliResult = {
    operationId: SESSION_ID,
    context: "discovery-profile",
    targetMode: "literal",
    executable: "/usr/bin/docker",
    argv: ["--context", "remote", "ps"],
    cwd: "/srv/project",
    exitCode: 0,
    timedOut: false,
    startedAt: TIMESTAMP,
    completedAt: TIMESTAMP,
    durationMs: 1,
    stdout: {
      data: "",
      encoding: "utf-8",
      bytes: 0,
      truncated: false,
    },
    stderr: {
      data: "",
      encoding: "utf-8",
      bytes: 0,
      truncated: false,
    },
  };
  validateCoreEventEnvelope("operation.completed", { result: cliResult });
  assert.throws(
    () => {
      const { targetMode: _targetMode, ...missingTargetMode } = cliResult;
      validateCoreEventEnvelope("operation.completed", {
        result: missingTargetMode,
      });
    },
    /targetMode/u,
  );

  const sessionStarted = {
    sessionId: SESSION_ID,
    mode: "pipes",
    pid: 42,
    context: "discovery-profile",
    targetMode: "literal",
    executable: "/usr/bin/docker",
    argv: ["--context", "remote", "events"],
    cwd: "/srv/project",
    outputWindowBytes: 262_144,
    maxOutputBytes: 0,
    startedAt: TIMESTAMP,
    state: "running",
  };
  validateCoreEventEnvelope("session.started", sessionStarted);
  assert.throws(
    () => {
      const { targetMode: _targetMode, ...missingTargetMode } = sessionStarted;
      validateCoreEventEnvelope("session.started", missingTargetMode);
    },
    /targetMode/u,
  );
});

test("renderer-only event envelopes validate supervisor status and window state", () => {
  validateRendererEventEnvelope("core.status", {
    state: "ready",
    pid: 42,
    health: {
      status: "ok",
      version: "0.1.0",
      protocolVersion: "1",
      pid: 42,
      startedAt: TIMESTAMP,
      dockerReady: true,
    },
  });
  validateRendererEventEnvelope("window.maximized", true);
  assert.throws(
    () => validateRendererEventEnvelope("window.maximized", "yes"),
    /must be a boolean/u,
  );
  assert.throws(
    () => validateRendererEventEnvelope("containers.changed", {}),
    /event must be one of/u,
  );
});

test("native window backgrounds accept only opaque six-digit hexadecimal colors", () => {
  assert.equal(validateWindowBackgroundColor("#00153C"), "#00153c");
  assert.equal(validateWindowBackgroundColor("#ffffff"), "#ffffff");
  for (const value of [
    "#fff",
    "#00153cff",
    "rgb(0 21 60)",
    "transparent",
    "#00153c; color: red",
    "",
    null,
  ]) {
    assert.throws(
      () => validateWindowBackgroundColor(value),
      /opaque six-digit hexadecimal color/u,
    );
  }
});

test("normalizes structured read requests with explicit context and immutable IDs", () => {
  assert.deepEqual(validateSystemSnapshot({ context: " default " }), {
    context: "default",
  });
  assert.deepEqual(
    validateContainerIdentity({ context: "default", id: CONTAINER_ID }),
    { context: "default", id: CONTAINER_ID },
  );
  assert.deepEqual(
    validateImagesList({
      context: "default",
      all: false,
      includeDangling: true,
    }),
    {
      context: "default",
      all: false,
      includeDangling: true,
    },
  );
  assert.throws(
    () =>
      validateImagesList({
        context: "default",
        includeDangling: "yes",
      }),
    /request\.includeDangling must be a boolean/u,
  );
  assert.deepEqual(validateVolumesList({ context: "default" }), {
    context: "default",
  });
  assert.throws(
    () =>
      validateContainerIdentity({
        context: "default",
        id: CONTAINER_ID.slice(0, 12),
      }),
    /full 64-character/u,
  );
});

test("image actions retain only action-specific, confirmed protocol fields", () => {
  assert.deepEqual(
    validateImagesAction({
      context: "default",
      action: "remove",
      id: IMAGE_ID,
      reference: "registry.example/team/api:latest",
      force: true,
      noPrune: true,
      confirmed: true,
    }),
    {
      context: "default",
      action: "remove",
      id: IMAGE_ID,
      reference: "registry.example/team/api:latest",
      force: true,
      noPrune: true,
      confirmed: true,
    },
  );
  assert.deepEqual(
    validateImagesAction({
      context: "default",
      action: "prune",
      filters: { dangling: ["true"], "label!": ["keep"] },
      confirmed: true,
    }),
    {
      context: "default",
      action: "prune",
      filters: { dangling: ["true"], "label!": ["keep"] },
      confirmed: true,
    },
  );
  assert.deepEqual(
    validateImagesAction({
      context: "default",
      action: "pull",
      reference: "registry.example/team/api:latest",
      cwd: "/home/tester/project",
      timeoutSeconds: 900,
      outputWindowBytes: 524_288,
      maxOutputBytes: 0,
    }),
    {
      context: "default",
      action: "pull",
      reference: "registry.example/team/api:latest",
      cwd: "/home/tester/project",
      timeoutSeconds: 900,
      outputWindowBytes: 524_288,
      maxOutputBytes: 0,
    },
  );

  assert.throws(
    () =>
      validateImagesAction({
        context: "default",
        action: "remove",
        id: IMAGE_ID,
        reference: "registry.example/team/api:latest",
      }),
    /confirmed must be true/u,
  );
  // A dangling image has no repo tag. Removal by immutable id alone must be accepted,
  // otherwise every untagged image is structurally unremovable through the UI.
  assert.deepEqual(
    validateImagesAction({
      context: "default",
      action: "remove",
      id: IMAGE_ID,
      confirmed: true,
    }),
    { context: "default", action: "remove", id: IMAGE_ID, confirmed: true },
  );
  assert.throws(
    () =>
      validateImagesAction({
        context: "default",
        action: "remove",
        reference: "registry.example/team/api:latest",
        confirmed: true,
      }),
    /id is required for image remove/u,
  );
  assert.throws(
    () =>
      validateImagesAction({
        context: "default",
        action: "remove",
        reference: "registry.example/team/api:latest",
        confirmed: true,
      }),
    /id is required for image remove/u,
  );
  for (const reference of ["--force", "team/api latest", "team/api\nlatest"]) {
    assert.throws(
      () =>
        validateImagesAction({
          context: "default",
          action: "remove",
          id: IMAGE_ID,
          reference,
          confirmed: true,
        }),
      /single non-option/u,
    );
  }
  assert.throws(
    () =>
      validateImagesAction({
        context: "default",
        action: "pull",
        reference: "--platform",
      }),
    /single non-option/u,
  );
  assert.throws(
    () =>
      validateImagesAction({
        context: "default",
        action: "prune",
        filters: { ancestor: ["api"] },
        confirmed: true,
      }),
    /not permitted/u,
  );
});

test("volume actions enforce names, map bounds, filters, and destructive confirmation", () => {
  assert.deepEqual(
    validateVolumesAction({
      context: "default",
      action: "create",
      name: "project_data",
      driver: "local",
      driverOpts: { type: "tmpfs" },
      labels: { project: "anchorage" },
    }),
    {
      context: "default",
      action: "create",
      name: "project_data",
      driver: "local",
      driverOpts: { type: "tmpfs" },
      labels: { project: "anchorage" },
    },
  );
  assert.deepEqual(
    validateVolumesAction({
      context: "default",
      action: "remove",
      name: "project_data",
      force: true,
      confirmed: true,
    }),
    {
      context: "default",
      action: "remove",
      name: "project_data",
      force: true,
      confirmed: true,
    },
  );
  assert.deepEqual(
    validateVolumesAction({
      context: "default",
      action: "prune",
      filters: { all: ["true"], label: ["temporary"] },
      confirmed: true,
    }),
    {
      context: "default",
      action: "prune",
      filters: { all: ["true"], label: ["temporary"] },
      confirmed: true,
    },
  );

  assert.throws(
    () =>
      validateVolumesAction({
        context: "default",
        action: "remove",
        name: "project_data",
      }),
    /confirmed must be true/u,
  );
  assert.throws(
    () =>
      validateVolumesAction({
        context: "default",
        action: "create",
        name: "-invalid",
      }),
    /unsupported volume-name/u,
  );
  assert.throws(
    () =>
      validateVolumesAction({
        context: "default",
        action: "prune",
        filters: { dangling: ["true"] },
        confirmed: true,
      }),
    /not permitted/u,
  );
});

test("normalizes session start using the exact streaming protocol fields", () => {
  assert.deepEqual(
    validateSessionStart({
      context: "default",
      argv: ["compose", "logs", "--follow", "api"],
      cwd: "/srv/project",
      env: { BUILDKIT_PROGRESS: "plain" },
      mode: "pty",
      rows: 42,
      cols: 120,
      timeoutSeconds: 86_400,
      outputWindowBytes: 262_144,
      maxOutputBytes: 1_099_511_627_776,
    }),
    {
      context: "default",
      targetMode: "pinned",
      argv: ["compose", "logs", "--follow", "api"],
      cwd: "/srv/project",
      env: { BUILDKIT_PROGRESS: "plain" },
      mode: "pty",
      rows: 42,
      cols: 120,
      timeoutSeconds: 86_400,
      outputWindowBytes: 262_144,
      maxOutputBytes: 1_099_511_627_776,
    },
  );

  assert.throws(
    () =>
      validateSessionStart({
        context: "default",
        argv: ["--context", "remote", "ps"],
        mode: "pipes",
      }),
    /pinned Docker target/u,
  );
  assert.throws(
    () =>
      validateSessionStart({
        context: "default",
        argv: ["ps"],
        mode: "terminal",
      }),
    /request\.mode/u,
  );

  const literal = {
    context: "discovery-profile",
    targetMode: "literal",
    argv: ["--context=remote", "--tlsverify", "compose", "logs", "--follow"],
    env: {
      DOCKER_HOST: "tcp://remote.example:2376",
      DOCKER_CERT_PATH: "/srv/tls",
    },
    mode: "pipes",
  };
  assert.deepEqual(validateSessionStart(literal), literal);
  assert.throws(
    () =>
      validateSessionStart({
        ...literal,
        env: { PATH: "/tmp/injected" },
      }),
    /not permitted/u,
  );
  assert.throws(
    () =>
      validateSessionStart({
        ...literal,
        argv: ["docker", "ps"],
      }),
    /executable path/u,
  );
});

test("validates bounded session input and every session control request", () => {
  assert.deepEqual(
    validateSessionInput({
      sessionId: SESSION_ID,
      data: "hello 🌊\n",
      encoding: "utf-8",
    }),
    {
      sessionId: SESSION_ID,
      data: "hello 🌊\n",
      encoding: "utf-8",
    },
  );
  assert.deepEqual(
    validateSessionInput({
      sessionId: SESSION_ID,
      data: "AA==",
      encoding: "base64",
      eof: true,
    }),
    {
      sessionId: SESSION_ID,
      data: "AA==",
      encoding: "base64",
      eof: true,
    },
  );
  assert.deepEqual(validateSessionInput({ sessionId: SESSION_ID, eof: true }), {
    sessionId: SESSION_ID,
    eof: true,
  });
  assert.deepEqual(
    validateSessionResize({ sessionId: SESSION_ID, rows: 24, cols: 80 }),
    { sessionId: SESSION_ID, rows: 24, cols: 80 },
  );
  assert.deepEqual(
    validateSessionSignal({ sessionId: SESSION_ID, signal: "interrupt" }),
    { sessionId: SESSION_ID, signal: "interrupt" },
  );
  assert.deepEqual(
    validateSessionCancel({ sessionId: SESSION_ID, gracePeriodMs: 0 }),
    { sessionId: SESSION_ID, gracePeriodMs: 0 },
  );
  assert.deepEqual(
    validateSessionAck({ sessionId: SESSION_ID, throughSequence: 9 }),
    { sessionId: SESSION_ID, throughSequence: 9 },
  );

  assert.throws(
    () => validateSessionInput({ sessionId: SESSION_ID }),
    /non-empty data or request EOF/u,
  );
  assert.throws(
    () =>
      validateSessionInput({
        sessionId: SESSION_ID,
        data: "not base64",
        encoding: "base64",
      }),
    /valid base64/u,
  );
  assert.throws(
    () =>
      validateSessionInput({
        sessionId: SESSION_ID,
        data: "a".repeat(262_145),
      }),
    /at most 262144 bytes/u,
  );
  assert.throws(
    () => validateSessionAck({ sessionId: SESSION_ID, throughSequence: -1 }),
    /between 0/u,
  );
  assert.throws(
    () =>
      validateSessionCancel({
        sessionId: SESSION_ID.toUpperCase(),
      }),
    /lowercase UUID/u,
  );
});
