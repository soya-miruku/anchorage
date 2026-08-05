const CONTAINER_ACTIONS = new Set([
  "start",
  "stop",
  "restart",
  "remove",
  "pause",
  "unpause",
  "kill",
]);

// Signals become both a query parameter and an argv element, so keep the shape narrow.
const CONTAINER_SIGNAL = /^[A-Z0-9]{1,20}$/u;

export const RENDERER_RPC_METHODS = Object.freeze([
  "system.capabilities",
  "system.contexts",
  "system.plugins",
  "system.snapshot",
  "system.action",
  "containers.list",
  "containers.inspect",
  "containers.stats",
  "containers.statsBatch",
  "containers.files",
  "containers.fileRead",
  "containers.fileWrite",
  "containers.top",
  "containers.diff",
  "containers.action",
  "containers.create",
  "containers.export",
  "images.scout",
  "volumes.files",
  "volumes.fileRead",
  "volumes.fileWrite",
  "builds.list",
  "builds.inspect",
  "volumes.backup",
  "volumes.restore",
  "volumes.clone",
  "volumes.empty",
  "compose.list",
  "compose.ps",
  "compose.config",
  "compose.action",
  "images.list",
  "images.action",
  "images.inspect",
  "images.search",
  "containers.commit",
  "volumes.list",
  "volumes.action",
  "networks.list",
  "networks.action",
  "secrets.list",
  "cli.run",
  "session.start",
  "session.input",
  "session.resize",
  "session.signal",
  "session.cancel",
  "session.ack",
]);

export const CORE_EVENTS = Object.freeze([
  "operation.started",
  "operation.completed",
  "reconciliation.requested",
  "reconciliation.required",
  "session.started",
  "session.output",
  "session.output.truncated",
  "session.error",
  "session.exited",
]);

export const RENDERER_EVENTS = Object.freeze([
  "core.status",
  ...CORE_EVENTS,
  "window.maximized",
]);

export const IPC_CHANNELS = Object.freeze({
  systemCapabilities: "anchorage:system.capabilities",
  systemContexts: "anchorage:system.contexts",
  systemPlugins: "anchorage:system.plugins",
  systemSnapshot: "anchorage:system.snapshot",
  systemAction: "anchorage:system.action",
  containersList: "anchorage:containers.list",
  containersInspect: "anchorage:containers.inspect",
  containersStats: "anchorage:containers.stats",
  containersStatsBatch: "anchorage:containers.statsBatch",
  containersFiles: "anchorage:containers.files",
  containersFileRead: "anchorage:containers.fileRead",
  containersFileWrite: "anchorage:containers.fileWrite",
  containersTop: "anchorage:containers.top",
  containersDiff: "anchorage:containers.diff",
  containersAction: "anchorage:containers.action",
  containersCreate: "anchorage:containers.create",
  containersExport: "anchorage:containers.export",
  imagesScout: "anchorage:images.scout",
  volumesFiles: "anchorage:volumes.files",
  volumesFileRead: "anchorage:volumes.fileRead",
  volumesFileWrite: "anchorage:volumes.fileWrite",
  buildsList: "anchorage:builds.list",
  buildsInspect: "anchorage:builds.inspect",
  volumesBackup: "anchorage:volumes.backup",
  volumesRestore: "anchorage:volumes.restore",
  volumesClone: "anchorage:volumes.clone",
  volumesEmpty: "anchorage:volumes.empty",
  composeList: "anchorage:compose.list",
  composePs: "anchorage:compose.ps",
  composeConfig: "anchorage:compose.config",
  composeAction: "anchorage:compose.action",
  imagesList: "anchorage:images.list",
  imagesAction: "anchorage:images.action",
  imagesInspect: "anchorage:images.inspect",
  imagesSearch: "anchorage:images.search",
  containersCommit: "anchorage:containers.commit",
  volumesList: "anchorage:volumes.list",
  volumesAction: "anchorage:volumes.action",
  networksList: "anchorage:networks.list",
  networksAction: "anchorage:networks.action",
  secretsList: "anchorage:secrets.list",
  cliRun: "anchorage:cli.run",
  sessionStart: "anchorage:session.start",
  sessionInput: "anchorage:session.input",
  sessionResize: "anchorage:session.resize",
  sessionSignal: "anchorage:session.signal",
  sessionCancel: "anchorage:session.cancel",
  sessionAck: "anchorage:session.ack",
  windowMinimize: "anchorage:window.minimize",
  windowMaximize: "anchorage:window.maximize",
  windowClose: "anchorage:window.close",
  windowIsMaximized: "anchorage:window.isMaximized",
  windowSetBackgroundColor: "anchorage:window.setBackgroundColor",
  event: "anchorage:event",
});

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\])/u;
const CONTAINER_ID = /^[A-Fa-f0-9]{64}$/u;
const IMAGE_ID = /^sha256:[A-Fa-f0-9]{64}$/u;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const SESSION_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SESSION_SIGNALS = new Set([
  "interrupt",
  "terminate",
  "kill",
  "hangup",
  "quit",
]);
const SESSION_MODES = new Set(["pipes", "pty"]);
const TARGET_MODES = new Set(["pinned", "literal"]);
const SESSION_INPUT_ENCODINGS = new Set(["utf-8", "base64"]);
const SESSION_OUTPUT_STREAMS = new Set(["stdout", "stderr", "pty"]);
const MAX_SESSION_INPUT_BYTES = 256 * 1_024;
const MAX_EVENT_PAYLOAD_BYTES = 8 * 1_024 * 1_024;
const MAX_CAPTURED_OUTPUT_CHARACTERS = 1_398_104;
const IMAGE_ACTIONS = new Set([
  "remove",
  "prune",
  "pull",
  "save",
  "load",
  "tag",
  "push",
]);
const VOLUME_ACTIONS = new Set(["create", "remove", "prune"]);
const OPERATION_METHODS = new Set([
  "system.action",
  "networks.action",
  "containers.action",
  "containers.export",
  "compose.action",
  "images.action",
  "volumes.action",
  "cli.run",
]);
const OPERATION_OUTCOMES = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
  "unknown",
]);
const COMPLETED_CONTAINER_OUTCOMES = new Set([
  "succeeded",
  "failed",
  "unknown",
]);
const RECONCILIATION_REASONS = new Set([
  "mutation_completed",
  "mutation_outcome_unknown",
]);
const CORE_STATUS_STATES = new Set([
  "starting",
  "restarting",
  "handshaking",
  "ready",
  "protocol-error",
  "incompatible",
  "unavailable",
  "stopped",
  "crashed",
  "restart-scheduled",
]);
const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const IMAGE_PRUNE_FILTERS = new Set(["dangling", "until", "label", "label!"]);
const VOLUME_PRUNE_FILTERS = new Set(["label", "label!", "all"]);
const DOCKER_TARGET_ENVIRONMENT_KEYS = new Set([
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
]);
const BLOCKED_ENVIRONMENT_KEYS =
  /^(?:BASH_ENV|ENV|GCONV_PATH|GIT_ASKPASS|HOME|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|NODE_OPTIONS|PATH|PATHEXT|PERL5OPT|PYTHONPATH|RUBYOPT|SHELLOPTS|SSH_ASKPASS|SSLKEYLOGFILE|USERPROFILE)$/u;
const TARGET_OVERRIDE_ARGUMENTS = new Set([
  "-c",
  "--context",
  "-H",
  "--host",
  "--config",
  "--tls",
  "--tlsverify",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
]);
const TARGET_OVERRIDE_VALUE_ARGUMENTS = new Set([
  "-c",
  "--context",
  "-H",
  "--host",
  "--config",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
]);
const TARGET_OVERRIDE_BOOLEAN_ARGUMENTS = new Set(["--tls", "--tlsverify"]);
const TARGET_OVERRIDE_PREFIXES = [
  "-c",
  "--context=",
  "-H",
  "--host=",
  "--config=",
  "--tls=",
  "--tlsverify=",
  "--tlscacert=",
  "--tlscert=",
  "--tlskey=",
];

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, name) {
  if (!isPlainObject(value)) {
    fail(`${name} must be a plain object`);
  }
}

function assertOnlyKeys(value, allowedKeys, name) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      fail(`${name}.${key} is not supported`);
    }
  }
}

function boundedString(value, name, maximumLength, { allowEmpty = false } = {}) {
  if (typeof value !== "string") {
    fail(`${name} must be a string`);
  }

  if ((!allowEmpty && value.length === 0) || value.length > maximumLength) {
    fail(`${name} must contain ${allowEmpty ? "at most" : "between 1 and"} ${maximumLength} characters`);
  }

  if (value.includes("\u0000")) {
    fail(`${name} must not contain NUL characters`);
  }

  return value;
}

function optionalBoolean(value, name) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    fail(`${name} must be a boolean`);
  }
  return value;
}

function optionalInteger(value, name, minimum, maximum) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function assignDefined(target, key, value) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function requiredInteger(value, name, minimum, maximum) {
  const normalized = optionalInteger(value, name, minimum, maximum);
  if (normalized === undefined) {
    fail(`${name} is required`);
  }
  return normalized;
}

function validateContext(value, { required = true } = {}) {
  if (value === undefined && !required) {
    return undefined;
  }
  const context = boundedString(value, "request.context", 255).trim();
  if (context.length === 0 || context.includes("\r") || context.includes("\n")) {
    fail("request.context must identify an explicit Docker context");
  }
  return context;
}

export function validateSystemCapabilities(value) {
  if (value === undefined) {
    return {};
  }
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context"]), "request");
  const context = validateContext(value.context, { required: false });
  return context === undefined ? {} : { context };
}

/**
 * Same shape as system.capabilities, validated separately rather than shared.
 *
 * The two verbs answer different questions and are free to diverge; a shared validator would
 * quietly widen one of them the day the other gained a parameter.
 */
export function validateSystemContexts(value) {
  if (value === undefined) {
    return {};
  }
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context"]), "request");
  const context = validateContext(value.context, { required: false });
  return context === undefined ? {} : { context };
}

