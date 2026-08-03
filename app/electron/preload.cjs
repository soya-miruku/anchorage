"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = Object.freeze({
  systemCapabilities: "anchorage:system.capabilities",
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
  composeList: "anchorage:compose.list",
  composePs: "anchorage:compose.ps",
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

const EVENTS = new Set([
  "core.status",
  "operation.started",
  "operation.completed",
  "reconciliation.requested",
  "reconciliation.required",
  "session.started",
  "session.output",
  "session.output.truncated",
  "session.error",
  "session.exited",
  "window.maximized",
]);

const ACTIONS = new Set([
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
const MAX_SESSION_INPUT_BYTES = 256 * 1_024;
const IMAGE_ACTIONS = new Set([
  "remove",
  "prune",
  "pull",
  "save",
  "load",
  "tag",
]);
const VOLUME_ACTIONS = new Set(["create", "remove", "prune"]);
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

function plainObject(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["[object Object]", "[object Null]"].includes(Object.prototype.toString.call(value))
  ) {
    fail(`${name} must be a plain object`);
  }
}

function onlyKeys(value, keys, name) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      fail(`${name}.${key} is not supported`);
    }
  }
}

function text(value, name, maximum, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    value.includes("\u0000")
  ) {
    fail(`${name} is invalid`);
  }
  return value;
}

function windowBackgroundColor(value) {
  if (
    typeof value !== "string" ||
    !/^#[0-9A-Fa-f]{6}$/u.test(value)
  ) {
    fail("window background color must be an opaque six-digit hexadecimal color");
  }
  return value.toLocaleLowerCase("en-US");
}

function optionalBoolean(value, name) {
  if (value !== undefined && typeof value !== "boolean") {
    fail(`${name} must be a boolean`);
  }
  return value;
}

