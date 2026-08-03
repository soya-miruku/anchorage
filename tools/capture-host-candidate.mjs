#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  HOST_CANDIDATE_CHECK_IDS,
  HOST_CANDIDATE_SCREEN_IDS,
  HOST_CANDIDATE_SCREEN_SEMANTIC_IDS,
  HOST_UI_INTERACTION_IDS,
  HOST_UI_PERFORMANCE_CHECK_IDS,
  HOST_UI_PERFORMANCE_PROFILE,
  canonicalPackagedPackageJson,
} from "../app/scripts/package-evidence-policy.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "..");
const appDirectory = resolve(workspaceRoot, "app");
const rendererDirectory = resolve(appDirectory, "dist/client");
const rendererEntry = resolve(rendererDirectory, "index.html");
const electronPath = resolve(
  appDirectory,
  "node_modules/electron/dist/electron",
);
const electronMainPath = resolve(appDirectory, "electron/main.mjs");
const electronPreloadPath = resolve(appDirectory, "electron/preload.cjs");
const protocolSchemaPath = resolve(workspaceRoot, "protocol/v1.schema.json");
const corePath = resolve(
  process.env.ANCHORAGE_HOST_CANDIDATE_CORE ??
    resolve(appDirectory, "build/core/anchorage-core"),
);
const outputDirectory = resolve(
  process.env.ANCHORAGE_HOST_CANDIDATE_OUTPUT ??
    resolve(workspaceRoot, "artifacts/host-candidate"),
);
const evidencePath = resolve(outputDirectory, "host-candidate.json");
const screensDirectory = resolve(outputDirectory, "screens");
const canonicalViewport = Object.freeze({ width: 1656, height: 1056 });
const captureTimeoutMs = 60_000;
const bridgeFunctions = Object.freeze([
  "cli.run",
  "containers.inspect",
  "containers.list",
  "containers.stats",
  "images.list",
  "session.start",
  "subscribe",
  "system.capabilities",
  "system.snapshot",
  "volumes.list",
  "window.close",
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function quoted(value) {
  return JSON.stringify(value);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function workspaceRelative(path) {
  return relative(workspaceRoot, path).split(sep).join("/");
}

function pathWithin(root, candidate) {
  const remainder = relative(root, candidate);
  return (
    remainder === "" ||
    (
      remainder !== ".." &&
      !remainder.startsWith(`..${sep}`) &&
      !isAbsolute(remainder)
    )
  );
}

async function fileEvidence(path) {
  const [content, info] = await Promise.all([readFile(path), stat(path)]);
  requireCondition(info.isFile(), `Candidate input is not a file: ${path}`);
  return {
    path: workspaceRelative(path),
    sha256: sha256(content),
    bytes: content.byteLength,
  };
}

async function hashDirectory(directory) {
  const files = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(directory);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const path of files) {
    const content = await readFile(path);
    hash.update(relative(directory, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(String(content.byteLength));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
    bytes += content.byteLength;
  }
  return { sha256: hash.digest("hex"), files: files.length, bytes };
}

async function electronRuntimeClosure() {
  const shipped = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (
        entry.isFile() &&
        path.endsWith(".mjs") &&
        !path.endsWith(".test.mjs")
      ) {
        shipped.push(path);
      }
    }
  }
  await visit(resolve(appDirectory, "electron"));
  shipped.push(electronPreloadPath);
  const entries = [];
  for (const path of shipped) {
    entries.push({
      name: relative(appDirectory, path).split(sep).join("/"),
      content: await readFile(path),
    });
  }
  entries.push({
    name: "package.json",
    content: canonicalPackagedPackageJson(
      await readFile(resolve(appDirectory, "package.json")),
    ),
  });
  entries.sort((left, right) =>
    left.name.localeCompare(right.name, "en"));
  const hash = createHash("sha256");
  let bytes = 0;
  for (const { name, content } of entries) {
    hash.update(name);
    hash.update("\0");
    hash.update(String(content.byteLength));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
    bytes += content.byteLength;
  }
  return {
    scope: "packaged-electron-runtime-v1",
    sha256: hash.digest("hex"),
    files: entries.length,
    bytes,
  };
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolveClose) => server.close(resolveClose));
  requireCondition(port, "Could not reserve a local DevTools port");
  return port;
}