/**
 * Same shape again, and again validated separately: system.plugins reports the installation
 * rather than a capability, so it is free to gain parameters the other two never want.
 */
export function validateSystemPlugins(value) {
  if (value === undefined) {
    return {};
  }
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context"]), "request");
  const context = validateContext(value.context, { required: false });
  return context === undefined ? {} : { context };
}

export function validateContainersList(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "all"]), "request");
  const normalized = { context: validateContext(value.context) };
  assignDefined(normalized, "all", optionalBoolean(value.all, "request.all"));
  return normalized;
}

export function validateSystemSnapshot(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "includeDiskUsage"]), "request");
  const normalized = { context: validateContext(value.context) };
  assignDefined(
    normalized,
    "includeDiskUsage",
    optionalBoolean(value.includeDiskUsage, "request.includeDiskUsage"),
  );
  return normalized;
}

export function validateSystemAction(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set(["context", "action", "all", "volumes", "confirmed"]),
    "request",
  );
  const action = boundedString(value.action, "request.action", 32);
  if (action !== "prune") {
    fail("request.action must be prune");
  }
  if (value.confirmed !== true) {
    fail("request.confirmed must be true for system prune");
  }
  const normalized = {
    context: validateContext(value.context),
    action,
    confirmed: true,
  };
  assignDefined(normalized, "all", optionalBoolean(value.all, "request.all"));
  assignDefined(
    normalized,
    "volumes",
    optionalBoolean(value.volumes, "request.volumes"),
  );
  return normalized;
}

const RESTART_POLICIES = new Set(["no", "always", "unless-stopped", "on-failure"]);
const NUMERIC_PORT = /^[0-9]{1,5}$/u;
const CONTAINER_PORT = /^[0-9]{1,5}(\/(tcp|udp|sctp))?$/u;
const DOCKER_OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;

export function validateContainersCreate(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set([
      "context",
      "image",
      "name",
      "command",
      "env",
      "ports",
      "binds",
      "labels",
      "restartPolicy",
      "network",
      "autoRemove",
      "start",
    ]),
    "request",
  );
  const image = boundedString(value.image, "request.image", 2048);
  // A leading '-' would let an image reference be read as a flag downstream.
  if (image.startsWith("-")) {
    fail("request.image must not begin with '-'");
  }
  const normalized = { context: validateContext(value.context), image };

  if (value.name !== undefined) {
    const name = boundedString(value.name, "request.name", 255);
    if (!DOCKER_OBJECT_NAME.test(name)) {
      fail("request.name is not a valid Docker container name");
    }
    normalized.name = name;
  }
  if (value.network !== undefined) {
    const network = boundedString(value.network, "request.network", 255);
    if (!DOCKER_OBJECT_NAME.test(network)) {
      fail("request.network is not a valid Docker network name");
    }
    normalized.network = network;
  }
  if (value.restartPolicy !== undefined) {
    const policy = boundedString(value.restartPolicy, "request.restartPolicy", 32);
    if (!RESTART_POLICIES.has(policy)) {
      fail("request.restartPolicy is not supported");
    }
    normalized.restartPolicy = policy;
  }
  for (const [key, limit] of [
    ["command", 256],
    ["env", 512],
    ["binds", 128],
  ]) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].length > limit) {
      fail(`request.${key} must be an array of at most ${limit} entries`);
    }
    normalized[key] = value[key].map((entry, index) =>
      boundedString(entry, `request.${key}[${index}]`, 4096),
    );
  }
  if (normalized.env) {
    for (const entry of normalized.env) {
      if (!entry.includes("=")) {
        fail("request.env entries must be KEY=VALUE");
      }
    }
  }
  if (value.ports !== undefined) {
    assertPlainObject(value.ports, "request.ports");
    const entries = Object.entries(value.ports);
    if (entries.length > 128) {
      fail("request.ports must contain at most 128 entries");
    }
    const ports = {};
    for (const [host, target] of entries) {
      if (!NUMERIC_PORT.test(host)) {
        fail("request.ports keys must be numeric host ports");
      }
      const container = boundedString(target, `request.ports.${host}`, 16);
      if (!CONTAINER_PORT.test(container)) {
        fail("request.ports values must be a port with an optional tcp/udp/sctp protocol");
      }
      ports[host] = container;
    }
    normalized.ports = ports;
  }
  assignDefined(normalized, "labels", validateStringMap(value.labels, "request.labels"));
  assignDefined(
    normalized,
    "autoRemove",
    optionalBoolean(value.autoRemove, "request.autoRemove"),
  );
  assignDefined(normalized, "start", optionalBoolean(value.start, "request.start"));
  return normalized;
}

export function validateContainersStatsBatch(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "ids"]), "request");
  if (!Array.isArray(value.ids) || value.ids.length > 64) {
    fail("request.ids must be an array of at most 64 container IDs");
  }
  const seen = new Set();
  const ids = value.ids.map((entry, index) => {
    const id = boundedString(entry, `request.ids[${index}]`, 64);
    if (!CONTAINER_ID.test(id)) {
      fail("request.ids entries must be full 64-character hexadecimal container IDs");
    }
    if (seen.has(id)) {
      fail("request.ids must not contain duplicates");
    }
    seen.add(id);
    return id;
  });
  return { context: validateContext(value.context), ids };
}

export function validateImagesInspect(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "id"]), "request");
  const id = boundedString(value.id, "request.id", 71);
  if (!IMAGE_ID.test(id)) {
    fail("request.id must be a full sha256 image ID");
  }
  return { context: validateContext(value.context), id };
}

// Container paths become an Engine query parameter, so they are validated as strictly here as
// in the core: absolute, no traversal, no control characters.
const CONTAINER_PATH = /^\/[^\u0000\r\n]{0,4095}$/u;

export function validateContainerFiles(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "id", "path"]), "request");
  const id = boundedString(value.id, "request.id", 64);
  if (!CONTAINER_ID.test(id)) {
    fail("request.id must be a full 64-character hexadecimal container ID");
  }
  const normalized = { context: validateContext(value.context), id };
  if (value.path !== undefined) {
    const target = boundedString(value.path, "request.path", 4096);
    if (!CONTAINER_PATH.test(target) || target.split("/").includes("..")) {
      fail("request.path must be an absolute container path without relative segments");
    }
    normalized.path = target;
  }
  return normalized;
}

export function validateContainerFileRead(value) {
  const normalized = validateContainerFiles(value);
  if (normalized.path === undefined) {
    fail("request.path is required to read a container file");
  }
  return normalized;
}

export function validateContainerFileWrite(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set(["context", "id", "path", "name", "content", "mode"]),
    "request",
  );
  const id = boundedString(value.id, "request.id", 64);
  if (!CONTAINER_ID.test(id)) {
    fail("request.id must be a full 64-character hexadecimal container ID");
  }
  const target = boundedString(value.path, "request.path", 4096);
  if (!CONTAINER_PATH.test(target) || target.split("/").includes("..")) {
    fail("request.path must be an absolute container path without relative segments");
  }
  // The name becomes a tar entry path; a separator would let the upload escape the directory.
  const name = boundedString(value.name, "request.name", 255);
  if (/[/\\\u0000]/u.test(name) || name === "." || name === "..") {
    fail("request.name must be a single path segment");
  }
  const content = boundedString(value.content, "request.content", 4 * 1024 * 1024, true);
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(content)) {
    fail("request.content must be base64-encoded");
  }
  const normalized = { context: validateContext(value.context), id, path: target, name, content };
  assignDefined(
    normalized,
    "mode",
    optionalInteger(value.mode, "request.mode", 1, 511),
  );
  return normalized;
}

export function validateImagesSearch(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "term", "limit"]), "request");
  const term = boundedString(value.term, "request.term", 255);
  if (/[\u0000\r\n]/u.test(term)) {
    fail("request.term contains a control character");
  }
  const normalized = { context: validateContext(value.context), term };
  assignDefined(normalized, "limit", optionalInteger(value.limit, "request.limit", 1, 100));
  return normalized;
}

export function validateContainersCommit(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set(["context", "id", "repository", "tag", "comment", "author", "pause", "changes"]),
    "request",
  );
  const id = boundedString(value.id, "request.id", 64);
  if (!CONTAINER_ID.test(id)) {
    fail("request.id must be a full 64-character hexadecimal container ID");
  }
  const repository = boundedString(value.repository, "request.repository", 2048);
  // A leading '-' would let the target be read as a flag downstream.
  if (repository.startsWith("-")) {
    fail("request.repository must not begin with '-'");
  }
  const normalized = { context: validateContext(value.context), id, repository };
  if (value.tag !== undefined) {
    const tag = boundedString(value.tag, "request.tag", 255);
    if (tag.startsWith("-")) {
      fail("request.tag must not begin with '-'");
    }
    normalized.tag = tag;
  }
  for (const key of ["comment", "author"]) {
    if (value[key] === undefined) continue;
    normalized[key] = boundedString(value[key], `request.${key}`, 1024, true);
  }
  assignDefined(normalized, "pause", optionalBoolean(value.pause, "request.pause"));
  if (value.changes !== undefined) {
    if (!Array.isArray(value.changes) || value.changes.length > 64) {
      fail("request.changes must be an array of at most 64 entries");
    }
    normalized.changes = value.changes.map((entry, index) =>
      boundedString(entry, `request.changes[${index}]`, 1024),
    );
  }
  return normalized;
}

export function validateContainerIdentity(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "id"]), "request");
  const id = boundedString(value.id, "request.id", 64);
  if (!CONTAINER_ID.test(id)) {
    fail("request.id must be a full 64-character hexadecimal container ID");
  }
  return { context: validateContext(value.context), id };
}

