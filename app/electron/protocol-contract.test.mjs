import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CORE_EVENTS,
  RENDERER_RPC_METHODS,
  validateCliRun,
  validateContainerAction,
  validateContainerIdentity,
  validateContainersList,
  validateCoreEventEnvelope,
  validateImagesAction,
  validateImagesList,
  validateSessionAck,
  validateSessionCancel,
  validateSessionInput,
  validateSessionResize,
  validateSessionSignal,
  validateSessionStart,
  validateSystemCapabilities,
  validateSystemContexts,
  validateContainersCreate,
  validateContainersRebindPorts,
  validateContainersExport,
  validateImagesScout,
  validateVolumeFiles,
  validateVolumeFileRead,
  validateVolumeFileWrite,
  validateBuildsList,
  validateBuildsInspect,
  validateBuildsBuilderAction,
  validateSystemPluginAction,
  validateVolumeBackup,
  validateVolumeRestore,
  validateComposeList,
  validateComposePs,
  validateComposeAction,
  validateContainerFileRead,
  validateContainerFileWrite,
  validateContainerFiles,
  validateContainersStatsBatch,
  validateContainersCommit,
  validateImagesInspect,
  validateImagesSearch,
  validateNetworksAction,
  validateNetworksList,
  validateSecretsList,
  validateSystemAction,
  validateSystemSnapshot,
  validateVolumesAction,
  validateVolumesList,
} from "./contracts.mjs";

const protocolUrl = new URL("../../protocol/v1.schema.json", import.meta.url);
const protocol = JSON.parse(await readFile(protocolUrl, "utf8"));

function collectMethodConstants(inputSchema, methods = new Set()) {
  const schema = resolveSchema(inputSchema);
  if (!schema || schema === true || schema === false) {
    return methods;
  }
  if (typeof schema.properties?.method?.const === "string") {
    methods.add(schema.properties.method.const);
  }
  for (const keyword of ["oneOf", "anyOf", "allOf"]) {
    for (const candidate of schema[keyword] ?? []) {
      collectMethodConstants(candidate, methods);
    }
  }
  return methods;
}

function collectEventConstants(inputSchema, events = new Set()) {
  const schema = resolveSchema(inputSchema);
  if (!schema || schema === true || schema === false) {
    return events;
  }
  if (typeof schema.properties?.event?.const === "string") {
    events.add(schema.properties.event.const);
  }
  for (const keyword of ["oneOf", "anyOf", "allOf"]) {
    for (const candidate of schema[keyword] ?? []) {
      collectEventConstants(candidate, events);
    }
  }
  return events;
}

function resolveSchema(schema) {
  if (!schema?.$ref) {
    return schema;
  }
  const path = schema.$ref.replace(/^#\//u, "").split("/");
  return path.reduce((value, key) => value[key], protocol);
}

function schemaMatches(inputSchema, value) {
  const schema = resolveSchema(inputSchema);
  if (schema === true) {
    return true;
  }
  if (schema === false || !schema) {
    return false;
  }
  if (
    schema.oneOf &&
    schema.oneOf.filter((candidate) => schemaMatches(candidate, value)).length !==
      1
  ) {
    return false;
  }
  if (schema.allOf && !schema.allOf.every((candidate) => schemaMatches(candidate, value))) {
    return false;
  }
  if (schema.if) {
    const conditionMatches = schemaMatches(schema.if, value);
    if (
      conditionMatches &&
      schema.then &&
      !schemaMatches(schema.then, value)
    ) {
      return false;
    }
    if (
      !conditionMatches &&
      schema.else &&
      !schemaMatches(schema.else, value)
    ) {
      return false;
    }
  }
  // `not` is used by the volume-path definitions to forbid traversal segments. Without this
  // branch the matcher silently ignores the keyword, and a schema constraint that exists only
  // in the file would read as tested.
  if (schema.not && schemaMatches(schema.not, value)) {
    return false;
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    return false;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return false;
  }

  if (schema.type === "null") {
    return value === null;
  }
  if (schema.type === "boolean") {
    return typeof value === "boolean";
  }
  if (schema.type === "integer") {
    return (
      Number.isInteger(value) &&
      (schema.minimum === undefined || value >= schema.minimum) &&
      (schema.maximum === undefined || value <= schema.maximum)
    );
  }
  // String constraints are applied whenever they are present, not only when an explicit
  // `type: "string"` accompanies them. A bare `{ "pattern": ... }` is what appears inside
  // `not`, and treating it as an unconstrained schema made the negation always true — which
  // silently rejected every valid path rather than the traversal it was meant to forbid.
  const hasStringConstraint =
    schema.minLength !== undefined ||
    schema.maxLength !== undefined ||
    schema.pattern !== undefined;
  if (schema.type === "string" || (hasStringConstraint && !schema.type)) {
    if (schema.type === "string" && typeof value !== "string") {
      return false;
    }
    if (typeof value !== "string") {
      return true;
    }
    return (
      (schema.minLength === undefined || value.length >= schema.minLength) &&
      (schema.maxLength === undefined || value.length <= schema.maxLength) &&
      (schema.pattern === undefined || new RegExp(schema.pattern, "u").test(value))
    );
  }
  if (schema.type === "array") {
    return (
      Array.isArray(value) &&
      (schema.minItems === undefined || value.length >= schema.minItems) &&
      (schema.maxItems === undefined || value.length <= schema.maxItems) &&
      value.every((item) => schemaMatches(schema.items, item))
    );
  }
  if (
    schema.type === "object" ||
    schema.properties ||
    schema.required ||
    schema.propertyNames ||
    Object.hasOwn(schema, "additionalProperties") ||
    schema.maxProperties !== undefined
  ) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const keys = Object.keys(value);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      return false;
    }
    if ((schema.required ?? []).some((key) => !Object.hasOwn(value, key))) {
      return false;
    }
    for (const key of keys) {
      if (Object.hasOwn(schema.properties ?? {}, key)) {
        if (!schemaMatches(schema.properties[key], value[key])) {
          return false;
        }
        continue;
      }
      if (schema.propertyNames && !schemaMatches(schema.propertyNames, key)) {
        return false;
      }
      if (schema.additionalProperties === false) {
        return false;
      }
      if (
        schema.additionalProperties &&
        schema.additionalProperties !== true &&
        !schemaMatches(schema.additionalProperties, value[key])
      ) {
        return false;
      }
    }
  }
  return true;
}