class CDPClient {
  constructor(socket) {
    this.socket = socket;
    this.counter = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        for (const listener of this.listeners) listener(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `${pending.method} failed: ${
              message.error.message ?? JSON.stringify(message.error)
            }`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Chrome DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(
        () => rejectOpen(new Error("Chrome DevTools connection timed out")),
        captureTimeoutMs,
      );
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectOpen(new Error("Chrome DevTools connection failed"));
      });
    });
    return new CDPClient(socket);
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method, params = {}) {
    const id = ++this.counter;
    return new Promise((resolveResult, rejectResult) => {
      this.pending.set(id, {
        method,
        resolve: resolveResult,
        reject: rejectResult,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function waitForTarget(port, expectedUrl) {
  const deadline = Date.now() + captureTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find(
        (candidate) =>
          candidate.type === "page" &&
          candidate.url.startsWith(expectedUrl) &&
          typeof candidate.webSocketDebuggerUrl === "string",
      );
      if (target) return target;
    } catch {
      // Electron has not exposed its renderer target yet.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the production HostBridge renderer");
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Host candidate expression failed",
    );
  }
  return result.result?.value;
}

async function waitForExpression(client, expression, description) {
  const deadline = Date.now() + captureTimeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForSelector(client, selector) {
  return waitForExpression(
    client,
    `Boolean(document.querySelector(${quoted(selector)}))`,
    `selector ${selector}`,
  );
}

async function settle(client) {
  await evaluate(
    client,
    `(async () => {
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`,
  );
  await delay(75);
}

function clickSelector(selector) {
  return `(() => {
    const element = document.querySelector(${quoted(selector)});
    if (!(element instanceof HTMLElement)) {
      throw new Error("Missing clickable selector: " + ${quoted(selector)});
    }
    element.click();
  })()`;
}

function clickButtonText(selector, text) {
  return `(() => {
    const element = [...document.querySelectorAll(${quoted(selector)})]
      .find((candidate) => candidate.textContent?.trim() === ${quoted(text)});
    if (!(element instanceof HTMLElement)) {
      throw new Error("Missing button text: " + ${quoted(text)});
    }
    element.click();
  })()`;
}

function pngDimensions(content, description) {
  requireCondition(
    content.length >= 24 &&
      content.subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
    `${description} is not a PNG`,
  );
  return {
    width: content.readUInt32BE(16),
    height: content.readUInt32BE(20),
  };
}

function eventText(argument) {
  if (argument.value !== undefined) return String(argument.value);
  if (argument.description !== undefined) return String(argument.description);
  return argument.type ?? "unknown";
}

function boundedText(value, maximum = 2_048) {
  const text = String(value ?? "");
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}

function processErrorLines(stderr) {
  return stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        /\[anchorage\].*(?:failed|error|invalid|crash)/iu.test(line) ||
        /\b(?:fatal|unhandledpromiserejection)\b/iu.test(line),
    )
    .map((line) => boundedText(line));
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      rejectExit(new Error("Electron did not exit after the native close request"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

const startedAt = new Date().toISOString();
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(screensDirectory, { recursive: true });
await chmod(corePath, 0o755);

const [
  rendererBuild,
  coreEvidence,
  electronBinaryEvidence,
  electronMainEvidence,
  electronPreloadEvidence,
  electronRuntimeEvidence,
  protocolSchemaEvidence,
  harnessEvidence,
] = await Promise.all([
  hashDirectory(rendererDirectory),
  fileEvidence(corePath),
  fileEvidence(electronPath),
  fileEvidence(electronMainPath),
  fileEvidence(electronPreloadPath),
  electronRuntimeClosure(),
  fileEvidence(protocolSchemaPath),
  fileEvidence(scriptPath),
]);
requireCondition(
  rendererBuild.files > 0 && rendererBuild.bytes > 0,
  "Production renderer build is absent",
);
await stat(rendererEntry);

const userDataDirectory = await mkdtemp(
  resolve(tmpdir(), "anchorage-host-candidate-"),
);
const cwdProofDirectory = await realpath(
  await mkdtemp(resolve("/tmp", "anchorage-host-cwd-proof-")),
);
const canonicalHome = await realpath(process.env.HOME ?? "");
requireCondition(
  !pathWithin(canonicalHome, cwdProofDirectory),
  `Host cwd proof directory must be outside HOME: ${cwdProofDirectory}`,
);
await writeFile(
  resolve(cwdProofDirectory, "compose.yaml"),
  [
    "services:",
    "  anchorage-cwd-proof:",
    "    image: scratch",
    "",
  ].join("\n"),
  { mode: 0o600 },
);
const debuggingPort = await freePort();
const rendererUrl = pathToFileURL(rendererEntry).href;
const electronEnvironment = {
  ...process.env,
  ANCHORAGE_CORE_BINARY: corePath,
};
delete electronEnvironment.ANCHORAGE_DESKTOP_SMOKE;
delete electronEnvironment.ANCHORAGE_PACKAGED_SMOKE;
const spawnStartedAtMs = performance.now();
const electron = spawn(
  electronPath,
  [
    `--remote-debugging-port=${debuggingPort}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDirectory}`,
    "--force-device-scale-factor=1",
    appDirectory,
  ],
  {
    cwd: workspaceRoot,
    env: electronEnvironment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let electronStdout = "";
let electronStderr = "";
for (const [stream, append] of [
  [electron.stdout, (chunk) => {
    electronStdout = `${electronStdout}${chunk}`.slice(-64 * 1024);
  }],
  [electron.stderr, (chunk) => {
    electronStderr = `${electronStderr}${chunk}`.slice(-64 * 1024);
  }],
]) {
  stream.setEncoding("utf8");
  stream.on("data", append);
}

let client;
let evidenceWritten = false;
try {
  const target = await waitForTarget(debuggingPort, rendererUrl);
  client = await CDPClient.connect(target.webSocketDebuggerUrl);
  const consoleErrors = [];
  const pageErrors = [];
  client.onEvent((message) => {
    if (
      message.method === "Runtime.consoleAPICalled" &&
      ["error", "assert"].includes(message.params?.type)
    ) {
      consoleErrors.push(
        boundedText(
          (message.params.args ?? []).map(eventText).join(" "),
        ),
      );
    }
    if (message.method === "Runtime.exceptionThrown") {
      pageErrors.push(
        boundedText(
          message.params?.exceptionDetails?.exception?.description ??
            message.params?.exceptionDetails?.text ??
            "Uncaught renderer exception",
        ),
      );
    }
    if (
      message.method === "Log.entryAdded" &&
      message.params?.entry?.level === "error"
    ) {
      consoleErrors.push(boundedText(message.params.entry.text));
    }
  });
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Log.enable"),
    client.send("Emulation.setDeviceMetricsOverride", {
      width: canonicalViewport.width,
      height: canonicalViewport.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: canonicalViewport.width,
      screenHeight: canonicalViewport.height,
    }),
    client.send("Emulation.setLocaleOverride", { locale: "en-GB" }),
    client.send("Emulation.setTimezoneOverride", {
      timezoneId: "Europe/London",
    }),
  ]);
  const browserVersion = await client.send("Browser.getVersion");
  await waitForSelector(client, '[data-testid="shell"]');
  await waitForSelector(client, '[data-testid="containers-screen"]');

  const hostAttestation = await evaluate(
    client,
    `(async () => {
      const api = window.anchorage;
      if (!api) throw new Error("Host API was not exposed by the preload");
      const functionPaths = ${quoted(bridgeFunctions)};
      for (const path of functionPaths) {
        const value = path.split(".").reduce(
          (current, key) => current?.[key],
          api,
        );
        if (typeof value !== "function") {
          throw new Error("Missing HostBridge function: " + path);
        }
      }
      const capabilities = await api.system.capabilities();
      if (capabilities?.protocolVersion !== "1") {
        throw new Error("HostBridge did not return protocol v1 capabilities");
      }
      const context =
        capabilities.selectedContext ??
        capabilities.currentContext ??
        capabilities.contexts?.find((candidate) => candidate.current)?.name ??
        capabilities.contexts?.[0]?.name;
      if (!context) throw new Error("No Docker context was discovered");
      const containers = await api.containers.list({ context, all: true });
      if (!Array.isArray(containers?.containers)) {
        throw new Error("HostBridge container list was malformed");
      }
      const images = await api.images.list({
        context,
        all: false,
        includeDangling: true,
      });
      if (!Array.isArray(images?.images)) {
        throw new Error("HostBridge image list was malformed");
      }
      const volumes = await api.volumes.list({ context });
      if (!Array.isArray(volumes?.volumes)) {
        throw new Error("HostBridge volume list was malformed");
      }
      return {
        functions: functionPaths,
        protocolVersion: capabilities.protocolVersion,
        context,
        currentContext: capabilities.currentContext ?? null,
        selectedContext: capabilities.selectedContext ?? null,
        commandInventoryComplete:
          capabilities.commandInventory?.complete === true,
        containerCount: containers.containers.length,
        imageCount: images.images.length,
        volumeCount: volumes.volumes.length,
      };
    })()`,
  );
  requireCondition(
    hostAttestation.containerCount > 0,
    "The host-candidate gate requires one existing container for detail and Files-unavailable evidence",
  );
  const initialUiPerformance = await evaluate(
    client,
    `(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      const firstContentfulPaint = performance
        .getEntriesByName("first-contentful-paint")[0];
      return {
        navigationDomContentLoadedMs:
          navigation?.domContentLoadedEventEnd ?? null,
        firstContentfulPaintMs:
          firstContentfulPaint?.startTime ?? null,
        domNodeCount: document.querySelectorAll("*").length,
        visibleContainerRows:
          document.querySelectorAll('[data-testid^="container-row-"]').length,
      };
    })()`,
  );
  requireCondition(
    Number.isFinite(initialUiPerformance.navigationDomContentLoadedMs) &&
      initialUiPerformance.navigationDomContentLoadedMs > 0 &&
      Number.isFinite(initialUiPerformance.firstContentfulPaintMs) &&
      initialUiPerformance.firstContentfulPaintMs > 0 &&
      Number.isSafeInteger(initialUiPerformance.domNodeCount) &&
      initialUiPerformance.domNodeCount > 0 &&
      Number.isSafeInteger(initialUiPerformance.visibleContainerRows) &&
      initialUiPerformance.visibleContainerRows > 0,
    `Host UI performance entries were incomplete: ` +
      `${JSON.stringify(initialUiPerformance)}`,
  );
  const spawnToHostReadyMs =
    Math.round((performance.now() - spawnStartedAtMs) * 100) / 100;
  const interactionTimings = [];
  const measureInteraction = async (id, work) => {
    const started = performance.now();
    await work();
    await settle(client);
    interactionTimings.push({
      id,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    });
  };

  const cli = await evaluate(
    client,
    `(async () => {
      const context = ${quoted(hostAttestation.context)};
      const pinned = await window.anchorage.cli.run({
        context,
        targetMode: "pinned",
        argv: ["version", "--format", "{{.Client.Version}}"],
        timeoutSeconds: 30,
      });
      const literal = await window.anchorage.cli.run({
        context,
        targetMode: "literal",
        argv: [
          "--context",
          context,
          "version",
          "--format",
          "{{.Client.Version}}",
        ],
        timeoutSeconds: 30,
      });
      const cwdSensitive = await window.anchorage.cli.run({
        context,
        targetMode: "pinned",
        argv: [
          "compose",
          "--project-name",
          "anchorage-cwd-proof",
          "config",
          "--quiet",
        ],
        cwd: ${quoted(cwdProofDirectory)},
        timeoutSeconds: 30,
      });
      for (const [mode, result] of Object.entries({ pinned, literal })) {
        if (
          result?.targetMode !== mode ||
          result?.exitCode !== 0 ||
          result?.timedOut !== false ||
          typeof result?.stdout?.data !== "string" ||
          result.stdout.data.trim().length === 0
        ) {
          throw new Error(mode + " CLI result did not pass");
        }
      }
      if (
        cwdSensitive?.targetMode !== "pinned" ||
        cwdSensitive?.exitCode !== 0 ||
        cwdSensitive?.timedOut !== false ||
        cwdSensitive?.cwd !== ${quoted(cwdProofDirectory)}
      ) {
        throw new Error(
          "cwd-sensitive Compose config did not run from the requested directory",
        );
      }
      return {
        pinned: {
          targetMode: pinned.targetMode,
          exitCode: pinned.exitCode,
          outputPresent: pinned.stdout.data.trim().length > 0,
          executedArgv: pinned.argv,
        },
        literal: {
          targetMode: literal.targetMode,
          exitCode: literal.exitCode,
          outputPresent: literal.stdout.data.trim().length > 0,
          executedArgv: literal.argv,
        },
        cwdSensitive: {
          targetMode: cwdSensitive.targetMode,
          exitCode: cwdSensitive.exitCode,
          timedOut: cwdSensitive.timedOut,
          composeConfigValidated: true,
          outsideHome: true,
          requestedCwd: ${quoted(cwdProofDirectory)},
          resultCwd: cwdSensitive.cwd,
          executedArgv: cwdSensitive.argv,
        },
      };
    })()`,
  );

  const screensById = new Map();
  const capture = async (id, checks) => {
    requireCondition(
      HOST_CANDIDATE_SCREEN_IDS.includes(id),
      `Unknown host candidate screen: ${id}`,
    );
    await settle(client);
    const layout = await evaluate(
      client,
      `({ width: window.innerWidth, height: window.innerHeight })`,
    );
    requireCondition(
      layout.width === canonicalViewport.width &&
        layout.height === canonicalViewport.height,
      `Host candidate viewport was ${layout.width}x${layout.height}`,
    );
    const semanticChecks = [];
    for (const check of checks) {
      const actual = await evaluate(client, check.expression);
      requireCondition(actual, `Semantic check failed: ${check.name}`);
      semanticChecks.push({
        id: check.id,
        name: check.name,
        status: "passed",
        actual:
          typeof actual === "string"
            ? boundedText(actual, 512)
            : actual,
      });
    }
    const expectedSemanticIds = HOST_CANDIDATE_SCREEN_SEMANTIC_IDS[id];
    requireCondition(
      checks.length === expectedSemanticIds.length &&
        [...checks.map((check) => check.id)].sort().every(
          (semanticId, index) =>
            semanticId === [...expectedSemanticIds].sort()[index],
        ),
      `Host screen ${id} did not use its policy-owned semantic matrix`,
    );
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const content = Buffer.from(screenshot.data, "base64");
    const dimensions = pngDimensions(content, `Host screen ${id}`);
    requireCondition(
      dimensions.width === canonicalViewport.width &&
        dimensions.height === canonicalViewport.height,
      `Host screen ${id} did not use canonical dimensions`,
    );
    const path = resolve(screensDirectory, `${id}.png`);
    await writeFile(path, content);
    screensById.set(id, {
      id,
      path: `screens/${id}.png`,
      sha256: sha256(content),
      bytes: content.byteLength,
      dimensions,
      semanticChecks,
    });
  };

  await capture("host-containers", [
    {
      id: "host-containers-visible",
      name: "live containers screen visible",
      expression:
        `Boolean(document.querySelector('[data-testid="containers-screen"]'))`,
    },
    {
      id: "host-containers-live-row",
      name: "at least one live container row visible",
      expression:
        `document.querySelectorAll('[data-testid^="container-row-"]').length`,
    },
    {
      id: "host-containers-fixture-banner-absent",
      name: "fixture update banner absent in host mode",
      expression:
        `!document.querySelector('[data-testid="update-banner"]')`,
    },
  ]);

  await measureInteraction("open-container-detail", async () => {
    await evaluate(
      client,
      clickSelector('[data-testid^="container-row-"]'),
    );
    await waitForSelector(
      client,
      '[data-testid="container-detail-screen"]',
    );
  });
  await capture("host-container-detail", [
    {
      id: "host-container-detail-visible",
      name: "container detail screen visible",
      expression:
        `Boolean(document.querySelector('[data-testid="container-detail-screen"]'))`,
    },
    {
      id: "host-container-detail-identity",
      name: "live container identity present",
      expression:
        `document.querySelector('.detail-header h1')?.textContent?.trim()`,
    },
  ]);
  // This gate used to require the Files tab to declare itself unavailable, which was the
  // honest state before a real browser existed. It now reads the container's filesystem by
  // walking tar headers from the archive endpoint, so the gap it asserted is closed. The
  // property worth keeping is the one that mattered all along: whatever appears here must
  // have come from the container. A listing and a stated error are both acceptable; a
  // fabricated tree is not.
  await measureInteraction("open-files-live", async () => {
    await evaluate(
      client,
      clickButtonText(
        '[aria-label="Container details"] button',
        "Files",
      ),
    );
    await waitForExpression(
      client,
      `(() => {
        const panel = document.querySelector('[data-testid="container-files"]');
        if (!panel) return false;
        const settled = panel.querySelector('[data-testid="container-files-table"] .files-row')
          || panel.querySelector('.capability-error')
          || panel.querySelector('.empty-state');
        return Boolean(settled);
      })()`,
      "the live container Files browser to settle",
    );
  });
  await capture("host-files-live", [
    {
      id: "host-files-live-panel",
      name: "live container file browser is mounted",
      expression:
        `Boolean(document.querySelector('[data-testid="container-files"]'))`,
    },
    {
      id: "host-files-live-settled",
      name: "the browser reports a listing, an empty directory, or a stated error",
      expression:
        `(() => {
          const panel = document.querySelector('[data-testid="container-files"]');
          if (!panel) return false;
          return Boolean(
            panel.querySelector('[data-testid="container-files-table"] .files-row')
              || panel.querySelector('.capability-error')
              || panel.querySelector('.empty-state'),
          );
        })()`,
    },
    {
      id: "host-files-no-synthetic-filesystem",
      name: "no fixture filesystem is shown against a live engine",
      // The design fixture's own paths. Seeing any of them against a real container would
      // mean the browser had fallen back to fabricated content.
      expression:
        `!["srv/dist/server.js", "var/log/app.log", "srv/package.json"]
          .some((path) => document.body.textContent?.includes(path))`,
    },
  ]);

  await measureInteraction("navigate-dashboard", async () => {
    await evaluate(client, clickSelector('[data-testid="nav-dashboard"]'));
    await waitForSelector(client, '[data-testid="dashboard-screen"]');
  });
  await capture("host-dashboard", [
    {
      id: "host-dashboard-visible",
      name: "live dashboard screen visible",
      expression:
        `Boolean(document.querySelector('[data-testid="dashboard-screen"]'))`,
    },
    {
      id: "host-dashboard-live-context",
      name: "live Docker context is identified",
      expression:
        `document.querySelector('[data-testid="dashboard-screen"] header p')
          ?.textContent?.includes(${quoted(hostAttestation.context)})
            ? ${quoted(hostAttestation.context)}
            : null`,
    },
    {
      id: "host-dashboard-snapshot-state-explicit",
      name: "background engine snapshot state is explicit",
      expression:
        `Boolean(document.querySelector('.host-engine-facts')) ||
          [...document.querySelectorAll('[role="status"]')].some(
            (element) => [
              "Loading system snapshot",
              "System snapshot unavailable",
            ].some((state) => element.textContent?.includes(state)),
          )`,
    },
  ]);

  await measureInteraction("navigate-images", async () => {
    await evaluate(client, clickSelector('[data-testid="nav-images"]'));
    await waitForSelector(client, '[data-testid="images-screen"]');
  });
  await capture("host-images", [
    {
      id: "host-images-visible",
      name: "live images screen visible",
      expression:
        `Boolean(document.querySelector('[data-testid="images-screen"]'))`,
    },
    {
      id: "host-images-capability-error-absent",
      name: "images screen has no live capability error",
      expression:
        `!document.querySelector('[data-testid="images-screen"] .capability-error')`,
    },
  ]);

  await measureInteraction("navigate-volumes", async () => {
    await evaluate(client, clickSelector('[data-testid="nav-volumes"]'));
    await waitForSelector(client, '[data-testid="volumes-screen"]');
  });
  await capture("host-volumes", [
    {
      id: "host-volumes-visible",
      name: "live volumes screen visible",
      expression:
        `Boolean(document.querySelector('[data-testid="volumes-screen"]'))`,
    },
    {
      id: "host-volumes-capability-error-absent",
      name: "volumes screen has no live capability error",
      expression:
        `!document.querySelector('[data-testid="volumes-screen"] .capability-error')`,
    },
  ]);

  await measureInteraction("navigate-builds", async () => {
    await evaluate(client, clickSelector('[data-testid="nav-builds"]'));
    await waitForSelector(client, '[data-testid="builds-screen"]');
  });
  await capture("host-unsupported-builds", [
    {
      id: "host-builds-unsupported-visible",
      name: "unsupported Builds state is explicit",
      expression:
        `document.querySelector('[data-testid="builds-screen"]')
          ?.textContent?.includes("Builds is unavailable in this build")`,
    },
    {
      id: "host-builds-fixture-disclaimer-visible",
      name: "host mode disclaims fixture data",
      expression:
        `document.querySelector('[data-testid="builds-screen"]')
          ?.textContent?.includes("No fixture or simulated data is shown")`,
    },
  ]);

  await measureInteraction("open-command-center", async () => {
    await evaluate(
      client,
      `(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "p",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }));
      })()`,
    );
    await waitForSelector(client, '[data-testid="command-center"]');
    await waitForExpression(
      client,
      `(() => {
        const select = document.querySelector(
          '[aria-label="Docker context"]',
        );
        return select instanceof HTMLSelectElement &&
          select.value.length > 0;
      })()`,
      "the HostBridge Command Center context",
    );
  });
  await capture("host-command-center-pinned", [
    {
      id: "host-command-inventory-visible",
      name: "Command Center is backed by installed command inventory",
      expression:
        `document.querySelector('.command-center__inventory')
          ?.textContent?.includes("runnable leaves")`,
    },
    {
      id: "host-command-target-pinned",
      name: "pinned target mode selected",
      expression:
        `document.querySelector('[aria-label="Docker target mode"]')?.value`,
    },
  ]);
  await measureInteraction("select-literal-target", async () => {
    await evaluate(
      client,
      `(() => {
        const select = document.querySelector(
          '[aria-label="Docker target mode"]',
        );
        if (!(select instanceof HTMLSelectElement)) {
          throw new Error("Missing target mode select");
        }
        const setter = Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          "value",
        )?.set;
        setter?.call(select, "literal");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      })()`,
    );
    await waitForExpression(
      client,
      `document.body.textContent?.includes("Literal target mode is enabled")`,
      "literal target-mode disclosure",
    );
  });
  await capture("host-command-center-literal", [
    {
      id: "host-command-target-literal",
      name: "literal target mode selected",
      expression:
        `document.querySelector('[aria-label="Docker target mode"]')?.value`,
    },
    {
      id: "host-command-literal-disclosure-visible",
      name: "literal mode target disclosure visible",
      expression:
        `document.body.textContent?.includes("Literal target mode is enabled")`,
    },
  ]);

  requireCondition(
    screensById.size === HOST_CANDIDATE_SCREEN_IDS.length,
    "The host candidate did not capture every required screen",
  );
  requireCondition(
    interactionTimings.length === HOST_UI_INTERACTION_IDS.length &&
      interactionTimings.every(
        (timing, index) =>
          timing.id === HOST_UI_INTERACTION_IDS[index] &&
          Number.isFinite(timing.durationMs) &&
          timing.durationMs > 0,
      ),
    `Host UI interaction matrix was incomplete: ` +
      `${JSON.stringify(interactionTimings)}`,
  );
  const uiMetricById = {
    "spawn-to-host-ready": "spawnToHostReadyMs",
    "navigation-dom-content-loaded":
      "navigationDomContentLoadedMs",
    "first-contentful-paint": "firstContentfulPaintMs",
    "scripted-interaction-settle-max":
      "scriptedInteractionSettleMaxMs",
    "bounded-dom-nodes": "domNodeCount",
    "bounded-visible-container-rows": "visibleContainerRows",
  };
  const uiPerformanceObservations = {
    spawnToHostReadyMs,
    navigationDomContentLoadedMs:
      Math.round(initialUiPerformance.navigationDomContentLoadedMs * 100) /
      100,
    firstContentfulPaintMs:
      Math.round(initialUiPerformance.firstContentfulPaintMs * 100) / 100,
    scriptedInteractionSettleMaxMs:
      Math.max(...interactionTimings.map(({ durationMs }) => durationMs)),
    domNodeCount: initialUiPerformance.domNodeCount,
    visibleContainerRows: initialUiPerformance.visibleContainerRows,
    liveContainerCount: hostAttestation.containerCount,
  };
  const uiPerformanceChecks = HOST_UI_PERFORMANCE_CHECK_IDS.map((id) => {
    const metric = uiMetricById[id];
    const observed = uiPerformanceObservations[metric];
    const limit = HOST_UI_PERFORMANCE_PROFILE.thresholds[metric];
    return {
      id,
      metric,
      comparison: "<=",
      observed,
      limit,
      status:
        Number.isFinite(observed) && observed > 0 && observed <= limit
          ? "passed"
          : "failed",
    };
  });
  requireCondition(
    uiPerformanceChecks.every((check) => check.status === "passed"),
    `Host UI performance failed: ${JSON.stringify(uiPerformanceChecks)}`,
  );
  const uiPerformance = {
    schemaVersion: 1,
    profile: HOST_UI_PERFORMANCE_PROFILE.id,
    thresholds: HOST_UI_PERFORMANCE_PROFILE.thresholds,
    status: "passed",
    observations: uiPerformanceObservations,
    interactionTimings,
    checks: uiPerformanceChecks,
  };
  await settle(client);
  await evaluate(client, `window.anchorage.window.close()`);
  const processExit = await waitForExit(electron, 15_000);
  const diagnostics = {
    consoleErrors: [...new Set(consoleErrors.filter(Boolean))],
    pageErrors: [...new Set(pageErrors.filter(Boolean))],
    processErrors: [...new Set(processErrorLines(electronStderr))],
  };
  requireCondition(
    diagnostics.consoleErrors.length === 0 &&
      diagnostics.pageErrors.length === 0 &&
      diagnostics.processErrors.length === 0,
    `Host candidate emitted errors: ${JSON.stringify(diagnostics)}`,
  );
  requireCondition(
    processExit.code === 0 && processExit.signal === null,
    `Electron exited with ${JSON.stringify(processExit)}`,
  );

  const completedAt = new Date().toISOString();
  const detailsByCheck = {
    "candidate-integrity": {
      rendererSha256: rendererBuild.sha256,
      coreSha256: coreEvidence.sha256,
      mainSha256: electronMainEvidence.sha256,
      preloadSha256: electronPreloadEvidence.sha256,
    },
    "clean-shutdown": processExit,
    "console-and-page-errors": {
      consoleErrors: 0,
      pageErrors: 0,
      processErrors: 0,
    },
    "core-handshake": {
      protocolVersion: hostAttestation.protocolVersion,
    },
    "docker-context-ready": {
      context: hostAttestation.context,
      containerCount: hostAttestation.containerCount,
      imageCount: hostAttestation.imageCount,
      volumeCount: hostAttestation.volumeCount,
    },
    "host-bridge-attestation": {
      functions: hostAttestation.functions,
    },
    "host-ui-performance": uiPerformance,
    "live-resource-screens": {
      screens: [
        "host-dashboard",
        "host-containers",
        "host-container-detail",
        "host-images",
        "host-volumes",
      ],
    },
    "literal-cli-run": cli.literal,
    "outside-home-cwd-cli-run": cli.cwdSensitive,
    "pinned-cli-run": cli.pinned,
    "unsupported-host-states": {
      screens: [
        "host-files-unavailable",
        "host-unsupported-builds",
      ],
    },
  };
  const evidence = {
    schemaVersion: 1,
    matrixVersion: 1,
    status: "passed",
    candidateMode: "staged-inputs",
    scope: "host-integration-smoke-not-pixel-parity",
    bridgeMode: "host",
    startedAt,
    completedAt,
    source: "app/dist/client",
    canonicalViewport,
    requiredChecks: [...HOST_CANDIDATE_CHECK_IDS],
    requiredScreens: [...HOST_CANDIDATE_SCREEN_IDS],
    checks: HOST_CANDIDATE_CHECK_IDS.map((id) => ({
      id,
      name: `Staged HostBridge candidate: ${id}`,
      status: "passed",
      details: detailsByCheck[id],
    })),
    candidate: {
      rendererBuild,
      core: coreEvidence,
      electron: {
        binary: electronBinaryEvidence,
        main: electronMainEvidence,
        preload: electronPreloadEvidence,
        runtimeClosure: electronRuntimeEvidence,
      },
      protocolSchema: protocolSchemaEvidence,
      harness: harnessEvidence,
    },
    runtime: {
      product: browserVersion.product,
      protocolVersion: browserVersion.protocolVersion,
      revision: browserVersion.revision,
      userAgent: browserVersion.userAgent,
      jsVersion: browserVersion.jsVersion,
    },
    bridge: {
      hostApiPresent: true,
      fixtureBridgeAbsent: true,
      functions: hostAttestation.functions,
      commandInventoryComplete:
        hostAttestation.commandInventoryComplete,
    },
    docker: {
      context: hostAttestation.context,
      currentContext: hostAttestation.currentContext,
      selectedContext: hostAttestation.selectedContext,
      ready: true,
      containerAvailable: hostAttestation.containerCount > 0,
      containerCount: hostAttestation.containerCount,
      imageCount: hostAttestation.imageCount,
      volumeCount: hostAttestation.volumeCount,
    },
    cli,
    uiPerformance,
    diagnostics,
    processExit,
    processOutput: {
      stdoutSha256: sha256(Buffer.from(electronStdout)),
      stderrSha256: sha256(Buffer.from(electronStderr)),
      stdoutBytes: Buffer.byteLength(electronStdout),
      stderrBytes: Buffer.byteLength(electronStderr),
    },
    screens: HOST_CANDIDATE_SCREEN_IDS.map((id) => screensById.get(id)),
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  evidenceWritten = true;
  process.stdout.write(
    `PASS: staged HostBridge candidate ${rendererBuild.sha256.slice(0, 12)} ` +
      `captured ${evidence.screens.length} host screens with ` +
      `${evidence.checks.length}/${evidence.checks.length} checks.\n`,
  );
} catch (error) {
  process.stderr.write(
    `FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n` +
      `${electronStdout}${electronStderr}\n`,
  );
  process.exitCode = 1;
} finally {
  if (client) client.close();
  if (electron.exitCode === null && electron.signalCode === null) {
    electron.kill("SIGTERM");
    try {
      await waitForExit(electron, 5_000);
    } catch {
      electron.kill("SIGKILL");
    }
  }
  await rm(userDataDirectory, { recursive: true, force: true });
  await rm(cwdProofDirectory, { recursive: true, force: true });
  if (!evidenceWritten) {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}
