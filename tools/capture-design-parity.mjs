#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "..");
const rendererDirectory = resolve(workspaceRoot, "app/dist/client");
const outputDirectory = resolve(
  workspaceRoot,
  process.env.ANCHORAGE_ACTUAL_CAPTURE_DIRECTORY ??
    "docs/design-qa/final-actual",
);
const electronPath = resolve(
  workspaceRoot,
  "app/node_modules/electron/dist/electron",
);
const canonicalViewport = { width: 1656, height: 1056 };
const captureTimeoutMs = 30_000;

const states = [
  { id: "containers" },
  {
    id: "containers-current",
    expression: clickTestId("nav-containers"),
  },
  {
    id: "containers-only-running",
    expression: clickTestId("only-running-filter"),
  },
  {
    id: "containers-search-empty",
    expression: setInput('[data-testid="global-search"]', "no-match-container"),
    waitFor: '[data-testid="containers-empty-state"]',
  },
  {
    id: "containers-row-hover",
    hover: '[data-testid^="container-row-"]',
  },
  {
    id: "containers-banner-dismissed",
    expression: clickButtonText('[data-testid="preview-banner"] button', "Dismiss"),
  },
  ...[
    ["container-detail-logs", "Logs"],
    ["container-detail-inspect", "Inspect"],
    ["container-detail-mounts", "Bind mounts"],
    ["container-detail-exec", "Exec"],
    ["container-detail-files", "Files"],
    ["container-detail-stats", "Stats"],
  ].map(([id, tab]) => ({
    id,
    steps: [
      {
        expression: clickSelector('[data-testid^="container-row-"]'),
        waitFor: '[data-testid="container-detail-screen"]',
      },
      {
        expression: clickButtonText(
          '[aria-label="Container details"] button',
          tab,
        ),
      },
    ],
  })),
  { id: "dashboard", expression: clickTestId("nav-dashboard") },
  { id: "images-local", expression: clickTestId("nav-images") },
  {
    id: "images-registry",
    steps: [
      {
        expression: clickTestId("nav-images"),
        waitFor: '[data-testid="images-screen"]',
      },
      { expression: clickSelector("#images-registry-tab") },
    ],
  },
  { id: "volumes", expression: clickTestId("nav-volumes") },
  { id: "builds", expression: clickTestId("nav-builds") },
  {
    id: "settings-resources",
    steps: settingsSteps("Resources"),
  },
  {
    id: "settings-engine",
    // The handoff calls this pane "Engine"; the build followed suit, and this harness drives
    // the rail by its visible label.
    steps: settingsSteps("Engine"),
  },
  {
    id: "settings-updates",
    steps: settingsSteps("Software updates"),
  },
  {
    id: "settings-advanced",
    steps: settingsSteps("Advanced"),
  },
];

function quoted(value) {
  return JSON.stringify(value);
}

function clickSelector(selector) {
  return `(() => {
    const element = document.querySelector(${quoted(selector)});
    if (!(element instanceof HTMLElement)) throw new Error("Missing clickable selector: " + ${quoted(selector)});
    element.click();
  })()`;
}

function clickTestId(testId) {
  return clickSelector(`[data-testid="${testId}"]`);
}

function clickButtonText(selector, text) {
  return `(() => {
    const element = [...document.querySelectorAll(${quoted(selector)})]
      .find((candidate) => candidate.textContent?.trim() === ${quoted(text)});
    if (!(element instanceof HTMLElement)) throw new Error("Missing button text: " + ${quoted(text)});
    element.click();
  })()`;
}

function setInput(selector, value) {
  return `(() => {
    const input = document.querySelector(${quoted(selector)});
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing input: " + ${quoted(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, ${quoted(value)});
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${quoted(value)} }));
    input.focus();
  })()`;
}

