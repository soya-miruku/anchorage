import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { RENDERER_RPC_METHODS } from "./contracts.mjs";

const preloadSource = await readFile(new URL("./preload.cjs", import.meta.url), "utf8");
const SESSION_ID = "01234567-89ab-cdef-0123-456789abcdef";
const CONTAINER_ID = "0123456789abcdef".repeat(4);
const IMAGE_ID = `sha256:${CONTAINER_ID}`;

function plain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function loadPreload({ invoke } = {}) {
  const ipcRenderer = new EventEmitter();
  const invocations = [];
  ipcRenderer.invoke = async (channel, payload) => {
    invocations.push({ channel, payload: plain(payload) });
    if (invoke) {
      return invoke(channel, payload);
    }
    return { ok: true, value: { channel, payload } };
  };

  let api;
  const contextBridge = {
    exposeInMainWorld(name, value) {
      assert.equal(name, "anchorage");
      api = value;
    },
  };
  const sandbox = {
    TextEncoder,
    require(specifier) {
      assert.equal(specifier, "electron");
      return { contextBridge, ipcRenderer };
    },
  };
  vm.runInNewContext(preloadSource, sandbox, {
    filename: "electron/preload.cjs",
  });
  return { api, ipcRenderer, invocations };
}

test("preload exposes every session method through dedicated allowlisted channels", async () => {
  const { api, invocations } = loadPreload();
  const requests = [
    [
      "anchorage:session.start",
      () =>
        api.session.start({
          context: "default",
          argv: ["compose", "logs", "--follow", "api"],
          mode: "pty",
          rows: 24,
          cols: 80,
          outputWindowBytes: 262_144,
        }),
    ],
    [
      "anchorage:session.input",
      () =>
        api.session.input({
          sessionId: SESSION_ID,
          data: "help\n",
          encoding: "utf-8",
        }),
    ],
    [
      "anchorage:session.resize",
      () => api.session.resize({ sessionId: SESSION_ID, rows: 42, cols: 120 }),
    ],
    [
      "anchorage:session.signal",
      () => api.session.signal({ sessionId: SESSION_ID, signal: "interrupt" }),
    ],
    [
      "anchorage:session.cancel",
      () => api.session.cancel({ sessionId: SESSION_ID, gracePeriodMs: 1_000 }),
    ],
    [
      "anchorage:session.ack",
      () => api.session.ack({ sessionId: SESSION_ID, throughSequence: 12 }),
    ],
  ];

  for (const [channel, invokeMethod] of requests) {
    const result = await invokeMethod();
    assert.equal(result.channel, channel);
  }
  assert.deepEqual(
    invocations.map((item) => item.channel),
    requests.map(([channel]) => channel),
  );

  await api.invoke("session.ack", {
    sessionId: SESSION_ID,
    throughSequence: 13,
  });
  assert.equal(invocations.at(-1).channel, "anchorage:session.ack");
  assert.throws(() => api.invoke("rpc.arbitrary", {}), /not supported/u);
});

test("preload defaults Docker execution to pinned and forwards literal target selection exactly", async () => {
  const { api, invocations } = loadPreload();

  await api.cli.run({ context: "default", argv: ["ps"] });
  assert.deepEqual(invocations.at(-1), {
    channel: "anchorage:cli.run",
    payload: {
      context: "default",
      targetMode: "pinned",
      argv: ["ps"],
    },
  });

  const literal = {
    context: "discovery-profile",
    targetMode: "literal",
    argv: ["--context", "remote", "--tlsverify", "compose", "ps"],
    env: {
      DOCKER_HOST: "tcp://remote.example:2376",
      DOCKER_CONFIG: "/srv/docker-config",
      DOCKER_TLS: "1",
    },
    mode: "pipes",
  };
  await api.session.start(literal);
  assert.deepEqual(invocations.at(-1), {
    channel: "anchorage:session.start",
    payload: literal,
  });

  assert.throws(
    () =>
      api.cli.run({
        context: "default",
        argv: ["ps"],
        env: { DOCKER_HOST: "tcp://remote.example:2375" },
      }),
    /not permitted/u,
  );
  for (const argv of [
    ["-cRemote", "ps"],
    ["-Htcp://remote.example:2375", "ps"],
    ["--tls=true", "ps"],
    ["--tlsverify=true", "ps"],
  ]) {
    assert.throws(
      () => api.cli.run({ context: "default", argv }),
      /pinned Docker target/u,
    );
  }
  assert.throws(
    () =>
      api.cli.run({
        context: "default",
        targetMode: "literal",
        argv: ["ps"],
        env: { PATH: "/tmp/injected" },
      }),
    /not permitted/u,
  );
  assert.throws(
    () =>
      api.session.start({
        context: "default",
        targetMode: "literal",
        argv: ["docker", "ps"],
        mode: "pipes",
      }),
    /start with a Docker command/u,
  );
});