function request(method, params) {
  return { id: `contract-${method}`, method, params };
}

test("Electron renderer RPC allowlist stays exhaustive against protocol v1", () => {
  const protocolMethods = [...collectMethodConstants(protocol.$defs.request)].sort();
  assert.deepEqual(
    protocolMethods,
    ["health", ...RENDERER_RPC_METHODS].sort(),
  );
});

test("Electron core-event allowlist stays exhaustive against protocol v1", () => {
  assert.deepEqual(
    [...collectEventConstants(protocol.$defs.event)].sort(),
    [...CORE_EVENTS].sort(),
  );
});

test("Electron validators produce requests accepted by protocol v1 schema", () => {
  const id = "0123456789abcdef".repeat(4);
  const sessionId = "01234567-89ab-cdef-0123-456789abcdef";
  const requests = [
    request("system.capabilities", validateSystemCapabilities({ context: "default" })),
    request("system.contexts", validateSystemContexts({ context: "default" })),
    request("system.snapshot", validateSystemSnapshot({ context: "default" })),
    request(
      "containers.create",
      validateContainersCreate({
        context: "default",
        image: "nginx:1.27",
        name: "web",
        ports: { "8080": "80/tcp" },
        env: ["TZ=Europe/London"],
        restartPolicy: "unless-stopped",
        start: true,
      }),
    ),
    request(
      "containers.rebindPorts",
      validateContainersRebindPorts({
        context: "default",
        id,
        ports: { "8080": "80/tcp" },
        confirmed: true,
      }),
    ),
    request(
      "containers.statsBatch",
      validateContainersStatsBatch({ context: "default", ids: [id] }),
    ),
    request(
      "images.inspect",
      validateImagesInspect({ context: "default", id: `sha256:${id}` }),
    ),
    request(
      "containers.files",
      validateContainerFiles({ context: "default", id, path: "/etc" }),
    ),
    request(
      "containers.fileRead",
      validateContainerFileRead({ context: "default", id, path: "/etc/hosts" }),
    ),
    request(
      "containers.fileWrite",
      validateContainerFileWrite({
        context: "default",
        id,
        path: "/tmp",
        name: "note.txt",
        content: "aGVsbG8=",
      }),
    ),
    request("containers.top", validateContainerIdentity({ context: "default", id })),
    request("containers.diff", validateContainerIdentity({ context: "default", id })),
    request(
      "images.search",
      validateImagesSearch({ context: "default", term: "nginx", limit: 10 }),
    ),
    request(
      "containers.commit",
      validateContainersCommit({
        context: "default",
        id,
        repository: "team/api",
        tag: "snapshot",
        pause: true,
      }),
    ),
    request("networks.list", validateNetworksList({ context: "default" })),
    request("secrets.list", validateSecretsList({ context: "default" })),
    request(
      "networks.action",
      validateNetworksAction({
        context: "default",
        action: "create",
        name: "app-net",
        driver: "bridge",
        subnet: "172.20.0.0/16",
      }),
    ),
    request(
      "networks.action",
      validateNetworksAction({
        context: "default",
        action: "connect",
        id: "abcdef012345",
        containerId: "0123456789abcdef".repeat(4),
      }),
    ),
    request(
      "system.action",
      validateSystemAction({
        context: "default",
        action: "prune",
        all: true,
        volumes: true,
        confirmed: true,
      }),
    ),
    request("containers.list", validateContainersList({ context: "default", all: true })),
    request(
      "containers.inspect",
      validateContainerIdentity({ context: "default", id }),
    ),
    request(
      "containers.stats",
      validateContainerIdentity({ context: "default", id }),
    ),
    request(
      "containers.action",
      validateContainerAction({
        context: "default",
        id,
        action: "stop",
        options: { timeoutSeconds: 10 },
      }),
    ),
    request(
      "containers.action",
      validateContainerAction({
        context: "default",
        id,
        action: "remove",
        options: { force: true, volumes: true, confirmed: true },
      }),
    ),
    request(
      "images.list",
      validateImagesList({
        context: "default",
        all: false,
        includeDangling: true,
      }),
    ),
    request(
      "images.action",
      validateImagesAction({
        context: "default",
        action: "remove",
        id: `sha256:${id}`,
        reference: "registry.example/team/api:latest",
        force: true,
        confirmed: true,
      }),
    ),
    request(
      "images.action",
      validateImagesAction({
        context: "default",
        action: "prune",
        filters: { dangling: ["true"], label: ["temporary"] },
        confirmed: true,
      }),
    ),
    request(
      "images.action",
      validateImagesAction({
        context: "default",
        action: "pull",
        reference: "registry.example/team/api:latest",
        cwd: "/srv/project",
        timeoutSeconds: 300,
        outputWindowBytes: 262_144,
        maxOutputBytes: 0,
      }),
    ),
    request(
      "images.action",
      validateImagesAction({
        context: "default",
        action: "save",
        reference: "registry.example/team/api:latest",
        archivePath: "/srv/project/api.tar",
        timeoutSeconds: 1_800,
        overwrite: true,
      }),
    ),
    request(
      "images.action",
      validateImagesAction({
        context: "default",
        action: "load",
        archivePath: "/srv/project/api.tar",
      }),
    ),
    request(
      "images.action",
      validateImagesAction({
        context: "default",
        action: "push",
        reference: "registry.example/team/api:latest",
        confirmed: true,
      }),
    ),
    request(
      "images.action",
      validateImagesAction({
        context: "default",
        action: "tag",
        id: `sha256:${id}`,
        reference: "registry.example/team/api:release",
      }),
    ),
    request(
      "images.scout",
      validateImagesScout({
        context: "default",
        reference: "registry.example/team/api:latest",
      }),
    ),
    request(
      "volumes.files",
      validateVolumeFiles({ context: "default", name: "project_data", path: "/config" }),
    ),
    request("builds.list", validateBuildsList({ context: "default" })),
    request(
      "builds.inspect",
      validateBuildsInspect({
        context: "default",
        ref: "desktop-linux/node_1/00b5zi7celyy89egnd8922ps1",
      }),
    ),
    request(
      "volumes.backup",
      validateVolumeBackup({
        context: "default",
        name: "project_data",
        archivePath: "/srv/backups/project_data.tar",
        overwrite: true,
      }),
    ),
    request(
      "volumes.restore",
      validateVolumeRestore({
        context: "default",
        name: "project_data",
        archivePath: "/srv/backups/project_data.tar",
        confirmed: true,
        confirmedInUse: true,
      }),
    ),
    request(
      "volumes.fileWrite",
      validateVolumeFileWrite({
        context: "default",
        name: "project_data",
        path: "/config",
        fileName: "app.json",
        content: "aGVsbG8=",
        confirmedInUse: true,
      }),
    ),
    request(
      "volumes.fileRead",
      validateVolumeFileRead({
        context: "default",
        name: "project_data",
        path: "/config/app.json",
      }),
    ),
    request("compose.list", validateComposeList({ context: "default", all: true })),
    request(
      "compose.ps",
      validateComposePs({ context: "default", project: "storefront" }),
    ),
    request(
      "compose.action",
      validateComposeAction({
        context: "default",
        project: "storefront",
        action: "up",
        configFiles: ["/srv/storefront/compose.yaml", "/srv/storefront/override.yaml"],
        removeOrphans: true,
      }),
    ),
    request(
      "compose.action",
      validateComposeAction({
        context: "default",
        project: "storefront",
        action: "down",
        confirmed: true,
        removeVolumes: true,
        confirmedRemoveVolumes: true,
      }),
    ),
    request(
      "compose.action",
      validateComposeAction({ context: "default", project: "storefront", action: "restart" }),
    ),
    request(
      "containers.export",
      validateContainersExport({
        context: "default",
        id,
        archivePath: "/srv/project/api-filesystem.tar",
        cwd: "/srv/project",
        outputWindowBytes: 262_144,
      }),
    ),
    request("volumes.list", validateVolumesList({ context: "default" })),
    request(
      "volumes.action",
      validateVolumesAction({
        context: "default",
        action: "create",
        name: "project_data",
        driver: "local",
        labels: { project: "anchorage" },
      }),
    ),
    request(
      "volumes.action",
      validateVolumesAction({
        context: "default",
        action: "prune",
        filters: { all: ["true"] },
        confirmed: true,
      }),
    ),
    request(
      "cli.run",
      validateCliRun({
        context: "default",
        argv: ["compose", "ps", "--all"],
        cwd: "/srv/project",
        env: { BUILDKIT_PROGRESS: "plain" },
        timeoutSeconds: 120,
        interactive: false,
        streaming: false,
      }),
    ),
    request(
      "session.start",
      validateSessionStart({
        context: "default",
        argv: ["compose", "logs", "--follow", "api"],
        cwd: "/srv/project",
        env: { BUILDKIT_PROGRESS: "plain" },
        mode: "pty",
        rows: 24,
        cols: 80,
        timeoutSeconds: 300,
        outputWindowBytes: 262_144,
        maxOutputBytes: 0,
      }),
    ),
    request(
      "session.input",
      validateSessionInput({
        sessionId,
        data: "help\n",
        encoding: "utf-8",
      }),
    ),
    request(
      "session.resize",
      validateSessionResize({ sessionId, rows: 32, cols: 120 }),
    ),
    request(
      "session.signal",
      validateSessionSignal({ sessionId, signal: "interrupt" }),
    ),
    request(
      "session.cancel",
      validateSessionCancel({ sessionId, gracePeriodMs: 2_000 }),
    ),
    request(
      "session.ack",
      validateSessionAck({ sessionId, throughSequence: 7 }),
    ),
  ];

  for (const envelope of requests) {
    assert.equal(
      schemaMatches(protocol, envelope),
      true,
      `${envelope.method} does not match protocol/v1.schema.json`,
    );
  }
});

