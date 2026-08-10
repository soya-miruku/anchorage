#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCEPTANCE_MATRIX_VERSION,
  ACCEPTANCE_SCHEMA_VERSION,
  MUTATION_ACCEPTANCE_CHECK_IDS,
  READ_ONLY_ACCEPTANCE_CHECK_IDS,
} from "./acceptance-check-ids.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "..");
const corePath = resolve(
  workspaceRoot,
  process.env.ANCHORAGE_CORE_PATH ?? "core/bin/anchorage-core",
);
const context = process.env.ANCHORAGE_DOCKER_CONTEXT?.trim() || "default";
const runMutations = process.env.ANCHORAGE_ACCEPTANCE_MUTATIONS === "1";
// Sourced from one shared definition; the packaging policy validates the artifact against
// exactly these ids, and keeping a second copy here is what broke packaging when the matrix
// last grew.
const READ_ONLY_CHECK_IDS = READ_ONLY_ACCEPTANCE_CHECK_IDS;
const MUTATION_CHECK_IDS = MUTATION_ACCEPTANCE_CHECK_IDS;
// A long-lived session must be observed well past the return of the request that created it.
// A per-request cancellation change once passed the request context into the session lifetime
// watcher, so every session died the instant session.start returned; eighteen checks that only
// ran short-lived sessions all still passed. Nothing shorter than "several unrelated requests
// later, seconds afterwards" distinguishes a healthy session from that defect.
const LONG_SESSION_PROBE_MS = 2_000;
const LONG_SESSION_HOLD_MS = 8_000;
const LONG_SESSION_EXIT_MS = 10_000;
// Scout indexes an image the first time it sees one, in proportion to its size. Bound the
// candidate so a host whose smallest image is enormous reports an explicit skip instead of
// stalling the read-only gate for minutes.
const SCOUT_MAX_IMAGE_BYTES = 512 * 1_048_576;
const SCOUT_TIMEOUT_MS = 300_000;
const SCOUT_SEVERITIES = Object.freeze([
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNSPECIFIED",
]);
const requiredChecks = runMutations
  ? [...READ_ONLY_CHECK_IDS, ...MUTATION_CHECK_IDS].sort()
  : [...READ_ONLY_CHECK_IDS];
const outputDirectory = resolve(workspaceRoot, "artifacts/docker");
const outputPath = resolve(
  workspaceRoot,
  process.env.ANCHORAGE_ACCEPTANCE_OUTPUT ??
    "artifacts/docker/conformance-results.json",
);
if (
  outputPath !== outputDirectory &&
  !outputPath.startsWith(`${outputDirectory}${sep}`)
) {
  throw new Error(
    "ANCHORAGE_ACCEPTANCE_OUTPUT must resolve inside artifacts/docker",
  );
}

function runProcess(executable, args, { input = "", timeoutMs = 30_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: workspaceRoot,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let killTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      rejectRun(error);
    });
    // `close`, not `exit`: exit fires when the process ends, close fires once its stdio has
    // also been drained. Nothing here needs the earlier event, and reading a command's output
    // is the whole point of running it.
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      resolveRun({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(input);
  });
}

