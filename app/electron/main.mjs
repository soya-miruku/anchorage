import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, Menu, session } from "electron";

import {
  IPC_CHANNELS,
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
  validateContainersExport,
  validateImagesScout,
  validateVolumeFiles,
  validateVolumeFileRead,
  validateVolumeFileWrite,
  validateBuildsList,
  validateBuildsInspect,
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
  validateSystemAction,
  validateSystemSnapshot,
  validateVolumesAction,
  validateVolumesList,
  validateRendererEventEnvelope,
} from "./contracts.mjs";
import { resolveCoreBinaryPath } from "./core-path.mjs";
import { resolveCoreLaunchPolicy } from "./core-launch-policy.mjs";
import { CoreSupervisor } from "./core-supervisor.mjs";
import {
  accessibilitySmokeEnabled,
  parseDevPort,
  validateLoopbackRendererUrl,
} from "./dev-server-proof.mjs";
import { redactSensitiveText } from "./redaction.mjs";
import {
  assertOSSandboxEnabled,
  assertRuntimeSecureWebPreferences,
  createContentSecurityPolicy,
  createSecureWebPreferences,
  installSessionSecurity,
  installWebContentsSecurity,
} from "./security-policy.mjs";
import {
  ANCHORAGE_APP_HEIGHT,
  ANCHORAGE_APP_WIDTH,
  ANCHORAGE_DESKTOP_SMOKE_RESIZE_RETRY_MS,
  ANCHORAGE_DESKTOP_SMOKE_RESIZE_TARGETS,
  createAnchorageWindowFrameOptions,
  createAnchorageWindowGeometry,
  desktopViewportGeometryMismatches,
  desktopSmokeEnabled,
  observeDesktopViewportConvergence,
  shouldRequestDesktopViewportResize,
} from "./window-geometry.mjs";
import {
  applyWindowBackgroundColor,
  toggleWindowMaximized,
} from "./window-chrome.mjs";

const ELECTRON_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const APP_DIRECTORY = resolve(ELECTRON_DIRECTORY, "..");
const CLIENT_DIRECTORY = resolve(APP_DIRECTORY, "dist", "client");
const CLIENT_ENTRY = resolve(CLIENT_DIRECTORY, "index.html");
const BACKGROUND_COLOR = "#16224a";
const WINDOW_REVEAL_FALLBACK_MS = 1_500;
const DESKTOP_SMOKE_GEOMETRY_TIMEOUT_MS = 5_000;
const DESKTOP_SMOKE_GEOMETRY_POLL_MS = 50;

app.enableSandbox();

let mainWindow = null;
let core = null;
let allowQuit = false;
let quitInProgress = false;
let trustedRenderer;
let smokeCoreReady = false;
let smokeRendererReady = false;
let smokeCompletionStarted = false;
let smokeMode = false;
let windowReadyToShow = false;
let windowBackgroundSynchronized = false;
let windowRevealFallback = null;

function revealWindowWhenReady({ force = false } = {}) {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !windowReadyToShow ||
    (!force && !windowBackgroundSynchronized)
  ) {
    return;
  }
  if (windowRevealFallback !== null) {
    clearTimeout(windowRevealFallback);
    windowRevealFallback = null;
  }
  mainWindow.show();
}

function rendererConfiguration() {
  const requestedDevelopmentUrl = process.env.ANCHORAGE_RENDERER_URL?.trim();

  if (app.isPackaged && requestedDevelopmentUrl) {
    throw new Error("ANCHORAGE_RENDERER_URL is disabled in packaged builds");
  }

  if (requestedDevelopmentUrl) {
    const developmentPort = parseDevPort(process.env.ANCHORAGE_DEV_PORT);
    const parsed = validateLoopbackRendererUrl(
      requestedDevelopmentUrl,
      developmentPort,
    );

    return {
      development: true,
      url: parsed.href,
      origin: parsed.origin,
      port: String(developmentPort),
      entryPath: null,
    };
  }

  return {
    development: false,
    url: pathToFileURL(CLIENT_ENTRY).href,
    origin: "null",
    port: null,
    entryPath: CLIENT_ENTRY,
  };
}