export function validateContainerAction(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "id", "action", "options"]), "request");

  const id = boundedString(value.id, "request.id", 256);
  if (!CONTAINER_ID.test(id)) {
    fail("request.id must be a full 64-character hexadecimal container ID");
  }

  const action = boundedString(value.action, "request.action", 32);
  if (!CONTAINER_ACTIONS.has(action)) {
    fail(`request.action must be one of: ${[...CONTAINER_ACTIONS].join(", ")}`);
  }

  const normalized = { context: validateContext(value.context), id, action };
  if (value.options === undefined) {
    if (action === "remove") {
      fail("request.options.confirmed must be true for remove");
    }
    return normalized;
  }

  assertPlainObject(value.options, "request.options");
  assertOnlyKeys(
    value.options,
    new Set([
      "timeoutSeconds",
      "force",
      "volumes",
      "confirmed",
      "signal",
      "name",
      "cpuShares",
      "memoryBytes",
      "restartPolicy",
    ]),
    "request.options",
  );

  const options = {};
  assignDefined(
    options,
    "timeoutSeconds",
    optionalInteger(value.options.timeoutSeconds, "request.options.timeoutSeconds", 0, 600),
  );

  assignDefined(options, "force", optionalBoolean(value.options.force, "request.options.force"));
  assignDefined(
    options,
    "volumes",
    optionalBoolean(value.options.volumes, "request.options.volumes"),
  );
  assignDefined(
    options,
    "confirmed",
    optionalBoolean(value.options.confirmed, "request.options.confirmed"),
  );

  if (value.name !== undefined) {
    const containerName = boundedString(value.name, "request.options.name", 255);
    if (action !== "rename") {
      fail("name is only valid for rename");
    }
    if (!DOCKER_OBJECT_NAME.test(containerName)) {
      fail("request.options.name is not a valid Docker container name");
    }
    options.name = containerName;
  }
  if (action === "rename" && options.name === undefined) {
    fail("rename requires request.options.name");
  }
  for (const key of ["cpuShares", "memoryBytes"]) {
    if (value[key] === undefined) continue;
    if (action !== "update") {
      fail("resource limits are only valid for update");
    }
    options[key] = requiredInteger(
      value[key],
      `request.options.${key}`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (value.restartPolicy !== undefined) {
    if (action !== "update") {
      fail("restartPolicy is only valid for update");
    }
    const policy = boundedString(value.restartPolicy, "request.options.restartPolicy", 32);
    if (!RESTART_POLICIES.has(policy)) {
      fail("request.options.restartPolicy is not supported");
    }
    options.restartPolicy = policy;
  }
  if (action !== "remove" && (options.force || options.volumes)) {
    fail("request.options.force and request.options.volumes are only valid for remove");
  }
  if (action === "remove" && options.timeoutSeconds !== undefined) {
    fail("request.options.timeoutSeconds is not valid for remove");
  }
  if (action === "remove" && options.confirmed !== true) {
    fail("request.options.confirmed must be true for remove");
  }
  if (action !== "remove" && options.confirmed === true) {
    fail("request.options.confirmed is only valid for remove");
  }

  if (Object.keys(options).length > 0) {
    normalized.options = options;
  }

  return normalized;
}

function validateTargetMode(value) {
  return value === undefined
    ? "pinned"
    : validateEnum(value, "request.targetMode", TARGET_MODES);
}

function validateDockerArgv(value, targetMode) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_024) {
    fail("request.argv must contain between 1 and 1024 arguments");
  }

  const argv = value.map((argument, index) => {
    return boundedString(argument, `request.argv[${index}]`, 1_048_576, {
      allowEmpty: index > 0,
    });
  });
  if (targetMode === "pinned") {
    let positionalOnly = false;
    for (const [index, argument] of argv.entries()) {
      if (argument === "--") {
        positionalOnly = true;
        continue;
      }
      if (
        !positionalOnly &&
        (TARGET_OVERRIDE_ARGUMENTS.has(argument) ||
          TARGET_OVERRIDE_PREFIXES.some((prefix) => argument.startsWith(prefix)))
      ) {
        fail(`request.argv[${index}] cannot override the pinned Docker target`);
      }
    }
  }
  let commandIndex = 0;
  if (targetMode === "literal") {
    while (commandIndex < argv.length) {
      const argument = argv[commandIndex];
      if (TARGET_OVERRIDE_VALUE_ARGUMENTS.has(argument)) {
        commandIndex += 2;
        continue;
      }
      if (
        TARGET_OVERRIDE_BOOLEAN_ARGUMENTS.has(argument) ||
        TARGET_OVERRIDE_PREFIXES.some((prefix) => argument.startsWith(prefix))
      ) {
        commandIndex += 1;
        continue;
      }
      break;
    }
  }
  const command = argv[commandIndex];
  if (
    command !== undefined &&
    (command.includes("/") ||
      command.includes("\\") ||
      /^(?:docker|docker\.exe)$/iu.test(command))
  ) {
    fail("request.argv must start with a Docker command, not an executable path");
  }
  return argv;
}

/**
 * A host path that save/load/export hands to Docker as an argv element.
 *
 * The core canonicalizes the parent directory against the working-directory allowlist and is
 * the authority on where an archive may land; this boundary rejects the shapes that would be
 * misread before they ever get that far — a leading '-' becomes a flag, and a newline would
 * split the audit log line that records the operation.
 */
function validateArchivePath(value, field = "request.archivePath") {
  const archivePath = boundedString(value, field, 4_096);
  if (archivePath.startsWith("-")) {
    fail(`${field} must not begin with '-'`);
  }
  if (!ABSOLUTE_PATH.test(archivePath)) {
    fail(`${field} must be an absolute path`);
  }
  if (/[\u0000\r\n]/u.test(archivePath)) {
    fail(`${field} contains a control character`);
  }
  return archivePath;
}

const COMPOSE_ACTIONS = new Set(["up", "down", "start", "stop", "restart"]);
// Compose lowercases project names; the leading character cannot be punctuation. The value
// becomes an argv element and a label selector, so the shape is enforced, not assumed.
const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_.-]{0,254}$/u;

function validateVolumeName(value, field = "request.name") {
  const name = boundedString(value, field, 255);
  if (!VOLUME_NAME.test(name)) {
    fail(`${field} must be a Docker volume name`);
  }
  return name;
}

const VOLUME_BROWSE_PATH = /^\/[^\u0000\r\n]*$/u;

const BUILD_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;

export function validateBuildsList(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context"]), "request");
  return { context: validateContext(value.context) };
}

export function validateBuildsInspect(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "ref"]), "request");
  const ref = boundedString(value.ref, "request.ref", 256);
  // Separators are allowed inside a segment because builder names use them, but never
  // first: a leading '-' is what turns the value into a flag.
  if (!BUILD_REF.test(ref)) {
    fail("request.ref must be a build record reference");
  }
  return { context: validateContext(value.context), ref };
}

export function validateVolumeBackup(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "name", "archivePath", "overwrite"]), "request");
  const normalized = {
    context: validateContext(value.context),
    name: validateVolumeName(value.name),
    archivePath: validateArchivePath(value.archivePath),
  };
  assignDefined(normalized, "overwrite", optionalBoolean(value.overwrite, "request.overwrite"));
  return normalized;
}

export function validateVolumeRestore(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set(["context", "name", "archivePath", "confirmed", "confirmedInUse"]),
    "request",
  );
  const normalized = {
    context: validateContext(value.context),
    name: validateVolumeName(value.name),
    archivePath: validateArchivePath(value.archivePath),
  };
  // Restoring writes over whatever the volume already holds.
  if (value.confirmed !== true) {
    fail("request.confirmed must be true for a volume restore");
  }
  normalized.confirmed = true;
  assignDefined(
    normalized,
    "confirmedInUse",
    optionalBoolean(value.confirmedInUse, "request.confirmedInUse"),
  );
  return normalized;
}

export function validateVolumeClone(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "name", "target"]), "request");
  const name = validateVolumeName(value.name);
  const target = validateVolumeName(value.target, "request.target");
  if (name === target) {
    fail("request.target must differ from request.name");
  }
  return { context: validateContext(value.context), name, target };
}

export function validateVolumeEmpty(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "name", "confirmed"]), "request");
  // Emptying discards every byte the volume holds and nothing restores it.
  if (value.confirmed !== true) {
    fail("request.confirmed must be true for a volume empty");
  }
  return {
    context: validateContext(value.context),
    name: validateVolumeName(value.name),
    confirmed: true,
  };
}

export function validateVolumeFileWrite(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set(["context", "name", "path", "fileName", "content", "mode", "confirmedInUse"]),
    "request",
  );
  const target = boundedString(value.path, "request.path", 4_096);
  if (!VOLUME_BROWSE_PATH.test(target) || target.split("/").includes("..")) {
    fail("request.path must be an absolute path inside the volume");
  }
  // The name becomes a tar entry, so a separator or traversal segment would let the upload
  // escape the directory the operator chose.
  const fileName = boundedString(value.fileName, "request.fileName", 255);
  if (
    fileName === "." ||
    fileName === ".." ||
    /[/\\\u0000\r\n]/u.test(fileName)
  ) {
    fail("request.fileName must be a single path segment");
  }
  const normalized = {
    context: validateContext(value.context),
    name: validateVolumeName(value.name),
    path: target,
    fileName,
    content: boundedString(value.content, "request.content", 8_388_608, true),
  };
  assignDefined(normalized, "mode", optionalInteger(value.mode, "request.mode", 1, 511));
  assignDefined(
    normalized,
    "confirmedInUse",
    optionalBoolean(value.confirmedInUse, "request.confirmedInUse"),
  );
  return normalized;
}

export function validateImagesScout(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "reference"]), "request");
  const reference = boundedString(value.reference, "request.reference", 2_048);
  // Scout takes a tag or an immutable image ID; either way it becomes an argv element.
  if (reference.startsWith("-") || /[\u0000\r\n\t ]/u.test(reference)) {
    fail("request.reference must be a single non-option Docker reference");
  }
  return { context: validateContext(value.context), reference };
}

export function validateVolumeFiles(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "name", "path"]), "request");
  const normalized = {
    context: validateContext(value.context),
    name: validateVolumeName(value.name),
  };
  if (value.path !== undefined) {
    const target = boundedString(value.path, "request.path", 4_096);
    if (!VOLUME_BROWSE_PATH.test(target) || target.split("/").includes("..")) {
      fail("request.path must be an absolute path inside the volume");
    }
    normalized.path = target;
  }
  return normalized;
}

