#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
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
   * to bun — TypeScript 7.0.2, Electron 43.4.0, Vite 7.3.6, React 19.2.8 and Vitest 4.1.10 all
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
/**
 * Reads the versions bun actually installs, keyed by package name.
 *
 * Only unambiguous names are returned. bun.lock can carry the same package at two versions in
 * different positions, and this map has no positions in it — so a name with more than one version
 * is left out rather than guessed at, and the audit sees npm's resolution for it. Skipping is the
 * conservative direction: it can miss an advisory, where guessing could invent one.
 */
function bunResolvedVersions(lockText) {
  const versions = new Map();
  const ambiguous = new Set();
  for (const [, spec] of lockText.matchAll(/^\s*"[^"]+":\s*\["([^"]+)"/gmu)) {
    const at = spec.lastIndexOf("@");
    if (at <= 0) continue;
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    if (versions.has(name) && versions.get(name) !== version) ambiguous.add(name);
    else versions.set(name, version);
  }
  for (const name of ambiguous) versions.delete(name);
  return versions;
}

async function ensureNpmLockfile() {
  const lockPath = resolve(appDirectory, "package-lock.json");
  /*
  Always derived fresh, never reused.

  This file is a build input rather than a source of truth, and a stale one is worse than none: it
  pins whatever npm resolved on some earlier day, so the audit describes neither the tree that
  ships nor the ranges in package.json. Measured — a leftover copy pinning nanoid 3.3.17 failed a
  packaging run against an advisory that a fresh derivation resolves past.
  */
  rmSync(lockPath, { force: true });
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

  /*
  Align the derived tree to the versions bun installs, so the audit is about what ships.

  npm derives by resolving package.json's ranges to the newest match; bun installs whatever
  bun.lock pins. Those are usually the same and are not required to be, and where they differ the
  audit was describing a tree nobody runs. That is not hypothetical: bun.lock pinned nanoid 3.3.17
  against an advisory fixed in 3.3.18, npm's fresh derivation picked 3.3.18, and the gate reported
  zero vulnerabilities while the vulnerable copy was the one in node_modules and in the package.

  Only the version field is rewritten. `resolved` and `integrity` still describe npm's choice and
  are left alone deliberately — nothing is installed from this file, npm audit looks advisories up
  by name and version, and rewriting fields the audit does not read would make the file claim to be
  something it is not. Verified: patching a version to a vulnerable one makes `npm audit` report
  that advisory, which is the whole mechanism this relies on.
  */
  const bunLockPath = resolve(appDirectory, "bun.lock");
  if (!existsSync(bunLockPath)) return;
  const installed = bunResolvedVersions(await readFile(bunLockPath, "utf8"));
  const derived = JSON.parse(await readFile(lockPath, "utf8"));
  let aligned = 0;
  for (const [path, meta] of Object.entries(derived.packages ?? {})) {
    const name = path.split("node_modules/").pop();
    if (!name || !meta?.version) continue;
    const version = installed.get(name);
    if (version && version !== meta.version) {
      meta.version = version;
      aligned += 1;
    }
  }
  if (aligned > 0) {
    await writeFile(lockPath, `${JSON.stringify(derived, null, 2)}\n`);
    process.stderr.write(
      `[anchorage-security] audited ${aligned} package(s) at the version bun.lock installs ` +
        `rather than the version npm would resolve\n`,
    );
  }
}