class CoreClient {
  constructor(path) {
    this.child = spawn(path, ["--allow-cwd", workspaceRoot], {
      cwd: workspaceRoot,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = "";
    this.stderr = "";
    this.pending = new Map();
    this.listeners = new Set();
    this.eventHistory = [];
    this.counter = 0;
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-256 * 1024);
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(
        `Anchorage core exited (code=${code}, signal=${signal}): ${this.stderr}`,
      );
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) {
          const error = new Error(
            `${message.error.code ?? "core_error"}: ${message.error.message}`,
          );
          // The code is kept as a field, not just inside the message, because the optional
          // plugin checks must distinguish "the plugin is genuinely not installed" from every
          // other failure by an exact code rather than by matching prose.
          error.code = message.error.code ?? "core_error";
          error.details = message.error.details;
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
      } else if (message.event) {
        this.eventHistory.push(message);
        if (this.eventHistory.length > 5_000) this.eventHistory.shift();
        for (const listener of this.listeners) listener(message);
      }
    }
  }

  request(method, params, timeoutMs = 30_000) {
    const id = `acceptance-${++this.counter}`;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout,
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  waitForEvent(predicate, timeoutMs = 30_000) {
    const existing = this.eventHistory.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveEvent, rejectEvent) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(listener);
        rejectEvent(new Error(`Session event timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const listener = (event) => {
        if (!predicate(event)) return;
        clearTimeout(timeout);
        this.listeners.delete(listener);
        resolveEvent(event);
      };
      this.listeners.add(listener);
    });
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((resolveClose) => {
      let killTimer;
      const finish = () => {
        clearTimeout(killTimer);
        resolveClose();
      };
      this.child.once("exit", finish);
      this.child.stdin.end();
      killTimer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill("SIGKILL");
        }
      }, 2_000);
    });
  }
}

function flattenLeaves(node, result = []) {
  const children = Array.isArray(node?.subcommands) ? node.subcommands : [];
  if (children.length === 0 && node?.path?.length > 0) {
    if (node.status === "available") result.push(node);
    return result;
  }
  children.forEach((child) => flattenLeaves(child, result));
  return result;
}

function outputText(output) {
  if (!output) return "";
  if (output.encoding === "base64") {
    return Buffer.from(output.data, "base64").toString("utf8");
  }
  return output.data ?? "";
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

function sameValues(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function identityEvidence(values) {
  return {
    count: values.length,
    sha256: sha256(`${values.join("\n")}\n`),
    first: values.at(0) ?? null,
    last: values.at(-1) ?? null,
  };
}

function elapsedMs(startedNs) {
  return (
    Math.round((Number(process.hrtime.bigint() - startedNs) / 1_000_000) * 100) /
    100
  );
}

function record(checks, id, name, passed, evidence, startedNs) {
  checks.push({
    id,
    name,
    status: passed ? "passed" : "failed",
    durationMs: elapsedMs(startedNs),
    evidence,
  });
  if (!passed) throw new Error(`${name} failed: ${JSON.stringify(evidence)}`);
}

// recordSkipped exists for exactly one situation: an optional Docker CLI plugin is genuinely
// not installed, or the environment offers nothing the check could legitimately act on. It is
// deliberately a third status rather than a pass, because "18 checks passed" while a verb was
// never exercised is precisely how the session-cancellation defect survived. The reason is
// carried into the artifact and printed in the run summary so an absent plugin cannot be
// mistaken for coverage.
function recordSkipped(checks, id, name, reason, evidence, startedNs) {
  checks.push({
    id,
    name,
    status: "skipped",
    durationMs: elapsedMs(startedNs),
    reason,
    evidence,
  });
}

// isMissingPlugin matches only the core's own "this optional plugin is not installed" codes.
// Any other failure — a broken plugin, a rejected argument, an unreachable daemon — is a real
// failure and must not be softened into a skip.
function isMissingPlugin(error, code) {
  return error?.code === code;
}

async function dockerRun(contextName, args, options) {
  return runProcess("docker", ["--context", contextName, ...args], options);
}

async function dockerLinesAt(contextName, args) {
  const result = await dockerRun(contextName, args);
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `Docker comparison failed${result.timedOut ? " after timeout" : ""}: ${result.stderr}`,
    );
  }
  return result.stdout.split(/\r?\n/u).filter(Boolean);
}

async function dockerOutputAt(contextName, args, options) {
  const result = await dockerRun(contextName, args, options);
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `Docker command failed${result.timedOut ? " after timeout" : ""}: ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

async function collectSession(
  client,
  request,
  expectedText,
  timeoutMs = 60_000,
) {
  const chunks = [];
  const seenSequences = new Set();
  const acceptOutput = async (payload) => {
    if (seenSequences.has(payload.sequence)) return;
    seenSequences.add(payload.sequence);
    chunks.push(outputText(payload));
    await client.request("session.ack", {
      sessionId: request.sessionId,
      throughSequence: payload.sequence,
    });
  };
  const listener = async (event) => {
    if (
      event.event !== "session.output" ||
      event.payload.sessionId !== request.sessionId
    ) {
      return;
    }
    await acceptOutput(event.payload);
  };
  client.listeners.add(listener);
  for (const event of client.eventHistory) {
    if (
      event.event === "session.output" &&
      event.payload.sessionId === request.sessionId
    ) {
      await acceptOutput(event.payload);
    }
  }
  const exitPromise = client.waitForEvent(
    (event) =>
      event.event === "session.exited" &&
      event.payload.sessionId === request.sessionId,
    timeoutMs,
  );
  const exited = await exitPromise;
  client.listeners.delete(listener);
  const text = chunks.join("");
  if (expectedText && !text.includes(expectedText)) {
    throw new Error(
      `Session output did not include ${JSON.stringify(expectedText)}: ${text}`,
    );
  }
  return { exited: exited.payload, text };
}

// attachSessionOutput subscribes to a session's output and acknowledges it, but never waits
// for the session to end. collectSession cannot be used for a session that is meant to stay
// alive, because its whole contract is to block until session.exited arrives.
function attachSessionOutput(client, sessionId) {
  const chunks = [];
  const seenSequences = new Set();
  const state = { lastSequence: 0, chunkCount: 0, exited: null, ackErrors: [] };
  const acceptOutput = async (payload) => {
    if (seenSequences.has(payload.sequence)) return;
    seenSequences.add(payload.sequence);
    chunks.push(outputText(payload));
    state.chunkCount += 1;
    if (payload.sequence > state.lastSequence) {
      state.lastSequence = payload.sequence;
    }
    try {
      await client.request("session.ack", {
        sessionId,
        throughSequence: payload.sequence,
      });
    } catch (error) {
      state.ackErrors.push(error instanceof Error ? error.message : String(error));
    }
  };
  const listener = async (event) => {
    if (event.payload?.sessionId !== sessionId) return;
    if (event.event === "session.output") {
      await acceptOutput(event.payload);
      return;
    }
    if (event.event === "session.exited" && !state.exited) {
      state.exited = event.payload;
    }
  };
  client.listeners.add(listener);
  return {
    state,
    text: () => chunks.join(""),
    detach: () => client.listeners.delete(listener),
  };
}

// readTarHeader reads the leading POSIX tar header block. Save, load and export all write a
// host file whose failure mode is a partially written or empty archive, so the check has to
// look at the bytes rather than trust a zero exit code.
async function readTarHeader(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(512);
    const { bytesRead } = await handle.read(header, 0, 512, 0);
    return {
      bytesRead,
      magic: header.subarray(257, 262).toString("ascii"),
      firstEntry: header
        .subarray(0, 100)
        .toString("ascii")
        .replace(/\0[\s\S]*$/u, ""),
    };
  } finally {
    await handle.close();
  }
}

async function describeArchive(path) {
  const info = await stat(path);
  const header = await readTarHeader(path);
  return {
    path,
    sizeBytes: info.size,
    tarMagic: header.magic,
    firstEntry: header.firstEntry,
    isTar: header.bytesRead === 512 && header.magic === "ustar",
  };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// summarizeSarif is the CLI-side truth the core's Scout projection is compared against. It is
// deliberately an independent reading of the same SARIF — one rule is one finding, graded by
// its CVSS v3 severity — rather than a re-use of anything the core computed.
function summarizeSarif(text) {
  const summary = Object.fromEntries(
    SCOUT_SEVERITIES.map((severity) => [severity, 0]),
  );
  const trimmed = text.trim();
  if (!trimmed) return { summary, total: 0 };
  const report = JSON.parse(trimmed);
  let total = 0;
  for (const run of report.runs ?? []) {
    for (const rule of run.tool?.driver?.rules ?? []) {
      const raw = (rule.properties?.cvssV3_severity ?? "").trim().toUpperCase();
      const severity = SCOUT_SEVERITIES.includes(raw) ? raw : "UNSPECIFIED";
      summary[severity] += 1;
      total += 1;
    }
  }
  return { summary, total };
}

function composeProjectNames(projects) {
  return sortedUnique(projects.map((project) => project.name));
}

// composeCliProjects reads the same `compose ls` surface the core reads, so the comparison is
// against the plugin's own JSON rather than against a re-derived expectation.
async function composeCliProjects(contextName) {
  const raw = await dockerOutputAt(contextName, [
    "compose",
    "ls",
    "--all",
    "--format",
    "json",
  ]);
  const records = raw ? JSON.parse(raw) : [];
  return sortedUnique(records.map((record_) => record_.Name));
}

async function composeCliContainerIds(contextName, project) {
  return sortedUnique(
    await dockerLinesAt(contextName, [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ]),
  );
}

// Compose service IDs are short in the plugin's JSON, so equivalence is by unambiguous prefix
// against the daemon's full IDs rather than by string equality.
function resolveShortIds(shortIds, fullIds) {
  return shortIds.map((short) => {
    const matches = fullIds.filter((full) => full.startsWith(short));
    return matches.length === 1 ? matches[0] : null;
  });
}

async function verifyDisposableOwnership(contextName, name, token) {
  const result = await runProcess("docker", [
    "--context",
    contextName,
    "container",
    "inspect",
    "--format",
    "{{index .Config.Labels \"io.anchorage.acceptance\"}}",
    name,
  ]);
  if (result.code !== 0) {
    if (/No such (?:object|container)/iu.test(result.stderr)) {
      return { exists: false, owned: false };
    }
    throw new Error(
      `Could not inspect disposable container ${name}: ${result.stderr}`,
    );
  }
  return { exists: true, owned: result.stdout.trim() === token };
}

async function containerVolumeMounts(contextName, name) {
  const result = await runProcess("docker", [
    "--context",
    contextName,
    "container",
    "inspect",
    "--format",
    '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}\n{{end}}{{end}}',
    name,
  ]);
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function volumeExistsAt(contextName, name) {
  const result = await runProcess("docker", [
    "--context",
    contextName,
    "volume",
    "inspect",
    name,
  ]);
  return result.code === 0;
}

async function cleanupDisposable(contextName, name, token) {
  const before = await verifyDisposableOwnership(contextName, name, token);
  if (!before.exists) return { anonymousVolumes: [] };
  if (!before.owned) {
    throw new Error(
      `Refusing to clean ${name}: acceptance ownership label does not match`,
    );
  }
  // docker:29-dind declares VOLUME /var/lib/docker, so every disposable daemon creates an
  // anonymous volume on the host. Removing the container without --volumes left exactly one
  // of those behind per mutation run, which accumulated silently on a daemon this harness does
  // not own. --volumes removes only the anonymous volumes of this container; named volumes
  // and volumes shared with anything else are untouched.
  const attachedVolumes = await containerVolumeMounts(contextName, name);
  const removed = await runProcess("docker", [
    "--context",
    contextName,
    "container",
    "rm",
    "--force",
    "--volumes",
    name,
  ]);
  if (removed.code !== 0 || removed.timedOut) {
    throw new Error(
      `Failed to remove disposable container ${name}: ${removed.stderr}`,
    );
  }
  const after = await verifyDisposableOwnership(contextName, name, token);
  if (after.exists) {
    throw new Error(`Disposable container ${name} still exists after cleanup`);
  }
  const surviving = [];
  for (const volume of attachedVolumes) {
    if (await volumeExistsAt(contextName, volume)) surviving.push(volume);
  }
  if (surviving.length > 0) {
    throw new Error(
      `Disposable container ${name} left anonymous volumes on ${contextName}: ${surviving.join(", ")}`,
    );
  }
  return { anonymousVolumes: attachedVolumes };
}

async function inspectDockerContext(name) {
  const result = await runProcess("docker", [
    "context",
    "inspect",
    "--format",
    "{{.Endpoints.docker.Host}}",
    name,
  ]);
  if (result.code === 0 && !result.timedOut) {
    return { exists: true, endpoint: result.stdout.trim() };
  }
  if (
    !result.timedOut &&
    /(?:context .* not found|no such context|does not exist)/iu.test(
      `${result.stdout}\n${result.stderr}`,
    )
  ) {
    return { exists: false, endpoint: null };
  }
  // Everything the process told us, because the alternative is a re-run. An arm64 release job
  // failed here with nothing after the colon: not a timeout, not a recognised "no such context",
  // just a non-zero exit and two empty streams. Whatever that was, the next occurrence should
  // name itself rather than cost another hour of CI to reproduce.
  throw new Error(
    `Could not inspect Docker context ${name}` +
      `${result.timedOut ? " after timeout" : ""}` +
      ` (exit ${result.code}${result.signal ? `, signal ${result.signal}` : ""}):` +
      ` ${result.stderr.trim() || result.stdout.trim() || "no output on either stream"}`,
  );
}

async function cleanupDockerContext(name, expectedEndpoint) {
  const before = await inspectDockerContext(name);
  if (!before.exists) return;
  if (before.endpoint !== expectedEndpoint) {
    throw new Error(
      `Refusing to clean Docker context ${name}: endpoint ownership does not match`,
    );
  }
  const removed = await runProcess("docker", [
    "context",
    "rm",
    "--force",
    name,
  ]);
  if (removed.code !== 0 || removed.timedOut) {
    throw new Error(`Failed to remove Docker context ${name}: ${removed.stderr}`);
  }
  const after = await inspectDockerContext(name);
  if (after.exists) {
    throw new Error(`Docker context ${name} still exists after cleanup`);
  }
}

function imageIds(result) {
  return sortedUnique(result.images.map((image) => image.id));
}

function imageWithId(result, id) {
  return result.images.find(
    (image) => image.id.toLowerCase() === id.toLowerCase(),
  );
}

function volumeNames(result) {
  return sortedUnique(result.volumes.map((volume) => volume.name));
}

function assertCoreRunSucceeded(result, description) {
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      `${description} failed (exit=${result.exitCode}): ${outputText(result.stderr)}`,
    );
  }
}

async function waitForDockerDaemon(contextName, timeoutMs = 90_000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    const info = await dockerRun(
      contextName,
      ["info", "--format", "{{.ServerVersion}}"],
      { timeoutMs: 5_000 },
    );
    if (info.code === 0 && !info.timedOut && info.stdout.trim()) {
      return info.stdout.trim();
    }
    lastError = info.stderr.trim() || `exit=${info.code}`;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(
    `Docker-in-Docker daemon did not become ready: ${lastError}`,
  );
}

const checks = [];
// A skipped check is not a passing check. It is surfaced at the top of the artifact and in the
// run summary so an optional plugin that is simply absent can never be read as coverage of the
// verbs it would have exercised.
//
// Derived when the artifact is written rather than bound once, because an interrupted run has to
// report the checks it had reached at the moment the signal arrived, not the empty list this
// file starts with.
function collectSkippedChecks() {
  return checks
    .filter((check) => check.status === "skipped")
    .map((check) => ({ id: check.id, reason: check.reason }));
}
const startedAt = new Date().toISOString();
await rm(outputPath, { force: true });
const [generatorSha256, coreSha256] = await Promise.all([
  sha256File(scriptPath),
  sha256File(corePath),
]);
const client = new CoreClient(corePath);
let dindResource = null;
let teardownPromise = null;
// Assigned by the signal handlers further down, but bound here because teardown and the artifact
// writers both read them, and they are declared above every one of those.
let interrupted = null;
let abortRecord = null;
let failure = null;
const cleanupErrors = [];
const cleanupEvidence = {
  dockerContext: null,
  dockerSocketContext: null,
  dindContainer: null,
  scratchDirectory: null,
};

// Each cleanup failure records the signal that was already in flight when it happened, or null
// when nothing was interfering.
//
// Teardown started by a signal runs while checks are still executing: it closes the core and
// removes the container out from under whatever the run was doing, so `client.close()` can report
// a shutdown failure in an abort that cleaned up perfectly. Those errors really did occur and are
// kept — dropping them would also hide the teardown that genuinely failed, which reports through
// this same list. What the artifact owes its reader is the difference between the two, and
// `afterSignal` is it: a name means this error was recorded by a teardown already racing an
// interrupt, `null` means the failure is the teardown's own.
//
// Per error rather than per artifact, because a signal that arrives midway through teardown must
// not retroactively excuse the failures teardown had already recorded before it arrived.
function recordCleanupError(error, prefix = "") {
  const message = error instanceof Error ? error.message : String(error);
  cleanupErrors.push({
    message: `${prefix}${message}`,
    afterSignal: interrupted,
  });
}

// One shape for the cleanup block, whichever artifact writes it. A completed run and an
// interrupted run report the same three fields, so the packaging policy — which reads
// `cleanup.status` and `cleanup.errors` — never has to know which kind of run it is holding.
function collectCleanupResult() {
  return {
    status: cleanupErrors.length === 0 ? "passed" : "failed",
    errors: cleanupErrors,
    evidence: cleanupEvidence,
  };
}

// Declared before the try so the signal handlers can reach it too. The body is the existing
// finally block, moved rather than rewritten: this step changes when cleanup runs, not what it
// does, and mixing those two changes would make a teardown regression impossible to bisect.
//
// A shared promise, not a boolean. With `if (teardownComplete) return`, a signal arriving while
// the finally block is mid-teardown returns instantly, and the handler's process.exit() then
// kills the teardown in flight — leaving the privileged container running, which is the exact
// failure this task exists to prevent. Returning the in-flight promise makes the second caller
// wait for the first to finish instead of racing past it.
function runTeardown() {
  if (teardownPromise) return teardownPromise;
  teardownPromise = (async () => {
    if (dindResource?.endpoint) {
      try {
        await cleanupDockerContext(
          dindResource.contextName,
          dindResource.endpoint,
        );
        cleanupEvidence.dockerContext = {
          name: dindResource.contextName,
          endpoint: dindResource.endpoint,
          verifiedAbsent: true,
        };
      } catch (error) {
        recordCleanupError(error);
        cleanupEvidence.dockerContext = {
          name: dindResource.contextName,
          endpoint: dindResource.endpoint,
          verifiedAbsent: false,
        };
      }
    }
    if (dindResource?.socketContextName) {
      try {
        await cleanupDockerContext(
          dindResource.socketContextName,
          dindResource.socketEndpoint,
        );
        cleanupEvidence.dockerSocketContext = {
          name: dindResource.socketContextName,
          endpoint: dindResource.socketEndpoint,
          verifiedAbsent: true,
        };
      } catch (error) {
        recordCleanupError(error);
        cleanupEvidence.dockerSocketContext = {
          name: dindResource.socketContextName,
          endpoint: dindResource.socketEndpoint,
          verifiedAbsent: false,
        };
      }
    }
    if (dindResource) {
      try {
        const disposed = await cleanupDisposable(
          context,
          dindResource.containerName,
          dindResource.token,
        );
        const after = await verifyDisposableOwnership(
          context,
          dindResource.containerName,
          dindResource.token,
        );
        cleanupEvidence.dindContainer = {
          context,
          name: dindResource.containerName,
          ownershipLabel: dindResource.token,
          verifiedAbsent: !after.exists,
          anonymousVolumes: disposed.anonymousVolumes,
          anonymousVolumesVerifiedAbsent: true,
        };
      } catch (error) {
        recordCleanupError(error);
        cleanupEvidence.dindContainer = {
          context,
          name: dindResource.containerName,
          ownershipLabel: dindResource.token,
          verifiedAbsent: false,
          anonymousVolumes: null,
          anonymousVolumesVerifiedAbsent: false,
        };
      }
    }
    try {
      await client.close();
    } catch (error) {
      recordCleanupError(error, "Core shutdown failed: ");
    }
    // The scratch tree is removed after the core exits, because the disposable daemon's Unix
    // socket lives inside it and the core caches an open transport to that endpoint.
    if (dindResource?.scratchDirectory) {
      try {
        await rm(dindResource.scratchDirectory, { recursive: true, force: true });
        const stillPresent = await pathExists(dindResource.scratchDirectory);
        if (stillPresent) {
          throw new Error(
            `Acceptance scratch directory ${dindResource.scratchDirectory} still exists after cleanup`,
          );
        }
        cleanupEvidence.scratchDirectory = {
          path: dindResource.scratchDirectory,
          verifiedAbsent: true,
        };
      } catch (error) {
        recordCleanupError(error);
        cleanupEvidence.scratchDirectory = {
          path: dindResource.scratchDirectory,
          verifiedAbsent: false,
        };
      }
    }
    if (!failure && cleanupErrors.length > 0) {
      failure = new Error(
        cleanupErrors.map((entry) => entry.message).join("; "),
      );
    }
  })();
  return teardownPromise;
}

// One artifact path, and by the end of an interrupted run two callers want it: the epilogue below
// and the signal handler's aborted record.
//
// `writeFile` truncates, so letting both through is not "one of the two records wins". Two
// truncating writes to one path interleave: a real run left a 13,181-byte file whose JSON ended
// at byte 12,774, with the tail of the other record trailing after it — evidence that no reader
// and no gate can parse at all. Even the tidy outcome is a lie, because the last writer to finish
// decides whether an interrupted run is remembered as `aborted` or as `failed`.
//
// The claim is made synchronously, before the first await, which on a single-threaded loop makes
// it a real mutex: the second caller cannot take it, and awaits the first writer's file rather
// than racing it. Returns whether this caller was the one that wrote.
let evidenceWrite = null;
function writeEvidenceOnce(record) {
  if (evidenceWrite) return evidenceWrite.then(() => false);
  evidenceWrite = (async () => {
    await mkdir(resolve(outputPath, ".."), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  })();
  return evidenceWrite.then(() => true);
}

/**
 * The evidence an interrupted run leaves behind.
 *
 * Deliberately not a passing artifact and deliberately not absent: `status: "aborted"` is a third
 * outcome the policy rejects for a release, while still recording which checks had completed and
 * what teardown managed to remove. Silence is the one option that helps nobody.
 */
async function writeAbortedEvidence(signal) {
  try {
    const aborted = {
      schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
      matrixVersion: ACCEPTANCE_MATRIX_VERSION,
      startedAt,
      completedAt: new Date().toISOString(),
      corePath,
      coreSha256,
      generator: { path: scriptPath, sha256: generatorSha256 },
      mutationsEnabled: runMutations,
      status: "aborted",
      abortedBy: signal,
      requiredChecks,
      checks,
      skippedChecks: collectSkippedChecks(),
      cleanup: collectCleanupResult(),
      error: null,
    };
    // A signal that lands after the run has already committed its own record finds the write
    // taken. Waiting for it and leaving it alone is the honest outcome — that record describes a
    // run that reached the end — and waiting is also what keeps the exit below from truncating a
    // write still in flight.
    const recorded = await writeEvidenceOnce(aborted);
    process.stderr.write(
      recorded
        ? `Recorded aborted run to ${outputPath}\n`
        : `The completed run reached ${outputPath} first; left its record in place.\n`,
    );
  } catch (error) {
    process.stderr.write(`Could not record the aborted run: ${error}\n`);
  }
}

// A run killed between the DinD launch and the finally block used to end here: Node exits, the
// privileged container keeps running, and nothing is written — so the leak is invisible rather
// than recorded. The next successful run overwrites the evidence path, and the file on disk is
// then honest, passing, and silent about a root-equivalent daemon still on the host.
//
// Recording an interrupted run matters as much as cleaning up after it. An `aborted` evidence
// file says what was left behind; no file at all says nothing happened.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interrupted) return;
    // Both assignments, with nothing awaited between them: the epilogue waits on `abortRecord`
    // whenever it sees `interrupted`, so a window where one is set without the other would put
    // it back to racing this handler for the artifact.
    interrupted = signal;
    abortRecord = (async () => {
      process.stderr.write(`\n${signal} received; tearing down before exit.\n`);
      await runTeardown();
      await writeAbortedEvidence(signal);
      process.exit(130);
    })().catch((error) => {
      // Nothing above can reject today — every await in teardown is individually caught, and
      // writeAbortedEvidence catches its own. But the epilogue now parks on this promise, so a
      // future unguarded await here would hang the run instead of ending it, and the exit that
      // this task exists to reach would silently stop happening. Teardown has settled by the time
      // a rejection can arrive, so exiting here still cannot cut a teardown short.
      process.stderr.write(`Interrupt handling failed: ${error}\n`);
      process.exit(130);
    });
  });
}