export function validateVolumeFileRead(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "name", "path"]), "request");
  const target = boundedString(value.path, "request.path", 4_096);
  // The same traversal check the container-path validators apply. The core rejects this too,
  // but a gap in only one layer defeats the point of validating at each boundary.
  if (
    !VOLUME_BROWSE_PATH.test(target) ||
    target === "/" ||
    target.split("/").includes("..")
  ) {
    fail("request.path must name a file inside the volume");
  }
  return {
    context: validateContext(value.context),
    name: validateVolumeName(value.name),
    path: target,
  };
}

export function validateComposeList(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "all"]), "request");
  const normalized = { context: validateContext(value.context) };
  assignDefined(normalized, "all", optionalBoolean(value.all, "request.all"));
  return normalized;
}

function validateComposeProject(value) {
  const project = boundedString(value, "request.project", 255);
  if (!COMPOSE_PROJECT.test(project)) {
    fail("request.project must be a Compose project name");
  }
  return project;
}

export function validateComposePs(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "project"]), "request");
  return {
    context: validateContext(value.context),
    project: validateComposeProject(value.project),
  };
}

// A configuration path that becomes an argv element beside -f. The core resolves each one and
// refuses anything that is not an ordinary file; this boundary rejects the shapes that would
// be misread before they get that far.
function validateComposeConfigFiles(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    fail("request.configFiles must be an array of 1 to 32 paths");
  }
  return value.map((entry, index) => {
    const file = boundedString(entry, `request.configFiles[${index}]`, 4_096);
    // The path becomes an argv element beside -f; a leading '-' would read as a flag.
    if (file.startsWith("-") || /[\u0000\r\n]/u.test(file)) {
      fail(`request.configFiles[${index}] must be a plain file path`);
    }
    return file;
  });
}

export function validateComposeConfig(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context", "project", "configFiles"]), "request");
  return {
    context: validateContext(value.context),
    project: validateComposeProject(value.project),
    // `config` renders files: unlike the lifecycle verbs it cannot find a project by label.
    configFiles: validateComposeConfigFiles(value.configFiles),
  };
}

export function validateComposeAction(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set([
      "context",
      "project",
      "action",
      "configFiles",
      "confirmed",
      "removeVolumes",
      "confirmedRemoveVolumes",
      "removeOrphans",
      "timeoutSeconds",
      "outputWindowBytes",
    ]),
    "request",
  );
  const action = validateEnum(value.action, "request.action", COMPOSE_ACTIONS);
  const normalized = {
    context: validateContext(value.context),
    project: validateComposeProject(value.project),
    action,
  };
  if (value.configFiles !== undefined) {
    if (!Array.isArray(value.configFiles) || value.configFiles.length === 0 ||
        value.configFiles.length > 32) {
      fail("request.configFiles must be an array of 1 to 32 paths");
    }
    normalized.configFiles = value.configFiles.map((entry, index) => {
      const file = boundedString(entry, `request.configFiles[${index}]`, 4_096);
      // The path becomes an argv element beside -f; a leading '-' would read as a flag.
      if (file.startsWith("-") || /[\u0000\r\n]/u.test(file)) {
        fail(`request.configFiles[${index}] must be a plain file path`);
      }
      return file;
    });
  }
  assignDefined(normalized, "confirmed", optionalBoolean(value.confirmed, "request.confirmed"));
  assignDefined(
    normalized,
    "removeVolumes",
    optionalBoolean(value.removeVolumes, "request.removeVolumes"),
  );
  assignDefined(
    normalized,
    "confirmedRemoveVolumes",
    optionalBoolean(value.confirmedRemoveVolumes, "request.confirmedRemoveVolumes"),
  );
  assignDefined(
    normalized,
    "removeOrphans",
    optionalBoolean(value.removeOrphans, "request.removeOrphans"),
  );
  assignDefined(
    normalized,
    "timeoutSeconds",
    optionalInteger(value.timeoutSeconds, "request.timeoutSeconds", 0, 86_400),
  );
  assignDefined(
    normalized,
    "outputWindowBytes",
    optionalInteger(value.outputWindowBytes, "request.outputWindowBytes", 1_024, 8_388_608),
  );

  if (action === "up") {
    // Compose finds existing containers by label, but recreating them needs the file.
    if (!normalized.configFiles) {
      fail("request.configFiles is required for compose up");
    }
    if (
      normalized.confirmed === true ||
      normalized.removeVolumes === true ||
      normalized.confirmedRemoveVolumes === true
    ) {
      fail("request contains options that are not valid for compose up");
    }
  } else if (action === "down") {
    if (normalized.confirmed !== true) {
      fail("request.confirmed must be true for compose down");
    }
    if (normalized.configFiles !== undefined) {
      fail("compose down finds the project by label and takes no configuration files");
    }
    // Taking a project down is reversible from its Compose file; destroying its named
    // volumes is not, so agreeing to the first must not carry the second.
    if (
      normalized.removeVolumes === true &&
      normalized.confirmedRemoveVolumes !== true
    ) {
      fail("request.confirmedRemoveVolumes must be true to remove compose volumes");
    }
  } else if (
    normalized.configFiles !== undefined ||
    normalized.confirmed === true ||
    normalized.removeVolumes === true ||
    normalized.confirmedRemoveVolumes === true ||
    normalized.removeOrphans === true
  ) {
    fail(`request contains options that are not valid for compose ${action}`);
  }
  return normalized;
}

export function validateContainersExport(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set([
      "context",
      "id",
      "archivePath",
      "overwrite",
      "cwd",
      "timeoutSeconds",
      "outputWindowBytes",
    ]),
    "request",
  );
  const id = boundedString(value.id, "request.id", 64);
  if (!CONTAINER_ID.test(id)) {
    fail("request.id must be a full 64-character hexadecimal container ID");
  }
  const normalized = {
    context: validateContext(value.context),
    id,
    archivePath: validateArchivePath(value.archivePath),
  };
  assignDefined(
    normalized,
    "overwrite",
    optionalBoolean(value.overwrite, "request.overwrite"),
  );
  assignDefined(normalized, "cwd", validateCwd(value.cwd));
  assignDefined(
    normalized,
    "timeoutSeconds",
    optionalInteger(value.timeoutSeconds, "request.timeoutSeconds", 0, 86_400),
  );
  assignDefined(
    normalized,
    "outputWindowBytes",
    optionalInteger(
      value.outputWindowBytes,
      "request.outputWindowBytes",
      1_024,
      8_388_608,
    ),
  );
  return normalized;
}

function validateCwd(value) {
  if (value === undefined) {
    return undefined;
  }
  const cwd = boundedString(value, "request.cwd", 4_096);
  if (!ABSOLUTE_PATH.test(cwd)) {
    fail("request.cwd must be an absolute path");
  }
  return cwd;
}

function validateEnvironment(value, targetMode) {
  if (value === undefined) {
    return undefined;
  }
  assertPlainObject(value, "request.env");
  const entries = Object.entries(value);
  if (entries.length > 1_024) {
    fail("request.env must contain at most 1024 entries");
  }
  const normalizedEntries = [];
  for (const [key, rawValue] of entries) {
    const canonicalKey = key.toUpperCase();
    if (
      !ENVIRONMENT_KEY.test(key) ||
      BLOCKED_ENVIRONMENT_KEYS.test(canonicalKey) ||
      (targetMode === "pinned" &&
        DOCKER_TARGET_ENVIRONMENT_KEYS.has(canonicalKey))
    ) {
      fail(`request.env.${key} is not permitted`);
    }
    normalizedEntries.push([
      key,
      boundedString(rawValue, `request.env.${key}`, 1_048_576, {
        allowEmpty: true,
      }),
    ]);
  }
  return Object.fromEntries(normalizedEntries);
}

function validateSessionId(value) {
  const sessionId = boundedString(value, "request.sessionId", 36);
  if (!SESSION_ID.test(sessionId)) {
    fail("request.sessionId must be a lowercase UUID");
  }
  return sessionId;
}

function validateEnum(value, name, allowed) {
  const normalized = boundedString(value, name, 32);
  if (!allowed.has(normalized)) {
    fail(`${name} must be one of: ${[...allowed].join(", ")}`);
  }
  return normalized;
}

function strictBase64ByteLength(value) {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    fail("request.data must be valid base64");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function validateFilters(value, name, allowed) {
  if (value === undefined) {
    return undefined;
  }
  assertPlainObject(value, name);
  const entries = Object.entries(value);
  if (entries.length > 32) {
    fail(`${name} must contain at most 32 filter keys`);
  }
  const normalized = {};
  for (const [key, rawValues] of entries) {
    if (!allowed.has(key)) {
      fail(`${name}.${key} is not permitted`);
    }
    if (!Array.isArray(rawValues) || rawValues.length === 0 || rawValues.length > 64) {
      fail(`${name}.${key} must contain between 1 and 64 values`);
    }
    normalized[key] = rawValues.map((rawValue, index) => {
      const item = boundedString(
        rawValue,
        `${name}.${key}[${index}]`,
        4_096,
      );
      if (/[\u0000\r\n]/u.test(item)) {
        fail(`${name}.${key}[${index}] contains unsupported control characters`);
      }
      return item;
    });
  }
  return normalized;
}

function validateStringMap(value, name) {
  if (value === undefined) {
    return undefined;
  }
  assertPlainObject(value, name);
  const entries = Object.entries(value);
  if (entries.length > 256) {
    fail(`${name} must contain at most 256 entries`);
  }
  const normalizedEntries = [];
  for (const [key, rawValue] of entries) {
    if (
      key.length === 0 ||
      key.length > 4_096 ||
      /[\u0000\r\n]/u.test(key)
    ) {
      fail(`${name} contains an invalid key`);
    }
    const item = boundedString(rawValue, `${name}.${key}`, 65_536, {
      allowEmpty: true,
    });
    if (/[\u0000\r\n]/u.test(item)) {
      fail(`${name}.${key} contains unsupported control characters`);
    }
    normalizedEntries.push([key, item]);
  }
  return Object.fromEntries(normalizedEntries);
}

export function validateImagesList(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set(["context", "all", "includeDangling"]),
    "request",
  );
  const normalized = { context: validateContext(value.context) };
  assignDefined(normalized, "all", optionalBoolean(value.all, "request.all"));
  assignDefined(
    normalized,
    "includeDangling",
    optionalBoolean(value.includeDangling, "request.includeDangling"),
  );
  return normalized;
}

