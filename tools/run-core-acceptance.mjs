#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "..");
const corePath = resolve(
  workspaceRoot,
  process.env.ANCHORAGE_CORE_PATH ?? "core/bin/anchorage-core",
);
const context = process.env.ANCHORAGE_DOCKER_CONTEXT?.trim() || "default";
const runMutations = process.env.ANCHORAGE_ACCEPTANCE_MUTATIONS === "1";
const READ_ONLY_CHECK_IDS = Object.freeze([
  "container-inspect-stats",
  "core-handshake",
  "installed-command-inventory",
  "literal-cli-run",
  "literal-pipes-session",
  "pinned-cli-run",
  "pinned-pipes-session",
  "snapshot-list-conformance",
]);
const MUTATION_CHECK_IDS = Object.freeze([
  "container-lifecycle",
  "dind-isolation",
  "image-prune-all",
  "image-prune-dangling",
  "image-pull-session",
  "image-remove-one-tag",
  "pty-session",
  "volume-prune-all",
  "volume-prune-default",
  "volume-remove-exact",
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
    child.on("exit", (code, signal) => {
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

function record(checks, id, name, passed, evidence, startedNs) {
  checks.push({
    id,
    name,
    status: passed ? "passed" : "failed",
    durationMs:
      Math.round((Number(process.hrtime.bigint() - startedNs) / 1_000_000) * 100) /
      100,
    evidence,
  });
  if (!passed) throw new Error(`${name} failed: ${JSON.stringify(evidence)}`);
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

async function cleanupDisposable(contextName, name, token) {
  const before = await verifyDisposableOwnership(contextName, name, token);
  if (!before.exists) return;
  if (!before.owned) {
    throw new Error(
      `Refusing to clean ${name}: acceptance ownership label does not match`,
    );
  }
  const removed = await runProcess("docker", [
    "--context",
    contextName,
    "container",
    "rm",
    "--force",
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
  throw new Error(`Could not inspect Docker context ${name}: ${result.stderr}`);
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
const startedAt = new Date().toISOString();
await rm(outputPath, { force: true });
const [generatorSha256, coreSha256] = await Promise.all([
  sha256File(scriptPath),
  sha256File(corePath),
]);
const client = new CoreClient(corePath);
let dindResource = null;
let failure = null;
const cleanupErrors = [];
const cleanupEvidence = {
  dockerContext: null,
  dindContainer: null,
};

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

  if (runMutations) {
    const token = randomUUID();
    const suffix = token.slice(0, 8);
    const dindName = `anchorage-dind-${suffix}`;
    const dindContext = `anchorage-dind-${suffix}`;
    dindResource = {
      containerName: dindName,
      contextName: dindContext,
      endpoint: null,
      token,
    };

    const isolationStarted = process.hrtime.bigint();
    const [existingContainer, existingContext] = await Promise.all([
      verifyDisposableOwnership(context, dindName, token),
      inspectDockerContext(dindContext),
    ]);
    if (existingContainer.exists || existingContext.exists) {
      throw new Error(
        `Random DinD isolation name collision: ${dindName}/${dindContext}`,
      );
    }
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
        "docker:29-dind",
        "--storage-driver=vfs",
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
        /^29(?:\.|$)/u.test(serverVersion) &&
        dindCapabilities.selectedContext === dindContext &&
        dindCapabilities.versions.server.version === serverVersion,
      {
        hostContext: context,
        containerName: dindName,
        containerId: launched.stdout.trim(),
        ownershipLabelVerified: ownership.owned,
        dockerContext: dindContext,
        endpoint,
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
      cleanupErrors.push(
        error instanceof Error ? error.message : String(error),
      );
      cleanupEvidence.dockerContext = {
        name: dindResource.contextName,
        endpoint: dindResource.endpoint,
        verifiedAbsent: false,
      };
    }
  }
  if (dindResource) {
    try {
      await cleanupDisposable(
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
      };
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error.message : String(error),
      );
      cleanupEvidence.dindContainer = {
        context,
        name: dindResource.containerName,
        ownershipLabel: dindResource.token,
        verifiedAbsent: false,
      };
    }
  }
  try {
    await client.close();
  } catch (error) {
    cleanupErrors.push(
      `Core shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!failure && cleanupErrors.length > 0) {
    failure = new Error(cleanupErrors.join("; "));
  }
}

const observedCheckIds = checks.map((check) => check.id).sort();
const checkMatrixComplete =
  checks.length === requiredChecks.length &&
  sameValues(observedCheckIds, requiredChecks);
if (!failure && !checkMatrixComplete) {
  failure = new Error(
    `Acceptance check matrix mismatch: required=${requiredChecks.join(",")} observed=${observedCheckIds.join(",")}`,
  );
}
const result = {
  schemaVersion: 2,
  matrixVersion: 1,
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
    checks.every((check) => check.status === "passed")
      ? "passed"
      : "failed",
  checks,
  cleanup: {
    status: cleanupErrors.length === 0 ? "passed" : "failed",
    errors: cleanupErrors,
    evidence: cleanupEvidence,
  },
  error: failure
    ? {
        name: failure instanceof Error ? failure.name : "Error",
        message:
          failure instanceof Error ? failure.message : String(failure),
      }
    : null,
};
await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
const summary =
  `${result.status.toUpperCase()}: ${checks.length} core acceptance checks ` +
  `(${runMutations ? "including" : "excluding"} disposable mutations).\n`;
if (failure) {
  process.stderr.write(summary);
  process.stderr.write(`${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(summary);
}
