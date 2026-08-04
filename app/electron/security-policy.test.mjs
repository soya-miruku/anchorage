import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ELECTRON_RUNTIME_UNOBSERVABLE_PREFERENCE_KEYS,
  assertOSSandboxEnabled,
  findSandboxDisablingSwitches,
  assertRuntimeSecureWebPreferences,
  assertSecureWebPreferences,
  createContentSecurityPolicy,
  createSecureWebPreferences,
  installSessionSecurity,
  installWebContentsSecurity,
} from "./security-policy.mjs";

test("creates the exact hardened BrowserWindow webPreferences", () => {
  const expected = {
    preload: "/opt/anchorage/electron/preload.cjs",
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
    devTools: false,
  };
  assert.deepEqual(
    createSecureWebPreferences({
      preload: expected.preload,
      devTools: false,
    }),
    expected,
  );
  assert.doesNotThrow(() =>
    assertSecureWebPreferences(
      { ...expected, additionalRuntimePreference: true },
      expected,
    ),
  );
  assert.throws(
    () =>
      assertSecureWebPreferences(
        { ...expected, sandbox: false },
        expected,
      ),
    /sandbox/u,
  );
  assert.doesNotThrow(() =>
    assertRuntimeSecureWebPreferences(
      {
        preload: undefined,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      },
      expected,
    ),
  );
  for (const key of ELECTRON_RUNTIME_UNOBSERVABLE_PREFERENCE_KEYS) {
    assert.throws(
      () =>
        assertRuntimeSecureWebPreferences(
          {
            ...expected,
            preload: undefined,
            [key]: !expected[key],
          },
          expected,
        ),
      new RegExp(key, "u"),
    );
  }
  assert.throws(
    () =>
      assertRuntimeSecureWebPreferences(
        {
          preload: undefined,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          contextIsolation: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
        },
        expected,
      ),
    /sandbox/u,
  );
  assert.throws(
    () =>
      assertRuntimeSecureWebPreferences(
        { ...expected, preload: "/tmp/unexpected-preload.cjs" },
        expected,
      ),
    /preload/u,
  );
  assert.throws(
    () =>
      assertRuntimeSecureWebPreferences(
        expected,
        { ...expected, preload: "" },
      ),
    /preload path/u,
  );
});

test("creates production and loopback-development CSP without widening other directives", () => {
  const production = createContentSecurityPolicy({
    development: false,
    port: null,
  });
  assert.equal(
    production,
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "media-src 'none'",
      "manifest-src 'self'",
    ].join("; "),
  );

  const development = createContentSecurityPolicy({
    development: true,
    port: "5173",
  });
  assert.match(development, /script-src 'self' 'unsafe-inline'/u);
  assert.match(
    development,
    /connect-src 'self' ws:\/\/127\.0\.0\.1:5173 ws:\/\/localhost:5173/u,
  );
  assert.match(development, /object-src 'none'/u);
  assert.match(development, /frame-ancestors 'none'/u);
});

test("installs deny-by-default session handlers and enforces request plus CSP policy", () => {
  const registered = {};
  const activeSession = {
    setPermissionCheckHandler(handler) {
      registered.permissionCheck = handler;
    },
    setPermissionRequestHandler(handler) {
      registered.permissionRequest = handler;
    },
    setDevicePermissionHandler(handler) {
      registered.devicePermission = handler;
    },
    on(event, handler) {
      registered[event] = handler;
    },
    webRequest: {
      onBeforeRequest(handler) {
        registered.beforeRequest = handler;
      },
      onHeadersReceived(handler) {
        registered.headersReceived = handler;
      },
    },
  };
  const trustedUrl = "file:///opt/anchorage/dist/client/index.html";
  const csp = "default-src 'self'; object-src 'none'";

  installSessionSecurity(activeSession, {
    isAllowedRendererRequest: (url) => url === trustedUrl,
    isTrustedRendererUrl: (url) => url === trustedUrl,
    contentSecurityPolicy: csp,
  });

  assert.equal(registered.permissionCheck(), false);
  let permissionDecision = true;
  registered.permissionRequest(null, "notifications", (allowed) => {
    permissionDecision = allowed;
  });
  assert.equal(permissionDecision, false);
  assert.equal(registered.devicePermission({ deviceType: "usb" }), false);

  const downloadEvent = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  registered["will-download"](downloadEvent);
  assert.equal(downloadEvent.prevented, true);

  let beforeRequest;
  registered.beforeRequest({ url: trustedUrl }, (result) => {
    beforeRequest = result;
  });
  assert.deepEqual(beforeRequest, { cancel: false });
  registered.beforeRequest({ url: "https://evil.example/" }, (result) => {
    beforeRequest = result;
  });
  assert.deepEqual(beforeRequest, { cancel: true });

  let headersResult;
  registered.headersReceived(
    {
      url: trustedUrl,
      responseHeaders: { "Cross-Origin-Resource-Policy": ["same-origin"] },
    },
    (result) => {
      headersResult = result;
    },
  );
  assert.deepEqual(headersResult, {
    responseHeaders: {
      "Cross-Origin-Resource-Policy": ["same-origin"],
      "Content-Security-Policy": [csp],
    },
  });
  registered.headersReceived(
    {
      url: "https://evil.example/",
      responseHeaders: { Server: ["untrusted"] },
    },
    (result) => {
      headersResult = result;
    },
  );
  assert.deepEqual(headersResult, {
    responseHeaders: { Server: ["untrusted"] },
  });
});

