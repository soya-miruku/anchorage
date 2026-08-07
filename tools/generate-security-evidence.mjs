#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCoreLaunchPolicy } from "../app/electron/core-launch-policy.mjs";
import {
  ELECTRON_SECURITY_POLICY_VERSION,
  createContentSecurityPolicy,
  createSecureWebPreferences,
  installSessionSecurity,
  installWebContentsSecurity,
} from "../app/electron/security-policy.mjs";
import {
  runBoundedProcess,
  validateNpmAuditResult,
} from "./security-evidence-helpers.mjs";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const appDirectory = resolve(workspaceRoot, "app");
const outputDirectory = resolve(workspaceRoot, "artifacts/security");
const electronEvidencePath = resolve(outputDirectory, "electron-config.json");
const dependencyEvidencePath = resolve(outputDirectory, "dependency-audit.json");
const auditTimeoutMs = 120_000;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function assertCheck(checks, id, condition, evidence) {
  checks.push({ id, status: condition ? "passed" : "failed", evidence });
  if (!condition) {
    throw new Error(`Electron security check failed: ${id}`);
  }
}

function preventableEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

function evaluateSecurityPolicy() {
  const checks = [];
  const preload = "/opt/anchorage/electron/preload.cjs";
  const preferences = createSecureWebPreferences({
    preload,
    devTools: false,
  });
  assertCheck(
    checks,
    "renderer-process-isolation",
    preferences.preload === preload &&
      preferences.nodeIntegration === false &&
      preferences.nodeIntegrationInWorker === false &&
      preferences.nodeIntegrationInSubFrames === false &&
      preferences.contextIsolation === true &&
      preferences.sandbox === true &&
      preferences.webSecurity === true &&
      preferences.allowRunningInsecureContent === false &&
      preferences.webviewTag === false &&
      preferences.navigateOnDragDrop === false &&
      preferences.devTools === false,
    {
      policyVersion: ELECTRON_SECURITY_POLICY_VERSION,
      preferences,
    },
  );

  const productionCsp = createContentSecurityPolicy({
    development: false,
    port: null,
  });
  const developmentCsp = createContentSecurityPolicy({
    development: true,
    port: "5173",
  });
  assertCheck(
    checks,
    "content-security-policy",
    productionCsp.includes("default-src 'self'") &&
      productionCsp.includes("object-src 'none'") &&
      productionCsp.includes("frame-src 'none'") &&
      productionCsp.includes("form-action 'none'") &&
      productionCsp.includes("frame-ancestors 'none'") &&
      productionCsp.includes("script-src 'self'") &&
      !productionCsp.includes("script-src 'self' 'unsafe-inline'") &&
      developmentCsp.includes(
        "connect-src 'self' ws://127.0.0.1:5173 ws://localhost:5173",
      ),
    {
      policyVersion: ELECTRON_SECURITY_POLICY_VERSION,
      production: productionCsp,
      development: developmentCsp,
    },
  );

  const trustedUrl = "file:///opt/anchorage/dist/client/index.html";
  const sessionHandlers = {};
  const activeSession = {
    setPermissionCheckHandler(handler) {
      sessionHandlers.permissionCheck = handler;
    },
    setPermissionRequestHandler(handler) {
      sessionHandlers.permissionRequest = handler;
    },
    setDevicePermissionHandler(handler) {
      sessionHandlers.devicePermission = handler;
    },
    on(event, handler) {
      sessionHandlers[event] = handler;
    },
    webRequest: {
      onBeforeRequest(handler) {
        sessionHandlers.beforeRequest = handler;
      },
      onHeadersReceived(handler) {
        sessionHandlers.headersReceived = handler;
      },
    },
  };
  installSessionSecurity(activeSession, {
    isAllowedRendererRequest: (url) => url === trustedUrl,
    isTrustedRendererUrl: (url) => url === trustedUrl,
    contentSecurityPolicy: productionCsp,
  });

  let permissionAllowed = true;
  sessionHandlers.permissionRequest(null, "notifications", (allowed) => {
    permissionAllowed = allowed;
  });
  const downloadEvent = preventableEvent();
  sessionHandlers["will-download"](downloadEvent);
  let trustedRequest;
  let blockedRequest;
  sessionHandlers.beforeRequest({ url: trustedUrl }, (decision) => {
    trustedRequest = decision;
  });
  sessionHandlers.beforeRequest(
    { url: "https://untrusted.invalid/" },
    (decision) => {
      blockedRequest = decision;
    },
  );
  let trustedHeaders;
  sessionHandlers.headersReceived(
    {
      url: trustedUrl,
      responseHeaders: { "Cross-Origin-Resource-Policy": ["same-origin"] },
    },
    (decision) => {
      trustedHeaders = decision;
    },
  );
  assertCheck(
    checks,
    "permission-download-request-and-csp-policy",
    sessionHandlers.permissionCheck() === false &&
      permissionAllowed === false &&
      sessionHandlers.devicePermission({ deviceType: "usb" }) === false &&
      downloadEvent.prevented === true &&
      trustedRequest?.cancel === false &&
      blockedRequest?.cancel === true &&
      trustedHeaders?.responseHeaders?.["Content-Security-Policy"]?.[0] ===
        productionCsp,
    {
      permissionCheck: false,
      permissionRequest: permissionAllowed,
      devicePermission: false,
      downloadPrevented: downloadEvent.prevented,
      trustedRequest,
      blockedRequest,
      trustedCspApplied:
        trustedHeaders?.responseHeaders?.["Content-Security-Policy"]?.[0] ===
        productionCsp,
    },
  );

  const webContentsHandlers = {};
  installWebContentsSecurity(
    {
      on(event, handler) {
        webContentsHandlers[event] = handler;
      },
      setWindowOpenHandler(handler) {
        webContentsHandlers.windowOpen = handler;
      },
    },
    {
      isTrustedNavigation: (url) => url === trustedUrl,
    },
  );
  const webviewEvent = preventableEvent();
  const trustedNavigationEvent = preventableEvent();
  const blockedNavigationEvent = preventableEvent();
  const blockedRedirectEvent = preventableEvent();
  webContentsHandlers["will-attach-webview"](webviewEvent);
  webContentsHandlers["will-navigate"](trustedNavigationEvent, trustedUrl);
  webContentsHandlers["will-navigate"](
    blockedNavigationEvent,
    "https://untrusted.invalid/",
  );
  webContentsHandlers["will-redirect"](
    blockedRedirectEvent,
    "https://untrusted.invalid/",
  );
  const popupDecision = webContentsHandlers.windowOpen({ url: trustedUrl });
  assertCheck(
    checks,
    "navigation-webview-and-popup-denial",
    webviewEvent.prevented === true &&
      trustedNavigationEvent.prevented === false &&
      blockedNavigationEvent.prevented === true &&
      blockedRedirectEvent.prevented === true &&
      popupDecision?.action === "deny",
    {
      webviewPrevented: webviewEvent.prevented,
      trustedNavigationPrevented: trustedNavigationEvent.prevented,
      blockedNavigationPrevented: blockedNavigationEvent.prevented,
      blockedRedirectPrevented: blockedRedirectEvent.prevented,
      popupDecision,
    },
  );

  return checks;
}

