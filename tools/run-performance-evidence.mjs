#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const workspaceRoot = resolve(import.meta.dirname, "..");
const scriptPath = resolve(
  import.meta.dirname,
  "run-performance-evidence.mjs",
);
const outputDirectory = resolve(workspaceRoot, "artifacts/performance");
const environmentPath = resolve(outputDirectory, "environment.json");
const resultsPath = resolve(outputDirectory, "results.json");

const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_RSS_SAMPLES = 5_000;
const SESSION_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const RELEASE_PERFORMANCE_PROFILE = Object.freeze({
  id: "anchorage-desktop-release-v1",
  thresholds: Object.freeze({
    coldHealthLatencyMs: 2_000,
    warmHealthP95LatencyMs: 100,
    containersFirstLatencyMs: 5_000,
    containersWarmP95LatencyMs: 2_000,
    imagesFirstLatencyMs: 10_000,
    imagesWarmP95LatencyMs: 5_000,
    volumesFirstLatencyMs: 15_000,
    volumesWarmP95LatencyMs: 5_000,
    // system.snapshot and system.capabilities were previously unmeasured, and they were the
    // two slowest paths in the core: the snapshot walked /system/df on every call (measured
    // at a 60s hard failure on a populated host) and capabilities re-walked the whole CLI
    // help tree (~244 subprocesses). Both are now cached/opt-in, so they get real budgets.
    snapshotFirstLatencyMs: 5_000,
    snapshotWarmP95LatencyMs: 1_000,
    capabilitiesFirstLatencyMs: 10_000,
    capabilitiesWarmP95LatencyMs: 500,
    statsFanoutWallLatencyMs: 3_000,
    statsIndividualP95LatencyMs: 3_000,
    warmHealthMinimumSamples: 20,
    listWarmMinimumSamples: 20,
    statsMinimumRounds: 20,
    sessionCancelToExitMs: 2_000,
    coreRssP95Bytes: 128 * 1024 * 1024,
    coreRssMaxBytes: 160 * 1024 * 1024,
    coreRssGrowthBytes: 32 * 1024 * 1024,
  }),
});

class EvidenceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "EvidenceError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function requireCondition(condition, code, message, details) {
  if (!condition) throw new EvidenceError(code, message, details);
}

function integerEnvironment(name, fallback, minimum, maximum) {
  const source = process.env[name];
  if (source === undefined || source.trim() === "") return fallback;
  requireCondition(
    /^(?:0|[1-9][0-9]*)$/u.test(source.trim()),
    "invalid_configuration",
    `${name} must be an integer`,
    { name, value: source },
  );
  const value = Number(source);
  requireCondition(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    "invalid_configuration",
    `${name} must be between ${minimum} and ${maximum}`,
    { name, value },
  );
  return value;
}

function loadConfiguration() {
  const soakDurationSeconds = integerEnvironment(
    "ANCHORAGE_PERF_SOAK_SECONDS",
    1_800,
    1,
    86_400,
  );
  const rssIntervalMs = integerEnvironment(
    "ANCHORAGE_PERF_RSS_INTERVAL_MS",
    5_000,
    100,
    60_000,
  );
  const estimatedRssSamples =
    Math.ceil((soakDurationSeconds * 1_000) / rssIntervalMs) + 1;
  requireCondition(
    estimatedRssSamples <= MAX_RSS_SAMPLES,
    "invalid_configuration",
    "The requested soak and RSS interval would exceed the bounded sample limit",
    { estimatedRssSamples, maximum: MAX_RSS_SAMPLES },
  );
  return {
    corePath: resolve(
      workspaceRoot,
      process.env.ANCHORAGE_CORE_PATH ?? "core/bin/anchorage-core",
    ),
    context: process.env.ANCHORAGE_DOCKER_CONTEXT?.trim() || "default",
    soakDurationSeconds,
    rssIntervalMs,
    warmHealthSamples: integerEnvironment(
      "ANCHORAGE_PERF_WARM_HEALTH_SAMPLES",
      20,
      20,
      50,
    ),
    listSamples: integerEnvironment(
      "ANCHORAGE_PERF_LIST_SAMPLES",
      21,
      21,
      50,
    ),
    statsFanout: integerEnvironment(
      "ANCHORAGE_PERF_STATS_FANOUT",
      4,
      4,
      64,
    ),
    statsRounds: integerEnvironment(
      "ANCHORAGE_PERF_STATS_ROUNDS",
      20,
      20,
      50,
    ),
    requestTimeoutMs: integerEnvironment(
      "ANCHORAGE_PERF_REQUEST_TIMEOUT_MS",
      60_000,
      1_000,
      300_000,
    ),
    cancelGraceMs: integerEnvironment(
      "ANCHORAGE_PERF_CANCEL_GRACE_MS",
      1_000,
      0,
      30_000,
    ),
  };
}

function elapsedMilliseconds(started) {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function rounded(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index];
}

function summarize(values) {
  requireCondition(
    Array.isArray(values) && values.length > 0,
    "missing_samples",
    "Cannot summarize an empty sample set",
  );
  const sorted = values.map(Number).sort((left, right) => left - right);
  requireCondition(
    sorted.every(Number.isFinite),
    "invalid_sample",
    "A timing or memory sample is not finite",
  );
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: rounded(sorted[0]),
    p50: rounded(percentile(sorted, 0.5)),
    p95: rounded(percentile(sorted, 0.95)),
    max: rounded(sorted.at(-1)),
    mean: rounded(sum / sorted.length),
  };
}