function optionalInteger(value, name, minimum, maximum) {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < minimum || value > maximum)
  ) {
    fail(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function copyDefined(target, key, value) {
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

function context(value, required = true) {
  if (value === undefined && !required) {
    return undefined;
  }
  const result = text(value, "request.context", 255).trim();
  if (result.length === 0 || result.includes("\r") || result.includes("\n")) {
    fail("request.context must identify an explicit Docker context");
  }
  return result;
}

function systemCapabilities(value) {
  if (value === undefined) {
    return {};
  }
  plainObject(value, "request");
  onlyKeys(value, new Set(["context"]), "request");
  const selectedContext = context(value.context, false);
  return selectedContext === undefined ? {} : { context: selectedContext };
}

function containersList(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context", "all"]), "request");
  const normalized = { context: context(value.context) };
  copyDefined(normalized, "all", optionalBoolean(value.all, "request.all"));
  return normalized;
}

function systemSnapshot(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context", "includeDiskUsage"]), "request");
  const normalized = { context: context(value.context) };
  copyDefined(
    normalized,
    "includeDiskUsage",
    optionalBoolean(value.includeDiskUsage, "request.includeDiskUsage"),
  );
  return normalized;
}

function systemAction(value) {
  plainObject(value, "request");
  onlyKeys(
    value,
    new Set(["context", "action", "all", "volumes", "confirmed"]),
    "request",
  );
  const action = text(value.action, "request.action", 32);
  if (action !== "prune") {
    fail("request.action must be prune");
  }
  if (value.confirmed !== true) {
    fail("request.confirmed must be true for system prune");
  }
  const normalized = {
    context: context(value.context),
    action,
    confirmed: true,
  };
  copyDefined(normalized, "all", optionalBoolean(value.all, "request.all"));
  copyDefined(
    normalized,
    "volumes",
    optionalBoolean(value.volumes, "request.volumes"),
  );
  return normalized;
}

const NETWORK_ACTIONS = new Set([
  "create",
  "remove",
  "prune",
  "connect",
  "disconnect",
]);
const NETWORK_ID = /^[A-Fa-f0-9]{12,64}$/u;
// Mirrors Docker's own network-name grammar. The leading class excludes '-' so a name can
// never be read as a flag by the CLI transport.
const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const NETWORK_PRUNE_FILTERS = new Set(["until", "label"]);

function networksList(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context"]), "request");
  return { context: context(value.context) };
}

function networksAction(value) {
  plainObject(value, "request");
  onlyKeys(
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
  const action = text(value.action, "request.action", 32);
  if (!NETWORK_ACTIONS.has(action)) {
    fail("request.action is not a supported network action");
  }
  const normalized = { context: context(value.context), action };

  if (action === "create") {
    const name = text(value.name, "request.name", 255);
    if (!NETWORK_NAME.test(name)) {
      fail("request.name is not a valid Docker network name");
    }
    normalized.name = name;
    copyDefined(normalized, "driver", value.driver === undefined ? undefined : text(value.driver, "request.driver", 64));
    copyDefined(normalized, "subnet", value.subnet === undefined ? undefined : text(value.subnet, "request.subnet", 64));
    copyDefined(normalized, "gateway", value.gateway === undefined ? undefined : text(value.gateway, "request.gateway", 64));
    copyDefined(normalized, "internal", optionalBoolean(value.internal, "request.internal"));
    copyDefined(
      normalized,
      "attachable",
      optionalBoolean(value.attachable, "request.attachable"),
    );
    copyDefined(
      normalized,
      "enableIpv6",
      optionalBoolean(value.enableIpv6, "request.enableIpv6"),
    );
    copyDefined(normalized, "labels", stringMap(value.labels, "request.labels"));
    copyDefined(normalized, "options", stringMap(value.options, "request.options"));
    return normalized;
  }

  if (action === "prune") {
    if (value.confirmed !== true) {
      fail("request.confirmed must be true for network prune");
    }
    normalized.confirmed = true;
    copyDefined(
      normalized,
      "filters",
      filters(value.filters, "request.filters", NETWORK_PRUNE_FILTERS),
    );
    return normalized;
  }

  const id = text(value.id, "request.id", 64);
  if (!NETWORK_ID.test(id)) {
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

  const containerId = text(value.containerId, "request.containerId", 64);
  if (!CONTAINER_ID.test(containerId)) {
    fail("request.containerId must be a full 64-character hexadecimal container ID");
  }
  normalized.containerId = containerId;
  copyDefined(normalized, "force", optionalBoolean(value.force, "request.force"));
  return normalized;
}

function containerIdentity(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context", "id"]), "request");
  const id = text(value.id, "request.id", 64);
  if (!CONTAINER_ID.test(id)) {
    fail("request.id must be a full 64-character hexadecimal container ID");
  }
  return { context: context(value.context), id };
}

function containerAction(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context", "id", "action", "options"]), "request");
  const id = text(value.id, "request.id", 256);
  const action = text(value.action, "request.action", 32);
  if (!CONTAINER_ID.test(id) || !ACTIONS.has(action)) {
    fail("request contains an invalid container id or action");
  }

  const normalized = { context: context(value.context), id, action };
  if (value.options === undefined) {
    if (action === "remove") {
      fail("confirmed must be true for remove");
    }
    return normalized;
  }

  plainObject(value.options, "request.options");
  onlyKeys(
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
  copyDefined(
    options,
    "timeoutSeconds",
    optionalInteger(value.options.timeoutSeconds, "request.options.timeoutSeconds", 0, 600),
  );
  copyDefined(options, "force", optionalBoolean(value.options.force, "request.options.force"));
  copyDefined(
    options,
    "volumes",
    optionalBoolean(value.options.volumes, "request.options.volumes"),
  );
  copyDefined(
    options,
    "confirmed",
    optionalBoolean(value.options.confirmed, "request.options.confirmed"),
  );
  if (value.options.signal !== undefined) {
    const signal = text(value.options.signal, "request.options.signal", 20);
    if (action !== "kill") {
      fail("signal is only valid for kill");
    }
    if (!CONTAINER_SIGNAL.test(signal)) {
      fail("request.options.signal must be an uppercase signal name or number");
    }
    options.signal = signal;
  }
  if (value.name !== undefined) {
    const containerName = text(value.name, "request.options.name", 255);
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
    const policy = text(value.restartPolicy, "request.options.restartPolicy", 32);
    if (!RESTART_POLICIES.has(policy)) {
      fail("request.options.restartPolicy is not supported");
    }
    options.restartPolicy = policy;
  }
  if (action !== "remove" && (options.force || options.volumes)) {
    fail("force and volumes are only valid for remove");
  }
  if (
    (action === "pause" || action === "unpause" || action === "start") &&
    Object.keys(options).length > 0
  ) {
    fail(`options are not valid for ${action}`);
  }
  if (action === "kill" && options.timeoutSeconds !== undefined) {
    fail("timeoutSeconds is not valid for kill");
  }
  if (action === "remove" && options.timeoutSeconds !== undefined) {
    fail("timeoutSeconds is not valid for remove");
  }
  if (action === "remove" && options.confirmed !== true) {
    fail("confirmed must be true for remove");
  }
  if (action !== "remove" && options.confirmed === true) {
    fail("confirmed is only valid for remove");
  }
  if (Object.keys(options).length > 0) {
    normalized.options = options;
  }
  return normalized;
}

const RESTART_POLICIES = new Set(["no", "always", "unless-stopped", "on-failure"]);
const NUMERIC_PORT = /^[0-9]{1,5}$/u;
const CONTAINER_PORT = /^[0-9]{1,5}(\/(tcp|udp|sctp))?$/u;
const DOCKER_OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;

function containersCreate(value) {
  plainObject(value, "request");
  onlyKeys(
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
  const image = text(value.image, "request.image", 2048);
  // A leading '-' would let an image reference be read as a flag downstream.
  if (image.startsWith("-")) {
    fail("request.image must not begin with '-'");
  }
  const normalized = { context: context(value.context), image };

  if (value.name !== undefined) {
    const name = text(value.name, "request.name", 255);
    if (!DOCKER_OBJECT_NAME.test(name)) {
      fail("request.name is not a valid Docker container name");
    }
    normalized.name = name;
  }
  if (value.network !== undefined) {
    const network = text(value.network, "request.network", 255);
    if (!DOCKER_OBJECT_NAME.test(network)) {
      fail("request.network is not a valid Docker network name");
    }
    normalized.network = network;
  }
  if (value.restartPolicy !== undefined) {
    const policy = text(value.restartPolicy, "request.restartPolicy", 32);
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
      text(entry, `request.${key}[${index}]`, 4096),
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
    plainObject(value.ports, "request.ports");
    const entries = Object.entries(value.ports);
    if (entries.length > 128) {
      fail("request.ports must contain at most 128 entries");
    }
    const ports = {};
    for (const [host, target] of entries) {
      if (!NUMERIC_PORT.test(host)) {
        fail("request.ports keys must be numeric host ports");
      }
      const container = text(target, `request.ports.${host}`, 16);
      if (!CONTAINER_PORT.test(container)) {
        fail("request.ports values must be a port with an optional tcp/udp/sctp protocol");
      }
      ports[host] = container;
    }
    normalized.ports = ports;
  }
  copyDefined(normalized, "labels", stringMap(value.labels, "request.labels"));
  copyDefined(
    normalized,
    "autoRemove",
    optionalBoolean(value.autoRemove, "request.autoRemove"),
  );
  copyDefined(normalized, "start", optionalBoolean(value.start, "request.start"));
  return normalized;
}

function containersStatsBatch(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context", "ids"]), "request");
  if (!Array.isArray(value.ids) || value.ids.length > 64) {
    fail("request.ids must be an array of at most 64 container IDs");
  }
  const seen = new Set();
  const ids = value.ids.map((entry, index) => {
    const id = text(entry, `request.ids[${index}]`, 64);
    if (!CONTAINER_ID.test(id)) {
      fail("request.ids entries must be full 64-character hexadecimal container IDs");
    }
    if (seen.has(id)) {
      fail("request.ids must not contain duplicates");
    }
    seen.add(id);
    return id;
  });
  return { context: context(value.context), ids };
}

function imagesInspect(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context", "id"]), "request");
  const id = text(value.id, "request.id", 71);
  if (!IMAGE_ID.test(id)) {
    fail("request.id must be a full sha256 image ID");
  }
  return { context: context(value.context), id };
}

// Container paths become an Engine query parameter, so they are validated as strictly here as
// in the core: absolute, no traversal, no control characters.
const CONTAINER_PATH = /^\/[^\u0000\r\n]{0,4095}$/u;

function containerFiles(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context", "id", "path"]), "request");
  const id = text(value.id, "request.id", 64);
  if (!CONTAINER_ID.test(id)) {
    fail("request.id must be a full 64-character hexadecimal container ID");
  }
  const normalized = { context: context(value.context), id };
  if (value.path !== undefined) {
    const target = text(value.path, "request.path", 4096);
    if (!CONTAINER_PATH.test(target) || target.split("/").includes("..")) {
      fail("request.path must be an absolute container path without relative segments");
    }
    normalized.path = target;
  }
  return normalized;
}

function containerFileRead(value) {
  const normalized = containerFiles(value);
  if (normalized.path === undefined) {
    fail("request.path is required to read a container file");
  }
  return normalized;
}

function containerFileWrite(value) {
  plainObject(value, "request");
  onlyKeys(
    value,
    new Set(["context", "id", "path", "name", "content", "mode"]),
    "request",
  );
  const id = text(value.id, "request.id", 64);
  if (!CONTAINER_ID.test(id)) {
    fail("request.id must be a full 64-character hexadecimal container ID");
  }
  const target = text(value.path, "request.path", 4096);
  if (!CONTAINER_PATH.test(target) || target.split("/").includes("..")) {
    fail("request.path must be an absolute container path without relative segments");
  }
  // The name becomes a tar entry path; a separator would let the upload escape the directory.
  const name = text(value.name, "request.name", 255);
  if (/[/\\\u0000]/u.test(name) || name === "." || name === "..") {
    fail("request.name must be a single path segment");
  }
  const content = text(value.content, "request.content", 4 * 1024 * 1024, true);
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(content)) {
    fail("request.content must be base64-encoded");
  }
  const normalized = { context: context(value.context), id, path: target, name, content };
  copyDefined(
    normalized,
    "mode",
    optionalInteger(value.mode, "request.mode", 1, 511),
  );
  return normalized;
}

function imagesSearch(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context", "term", "limit"]), "request");
  const term = text(value.term, "request.term", 255);
  if (/[\u0000\r\n]/u.test(term)) {
    fail("request.term contains a control character");
  }
  const normalized = { context: context(value.context), term };
  copyDefined(normalized, "limit", optionalInteger(value.limit, "request.limit", 1, 100));
  return normalized;
}

function containersCommit(value) {
  plainObject(value, "request");
  onlyKeys(
    value,
    new Set(["context", "id", "repository", "tag", "comment", "author", "pause", "changes"]),
    "request",
  );
  const id = text(value.id, "request.id", 64);
  if (!CONTAINER_ID.test(id)) {
    fail("request.id must be a full 64-character hexadecimal container ID");
  }
  const repository = text(value.repository, "request.repository", 2048);
  // A leading '-' would let the target be read as a flag downstream.
  if (repository.startsWith("-")) {
    fail("request.repository must not begin with '-'");
  }
  const normalized = { context: context(value.context), id, repository };
  if (value.tag !== undefined) {
    const tag = text(value.tag, "request.tag", 255);
    if (tag.startsWith("-")) {
      fail("request.tag must not begin with '-'");
    }
    normalized.tag = tag;
  }
  for (const key of ["comment", "author"]) {
    if (value[key] === undefined) continue;
    normalized[key] = text(value[key], `request.${key}`, 1024, true);
  }
  copyDefined(normalized, "pause", optionalBoolean(value.pause, "request.pause"));
  if (value.changes !== undefined) {
    if (!Array.isArray(value.changes) || value.changes.length > 64) {
      fail("request.changes must be an array of at most 64 entries");
    }
    normalized.changes = value.changes.map((entry, index) =>
      text(entry, `request.changes[${index}]`, 1024),
    );
  }
  return normalized;
}

function targetMode(value) {
  return value === undefined
    ? "pinned"
    : enumValue(value, "request.targetMode", TARGET_MODES);
}

function dockerArgv(value, selectedTargetMode) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_024) {
    fail("request.argv must contain between 1 and 1024 arguments");
  }

  const argv = value.map((argument, index) => {
    return text(argument, `request.argv[${index}]`, 1_048_576, index > 0);
  });
  if (selectedTargetMode === "pinned") {
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
  if (selectedTargetMode === "literal") {
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
    fail("request.argv must start with a Docker command");
  }
  return argv;
}

function cwd(value) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = text(value, "request.cwd", 4_096);
  if (!ABSOLUTE_PATH.test(normalized)) {
    fail("request.cwd must be absolute");
  }
  return normalized;
}

/**
 * A host path for save/load/export. The core owns the allowlist decision about where an
 * archive may land; this rejects the shapes that would be misread before reaching it — a
 * leading '-' becomes a flag, and a newline would split the operation's audit log line.
 */
function archivePath(value, field = "request.archivePath") {
  const normalized = text(value, field, 4_096);
  if (normalized.startsWith("-")) {
    fail(`${field} must not begin with '-'`);
  }
  if (!ABSOLUTE_PATH.test(normalized)) {
    fail(`${field} must be absolute`);
  }
  if (/[\u0000\r\n]/u.test(normalized)) {
    fail(`${field} contains a control character`);
  }
  return normalized;
}

const COMPOSE_ACTIONS = new Set(["up", "down", "start", "stop", "restart"]);
// Compose lowercases project names; the leading character cannot be punctuation. The value
// becomes an argv element and a label selector, so the shape is enforced, not assumed.
const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_.-]{0,254}$/u;

function volumeName(value) {
  const name = text(value, "request.name", 255);
  if (!VOLUME_NAME.test(name)) {
    fail("request.name must be a Docker volume name");
  }
  return name;
}

const VOLUME_BROWSE_PATH = /^\/[^\u0000\r\n]*$/u;

function imagesScout(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context", "reference"]), "request");
  const reference = text(value.reference, "request.reference", 2_048);
  // Scout takes a tag or an immutable image ID; either way it becomes an argv element.
  if (reference.startsWith("-") || /[\u0000\r\n\t ]/u.test(reference)) {
    fail("request.reference must be a single non-option Docker reference");
  }
  return { context: context(value.context), reference };
}

function volumeFiles(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context", "name", "path"]), "request");
  const normalized = {
    context: context(value.context),
    name: volumeName(value.name),
  };
  if (value.path !== undefined) {
    const target = text(value.path, "request.path", 4_096);
    if (!VOLUME_BROWSE_PATH.test(target) || target.split("/").includes("..")) {
      fail("request.path must be an absolute path inside the volume");
    }
    normalized.path = target;
  }
  return normalized;
}

function volumeFileRead(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context", "name", "path"]), "request");
  const target = text(value.path, "request.path", 4_096);
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
    context: context(value.context),
    name: volumeName(value.name),
    path: target,
  };
}

function composeList(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context", "all"]), "request");
  const normalized = { context: context(value.context) };
  copyDefined(normalized, "all", optionalBoolean(value.all, "request.all"));
  return normalized;
}

function composeProject(value) {
  const project = text(value, "request.project", 255);
  if (!COMPOSE_PROJECT.test(project)) {
    fail("request.project must be a Compose project name");
  }
  return project;
}

function composePs(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context", "project"]), "request");
  return {
    context: context(value.context),
    project: composeProject(value.project),
  };
}

function composeAction(value) {
  plainObject(value, "request");
  onlyKeys(
    value,
    new Set([
      "context",
      "project",
      "action",
      "configFiles",
      "confirmed",
      "removeVolumes",
      "removeOrphans",
      "timeoutSeconds",
      "outputWindowBytes",
    ]),
    "request",
  );
  const action = enumValue(value.action, "request.action", COMPOSE_ACTIONS);
  const normalized = {
    context: context(value.context),
    project: composeProject(value.project),
    action,
  };
  if (value.configFiles !== undefined) {
    if (!Array.isArray(value.configFiles) || value.configFiles.length === 0 ||
        value.configFiles.length > 32) {
      fail("request.configFiles must be an array of 1 to 32 paths");
    }
    normalized.configFiles = value.configFiles.map((entry, index) => {
      const file = text(entry, `request.configFiles[${index}]`, 4_096);
      // The path becomes an argv element beside -f; a leading '-' would read as a flag.
      if (file.startsWith("-") || /[\u0000\r\n]/u.test(file)) {
        fail(`request.configFiles[${index}] must be a plain file path`);
      }
      return file;
    });
  }
  copyDefined(normalized, "confirmed", optionalBoolean(value.confirmed, "request.confirmed"));
  copyDefined(
    normalized,
    "removeVolumes",
    optionalBoolean(value.removeVolumes, "request.removeVolumes"),
  );
  copyDefined(
    normalized,
    "removeOrphans",
    optionalBoolean(value.removeOrphans, "request.removeOrphans"),
  );
  copyDefined(
    normalized,
    "timeoutSeconds",
    optionalInteger(value.timeoutSeconds, "request.timeoutSeconds", 0, 86_400),
  );
  copyDefined(
    normalized,
    "outputWindowBytes",
    optionalInteger(value.outputWindowBytes, "request.outputWindowBytes", 1_024, 8_388_608),
  );

  if (action === "up") {
    // Compose finds existing containers by label, but recreating them needs the file.
    if (!normalized.configFiles) {
      fail("request.configFiles is required for compose up");
    }
    if (normalized.confirmed === true || normalized.removeVolumes === true) {
      fail("request contains options that are not valid for compose up");
    }
  } else if (action === "down") {
    if (normalized.confirmed !== true) {
      fail("request.confirmed must be true for compose down");
    }
    if (normalized.configFiles !== undefined) {
      fail("compose down finds the project by label and takes no configuration files");
    }
  } else if (
    normalized.configFiles !== undefined ||
    normalized.confirmed === true ||
    normalized.removeVolumes === true ||
    normalized.removeOrphans === true
  ) {
    fail(`request contains options that are not valid for compose ${action}`);
  }
  return normalized;
}

function containersExport(value) {
  plainObject(value, "request");
  onlyKeys(
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
  const id = text(value.id, "request.id", 64);
  if (!CONTAINER_ID.test(id)) {
    fail("request.id must be a full 64-character hexadecimal container ID");
  }
  const normalized = {
    context: context(value.context),
    id,
    archivePath: archivePath(value.archivePath),
  };
  copyDefined(
    normalized,
    "overwrite",
    optionalBoolean(value.overwrite, "request.overwrite"),
  );
  copyDefined(normalized, "cwd", cwd(value.cwd));
  copyDefined(
    normalized,
    "timeoutSeconds",
    optionalInteger(value.timeoutSeconds, "request.timeoutSeconds", 0, 86_400),
  );
  copyDefined(
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

function environment(value, selectedTargetMode) {
  if (value === undefined) {
    return undefined;
  }
  plainObject(value, "request.env");
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
      (selectedTargetMode === "pinned" &&
        DOCKER_TARGET_ENVIRONMENT_KEYS.has(canonicalKey))
    ) {
      fail(`request.env.${key} is not permitted`);
    }
    normalizedEntries.push([
      key,
      text(rawValue, `request.env.${key}`, 1_048_576, true),
    ]);
  }
  return Object.fromEntries(normalizedEntries);
}

function sessionId(value) {
  const normalized = text(value, "request.sessionId", 36);
  if (!SESSION_ID.test(normalized)) {
    fail("request.sessionId must be a lowercase UUID");
  }
  return normalized;
}

function enumValue(value, name, allowed) {
  const normalized = text(value, name, 32);
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

function filters(value, name, allowed) {
  if (value === undefined) {
    return undefined;
  }
  plainObject(value, name);
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
      const item = text(rawValue, `${name}.${key}[${index}]`, 4_096);
      if (/[\u0000\r\n]/u.test(item)) {
        fail(`${name}.${key}[${index}] contains unsupported control characters`);
      }
      return item;
    });
  }
  return normalized;
}

function stringMap(value, name) {
  if (value === undefined) {
    return undefined;
  }
  plainObject(value, name);
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
    const item = text(rawValue, `${name}.${key}`, 65_536, true);
    if (/[\u0000\r\n]/u.test(item)) {
      fail(`${name}.${key} contains unsupported control characters`);
    }
    normalizedEntries.push([key, item]);
  }
  return Object.fromEntries(normalizedEntries);
}