try {
  {
    const started = process.hrtime.bigint();
    const health = await client.request("health", {});
    record(
      checks,
      "core-handshake",
      "core handshake",
      health.status === "ok" && health.protocolVersion === "1",
      health,
      started,
    );
  }

  const capabilitiesStarted = process.hrtime.bigint();
  const capabilities = await client.request(
    "system.capabilities",
    { context },
    60_000,
  );
  const leaves = flattenLeaves(capabilities.commandInventory.root);
  const leafPaths = sortedUnique(
    leaves.map((leaf) => leaf.path.join(" ")),
  );
  record(
    checks,
    "installed-command-inventory",
    "complete installed command inventory",
    capabilities.commandInventory.complete &&
      !capabilities.commandInventory.limitReached &&
      capabilities.commandInventory.warnings.length === 0 &&
      leaves.length > 0 &&
      leafPaths.length === leaves.length,
    {
      nodeCount: capabilities.commandInventory.nodeCount,
      leafCount: leaves.length,
      leafIdentity: identityEvidence(leafPaths),
      warnings: capabilities.commandInventory.warnings,
      binarySha256: capabilities.binary.sha256,
    },
    capabilitiesStarted,
  );

  const snapshotStarted = process.hrtime.bigint();
  const [
    snapshot,
    containerList,
    defaultImageList,
    uiImageList,
    allImageList,
    volumeList,
  ] =
    await Promise.all([
      client.request("system.snapshot", { context }, 60_000),
      client.request("containers.list", { context, all: true }),
      client.request(
        "images.list",
        { context, all: false, includeDangling: false },
        60_000,
      ),
      client.request(
        "images.list",
        { context, all: false, includeDangling: true },
        60_000,
      ),
      client.request("images.list", { context, all: true }, 60_000),
      client.request("volumes.list", { context }, 60_000),
    ]);
  const [
    dockerContainers,
    dockerImages,
    danglingDockerImages,
    allDockerImages,
    dockerVolumes,
  ] =
    await Promise.all([
      dockerLinesAt(context, [
        "container",
        "ls",
        "--all",
        "--quiet",
        "--no-trunc",
      ]),
      dockerLinesAt(context, ["image", "ls", "--quiet", "--no-trunc"]),
      dockerLinesAt(context, [
        "image",
        "ls",
        "--filter",
        "dangling=true",
        "--quiet",
        "--no-trunc",
      ]),
      dockerLinesAt(context, [
        "image",
        "ls",
        "--all",
        "--quiet",
        "--no-trunc",
      ]),
      dockerLinesAt(context, ["volume", "ls", "--quiet"]),
    ]);
  const coreContainerIds = sortedUnique(
    containerList.containers.map((item) => item.id),
  );
  const cliContainerIds = sortedUnique(dockerContainers);
  const coreDefaultImageIds = sortedUnique(
    defaultImageList.images.map((item) => item.id.replace(/^sha256:/u, "")),
  );
  const cliDefaultImageIds = sortedUnique(
    dockerImages.map((value) => value.replace(/^sha256:/u, "")),
  );
  const coreUiImageIds = sortedUnique(
    uiImageList.images.map((item) => item.id.replace(/^sha256:/u, "")),
  );
  const cliUiImageIds = sortedUnique(
    [...dockerImages, ...danglingDockerImages].map((value) =>
      value.replace(/^sha256:/u, ""),
    ),
  );
  const coreAllImageIds = sortedUnique(
    allImageList.images.map((item) => item.id.replace(/^sha256:/u, "")),
  );
  const cliAllImageIds = sortedUnique(
    allDockerImages.map((value) => value.replace(/^sha256:/u, "")),
  );
  const coreVolumeNames = sortedUnique(
    volumeList.volumes.map((item) => item.name),
  );
  const cliVolumeNames = sortedUnique(dockerVolumes);
  record(
    checks,
    "snapshot-list-conformance",
    "native snapshot and list conformance",
    snapshot.source === "engine-api" &&
      sameValues(coreContainerIds, cliContainerIds) &&
      sameValues(coreDefaultImageIds, cliDefaultImageIds) &&
      sameValues(coreUiImageIds, cliUiImageIds) &&
      sameValues(coreAllImageIds, cliAllImageIds) &&
      sameValues(coreVolumeNames, cliVolumeNames) &&
      containerList.containers.every((item) => /^[a-f0-9]{64}$/u.test(item.id)) &&
      defaultImageList.images.every((item) =>
        /^sha256:[a-f0-9]{64}$/u.test(item.id),
      ) &&
      uiImageList.images.every((item) =>
        /^sha256:[a-f0-9]{64}$/u.test(item.id),
      ) &&
      allImageList.images.every((item) => /^sha256:[a-f0-9]{64}$/u.test(item.id)),
    {
      source: snapshot.source,
      apiVersion: snapshot.apiVersion,
      containers: {
        core: identityEvidence(coreContainerIds),
        cli: identityEvidence(cliContainerIds),
      },
      images: {
        default: {
          core: identityEvidence(coreDefaultImageIds),
          cli: identityEvidence(cliDefaultImageIds),
        },
        uiDefaultIncludingDangling: {
          core: identityEvidence(coreUiImageIds),
          cliUnion: identityEvidence(cliUiImageIds),
        },
        all: {
          core: identityEvidence(coreAllImageIds),
          cli: identityEvidence(cliAllImageIds),
        },
      },
      volumes: {
        core: identityEvidence(coreVolumeNames),
        cli: identityEvidence(cliVolumeNames),
      },
    },
    snapshotStarted,
  );

  const running = containerList.containers.find((container) => container.state === "running");
  if (!running) {
    record(
      checks,
      "container-inspect-stats",
      "native container inspect and stats",
      false,
      {
        reason:
          "No running container was available for read-only inspect/stats conformance.",
      },
      process.hrtime.bigint(),
    );
  } else {
    const detailStarted = process.hrtime.bigint();
    const [inspect, stats] = await Promise.all([
      client.request("containers.inspect", { context, id: running.id }),
      client.request("containers.stats", { context, id: running.id }),
    ]);
    record(
      checks,
      "container-inspect-stats",
      "native container inspect and stats",
      inspect.container.id === running.id &&
        stats.containerId === running.id &&
        stats.memoryWorkingSetBytes >= 0,
      {
        id: running.id,
        inspectSource: inspect.source,
        statsSource: stats.source,
        cpuPercent: stats.cpuPercent,
        memoryWorkingSetBytes: stats.memoryWorkingSetBytes,
      },
      detailStarted,
    );
  }

  {
    const cliStarted = process.hrtime.bigint();
    const direct = await runProcess("docker", [
      "--context",
      context,
      "version",
      "--format",
      "{{.Client.Version}}",
    ]);
    const viaCore = await client.request("cli.run", {
      context,
      targetMode: "pinned",
      argv: ["version", "--format", "{{.Client.Version}}"],
      timeoutSeconds: 30,
    });
    record(
      checks,
      "pinned-cli-run",
      "captured literal argv CLI conformance",
      !direct.timedOut &&
        direct.code === viaCore.exitCode &&
        viaCore.targetMode === "pinned" &&
        sameValues(viaCore.argv, [
          "--context",
          context,
          "version",
          "--format",
          "{{.Client.Version}}",
        ]) &&
        direct.stdout === outputText(viaCore.stdout) &&
        direct.stderr === outputText(viaCore.stderr),
      {
        directExitCode: direct.code,
        coreExitCode: viaCore.exitCode,
        argv: viaCore.argv,
        stdout: outputText(viaCore.stdout).trim(),
      },
      cliStarted,
    );
  }

  {
    const sessionStarted = process.hrtime.bigint();
    const session = await client.request("session.start", {
      context,
      targetMode: "pinned",
      argv: ["version", "--format", "ANCHORAGE_PIPES_OK {{.Client.Version}}"],
      mode: "pipes",
      outputWindowBytes: 65_536,
      maxOutputBytes: 1_048_576,
    });
    const collected = await collectSession(
      client,
      session,
      "ANCHORAGE_PIPES_OK",
    );
    record(
      checks,
      "pinned-pipes-session",
      "streamed pipes session",
      collected.exited.exitCode === 0 &&
        session.targetMode === "pinned" &&
        sameValues(session.argv, [
          "--context",
          context,
          "version",
          "--format",
          "ANCHORAGE_PIPES_OK {{.Client.Version}}",
        ]) &&
        !collected.exited.timedOut &&
        !collected.exited.output.truncated,
      {
        sessionId: session.sessionId,
        exitCode: collected.exited.exitCode,
        outputBytes: collected.exited.output.stdoutBytes,
      },
      sessionStarted,
    );
  }

  {
    const literalStarted = process.hrtime.bigint();
    const literalArgv = [
      "--context",
      context,
      "version",
      "--format",
      "ANCHORAGE_LITERAL_CLI {{.Client.Version}}",
    ];
    const direct = await runProcess("docker", literalArgv);
    const viaCore = await client.request("cli.run", {
      context,
      targetMode: "literal",
      argv: literalArgv,
      timeoutSeconds: 30,
    });
    record(
      checks,
      "literal-cli-run",
      "literal-target CLI conformance",
      !direct.timedOut &&
        direct.code === viaCore.exitCode &&
        viaCore.targetMode === "literal" &&
        sameValues(viaCore.argv, literalArgv) &&
        direct.stdout === outputText(viaCore.stdout) &&
        direct.stderr === outputText(viaCore.stderr),
      {
        directExitCode: direct.code,
        coreExitCode: viaCore.exitCode,
        targetMode: viaCore.targetMode,
        argv: viaCore.argv,
        stdout: outputText(viaCore.stdout).trim(),
      },
      literalStarted,
    );
  }

  {
    const literalSessionStarted = process.hrtime.bigint();
    const literalArgv = [
      "--context",
      context,
      "version",
      "--format",
      "ANCHORAGE_LITERAL_PIPES {{.Client.Version}}",
    ];
    const direct = await runProcess("docker", literalArgv);
    const session = await client.request("session.start", {
      context,
      targetMode: "literal",
      argv: literalArgv,
      mode: "pipes",
      outputWindowBytes: 65_536,
      maxOutputBytes: 1_048_576,
    });
    const collected = await collectSession(
      client,
      session,
      "ANCHORAGE_LITERAL_PIPES",
    );
    record(
      checks,
      "literal-pipes-session",
      "literal-target pipes session",
      !direct.timedOut &&
        direct.code === collected.exited.exitCode &&
        session.targetMode === "literal" &&
        sameValues(session.argv, literalArgv) &&
        direct.stdout === collected.text &&
        !collected.exited.timedOut &&
        !collected.exited.output.truncated,
      {
        sessionId: session.sessionId,
        exitCode: collected.exited.exitCode,
        targetMode: session.targetMode,
        argv: session.argv,
        outputBytes: collected.exited.output.stdoutBytes,
      },
      literalSessionStarted,
    );
  }

  // A session deliberately outlives the request that created it. When request contexts became
  // individually cancellable, session.start passed its request context into the session's
  // lifetime watcher, so every session was torn down the instant session.start returned. Every
  // other check in this matrix runs a session that finishes in well under a second, so all of
  // them still passed; only a thirty-minute soak noticed. This check is the cheap version of
  // that soak: hold one session open across several later requests and prove it is still both
  // producing output and accepting input before cancelling it.
  {
    const longSessionStarted = process.hrtime.bigint();
    const longSessionName = "long-lived session outlives its originating request";
    if (!running) {
      record(
        checks,
        "long-lived-session",
        longSessionName,
        false,
        {
          reason:
            "No running container was available to stream a long-lived read-only session from.",
        },
        longSessionStarted,
      );
    } else {
      const longSession = await client.request("session.start", {
        context,
        targetMode: "pinned",
        argv: [
          "stats",
          "--format",
          "ANCHORAGE_LIVE {{.Name}} {{.CPUPerc}}",
          running.id,
        ],
        mode: "pipes",
        outputWindowBytes: 65_536,
        maxOutputBytes: 8 * 1_048_576,
      });
      const startReturnedAt = Date.now();
      const attached = attachSessionOutput(client, longSession.sessionId);
      let evidence = null;
      let passed = false;
      try {
        await new Promise((wait) => setTimeout(wait, LONG_SESSION_PROBE_MS));
        const sequenceAtProbe = attached.state.lastSequence;
        const exitedAtProbe = attached.state.exited;
        // Unrelated requests are issued and completed while the session is supposed to keep
        // running. Under the defect each of these returning was fatal to the session, so the
        // interleaving is the part that reproduces it rather than incidental noise.
        const interleaved = [];
        for (let index = 0; index < 4; index += 1) {
          const health = await client.request("health", {});
          interleaved.push(health.status);
          await new Promise((wait) =>
            setTimeout(wait, LONG_SESSION_HOLD_MS / 4),
          );
        }
        const heldMs = Date.now() - startReturnedAt;
        const sequenceAfterHold = attached.state.lastSequence;
        const exitedDuringHold = attached.state.exited;
        let inputAccepted = null;
        let inputError = null;
        try {
          // session.input is refused with session_closed once the core considers the process
          // gone, so accepting a byte here is positive proof the session is still live rather
          // than merely still tombstoned in the session map.
          inputAccepted = await client.request("session.input", {
            sessionId: longSession.sessionId,
            data: "\n",
            encoding: "utf-8",
          });
        } catch (error) {
          inputError = error instanceof Error ? error.message : String(error);
        }
        const canceled = await client.request("session.cancel", {
          sessionId: longSession.sessionId,
          gracePeriodMs: 2_000,
        });
        const cancelRequestedAt = Date.now();
        const exitEvent = await client.waitForEvent(
          (event) =>
            event.event === "session.exited" &&
            event.payload.sessionId === longSession.sessionId,
          LONG_SESSION_EXIT_MS,
        );
        const exitLatencyMs = Date.now() - cancelRequestedAt;
        const exited = exitEvent.payload;
        const survivedHold = !exitedAtProbe && !exitedDuringHold;
        const producedBeforeHold = sequenceAtProbe > 0;
        const producedAfterHold = sequenceAfterHold > sequenceAtProbe;
        const acceptedInput = inputAccepted?.acceptedBytes === 1;
        const cancelAccepted =
          canceled.accepted === true && canceled.state === "canceling";
        const exitedOnCancel =
          exited.canceled === true && exited.timedOut === false;
        passed =
          survivedHold &&
          heldMs >= LONG_SESSION_HOLD_MS &&
          producedBeforeHold &&
          producedAfterHold &&
          acceptedInput &&
          cancelAccepted &&
          exitedOnCancel &&
          attached.state.ackErrors.length === 0;
        evidence = {
          sessionId: longSession.sessionId,
          pid: longSession.pid,
          argv: longSession.argv,
          heldMs,
          interleavedRequestsWhileHeld: interleaved.length,
          survivedHold,
          exitedDuringHold: exitedDuringHold
            ? {
                exitCode: exitedDuringHold.exitCode,
                canceled: exitedDuringHold.canceled,
                durationMs: exitedDuringHold.durationMs,
              }
            : null,
          outputSequenceAtProbe: sequenceAtProbe,
          outputSequenceAfterHold: sequenceAfterHold,
          producedOutputAfterHold: producedAfterHold,
          outputChunks: attached.state.chunkCount,
          acknowledgementErrors: attached.state.ackErrors,
          inputAcceptedBytes: inputAccepted?.acceptedBytes ?? null,
          inputError,
          cancelAccepted: canceled.accepted,
          cancelState: canceled.state,
          exitLatencyMs,
          exitCode: exited.exitCode,
          exitCanceled: exited.canceled,
          exitTimedOut: exited.timedOut,
          exitDurationMs: exited.durationMs,
        };
      } finally {
        attached.detach();
      }
      record(
        checks,
        "long-lived-session",
        longSessionName,
        passed,
        evidence,
        longSessionStarted,
      );
    }
  }

  {
    const composeStarted = process.hrtime.bigint();
    const composeName = "Compose project and service conformance";
    let composeList = null;
    let composeUnavailable = null;
    try {
      composeList = await client.request(
        "compose.list",
        { context, all: true },
        60_000,
      );
    } catch (error) {
      if (!isMissingPlugin(error, "compose_unavailable")) throw error;
      composeUnavailable = error.message;
    }
    if (composeUnavailable) {
      recordSkipped(
        checks,
        "compose-project-conformance",
        composeName,
        "The Docker Compose CLI plugin is not installed for this Docker CLI, so compose.list and compose.ps have no surface to exercise.",
        { context, error: composeUnavailable },
        composeStarted,
      );
    } else {
      // The daemon is live and user-owned, so a project or container can legitimately appear
      // between two reads. The core reading is compared against a CLI reading on either side
      // of it, which tolerates that churn without weakening the equality itself.
      const cliProjectsBefore = await composeCliProjects(context);
      const coreProjects = composeProjectNames(composeList.projects);
      const cliProjectsAfter = await composeCliProjects(context);
      const projectsMatch =
        sameValues(coreProjects, cliProjectsBefore) ||
        sameValues(coreProjects, cliProjectsAfter);
      const statesConsistent = composeList.projects.every((project) => {
        const counted = project.states.filter((term) => term.count >= 0);
        const total = counted.reduce((sum, term) => sum + term.count, 0);
        const runningTotal = counted
          .filter((term) => term.state === "running")
          .reduce((sum, term) => sum + term.count, 0);
        return (
          total === project.totalCount &&
          runningTotal === project.runningCount &&
          project.states.every((term) => project.status.includes(term.state))
        );
      });
      const target = composeList.projects.find(
        (project) => project.totalCount > 0,
      );
      if (!target) {
        recordSkipped(
          checks,
          "compose-project-conformance",
          composeName,
          "Docker Compose is installed, but this daemon hosts no Compose project with containers to compare service listings against.",
          {
            context,
            source: composeList.source,
            coreProjects: identityEvidence(coreProjects),
            cliProjects: identityEvidence(cliProjectsAfter),
            projectsMatch,
          },
          composeStarted,
        );
      } else {
        const cliIdsBefore = await composeCliContainerIds(context, target.name);
        const servicesResult = await client.request(
          "compose.ps",
          { context, project: target.name },
          60_000,
        );
        const cliIdsAfter = await composeCliContainerIds(context, target.name);
        const shortIds = sortedUnique(
          servicesResult.services.map((service) => service.containerId),
        );
        const matchesSnapshot = (fullIds) => {
          const resolved = resolveShortIds(shortIds, fullIds);
          return (
            resolved.every(Boolean) &&
            sameValues(sortedUnique(resolved), fullIds)
          );
        };
        const servicesMatch =
          matchesSnapshot(cliIdsBefore) || matchesSnapshot(cliIdsAfter);
        record(
          checks,
          "compose-project-conformance",
          composeName,
          composeList.source === "cli-json" &&
            servicesResult.source === "cli-json" &&
            servicesResult.project === target.name &&
            projectsMatch &&
            statesConsistent &&
            servicesMatch &&
            servicesResult.services.every(
              (service) => service.service !== "" && service.state !== "",
            ),
          {
            context,
            listSource: composeList.source,
            psSource: servicesResult.source,
            coreProjects: identityEvidence(coreProjects),
            cliProjects: identityEvidence(cliProjectsAfter),
            projectsMatch,
            statusParsingConsistent: statesConsistent,
            comparedProject: target.name,
            comparedProjectStatus: target.status,
            coreServiceIds: identityEvidence(shortIds),
            cliContainerIds: identityEvidence(cliIdsAfter),
            servicesMatch,
          },
          composeStarted,
        );
      }
    }
  }

  {
    const scoutStarted = process.hrtime.bigint();
    const scoutName = "Scout SARIF projection conformance";
    // The smallest tagged image is chosen because Scout's first analysis of an image builds an
    // SBOM in proportion to its size. The choice is deterministic for a given daemon, and the
    // reference is the immutable ID so a tag moving mid-run cannot change what was scanned.
    const scoutCandidate = defaultImageList.images
      .filter((image) => image.repoTags.length > 0 && image.sizeBytes > 0)
      .sort((left, right) => left.sizeBytes - right.sizeBytes)
      .at(0);
    if (!scoutCandidate) {
      recordSkipped(
        checks,
        "image-scout-report",
        scoutName,
        "This daemon exposes no tagged local image with a known size for Scout to analyze.",
        { context },
        scoutStarted,
      );
    } else if (scoutCandidate.sizeBytes > SCOUT_MAX_IMAGE_BYTES) {
      recordSkipped(
        checks,
        "image-scout-report",
        scoutName,
        "The smallest tagged local image is larger than the bounded first-scan budget, so a Scout index would dominate the read-only gate.",
        {
          context,
          smallestImageId: scoutCandidate.id,
          smallestImageBytes: scoutCandidate.sizeBytes,
          budgetBytes: SCOUT_MAX_IMAGE_BYTES,
        },
        scoutStarted,
      );
    } else {
      let scout = null;
      let scoutUnavailable = null;
      try {
        scout = await client.request(
          "images.scout",
          { context, reference: scoutCandidate.id },
          SCOUT_TIMEOUT_MS,
        );
      } catch (error) {
        if (!isMissingPlugin(error, "scout_unavailable")) throw error;
        scoutUnavailable = error.message;
      }
      if (scoutUnavailable) {
        recordSkipped(
          checks,
          "image-scout-report",
          scoutName,
          "The Docker Scout CLI plugin is not installed for this Docker CLI, so images.scout has no surface to exercise.",
          { context, error: scoutUnavailable },
          scoutStarted,
        );
      } else {
        const direct = await dockerRun(
          context,
          ["scout", "cves", "--format", "sarif", scoutCandidate.id],
          { timeoutMs: SCOUT_TIMEOUT_MS },
        );
        const directReport =
          direct.code === 0 && !direct.timedOut
            ? summarizeSarif(direct.stdout)
            : null;
        const summaryKeys = Object.keys(scout.summary).sort();
        const summaryTotal = Object.values(scout.summary).reduce(
          (sum, value) => sum + value,
          0,
        );
        const summaryMatches =
          directReport !== null &&
          SCOUT_SEVERITIES.every(
            (severity) =>
              scout.summary[severity] === directReport.summary[severity],
          );
        const rank = new Map(
          SCOUT_SEVERITIES.map((severity, index) => [severity, index]),
        );
        const ordered = scout.findings.every(
          (finding, index) =>
            index === 0 ||
            rank.get(scout.findings[index - 1].severity) <=
              rank.get(finding.severity),
        );
        record(
          checks,
          "image-scout-report",
          scoutName,
          scout.source === "cli-sarif" &&
            scout.reference === scoutCandidate.id &&
            sameValues(summaryKeys, [...SCOUT_SEVERITIES].sort()) &&
            scout.total === summaryTotal &&
            directReport?.total === scout.total &&
            summaryMatches &&
            scout.findings.length === Math.min(scout.total, 500) &&
            ordered &&
            scout.findings.every(
              (finding) =>
                finding.id !== "" && rank.has(finding.severity),
            ),
          {
            context,
            reference: scoutCandidate.id,
            referenceTags: scoutCandidate.repoTags,
            imageBytes: scoutCandidate.sizeBytes,
            source: scout.source,
            scanner: scout.scanner,
            summary: scout.summary,
            total: scout.total,
            directSarifSummary: directReport?.summary ?? null,
            directSarifTotal: directReport?.total ?? null,
            directExitCode: direct.code,
            severityCountsMatch: summaryMatches,
            findingCount: scout.findings.length,
            findingsOrdered: ordered,
            // A clean image is a legitimate result, but it makes the severity comparison
            // vacuous. Recording it keeps a zero-finding run from reading as proof that
            // severity projection works.
            comparedNonEmptyReport: scout.total > 0,
            limitations: scout.limitations,
          },
          scoutStarted,
        );
      }
    }
  }

  if (runMutations) {
    const token = randomUUID();
    const suffix = token.slice(0, 8);
    const dindName = `anchorage-dind-${suffix}`;
    const dindContext = `anchorage-dind-${suffix}`;
    const dindSocketContext = `anchorage-dind-sock-${suffix}`;
    // Archives must land inside the core's cwd allowlist, which is this workspace, so the
    // scratch directory lives under the evidence tree and is removed with verification.
    const scratchDirectory = resolve(
      workspaceRoot,
      `artifacts/docker/acceptance-scratch-${suffix}`,
    );
    const dindSocketDirectory = resolve(scratchDirectory, "engine");
    const dindSocketPath = resolve(dindSocketDirectory, "docker.sock");
    dindResource = {
      containerName: dindName,
      contextName: dindContext,
      socketContextName: dindSocketContext,
      socketEndpoint: `unix://${dindSocketPath}`,
      scratchDirectory,
      endpoint: null,
      token,
    };

    const isolationStarted = process.hrtime.bigint();
    const [existingContainer, existingContext, existingSocketContext] =
      await Promise.all([
        verifyDisposableOwnership(context, dindName, token),
        inspectDockerContext(dindContext),
        inspectDockerContext(dindSocketContext),
      ]);
    if (
      existingContainer.exists ||
      existingContext.exists ||
      existingSocketContext.exists
    ) {
      throw new Error(
        `Random DinD isolation name collision: ${dindName}/${dindContext}`,
      );
    }
    // The scratch directory owns two things the daemon cannot: the host archives that save,
    // load and export read and write, and the Unix socket the disposable daemon is additionally
    // published on. Mode 0700 keeps the socket of a privileged daemon unreachable by other
    // local users for the few seconds it exists.
    await mkdir(dindSocketDirectory, { recursive: true, mode: 0o700 });
    const launched = await dockerRun(
      context,
      [
        "run",
        "--detach",
        "--privileged",
        "--name",
        dindName,
        "--label",
        `io.anchorage.acceptance=${token}`,
        "--env",
        "DOCKER_TLS_CERTDIR=",
        "--publish",
        "127.0.0.1::2375",
        "--volume",
        `${dindSocketDirectory}:/anchorage-socket`,
        "docker:29-dind",
        "--storage-driver=vfs",
        // The published TCP endpoint stays the primary context so the CLI-routed transport
        // remains under test, but the Engine-API methods (containers/volumes archive reads)
        // require a directly reachable Unix socket and are unreachable over TCP. Naming any
        // --host suppresses the entrypoint's defaults, so all three are listed explicitly.
        "--host=unix:///var/run/docker.sock",
        "--host=tcp://0.0.0.0:2375",
        "--host=unix:///anchorage-socket/docker.sock",
        // Without this the bind-mounted socket is owned by the container's docker group, whose
        // GID is unrelated to this host's, and the core could not open it.
        `--group=${process.getgid()}`,
      ],
      { timeoutMs: 180_000 },
    );
    if (
      launched.code !== 0 ||
      launched.timedOut ||
      !/^[a-f0-9]{64}$/u.test(launched.stdout.trim())
    ) {
      throw new Error(
        `Could not launch owned Docker 29 DinD container: ${launched.stderr}`,
      );
    }
    const ownership = await verifyDisposableOwnership(context, dindName, token);
    if (!ownership.exists || !ownership.owned) {
      throw new Error("Docker 29 DinD ownership label verification failed");
    }
    const published = await dockerOutputAt(context, [
      "container",
      "port",
      dindName,
      "2375/tcp",
    ]);
    const portMatch = published.match(/127\.0\.0\.1:(\d+)/u);
    if (!portMatch) {
      throw new Error(`Could not resolve DinD localhost port: ${published}`);
    }
    const endpoint = `tcp://127.0.0.1:${portMatch[1]}`;
    dindResource.endpoint = endpoint;
    const createdContext = await runProcess("docker", [
      "context",
      "create",
      "--description",
      `Anchorage acceptance ${token}`,
      "--docker",
      `host=${endpoint}`,
      dindContext,
    ]);
    if (createdContext.code !== 0 || createdContext.timedOut) {
      throw new Error(
        `Could not create isolated Docker context: ${createdContext.stderr}`,
      );
    }
    const contextOwnership = await inspectDockerContext(dindContext);
    if (
      !contextOwnership.exists ||
      contextOwnership.endpoint !== endpoint
    ) {
      throw new Error("DinD Docker context endpoint verification failed");
    }
    const serverVersion = await waitForDockerDaemon(dindContext);
    const socketEndpoint = `unix://${dindSocketPath}`;
    const createdSocketContext = await runProcess("docker", [
      "context",
      "create",
      "--description",
      `Anchorage acceptance engine ${token}`,
      "--docker",
      `host=${socketEndpoint}`,
      dindSocketContext,
    ]);
    if (createdSocketContext.code !== 0 || createdSocketContext.timedOut) {
      throw new Error(
        `Could not create isolated Docker socket context: ${createdSocketContext.stderr}`,
      );
    }
    const socketContextOwnership =
      await inspectDockerContext(dindSocketContext);
    if (
      !socketContextOwnership.exists ||
      socketContextOwnership.endpoint !== socketEndpoint
    ) {
      throw new Error("DinD socket context endpoint verification failed");
    }
    const socketServerVersion = await waitForDockerDaemon(dindSocketContext);
    const dindCapabilities = await client.request(
      "system.capabilities",
      { context: dindContext },
      60_000,
    );
    record(
      checks,
      "dind-isolation",
      "owned isolated Docker 29 DinD",
      ownership.owned &&
        contextOwnership.endpoint === endpoint &&
        socketContextOwnership.endpoint === socketEndpoint &&
        /^29(?:\.|$)/u.test(serverVersion) &&
        socketServerVersion === serverVersion &&
        dindCapabilities.selectedContext === dindContext &&
        dindCapabilities.versions.server.version === serverVersion,
      {
        hostContext: context,
        containerName: dindName,
        containerId: launched.stdout.trim(),
        ownershipLabelVerified: ownership.owned,
        dockerContext: dindContext,
        endpoint,
        socketContext: dindSocketContext,
        socketEndpoint,
        socketServerVersion,
        scratchDirectory,
        serverVersion,
        capabilitiesSelectedContext: dindCapabilities.selectedContext,
        capabilitiesServerVersion:
          dindCapabilities.versions.server.version ?? null,
      },
      isolationStarted,
    );

    const sourceRef = "alpine:3.20";
    const pullStarted = process.hrtime.bigint();
    const pull = await client.request(
      "images.action",
      {
        context: dindContext,
        action: "pull",
        reference: sourceRef,
        timeoutSeconds: 180,
        outputWindowBytes: 65_536,
        maxOutputBytes: 8 * 1_048_576,
      },
      60_000,
    );
    if (!pull.session) {
      throw new Error("Image pull did not return a session");
    }
    const pulled = await collectSession(
      client,
      pull.session,
      "",
      180_000,
    );
    const pulledImages = await client.request(
      "images.list",
      { context: dindContext, all: true },
      60_000,
    );
    const pulledImage = pulledImages.images.find((image) =>
      image.repoTags.includes(sourceRef),
    );
    record(
      checks,
      "image-pull-session",
      "session-backed image pull",
      pull.receipt.source === "cli-session" &&
        pull.session.targetMode === "pinned" &&
        pulled.exited.exitCode === 0 &&
        !pulled.exited.timedOut &&
        !pulled.exited.output.truncated &&
        Boolean(pulledImage),
      {
        reference: sourceRef,
        sessionId: pull.session.sessionId,
        exitCode: pulled.exited.exitCode,
        receiptSource: pull.receipt.source,
        imageId: pulledImage?.id ?? null,
      },
      pullStarted,
    );
    if (!pulledImage) {
      throw new Error(`Pulled image ${sourceRef} was not listed`);
    }

    const containerName = `anchorage-action-${suffix}`;
    const containerStarted = process.hrtime.bigint();
    const created = await client.request("cli.run", {
      context: dindContext,
      targetMode: "pinned",
      argv: [
        "container",
        "create",
        "--name",
        containerName,
        "--label",
        `io.anchorage.acceptance=${token}`,
        sourceRef,
        "sleep",
        "60",
      ],
      timeoutSeconds: 30,
    });
    assertCoreRunSucceeded(created, "Disposable container create");
    const containerId = outputText(created.stdout).trim();
    if (!/^[a-f0-9]{64}$/u.test(containerId)) {
      throw new Error(
        `Disposable container create returned invalid id: ${containerId}`,
      );
    }
    const startedReceipt = await client.request("containers.action", {
      context: dindContext,
      id: containerId,
      action: "start",
    });
    const runningInspect = await client.request("containers.inspect", {
      context: dindContext,
      id: containerId,
    });
    await client.request("containers.action", {
      context: dindContext,
      id: containerId,
      action: "stop",
      options: { timeoutSeconds: 10 },
    });
    const removedReceipt = await client.request("containers.action", {
      context: dindContext,
      id: containerId,
      action: "remove",
      options: { confirmed: true },
    });
    const containerAbsent = await verifyDisposableOwnership(
      dindContext,
      containerName,
      token,
    );
    record(
      checks,
      "container-lifecycle",
      "isolated structured container lifecycle",
      startedReceipt.outcome === "succeeded" &&
        runningInspect.container.state.running &&
        removedReceipt.outcome === "succeeded" &&
        !containerAbsent.exists,
      {
        id: containerId,
        context: dindContext,
        startSource: startedReceipt.source,
        removeSource: removedReceipt.source,
        verifiedAbsent: !containerAbsent.exists,
      },
      containerStarted,
    );

    const ptyName = `anchorage-pty-${suffix}`;
    const ptyStarted = process.hrtime.bigint();
    const pty = await client.request("session.start", {
      context: dindContext,
      targetMode: "pinned",
      argv: [
        "run",
        "--rm",
        "-it",
        "--name",
        ptyName,
        "--label",
        `io.anchorage.acceptance=${token}`,
        sourceRef,
        "sh",
      ],
      mode: "pty",
      rows: 24,
      cols: 100,
      outputWindowBytes: 65_536,
      maxOutputBytes: 1_048_576,
      timeoutSeconds: 30,
    });
    const ptyOutput = [];
    const ptySequences = new Set();
    const acceptPtyOutput = async (payload) => {
      if (ptySequences.has(payload.sequence)) return;
      ptySequences.add(payload.sequence);
      ptyOutput.push(outputText(payload));
      await client.request("session.ack", {
        sessionId: pty.sessionId,
        throughSequence: payload.sequence,
      });
    };
    const ptyListener = async (event) => {
      if (
        event.event !== "session.output" ||
        event.payload.sessionId !== pty.sessionId
      ) {
        return;
      }
      await acceptPtyOutput(event.payload);
    };
    client.listeners.add(ptyListener);
    for (const event of client.eventHistory) {
      if (
        event.event === "session.output" &&
        event.payload.sessionId === pty.sessionId
      ) {
        await acceptPtyOutput(event.payload);
      }
    }
    const ptyExit = client.waitForEvent(
      (event) =>
        event.event === "session.exited" &&
        event.payload.sessionId === pty.sessionId,
      60_000,
    );
    await client.request("session.resize", {
      sessionId: pty.sessionId,
      rows: 30,
      cols: 120,
    });
    await client.request("session.input", {
      sessionId: pty.sessionId,
      data: "printf 'ANCHORAGE_PTY_RESULT_%s\\n' \"$(id -u)\"; exit\r",
      encoding: "utf-8",
    });
    const ptyExited = await ptyExit;
    client.listeners.delete(ptyListener);
    const ptyAbsent = await verifyDisposableOwnership(
      dindContext,
      ptyName,
      token,
    );
    const ptyText = ptyOutput.join("");
    record(
      checks,
      "pty-session",
      "isolated interactive PTY lifecycle",
      pty.targetMode === "pinned" &&
        ptyExited.payload.exitCode === 0 &&
        ptyText.includes("ANCHORAGE_PTY_RESULT_0") &&
        !ptyAbsent.exists,
      {
        sessionId: pty.sessionId,
        context: dindContext,
        exitCode: ptyExited.payload.exitCode,
        outputMatched: ptyText.includes("ANCHORAGE_PTY_RESULT_0"),
        verifiedAbsent: !ptyAbsent.exists,
      },
      ptyStarted,
    );

    const tagStarted = process.hrtime.bigint();
    const structuredTag = `anchorage-acceptance/tagged:${suffix}`;
    const tagReceipt = await client.request("images.action", {
      context: dindContext,
      action: "tag",
      id: pulledImage.id,
      reference: structuredTag,
    });
    const afterTag = await client.request(
      "images.list",
      { context: dindContext, all: true },
      60_000,
    );
    const taggedImage = imageWithId(afterTag, pulledImage.id);
    record(
      checks,
      "image-tag-action",
      "structured image tag by immutable ID",
      tagReceipt.action === "tag" &&
        tagReceipt.receipt.outcome === "succeeded" &&
        tagReceipt.receipt.resourceId === pulledImage.id &&
        Boolean(taggedImage) &&
        taggedImage.repoTags.includes(structuredTag) &&
        // Tagging adds a name, it does not move one: the source tag must survive.
        taggedImage.repoTags.includes(sourceRef) &&
        // No other image may acquire the new name.
        afterTag.images.filter((image) =>
          image.repoTags.includes(structuredTag),
        ).length === 1,
      {
        imageId: pulledImage.id,
        addedReference: structuredTag,
        sourceReference: sourceRef,
        receiptSource: tagReceipt.receipt.source,
        receiptOutcome: tagReceipt.receipt.outcome,
        postReferences: taggedImage?.repoTags ?? [],
      },
      tagStarted,
    );

    const archiveStarted = process.hrtime.bigint();
    const imageArchivePath = resolve(
      scratchDirectory,
      `image-${suffix}.tar`,
    );
    const save = await client.request("images.action", {
      context: dindContext,
      action: "save",
      reference: structuredTag,
      archivePath: imageArchivePath,
      timeoutSeconds: 300,
      outputWindowBytes: 65_536,
      maxOutputBytes: 8 * 1_048_576,
    });
    if (!save.session) {
      throw new Error("Image save did not return a session");
    }
    const saved = await collectSession(client, save.session, "", 300_000);
    const savedArchive = await describeArchive(imageArchivePath);
    // Removing the saved name is what makes the load meaningful: without it a successful load
    // is indistinguishable from a no-op against an image that never went away.
    const removedSavedTag = await client.request("images.action", {
      context: dindContext,
      action: "remove",
      id: pulledImage.id,
      reference: structuredTag,
      confirmed: true,
    });
    const betweenArchive = await client.request(
      "images.list",
      { context: dindContext, all: true },
      60_000,
    );
    const withoutSavedTag = imageWithId(betweenArchive, pulledImage.id);
    const load = await client.request("images.action", {
      context: dindContext,
      action: "load",
      archivePath: imageArchivePath,
      timeoutSeconds: 300,
      outputWindowBytes: 65_536,
      maxOutputBytes: 8 * 1_048_576,
    });
    if (!load.session) {
      throw new Error("Image load did not return a session");
    }
    const loaded = await collectSession(client, load.session, "", 300_000);
    const afterArchive = await client.request(
      "images.list",
      { context: dindContext, all: true },
      60_000,
    );
    const restoredImage = imageWithId(afterArchive, pulledImage.id);
    record(
      checks,
      "image-save-load-roundtrip",
      "session-backed image save and load round trip",
      save.receipt.source === "cli-session" &&
        save.receipt.action === "save" &&
        saved.exited.exitCode === 0 &&
        !saved.exited.timedOut &&
        !saved.exited.output.truncated &&
        savedArchive.isTar &&
        savedArchive.sizeBytes > 1_048_576 &&
        removedSavedTag.receipt.outcome === "succeeded" &&
        Boolean(withoutSavedTag) &&
        !withoutSavedTag.repoTags.includes(structuredTag) &&
        load.receipt.source === "cli-session" &&
        load.receipt.action === "load" &&
        loaded.exited.exitCode === 0 &&
        !loaded.exited.timedOut &&
        loaded.text.includes(structuredTag) &&
        Boolean(restoredImage) &&
        // The archive must restore the same immutable image, not a re-derived one.
        restoredImage.repoTags.includes(structuredTag) &&
        restoredImage.repoTags.includes(sourceRef),
      {
        imageId: pulledImage.id,
        reference: structuredTag,
        archive: savedArchive,
        saveSessionId: save.session.sessionId,
        saveExitCode: saved.exited.exitCode,
        saveReceiptSource: save.receipt.source,
        removedBetween: !withoutSavedTag?.repoTags.includes(structuredTag),
        referencesBetween: withoutSavedTag?.repoTags ?? [],
        loadSessionId: load.session.sessionId,
        loadExitCode: loaded.exited.exitCode,
        loadReceiptSource: load.receipt.source,
        loadOutput: loaded.text.trim(),
        restoredImageId: restoredImage?.id ?? null,
        restoredReferences: restoredImage?.repoTags ?? [],
      },
      archiveStarted,
    );

    const exportStarted = process.hrtime.bigint();
    const exportName = `anchorage-export-${suffix}`;
    const exportArchivePath = resolve(
      scratchDirectory,
      `container-${suffix}.tar`,
    );
    const exportCreated = await client.request("cli.run", {
      context: dindContext,
      targetMode: "pinned",
      argv: [
        "container",
        "create",
        "--name",
        exportName,
        "--label",
        `io.anchorage.acceptance=${token}`,
        sourceRef,
        "sleep",
        "60",
      ],
      timeoutSeconds: 60,
    });
    assertCoreRunSucceeded(exportCreated, "Export source container create");
    const exportId = outputText(exportCreated.stdout).trim();
    if (!/^[a-f0-9]{64}$/u.test(exportId)) {
      throw new Error(
        `Export source container create returned invalid id: ${exportId}`,
      );
    }
    const exported = await client.request("containers.export", {
      context: dindContext,
      id: exportId,
      archivePath: exportArchivePath,
      timeoutSeconds: 300,
      outputWindowBytes: 65_536,
    });
    if (!exported.session) {
      throw new Error("Container export did not return a session");
    }
    const exportRun = await collectSession(
      client,
      exported.session,
      "",
      300_000,
    );
    const exportedArchive = await describeArchive(exportArchivePath);
    await client.request("containers.action", {
      context: dindContext,
      id: exportId,
      action: "remove",
      options: { confirmed: true },
    });
    const exportSourceAbsent = await verifyDisposableOwnership(
      dindContext,
      exportName,
      token,
    );
    record(
      checks,
      "container-export-archive",
      "session-backed container filesystem export",
      exported.action === "export" &&
        exported.receipt.source === "cli-session" &&
        exported.receipt.resourceId === exportId &&
        exportRun.exited.exitCode === 0 &&
        !exportRun.exited.timedOut &&
        !exportRun.exited.output.truncated &&
        exportedArchive.isTar &&
        exportedArchive.sizeBytes > 1_048_576 &&
        exportedArchive.firstEntry !== "" &&
        !exportSourceAbsent.exists,
      {
        containerId: exportId,
        containerName: exportName,
        sessionId: exported.session.sessionId,
        exitCode: exportRun.exited.exitCode,
        receiptSource: exported.receipt.source,
        archive: exportedArchive,
        sourceContainerVerifiedAbsent: !exportSourceAbsent.exists,
      },
      exportStarted,
    );

    const browseStarted = process.hrtime.bigint();
    const browseVolumeName = `anchorage_browse_${suffix}`;
    const browseMarker = `ANCHORAGE_VOLUME_${suffix}`;
    const createdBrowseVolume = await client.request("volumes.action", {
      context: dindContext,
      action: "create",
      name: browseVolumeName,
      labels: { "io.anchorage.acceptance": token },
    });
    const madeDirectory = await client.request("cli.run", {
      context: dindContext,
      targetMode: "pinned",
      argv: [
        "run",
        "--rm",
        "--volume",
        `${browseVolumeName}:/data`,
        sourceRef,
        "mkdir",
        "-p",
        "/data/nested",
      ],
      timeoutSeconds: 120,
    });
    assertCoreRunSucceeded(madeDirectory, "Volume browse directory seed");
    // The file is written through a session's stdin rather than a shell, because argv-level
    // `sh -c` is refused: `-c` is the Docker CLI's own --context shorthand.
    const seedSession = await client.request("session.start", {
      context: dindContext,
      targetMode: "pinned",
      argv: [
        "run",
        "--rm",
        "--interactive",
        "--volume",
        `${browseVolumeName}:/data`,
        sourceRef,
        "tee",
        "/data/nested/anchorage.txt",
      ],
      mode: "pipes",
      outputWindowBytes: 65_536,
      maxOutputBytes: 1_048_576,
      timeoutSeconds: 120,
    });
    const seedCollected = collectSession(client, seedSession, "", 120_000);
    await new Promise((wait) => setTimeout(wait, 1_500));
    await client.request("session.input", {
      sessionId: seedSession.sessionId,
      data: `${browseMarker}\n`,
      encoding: "utf-8",
      eof: true,
    });
    const seeded = await seedCollected;
    if (seeded.exited.exitCode !== 0) {
      throw new Error(
        `Volume browse file seed exited ${seeded.exited.exitCode}: ${seeded.text}`,
      );
    }
    // volumes.files and volumes.fileRead are Engine-API-only, so they run against the Unix
    // socket context; the published TCP context cannot serve them at all.
    const rootListing = await client.request(
      "volumes.files",
      { context: dindSocketContext, name: browseVolumeName, path: "/" },
      120_000,
    );
    const nestedListing = await client.request(
      "volumes.files",
      { context: dindSocketContext, name: browseVolumeName, path: "/nested" },
      120_000,
    );
    const fileRead = await client.request(
      "volumes.fileRead",
      {
        context: dindSocketContext,
        name: browseVolumeName,
        path: "/nested/anchorage.txt",
      },
      120_000,
    );
    const nestedEntry = rootListing.entries.find(
      (entry) => entry.name === "nested",
    );
    const seededEntry = nestedListing.entries.find(
      (entry) => entry.name === "anchorage.txt",
    );
    const helperQuery = [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      "label=io.anchorage.helper=volume-browse",
    ];
    /*
     * A helper surviving the read is now the design, not a leak.
     *
     * This used to assert zero helpers here, when the helper was created and never started. It
     * is now started and parked, because reusing it takes a directory hop from 8s to 0.04s, and
     * a browse that leaves one behind is what makes the second hop fast. What must still be
     * bounded is how many: walking a tree must pin one container, not one per directory.
     */
    const parkedDuringBrowse = await dockerLinesAt(dindSocketContext, helperQuery);
    const removedBrowseVolume = await client.request("volumes.action", {
      context: dindContext,
      action: "remove",
      name: browseVolumeName,
      confirmed: true,
    });
    /*
     * After the removal, though, nothing may remain.
     *
     * This is the property whose absence was the actual defect: a parked helper holds a
     * reference on its volume, so `docker volume rm` fails with "volume is in use" until the
     * core lets go. Counted after the remove rather than before, because "the helper is gone by
     * the time the volume is" is the contract, and it is the one that was broken.
     */
    const leakedHelpers = await dockerLinesAt(dindSocketContext, helperQuery);
    const afterBrowseRemove = await client.request("volumes.list", {
      context: dindContext,
    });
    record(
      checks,
      "volume-file-browse",
      "read-only volume browse through an unstarted helper",
      createdBrowseVolume.receipt.outcome === "succeeded" &&
        rootListing.source === "engine-api" &&
        // The helper's mount point must never leak into the reported paths.
        rootListing.path === "/" &&
        Boolean(nestedEntry) &&
        nestedEntry.isDir &&
        nestedEntry.path === "/nested" &&
        nestedListing.path === "/nested" &&
        Boolean(seededEntry) &&
        !seededEntry.isDir &&
        seededEntry.path === "/nested/anchorage.txt" &&
        fileRead.path === "/nested/anchorage.txt" &&
        fileRead.encoding === "utf-8" &&
        fileRead.content.trim() === browseMarker &&
        fileRead.sizeBytes === browseMarker.length + 1 &&
        !fileRead.truncated &&
        // One container for a whole tree walk, not one per directory.
        parkedDuringBrowse.length <= 1 &&
        leakedHelpers.length === 0 &&
        removedBrowseVolume.receipt.outcome === "succeeded" &&
        !volumeNames(afterBrowseRemove).includes(browseVolumeName),
      {
        volume: browseVolumeName,
        engineContext: dindSocketContext,
        listSource: rootListing.source,
        rootEntries: identityEvidence(
          sortedUnique(rootListing.entries.map((entry) => entry.path)),
        ),
        nestedEntries: identityEvidence(
          sortedUnique(nestedListing.entries.map((entry) => entry.path)),
        ),
        readPath: fileRead.path,
        readSizeBytes: fileRead.sizeBytes,
        readEncoding: fileRead.encoding,
        readMatched: fileRead.content.trim() === browseMarker,
        parkedHelperContainersDuringBrowse: parkedDuringBrowse.length,
        leakedHelperContainersAfterRemove: leakedHelpers.length,
        volumeVerifiedAbsent: !volumeNames(afterBrowseRemove).includes(
          browseVolumeName,
        ),
      },
      browseStarted,
    );

    const composeLifecycleStarted = process.hrtime.bigint();
    const composeLifecycleName = "disposable Compose project lifecycle";
    let dindComposeAvailable = true;
    let dindComposeError = null;
    try {
      await client.request(
        "compose.list",
        { context: dindContext, all: true },
        60_000,
      );
    } catch (error) {
      if (!isMissingPlugin(error, "compose_unavailable")) throw error;
      dindComposeAvailable = false;
      dindComposeError = error.message;
    }
    if (!dindComposeAvailable) {
      recordSkipped(
        checks,
        "compose-lifecycle",
        composeLifecycleName,
        "The Docker Compose CLI plugin is not installed for this Docker CLI, so compose.action up/stop/start/restart/down cannot be exercised.",
        { context: dindContext, error: dindComposeError },
        composeLifecycleStarted,
      );
    } else {
      const composeProject = `anchorage-acceptance-${suffix}`;
      const composeFile = resolve(scratchDirectory, `compose-${suffix}.yaml`);
      // A one-second stop grace keeps stop/restart/down bounded; the default ten-second wait
      // for a process that ignores SIGTERM would triple this check's runtime for no coverage.
      await writeFile(
        composeFile,
        [
          "services:",
          "  idle:",
          `    image: ${sourceRef}`,
          '    command: ["sleep", "600"]',
          "    stop_grace_period: 1s",
          "    labels:",
          `      io.anchorage.acceptance: "${token}"`,
          "",
        ].join("\n"),
      );
      const composeReceipts = {};
      const composeExits = {};
      const runComposeAction = async (action, extra = {}) => {
        const started = await client.request("compose.action", {
          context: dindContext,
          project: composeProject,
          action,
          timeoutSeconds: 300,
          outputWindowBytes: 65_536,
          ...extra,
        });
        if (!started.session) {
          throw new Error(`Compose ${action} did not return a session`);
        }
        const collected = await collectSession(
          client,
          started.session,
          "",
          300_000,
        );
        composeReceipts[action] = started.receipt;
        composeExits[action] = collected.exited;
        return { started, collected };
      };
      const up = await runComposeAction("up", { configFiles: [composeFile] });
      const composeProjects = await client.request(
        "compose.list",
        { context: dindContext, all: true },
        60_000,
      );
      const listedProject = composeProjects.projects.find(
        (project) => project.name === composeProject,
      );
      const composeServices = await client.request(
        "compose.ps",
        { context: dindContext, project: composeProject },
        60_000,
      );
      await runComposeAction("stop");
      const stoppedServices = await client.request(
        "compose.ps",
        { context: dindContext, project: composeProject },
        60_000,
      );
      await runComposeAction("start");
      await runComposeAction("restart");
      const restartedServices = await client.request(
        "compose.ps",
        { context: dindContext, project: composeProject },
        60_000,
      );
      await runComposeAction("down", { confirmed: true, removeOrphans: true });
      const afterDown = await client.request(
        "compose.list",
        { context: dindContext, all: true },
        60_000,
      );
      const projectContainersAfterDown = await composeCliContainerIds(
        dindContext,
        composeProject,
      );
      const allActionsSucceeded = ["up", "stop", "start", "restart", "down"]
        .every(
          (action) =>
            composeReceipts[action]?.source === "cli-session" &&
            composeReceipts[action]?.outcome === "running" &&
            composeExits[action]?.exitCode === 0 &&
            composeExits[action]?.timedOut === false,
        );
      record(
        checks,
        "compose-lifecycle",
        composeLifecycleName,
        allActionsSucceeded &&
          Boolean(listedProject) &&
          listedProject.runningCount === 1 &&
          listedProject.totalCount === 1 &&
          listedProject.configFiles.includes(composeFile) &&
          composeServices.services.length === 1 &&
          composeServices.services[0].service === "idle" &&
          composeServices.services[0].state === "running" &&
          stoppedServices.services.length === 1 &&
          stoppedServices.services[0].state === "exited" &&
          restartedServices.services.length === 1 &&
          restartedServices.services[0].state === "running" &&
          // down must remove the project outright, not merely stop it.
          !afterDown.projects.some(
            (project) => project.name === composeProject,
          ) &&
          projectContainersAfterDown.length === 0,
        {
          context: dindContext,
          project: composeProject,
          configFile: composeFile,
          actions: Object.fromEntries(
            ["up", "stop", "start", "restart", "down"].map((action) => [
              action,
              {
                receiptAction: composeReceipts[action]?.action ?? null,
                receiptOutcome: composeReceipts[action]?.outcome ?? null,
                source: composeReceipts[action]?.source ?? null,
                exitCode: composeExits[action]?.exitCode ?? null,
                durationMs: composeExits[action]?.durationMs ?? null,
              },
            ]),
          ),
          upOutput: up.collected.text.trim().split("\n").slice(-2),
          listedRunningCount: listedProject?.runningCount ?? null,
          listedTotalCount: listedProject?.totalCount ?? null,
          serviceStates: {
            afterUp: composeServices.services.map((s) => s.state),
            afterStop: stoppedServices.services.map((s) => s.state),
            afterRestart: restartedServices.services.map((s) => s.state),
          },
          projectVerifiedAbsent: !afterDown.projects.some(
            (project) => project.name === composeProject,
          ),
          containersVerifiedAbsent: projectContainersAfterDown.length === 0,
        },
        composeLifecycleStarted,
      );
    }

    const removeStarted = process.hrtime.bigint();
    const tagA = `anchorage-acceptance/dual:${suffix}-a`;
    const tagB = `anchorage-acceptance/dual:${suffix}-b`;
    for (const tag of [tagA, tagB]) {
      const tagged = await client.request("cli.run", {
        context: dindContext,
        targetMode: "pinned",
        argv: ["image", "tag", sourceRef, tag],
        timeoutSeconds: 30,
      });
      assertCoreRunSucceeded(tagged, `Image tag ${tag}`);
    }
    const beforeRemove = await client.request(
      "images.list",
      { context: dindContext, all: true },
      60_000,
    );
    const dualImage = beforeRemove.images.find((image) =>
      image.repoTags.includes(tagA),
    );
    if (
      !dualImage ||
      !dualImage.repoTags.includes(tagB) ||
      dualImage.id !== pulledImage.id
    ) {
      throw new Error("Dual-target image setup did not preserve one image ID");
    }
    const removedTag = await client.request("images.action", {
      context: dindContext,
      action: "remove",
      id: dualImage.id,
      reference: tagA,
      confirmed: true,
    });
    const afterRemove = await client.request(
      "images.list",
      { context: dindContext, all: true },
      60_000,
    );
    const preservedDualImage = imageWithId(afterRemove, dualImage.id);
    record(
      checks,
      "image-remove-one-tag",
      "dual-target one-tag image removal",
      removedTag.receipt.outcome === "succeeded" &&
        Boolean(preservedDualImage) &&
        preservedDualImage.repoTags.includes(tagB) &&
        !preservedDualImage.repoTags.includes(tagA),
      {
        imageId: dualImage.id,
        removedReference: tagA,
        preservedReference: tagB,
        receiptSource: removedTag.receipt.source,
        receiptOutcome: removedTag.receipt.outcome,
        preservedImageId: preservedDualImage?.id ?? null,
        postReferences: preservedDualImage?.repoTags ?? [],
      },
      removeStarted,
    );

    const danglingStarted = process.hrtime.bigint();
    const buildTag = `anchorage-acceptance/build:${suffix}`;
    await dockerOutputAt(
      dindContext,
      ["build", "--tag", buildTag, "-"],
      {
        input:
          `FROM scratch\n` +
          `LABEL io.anchorage.acceptance.variant="${token}-one"\n`,
        timeoutMs: 120_000,
      },
    );
    const firstBuildId = await dockerOutputAt(dindContext, [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      buildTag,
    ]);
    await dockerOutputAt(
      dindContext,
      ["build", "--tag", buildTag, "-"],
      {
        input:
          `FROM scratch\n` +
          `LABEL io.anchorage.acceptance.variant="${token}-two"\n`,
        timeoutMs: 120_000,
      },
    );
    const secondBuildId = await dockerOutputAt(dindContext, [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      buildTag,
    ]);
    if (
      firstBuildId === secondBuildId ||
      !/^sha256:[a-f0-9]{64}$/u.test(firstBuildId) ||
      !/^sha256:[a-f0-9]{64}$/u.test(secondBuildId)
    ) {
      throw new Error("Scratch builds did not produce distinct full image IDs");
    }
    const danglingPrune = await client.request("images.action", {
      context: dindContext,
      action: "prune",
      confirmed: true,
      filters: { dangling: ["true"] },
    });
    const afterDanglingPrune = await client.request(
      "images.list",
      { context: dindContext, all: true },
      60_000,
    );
    const taggedBuildAfterDangling = imageWithId(
      afterDanglingPrune,
      secondBuildId,
    );
    const taggedDualAfterDangling = imageWithId(
      afterDanglingPrune,
      dualImage.id,
    );
    record(
      checks,
      "image-prune-dangling",
      "dangling-only image prune",
      danglingPrune.receipt.outcome === "succeeded" &&
        !imageIds(afterDanglingPrune).includes(firstBuildId) &&
        Boolean(taggedBuildAfterDangling) &&
        taggedBuildAfterDangling.repoTags.includes(buildTag) &&
        Boolean(taggedDualAfterDangling) &&
        taggedDualAfterDangling.repoTags.includes(tagB),
      {
        danglingImageId: firstBuildId,
        taggedBuildImageId: secondBuildId,
        taggedDualImageId: dualImage.id,
        danglingAbsent: !imageIds(afterDanglingPrune).includes(firstBuildId),
        taggedBuildPreserved:
          taggedBuildAfterDangling?.repoTags.includes(buildTag) ?? false,
        taggedDualPreserved:
          taggedDualAfterDangling?.repoTags.includes(tagB) ?? false,
        receiptSource: danglingPrune.receipt.source,
        receiptOutcome: danglingPrune.receipt.outcome,
      },
      danglingStarted,
    );

    const allImagesStarted = process.hrtime.bigint();
    const allImagesPrune = await client.request("images.action", {
      context: dindContext,
      action: "prune",
      confirmed: true,
      filters: { dangling: ["false"] },
    });
    const afterAllImagesPrune = await client.request(
      "images.list",
      { context: dindContext, all: true },
      60_000,
    );
    const remainingImageIds = imageIds(afterAllImagesPrune);
    record(
      checks,
      "image-prune-all",
      "all-unused image prune",
      allImagesPrune.receipt.outcome === "succeeded" &&
        !remainingImageIds.includes(secondBuildId) &&
        !remainingImageIds.includes(dualImage.id),
      {
        deletedTaggedBuildId: secondBuildId,
        deletedTaggedDualId: dualImage.id,
        taggedBuildAbsent: !remainingImageIds.includes(secondBuildId),
        taggedDualAbsent: !remainingImageIds.includes(dualImage.id),
        remainingImages: identityEvidence(remainingImageIds),
        receiptSource: allImagesPrune.receipt.source,
        receiptOutcome: allImagesPrune.receipt.outcome,
      },
      allImagesStarted,
    );

    const pruneVolumeName = `anchorage_prune_${suffix}`;
    const defaultVolumeStarted = process.hrtime.bigint();
    const createdPruneVolume = await client.request("volumes.action", {
      context: dindContext,
      action: "create",
      name: pruneVolumeName,
      labels: { "io.anchorage.acceptance": token },
    });
    const defaultVolumePrune = await client.request("volumes.action", {
      context: dindContext,
      action: "prune",
      confirmed: true,
    });
    const afterDefaultVolumePrune = await client.request("volumes.list", {
      context: dindContext,
    });
    const allFalseVolumePrune = await client.request("volumes.action", {
      context: dindContext,
      action: "prune",
      confirmed: true,
      filters: { all: ["false"] },
    });
    const afterAllFalseVolumePrune = await client.request("volumes.list", {
      context: dindContext,
    });
    record(
      checks,
      "volume-prune-default",
      "named volume default and all=false prune preservation",
      createdPruneVolume.receipt.outcome === "succeeded" &&
        defaultVolumePrune.receipt.outcome === "succeeded" &&
        allFalseVolumePrune.receipt.outcome === "succeeded" &&
        volumeNames(afterDefaultVolumePrune).includes(pruneVolumeName) &&
        volumeNames(afterAllFalseVolumePrune).includes(pruneVolumeName),
      {
        name: pruneVolumeName,
        createSource: createdPruneVolume.receipt.source,
        defaultPruneSource: defaultVolumePrune.receipt.source,
        allFalsePruneSource: allFalseVolumePrune.receipt.source,
        presentAfterDefault:
          volumeNames(afterDefaultVolumePrune).includes(pruneVolumeName),
        presentAfterAllFalse:
          volumeNames(afterAllFalseVolumePrune).includes(pruneVolumeName),
      },
      defaultVolumeStarted,
    );

    const allVolumeStarted = process.hrtime.bigint();
    const allVolumePrune = await client.request("volumes.action", {
      context: dindContext,
      action: "prune",
      confirmed: true,
      filters: { all: ["true"] },
    });
    const afterAllVolumePrune = await client.request("volumes.list", {
      context: dindContext,
    });
    record(
      checks,
      "volume-prune-all",
      "all-unused named volume prune",
      allVolumePrune.receipt.outcome === "succeeded" &&
        !volumeNames(afterAllVolumePrune).includes(pruneVolumeName),
      {
        name: pruneVolumeName,
        verifiedAbsent:
          !volumeNames(afterAllVolumePrune).includes(pruneVolumeName),
        receiptSource: allVolumePrune.receipt.source,
        receiptOutcome: allVolumePrune.receipt.outcome,
      },
      allVolumeStarted,
    );

    const exactVolumeStarted = process.hrtime.bigint();
    const exactVolumeName = `anchorage_exact_${suffix}`;
    const createdExactVolume = await client.request("volumes.action", {
      context: dindContext,
      action: "create",
      name: exactVolumeName,
      labels: { "io.anchorage.acceptance": token },
    });
    const removedExactVolume = await client.request("volumes.action", {
      context: dindContext,
      action: "remove",
      name: exactVolumeName,
      confirmed: true,
    });
    const afterExactVolumeRemove = await client.request("volumes.list", {
      context: dindContext,
    });
    record(
      checks,
      "volume-remove-exact",
      "exact named volume removal",
      createdExactVolume.receipt.outcome === "succeeded" &&
        removedExactVolume.receipt.outcome === "succeeded" &&
        !volumeNames(afterExactVolumeRemove).includes(exactVolumeName),
      {
        name: exactVolumeName,
        createSource: createdExactVolume.receipt.source,
        removeSource: removedExactVolume.receipt.source,
        removeOutcome: removedExactVolume.receipt.outcome,
        verifiedAbsent:
          !volumeNames(afterExactVolumeRemove).includes(exactVolumeName),
      },
      exactVolumeStarted,
    );
  }
} catch (error) {
  failure = error;
} finally {
  await runTeardown();
}