function settingsSteps(label) {
  return [
    {
      expression: clickTestId("nav-settings"),
      waitFor: '[data-testid="settings-screen"]',
    },
    {
      expression: clickButtonText(
        '[aria-label="Settings sections"] button',
        label,
      ),
    },
  ];
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
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

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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
  if (!port) throw new Error("Could not reserve a local capture port");
  return port;
}

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname);
      const relativePath =
        pathname === "/" || pathname.endsWith("/")
          ? `${pathname}index.html`
          : pathname;
      const candidate = resolve(rendererDirectory, `.${relativePath}`);
      if (
        candidate !== rendererDirectory &&
        !candidate.startsWith(`${rendererDirectory}${sep}`)
      ) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const info = await stat(candidate);
      if (!info.isFile()) throw new Error("Not a file");
      const content = await readFile(candidate);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type":
          mimeTypes.get(extname(candidate)) ?? "application/octet-stream",
      });
      response.end(content);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("Static capture server did not expose a TCP address");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

class CDPClient {
  constructor(socket) {
    this.socket = socket;
    this.counter = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`,
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
      const timeout = setTimeout(
        () => rejectOpen(new Error("Chrome DevTools connection timed out")),
        captureTimeoutMs,
      );
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolveOpen();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        rejectOpen(new Error("Chrome DevTools connection failed"));
      });
    });
    return new CDPClient(socket);
  }

  /**
   * Every request is bounded, because an unbounded one hangs the whole run silently.
   *
   * This used to return a promise that settled only when a reply arrived. When the renderer
   * stopped answering — a page-side await that never resolves, a compositor that stops running
   * frames — the reply never came and this promise never settled. Nothing above could recover:
   * `waitForSelector` has a deadline, but it awaits this call before it can check the clock, so
   * the deadline was never reached. The run stopped mid-sequence with no output, no error and no
   * exit, and had to be killed by hand; the capture directory was left half-deleted, because the
   * harness clears each state's file before rewriting it.
   *
   * A timeout here turns every one of those into a named failure.
   */
  send(method, params = {}) {
    const id = ++this.counter;
    return new Promise((resolveResult, rejectResult) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectResult(
          new Error(
            `Chrome DevTools did not answer ${method} within ${captureTimeoutMs}ms`,
          ),
        );
      }, captureTimeoutMs);
      const settle = (outcome) => (value) => {
        clearTimeout(timeout);
        outcome(value);
      };
      this.pending.set(id, {
        method,
        resolve: settle(resolveResult),
        reject: settle(rejectResult),
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
      // Electron is still starting.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the Electron capture target");
}

async function evaluate(client, expression, awaitPromise = true) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Capture expression failed",
    );
  }
  return result.result?.value;
}

async function waitForSelector(client, selector) {
  const deadline = Date.now() + captureTimeoutMs;
  while (Date.now() < deadline) {
    const found = await evaluate(
      client,
      `Boolean(document.querySelector(${quoted(selector)}))`,
    );
    if (found) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for selector ${selector}`);
}

async function settle(client) {
  await evaluate(
    client,
    `(async () => {
      await document.fonts.ready;
      // Two frames, or 10s, whichever comes first.
      //
      // requestAnimationFrame only fires while the window is being composited, and this harness
      // spawns a real visible Electron window — so when the desktop stops updating it (occluded,
      // another workspace, an idle compositor) the callback never runs and this promise never
      // settles. Every wait in this file is bounded except the ones inside the page, so that
      // presented as a silent hang: the run stopped mid-sequence with no output and no error,
      // and had to be killed.
      //
      // The bound is deliberately far longer than a frame. At 2s it fired on a merely slow
      // compositor rather than a stalled one, and the captures stopped being deterministic
      // within a single run: containers and containers-current, which are the same screen and
      // must be byte-identical, drifted 0.00296. A healthy run must always settle on frames.
      await Promise.race([
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        new Promise((resolve) => setTimeout(resolve, 10000)),
      ]);
    })()`,
  );
  await delay(40);
}

await mkdir(outputDirectory, { recursive: true });
for (const state of states) {
  await rm(resolve(outputDirectory, `${state.id}.png`), { force: true });
}