test("protocol v1 keeps context pins and immutable IDs mandatory", () => {
  assert.equal(
    schemaMatches(protocol, request("containers.list", { all: true })),
    false,
  );
  assert.equal(
    schemaMatches(
      protocol,
      request("containers.action", {
        context: "default",
        id: "0123456789ab",
        action: "stop",
      }),
    ),
    false,
  );
  assert.equal(
    schemaMatches(
      protocol,
      request("containers.action", {
        context: "default",
        id: "0123456789abcdef".repeat(4),
        action: "remove",
        options: { force: true },
      }),
    ),
    false,
  );
  assert.equal(
    schemaMatches(
      protocol,
      request("containers.action", {
        context: "default",
        id: "0123456789abcdef".repeat(4),
        action: "remove",
        options: { timeoutSeconds: 0, confirmed: true },
      }),
    ),
    false,
  );
  assert.throws(
    () =>
      validateContainerAction({
        context: "default",
        id: "0123456789abcdef".repeat(4),
        action: "remove",
        options: { timeoutSeconds: 0, confirmed: true },
      }),
    /timeoutSeconds is not valid for remove/u,
  );
  const imageId = `sha256:${"0123456789abcdef".repeat(4)}`;
  // Removal by immutable id with no reference is the dangling-image path: valid by design,
  // because an id cannot be re-pointed the way a tag can.
  assert.equal(
    schemaMatches(
      protocol,
      request("images.action", {
        context: "default",
        action: "remove",
        id: imageId,
        confirmed: true,
      }),
    ),
    true,
    "removal by immutable id must be accepted",
  );
  for (const params of [
    {
      context: "default",
      action: "remove",
      reference: "registry.example/team/api:latest",
      confirmed: true,
    },
    {
      context: "default",
      action: "remove",
      id: imageId,
      reference: "--force",
      confirmed: true,
    },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("images.action", params)),
      false,
      `unsafe image removal unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(() => validateImagesAction(params), TypeError);
  }
});

test("protocol v1 rejects archive paths that would be re-read as a Docker flag", () => {
  // The archive path becomes an argv element beside `--output`/`--input`. The core owns the
  // allowlist decision about where a file may land; both boundaries below must independently
  // refuse the shapes that change what the argument *is* before that decision is reached.
  const unsafe = [
    "-o/tmp/evil.tar", // reads as a flag
    "--output=/tmp/evil.tar",
    "relative/api.tar", // resolves against an unknown cwd
    "/srv/project/api.tar\nrm -rf /", // splits the operation's audit line
    "", // empty
  ];
  for (const archivePath of unsafe) {
    const save = {
      context: "default",
      action: "save",
      reference: "registry.example/team/api:latest",
      archivePath,
    };
    assert.equal(
      schemaMatches(protocol, request("images.action", save)),
      false,
      `unsafe archive path unexpectedly matched the schema: ${JSON.stringify(archivePath)}`,
    );
    assert.throws(
      () => validateImagesAction(save),
      TypeError,
      `unsafe archive path unexpectedly validated: ${JSON.stringify(archivePath)}`,
    );

    const exported = { context: "default", id: "ab".repeat(32), archivePath };
    assert.equal(
      schemaMatches(protocol, request("containers.export", exported)),
      false,
      `unsafe export path unexpectedly matched the schema: ${JSON.stringify(archivePath)}`,
    );
    assert.throws(
      () => validateContainersExport(exported),
      TypeError,
      `unsafe export path unexpectedly validated: ${JSON.stringify(archivePath)}`,
    );
  }

  // Archive options belong to exactly one action; carrying them onto another is rejected
  // rather than silently ignored, so a mis-built request can never write a file.
  // Publishing cannot be undone and its destination is derived from the reference, so an
  // unconfirmed push, or one carrying another verb's options, is refused at every layer.
  for (const params of [
    { context: "default", action: "push", reference: "team/api:v1" },
    { context: "default", action: "push", reference: "team/api:v1", confirmed: false },
    { context: "default", action: "push", confirmed: true },
    { context: "default", action: "push", reference: "--all", confirmed: true },
    {
      context: "default",
      action: "push",
      reference: "team/api:v1",
      confirmed: true,
      archivePath: "/srv/project/api.tar",
    },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("images.action", params)),
      false,
      `unsafe push unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(() => validateImagesAction(params), TypeError);
  }

  // A tag names its source by immutable ID. Naming it by tag would let the operation label
  // whatever that tag points at now, which need not be the image the operator selected.
  for (const params of [
    { context: "default", action: "tag", reference: "team/api:v2" },
    { context: "default", action: "tag", id: "sha256:" + "ab".repeat(32), reference: "--force" },
    {
      context: "default",
      action: "tag",
      id: "sha256:" + "ab".repeat(32),
      reference: "team/api:v2",
      archivePath: "/srv/project/api.tar",
    },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("images.action", params)),
      false,
      `unsafe image tag unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(() => validateImagesAction(params), TypeError);
  }

  // `overwrite` agrees to destroy an existing host file. It belongs only to the verbs that
  // write one, and must never be accepted where it would be silently ignored.
  for (const params of [
    { context: "default", action: "load", archivePath: "/srv/project/api.tar", overwrite: true },
    { context: "default", action: "pull", reference: "team/api", overwrite: true },
    { context: "default", action: "prune", confirmed: true, overwrite: true },
    {
      context: "default",
      action: "remove",
      id: "sha256:" + "ab".repeat(32),
      confirmed: true,
      overwrite: true,
    },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("images.action", params)),
      false,
      `misplaced overwrite unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(() => validateImagesAction(params), TypeError);
  }

  for (const params of [
    { context: "default", action: "load", archivePath: "/srv/project/api.tar", reference: "team/api" },
    { context: "default", action: "save", archivePath: "/srv/project/api.tar" },
    { context: "default", action: "pull", reference: "team/api", archivePath: "/srv/project/api.tar" },
    { context: "default", action: "prune", confirmed: true, archivePath: "/srv/project/api.tar" },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("images.action", params)),
      false,
      `mismatched archive options unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(() => validateImagesAction(params), TypeError);
  }
});

test("protocol v1 makes literal Docker target selection explicit and keeps context metadata required", () => {
  const literalCases = [
    {
      method: "cli.run",
      validate: validateCliRun,
      params: {
        context: "discovery-profile",
        targetMode: "literal",
        argv: ["--host=tcp://remote.example:2376", "--tlsverify", "ps"],
        env: {
          DOCKER_CONTEXT: "remote",
          DOCKER_CONFIG: "/srv/docker-config",
        },
      },
    },
    {
      method: "session.start",
      validate: validateSessionStart,
      params: {
        context: "discovery-profile",
        targetMode: "literal",
        argv: ["--context", "remote", "events"],
        env: {
          DOCKER_HOST: "tcp://remote.example:2376",
          DOCKER_CERT_PATH: "/srv/tls",
        },
        mode: "pipes",
      },
    },
  ];

  for (const item of literalCases) {
    const normalized = item.validate(item.params);
    assert.deepEqual(normalized, item.params);
    assert.equal(schemaMatches(protocol, request(item.method, normalized)), true);

    assert.equal(
      schemaMatches(protocol, request(item.method, { ...item.params, targetMode: "unsafe" })),
      false,
    );
    assert.throws(
      () => item.validate({ ...item.params, targetMode: "unsafe" }),
      /request\.targetMode/u,
    );

    const { context: _context, ...missingContext } = item.params;
    assert.equal(
      schemaMatches(protocol, request(item.method, missingContext)),
      false,
    );
    assert.throws(() => item.validate(missingContext), /request\.context/u);
  }

  assert.deepEqual(
    validateCliRun({ context: "default", argv: ["ps"] }),
    { context: "default", targetMode: "pinned", argv: ["ps"] },
  );
  assert.deepEqual(
    validateSessionStart({
      context: "default",
      argv: ["events"],
      mode: "pipes",
    }),
    {
      context: "default",
      targetMode: "pinned",
      argv: ["events"],
      mode: "pipes",
    },
  );
});

test("session control envelopes reject non-canonical session identifiers", () => {
  const canonical = "01234567-89ab-cdef-0123-456789abcdef";
  const invalidIds = [canonical.toUpperCase(), "session-1"];
  const controls = [
    {
      method: "session.input",
      params: (sessionId) => ({ sessionId, data: "help\n", encoding: "utf-8" }),
      validate: validateSessionInput,
    },
    {
      method: "session.resize",
      params: (sessionId) => ({ sessionId, rows: 32, cols: 120 }),
      validate: validateSessionResize,
    },
    {
      method: "session.signal",
      params: (sessionId) => ({ sessionId, signal: "interrupt" }),
      validate: validateSessionSignal,
    },
    {
      method: "session.cancel",
      params: (sessionId) => ({ sessionId, gracePeriodMs: 2_000 }),
      validate: validateSessionCancel,
    },
    {
      method: "session.ack",
      params: (sessionId) => ({ sessionId, throughSequence: 7 }),
      validate: validateSessionAck,
    },
  ];

  for (const sessionId of invalidIds) {
    for (const control of controls) {
      const params = control.params(sessionId);
      assert.equal(
        schemaMatches(protocol, request(control.method, params)),
        false,
        `${control.method} accepted invalid session ID ${sessionId}`,
      );
      assert.throws(
        () => control.validate(params),
        /request\.sessionId must be a lowercase UUID/u,
      );
    }
  }
});

test("protocol v1 validates every complete discriminated event envelope", () => {
  const operationId = "01234567-89ab-cdef-0123-456789abcdef";
  const containerId = "0123456789abcdef".repeat(4);
  const timestamp = "2026-08-02T20:00:00.000Z";
  const output = {
    stdoutBytes: 3,
    stderrBytes: 0,
    ptyBytes: 0,
    emittedBytes: 3,
    droppedBytes: 0,
    truncated: false,
    lastSequence: 1,
  };
  const envelopes = [
    {
      event: "operation.started",
      payload: {
        operationId,
        method: "containers.action",
        context: "default",
        containerId,
        action: "restart",
        startedAt: timestamp,
      },
    },
    {
      event: "operation.completed",
      payload: {
        receipt: {
          operationId,
          context: "default",
          containerId,
          action: "restart",
          source: "engine-api",
          outcome: "succeeded",
          startedAt: timestamp,
          completedAt: timestamp,
          durationMs: 0,
        },
      },
    },
    {
      event: "reconciliation.requested",
      payload: {
        operationId,
        context: "default",
        domain: "container",
        resourceId: containerId,
        action: "restart",
        reason: "mutation_completed",
      },
    },
    {
      event: "reconciliation.required",
      payload: {
        operationId,
        context: "default",
        domain: "container",
        resourceId: containerId,
        action: "restart",
        reason: "mutation_outcome_unknown",
      },
    },
    {
      event: "session.started",
      payload: {
        sessionId: operationId,
        mode: "pipes",
        pid: 42,
        context: "default",
        targetMode: "pinned",
        executable: "/usr/bin/docker",
        argv: ["docker", "--context", "default", "ps"],
        cwd: "/srv/project",
        outputWindowBytes: 262_144,
        maxOutputBytes: 0,
        startedAt: timestamp,
        state: "running",
      },
    },
    {
      event: "session.output",
      payload: {
        sessionId: operationId,
        sequence: 1,
        stream: "stdout",
        data: "ok\n",
        encoding: "utf-8",
        bytes: 3,
      },
    },
    {
      event: "session.output.truncated",
      payload: {
        sessionId: operationId,
        maxOutputBytes: 1_024,
        droppedBytes: 3,
      },
    },
    {
      event: "session.error",
      payload: {
        sessionId: operationId,
        code: "session_output_failed",
        message: "read failed",
        stream: "stdout",
      },
    },
    {
      event: "session.exited",
      payload: {
        sessionId: operationId,
        state: "exited",
        exitCode: 0,
        timedOut: false,
        canceled: false,
        startedAt: timestamp,
        exitedAt: timestamp,
        durationMs: 0,
        output,
      },
    },
  ];

  assert.deepEqual(
    envelopes.map(({ event }) => event).sort(),
    [...CORE_EVENTS].sort(),
  );
  for (const envelope of envelopes) {
    assert.equal(
      schemaMatches(protocol, envelope),
      true,
      `${envelope.event} does not match protocol/v1.schema.json`,
    );
    assert.deepEqual(
      validateCoreEventEnvelope(envelope.event, envelope.payload),
      envelope,
    );
  }
});

test("CLI lifecycle envelopes require normalized target mode metadata", () => {
  const operationId = "01234567-89ab-cdef-0123-456789abcdef";
  const timestamp = "2026-08-02T20:00:00.000Z";
  const started = {
    event: "operation.started",
    payload: {
      operationId,
      method: "cli.run",
      context: "discovery-profile",
      targetMode: "literal",
      argv: ["--context", "remote", "ps"],
      cwd: "/srv/project",
      startedAt: timestamp,
    },
  };
  const completed = {
    event: "operation.completed",
    payload: {
      result: {
        operationId,
        context: "discovery-profile",
        targetMode: "literal",
        executable: "/usr/bin/docker",
        argv: ["--context", "remote", "ps"],
        cwd: "/srv/project",
        exitCode: 0,
        timedOut: false,
        startedAt: timestamp,
        completedAt: timestamp,
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
      },
    },
  };

  for (const envelope of [started, completed]) {
    assert.equal(schemaMatches(protocol, envelope), true);
    assert.deepEqual(
      validateCoreEventEnvelope(envelope.event, envelope.payload),
      envelope,
    );
  }

  const missingStarted = structuredClone(started);
  delete missingStarted.payload.targetMode;
  const missingCompleted = structuredClone(completed);
  delete missingCompleted.payload.result.targetMode;
  for (const envelope of [missingStarted, missingCompleted]) {
    assert.equal(
      schemaMatches(protocol, envelope),
      false,
      `${envelope.event} accepted missing targetMode in ${
        envelope.payload.result ? "result" : "started payload"
      }`,
    );
    assert.throws(
      () => validateCoreEventEnvelope(envelope.event, envelope.payload),
      /targetMode/u,
    );
  }
});

test("protocol v1 rejects unknown, mismatched, and malformed event envelopes", () => {
  const sessionId = "01234567-89ab-cdef-0123-456789abcdef";
  const invalid = [
    { event: "containers.changed", payload: { revision: 2 } },
    {
      event: "reconciliation.required",
      payload: {
        operationId: sessionId,
        context: "default",
        domain: "container",
        action: "restart",
        reason: "mutation_completed",
      },
    },
    {
      event: "session.output",
      payload: {
        sessionId,
        sequence: 1,
        stream: "stdout",
        data: "ok\n",
        encoding: "utf-8",
        bytes: 0,
      },
    },
    {
      event: "session.error",
      payload: {
        sessionId,
        code: "bad",
        message: "bad",
        unexpected: true,
      },
    },
    { event: "operation.completed", payload: {} },
  ];

  for (const envelope of invalid) {
    assert.equal(
      schemaMatches(protocol, envelope),
      false,
      `${envelope.event} malformed envelope unexpectedly matched the schema`,
    );
    assert.throws(
      () => validateCoreEventEnvelope(envelope.event, envelope.payload),
      TypeError,
    );
  }
});

test("operation completion permits a verified image pull session receipt still running", () => {
  const envelope = {
    event: "operation.completed",
    payload: {
      receipt: {
        operationId: "01234567-89ab-cdef-0123-456789abcdef",
        context: "default",
        domain: "image",
        resourceId: "registry.example/team/api:latest",
        action: "pull",
        source: "cli-session",
        outcome: "running",
        startedAt: "2026-08-02T20:00:00.000Z",
      },
    },
  };
  assert.equal(schemaMatches(protocol, envelope), true);
  assert.deepEqual(
    validateCoreEventEnvelope(envelope.event, envelope.payload),
    envelope,
  );
});

test("protocol v1 keeps Compose verbs from borrowing each other's options", () => {
  for (const params of [
    // up cannot recreate containers without the file that defines them.
    { context: "default", project: "storefront", action: "up" },
    // A configuration path becomes an argv element beside -f.
    { context: "default", project: "storefront", action: "up", configFiles: ["-rf"] },
    // down removes containers and networks, so it is confirmed like every destructive verb.
    { context: "default", project: "storefront", action: "down" },
    { context: "default", project: "storefront", action: "down", confirmed: false },
    // down locates the project by label; a file would silently change what it targets.
    {
      context: "default",
      project: "storefront",
      action: "down",
      confirmed: true,
      configFiles: ["/srv/storefront/compose.yaml"],
    },
    // stop/start/restart take neither.
    { context: "default", project: "storefront", action: "stop", removeVolumes: true },
    // Destroying named volumes is not reversible; down's own confirmation does not cover it.
    {
      context: "default",
      project: "storefront",
      action: "down",
      confirmed: true,
      removeVolumes: true,
    },
    { context: "default", project: "storefront", action: "restart", confirmed: true },
    // The project name becomes an argv element and a label selector.
    { context: "default", project: "-p", action: "stop" },
    { context: "default", project: "Storefront", action: "stop" },
    { context: "default", project: "store front", action: "stop" },
    { context: "default", project: "storefront", action: "exec" },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("compose.action", params)),
      false,
      `unsafe compose action unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(
      () => validateComposeAction(params),
      TypeError,
      `unsafe compose action unexpectedly validated: ${JSON.stringify(params)}`,
    );
  }
});

