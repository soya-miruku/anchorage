#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "..");
const corePath = resolve(
  workspaceRoot,
  process.env.ANCHORAGE_CORE_PATH ?? "core/bin/anchorage-core",
);
const outputDirectory = resolve(
  workspaceRoot,
  process.env.ANCHORAGE_EVIDENCE_DIRECTORY ?? "artifacts/docker",
);
const requestedContext = process.env.ANCHORAGE_DOCKER_CONTEXT?.trim();
const outputPaths = {
  capabilities: resolve(outputDirectory, "system-capabilities.json"),
  ledger: resolve(outputDirectory, "capability-ledger.json"),
  generation: resolve(outputDirectory, "capability-generation.json"),
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requestCapabilities() {
  return new Promise((resolveRequest, rejectRequest) => {
    const child = spawn(corePath, [], {
      cwd: workspaceRoot,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const request = {
      id: "capability-ledger",
      method: "system.capabilities",
      params: requestedContext ? { context: requestedContext } : {},
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRequest(
        new Error("Timed out waiting for system.capabilities after 30 seconds"),
      );
    }, 30_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline === -1) return;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          rejectRequest(
            new Error(`Core emitted invalid JSON: ${error.message}`),
          );
          return;
        }
        if (message.id !== request.id) continue;
        settled = true;
        clearTimeout(timeout);
        child.stdin.end();
        if (message.error) {
          rejectRequest(
            new Error(
              `${message.error.code ?? "core_error"}: ${message.error.message}`,
            ),
          );
          return;
        }
        resolveRequest(message.result);
        return;
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 256 * 1024) {
        stderr = stderr.slice(-256 * 1024);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectRequest(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (!settled) {
        rejectRequest(
          new Error(
            `Core exited before responding (code=${code}, signal=${signal}): ${stderr}`,
          ),
        );
      }
    });

    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function flattenLeafCommands(node, result = []) {
  const children = Array.isArray(node?.subcommands) ? node.subcommands : [];
  if (children.length === 0 && Array.isArray(node?.path) && node.path.length > 0) {
    result.push(node);
    return result;
  }
  for (const child of children) flattenLeafCommands(child, result);
  return result;
}

function evidenceSummary(evidence) {
  const stdout = String(evidence?.stdout ?? "");
  const stderr = String(evidence?.stderr ?? "");
  return {
    argv: Array.isArray(evidence?.argv) ? evidence.argv : [],
    exitCode: Number(evidence?.exitCode ?? -1),
    durationMs: Number(evidence?.durationMs ?? 0),
    timedOut: Boolean(evidence?.timedOut),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
  };
}

function ledgerRow(node, capabilities) {
  const available = node.status === "available";
  const context = capabilities.selectedContext ?? capabilities.currentContext;
  const command = node.path.join(" ");
  return {
    id: `docker:${node.path.join(":")}`,
    commandIdentity: {
      executable: capabilities.binary.realPath,
      executableSha256: capabilities.binary.sha256,
      plugin: node.pluginRoot ?? null,
      path: node.path,
      command: `docker ${command}`,
      kind: node.kind,
      DockerClientVersion: capabilities.versions?.client?.version ?? null,
    },
    discovery: {
      status: node.status,
      reason: node.reason,
      usage: node.usage ?? null,
      transports: node.transports,
      evidence: evidenceSummary(node.evidence),
      rawEvidenceFile: "system-capabilities.json",
      scope:
        "Recursive installed-command help and Usage discovery only; command-specific flags, positional arguments, environment requirements, and TTY needs are not inferred by this ledger.",
    },
    invocation: {
      executable: capabilities.binary.realPath,
      context,
      argvPrefix: ["--context", context],
      commandArgv: node.path,
      shellInterpolation: false,
      cwdPolicy: "core allowlisted root only",
      environmentPolicy: "core allowlist with Docker target overrides rejected",
    },
    io: {
      coverage: "shared-session-transport",
      supportedCapabilities: [
        "stdout",
        "stderr",
        "stdin",
        "streaming",
        "cancellation",
        "signals",
        "pty",
        "terminal-resize",
        "exit-status",
      ],
      backpressure: "sequenced ACK window",
      commandSpecificRequirements:
        "not inferred or executed by the inventory generator",
    },
    uiPath: {
      surface: "Command Center",
      shortcut: "Ctrl/Cmd+Shift+P",
      selection: command,
      structuredLiteralArgv: true,
      pipesMode: true,
      interactivePtyMode: true,
    },
    result: {
      coverage:
        available ? "executable-through-installed-cli" : "not-executable",
      commandExecution:
        "not-run-by-ledger-generator; destructive and environment-specific commands are not probed",
    },
    transportEvidence: [
      "core command discovery exact-binary tests",
      "core session literal-argv and context-injection tests",
      "core pipe/PTY/input/resize/signal/cancel/ACK tests",
      "Electron request/event bridge contract tests",
      "renderer Command Center inventory and session lifecycle tests",
    ],
    status: available ? "transport-covered" : "blocked",
    blockedReason: available ? null : node.reason,
  };
}

const startedAt = new Date().toISOString();
const startedNs = process.hrtime.bigint();
await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  Object.values(outputPaths).map((path) => rm(path, { force: true })),
);
const [coreSha256, generatorSha256] = await Promise.all([
  readFile(corePath).then(sha256),
  readFile(scriptPath).then(sha256),
]);
const capabilities = await requestCapabilities();
const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;

if (
  !capabilities?.commandInventory?.complete ||
  capabilities.commandInventory.limitReached
) {
  throw new Error(
    `Refusing an incomplete parity ledger: complete=${capabilities?.commandInventory?.complete}, limitReached=${capabilities?.commandInventory?.limitReached}`,
  );
}

const leaves = flattenLeafCommands(
  capabilities.commandInventory.root,
).filter((node) => node.status === "available");
const rows = leaves.map((node) => ledgerRow(node, capabilities));
const transportCovered = rows.filter(
  (row) => row.status === "transport-covered",
).length;
const blocked = rows.length - transportCovered;
const completedAt = new Date().toISOString();
const ledger = {
  schemaVersion: 1,
  generatedAt: completedAt,
  sourceObservedAt: capabilities.observedAt ?? null,
  selectedContext:
    capabilities.selectedContext ?? capabilities.currentContext ?? null,
  inventory: {
    complete: capabilities.commandInventory.complete,
    nodeCount: capabilities.commandInventory.nodeCount,
    leafCount: rows.length,
    transportCovered,
    commandExecutedConformancePassed: 0,
    blocked,
    warnings: capabilities.commandInventory.warnings,
  },
  coverageDefinition:
    "Every available installed leaf command is selectable as literal Docker argv and reachable through the same pipes/PTY session transport. Transport coverage is not command-behavior conformance: the generator intentionally does not execute arbitrary, destructive, credentialed, or environment-specific leaf commands.",
  rows,
};
const generation = {
  schemaVersion: 1,
  startedAt,
  completedAt,
  sourceObservedAt: capabilities.observedAt ?? null,
  durationMs: Math.round(elapsedMs * 100) / 100,
  corePath,
  coreSha256,
  dockerBinarySha256: capabilities.binary.sha256,
  generator: {
    path: scriptPath,
    sha256: generatorSha256,
  },
  context: ledger.selectedContext,
  complete: ledger.inventory.complete,
  nodeCount: ledger.inventory.nodeCount,
  leafCount: ledger.inventory.leafCount,
  transportCovered,
  commandExecutedConformancePassed: 0,
  blocked,
};

await Promise.all([
  writeFile(
    outputPaths.capabilities,
    `${JSON.stringify(capabilities, null, 2)}\n`,
  ),
  writeFile(
    outputPaths.ledger,
    `${JSON.stringify(ledger, null, 2)}\n`,
  ),
  writeFile(
    outputPaths.generation,
    `${JSON.stringify(generation, null, 2)}\n`,
  ),
]);

process.stdout.write(
  `Generated ${rows.length} leaf-command rows (${transportCovered} transport-covered, ${blocked} blocked; commands not mass-executed) in ${elapsedMs.toFixed(1)} ms.\n`,
);