const rendererBuild = await hashDirectory(rendererDirectory);
const harnessContent = await readFile(scriptPath);
const userDataDirectory = await mkdtemp(
  resolve(tmpdir(), "anchorage-design-capture-"),
);
const { server, url } = await startStaticServer();
const debuggingPort = await freePort();
const electron = spawn(
  electronPath,
  [
    `--remote-debugging-port=${debuggingPort}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDirectory}`,
    "--force-device-scale-factor=1",
    url,
  ],
  {
    cwd: workspaceRoot,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let electronStderr = "";
electron.stderr.setEncoding("utf8");
electron.stderr.on("data", (chunk) => {
  electronStderr = `${electronStderr}${chunk}`.slice(-64 * 1024);
});

let client;
const capturedStates = [];
try {
  const target = await waitForTarget(debuggingPort, url);
  client = await CDPClient.connect(target.webSocketDebuggerUrl);
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Emulation.setDeviceMetricsOverride", {
      width: canonicalViewport.width,
      height: canonicalViewport.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: canonicalViewport.width,
      screenHeight: canonicalViewport.height,
    }),
    client.send("Emulation.setLocaleOverride", { locale: "en-GB" }),
    client.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/London" }),
  ]);
  const browserVersion = await client.send("Browser.getVersion");

  for (const state of states) {
    // designCapture freezes the status-bar clock. Without it the wall time landed in every
    // frame, so two runs of an identical build never produced identical bytes and the
    // per-file SHA-256 binding in visual-review-attestation.json was invalidated by every
    // re-capture, whether or not anything had actually changed.
    await client.send("Page.navigate", {
      url: `${url}?capture=${encodeURIComponent(state.id)}&designCapture=1`,
    });
    await waitForSelector(client, '[data-testid="shell"]');
    await settle(client);
    const steps = state.steps ?? (
      state.expression
        ? [{ expression: state.expression, waitFor: state.waitFor }]
        : []
    );
    for (const step of steps) {
      await evaluate(client, step.expression);
      if (step.waitFor) await waitForSelector(client, step.waitFor);
      await settle(client);
    }
    if (state.hover) {
      const point = await evaluate(
        client,
        `(() => {
          const element = document.querySelector(${quoted(state.hover)});
          if (!(element instanceof HTMLElement)) throw new Error("Missing hover selector: " + ${quoted(state.hover)});
          const rect = element.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`,
      );
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "none",
      });
      await settle(client);
    }
    await evaluate(
      client,
      `(() => {
        if (document.activeElement instanceof HTMLElement &&
            !document.activeElement.matches('[data-testid="global-search"]')) {
          document.activeElement.blur();
        }
      })()`,
    );
    await settle(client);
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const content = Buffer.from(screenshot.data, "base64");
    const path = resolve(outputDirectory, `${state.id}.png`);
    await writeFile(path, content);
    capturedStates.push({
      state: state.id,
      path: `${basename(outputDirectory)}/${state.id}.png`,
      sha256: sha256(content),
      bytes: content.byteLength,
      dimensions: canonicalViewport,
    });
  }

  const provenance = {
    schemaVersion: 1,
    captureMode: "fixture-browser",
    bridgeMode: "fixture",
    capturedAt: new Date().toISOString(),
    source: "app/dist/client",
    canonicalViewport,
    rendererBuild,
    harness: {
      path: "tools/capture-design-parity.mjs",
      sha256: sha256(harnessContent),
    },
    runtime: {
      executable: "app/node_modules/electron/dist/electron",
      product: browserVersion.product,
      protocolVersion: browserVersion.protocolVersion,
      revision: browserVersion.revision,
      userAgent: browserVersion.userAgent,
      jsVersion: browserVersion.jsVersion,
    },
    states: capturedStates,
  };
  await writeFile(
    resolve(outputDirectory, "capture-provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  process.stdout.write(
    `PASS: captured ${capturedStates.length} canonical states from renderer ${rendererBuild.sha256.slice(0, 12)}.\n`,
  );
} catch (error) {
  process.stderr.write(
    `FAIL: ${error instanceof Error ? error.message : String(error)}\n${electronStderr}\n`,
  );
  process.exitCode = 1;
} finally {
  if (client) {
    try {
      await client.send("Browser.close");
    } catch {
      // The browser may already be closing.
    }
    client.close();
  }
  if (electron.exitCode === null && electron.signalCode === null) {
    electron.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => electron.once("exit", resolveExit)),
      delay(2_000),
    ]);
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(userDataDirectory, { recursive: true, force: true });
}