function isPathInside(parent, candidate) {
  const result = relative(parent, candidate);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

function isTrustedRendererUrl(rawUrl, { navigation = false } = {}) {
  if (!trustedRenderer) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (trustedRenderer.development) {
    if (parsed.origin !== trustedRenderer.origin) {
      return false;
    }
    return !navigation || parsed.pathname === "/" || parsed.pathname === "/index.html";
  }

  if (parsed.protocol !== "file:") {
    return false;
  }

  let candidate;
  try {
    candidate = fileURLToPath(parsed);
  } catch {
    return false;
  }

  const resolved = existsSync(candidate) ? realpathSync(candidate) : resolve(candidate);
  if (!isPathInside(CLIENT_DIRECTORY, resolved)) {
    return false;
  }
  return !navigation || resolved === CLIENT_ENTRY;
}

function isAllowedRendererRequest(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (["data:", "blob:"].includes(parsed.protocol)) {
    return true;
  }
  if (trustedRenderer.development && parsed.protocol === "ws:") {
    return (
      parsed.hostname === new URL(trustedRenderer.url).hostname &&
      parsed.port === trustedRenderer.port
    );
  }
  if (trustedRenderer.development && parsed.protocol === "devtools:") {
    return true;
  }
  return isTrustedRendererUrl(rawUrl);
}

function configureSession() {
  installSessionSecurity(session.defaultSession, {
    isAllowedRendererRequest,
    isTrustedRendererUrl,
    contentSecurityPolicy: createContentSecurityPolicy({
      development: trustedRenderer.development,
      port: trustedRenderer.port,
    }),
  });
}

function configureWebContentsSecurity(contents) {
  installWebContentsSecurity(contents, {
    isTrustedNavigation: (url) =>
      isTrustedRendererUrl(url, { navigation: true }),
  });
}

app.on("web-contents-created", (_event, contents) => {
  configureWebContentsSecurity(contents);
});

function createWindow() {
  const preload = resolve(ELECTRON_DIRECTORY, "preload.cjs");
  const window = new BrowserWindow({
    ...createAnchorageWindowGeometry(),
    ...createAnchorageWindowFrameOptions(),
    show: false,
    transparent: false,
    backgroundColor: BACKGROUND_COLOR,
    autoHideMenuBar: true,
    title: "Anchorage",
    webPreferences: createSecureWebPreferences({
      preload,
      devTools: trustedRenderer.development,
    }),
  });

  mainWindow = window;
  windowReadyToShow = false;
  windowBackgroundSynchronized = false;
  if (windowRevealFallback !== null) {
    clearTimeout(windowRevealFallback);
    windowRevealFallback = null;
  }
  window.on("ready-to-show", () => {
    if (!window.isDestroyed()) {
      windowReadyToShow = true;
      revealWindowWhenReady();
      if (!window.isVisible()) {
        windowRevealFallback = setTimeout(() => {
          windowRevealFallback = null;
          revealWindowWhenReady({ force: true });
        }, WINDOW_REVEAL_FALLBACK_MS);
      }
    }
  });
  window.on("closed", () => {
    if (windowRevealFallback !== null) {
      clearTimeout(windowRevealFallback);
      windowRevealFallback = null;
    }
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  window.webContents.once("did-finish-load", () => {
    smokeRendererReady = true;
    void completeDesktopSmokeIfReady();
  });
  window.on("maximize", () => sendRendererEvent("window.maximized", true));
  window.on("unmaximize", () => sendRendererEvent("window.maximized", false));

  void window.loadURL(trustedRenderer.url).catch((error) => {
    console.error(`[anchorage] Failed to load the renderer: ${error.message}`);
    if (!window.isDestroyed()) {
      window.destroy();
    }
  });

  return window;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function readRendererViewportGeometry(window) {
  return window.webContents.executeJavaScript(
    `(() => {
      const rect = (element) => {
        if (!element) return null;
        const bounds = element.getBoundingClientRect();
        return {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height
        };
      };
      const dimensions = (element) => {
        if (!element) return null;
        return {
          client: [element.clientWidth, element.clientHeight],
          scroll: [element.scrollWidth, element.scrollHeight]
        };
      };
      const desk = document.querySelector(".anchorage-desk");
      return {
        viewport: [window.innerWidth, window.innerHeight],
        surfaceMode: desk?.dataset.surfaceMode ?? null,
        desk: rect(desk),
        shell: rect(document.querySelector('[data-testid="shell"]')),
        documentElement: dimensions(document.documentElement),
        body: dimensions(document.body),
        scrollingElement: dimensions(document.scrollingElement)
      };
    })()`,
    true,
  );
}

async function waitForDesktopViewportGeometry(
  window,
  target,
  stage,
  { requestContentSize = false } = {},
) {
  const deadline = Date.now() + DESKTOP_SMOKE_GEOMETRY_TIMEOUT_MS;
  let lastState = null;
  let lastMismatches = ["geometry probe has not run"];
  let matchingSince = null;
  let nextResizeRequestAt = 0;

  while (Date.now() < deadline) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      throw new Error(`window was destroyed while waiting for ${stage}`);
    }

    const now = Date.now();
    if (
      shouldRequestDesktopViewportResize({
        enabled: requestContentSize,
        nextRequestAt: nextResizeRequestAt,
        now,
      })
    ) {
      window.setContentSize(target.width, target.height);
      nextResizeRequestAt =
        now + ANCHORAGE_DESKTOP_SMOKE_RESIZE_RETRY_MS;
    }

    try {
      lastState = {
        nativeContentSize: window.getContentSize(),
        resizable: window.isResizable(),
        renderer: await readRendererViewportGeometry(window),
      };
      lastMismatches = desktopViewportGeometryMismatches(lastState, target);
    } catch (error) {
      lastMismatches = [`geometry probe failed: ${error.message}`];
    }

    const convergence = observeDesktopViewportConvergence({
      matchingSince,
      mismatches: lastMismatches,
      now: Date.now(),
    });
    matchingSince = convergence.matchingSince;
    if (convergence.settled) {
      console.log(
        `ANCHORAGE_DESKTOP_VIEWPORT ${JSON.stringify({
          stage,
          target,
          ...lastState,
        })}`,
      );
      return lastState;
    }

    await delay(DESKTOP_SMOKE_GEOMETRY_POLL_MS);
  }

  throw new Error(
    `${stage} did not converge to ${target.width}x${target.height}: ` +
      `${JSON.stringify({
        mismatches: lastMismatches,
        lastState,
      })}`,
  );
}

async function completeDesktopSmokeIfReady() {
  if (
    !smokeMode ||
    smokeCompletionStarted ||
    !smokeCoreReady ||
    !smokeRendererReady ||
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return;
  }
  smokeCompletionStarted = true;

  try {
    const smokeState = await mainWindow.webContents.executeJavaScript(
      `(async () => {
        const workerExposure = await new Promise((resolveWorker) => {
          const workerUrl = URL.createObjectURL(new Blob([
            "postMessage({ requireType: typeof require, processType: typeof process })"
          ], { type: "text/javascript" }));
          const worker = new Worker(workerUrl);
          let settled = false;
          const settle = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
            resolveWorker(value);
          };
          const timeoutId = setTimeout(
            () => settle({ error: "worker probe timed out" }),
            2000,
          );
          worker.onmessage = (event) => settle(event.data);
          worker.onerror = (event) =>
            settle({ error: String(event.message || "worker probe failed") });
        });
        return {
          bridge: {
            invoke: typeof window.anchorage?.invoke,
            capabilities: typeof window.anchorage?.system?.capabilities,
            snapshot: typeof window.anchorage?.system?.snapshot,
            list: typeof window.anchorage?.containers?.list,
            inspect: typeof window.anchorage?.containers?.inspect,
            stats: typeof window.anchorage?.containers?.stats,
            action: typeof window.anchorage?.containers?.action,
            imagesList: typeof window.anchorage?.images?.list,
            imagesAction: typeof window.anchorage?.images?.action,
            volumesList: typeof window.anchorage?.volumes?.list,
            volumesAction: typeof window.anchorage?.volumes?.action,
            cli: typeof window.anchorage?.cli?.run,
            sessionStart: typeof window.anchorage?.session?.start,
            sessionInput: typeof window.anchorage?.session?.input,
            sessionResize: typeof window.anchorage?.session?.resize,
            sessionSignal: typeof window.anchorage?.session?.signal,
            sessionCancel: typeof window.anchorage?.session?.cancel,
            sessionAck: typeof window.anchorage?.session?.ack,
            subscribe: typeof window.anchorage?.subscribe,
            minimize: typeof window.anchorage?.window?.minimize,
            maximize: typeof window.anchorage?.window?.maximize,
            close: typeof window.anchorage?.window?.close,
            isMaximized: typeof window.anchorage?.window?.isMaximized,
            setBackgroundColor:
              typeof window.anchorage?.window?.setBackgroundColor
          },
          security: {
            mainWorldRequire: typeof window.require,
            mainWorldProcess: typeof window.process,
            workerRequire: workerExposure.requireType,
            workerProcess: workerExposure.processType,
            workerError: workerExposure.error ?? null
          }
        };
      })()`,
      true,
    );
    if (Object.values(smokeState.bridge).some((type) => type !== "function")) {
      throw new Error(
        `preload bridge shape was incomplete: ${JSON.stringify(smokeState.bridge)}`,
      );
    }
    if (
      smokeState.security.mainWorldRequire !== "undefined" ||
      smokeState.security.mainWorldProcess !== "undefined" ||
      smokeState.security.workerRequire !== "undefined" ||
      smokeState.security.workerProcess !== "undefined" ||
      smokeState.security.workerError !== null
    ) {
      throw new Error(
        `renderer Node isolation probe failed: ${JSON.stringify(smokeState.security)}`,
      );
    }
    const runtimeWebPreferences =
      mainWindow.webContents.getLastWebPreferences();
    console.log(
      `ANCHORAGE_DESKTOP_RUNTIME_PREFERENCES ${JSON.stringify(runtimeWebPreferences)}`,
    );
    assertRuntimeSecureWebPreferences(
      runtimeWebPreferences,
      createSecureWebPreferences({
        preload: resolve(ELECTRON_DIRECTORY, "preload.cjs"),
        devTools: trustedRenderer.development,
      }),
    );
    const initialTarget = {
      width: ANCHORAGE_APP_WIDTH,
      height: ANCHORAGE_APP_HEIGHT,
    };
    await waitForDesktopViewportGeometry(
      mainWindow,
      initialTarget,
      "initial",
    );
    for (const target of ANCHORAGE_DESKTOP_SMOKE_RESIZE_TARGETS) {
      await waitForDesktopViewportGeometry(
        mainWindow,
        target,
        `resized-${target.width}x${target.height}`,
        { requestContentSize: true },
      );
    }
    await waitForDesktopViewportGeometry(
      mainWindow,
      initialTarget,
      "restored",
      { requestContentSize: true },
    );
    if (app.isPackaged) {
      mainWindow.webContents.openDevTools({ mode: "detach", activate: false });
      await delay(250);
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
        throw new Error("DevTools opened despite the packaged disable policy");
      }
    }
    console.log("ANCHORAGE_DESKTOP_SMOKE_OK");
    app.quit();
  } catch (error) {
    console.error(`[anchorage] Desktop smoke failed: ${error.message}`);
    await core?.stop();
    app.exit(1);
  }
}

function validateIpcSender(event) {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    !isTrustedRendererUrl(event.senderFrame.url, { navigation: true })
  ) {
    const error = new Error("IPC request rejected: untrusted renderer");
    error.code = "UNTRUSTED_RENDERER";
    throw error;
  }
}