test("protocol v1 keeps a volume browse inside the volume", () => {
  // The path is resolved inside a helper container that has the volume mounted, so anything
  // that escapes it would read the helper image's own filesystem instead.
  for (const params of [
    { context: "default", name: "project_data", path: "config" },
    { context: "default", name: "project_data", path: "/a/../../etc/passwd" },
    { context: "default", name: "project_data", path: "/.." },
    { context: "default", name: "project_data", path: "/../etc" },
    { context: "default", name: "project_data", path: "" },
    { context: "default", name: "../etc", path: "/" },
    { context: "default", name: "-rf", path: "/" },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("volumes.files", params)),
      false,
      `unsafe volume browse unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(() => validateVolumeFiles(params), TypeError);
  }
  // Reading needs a file, and the volume root is never one.
  for (const params of [
    { context: "default", name: "project_data", path: "/" },
    { context: "default", name: "project_data" },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("volumes.fileRead", params)),
      false,
      `unsafe volume read unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(() => validateVolumeFileRead(params), TypeError);
  }
});

test("protocol v1 keeps a Scout reference from becoming a flag", () => {
  for (const params of [
    { context: "default", reference: "--format" },
    { context: "default", reference: "" },
    { context: "default", reference: "team/api latest" },
    { context: "default" },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("images.scout", params)),
      false,
      `unsafe scout reference unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(() => validateImagesScout(params), TypeError);
  }
});

test("session-backed verbs report receipts the event boundary accepts", () => {
  // Compose lifecycle, image save/load and container export used to pass their emitter
  // straight through, so their receipts existed only in the RPC result with outcome
  // "running" and nothing driven off operation.* ever saw them finish. Now that they do
  // emit, both the schema and the renderer validator have to accept the domains and actions
  // they carry — a rejected event is silently dropped, which looks exactly like the old bug.
  const operationId = "01234567-89ab-cdef-0123-456789abcdef";
  const startedAt = "2026-08-03T12:00:00.000Z";
  for (const payload of [
    {
      operationId,
      method: "compose.action",
      context: "default",
      domain: "compose",
      resourceId: "storefront",
      action: "down",
      source: "cli-session",
      startedAt,
    },
    {
      operationId,
      method: "containers.export",
      context: "default",
      domain: "container",
      resourceId: "ab".repeat(32),
      action: "export",
      source: "cli-session",
      startedAt,
    },
    {
      operationId,
      method: "images.action",
      context: "default",
      domain: "image",
      resourceId: "team/api:v1",
      action: "save",
      source: "cli-session",
      startedAt,
    },
  ]) {
    assert.equal(
      schemaMatches(protocol.$defs.event, {
        event: "operation.started",
        payload,
      }),
      true,
      `receipt rejected by the schema: ${payload.method}/${payload.action}`,
    );
    assert.doesNotThrow(
      () => validateCoreEventEnvelope("operation.started", payload),
      `receipt rejected by the renderer boundary: ${payload.method}/${payload.action}`,
    );
  }

  // Reconciliation for those same verbs must also be deliverable.
  assert.doesNotThrow(() =>
    validateCoreEventEnvelope("reconciliation.requested", {
      operationId,
      context: "default",
      domain: "compose",
      resourceId: "storefront",
      action: "down",
      reason: "mutation_completed",
    }),
  );
});

test("protocol v1 keeps a volume upload inside the directory it names", () => {
  // The file name becomes a tar entry, so a separator or traversal segment would place the
  // upload somewhere the operator did not choose.
  for (const params of [
    { context: "default", name: "v", path: "/", fileName: "../escape.txt", content: "aGk=" },
    { context: "default", name: "v", path: "/", fileName: "a/b.txt", content: "aGk=" },
    { context: "default", name: "v", path: "/", fileName: "..", content: "aGk=" },
    { context: "default", name: "v", path: "/", fileName: ".", content: "aGk=" },
    { context: "default", name: "v", path: "/a/../../etc", fileName: "x", content: "aGk=" },
    { context: "default", name: "v", path: "relative", fileName: "x", content: "aGk=" },
    { context: "default", name: "../etc", path: "/", fileName: "x", content: "aGk=" },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("volumes.fileWrite", params)),
      false,
      `unsafe volume upload unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(() => validateVolumeFileWrite(params), TypeError);
  }
});