test("preload exposes structured domain RPC through dedicated allowlisted channels", async () => {
  const { api, invocations } = loadPreload();
  const requests = [
    [
      "anchorage:system.snapshot",
      () => api.system.snapshot({ context: "default" }),
    ],
    [
      "anchorage:containers.inspect",
      () => api.containers.inspect({ context: "default", id: CONTAINER_ID }),
    ],
    [
      "anchorage:containers.stats",
      () => api.containers.stats({ context: "default", id: CONTAINER_ID }),
    ],
    [
      "anchorage:images.list",
      () =>
        api.images.list({
          context: "default",
          all: false,
          includeDangling: true,
        }),
    ],
    [
      "anchorage:images.action",
      () =>
        api.images.action({
          context: "default",
          action: "pull",
          reference: "registry.example/team/api:latest",
          cwd: "/home/tester/project",
        }),
    ],
    [
      "anchorage:images.action",
      () =>
        api.images.action({
          context: "default",
          action: "remove",
          id: IMAGE_ID,
          reference: "registry.example/team/api:latest",
          confirmed: true,
        }),
    ],
    [
      "anchorage:volumes.list",
      () => api.volumes.list({ context: "default" }),
    ],
    [
      "anchorage:volumes.action",
      () =>
        api.volumes.action({
          context: "default",
          action: "create",
          name: "project_data",
        }),
    ],
  ];

  for (const [channel, invokeMethod] of requests) {
    const result = await invokeMethod();
    assert.equal(result.channel, channel);
  }
  assert.deepEqual(invocations[3], {
    channel: "anchorage:images.list",
    payload: {
      context: "default",
      all: false,
      includeDangling: true,
    },
  });
  assert.deepEqual(invocations[5], {
    channel: "anchorage:images.action",
    payload: {
      context: "default",
      action: "remove",
      id: IMAGE_ID,
      reference: "registry.example/team/api:latest",
      confirmed: true,
    },
  });
  assert.deepEqual(
    invocations.map((item) => item.channel),
    requests.map(([channel]) => channel),
  );

  await api.invoke("images.list", { context: "default" });
  assert.equal(invocations.at(-1).channel, "anchorage:images.list");
});

test("preload exposes stateful window chrome through dedicated validated channels", async () => {
  const { api, invocations, ipcRenderer } = loadPreload();

  await api.window.minimize();
  await api.window.maximize();
  await api.window.close();
  await api.window.isMaximized();
  await api.window.setBackgroundColor("#00153C");

  assert.deepEqual(invocations, [
    { channel: "anchorage:window.minimize", payload: undefined },
    { channel: "anchorage:window.maximize", payload: undefined },
    { channel: "anchorage:window.close", payload: undefined },
    { channel: "anchorage:window.isMaximized", payload: undefined },
    {
      channel: "anchorage:window.setBackgroundColor",
      payload: "#00153c",
    },
  ]);

  const maximized = [];
  const unsubscribe = api.subscribe("window.maximized", (value) => {
    maximized.push(value);
  });
  ipcRenderer.emit(
    "anchorage:event",
    { sender: ipcRenderer },
    "window.maximized",
    true,
  );
  assert.deepEqual(maximized, [true]);
  unsubscribe();
});

test("preload rejects non-opaque native window backgrounds before IPC", () => {
  const { api, invocations } = loadPreload();

  for (const color of [
    "#fff",
    "#00153cff",
    "rgb(0 21 60)",
    "transparent",
    "#00153c; color: red",
  ]) {
    assert.throws(
      () => api.window.setBackgroundColor(color),
      /opaque six-digit hexadecimal color/u,
    );
  }
  assert.equal(invocations.length, 0);
});