export function validateImagesAction(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set([
      "context",
      "action",
      "id",
      "reference",
      "archivePath",
      "overwrite",
      "force",
      "noPrune",
      "filters",
      "confirmed",
      "cwd",
      "timeoutSeconds",
      "outputWindowBytes",
      "maxOutputBytes",
    ]),
    "request",
  );
  const action = validateEnum(value.action, "request.action", IMAGE_ACTIONS);
  const normalized = {
    context: validateContext(value.context),
    action,
  };
  if (value.id !== undefined) {
    const id = boundedString(value.id, "request.id", 71);
    if (!IMAGE_ID.test(id)) {
      fail("request.id must be a full immutable sha256 image ID");
    }
    normalized.id = id;
  }
  if (value.reference !== undefined) {
    const reference = boundedString(
      value.reference,
      "request.reference",
      2_048,
    );
    if (reference.startsWith("-") || /[\u0000\r\n\t ]/u.test(reference)) {
      fail("request.reference must be a single non-option Docker reference");
    }
    normalized.reference = reference;
  }
  assignDefined(
    normalized,
    "overwrite",
    optionalBoolean(value.overwrite, "request.overwrite"),
  );
  if (value.archivePath !== undefined) {
    normalized.archivePath = validateArchivePath(value.archivePath);
  }
  assignDefined(normalized, "force", optionalBoolean(value.force, "request.force"));
  assignDefined(
    normalized,
    "noPrune",
    optionalBoolean(value.noPrune, "request.noPrune"),
  );
  const allowedFilters =
    action === "prune" ? IMAGE_PRUNE_FILTERS : new Set();
  assignDefined(
    normalized,
    "filters",
    validateFilters(value.filters, "request.filters", allowedFilters),
  );
  assignDefined(
    normalized,
    "confirmed",
    optionalBoolean(value.confirmed, "request.confirmed"),
  );
  assignDefined(normalized, "cwd", validateCwd(value.cwd));
  assignDefined(
    normalized,
    "timeoutSeconds",
    optionalInteger(value.timeoutSeconds, "request.timeoutSeconds", 0, 86_400),
  );
  assignDefined(
    normalized,
    "outputWindowBytes",
    optionalInteger(
      value.outputWindowBytes,
      "request.outputWindowBytes",
      1_024,
      8_388_608,
    ),
  );
  assignDefined(
    normalized,
    "maxOutputBytes",
    optionalInteger(
      value.maxOutputBytes,
      "request.maxOutputBytes",
      0,
      1_099_511_627_776,
    ),
  );

  if (action === "remove") {
    if (!normalized.id) {
      fail("request.id is required for image remove");
    }
    // reference is optional: a dangling image has no repo tag, so requiring one made every
    // untagged image structurally unremovable. The immutable id is always the real target.

    if (normalized.confirmed !== true) {
      fail("request.confirmed must be true for image remove");
    }
    if (
      Object.keys(normalized.filters ?? {}).length > 0 ||
      normalized.archivePath !== undefined ||
      normalized.overwrite !== undefined ||
      normalized.cwd !== undefined ||
      (normalized.timeoutSeconds ?? 0) !== 0 ||
      normalized.outputWindowBytes !== undefined ||
      (normalized.maxOutputBytes ?? 0) !== 0
    ) {
      fail("request contains options that are not valid for image remove");
    }
  } else if (action === "prune") {
    if (normalized.confirmed !== true) {
      fail("request.confirmed must be true for image prune");
    }
    if (
      normalized.id !== undefined ||
      normalized.reference !== undefined ||
      normalized.archivePath !== undefined ||
      normalized.overwrite !== undefined ||
      normalized.force === true ||
      normalized.noPrune === true ||
      normalized.cwd !== undefined ||
      (normalized.timeoutSeconds ?? 0) !== 0 ||
      normalized.outputWindowBytes !== undefined ||
      (normalized.maxOutputBytes ?? 0) !== 0
    ) {
      fail("request contains options that are not valid for image prune");
    }
  } else if (action === "push") {
    if (!normalized.reference) {
      fail("request.reference is required for image push");
    }
    // Publishing cannot be taken back, and the destination comes from the reference rather
    // than a separate field, so the wrong tag is a disclosure rather than a failed command.
    if (normalized.confirmed !== true) {
      fail("request.confirmed must be true for image push");
    }
    if (
      normalized.id !== undefined ||
      normalized.archivePath !== undefined ||
      normalized.overwrite !== undefined ||
      normalized.force === true ||
      normalized.noPrune === true ||
      Object.keys(normalized.filters ?? {}).length > 0
    ) {
      fail("request contains options that are not valid for image push");
    }
  } else if (action === "tag") {
    if (!normalized.id) {
      fail("request.id is required for image tag");
    }
    if (!normalized.reference) {
      fail("request.reference is required for image tag");
    }
    if (
      normalized.archivePath !== undefined ||
      normalized.force === true ||
      normalized.noPrune === true ||
      Object.keys(normalized.filters ?? {}).length > 0 ||
      normalized.confirmed === true ||
      normalized.cwd !== undefined ||
      (normalized.timeoutSeconds ?? 0) !== 0 ||
      normalized.outputWindowBytes !== undefined ||
      (normalized.maxOutputBytes ?? 0) !== 0
    ) {
      fail("request contains options that are not valid for image tag");
    }
  } else if (action === "save" || action === "load") {
    if (normalized.archivePath === undefined) {
      fail(`request.archivePath is required for image ${action}`);
    }
    // save names what to write; load learns its images from the archive itself.
    if (action === "save" && !normalized.reference) {
      fail("request.reference is required for image save");
    }
    if (action === "load" && normalized.reference !== undefined) {
      fail("request.reference is not valid for image load");
    }
    // `overwrite` agrees to replace a file; load only ever reads one.
    if (action === "load" && normalized.overwrite !== undefined) {
      fail("request.overwrite is not valid for image load");
    }
    if (
      normalized.id !== undefined ||
      normalized.force === true ||
      normalized.noPrune === true ||
      Object.keys(normalized.filters ?? {}).length > 0 ||
      normalized.confirmed === true
    ) {
      fail(`request contains options that are not valid for image ${action}`);
    }
  } else {
    if (!normalized.reference) {
      fail("request.reference is required for image pull");
    }
    if (
      normalized.id !== undefined ||
      normalized.archivePath !== undefined ||
      normalized.overwrite !== undefined ||
      normalized.force === true ||
      normalized.noPrune === true ||
      Object.keys(normalized.filters ?? {}).length > 0 ||
      normalized.confirmed === true
    ) {
      fail("request contains options that are not valid for image pull");
    }
  }
  return normalized;
}

export function validateVolumesList(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context"]), "request");
  return { context: validateContext(value.context) };
}

const NETWORK_ACTIONS = new Set([
  "create",
  "remove",
  "prune",
  "connect",
  "disconnect",
]);
const NETWORK_ID_PATTERN = /^[A-Fa-f0-9]{12,64}$/u;
// Mirrors Docker's own network-name grammar; the leading class excludes '-' so a name can
// never be read as a flag by the CLI transport.
const NETWORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const NETWORK_PRUNE_FILTERS = new Set(["until", "label"]);

export function validateNetworksList(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context"]), "request");
  return { context: validateContext(value.context) };
}

/**
 * The whole secrets surface. There is no inspect and no mutation to validate: Docker never
 * returns a secret's value, and creating or removing one is out of scope, so the context is
 * the only thing that crosses.
 */
export function validateSecretsList(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["context"]), "request");
  return { context: validateContext(value.context) };
}

export function validateNetworksAction(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set([
      "context",
      "action",
      "name",
      "id",
      "containerId",
      "driver",
      "subnet",
      "gateway",
      "internal",
      "attachable",
      "enableIpv6",
      "labels",
      "options",
      "filters",
      "force",
      "confirmed",
    ]),
    "request",
  );
  const action = boundedString(value.action, "request.action", 32);
  if (!NETWORK_ACTIONS.has(action)) {
    fail("request.action is not a supported network action");
  }
  const normalized = { context: validateContext(value.context), action };

  if (action === "create") {
    const name = boundedString(value.name, "request.name", 255);
    if (!NETWORK_NAME_PATTERN.test(name)) {
      fail("request.name is not a valid Docker network name");
    }
    normalized.name = name;
    for (const key of ["driver", "subnet", "gateway"]) {
      if (value[key] !== undefined) {
        normalized[key] = boundedString(value[key], `request.${key}`, 64);
      }
    }
    for (const key of ["internal", "attachable", "enableIpv6"]) {
      assignDefined(normalized, key, optionalBoolean(value[key], `request.${key}`));
    }
    assignDefined(normalized, "labels", validateStringMap(value.labels, "request.labels"));
    assignDefined(normalized, "options", validateStringMap(value.options, "request.options"));
    return normalized;
  }

  if (action === "prune") {
    if (value.confirmed !== true) {
      fail("request.confirmed must be true for network prune");
    }
    normalized.confirmed = true;
    assignDefined(
      normalized,
      "filters",
      validateFilters(value.filters, "request.filters", NETWORK_PRUNE_FILTERS),
    );
    return normalized;
  }

  const id = boundedString(value.id, "request.id", 64);
  if (!NETWORK_ID_PATTERN.test(id)) {
    fail("request.id must be a 12 to 64 character hexadecimal network ID");
  }
  normalized.id = id;

  if (action === "remove") {
    if (value.confirmed !== true) {
      fail("request.confirmed must be true for network remove");
    }
    normalized.confirmed = true;
    return normalized;
  }

  const containerId = boundedString(value.containerId, "request.containerId", 64);
  if (!CONTAINER_ID.test(containerId)) {
    fail("request.containerId must be a full 64-character hexadecimal container ID");
  }
  normalized.containerId = containerId;
  assignDefined(normalized, "force", optionalBoolean(value.force, "request.force"));
  return normalized;
}