function imagesList(value) {
  plainObject(value, "request");
  onlyKeys(
    value,
    new Set(["context", "all", "includeDangling"]),
    "request",
  );
  const normalized = { context: context(value.context) };
  copyDefined(normalized, "all", optionalBoolean(value.all, "request.all"));
  copyDefined(
    normalized,
    "includeDangling",
    optionalBoolean(value.includeDangling, "request.includeDangling"),
  );
  return normalized;
}

function imagesAction(value) {
  plainObject(value, "request");
  onlyKeys(
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
  const action = enumValue(value.action, "request.action", IMAGE_ACTIONS);
  const normalized = {
    context: context(value.context),
    action,
  };
  if (value.id !== undefined) {
    const id = text(value.id, "request.id", 71);
    if (!IMAGE_ID.test(id)) {
      fail("request.id must be a full immutable sha256 image ID");
    }
    normalized.id = id;
  }
  if (value.reference !== undefined) {
    const reference = text(value.reference, "request.reference", 2_048);
    if (reference.startsWith("-") || /[\u0000\r\n\t ]/u.test(reference)) {
      fail("request.reference must be a single non-option Docker reference");
    }
    normalized.reference = reference;
  }
  copyDefined(
    normalized,
    "overwrite",
    optionalBoolean(value.overwrite, "request.overwrite"),
  );
  if (value.archivePath !== undefined) {
    normalized.archivePath = archivePath(value.archivePath);
  }
  copyDefined(normalized, "force", optionalBoolean(value.force, "request.force"));
  copyDefined(
    normalized,
    "noPrune",
    optionalBoolean(value.noPrune, "request.noPrune"),
  );
  const allowedFilters = action === "prune" ? IMAGE_PRUNE_FILTERS : new Set();
  copyDefined(
    normalized,
    "filters",
    filters(value.filters, "request.filters", allowedFilters),
  );
  copyDefined(
    normalized,
    "confirmed",
    optionalBoolean(value.confirmed, "request.confirmed"),
  );
  copyDefined(normalized, "cwd", cwd(value.cwd));
  copyDefined(
    normalized,
    "timeoutSeconds",
    optionalInteger(value.timeoutSeconds, "request.timeoutSeconds", 0, 86_400),
  );
  copyDefined(
    normalized,
    "outputWindowBytes",
    optionalInteger(
      value.outputWindowBytes,
      "request.outputWindowBytes",
      1_024,
      8_388_608,
    ),
  );
  copyDefined(
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

function volumesList(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["context"]), "request");
  return { context: context(value.context) };
}

function volumesAction(value) {
  plainObject(value, "request");
  onlyKeys(
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
  const action = enumValue(value.action, "request.action", VOLUME_ACTIONS);
  const normalized = {
    context: context(value.context),
    action,
  };
  if (value.name !== undefined) {
    const name = text(value.name, "request.name", 255);
    if (!VOLUME_NAME.test(name)) {
      fail("request.name contains unsupported volume-name characters");
    }
    normalized.name = name;
  }
  if (value.driver !== undefined) {
    normalized.driver = text(value.driver, "request.driver", 4_096, true);
  }
  copyDefined(
    normalized,
    "driverOpts",
    stringMap(value.driverOpts, "request.driverOpts"),
  );
  copyDefined(normalized, "labels", stringMap(value.labels, "request.labels"));
  copyDefined(normalized, "force", optionalBoolean(value.force, "request.force"));
  const allowedFilters = action === "prune" ? VOLUME_PRUNE_FILTERS : new Set();
  copyDefined(
    normalized,
    "filters",
    filters(value.filters, "request.filters", allowedFilters),
  );
  copyDefined(
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

function cliRun(value) {
  plainObject(value, "request");
  onlyKeys(
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

  const selectedTargetMode = targetMode(value.targetMode);
  const normalized = {
    context: context(value.context),
    targetMode: selectedTargetMode,
    argv: dockerArgv(value.argv, selectedTargetMode),
  };
  copyDefined(normalized, "cwd", cwd(value.cwd));
  copyDefined(normalized, "env", environment(value.env, selectedTargetMode));
  copyDefined(
    normalized,
    "timeoutSeconds",
    optionalInteger(value.timeoutSeconds, "request.timeoutSeconds", 0, 3_600),
  );
  copyDefined(
    normalized,
    "interactive",
    optionalBoolean(value.interactive, "request.interactive"),
  );
  copyDefined(normalized, "streaming", optionalBoolean(value.streaming, "request.streaming"));
  return normalized;
}

function sessionStart(value) {
  plainObject(value, "request");
  onlyKeys(
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

  const selectedTargetMode = targetMode(value.targetMode);
  const normalized = {
    context: context(value.context),
    targetMode: selectedTargetMode,
    argv: dockerArgv(value.argv, selectedTargetMode),
    mode: enumValue(value.mode, "request.mode", SESSION_MODES),
  };
  copyDefined(normalized, "cwd", cwd(value.cwd));
  copyDefined(normalized, "env", environment(value.env, selectedTargetMode));
  copyDefined(normalized, "rows", optionalInteger(value.rows, "request.rows", 1, 1_000));
  copyDefined(normalized, "cols", optionalInteger(value.cols, "request.cols", 1, 1_000));
  copyDefined(
    normalized,
    "timeoutSeconds",
    optionalInteger(value.timeoutSeconds, "request.timeoutSeconds", 0, 86_400),
  );
  copyDefined(
    normalized,
    "outputWindowBytes",
    optionalInteger(
      value.outputWindowBytes,
      "request.outputWindowBytes",
      1_024,
      8_388_608,
    ),
  );
  copyDefined(
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

function sessionInput(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["sessionId", "data", "encoding", "eof"]), "request");

  const normalized = { sessionId: sessionId(value.sessionId) };
  const encoding =
    value.encoding === undefined
      ? "utf-8"
      : enumValue(value.encoding, "request.encoding", SESSION_INPUT_ENCODINGS);
  let dataBytes = 0;
  if (value.data !== undefined) {
    const data = text(value.data, "request.data", 1_048_576, true);
    dataBytes =
      encoding === "base64"
        ? strictBase64ByteLength(data)
        : new TextEncoder().encode(data).byteLength;
    if (dataBytes > MAX_SESSION_INPUT_BYTES) {
      fail(`request.data must encode at most ${MAX_SESSION_INPUT_BYTES} bytes`);
    }
    normalized.data = data;
  }
  copyDefined(
    normalized,
    "encoding",
    value.encoding === undefined ? undefined : encoding,
  );
  const eof = optionalBoolean(value.eof, "request.eof");
  copyDefined(normalized, "eof", eof);
  if (dataBytes === 0 && eof !== true) {
    fail("request must include non-empty data or request EOF");
  }
  return normalized;
}

function sessionResize(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["sessionId", "rows", "cols"]), "request");
  return {
    sessionId: sessionId(value.sessionId),
    rows: requiredInteger(value.rows, "request.rows", 1, 1_000),
    cols: requiredInteger(value.cols, "request.cols", 1, 1_000),
  };
}

function sessionSignal(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["sessionId", "signal"]), "request");
  return {
    sessionId: sessionId(value.sessionId),
    signal: enumValue(value.signal, "request.signal", SESSION_SIGNALS),
  };
}

function sessionCancel(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["sessionId", "gracePeriodMs"]), "request");
  const normalized = { sessionId: sessionId(value.sessionId) };
  copyDefined(
    normalized,
    "gracePeriodMs",
    optionalInteger(value.gracePeriodMs, "request.gracePeriodMs", 0, 30_000),
  );
  return normalized;
}