test("protocol v1 gates a volume restore and keeps backup paths argv-safe", () => {
  // A restore writes over whatever the volume already holds, so it is confirmed like any
  // other irreversible verb — and the archive path is argv-adjacent on both sides.
  for (const params of [
    { context: "default", name: "v", archivePath: "/srv/b.tar" },
    { context: "default", name: "v", archivePath: "/srv/b.tar", confirmed: false },
    { context: "default", name: "v", archivePath: "-rf", confirmed: true },
    { context: "default", name: "v", archivePath: "relative.tar", confirmed: true },
    { context: "default", name: "../etc", archivePath: "/srv/b.tar", confirmed: true },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("volumes.restore", params)),
      false,
      `unsafe restore unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(() => validateVolumeRestore(params), TypeError);
  }
  for (const params of [
    { context: "default", name: "v", archivePath: "-o/tmp/x.tar" },
    { context: "default", name: "v", archivePath: "relative.tar" },
    { context: "default", name: "v" },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("volumes.backup", params)),
      false,
      `unsafe backup unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(() => validateVolumeBackup(params), TypeError);
  }
});

test("protocol v1 keeps a build reference from becoming a flag", () => {
  // Separators appear inside builder names, so they are allowed within a segment — but a
  // leading one is exactly what turns the value into a Docker option.
  for (const params of [
    { context: "default", ref: "--format" },
    { context: "default", ref: "-o" },
    { context: "default", ref: "../../etc" },
    { context: "default", ref: "" },
    { context: "default", ref: "has space" },
    { context: "default", ref: "a//b" },
    { context: "default", ref: "/leading" },
    { context: "default" },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("builds.inspect", params)),
      false,
      `unsafe build reference unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(() => validateBuildsInspect(params), TypeError);
  }
});

test("protocol v1 gates a plugin repair and keeps its path off the shapes that read as a flag", () => {
  // The first request that deletes a file on the operator's machine. The schema and the
  // boundary validator must agree on all of it: what the path may look like, that a removal is
  // agreed to explicitly, and that `enable` cannot carry an agreement it has no use for.
  const base = {
    context: "default",
    name: "mcp",
    path: "/home/operator/.docker/cli-plugins/docker-mcp",
  };
  for (const params of [
    // A removal without the agreement.
    { ...base, action: "remove" },
    { ...base, action: "remove", confirmed: false },
    // `enable` borrowing remove's confirmation.
    { ...base, action: "enable", confirmed: true },
    // Verbs that are not repairs. `install` in particular: nothing here installs anything.
    { ...base, action: "install", confirmed: true },
    { ...base, action: "chmod", confirmed: true },
    // Paths that are not absolute, or that could be re-read as an option or a second argument.
    { ...base, path: "docker-mcp", action: "enable" },
    { ...base, path: "--force", action: "enable" },
    { ...base, path: "", action: "enable" },
    { ...base, path: "/plugins/docker-mcp\nrm -rf /", action: "enable" },
    // A name that is not a plugin command name.
    { ...base, name: "-mcp", action: "enable" },
    { ...base, name: "", action: "enable" },
    { ...base, action: "enable", extra: true },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("system.pluginAction", params)),
      false,
      `unsafe plugin repair unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(() => validateSystemPluginAction(params), TypeError);
  }
  // Both repairs, correctly formed, are accepted by the schema as the validator emits them.
  for (const params of [
    { ...base, action: "remove", confirmed: true },
    { ...base, action: "enable" },
  ]) {
    assert.equal(
      schemaMatches(
        protocol,
        request("system.pluginAction", validateSystemPluginAction(params)),
      ),
      true,
      `a well-formed repair was refused: ${JSON.stringify(params)}`,
    );
  }
});