test("installs webContents handlers that deny webviews, untrusted navigation, redirects, and popups", () => {
  const registered = {};
  const contents = {
    on(event, handler) {
      registered[event] = handler;
    },
    setWindowOpenHandler(handler) {
      registered.windowOpen = handler;
    },
  };
  const trustedUrl = "file:///opt/anchorage/dist/client/index.html";

  installWebContentsSecurity(contents, {
    isTrustedNavigation: (url) => url === trustedUrl,
  });

  const webviewEvent = preventableEvent();
  registered["will-attach-webview"](webviewEvent);
  assert.equal(webviewEvent.prevented, true);

  const trustedNavigation = preventableEvent();
  registered["will-navigate"](trustedNavigation, trustedUrl);
  assert.equal(trustedNavigation.prevented, false);

  const untrustedNavigation = preventableEvent();
  registered["will-navigate"](untrustedNavigation, "https://evil.example/");
  assert.equal(untrustedNavigation.prevented, true);

  const untrustedRedirect = preventableEvent();
  registered["will-redirect"](untrustedRedirect, "https://evil.example/");
  assert.equal(untrustedRedirect.prevented, true);

  assert.deepEqual(registered.windowOpen({ url: trustedUrl }), {
    action: "deny",
  });
});

function preventableEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

test("sandbox-disabling command line switches are detected and rejected", () => {
  assert.deepEqual(findSandboxDisablingSwitches(["/usr/bin/anchorage", "%U"]), []);
  assert.deepEqual(
    findSandboxDisablingSwitches(["AppRun", "--no-sandbox", "%U"]),
    ["--no-sandbox"],
  );
  // electron-builder's AppImage template is the concrete regression this guards.
  assert.throws(
    () => assertOSSandboxEnabled(["AppRun", "--no-sandbox", "%U"]),
    /Chromium OS sandbox disabled: --no-sandbox/,
  );
  assert.throws(
    () => assertOSSandboxEnabled(["anchorage", "--disable-setuid-sandbox=1"]),
    /--disable-setuid-sandbox/,
  );
  assert.doesNotThrow(() => assertOSSandboxEnabled(["anchorage", "%U"]));
});

test("the packaged desktop entry does not disable the OS sandbox", async () => {
  // electron-builder computes the AppImage desktop Exec as `AppRun <executableArgs> %U`, and
  // defaults executableArgs to ["--no-sandbox"] when no appimage toolset is configured. The
  // suppression therefore has to be an explicit empty list: the default is applied with `??`,
  // so omitting the key restores the flag while [] removes it.
  //
  // This previously asserted a `linux.desktop.entry.Exec` override. Current electron-builder
  // rejects that key outright, so the assertion moved to the mechanism that now carries the
  // guarantee rather than being dropped.
  const config = await readFile(
    new URL("../electron-builder.yml", import.meta.url),
    "utf8",
  );
  assert.ok(
    /^appImage:\s*$/mu.test(config),
    "an appImage block must exist to carry executableArgs",
  );
  const executableArgs = config.match(/^\s*executableArgs:\s*(.+)$/mu);
  assert.ok(
    executableArgs,
    "appImage.executableArgs must be set explicitly; omitting it restores --no-sandbox",
  );
  assert.equal(
    executableArgs[1].trim(),
    "[]",
    "appImage.executableArgs must be an empty list, which is what suppresses the default",
  );

  // The old override must not linger: a stale Exec key fails the build outright.
  assert.equal(
    /^\s*Exec:\s*/mu.test(config),
    false,
    "linux.desktop.entry.Exec is rejected by electron-builder and must not be present",
  );

  // Whatever Exec the builder now derives must still be free of sandbox-disabling switches.
  const derivedExec = ["AppRun", "%U"];
  assert.deepEqual(findSandboxDisablingSwitches(derivedExec), []);
});