function evaluatePerformanceSLOs(results) {
  const limits = RELEASE_PERFORMANCE_PROFILE.thresholds;
  const maximum = (id, metric, observed, limit) => ({
    id,
    metric,
    comparison: "<=",
    observed,
    limit,
    status:
      Number.isFinite(observed) && Number.isFinite(limit) && observed <= limit
        ? "passed"
        : "failed",
  });
  const equal = (id, metric, observed, expected) => ({
    id,
    metric,
    comparison: "===",
    observed,
    expected,
    status: Object.is(observed, expected) ? "passed" : "failed",
  });
  const minimum = (id, metric, observed, limit) => ({
    id,
    metric,
    comparison: ">=",
    observed,
    limit,
    status:
      Number.isFinite(observed) && Number.isFinite(limit) && observed >= limit
        ? "passed"
        : "failed",
  });
  const checks = [
    maximum(
      "cold-health-latency",
      "health.cold.latencyMs",
      results.health?.cold?.latencyMs,
      limits.coldHealthLatencyMs,
    ),
    maximum(
      "warm-health-p95-latency",
      "health.warm.latencyMs.p95",
      results.health?.warm?.latencyMs?.p95,
      limits.warmHealthP95LatencyMs,
    ),
    maximum(
      "containers-first-latency",
      "nativeLists.containers.firstLatencyMs",
      results.nativeLists?.containers?.firstLatencyMs,
      limits.containersFirstLatencyMs,
    ),
    maximum(
      "containers-warm-p95-latency",
      "nativeLists.containers.subsequentLatencyMs.p95",
      results.nativeLists?.containers?.subsequentLatencyMs?.p95,
      limits.containersWarmP95LatencyMs,
    ),
    maximum(
      "images-first-latency",
      "nativeLists.images.firstLatencyMs",
      results.nativeLists?.images?.firstLatencyMs,
      limits.imagesFirstLatencyMs,
    ),
    maximum(
      "images-warm-p95-latency",
      "nativeLists.images.subsequentLatencyMs.p95",
      results.nativeLists?.images?.subsequentLatencyMs?.p95,
      limits.imagesWarmP95LatencyMs,
    ),
    maximum(
      "volumes-first-latency",
      "nativeLists.volumes.firstLatencyMs",
      results.nativeLists?.volumes?.firstLatencyMs,
      limits.volumesFirstLatencyMs,
    ),
    maximum(
      "volumes-warm-p95-latency",
      "nativeLists.volumes.subsequentLatencyMs.p95",
      results.nativeLists?.volumes?.subsequentLatencyMs?.p95,
      limits.volumesWarmP95LatencyMs,
    ),
    maximum(
      "snapshot-first-latency",
      "nativeLists.snapshot.firstLatencyMs",
      results.nativeLists?.snapshot?.firstLatencyMs,
      limits.snapshotFirstLatencyMs,
    ),
    maximum(
      "snapshot-warm-p95-latency",
      "nativeLists.snapshot.subsequentLatencyMs.p95",
      results.nativeLists?.snapshot?.subsequentLatencyMs?.p95,
      limits.snapshotWarmP95LatencyMs,
    ),
    maximum(
      "capabilities-first-latency",
      "nativeLists.capabilities.firstLatencyMs",
      results.nativeLists?.capabilities?.firstLatencyMs,
      limits.capabilitiesFirstLatencyMs,
    ),
    maximum(
      "capabilities-warm-p95-latency",
      "nativeLists.capabilities.subsequentLatencyMs.p95",
      results.nativeLists?.capabilities?.subsequentLatencyMs?.p95,
      limits.capabilitiesWarmP95LatencyMs,
    ),
    maximum(
      "stats-fanout-wall-latency",
      "visibleContainerStats.wallLatencyMs.p95",
      results.visibleContainerStats?.wallLatencyMs?.p95,
      limits.statsFanoutWallLatencyMs,
    ),
    maximum(
      "stats-individual-p95-latency",
      "visibleContainerStats.individualLatencyMs.p95",
      results.visibleContainerStats?.individualLatencyMs?.p95,
      limits.statsIndividualP95LatencyMs,
    ),
    minimum(
      "warm-health-sample-floor",
      "health.warm.latencyMs.count",
      results.health?.warm?.latencyMs?.count,
      limits.warmHealthMinimumSamples,
    ),
    minimum(
      "containers-warm-sample-floor",
      "nativeLists.containers.subsequentLatencyMs.count",
      results.nativeLists?.containers?.subsequentLatencyMs?.count,
      limits.listWarmMinimumSamples,
    ),
    minimum(
      "images-warm-sample-floor",
      "nativeLists.images.subsequentLatencyMs.count",
      results.nativeLists?.images?.subsequentLatencyMs?.count,
      limits.listWarmMinimumSamples,
    ),
    minimum(
      "volumes-warm-sample-floor",
      "nativeLists.volumes.subsequentLatencyMs.count",
      results.nativeLists?.volumes?.subsequentLatencyMs?.count,
      limits.listWarmMinimumSamples,
    ),
    minimum(
      "stats-round-sample-floor",
      "visibleContainerStats.actualRounds",
      results.visibleContainerStats?.actualRounds,
      limits.statsMinimumRounds,
    ),
    maximum(
      "session-cancel-to-exit",
      "streamingSoak.cancellation.cancelToExitMs",
      results.streamingSoak?.cancellation?.cancelToExitMs,
      limits.sessionCancelToExitMs,
    ),
    maximum(
      "core-rss-p95",
      "streamingSoak.rssBytes.p95",
      results.streamingSoak?.rssBytes?.p95,
      limits.coreRssP95Bytes,
    ),
    maximum(
      "core-rss-max",
      "streamingSoak.rssBytes.max",
      results.streamingSoak?.rssBytes?.max,
      limits.coreRssMaxBytes,
    ),
    maximum(
      "core-rss-growth",
      "max(0, streamingSoak.rssDeltaBytes)",
      Math.max(0, results.streamingSoak?.rssDeltaBytes),
      limits.coreRssGrowthBytes,
    ),
    equal(
      "stats-fanout-complete",
      "visibleContainerStats.actualFanout",
      results.visibleContainerStats?.actualFanout,
      results.visibleContainerStats?.requestedFanout,
    ),
    equal(
      "stats-rounds-complete",
      "visibleContainerStats.actualRounds",
      results.visibleContainerStats?.actualRounds,
      results.visibleContainerStats?.requestedRounds,
    ),
    equal(
      "stats-sample-matrix-complete",
      "visibleContainerStats.samples.length",
      results.visibleContainerStats?.samples?.length,
      results.visibleContainerStats?.actualFanout *
        results.visibleContainerStats?.actualRounds,
    ),
    equal(
      "session-output-not-dropped",
      "streamingSoak.cancellation.exit.output.droppedBytes",
      results.streamingSoak?.cancellation?.exit?.output?.droppedBytes,
      0,
    ),
    equal(
      "session-output-not-truncated",
      "streamingSoak.cancellation.exit.output.truncated",
      results.streamingSoak?.cancellation?.exit?.output?.truncated,
      false,
    ),
    equal(
      "session-event-acknowledgements",
      "streamingSoak.sessionOutput.acknowledgements",
      results.streamingSoak?.sessionOutput?.acknowledgements,
      results.streamingSoak?.sessionOutput?.events,
    ),
    equal(
      "session-byte-acknowledgements",
      "streamingSoak.sessionOutput.acknowledgedBytes",
      results.streamingSoak?.sessionOutput?.acknowledgedBytes,
      results.streamingSoak?.sessionOutput?.bytes,
    ),
  ];
  return {
    profile: RELEASE_PERFORMANCE_PROFILE.id,
    thresholds: limits,
    status: checks.every((check) => check.status === "passed")
      ? "passed"
      : "failed",
    checks,
  };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    timer.unref();
  });
}