function sessionAck(value) {
  plainObject(value, "request");
  onlyKeys(value, new Set(["sessionId", "throughSequence"]), "request");
  return {
    sessionId: sessionId(value.sessionId),
    throughSequence: requiredInteger(
      value.throughSequence,
      "request.throughSequence",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

async function call(channel, payload) {
  const response = await ipcRenderer.invoke(channel, payload);
  if (
    response === null ||
    typeof response !== "object" ||
    typeof response.ok !== "boolean"
  ) {
    const error = new Error("The Anchorage desktop bridge returned an invalid response");
    error.name = "AnchorageError";
    error.code = "INVALID_DESKTOP_RESPONSE";
    throw error;
  }
  if (response.ok) {
    return response.value;
  }

  const source = response.error;
  const error = new Error(
    source && typeof source.message === "string"
      ? source.message
      : "The Anchorage desktop request failed",
  );
  error.name = "AnchorageError";
  error.code =
    source && typeof source.code === "string" ? source.code : "DESKTOP_ERROR";
  if (source && source.details && typeof source.details === "object") {
    error.details = source.details;
  }
  throw error;
}

function invoke(method, payload) {
  switch (method) {
    case "system.capabilities":
      return call(CHANNELS.systemCapabilities, systemCapabilities(payload));
    case "system.snapshot":
      return call(CHANNELS.systemSnapshot, systemSnapshot(payload));
    case "system.action":
      return call(CHANNELS.systemAction, systemAction(payload));
    case "containers.list":
      return call(CHANNELS.containersList, containersList(payload));
    case "containers.inspect":
      return call(CHANNELS.containersInspect, containerIdentity(payload));
    case "containers.stats":
      return call(CHANNELS.containersStats, containerIdentity(payload));
    case "containers.statsBatch":
      return call(CHANNELS.containersStatsBatch, containersStatsBatch(payload));
    case "containers.files":
      return call(CHANNELS.containersFiles, containerFiles(payload));
    case "containers.fileRead":
      return call(CHANNELS.containersFileRead, containerFileRead(payload));
    case "containers.fileWrite":
      return call(CHANNELS.containersFileWrite, containerFileWrite(payload));
    case "containers.top":
      return call(CHANNELS.containersTop, containerIdentity(payload));
    case "containers.diff":
      return call(CHANNELS.containersDiff, containerIdentity(payload));
    case "containers.action":
      return call(CHANNELS.containersAction, containerAction(payload));
    case "containers.create":
      return call(CHANNELS.containersCreate, containersCreate(payload));
    case "containers.export":
      return call(CHANNELS.containersExport, containersExport(payload));
    case "images.scout":
      return call(CHANNELS.imagesScout, imagesScout(payload));
    case "volumes.files":
      return call(CHANNELS.volumesFiles, volumeFiles(payload));
    case "volumes.fileRead":
      return call(CHANNELS.volumesFileRead, volumeFileRead(payload));
    case "compose.list":
      return call(CHANNELS.composeList, composeList(payload));
    case "compose.ps":
      return call(CHANNELS.composePs, composePs(payload));
    case "compose.action":
      return call(CHANNELS.composeAction, composeAction(payload));
    case "images.list":
      return call(CHANNELS.imagesList, imagesList(payload));
    case "images.action":
      return call(CHANNELS.imagesAction, imagesAction(payload));
    case "images.inspect":
      return call(CHANNELS.imagesInspect, imagesInspect(payload));
    case "images.search":
      return call(CHANNELS.imagesSearch, imagesSearch(payload));
    case "containers.commit":
      return call(CHANNELS.containersCommit, containersCommit(payload));
    case "volumes.list":
      return call(CHANNELS.volumesList, volumesList(payload));
    case "volumes.action":
      return call(CHANNELS.volumesAction, volumesAction(payload));
    case "networks.list":
      return call(CHANNELS.networksList, networksList(payload));
    case "networks.action":
      return call(CHANNELS.networksAction, networksAction(payload));
    case "cli.run":
      return call(CHANNELS.cliRun, cliRun(payload));
    case "session.start":
      return call(CHANNELS.sessionStart, sessionStart(payload));
    case "session.input":
      return call(CHANNELS.sessionInput, sessionInput(payload));
    case "session.resize":
      return call(CHANNELS.sessionResize, sessionResize(payload));
    case "session.signal":
      return call(CHANNELS.sessionSignal, sessionSignal(payload));
    case "session.cancel":
      return call(CHANNELS.sessionCancel, sessionCancel(payload));
    case "session.ack":
      return call(CHANNELS.sessionAck, sessionAck(payload));
    default:
      fail("method is not supported");
  }
}

const api = Object.freeze({
  invoke,
  system: Object.freeze({
    capabilities: (request) =>
      call(CHANNELS.systemCapabilities, systemCapabilities(request)),
    snapshot: (request) => call(CHANNELS.systemSnapshot, systemSnapshot(request)),
    action: (request) => call(CHANNELS.systemAction, systemAction(request)),
  }),
  containers: Object.freeze({
    list: (request) => call(CHANNELS.containersList, containersList(request)),
    inspect: (request) =>
      call(CHANNELS.containersInspect, containerIdentity(request)),
    stats: (request) =>
      call(CHANNELS.containersStats, containerIdentity(request)),
    statsBatch: (request) =>
      call(CHANNELS.containersStatsBatch, containersStatsBatch(request)),
    files: (request) => call(CHANNELS.containersFiles, containerFiles(request)),
    fileRead: (request) =>
      call(CHANNELS.containersFileRead, containerFileRead(request)),
    fileWrite: (request) =>
      call(CHANNELS.containersFileWrite, containerFileWrite(request)),
    top: (request) => call(CHANNELS.containersTop, containerIdentity(request)),
    diff: (request) => call(CHANNELS.containersDiff, containerIdentity(request)),
    action: (request) => call(CHANNELS.containersAction, containerAction(request)),
    create: (request) => call(CHANNELS.containersCreate, containersCreate(request)),
    export: (request) => call(CHANNELS.containersExport, containersExport(request)),
    commit: (request) => call(CHANNELS.containersCommit, containersCommit(request)),
  }),
  compose: Object.freeze({
    list: (request) => call(CHANNELS.composeList, composeList(request)),
    ps: (request) => call(CHANNELS.composePs, composePs(request)),
    action: (request) => call(CHANNELS.composeAction, composeAction(request)),
  }),
  images: Object.freeze({
    list: (request) => call(CHANNELS.imagesList, imagesList(request)),
    action: (request) => call(CHANNELS.imagesAction, imagesAction(request)),
    inspect: (request) => call(CHANNELS.imagesInspect, imagesInspect(request)),
    search: (request) => call(CHANNELS.imagesSearch, imagesSearch(request)),
    scout: (request) => call(CHANNELS.imagesScout, imagesScout(request)),
  }),
  volumes: Object.freeze({
    list: (request) => call(CHANNELS.volumesList, volumesList(request)),
    action: (request) => call(CHANNELS.volumesAction, volumesAction(request)),
    files: (request) => call(CHANNELS.volumesFiles, volumeFiles(request)),
    fileRead: (request) => call(CHANNELS.volumesFileRead, volumeFileRead(request)),
  }),
  networks: Object.freeze({
    list: (request) => call(CHANNELS.networksList, networksList(request)),
    action: (request) => call(CHANNELS.networksAction, networksAction(request)),
  }),
  cli: Object.freeze({
    run: (request) => call(CHANNELS.cliRun, cliRun(request)),
  }),
  session: Object.freeze({
    start: (request) => call(CHANNELS.sessionStart, sessionStart(request)),
    input: (request) => call(CHANNELS.sessionInput, sessionInput(request)),
    resize: (request) => call(CHANNELS.sessionResize, sessionResize(request)),
    signal: (request) => call(CHANNELS.sessionSignal, sessionSignal(request)),
    cancel: (request) => call(CHANNELS.sessionCancel, sessionCancel(request)),
    ack: (request) => call(CHANNELS.sessionAck, sessionAck(request)),
  }),
  subscribe(event, handler) {
    if (!EVENTS.has(event)) {
      fail("event is not supported");
    }
    if (typeof handler !== "function") {
      fail("handler must be a function");
    }

    const listener = (_ipcEvent, emittedEvent, payload) => {
      if (emittedEvent === event) {
        handler(payload);
      }
    };
    ipcRenderer.on(CHANNELS.event, listener);
    return () => ipcRenderer.removeListener(CHANNELS.event, listener);
  },
  window: Object.freeze({
    minimize: () => call(CHANNELS.windowMinimize),
    maximize: () => call(CHANNELS.windowMaximize),
    close: () => call(CHANNELS.windowClose),
    isMaximized: () => call(CHANNELS.windowIsMaximized),
    setBackgroundColor: (color) =>
      call(CHANNELS.windowSetBackgroundColor, windowBackgroundColor(color)),
  }),
});

contextBridge.exposeInMainWorld("anchorage", api);