test("protocol v1 keeps builder actions to buildx's two safe verbs and gates removal", () => {
  const base = { context: "default", name: "desktop-linux" };
  for (const params of [
    // Switching the active builder is not offered at all: it rewrites configuration shared
    // with every other Docker tool on the machine.
    { ...base, action: "use" },
    { ...base, action: "create" },
    { ...base, action: "prune", confirmed: true },
    // Removal discards the builder's cache, so it is agreed to explicitly.
    { ...base, action: "remove" },
    { ...base, action: "remove", confirmed: false },
    // Bootstrap destroys nothing and must not accept an agreement.
    { ...base, action: "bootstrap", confirmed: true },
    // Names that would read as a flag or carry a second argument.
    { ...base, name: "--all-inactive", action: "bootstrap" },
    { ...base, name: "-f", action: "bootstrap" },
    { ...base, name: "a b", action: "bootstrap" },
    { ...base, name: "a/b", action: "bootstrap" },
    { ...base, name: "", action: "bootstrap" },
    { context: "default", action: "bootstrap" },
  ]) {
    assert.equal(
      schemaMatches(protocol, request("builds.builderAction", params)),
      false,
      `unsafe builder action unexpectedly matched: ${JSON.stringify(params)}`,
    );
    assert.throws(() => validateBuildsBuilderAction(params), TypeError);
  }
  for (const params of [
    { ...base, action: "remove", confirmed: true },
    { ...base, action: "bootstrap" },
  ]) {
    assert.equal(
      schemaMatches(
        protocol,
        request("builds.builderAction", validateBuildsBuilderAction(params)),
      ),
      true,
      `a well-formed builder action was refused: ${JSON.stringify(params)}`,
    );
  }
});