export function validateVolumesAction(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set([
      "context",
      "action",
      "name",
      "driver",
      "driverOpts",
      "labels",
      "force",
      "filters",
      "confirmed",
    ]),
    "request",
  );
  const action = validateEnum(value.action, "request.action", VOLUME_ACTIONS);
  const normalized = {
    context: validateContext(value.context),
    action,
  };
  if (value.name !== undefined) {
    const name = boundedString(value.name, "request.name", 255);
    if (!VOLUME_NAME.test(name)) {
      fail("request.name contains unsupported volume-name characters");
    }
    normalized.name = name;
  }
  if (value.driver !== undefined) {
    normalized.driver = boundedString(
      value.driver,
      "request.driver",
      4_096,
      { allowEmpty: true },
    );
  }
  assignDefined(
    normalized,
    "driverOpts",
    validateStringMap(value.driverOpts, "request.driverOpts"),
  );
  assignDefined(
    normalized,
    "labels",
    validateStringMap(value.labels, "request.labels"),
  );
  assignDefined(normalized, "force", optionalBoolean(value.force, "request.force"));
  const allowedFilters =
    action === "prune" ? VOLUME_PRUNE_FILTERS : new Set();
  assignDefined(
    normalized,
    "filters",
    validateFilters(value.filters, "request.filters", allowedFilters),
  );
  assignDefined(
    normalized,
    "confirmed",
    optionalBoolean(value.confirmed, "request.confirmed"),
  );

  if (action === "create") {
    if (!normalized.name) {
      fail("request.name is required for volume create");
    }
    if (
      normalized.force === true ||
      Object.keys(normalized.filters ?? {}).length > 0 ||
      normalized.confirmed === true
    ) {
      fail("request contains options that are not valid for volume create");
    }
  } else if (action === "remove") {
    if (!normalized.name) {
      fail("request.name is required for volume remove");
    }
    if (normalized.confirmed !== true) {
      fail("request.confirmed must be true for volume remove");
    }
    if (
      (normalized.driver !== undefined && normalized.driver !== "") ||
      Object.keys(normalized.driverOpts ?? {}).length > 0 ||
      Object.keys(normalized.labels ?? {}).length > 0 ||
      Object.keys(normalized.filters ?? {}).length > 0
    ) {
      fail("request contains options that are not valid for volume remove");
    }
  } else {
    if (normalized.confirmed !== true) {
      fail("request.confirmed must be true for volume prune");
    }
    if (
      normalized.name !== undefined ||
      (normalized.driver !== undefined && normalized.driver !== "") ||
      Object.keys(normalized.driverOpts ?? {}).length > 0 ||
      Object.keys(normalized.labels ?? {}).length > 0 ||
      normalized.force === true
    ) {
      fail("request contains options that are not valid for volume prune");
    }
  }
  return normalized;
}

export function validateCliRun(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set([
      "context",
      "targetMode",
      "argv",
      "cwd",
      "env",
      "timeoutSeconds",
      "interactive",
      "streaming",
    ]),
    "request",
  );

  const targetMode = validateTargetMode(value.targetMode);
  const normalized = {
    context: validateContext(value.context),
    targetMode,
    argv: validateDockerArgv(value.argv, targetMode),
  };
  assignDefined(normalized, "cwd", validateCwd(value.cwd));
  assignDefined(normalized, "env", validateEnvironment(value.env, targetMode));

  assignDefined(
    normalized,
    "timeoutSeconds",
    optionalInteger(value.timeoutSeconds, "request.timeoutSeconds", 0, 3_600),
  );
  assignDefined(
    normalized,
    "interactive",
    optionalBoolean(value.interactive, "request.interactive"),
  );
  assignDefined(normalized, "streaming", optionalBoolean(value.streaming, "request.streaming"));

  return normalized;
}

export function validateSessionStart(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set([
      "context",
      "targetMode",
      "argv",
      "cwd",
      "env",
      "mode",
      "rows",
      "cols",
      "timeoutSeconds",
      "outputWindowBytes",
      "maxOutputBytes",
    ]),
    "request",
  );

  const targetMode = validateTargetMode(value.targetMode);
  const normalized = {
    context: validateContext(value.context),
    targetMode,
    argv: validateDockerArgv(value.argv, targetMode),
    mode: validateEnum(value.mode, "request.mode", SESSION_MODES),
  };
  assignDefined(normalized, "cwd", validateCwd(value.cwd));
  assignDefined(normalized, "env", validateEnvironment(value.env, targetMode));
  assignDefined(
    normalized,
    "rows",
    optionalInteger(value.rows, "request.rows", 1, 1_000),
  );
  assignDefined(
    normalized,
    "cols",
    optionalInteger(value.cols, "request.cols", 1, 1_000),
  );
  assignDefined(
    normalized,
    "timeoutSeconds",
    optionalInteger(value.timeoutSeconds, "request.timeoutSeconds", 0, 86_400),
  );
  assignDefined(
    normalized,
    "outputWindowBytes",
    optionalInteger(
      value.outputWindowBytes,
      "request.outputWindowBytes",
      1_024,
      8_388_608,
    ),
  );
  assignDefined(
    normalized,
    "maxOutputBytes",
    optionalInteger(
      value.maxOutputBytes,
      "request.maxOutputBytes",
      0,
      1_099_511_627_776,
    ),
  );
  return normalized;
}

export function validateSessionInput(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(
    value,
    new Set(["sessionId", "data", "encoding", "eof"]),
    "request",
  );

  const normalized = { sessionId: validateSessionId(value.sessionId) };
  const encoding =
    value.encoding === undefined
      ? "utf-8"
      : validateEnum(
          value.encoding,
          "request.encoding",
          SESSION_INPUT_ENCODINGS,
        );
  let dataBytes = 0;
  if (value.data !== undefined) {
    const data = boundedString(value.data, "request.data", 1_048_576, {
      allowEmpty: true,
    });
    dataBytes =
      encoding === "base64"
        ? strictBase64ByteLength(data)
        : Buffer.byteLength(data, "utf8");
    if (dataBytes > MAX_SESSION_INPUT_BYTES) {
      fail(`request.data must encode at most ${MAX_SESSION_INPUT_BYTES} bytes`);
    }
    normalized.data = data;
  }
  assignDefined(
    normalized,
    "encoding",
    value.encoding === undefined ? undefined : encoding,
  );
  const eof = optionalBoolean(value.eof, "request.eof");
  assignDefined(normalized, "eof", eof);
  if (dataBytes === 0 && eof !== true) {
    fail("request must include non-empty data or request EOF");
  }
  return normalized;
}

export function validateSessionResize(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["sessionId", "rows", "cols"]), "request");
  return {
    sessionId: validateSessionId(value.sessionId),
    rows: requiredInteger(value.rows, "request.rows", 1, 1_000),
    cols: requiredInteger(value.cols, "request.cols", 1, 1_000),
  };
}

export function validateSessionSignal(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["sessionId", "signal"]), "request");
  return {
    sessionId: validateSessionId(value.sessionId),
    signal: validateEnum(value.signal, "request.signal", SESSION_SIGNALS),
  };
}

export function validateSessionCancel(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["sessionId", "gracePeriodMs"]), "request");
  const normalized = { sessionId: validateSessionId(value.sessionId) };
  assignDefined(
    normalized,
    "gracePeriodMs",
    optionalInteger(value.gracePeriodMs, "request.gracePeriodMs", 0, 30_000),
  );
  return normalized;
}