// Everything below states the run's verdict, and an interrupted run's verdict is the handler's to
// state. Without this guard the two paths converge here: the handler tears down, the request that
// was in flight fails, `catch`/`finally` unwind through an already-resolved `runTeardown()`, and
// this epilogue writes `status: "failed"` over — or into — the `aborted` record being written to
// the same path. Whoever read the result would be told the run failed its checks, when what
// actually happened is that someone stopped it midway.
//
// Waiting, rather than skipping ahead, is the point: `abortRecord` settles only by way of the
// handler's own exit, so there is no second narrator and no second writer.
if (interrupted) await abortRecord;

const observedCheckIds = checks.map((check) => check.id).sort();
const checkMatrixComplete =
  checks.length === requiredChecks.length &&
  sameValues(observedCheckIds, requiredChecks);
if (!failure && !checkMatrixComplete) {
  failure = new Error(
    `Acceptance check matrix mismatch: required=${requiredChecks.join(",")} observed=${observedCheckIds.join(",")}`,
  );
}
const skippedChecks = collectSkippedChecks();
const result = {
  schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
  matrixVersion: ACCEPTANCE_MATRIX_VERSION,
  startedAt,
  completedAt: new Date().toISOString(),
  context,
  corePath,
  coreSha256,
  generator: {
    path: scriptPath,
    sha256: generatorSha256,
  },
  mutationsEnabled: runMutations,
  requiredChecks,
  status:
    !failure &&
    checkMatrixComplete &&
    checks.every(
      (check) => check.status === "passed" || check.status === "skipped",
    )
      ? "passed"
      : "failed",
  passedCheckCount: checks.filter((check) => check.status === "passed").length,
  skippedChecks,
  checks,
  cleanup: collectCleanupResult(),
  /*
   * The code and details, not only the message.
   *
   * The RPC client already keeps both on the thrown error — the code so the optional-plugin
   * checks can match exactly rather than by prose, the details because that is where the core
   * puts Docker's own stderr. Recording only the message threw the reason away at the last
   * step: a run that failed reported "volume_action_failed: Docker CLI rejected the volume
   * mutation" and nothing about which mutation or what Docker said, which is a whole re-run to
   * learn something the process already knew.
   */
  error: failure
    ? {
        name: failure instanceof Error ? failure.name : "Error",
        message:
          failure instanceof Error ? failure.message : String(failure),
        code: failure instanceof Error ? (failure.code ?? null) : null,
        details: failure instanceof Error ? (failure.details ?? null) : null,
      }
    : null,
};
await writeEvidenceOnce(result);
const summary =
  `${result.status.toUpperCase()}: ${result.passedCheckCount} of ${checks.length} ` +
  `core acceptance checks executed, ${skippedChecks.length} skipped ` +
  `(${runMutations ? "including" : "excluding"} disposable mutations).\n` +
  skippedChecks
    .map((check) => `  skipped ${check.id}: ${check.reason}\n`)
    .join("");
if (failure) {
  process.stderr.write(summary);
  process.stderr.write(`${result.error.message}\n`);
  // Printed as well as recorded: whoever ran this is looking at a terminal, and the detail is
  // the difference between "a volume mutation failed" and knowing which call and why.
  if (result.error.details) {
    process.stderr.write(`${JSON.stringify(result.error.details, null, 2)}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(summary);
}