test("protocol v1 makes the container-replacing verb demand the immutable ID", () => {
  // rebindPorts was the one container verb that took a prefix. It is also the one that destroys
  // the container it resolves to, so it was the worst place for the exception: a shorter
  // reference can name a different container between the moment a surface rendered it and the
  // moment this acts. Schema and boundary validator now agree with the rest of the surface.
  const full = "0123456789abcdef".repeat(4);
  for (const id of [
    "abc123",
    "0123456789ab",
    full.slice(0, 63),
    `${full}0`,
    "g".repeat(64),
    `sha256:${full}`,
  ]) {
    const params = { context: "default", id, ports: { "8080": "80/tcp" }, confirmed: true };
    assert.equal(
      schemaMatches(protocol, request("containers.rebindPorts", params)),
      false,
      `a partial container id unexpectedly matched: ${id}`,
    );
    assert.throws(() => validateContainersRebindPorts(params), TypeError);
  }
  // And replacing a container is never implicit.
  assert.throws(
    () =>
      validateContainersRebindPorts({
        context: "default",
        id: full,
        ports: { "8080": "80/tcp" },
      }),
    TypeError,
  );
});

test("every protocol method survives the RPC transport", async () => {
  /*
   * The gap this closes.
   *
   * The allowlist test above proves the schema and RENDERER_RPC_METHODS agree, and the validator
   * test proves each request shape is schema-valid. Neither asks whether the transport that
   * actually carries them would accept the name — and for eight of the fifty-two it would not.
   * `JsonlRpcClient.request` validated method names against `[a-z][a-z0-9]*`, so every camelCase
   * verb was refused as malformed after passing the schema, the renderer allowlist, the preload
   * switch and the IPC channel map. The core had always accepted them.
   *
   * Asserted against the real client rather than a copy of its pattern, so a future tightening
   * of that regex fails here instead of at a user's plugin removal.
   */
  const { JsonLineRpcClient } = await import("./jsonl-rpc.mjs");
  const client = new JsonLineRpcClient();

  for (const method of ["health", ...RENDERER_RPC_METHODS]) {
    await assert.rejects(
      client.request(method, {}),
      (error) => {
        assert.notEqual(
          error.code,
          "RPC_INVALID_METHOD",
          `the transport rejected ${method} as a malformed name`,
        );
        // With no core attached the only legitimate refusal is that there is nothing to talk to.
        assert.equal(error.code, "CORE_UNAVAILABLE");
        return true;
      },
      `${method} did not reach the transport`,
    );
  }
});

test("the RPC transport still refuses a malformed method name", () => {
  // Widening the pattern for camelCase must not have widened it to anything else.
  const pattern = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/u;
  for (const method of [
    "",
    ".plugins",
    "system.",
    "system..plugins",
    "System.plugins",
    "1system.plugins",
    "sys tem.plugins",
    "system.plugins\n",
    "system.plugins;rm -rf /",
    "../../etc/passwd",
  ]) {
    assert.equal(
      pattern.test(method),
      false,
      `the transport pattern accepted ${JSON.stringify(method)}`,
    );
  }
});