function boundedText(value, maximum = 4_096) {
  const text = String(value ?? "");
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}

function errorRecord(error) {
  let details;
  if (error?.details !== undefined) {
    try {
      const serialized = JSON.stringify(error.details);
      details =
        Buffer.byteLength(serialized) <= 8_192
          ? JSON.parse(serialized)
          : {
              truncated: true,
              preview: boundedText(serialized, 8_192),
            };
    } catch {
      details = { unavailable: "Error details were not JSON-serializable." };
    }
  }
  return {
    name: boundedText(error?.name ?? "Error", 128),
    code: boundedText(error?.code ?? "performance_evidence_failed", 256),
    message: boundedText(error?.message ?? error, 4_096),
    ...(details === undefined ? {} : { details }),
  };
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", rejectHash);
    input.once("end", resolveHash);
  });
  return hash.digest("hex");
}

function runBounded(executable, args, timeoutMs = 30_000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: workspaceRoot,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure = null;
    let settled = false;
    let forceKill = null;

    const failAndStop = (error) => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 2_000);
    };
    const timeout = setTimeout(() => {
      failAndStop(
        new EvidenceError(
          "tool_timeout",
          `${executable} ${args.join(" ")} timed out after ${timeoutMs} ms`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_TOOL_OUTPUT_BYTES) {
        failAndStop(
          new EvidenceError(
            "tool_output_too_large",
            `${executable} stdout exceeded ${MAX_TOOL_OUTPUT_BYTES} bytes`,
          ),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_TOOL_OUTPUT_BYTES) {
        failAndStop(
          new EvidenceError(
            "tool_output_too_large",
            `${executable} stderr exceeded ${MAX_TOOL_OUTPUT_BYTES} bytes`,
          ),
        );
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      if (settled) return;
      settled = true;
      rejectRun(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      if (settled) return;
      settled = true;
      if (failure) {
        rejectRun(failure);
        return;
      }
      resolveRun({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

class CoreClient {
  constructor(corePath) {
    this.child = spawn(corePath, ["--allow-cwd", workspaceRoot], {
      cwd: workspaceRoot,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.counter = 0;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.stderr = "";
    this.pending = new Map();
    this.notificationListeners = new Set();
    this.fatalError = null;
    this.closing = false;
    this.exitInfo = null;
    this.exitPromise = new Promise((resolveExit) => {
      this.resolveExit = resolveExit;
    });
    this.fatalPromise = new Promise((resolveFatal) => {
      this.resolveFatal = resolveFatal;
    });

    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    this.child.once("error", (error) => {
      this.fail(error);
      if (!this.exitInfo) {
        this.exitInfo = { code: null, signal: null };
        this.resolveExit(this.exitInfo);
      }
    });
    this.child.once("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.resolveExit(this.exitInfo);
      if (!this.closing) {
        this.fail(
          new EvidenceError(
            "core_exited",
            `Anchorage core exited unexpectedly (code=${code}, signal=${signal})`,
            { stderr: boundedText(this.stderr, MAX_STDERR_BYTES) },
          ),
        );
      }
    });
  }

  onData(chunk) {
    if (this.fatalError) return;
    this.buffer += this.decoder.write(chunk);
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_RPC_LINE_BYTES) {
        this.fail(
          new EvidenceError(
            "rpc_line_too_large",
            `Core emitted a line larger than ${MAX_RPC_LINE_BYTES} bytes`,
          ),
        );
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.fail(
          new EvidenceError("invalid_core_json", "Core emitted invalid JSON", {
            cause: error.message,
          }),
        );
        return;
      }
      this.onMessage(message);
    }
    if (Buffer.byteLength(this.buffer) > MAX_RPC_LINE_BYTES) {
      this.fail(
        new EvidenceError(
          "rpc_line_too_large",
          `Core emitted an unterminated line larger than ${MAX_RPC_LINE_BYTES} bytes`,
        ),
      );
    }
  }

  onMessage(message) {
    if (
      message &&
      typeof message === "object" &&
      Object.hasOwn(message, "id")
    ) {
      const id =
        typeof message.id === "number" ? String(message.id) : message.id;
      const pending = this.pending.get(id);
      if (!pending) {
        this.fail(
          new EvidenceError(
            "unknown_response_id",
            `Core answered unknown request id ${boundedText(id, 128)}`,
          ),
        );
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      if (message.error) {
        const error = new EvidenceError(
          message.error.code ?? "core_error",
          message.error.message ?? "Core request failed",
          message.error.details,
        );
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (
      message &&
      typeof message === "object" &&
      typeof message.event === "string"
    ) {
      for (const listener of this.notificationListeners) {
        try {
          listener(message);
        } catch (error) {
          this.fail(error);
          return;
        }
      }
      return;
    }
    this.fail(
      new EvidenceError(
        "invalid_core_envelope",
        "Core emitted an invalid protocol envelope",
      ),
    );
  }

  fail(error) {
    if (this.fatalError) return;
    this.fatalError =
      error instanceof Error ? error : new Error(String(error ?? "Core failure"));
    this.resolveFatal(this.fatalError);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.fatalError);
    }
    this.pending.clear();
    if (!this.closing && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
    }
  }

  throwIfFailed() {
    if (this.fatalError) throw this.fatalError;
  }

  subscribe(listener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  request(method, params, timeoutMs) {
    this.throwIfFailed();
    requireCondition(
      this.child.stdin && !this.child.stdin.destroyed,
      "core_unavailable",
      "Core stdin is unavailable",
    );
    const id = `performance-${++this.counter}`;
    const line = `${JSON.stringify({ id, method, params })}\n`;
    requireCondition(
      Buffer.byteLength(line) <= MAX_RPC_LINE_BYTES,
      "rpc_request_too_large",
      "Performance request exceeded the protocol line limit",
    );
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(
          new EvidenceError(
            "core_timeout",
            `${method} timed out after ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout,
      });
      this.child.stdin.write(line, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        rejectRequest(error);
      });
    });
  }

  async close() {
    if (this.closing) return this.exitPromise;
    this.closing = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      return this.exitPromise;
    }
    this.child.stdin.end();
    let exited = await Promise.race([
      this.exitPromise.then(() => true),
      delay(5_000).then(() => false),
    ]);
    if (!exited && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      exited = await Promise.race([
        this.exitPromise.then(() => true),
        delay(2_000).then(() => false),
      ]);
    }
    if (!exited && this.child.exitCode === null) {
      this.child.kill("SIGKILL");
      await this.exitPromise;
    }
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    return this.exitInfo;
  }
}

class SessionTracker {
  constructor(client, requestTimeoutMs) {
    this.client = client;
    this.requestTimeoutMs = requestTimeoutMs;
    this.sessionId = null;
    this.started = null;
    this.exited = null;
    this.exitObservedNs = null;
    this.lastSequence = 0;
    this.outputEvents = 0;
    this.outputBytes = 0;
    this.ackCount = 0;
    this.ackedBytes = 0;
    this.streamBytes = { stdout: 0, stderr: 0, pty: 0 };
    this.ackChain = Promise.resolve();
    this.terminalState = null;
    this.terminal = new Promise((resolveTerminal) => {
      this.resolveTerminal = resolveTerminal;
    });
    this.unsubscribe = client.subscribe((message) => this.onEvent(message));
  }

  onEvent(message) {
    const payload = message.payload;
    if (message.event === "session.started") {
      if (this.sessionId && this.sessionId !== payload?.sessionId) {
        this.fail(
          new EvidenceError(
            "unexpected_session",
            "Core started more than one session during the performance run",
          ),
        );
        return;
      }
      this.sessionId = payload?.sessionId;
      this.started = payload;
      return;
    }
    if (!payload?.sessionId || payload.sessionId !== this.sessionId) return;
    if (message.event === "session.output") {
      this.acceptOutput(payload);
      return;
    }
    if (message.event === "session.output.truncated") {
      this.fail(
        new EvidenceError(
          "session_output_truncated",
          "The docker events session dropped output during the soak",
          payload,
        ),
      );
      return;
    }
    if (message.event === "session.error") {
      this.fail(
        new EvidenceError(
          payload.code ?? "session_error",
          payload.message ?? "The docker events session reported an error",
          payload,
        ),
      );
      return;
    }
    if (message.event === "session.exited") {
      this.exited = payload;
      this.exitObservedNs = process.hrtime.bigint();
      this.ackChain.then(
        () => this.settle({ kind: "exited", payload }),
        (error) => this.fail(error),
      );
    }
  }

  acceptOutput(payload) {
    if (
      !Number.isSafeInteger(payload.sequence) ||
      payload.sequence <= this.lastSequence ||
      !Number.isSafeInteger(payload.bytes) ||
      payload.bytes < 0
    ) {
      this.fail(
        new EvidenceError(
          "invalid_session_output",
          "Session output sequence or byte count is invalid",
          {
            sequence: payload.sequence,
            lastSequence: this.lastSequence,
            bytes: payload.bytes,
          },
        ),
      );
      return;
    }
    this.lastSequence = payload.sequence;
    this.outputEvents += 1;
    this.outputBytes += payload.bytes;
    if (Object.hasOwn(this.streamBytes, payload.stream)) {
      this.streamBytes[payload.stream] += payload.bytes;
    }
    const sequence = payload.sequence;
    const bytes = payload.bytes;
    this.ackChain = this.ackChain.then(async () => {
      const result = await this.client.request(
        "session.ack",
        { sessionId: this.sessionId, throughSequence: sequence },
        this.requestTimeoutMs,
      );
      requireCondition(
        result.sessionId === this.sessionId &&
          result.throughSequence >= sequence &&
          result.outstandingBytes >= 0,
        "invalid_session_ack",
        "Core returned an invalid session acknowledgement",
        result,
      );
      this.ackCount += 1;
      this.ackedBytes += bytes;
    });
    this.ackChain.catch((error) => this.fail(error));
  }

  bindStartResult(result) {
    requireCondition(
      result?.sessionId &&
        result.sessionId === this.sessionId &&
        this.started?.sessionId === result.sessionId,
      "missing_session_started",
      "session.started was not observed before the session.start response",
      { responseSessionId: result?.sessionId, eventSessionId: this.sessionId },
    );
    requireCondition(
      result.mode === "pipes" &&
        result.context === this.started.context &&
        Array.isArray(result.argv),
      "invalid_session_start",
      "Core returned an invalid docker events session start result",
      result,
    );
  }

  fail(error) {
    if (this.terminalState) return;
    this.settle({
      kind: "failure",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  settle(state) {
    if (this.terminalState) return;
    this.terminalState = state;
    this.resolveTerminal(state);
  }

  async raceDelay(milliseconds) {
    const state = await Promise.race([
      delay(milliseconds).then(() => null),
      this.terminal,
      this.client.fatalPromise.then((error) => ({
        kind: "failure",
        error,
      })),
    ]);
    if (!state) return;
    if (state.kind === "failure") throw state.error;
    throw new EvidenceError(
      "session_exited_early",
      "The docker events session exited before the soak was canceled",
      state.payload,
    );
  }

  async waitForExit(timeoutMs) {
    const state = await Promise.race([
      this.terminal,
      delay(timeoutMs).then(() => ({
        kind: "failure",
        error: new EvidenceError(
          "session_exit_timeout",
          `The docker events session did not exit within ${timeoutMs} ms`,
        ),
      })),
    ]);
    if (state.kind === "failure") throw state.error;
    return state.payload;
  }

  close() {
    this.unsubscribe();
  }
}

async function readCoreMemory(pid, startedNs) {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const numericField = (name) => {
    const match = status.match(new RegExp(`^${name}:\\s+([0-9]+)\\s+kB$`, "mu"));
    requireCondition(
      match,
      "missing_rss_sample",
      `Core /proc status did not include ${name}`,
      { pid },
    );
    return Number(match[1]) * 1024;
  };
  const threadMatch = status.match(/^Threads:\s+([0-9]+)$/mu);
  requireCondition(
    threadMatch,
    "missing_rss_sample",
    "Core /proc status did not include Threads",
    { pid },
  );
  return {
    observedAt: new Date().toISOString(),
    relativeMs: rounded(elapsedMilliseconds(startedNs)),
    rssBytes: numericField("VmRSS"),
    rssHighWaterBytes: numericField("VmHWM"),
    virtualBytes: numericField("VmSize"),
    threads: Number(threadMatch[1]),
  };
}

async function collectStaticEnvironment(configuration) {
  await access(configuration.corePath, constants.R_OK | constants.X_OK);
  const [coreStat, coreSha256, dockerRun] = await Promise.all([
    stat(configuration.corePath),
    sha256File(configuration.corePath),
    runBounded(
      "docker",
      [
        "--context",
        configuration.context,
        "version",
        "--format",
        "{{json .}}",
      ],
      configuration.requestTimeoutMs,
    ),
  ]);
  requireCondition(
    coreStat.isFile(),
    "invalid_core_binary",
    "Anchorage core path is not a regular file",
    { path: configuration.corePath },
  );
  requireCondition(
    dockerRun.code === 0,
    "docker_version_failed",
    "Docker version discovery failed",
    {
      exitCode: dockerRun.code,
      signal: dockerRun.signal,
      stderr: boundedText(dockerRun.stderr),
    },
  );
  let dockerVersion;
  try {
    dockerVersion = JSON.parse(dockerRun.stdout);
  } catch (error) {
    throw new EvidenceError(
      "docker_version_invalid",
      "Docker version discovery returned invalid JSON",
      { cause: error.message },
    );
  }
  const versionFields = (value) => ({
    version: value?.Version ?? null,
    apiVersion: value?.ApiVersion ?? null,
    minApiVersion: value?.MinAPIVersion ?? null,
    goVersion: value?.GoVersion ?? null,
    os: value?.Os ?? null,
    arch: value?.Arch ?? null,
  });
  const cpus = os.cpus();
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    harness: {
      script: "tools/run-performance-evidence.mjs",
      sha256: createHash("sha256")
        .update(await readFile(scriptPath))
        .digest("hex"),
      readOnly: true,
      performanceProfile: RELEASE_PERFORMANCE_PROFILE,
      context: configuration.context,
      requestedSoakDurationSeconds: configuration.soakDurationSeconds,
      rssIntervalMs: configuration.rssIntervalMs,
      warmHealthSamples: configuration.warmHealthSamples,
      listSamples: configuration.listSamples,
      statsFanout: configuration.statsFanout,
      statsRounds: configuration.statsRounds,
      requestTimeoutMs: configuration.requestTimeoutMs,
      cancelGraceMs: configuration.cancelGraceMs,
      maximumRssSamples: MAX_RSS_SAMPLES,
      maximumArtifactBytes: MAX_ARTIFACT_BYTES,
    },
    host: {
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model ?? null,
      cpuSpeedMHz: cpus[0]?.speed ?? null,
      totalMemoryBytes: os.totalmem(),
    },
    tools: {
      node: {
        version: process.version,
        v8: process.versions.v8,
        modules: process.versions.modules,
      },
      docker: {
        client: versionFields(dockerVersion.Client),
        server: versionFields(dockerVersion.Server),
      },
      core: {
        path: configuration.corePath,
        sizeBytes: coreStat.size,
        modifiedAt: coreStat.mtime.toISOString(),
        sha256: coreSha256,
      },
    },
  };
}

async function timedRequest(client, method, params, timeoutMs) {
  const started = process.hrtime.bigint();
  const result = await client.request(method, params, timeoutMs);
  return { result, latencyMs: rounded(elapsedMilliseconds(started)) };
}

function assertHealth(health, childPid) {
  requireCondition(
    health?.status === "ok" &&
      health.protocolVersion === "1" &&
      health.dockerReady === true &&
      health.pid === childPid,
    "invalid_core_health",
    "Core health response was not ready or did not identify the spawned core",
    health,
  );
}

async function measureNativeLists(client, configuration) {
  const definitions = [
    {
      name: "containers",
      method: "containers.list",
      params: { context: configuration.context, all: true },
      field: "containers",
    },
    {
      name: "images",
      method: "images.list",
      params: {
        context: configuration.context,
        all: false,
        includeDangling: true,
      },
      field: "images",
    },
    {
      name: "volumes",
      method: "volumes.list",
      params: { context: configuration.context },
      field: "volumes",
    },
    {
      // Disk usage is deliberately excluded: it is opt-in precisely because it is a full
      // daemon-side walk, and only the dashboard requests it.
      name: "snapshot",
      method: "system.snapshot",
      params: { context: configuration.context },
      field: null,
    },
    {
      name: "capabilities",
      method: "system.capabilities",
      params: { context: configuration.context },
      field: null,
    },
  ];
  const measurements = {};
  let latestContainers = null;
  for (const definition of definitions) {
    const samples = [];
    for (let index = 0; index < configuration.listSamples; index += 1) {
      const sample = await timedRequest(
        client,
        definition.method,
        definition.params,
        configuration.requestTimeoutMs,
      );
      // Not every measured method is a list. system.capabilities has no Engine endpoint hash
      // at all (it is a CLI-discovery method), and system.snapshot returns no collection.
      const collection = definition.field
        ? sample.result?.[definition.field]
        : null;
      if (definition.field) {
        requireCondition(
          sample.result?.source === "engine-api" &&
            typeof sample.result.endpointHash === "string" &&
            sample.result.endpointHash.length > 0 &&
            Array.isArray(collection),
          "non_native_list",
          `${definition.method} did not return a native Engine result`,
          {
            source: sample.result?.source,
            endpointHash: sample.result?.endpointHash,
          },
        );
      } else {
        requireCondition(
          sample.result !== undefined && sample.result !== null,
          "empty_result",
          `${definition.method} did not return a result`,
          { method: definition.method },
        );
      }
      samples.push({
        index,
        latencyMs: sample.latencyMs,
        count: collection ? collection.length : null,
        observedAt: sample.result.observedAt,
        apiVersion: sample.result.apiVersion,
      });
      if (definition.name === "containers") latestContainers = sample.result;
    }
    const warmLatencies = samples.slice(1).map((sample) => sample.latencyMs);
    measurements[definition.name] = {
      method: definition.method,
      params: definition.params,
      firstLatencyMs: samples[0].latencyMs,
      subsequentLatencyMs: summarize(warmLatencies),
      samples,
    };
  }
  requireCondition(
    latestContainers,
    "missing_samples",
    "No native container-list sample was retained",
  );
  return { measurements, latestContainers };
}

async function measureStatsFanout(client, configuration, containerList) {
  const targets = containerList.containers
    .filter((container) => container.state === "running")
    .slice(0, configuration.statsFanout);
  requireCondition(
    targets.length === configuration.statsFanout,
    "missing_samples",
    `The release profile requires ${configuration.statsFanout} running containers for stats fan-out`,
    {
      requestedFanout: configuration.statsFanout,
      availableTargets: targets.length,
    },
  );
  for (const target of targets) {
    requireCondition(
      /^[a-fA-F0-9]{64}$/u.test(target.id),
      "invalid_container_id",
      "Visible stats target did not have a full immutable container ID",
      { id: target.id },
    );
  }
  const samples = [];
  const wallSamples = [];
  for (let round = 0; round < configuration.statsRounds; round += 1) {
    const started = process.hrtime.bigint();
    const roundSamples = await Promise.all(
      targets.map(async (target, index) => {
        const sample = await timedRequest(
          client,
          "containers.stats",
          { context: configuration.context, id: target.id },
          configuration.requestTimeoutMs,
        );
        const stats = sample.result;
        requireCondition(
          stats?.source === "engine-api" &&
            stats.containerId === target.id &&
            typeof stats.endpointHash === "string" &&
            stats.endpointHash.length > 0 &&
            Number.isFinite(stats.cpuPercent) &&
            Number.isFinite(stats.memoryWorkingSetBytes),
          "invalid_stats_sample",
          "Visible-container stats did not return a matching native sample",
          {
            requestedId: target.id,
            returnedId: stats?.containerId,
            source: stats?.source,
          },
        );
        return {
          round,
          index,
          containerId: target.id,
          latencyMs: sample.latencyMs,
          observedAt: stats.observedAt,
          cpuPercent: rounded(stats.cpuPercent),
          memoryWorkingSetBytes: stats.memoryWorkingSetBytes,
          networkRxBytes: stats.networkRxBytes,
          networkTxBytes: stats.networkTxBytes,
          pids: stats.pids,
        };
      }),
    );
    requireCondition(
      roundSamples.length === targets.length,
      "missing_samples",
      "Concurrent stats fan-out returned an incomplete sample set",
      { round, expected: targets.length, actual: roundSamples.length },
    );
    samples.push(...roundSamples);
    wallSamples.push(rounded(elapsedMilliseconds(started)));
  }
  return {
    requestedFanout: configuration.statsFanout,
    actualFanout: targets.length,
    requestedRounds: configuration.statsRounds,
    actualRounds: wallSamples.length,
    wallLatencyMs: summarize(wallSamples),
    individualLatencyMs: summarize(
      samples.map((sample) => sample.latencyMs),
    ),
    samples,
  };
}

async function runStreamingSoak(client, configuration) {
  const tracker = new SessionTracker(client, configuration.requestTimeoutMs);
  let session;
  try {
    session = await client.request(
      "session.start",
      {
        context: configuration.context,
        argv: ["events", "--format", "{{json .}}"],
        mode: "pipes",
        outputWindowBytes: 256 * 1024,
        maxOutputBytes: SESSION_OUTPUT_LIMIT_BYTES,
      },
      configuration.requestTimeoutMs,
    );
    tracker.bindStartResult(session);
    const soakStartedNs = process.hrtime.bigint();
    const deadlineNs =
      soakStartedNs + BigInt(configuration.soakDurationSeconds) * 1_000_000_000n;
    const rssSamples = [];
    for (;;) {
      client.throwIfFailed();
      rssSamples.push(await readCoreMemory(client.child.pid, soakStartedNs));
      const remainingNs = deadlineNs - process.hrtime.bigint();
      if (remainingNs <= 0n) break;
      const remainingMs = Number(remainingNs) / 1_000_000;
      await tracker.raceDelay(
        Math.max(1, Math.min(configuration.rssIntervalMs, remainingMs)),
      );
    }
    const actualSoakDurationMs = rounded(elapsedMilliseconds(soakStartedNs));
    requireCondition(
      rssSamples.length >= 2,
      "missing_samples",
      "The streaming soak did not collect at least two RSS samples",
      { sampleCount: rssSamples.length },
    );
    requireCondition(
      rssSamples.length <= MAX_RSS_SAMPLES,
      "sample_limit_exceeded",
      "The streaming soak exceeded the bounded RSS sample count",
      { sampleCount: rssSamples.length, maximum: MAX_RSS_SAMPLES },
    );

    const cancelStartedNs = process.hrtime.bigint();
    const cancelResult = await client.request(
      "session.cancel",
      {
        sessionId: session.sessionId,
        gracePeriodMs: configuration.cancelGraceMs,
      },
      configuration.requestTimeoutMs,
    );
    requireCondition(
      cancelResult?.sessionId === session.sessionId &&
        cancelResult.accepted === true &&
        cancelResult.state === "canceling",
      "session_cancel_rejected",
      "Core did not accept cancellation of the docker events session",
      cancelResult,
    );
    const exited = await tracker.waitForExit(
      configuration.cancelGraceMs + configuration.requestTimeoutMs,
    );
    const cancelToExitMs = rounded(
      Number(tracker.exitObservedNs - cancelStartedNs) / 1_000_000,
    );
    requireCondition(
      exited.sessionId === session.sessionId &&
        exited.canceled === true &&
        exited.timedOut === false &&
        exited.output?.truncated === false &&
        exited.output?.droppedBytes === 0,
      "invalid_session_exit",
      "Docker events session did not exit cleanly after explicit cancellation",
      exited,
    );
    requireCondition(
      tracker.ackCount === tracker.outputEvents &&
        tracker.ackedBytes === tracker.outputBytes,
      "missing_session_ack",
      "Not every docker events output sample was acknowledged",
      {
        outputEvents: tracker.outputEvents,
        ackCount: tracker.ackCount,
        outputBytes: tracker.outputBytes,
        ackedBytes: tracker.ackedBytes,
      },
    );
    const rssValues = rssSamples.map((sample) => sample.rssBytes);
    return {
      command: ["docker", "--context", configuration.context, "events"],
      sessionId: session.sessionId,
      requestedDurationSeconds: configuration.soakDurationSeconds,
      actualDurationMs: actualSoakDurationMs,
      sampleSpanMs: rounded(
        rssSamples.at(-1).relativeMs - rssSamples[0].relativeMs,
      ),
      rssIntervalMs: configuration.rssIntervalMs,
      rssBytes: summarize(rssValues),
      rssDeltaBytes: rssValues.at(-1) - rssValues[0],
      rssSamples,
      sessionOutput: {
        events: tracker.outputEvents,
        bytes: tracker.outputBytes,
        acknowledgements: tracker.ackCount,
        acknowledgedBytes: tracker.ackedBytes,
        streams: tracker.streamBytes,
        lastSequence: tracker.lastSequence,
      },
      cancellation: {
        gracePeriodMs: configuration.cancelGraceMs,
        cancelToExitMs,
        result: cancelResult,
        exit: {
          exitCode: exited.exitCode,
          signal: exited.signal ?? null,
          canceled: exited.canceled,
          timedOut: exited.timedOut,
          durationMs: exited.durationMs,
          output: exited.output,
        },
      },
    };
  } catch (error) {
    if (
      session?.sessionId &&
      !tracker.exited &&
      !client.fatalError &&
      client.child.exitCode === null
    ) {
      try {
        await client.request(
          "session.cancel",
          { sessionId: session.sessionId, gracePeriodMs: 0 },
          Math.min(configuration.requestTimeoutMs, 10_000),
        );
        await tracker.waitForExit(10_000);
      } catch {
        // CoreClient.close() is the final bounded process-tree cleanup path.
      }
    }
    throw error;
  } finally {
    tracker.close();
  }
}

async function writeBoundedJSON(path, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  requireCondition(
    Buffer.byteLength(serialized) <= MAX_ARTIFACT_BYTES,
    "artifact_too_large",
    `${path} exceeded the ${MAX_ARTIFACT_BYTES}-byte artifact limit`,
  );
  await mkdir(outputDirectory, { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, serialized, { mode: 0o600 });
  await rename(temporaryPath, path);
}

const runStartedAt = new Date().toISOString();
const runStartedNs = process.hrtime.bigint();
let configuration;
let environment = {
  schemaVersion: 1,
  observedAt: runStartedAt,
  harness: {
    script: "tools/run-performance-evidence.mjs",
    sha256: createHash("sha256")
      .update(await readFile(scriptPath))
      .digest("hex"),
    readOnly: true,
  },
};
let results = {
  schemaVersion: 1,
  status: "running",
  startedAt: runStartedAt,
  readOnly: true,
};
let client = null;
let runError = null;

try {
  configuration = loadConfiguration();
  environment = await collectStaticEnvironment(configuration);
  results.context = configuration.context;
  results.requestedSoakDurationSeconds = configuration.soakDurationSeconds;

  const coldStarted = process.hrtime.bigint();
  client = new CoreClient(configuration.corePath);
  const coldHealth = await client.request(
    "health",
    {},
    configuration.requestTimeoutMs,
  );
  const coldHealthLatencyMs = rounded(elapsedMilliseconds(coldStarted));
  assertHealth(coldHealth, client.child.pid);
  environment.tools.core.runtime = {
    version: coldHealth.version,
    protocolVersion: coldHealth.protocolVersion,
    pid: coldHealth.pid,
    startedAt: coldHealth.startedAt,
    dockerReady: coldHealth.dockerReady,
  };

  const warmHealthSamples = [];
  for (
    let index = 0;
    index < configuration.warmHealthSamples;
    index += 1
  ) {
    const sample = await timedRequest(
      client,
      "health",
      {},
      configuration.requestTimeoutMs,
    );
    assertHealth(sample.result, client.child.pid);
    warmHealthSamples.push({
      index,
      latencyMs: sample.latencyMs,
      observedAt: new Date().toISOString(),
    });
  }
  results.health = {
    cold: {
      latencyMs: coldHealthLatencyMs,
      includesProcessSpawn: true,
      response: coldHealth,
    },
    warm: {
      latencyMs: summarize(
        warmHealthSamples.map((sample) => sample.latencyMs),
      ),
      samples: warmHealthSamples,
    },
  };

  const nativeLists = await measureNativeLists(client, configuration);
  results.nativeLists = nativeLists.measurements;
  results.visibleContainerStats = await measureStatsFanout(
    client,
    configuration,
    nativeLists.latestContainers,
  );
  results.streamingSoak = await runStreamingSoak(client, configuration);
  results.performanceSLO = evaluatePerformanceSLOs(results);
  requireCondition(
    results.performanceSLO.status === "passed",
    "performance_slo_failed",
    `Performance did not satisfy ${RELEASE_PERFORMANCE_PROFILE.id}`,
    {
      failedChecks: results.performanceSLO.checks.filter(
        (check) => check.status !== "passed",
      ),
    },
  );
  results.status = "passed";
} catch (error) {
  runError = error instanceof Error ? error : new Error(String(error));
  results.status = "failed";
  results.error = errorRecord(runError);
} finally {
  if (client) {
    try {
      const exit = await client.close();
      results.coreExit = exit;
      if (
        !runError &&
        (exit?.code !== 0 || exit?.signal !== null)
      ) {
        runError = new EvidenceError(
          "core_cleanup_failed",
          "Core did not exit cleanly after the evidence run",
          exit,
        );
        results.status = "failed";
        results.error = errorRecord(runError);
      }
    } catch (error) {
      if (!runError) runError = error;
      results.status = "failed";
      results.error = errorRecord(runError);
    }
  }
}

results.completedAt = new Date().toISOString();
results.harnessDurationMs = rounded(elapsedMilliseconds(runStartedNs));
environment.completedAt = results.completedAt;

try {
  await Promise.all([
    writeBoundedJSON(environmentPath, environment),
    writeBoundedJSON(resultsPath, results),
  ]);
} catch (error) {
  if (!runError) runError = error;
}

if (runError) {
  process.stderr.write(
    `FAIL: ${runError.code ?? runError.name}: ${runError.message}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `PASS: ${results.streamingSoak.rssSamples.length} RSS samples over ${(
      results.streamingSoak.actualDurationMs / 1_000
    ).toFixed(3)} s; ${results.performanceSLO.checks.length}/${results.performanceSLO.checks.length} release SLO checks; stats fan-out ${results.visibleContainerStats.actualFanout}; cancel-to-exit ${results.streamingSoak.cancellation.cancelToExitMs.toFixed(3)} ms.\n`,
  );
}