function registerHandler(channel, handler) {
  ipcMain.handle(channel, async (event, value) => {
    try {
      validateIpcSender(event);
      return { ok: true, value: await handler(value) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            typeof error?.code === "string" && error.code.length > 0
              ? error.code.slice(0, 128)
              : "DESKTOP_ERROR",
          message: redactSensitiveText(error?.message || "The desktop request failed"),
          ...(error?.details && typeof error.details === "object"
            ? { details: redactErrorDetails(error.details) }
            : {}),
        },
      };
    }
  });
}

function redactErrorDetails(value, depth = 0) {
  if (depth >= 6) {
    return "[truncated]";
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactErrorDetails(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = [];
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      entries.push([key, redactErrorDetails(item, depth + 1)]);
    }
    return Object.fromEntries(entries);
  }
  return String(value);
}

function activeWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("The Anchorage window is unavailable");
  }
  return mainWindow;
}

function registerIpcHandlers() {
  registerHandler(IPC_CHANNELS.systemCapabilities, (request) =>
    core.request("system.capabilities", validateSystemCapabilities(request), { timeoutMs: 120_000 }),
  );
  // Short timeout on purpose: this is two sub-100ms Docker calls on the launch path. If it
  // cannot answer quickly the window should report that, not wait two minutes the way the
  // capability walk legitimately might.
  registerHandler(IPC_CHANNELS.systemContexts, (request) =>
    core.request("system.contexts", validateSystemContexts(request), {
      timeoutMs: 20_000,
    }),
  );
  registerHandler(IPC_CHANNELS.systemSnapshot, (request) =>
    core.request("system.snapshot", validateSystemSnapshot(request), {
      timeoutMs: 45_000,
    }),
  );
  registerHandler(IPC_CHANNELS.systemAction, (request) =>
    // A full system prune walks containers, networks, images and build cache in sequence, so
    // it gets the mutation-length budget rather than the read budget.
    core.request("system.action", validateSystemAction(request), {
      timeoutMs: 300_000,
    }),
  );
  registerHandler(IPC_CHANNELS.containersList, (request) =>
    core.request("containers.list", validateContainersList(request), { timeoutMs: 45_000 }),
  );
  registerHandler(IPC_CHANNELS.containersInspect, (request) =>
    core.request("containers.inspect", validateContainerIdentity(request), {
      timeoutMs: 45_000,
    }),
  );
  registerHandler(IPC_CHANNELS.containersStats, (request) =>
    core.request("containers.stats", validateContainerIdentity(request), {
      timeoutMs: 45_000,
    }),
  );
  registerHandler(IPC_CHANNELS.containersAction, (request) => {
    assertMutationsEnabled();
    const normalized = validateContainerAction(request);
    const requestedTimeout = normalized.options?.timeoutSeconds ?? 0;
    const coreTimeoutSeconds = Math.max(120, requestedTimeout + 30);
    return core.request("containers.action", normalized, {
      timeoutMs: (coreTimeoutSeconds + 15) * 1_000,
    });
  });
  registerHandler(IPC_CHANNELS.imagesList, (request) =>
    core.request("images.list", validateImagesList(request), {
      timeoutMs: 45_000,
    }),
  );
  registerHandler(IPC_CHANNELS.imagesAction, (request) => {
    assertMutationsEnabled();
    return core.request("images.action", validateImagesAction(request), {
      timeoutMs: 120_000,
    });
  });
  registerHandler(IPC_CHANNELS.volumesList, (request) =>
    core.request("volumes.list", validateVolumesList(request), {
      timeoutMs: 45_000,
    }),
  );
  registerHandler(IPC_CHANNELS.volumesAction, (request) => {
    assertMutationsEnabled();
    return core.request("volumes.action", validateVolumesAction(request), {
      timeoutMs: 120_000,
    });
  });
  registerHandler(IPC_CHANNELS.containersFiles, (request) =>
    core.request("containers.files", validateContainerFiles(request), { timeoutMs: 45_000 }),
  );
  registerHandler(IPC_CHANNELS.containersFileRead, (request) =>
    core.request("containers.fileRead", validateContainerFileRead(request), {
      timeoutMs: 45_000,
    }),
  );
  registerHandler(IPC_CHANNELS.containersFileWrite, (request) => {
    assertMutationsEnabled();
    return core.request("containers.fileWrite", validateContainerFileWrite(request), {
      timeoutMs: 120_000,
    });
  });
  registerHandler(IPC_CHANNELS.containersTop, (request) =>
    core.request("containers.top", validateContainerIdentity(request), { timeoutMs: 30_000 }),
  );
  registerHandler(IPC_CHANNELS.containersDiff, (request) =>
    core.request("containers.diff", validateContainerIdentity(request), { timeoutMs: 45_000 }),
  );
  registerHandler(IPC_CHANNELS.imagesSearch, (request) =>
    core.request("images.search", validateImagesSearch(request), { timeoutMs: 45_000 }),
  );
  registerHandler(IPC_CHANNELS.containersCommit, (request) => {
    assertMutationsEnabled();
    return core.request("containers.commit", validateContainersCommit(request), {
      timeoutMs: 300_000,
    });
  });
  registerHandler(IPC_CHANNELS.imagesInspect, (request) =>
    core.request("images.inspect", validateImagesInspect(request), { timeoutMs: 45_000 }),
  );
  registerHandler(IPC_CHANNELS.containersStatsBatch, (request) =>
    core.request("containers.statsBatch", validateContainersStatsBatch(request), {
      timeoutMs: 45_000,
    }),
  );
  registerHandler(IPC_CHANNELS.containersCreate, (request) => {
    assertMutationsEnabled();
    return core.request("containers.create", validateContainersCreate(request), {
      timeoutMs: 300_000,
    });
  });
  // export writes a host file, so it is a mutation of the host even though the container
  // itself is untouched. The core returns as soon as the session starts; the archive is
  // written by that session, which is why this timeout is a start timeout, not a copy budget.
  registerHandler(IPC_CHANNELS.containersExport, (request) => {
    assertMutationsEnabled();
    return core.request("containers.export", validateContainersExport(request), {
      timeoutMs: 45_000,
    });
  });
  // Scout indexes an image the first time it analyses it, which is slow in proportion to
  // image size; a second run against the same image returns from its cache in seconds.
  registerHandler(IPC_CHANNELS.imagesScout, (request) =>
    core.request("images.scout", validateImagesScout(request), { timeoutMs: 540_000 }),
  );
  // Browsing creates and removes a helper container, so it is slower than a plain read.
  registerHandler(IPC_CHANNELS.volumesFiles, (request) =>
    core.request("volumes.files", validateVolumeFiles(request), { timeoutMs: 120_000 }),
  );
  registerHandler(IPC_CHANNELS.buildsList, (request) =>
    core.request("builds.list", validateBuildsList(request), { timeoutMs: 90_000 }),
  );
  registerHandler(IPC_CHANNELS.buildsInspect, (request) =>
    core.request("builds.inspect", validateBuildsInspect(request), { timeoutMs: 90_000 }),
  );
  // A backup copies the whole volume to disk; a restore writes over it. Both are bounded by
  // volume size rather than latency, so they get the core's own long timeout plus headroom.
  registerHandler(IPC_CHANNELS.volumesBackup, (request) => {
    assertMutationsEnabled();
    return core.request("volumes.backup", validateVolumeBackup(request), {
      timeoutMs: 1_860_000,
    });
  });
  registerHandler(IPC_CHANNELS.volumesRestore, (request) => {
    assertMutationsEnabled();
    return core.request("volumes.restore", validateVolumeRestore(request), {
      timeoutMs: 1_860_000,
    });
  });
  // Writing mounts the helper rw, so it is a mutation even though the volume's own
  // containers are untouched.
  registerHandler(IPC_CHANNELS.volumesFileWrite, (request) => {
    assertMutationsEnabled();
    return core.request("volumes.fileWrite", validateVolumeFileWrite(request), {
      timeoutMs: 120_000,
    });
  });
  registerHandler(IPC_CHANNELS.volumesFileRead, (request) =>
    core.request("volumes.fileRead", validateVolumeFileRead(request), { timeoutMs: 120_000 }),
  );
  registerHandler(IPC_CHANNELS.composeList, (request) =>
    core.request("compose.list", validateComposeList(request), { timeoutMs: 60_000 }),
  );
  registerHandler(IPC_CHANNELS.composePs, (request) =>
    core.request("compose.ps", validateComposePs(request), { timeoutMs: 60_000 }),
  );
  // Every compose verb returns as soon as its session starts, so this is a start timeout,
  // not a budget for `up` to pull images and wait on health checks.
  registerHandler(IPC_CHANNELS.composeAction, (request) => {
    assertMutationsEnabled();
    return core.request("compose.action", validateComposeAction(request), {
      timeoutMs: 45_000,
    });
  });
  registerHandler(IPC_CHANNELS.networksList, (request) =>
    core.request("networks.list", validateNetworksList(request), { timeoutMs: 45_000 }),
  );
  registerHandler(IPC_CHANNELS.networksAction, (request) => {
    assertMutationsEnabled();
    return core.request("networks.action", validateNetworksAction(request), {
      timeoutMs: 120_000,
    });
  });
  registerHandler(IPC_CHANNELS.cliRun, (request) => {
    assertMutationsEnabled();
    const normalized = validateCliRun(request);
    const coreTimeoutSeconds = normalized.timeoutSeconds || 60;
    return core.request("cli.run", normalized, {
      timeoutMs: (coreTimeoutSeconds + 30) * 1_000,
    });
  });
  registerHandler(IPC_CHANNELS.sessionStart, (request) => {
    assertMutationsEnabled();
    return core.request("session.start", validateSessionStart(request), {
      timeoutMs: 45_000,
    });
  });
  registerHandler(IPC_CHANNELS.sessionInput, (request) => {
    assertMutationsEnabled();
    return core.request("session.input", validateSessionInput(request), {
      timeoutMs: 30_000,
    });
  });
  registerHandler(IPC_CHANNELS.sessionResize, (request) => {
    assertMutationsEnabled();
    return core.request("session.resize", validateSessionResize(request), {
      timeoutMs: 30_000,
    });
  });
  registerHandler(IPC_CHANNELS.sessionSignal, (request) => {
    assertMutationsEnabled();
    return core.request("session.signal", validateSessionSignal(request), {
      timeoutMs: 30_000,
    });
  });
  registerHandler(IPC_CHANNELS.sessionCancel, (request) => {
    assertMutationsEnabled();
    return core.request("session.cancel", validateSessionCancel(request), {
      timeoutMs: 30_000,
    });
  });
  registerHandler(IPC_CHANNELS.sessionAck, (request) => {
    assertMutationsEnabled();
    return core.request("session.ack", validateSessionAck(request), {
      timeoutMs: 30_000,
    });
  });

  registerHandler(IPC_CHANNELS.windowMinimize, () => {
    activeWindow().minimize();
    return null;
  });
  registerHandler(IPC_CHANNELS.windowMaximize, () => {
    return toggleWindowMaximized(activeWindow());
  });
  registerHandler(IPC_CHANNELS.windowClose, () => {
    activeWindow().close();
    return null;
  });
  registerHandler(IPC_CHANNELS.windowIsMaximized, () => activeWindow().isMaximized());
  registerHandler(IPC_CHANNELS.windowSetBackgroundColor, (value) => {
    const color = applyWindowBackgroundColor(activeWindow(), value);
    windowBackgroundSynchronized = true;
    revealWindowWhenReady();
    return color;
  });
}