test("generic invoke is exhaustive for protocol methods without exposing arbitrary IPC", async () => {
  const { api, invocations } = loadPreload();
  const samples = {
    "system.capabilities": { context: "default" },
    "system.snapshot": { context: "default" },
    "system.action": {
      context: "default",
      action: "prune",
      confirmed: true,
    },
    "containers.list": { context: "default", all: true },
    "containers.inspect": { context: "default", id: CONTAINER_ID },
    "containers.stats": { context: "default", id: CONTAINER_ID },
    "containers.statsBatch": { context: "default", ids: [CONTAINER_ID] },
    "containers.files": { context: "default", id: CONTAINER_ID, path: "/etc" },
    "containers.fileRead": { context: "default", id: CONTAINER_ID, path: "/etc/hosts" },
    "containers.fileWrite": {
      context: "default",
      id: CONTAINER_ID,
      path: "/tmp",
      name: "note.txt",
      content: "aGVsbG8=",
    },
    "containers.top": { context: "default", id: CONTAINER_ID },
    "containers.diff": { context: "default", id: CONTAINER_ID },
    "containers.action": {
      context: "default",
      id: CONTAINER_ID,
      action: "start",
    },
    "containers.create": { context: "default", image: "nginx:1.27" },
    "containers.export": {
      context: "default",
      id: CONTAINER_ID,
      archivePath: "/home/operator/api-filesystem.tar",
    },
    "images.scout": {
      context: "default",
      reference: "registry.example/team/api:latest",
    },
    "volumes.files": { context: "default", name: "project_data", path: "/" },
    "volumes.fileWrite": {
      context: "default",
      name: "project_data",
      path: "/config",
      fileName: "app.json",
      content: "aGVsbG8=",
    },
    "volumes.fileRead": {
      context: "default",
      name: "project_data",
      path: "/config.json",
    },
    "compose.list": { context: "default", all: true },
    "compose.ps": { context: "default", project: "storefront" },
    "compose.action": {
      context: "default",
      project: "storefront",
      action: "restart",
    },
    "images.list": { context: "default", all: true },
    "images.action": {
      context: "default",
      action: "pull",
      reference: "registry.example/team/api:latest",
    },
    "networks.list": { context: "default" },
    "networks.action": {
      context: "default",
      action: "prune",
      confirmed: true,
    },
    "images.inspect": { context: "default", id: IMAGE_ID },
    "images.search": { context: "default", term: "nginx" },
    "containers.commit": {
      context: "default",
      id: CONTAINER_ID,
      repository: "team/api",
    },
    "volumes.list": { context: "default" },
    "volumes.action": {
      context: "default",
      action: "create",
      name: "project_data",
    },
    "cli.run": { context: "default", argv: ["ps"] },
    "session.start": {
      context: "default",
      argv: ["compose", "logs", "--follow"],
      mode: "pipes",
    },
    "session.input": { sessionId: SESSION_ID, data: "q" },
    "session.resize": { sessionId: SESSION_ID, rows: 24, cols: 80 },
    "session.signal": { sessionId: SESSION_ID, signal: "interrupt" },
    "session.cancel": { sessionId: SESSION_ID },
    "session.ack": { sessionId: SESSION_ID, throughSequence: 1 },
  };
  assert.deepEqual(Object.keys(samples).sort(), [...RENDERER_RPC_METHODS].sort());

  for (const [method, params] of Object.entries(samples)) {
    await api.invoke(method, params);
  }
  assert.equal(invocations.length, RENDERER_RPC_METHODS.length);
  assert.throws(() => api.invoke("health", {}), /not supported/u);
  assert.throws(() => api.invoke("filesystem.read", {}), /not supported/u);
});