export function validateSessionAck(value) {
  assertPlainObject(value, "request");
  assertOnlyKeys(value, new Set(["sessionId", "throughSequence"]), "request");
  return {
    sessionId: validateSessionId(value.sessionId),
    throughSequence: requiredInteger(
      value.throughSequence,
      "request.throughSequence",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export function validateWindowBackgroundColor(value) {
  if (
    typeof value !== "string" ||
    !/^#[0-9A-Fa-f]{6}$/u.test(value)
  ) {
    fail("window background color must be an opaque six-digit hexadecimal color");
  }
  return value.toLocaleLowerCase("en-US");
}

function eventText(
  value,
  name,
  maximumLength = 4_096,
  { allowEmpty = false } = {},
) {
  return boundedString(value, name, maximumLength, { allowEmpty });
}

function eventInteger(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function eventBoolean(value, name) {
  if (typeof value !== "boolean") {
    fail(`${name} must be a boolean`);
  }
  return value;
}

function eventTimestamp(value, name) {
  const normalized = eventText(value, name, 64);
  if (!RFC3339_TIMESTAMP.test(normalized)) {
    fail(`${name} must be an RFC3339 UTC timestamp`);
  }
  return normalized;
}

function eventIdentifier(value, name) {
  const normalized = eventText(value, name, 36);
  if (!SESSION_ID.test(normalized)) {
    fail(`${name} must be a lowercase UUID`);
  }
  return normalized;
}

function assertEventPayloadSize(value, name) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail(`${name} must be JSON serializable`);
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > MAX_EVENT_PAYLOAD_BYTES
  ) {
    fail(`${name} exceeds the ${MAX_EVENT_PAYLOAD_BYTES}-byte limit`);
  }
}

function validateEventError(value, name) {
  assertPlainObject(value, name);
  assertOnlyKeys(value, new Set(["code", "message", "details"]), name);
  eventText(value.code, `${name}.code`, 128);
  eventText(value.message, `${name}.message`, 4_096);
  if (value.details !== undefined) {
    assertPlainObject(value.details, `${name}.details`);
  }
}

function validateCapturedOutput(value, name) {
  assertPlainObject(value, name);
  assertOnlyKeys(
    value,
    new Set(["data", "encoding", "bytes", "truncated"]),
    name,
  );
  eventText(
    value.data,
    `${name}.data`,
    MAX_CAPTURED_OUTPUT_CHARACTERS,
    { allowEmpty: true },
  );
  validateEnum(
    value.encoding,
    `${name}.encoding`,
    SESSION_INPUT_ENCODINGS,
  );
  eventInteger(value.bytes, `${name}.bytes`);
  eventBoolean(value.truncated, `${name}.truncated`);
}

function validateOperationReceipt(value, name) {
  assertPlainObject(value, name);
  assertOnlyKeys(
    value,
    new Set([
      "operationId",
      "context",
      "containerId",
      "domain",
      "resourceId",
      "action",
      "source",
      "outcome",
      "httpStatus",
      "exitCode",
      "startedAt",
      "completedAt",
      "durationMs",
      "endpointHash",
      "stdout",
      "stderr",
    ]),
    name,
  );
  eventIdentifier(value.operationId, `${name}.operationId`);
  eventText(value.context, `${name}.context`, 255);
  eventText(value.action, `${name}.action`, 32);
  eventText(value.source, `${name}.source`, 64);
  const outcome = validateEnum(
    value.outcome,
    `${name}.outcome`,
    OPERATION_OUTCOMES,
  );
  eventTimestamp(value.startedAt, `${name}.startedAt`);
  if (value.containerId !== undefined) {
    const containerId = eventText(
      value.containerId,
      `${name}.containerId`,
      64,
    );
    if (!CONTAINER_ID.test(containerId)) {
      fail(`${name}.containerId must be a full container ID`);
    }
    if (value.domain !== undefined || value.resourceId !== undefined) {
      fail(`${name} must use either containerId or domain/resourceId`);
    }
    if (!COMPLETED_CONTAINER_OUTCOMES.has(outcome)) {
      fail(`${name}.outcome is not valid for a completed container operation`);
    }
    eventTimestamp(value.completedAt, `${name}.completedAt`);
    eventInteger(value.durationMs, `${name}.durationMs`);
  } else {
    validateEnum(
      value.domain,
      `${name}.domain`,
      new Set(["image", "volume"]),
    );
    if (value.resourceId !== undefined) {
      eventText(value.resourceId, `${name}.resourceId`, 4_096);
    }
    if (value.completedAt !== undefined) {
      eventTimestamp(value.completedAt, `${name}.completedAt`);
    }
    if (value.durationMs !== undefined) {
      eventInteger(value.durationMs, `${name}.durationMs`);
    }
  }
  if (value.httpStatus !== undefined) {
    eventInteger(value.httpStatus, `${name}.httpStatus`, 100, 599);
  }
  if (value.exitCode !== undefined) {
    eventInteger(
      value.exitCode,
      `${name}.exitCode`,
      -2_147_483_648,
      2_147_483_647,
    );
  }
  for (const key of ["endpointHash", "stdout", "stderr"]) {
    if (value[key] !== undefined) {
      eventText(
        value[key],
        `${name}.${key}`,
        key === "endpointHash" ? 128 : 1_048_576,
        { allowEmpty: key !== "endpointHash" },
      );
    }
  }
}

function validateCliResult(value, name) {
  assertPlainObject(value, name);
  assertOnlyKeys(
    value,
    new Set([
      "operationId",
      "context",
      "targetMode",
      "executable",
      "argv",
      "cwd",
      "exitCode",
      "timedOut",
      "startedAt",
      "completedAt",
      "durationMs",
      "stdout",
      "stderr",
    ]),
    name,
  );
  eventIdentifier(value.operationId, `${name}.operationId`);
  eventText(value.context, `${name}.context`, 255);
  validateEnum(value.targetMode, `${name}.targetMode`, TARGET_MODES);
  eventText(value.executable, `${name}.executable`, 4_096);
  if (
    !Array.isArray(value.argv) ||
    value.argv.length === 0 ||
    value.argv.length > 1_024
  ) {
    fail(`${name}.argv must contain between 1 and 1024 arguments`);
  }
  value.argv.forEach((argument, index) => {
    eventText(argument, `${name}.argv[${index}]`, 1_048_576, {
      allowEmpty: index > 0,
    });
  });
  eventText(value.cwd, `${name}.cwd`, 4_096);
  eventInteger(
    value.exitCode,
    `${name}.exitCode`,
    -2_147_483_648,
    2_147_483_647,
  );
  eventBoolean(value.timedOut, `${name}.timedOut`);
  eventTimestamp(value.startedAt, `${name}.startedAt`);
  eventTimestamp(value.completedAt, `${name}.completedAt`);
  eventInteger(value.durationMs, `${name}.durationMs`);
  validateCapturedOutput(value.stdout, `${name}.stdout`);
  validateCapturedOutput(value.stderr, `${name}.stderr`);
}

function validateOperationStarted(value) {
  const name = "event.payload";
  assertPlainObject(value, name);
  const method = validateEnum(
    value.method,
    `${name}.method`,
    OPERATION_METHODS,
  );
  const allowed = new Set([
    "operationId",
    "method",
    "context",
    "startedAt",
    "action",
  ]);
  if (method === "containers.action") {
    allowed.add("containerId");
  } else if (method === "cli.run") {
    allowed.add("targetMode");
    allowed.add("argv");
    allowed.add("cwd");
  } else {
    allowed.add("domain");
    allowed.add("resourceId");
    allowed.add("source");
  }
  assertOnlyKeys(value, allowed, name);
  eventIdentifier(value.operationId, `${name}.operationId`);
  eventText(value.context, `${name}.context`, 255);
  eventTimestamp(value.startedAt, `${name}.startedAt`);
  if (method === "containers.action") {
    const containerId = eventText(
      value.containerId,
      `${name}.containerId`,
      64,
    );
    if (!CONTAINER_ID.test(containerId)) {
      fail(`${name}.containerId must be a full container ID`);
    }
    validateEnum(value.action, `${name}.action`, CONTAINER_ACTIONS);
  } else if (method === "cli.run") {
    validateEnum(value.targetMode, `${name}.targetMode`, TARGET_MODES);
    if (
      !Array.isArray(value.argv) ||
      value.argv.length === 0 ||
      value.argv.length > 1_024
    ) {
      fail(`${name}.argv must contain between 1 and 1024 arguments`);
    }
    value.argv.forEach((argument, index) =>
      eventText(argument, `${name}.argv[${index}]`, 1_048_576, {
        allowEmpty: index > 0,
      }),
    );
    eventText(value.cwd, `${name}.cwd`, 4_096);
  } else {
    // Each method reports exactly one domain, and its own action vocabulary. Container
    // export and Compose lifecycle receipts arrive only on this path, never as requests.
    const domainsByMethod = {
      "images.action": "image",
      "containers.export": "container",
      "compose.action": "compose",
    };
    const actionsByMethod = {
      "images.action": IMAGE_ACTIONS,
      "containers.export": new Set(["export"]),
      "compose.action": COMPOSE_ACTIONS,
    };
    const expectedDomain = domainsByMethod[method] ?? "volume";
    if (value.domain !== expectedDomain) {
      fail(`${name}.domain must be ${expectedDomain} for ${method}`);
    }
    validateEnum(
      value.action,
      `${name}.action`,
      actionsByMethod[method] ?? VOLUME_ACTIONS,
    );
    eventText(value.source, `${name}.source`, 64);
    if (value.resourceId !== undefined) {
      eventText(value.resourceId, `${name}.resourceId`, 4_096);
    }
  }
}

function validateOperationCompleted(value) {
  const name = "event.payload";
  assertPlainObject(value, name);
  assertOnlyKeys(value, new Set(["receipt", "result", "error"]), name);
  const hasReceipt = value.receipt !== undefined;
  const hasResult = value.result !== undefined;
  if (hasReceipt === hasResult) {
    fail(`${name} must contain exactly one of receipt or result`);
  }
  if (hasReceipt) {
    validateOperationReceipt(value.receipt, `${name}.receipt`);
  } else {
    validateCliResult(value.result, `${name}.result`);
  }
  if (value.error !== undefined) {
    validateEventError(value.error, `${name}.error`);
  }
}

function validateReconciliation(value, event) {
  const name = "event.payload";
  assertPlainObject(value, name);
  assertOnlyKeys(
    value,
    new Set([
      "operationId",
      "context",
      "domain",
      "resourceId",
      "action",
      "reason",
    ]),
    name,
  );
  eventIdentifier(value.operationId, `${name}.operationId`);
  eventText(value.context, `${name}.context`, 255);
  const domain = validateEnum(
    value.domain,
    `${name}.domain`,
    // compose joined these when Compose lifecycle verbs began reporting receipts.
    new Set(["container", "image", "volume", "compose"]),
  );
  // `export` is a container verb that only ever arrives on a receipt, never as a request, so
  // it is not in CONTAINER_ACTIONS; without it a completed export is rejected at this
  // boundary and the audit trail loses the operation it most needs to record.
  const actions =
    domain === "container"
      ? new Set([...CONTAINER_ACTIONS, "export"])
      : domain === "image"
        ? IMAGE_ACTIONS
        : domain === "compose"
          ? COMPOSE_ACTIONS
          : VOLUME_ACTIONS;
  validateEnum(value.action, `${name}.action`, actions);
  if (value.resourceId !== undefined) {
    eventText(value.resourceId, `${name}.resourceId`, 4_096);
  }
  const reason = validateEnum(
    value.reason,
    `${name}.reason`,
    RECONCILIATION_REASONS,
  );
  const expectedReason =
    event === "reconciliation.requested"
      ? "mutation_completed"
      : "mutation_outcome_unknown";
  if (reason !== expectedReason) {
    fail(`${name}.reason does not match ${event}`);
  }
}

function validateSessionStarted(value) {
  const name = "event.payload";
  assertPlainObject(value, name);
  assertOnlyKeys(
    value,
    new Set([
      "sessionId",
      "mode",
      "pid",
      "context",
      "targetMode",
      "executable",
      "argv",
      "cwd",
      "rows",
      "cols",
      "outputWindowBytes",
      "maxOutputBytes",
      "startedAt",
      "state",
    ]),
    name,
  );
  eventIdentifier(value.sessionId, `${name}.sessionId`);
  const mode = validateEnum(value.mode, `${name}.mode`, SESSION_MODES);
  eventInteger(value.pid, `${name}.pid`, 1);
  eventText(value.context, `${name}.context`, 255);
  validateEnum(value.targetMode, `${name}.targetMode`, TARGET_MODES);
  eventText(value.executable, `${name}.executable`, 4_096);
  if (
    !Array.isArray(value.argv) ||
    value.argv.length === 0 ||
    value.argv.length > 1_024
  ) {
    fail(`${name}.argv must contain between 1 and 1024 arguments`);
  }
  value.argv.forEach((argument, index) =>
    eventText(argument, `${name}.argv[${index}]`, 1_048_576, {
      allowEmpty: index > 0,
    }),
  );
  eventText(value.cwd, `${name}.cwd`, 4_096);
  if (mode === "pty") {
    eventInteger(value.rows, `${name}.rows`, 1, 1_000);
    eventInteger(value.cols, `${name}.cols`, 1, 1_000);
  } else if (value.rows !== undefined || value.cols !== undefined) {
    fail(`${name}.rows and cols are only valid for pty sessions`);
  }
  eventInteger(
    value.outputWindowBytes,
    `${name}.outputWindowBytes`,
    1_024,
    8_388_608,
  );
  eventInteger(value.maxOutputBytes, `${name}.maxOutputBytes`);
  eventTimestamp(value.startedAt, `${name}.startedAt`);
  if (value.state !== "running") {
    fail(`${name}.state must be running`);
  }
}

function validateSessionOutput(value) {
  const name = "event.payload";
  assertPlainObject(value, name);
  assertOnlyKeys(
    value,
    new Set(["sessionId", "sequence", "stream", "data", "encoding", "bytes"]),
    name,
  );
  eventIdentifier(value.sessionId, `${name}.sessionId`);
  eventInteger(value.sequence, `${name}.sequence`, 1);
  validateEnum(value.stream, `${name}.stream`, SESSION_OUTPUT_STREAMS);
  const encoding = validateEnum(
    value.encoding,
    `${name}.encoding`,
    SESSION_INPUT_ENCODINGS,
  );
  const data = eventText(value.data, `${name}.data`, 1_048_576, {
    allowEmpty: true,
  });
  const bytes = eventInteger(value.bytes, `${name}.bytes`, 1, 1_048_576);
  const representedBytes =
    encoding === "base64"
      ? strictBase64ByteLength(data)
      : Buffer.byteLength(data, "utf8");
  if (representedBytes !== bytes) {
    fail(`${name}.bytes must match the represented data`);
  }
}

function validateSessionTruncated(value) {
  const name = "event.payload";
  assertPlainObject(value, name);
  assertOnlyKeys(
    value,
    new Set(["sessionId", "maxOutputBytes", "droppedBytes"]),
    name,
  );
  eventIdentifier(value.sessionId, `${name}.sessionId`);
  eventInteger(value.maxOutputBytes, `${name}.maxOutputBytes`);
  eventInteger(value.droppedBytes, `${name}.droppedBytes`, 1);
}

function validateSessionError(value) {
  const name = "event.payload";
  assertPlainObject(value, name);
  assertOnlyKeys(
    value,
    new Set(["sessionId", "code", "message", "stream"]),
    name,
  );
  eventIdentifier(value.sessionId, `${name}.sessionId`);
  eventText(value.code, `${name}.code`, 128);
  eventText(value.message, `${name}.message`, 4_096);
  if (value.stream !== undefined) {
    validateEnum(value.stream, `${name}.stream`, SESSION_OUTPUT_STREAMS);
  }
}

function validateSessionExited(value) {
  const name = "event.payload";
  assertPlainObject(value, name);
  assertOnlyKeys(
    value,
    new Set([
      "sessionId",
      "state",
      "exitCode",
      "signal",
      "timedOut",
      "canceled",
      "startedAt",
      "exitedAt",
      "durationMs",
      "output",
    ]),
    name,
  );
  eventIdentifier(value.sessionId, `${name}.sessionId`);
  if (value.state !== "exited") {
    fail(`${name}.state must be exited`);
  }
  eventInteger(
    value.exitCode,
    `${name}.exitCode`,
    -2_147_483_648,
    2_147_483_647,
  );
  if (value.signal !== undefined) {
    eventText(value.signal, `${name}.signal`, 64);
  }
  eventBoolean(value.timedOut, `${name}.timedOut`);
  eventBoolean(value.canceled, `${name}.canceled`);
  eventTimestamp(value.startedAt, `${name}.startedAt`);
  eventTimestamp(value.exitedAt, `${name}.exitedAt`);
  eventInteger(value.durationMs, `${name}.durationMs`);
  assertPlainObject(value.output, `${name}.output`);
  assertOnlyKeys(
    value.output,
    new Set([
      "stdoutBytes",
      "stderrBytes",
      "ptyBytes",
      "emittedBytes",
      "droppedBytes",
      "truncated",
      "lastSequence",
    ]),
    `${name}.output`,
  );
  for (const key of [
    "stdoutBytes",
    "stderrBytes",
    "ptyBytes",
    "emittedBytes",
    "droppedBytes",
    "lastSequence",
  ]) {
    eventInteger(value.output[key], `${name}.output.${key}`);
  }
  eventBoolean(value.output.truncated, `${name}.output.truncated`);
}

const CORE_EVENT_VALIDATORS = new Map([
  ["operation.started", validateOperationStarted],
  ["operation.completed", validateOperationCompleted],
  [
    "reconciliation.requested",
    (payload) => validateReconciliation(payload, "reconciliation.requested"),
  ],
  [
    "reconciliation.required",
    (payload) => validateReconciliation(payload, "reconciliation.required"),
  ],
  ["session.started", validateSessionStarted],
  ["session.output", validateSessionOutput],
  ["session.output.truncated", validateSessionTruncated],
  ["session.error", validateSessionError],
  ["session.exited", validateSessionExited],
]);

export function validateCoreEventName(value) {
  if (typeof value !== "string" || !CORE_EVENTS.includes(value)) {
    fail(`event must be one of: ${CORE_EVENTS.join(", ")}`);
  }
  return value;
}

export function validateCoreEventEnvelope(event, payload) {
  const normalizedEvent = validateCoreEventName(event);
  assertEventPayloadSize(payload, "event.payload");
  CORE_EVENT_VALIDATORS.get(normalizedEvent)(payload);
  return { event: normalizedEvent, payload };
}

export function validateRendererEventEnvelope(event, payload) {
  if (CORE_EVENTS.includes(event)) {
    return validateCoreEventEnvelope(event, payload);
  }
  if (event === "window.maximized") {
    eventBoolean(payload, "event.payload");
    return { event, payload };
  }
  if (event === "core.status") {
    assertEventPayloadSize(payload, "event.payload");
    assertPlainObject(payload, "event.payload");
    assertOnlyKeys(
      payload,
      new Set([
        "state",
        "attempt",
        "pid",
        "health",
        "error",
        "code",
        "signal",
        "stderrTail",
        "delayMs",
      ]),
      "event.payload",
    );
    validateEnum(payload.state, "event.payload.state", CORE_STATUS_STATES);
    for (const key of ["attempt", "pid", "delayMs"]) {
      if (payload[key] !== undefined) {
        eventInteger(payload[key], `event.payload.${key}`);
      }
    }
    if (payload.error !== undefined) {
      validateEventError(payload.error, "event.payload.error");
    }
    if (payload.code !== undefined && payload.code !== null) {
      eventInteger(
        payload.code,
        "event.payload.code",
        -2_147_483_648,
        2_147_483_647,
      );
    }
    if (payload.signal !== undefined && payload.signal !== null) {
      eventText(payload.signal, "event.payload.signal", 64);
    }
    if (payload.stderrTail !== undefined) {
      if (
        !Array.isArray(payload.stderrTail) ||
        payload.stderrTail.length > 1_024
      ) {
        fail("event.payload.stderrTail must be a bounded array");
      }
      payload.stderrTail.forEach((line, index) =>
        eventText(
          line,
          `event.payload.stderrTail[${index}]`,
          4_096,
          { allowEmpty: true },
        ),
      );
    }
    if (payload.health !== undefined) {
      assertPlainObject(payload.health, "event.payload.health");
      if (
        payload.health.status !== "ok" ||
        payload.health.protocolVersion !== "1" ||
        payload.health.pid !== payload.pid ||
        typeof payload.health.dockerReady !== "boolean"
      ) {
        fail("event.payload.health is incompatible with the ready core status");
      }
    }
    return { event, payload };
  }
  fail(`event must be one of: ${RENDERER_EVENTS.join(", ")}`);
}

export function normalizeRpcError(value) {
  if (typeof value === "string") {
    return { code: "CORE_ERROR", message: value.slice(0, 4_096) };
  }

  if (!isPlainObject(value)) {
    return { code: "CORE_ERROR", message: "The Anchorage core returned an invalid error" };
  }

  const code =
    typeof value.code === "string" && value.code.length > 0
      ? value.code.slice(0, 128)
      : "CORE_ERROR";
  const message =
    typeof value.message === "string" && value.message.length > 0
      ? value.message.slice(0, 4_096)
      : "The Anchorage core request failed";

  let details;
  if (isPlainObject(value.details)) {
    try {
      const serialized = JSON.stringify(value.details);
      if (serialized.length <= 65_536) {
        details = JSON.parse(serialized);
      }
    } catch {
      // Invalid diagnostic details are omitted; the stable code and message remain.
    }
  }

  return details === undefined ? { code, message } : { code, message, details };
}