function assertMutationsEnabled() {
  if (smokeMode) {
    const error = new Error("Mutating operations are disabled during desktop smoke");
    error.code = "SMOKE_MUTATION_BLOCKED";
    throw error;
  }
}

function sendRendererEvent(event, payload) {
  const validated = validateRendererEventEnvelope(event, payload);
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed()
  ) {
    return;
  }
  mainWindow.webContents.send(
    IPC_CHANNELS.event,
    validated.event,
    validated.payload,
  );
}

async function initialize() {
  trustedRenderer = rendererConfiguration();
  smokeMode = desktopSmokeEnabled({
    isPackaged: app.isPackaged,
    developmentValue: process.env.ANCHORAGE_DESKTOP_SMOKE,
    packagedValue: process.env.ANCHORAGE_PACKAGED_SMOKE,
  });
  if (
    accessibilitySmokeEnabled(process.env.ANCHORAGE_ACCESSIBILITY_SMOKE, {
      isPackaged: app.isPackaged,
    })
  ) {
    app.setAccessibilitySupportEnabled(true);
  }
  Menu.setApplicationMenu(null);
  configureSession();
  registerIpcHandlers();

  const binaryPath = resolveCoreBinaryPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  const launchPolicy = resolveCoreLaunchPolicy();
  core = new CoreSupervisor({
    binaryPath,
    args: launchPolicy.args,
    cwd: launchPolicy.cwd,
  });
  core.on("status", (status) => {
    sendRendererEvent("core.status", status);
    if (status.state === "ready") {
      smokeCoreReady = true;
      void completeDesktopSmokeIfReady();
    }
  });
  core.on("notification", (event, payload) => {
    try {
      const validated = validateCoreEventEnvelope(event, payload);
      sendRendererEvent(validated.event, validated.payload);
    } catch {
      console.error(
        `[anchorage] Core emitted an invalid event envelope: ` +
          `${String(event).slice(0, 128)}`,
      );
    }
  });
  core.start();

  createWindow();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
// Fail closed before any window exists if the OS sandbox was disabled on the command line.
// webPreferences.sandbox keeps Node out of the renderer; it does not replace the Chromium
// seccomp-bpf/namespace sandbox that --no-sandbox turns off.
try {
  assertOSSandboxEnabled(process.argv);
} catch (error) {
  console.error(`[anchorage] ${error.message}`);
  app.exit(1);
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.whenReady().then(initialize).catch((error) => {
    console.error(`[anchorage] Desktop initialization failed: ${error.stack ?? error.message}`);
    app.exit(1);
  });
}

app.on("activate", () => {
  if (!mainWindow && trustedRenderer) {
    createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (allowQuit || quitInProgress) {
    return;
  }

  event.preventDefault();
  quitInProgress = true;
  Promise.resolve(core?.stop())
    .catch((error) => {
      console.error(`[anchorage] Core shutdown failed: ${error.message}`);
    })
    .finally(() => {
      allowQuit = true;
      app.quit();
    });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => app.quit());
}