export async function generateSecurityEvidence() {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    rm(electronEvidencePath, { force: true }),
    rm(dependencyEvidencePath, { force: true }),
  ]);

  /*
   * npm's lockfile, derived rather than committed.
   *
   * Bun is the package runtime and `bun.lock` is what the repository carries. `bun audit --json`
   * exists but answers `{}` — no `auditReportVersion`, no `metadata.vulnerabilities` — so it
   * cannot satisfy validateNpmAuditResult, and weakening that check to fit the tool would be
   * trading a security gate for a convenience. npm's advisory database is still the source, and
   * `npm audit` reads a lockfile it understands.
   *
   * So one is derived here from the same package.json, with no install and no scripts. It is a
   * build input rather than a source of truth: two committed lockfiles for one dependency set is
   * two answers to the same question. Verified against the installed tree when the runtime moved
   * to bun — TypeScript 7.0.2, Electron 43.2.0, Vite 6.4.3, React 19.2.0 and Vitest 4.1.10 all
   * resolve identically either way — and the audit below reports on whatever this produces, so a
   * divergence would show up as a different dependency set rather than pass silently.
   */
  await ensureNpmLockfile();

  const [
    mainSource,
    preloadSource,
    contractsSource,
    coreLaunchPolicySource,
    protocolSchemaSource,
    policySource,
    helperSource,
    generatorSource,
    packageSource,
    lockSource,
  ] = await Promise.all([
    readFile(resolve(appDirectory, "electron/main.mjs"), "utf8"),
    readFile(resolve(appDirectory, "electron/preload.cjs"), "utf8"),
    readFile(resolve(appDirectory, "electron/contracts.mjs"), "utf8"),
    readFile(
      resolve(appDirectory, "electron/core-launch-policy.mjs"),
      "utf8",
    ),
    readFile(resolve(workspaceRoot, "protocol/v1.schema.json"), "utf8"),
    readFile(resolve(appDirectory, "electron/security-policy.mjs"), "utf8"),
    readFile(resolve(workspaceRoot, "tools/security-evidence-helpers.mjs"), "utf8"),
    readFile(fileURLToPath(import.meta.url), "utf8"),
    readFile(resolve(appDirectory, "package.json"), "utf8"),
    readFile(resolve(appDirectory, "package-lock.json"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);
  const packageLock = JSON.parse(lockSource);
  const checks = evaluateSecurityPolicy();
  const coreLaunchPolicy = resolveCoreLaunchPolicy();
  const filesystemRoot = parse(coreLaunchPolicy.cwd).root;
  assertCheck(
    checks,
    "current-user-cwd-reachability",
    coreLaunchPolicy.cwd !== filesystemRoot &&
      coreLaunchPolicy.allowedCwdRoot === filesystemRoot &&
      coreLaunchPolicy.args.length === 2 &&
      coreLaunchPolicy.args[0] === "--allow-cwd" &&
      coreLaunchPolicy.args[1] === filesystemRoot,
    {
      coreProcessCwd: coreLaunchPolicy.cwd,
      allowedCwdRoot: coreLaunchPolicy.allowedCwdRoot,
      args: [...coreLaunchPolicy.args],
      authorization: "same-user-os-permissions",
    },
  );

  const behavioralTests = await runBoundedProcess(
    process.execPath,
    [
      "--test",
      "electron/contracts.test.mjs",
      "electron/protocol-contract.test.mjs",
      "electron/security-policy.test.mjs",
      "electron/preload.test.mjs",
      "electron/core-launch-policy.test.mjs",
      "electron/core-supervisor.test.mjs",
    ],
    {
      cwd: appDirectory,
      timeoutMs: 60_000,
    },
  );
  assertCheck(
    checks,
    "behavioral-electron-security-tests",
    behavioralTests.code === 0,
    {
      command:
        "node --test electron/contracts.test.mjs electron/protocol-contract.test.mjs electron/security-policy.test.mjs electron/preload.test.mjs electron/core-launch-policy.test.mjs electron/core-supervisor.test.mjs",
      exitCode: behavioralTests.code,
      stdoutSha256: sha256(behavioralTests.stdout),
      stderr: behavioralTests.stderr.trim(),
    },
  );

  const auditRun = await runBoundedProcess(
    "npm",
    ["audit", "--json"],
    {
      cwd: appDirectory,
      timeoutMs: auditTimeoutMs,
    },
  );
  const audit = validateNpmAuditResult(auditRun);
  const vulnerabilityCounts = audit.metadata.vulnerabilities;

  const generatedAt = new Date().toISOString();
  await Promise.all([
    writeFile(
      electronEvidencePath,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          generatedAt,
          status: "passed",
          policyVersion: ELECTRON_SECURITY_POLICY_VERSION,
          application: {
            electron: packageJson.devDependencies.electron,
            vite: packageJson.devDependencies.vite,
          },
          sourceHashes: {
            main: sha256(mainSource),
            preload: sha256(preloadSource),
            contracts: sha256(contractsSource),
            coreLaunchPolicy: sha256(coreLaunchPolicySource),
            protocolSchema: sha256(protocolSchemaSource),
            securityPolicy: sha256(policySource),
            securityEvidenceHelpers: sha256(helperSource),
            generator: sha256(generatorSource),
          },
          checks,
        },
        null,
        2,
      )}\n`,
      { mode: 0o644 },
    ),
    writeFile(
      dependencyEvidencePath,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          generatedAt,
          status: "passed",
          command: "npm audit --json",
          auditReportVersion: audit.auditReportVersion,
          packageLockVersion: packageLock.lockfileVersion,
          packageLockSha256: sha256(lockSource),
          vulnerabilities: vulnerabilityCounts,
          dependencies: audit.metadata.dependencies,
        },
        null,
        2,
      )}\n`,
      { mode: 0o644 },
    ),
  ]);

  process.stdout.write(
    `PASS: ${checks.length} behavioral Electron security controls and ` +
      `${vulnerabilityCounts.total} dependency vulnerabilities.\n`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  generateSecurityEvidence().catch((error) => {
    process.stderr.write(
      `[anchorage-security] ${error.stack ?? error.message}\n`,
    );
    process.exitCode = 1;
  });
}

/**
 * Writes app/package-lock.json from package.json when it is absent.
 *
 * `--package-lock-only` resolves the tree and writes the lockfile without installing anything;
 * `--ignore-scripts` means nothing in the dependency graph executes to produce it.
 */
async function ensureNpmLockfile() {
  const lockPath = resolve(appDirectory, "package-lock.json");
  if (existsSync(lockPath)) {
    return;
  }
  const derive = await runBoundedProcess(
    "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: appDirectory, timeoutMs: auditTimeoutMs },
  );
  if (derive.code !== 0 || !existsSync(lockPath)) {
    throw new Error(
      `Could not derive package-lock.json for npm audit: ${derive.stderr || derive.stdout}`,
    );
  }
}