test("preload rejects unsafe session requests before invoking main", () => {
  const { api, invocations } = loadPreload();

  assert.throws(
    () =>
      api.session.start({
        context: "default",
        argv: ["--host", "tcp://remote:2375", "ps"],
        mode: "pipes",
      }),
    /pinned Docker target/u,
  );
  assert.throws(
    () =>
      api.session.input({
        sessionId: SESSION_ID,
        data: "not base64",
        encoding: "base64",
      }),
    /valid base64/u,
  );
  assert.throws(
    () =>
      api.session.input({
        sessionId: SESSION_ID,
        data: "a".repeat(262_145),
      }),
    /at most 262144 bytes/u,
  );
  assert.throws(
    () =>
      api.session.signal({
        sessionId: SESSION_ID,
        signal: "SIGUSR1",
      }),
    /request\.signal/u,
  );
  assert.throws(
    () =>
      api.session.ack({
        sessionId: SESSION_ID.toUpperCase(),
        throughSequence: 1,
      }),
    /lowercase UUID/u,
  );
  assert.throws(
    () =>
      api.images.action({
        context: "default",
        action: "remove",
        id: IMAGE_ID,
        reference: "registry.example/team/api:latest",
      }),
    /confirmed must be true/u,
  );
  assert.throws(
    () =>
      api.images.action({
        context: "default",
        action: "remove",
        reference: "registry.example/team/api:latest",
        confirmed: true,
      }),
    /id is required for image remove/u,
  );
  assert.throws(
    () =>
      api.images.action({
        context: "default",
        action: "remove",
        reference: "registry.example/team/api:latest",
        confirmed: true,
      }),
    /id is required for image remove/u,
  );
  assert.throws(
    () =>
      api.images.action({
        context: "default",
        action: "remove",
        id: IMAGE_ID,
        reference: "--force",
        confirmed: true,
      }),
    /single non-option/u,
  );
  assert.throws(
    () =>
      api.containers.action({
        context: "default",
        id: CONTAINER_ID,
        action: "remove",
        options: {
          timeoutSeconds: 0,
          confirmed: true,
        },
      }),
    /timeoutSeconds is not valid for remove/u,
  );
  assert.throws(
    () =>
      api.volumes.action({
        context: "default",
        action: "prune",
        filters: { dangling: ["true"] },
        confirmed: true,
      }),
    /not permitted/u,
  );
  assert.equal(invocations.length, 0);

  // Removal by immutable id with no reference is the dangling-image path. It is valid, so it
  // is the one image request in this test that must reach main.
  api.images.action({
    context: "default",
    action: "remove",
    id: IMAGE_ID,
    confirmed: true,
  });
  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0].payload, {
    context: "default",
    action: "remove",
    id: IMAGE_ID,
    confirmed: true,
  });
});

test("session event subscriptions pass payload only and clean up their exact listener", () => {
  const { api, ipcRenderer } = loadPreload();
  const observed = [];
  const unsubscribe = api.subscribe("session.output", (...args) => {
    observed.push(args);
  });

  const dangerousElectronEvent = { sender: ipcRenderer };
  const payload = {
    sessionId: SESSION_ID,
    sequence: 1,
    stream: "stdout",
    data: "ready\n",
    encoding: "utf-8",
    bytes: 6,
  };
  ipcRenderer.emit(
    "anchorage:event",
    dangerousElectronEvent,
    "session.output",
    payload,
  );

  assert.equal(observed.length, 1);
  assert.equal(observed[0].length, 1);
  assert.equal(observed[0][0], payload);
  assert.equal(ipcRenderer.listenerCount("anchorage:event"), 1);

  unsubscribe();
  assert.equal(ipcRenderer.listenerCount("anchorage:event"), 0);
  ipcRenderer.emit(
    "anchorage:event",
    dangerousElectronEvent,
    "session.output",
    payload,
  );
  assert.equal(observed.length, 1);

  for (const event of [
    "session.started",
    "session.output",
    "session.output.truncated",
    "session.error",
    "session.exited",
    "reconciliation.requested",
    "reconciliation.required",
  ]) {
    const remove = api.subscribe(event, () => {});
    assert.equal(typeof remove, "function");
    remove();
  }
  assert.throws(
    () => api.subscribe("session.secret", () => {}),
    /event is not supported/u,
  );
});

test("preload preserves structured desktop errors and rejects malformed responses", async () => {
  const expectedDetails = { sessionId: SESSION_ID, state: "exited" };
  const failing = loadPreload({
    invoke: async () => ({
      ok: false,
      error: {
        code: "session_closed",
        message: "Session process has exited.",
        details: expectedDetails,
      },
    }),
  });

  await assert.rejects(
    failing.api.session.cancel({ sessionId: SESSION_ID }),
    (error) => {
      assert.equal(error.name, "AnchorageError");
      assert.equal(error.code, "session_closed");
      assert.equal(error.message, "Session process has exited.");
      assert.deepEqual(plain(error.details), expectedDetails);
      return true;
    },
  );

  const malformed = loadPreload({
    invoke: async () => ({ value: "missing ok discriminator" }),
  });
  await assert.rejects(
    malformed.api.session.ack({
      sessionId: SESSION_ID,
      throughSequence: 0,
    }),
    (error) => {
      assert.equal(error.code, "INVALID_DESKTOP_RESPONSE");
      return true;
    },
  );
});
