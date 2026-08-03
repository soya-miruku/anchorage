export const ELECTRON_SECURITY_POLICY_VERSION = 1;

export const ELECTRON_RUNTIME_UNOBSERVABLE_PREFERENCE_KEYS = Object.freeze([
  "nodeIntegrationInWorker",
  "navigateOnDragDrop",
  "spellcheck",
  "devTools",
]);

/**
 * Command-line switches that disable the Chromium OS sandbox (seccomp-bpf + user namespaces).
 * This is a distinct control from `webPreferences.sandbox`, which only keeps Node out of the
 * renderer, so neither substitutes for the other.
 *
 * electron-builder's AppImage desktop-entry template defaults to `AppRun --no-sandbox %U`,
 * which silently disabled OS-level containment for every desktop-integrated launch.
 */
export const SANDBOX_DISABLING_SWITCHES = Object.freeze([
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-namespace-sandbox",
  "--disable-seccomp-filter-sandbox",
]);

/**
 * @param {readonly string[]} argv
 * @returns {string[]} the sandbox-disabling switches present in argv
 */
export function findSandboxDisablingSwitches(argv) {
  return SANDBOX_DISABLING_SWITCHES.filter((flag) =>
    argv.some((entry) => entry === flag || entry.startsWith(`${flag}=`)),
  );
}

/**
 * Fails closed when the process was launched with the OS sandbox disabled.
 * @param {readonly string[]} argv
 */
export function assertOSSandboxEnabled(argv) {
  const disabled = findSandboxDisablingSwitches(argv);
  if (disabled.length > 0) {
    throw new Error(
      `Anchorage refuses to run with the Chromium OS sandbox disabled: ${disabled.join(", ")}`,
    );
  }
}

export function createSecureWebPreferences({ preload, devTools }) {
  return {
    preload,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    devTools,
  };
}

export function assertSecureWebPreferences(observed, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (observed?.[key] !== value) {
      throw new Error(
        `Active BrowserWindow webPreference ${key} was ` +
          `${JSON.stringify(observed?.[key])}, expected ${JSON.stringify(value)}`,
      );
    }
  }
}

export function assertRuntimeSecureWebPreferences(observed, expected) {
  if (typeof expected?.preload !== "string" || expected.preload.length === 0) {
    throw new Error("Expected BrowserWindow preload path was not configured");
  }
  if (
    observed?.preload !== undefined &&
    observed.preload !== expected.preload
  ) {
    throw new Error(
      `Active BrowserWindow webPreference preload was ` +
        `${JSON.stringify(observed.preload)}, expected ${JSON.stringify(expected.preload)}`,
    );
  }
  // Electron 43's live getLastWebPreferences snapshot omits the packaged
  // preload path and a small, pinned set of configured preferences. The
  // contextBridge and renderer probes prove the security-sensitive runtime
  // effects, while the package closure binds the exact BrowserWindow source
  // and preload file. Every preference Electron does expose remains required,
  // and any explicitly exposed value must match.
  const { preload: _preload, ...runtimeExpected } = expected;
  void _preload;
  const unobservableKeys = new Set(
    ELECTRON_RUNTIME_UNOBSERVABLE_PREFERENCE_KEYS,
  );
  for (const [key, value] of Object.entries(runtimeExpected)) {
    const runtimeValue = observed?.[key];
    if (
      runtimeValue === undefined &&
      unobservableKeys.has(key)
    ) {
      continue;
    }
    if (runtimeValue !== value) {
      throw new Error(
        `Active BrowserWindow webPreference ${key} was ` +
          `${JSON.stringify(runtimeValue)}, expected ${JSON.stringify(value)}`,
      );
    }
  }
}

export function createContentSecurityPolicy({ development, port }) {
  const scriptSource = development
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self'";
  const connectSource = development
    ? `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`
    : "connect-src 'self'";

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    scriptSource,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    connectSource,
    "worker-src 'self' blob:",
    "media-src 'none'",
    "manifest-src 'self'",
  ].join("; ");
}

export function createSessionSecurityHandlers({
  isAllowedRendererRequest,
  isTrustedRendererUrl,
  contentSecurityPolicy,
}) {
  return {
    permissionCheck: () => false,
    permissionRequest: (_webContents, _permission, callback) => {
      callback(false);
    },
    devicePermission: () => false,
    willDownload: (event) => {
      event.preventDefault();
    },
    beforeRequest: (details, callback) => {
      callback({ cancel: !isAllowedRendererRequest(details.url) });
    },
    headersReceived: (details, callback) => {
      if (!isTrustedRendererUrl(details.url)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [contentSecurityPolicy],
        },
      });
    },
  };
}

export function installSessionSecurity(activeSession, options) {
  const handlers = createSessionSecurityHandlers(options);
  activeSession.setPermissionCheckHandler(handlers.permissionCheck);
  activeSession.setPermissionRequestHandler(handlers.permissionRequest);
  activeSession.setDevicePermissionHandler?.(handlers.devicePermission);
  activeSession.on("will-download", handlers.willDownload);
  activeSession.webRequest.onBeforeRequest(handlers.beforeRequest);
  activeSession.webRequest.onHeadersReceived(handlers.headersReceived);
  return handlers;
}

export function createWebContentsSecurityHandlers({ isTrustedNavigation }) {
  const denyUntrustedNavigation = (event, url) => {
    if (!isTrustedNavigation(url)) {
      event.preventDefault();
    }
  };
  return {
    willAttachWebview: (event) => {
      event.preventDefault();
    },
    willNavigate: denyUntrustedNavigation,
    willRedirect: denyUntrustedNavigation,
    windowOpen: () => ({ action: "deny" }),
  };
}

export function installWebContentsSecurity(contents, options) {
  const handlers = createWebContentsSecurityHandlers(options);
  contents.on("will-attach-webview", handlers.willAttachWebview);
  contents.on("will-navigate", handlers.willNavigate);
  contents.on("will-redirect", handlers.willRedirect);
  contents.setWindowOpenHandler(handlers.windowOpen);
  return handlers;
}
