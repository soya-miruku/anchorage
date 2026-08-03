import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

import { JsonLineRpcClient } from "./jsonl-rpc.mjs";
import { RedactedLogTail } from "./redaction.mjs";

const MAX_STDERR_BUFFER_BYTES = 32_768;
const RESTART_DELAYS_MS = [250, 1_000, 2_500, 5_000, 10_000, 30_000];

function publicError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "CORE_ERROR",
    message: typeof error?.message === "string" ? error.message.slice(0, 4_096) : "Core error",
  };
}

function createCoreEnvironment(source) {
  const allowedExact = new Set([
    "APPDATA",
    "COMSPEC",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "SSH_AUTH_SOCK",
    "SYSTEMROOT",
    "TMPDIR",
    "TMP",
    "TEMP",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
  ]);

  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      typeof value === "string" &&
      (allowedExact.has(key.toUpperCase()) || key.toUpperCase().startsWith("DOCKER_"))
    ) {
      result[key] = value;
    }
  }
  return result;
}

export class CoreSupervisor extends EventEmitter {
  #binaryPath;
  #args;
  #cwd;
  #spawn;
  #sourceEnvironment;
  #restartDelaysMs;
  #child = null;
  #rpc = null;
  #restartTimer = null;
  #restartAttempt = 0;
  #stabilityTimer = null;
  #stopping = false;
  #stderrDecoder = new StringDecoder("utf8");
  #stderrBuffer = "";
  #stderrBufferBytes = 0;
  #logTail = new RedactedLogTail();

  constructor({
    binaryPath,
    args = [],
    cwd,
    spawn = nodeSpawn,
    environment = process.env,
    restartDelaysMs = RESTART_DELAYS_MS,
  }) {
    if (
      !Array.isArray(args) ||
      args.some((argument) => typeof argument !== "string" || argument.includes("\u0000"))
    ) {
      throw new TypeError("Core process arguments must be NUL-free strings");
    }
    if (cwd !== undefined && (typeof cwd !== "string" || cwd.includes("\u0000"))) {
      throw new TypeError("Core process cwd must be a NUL-free string");
    }
    if (
      !Array.isArray(restartDelaysMs) ||
      restartDelaysMs.length === 0 ||
      restartDelaysMs.some(
        (delay) => !Number.isInteger(delay) || delay < 0 || delay > 300_000,
      )
    ) {
      throw new TypeError("Core restart delays must be bounded non-negative integers");
    }
    super();
    this.#binaryPath = binaryPath;
    this.#args = Object.freeze([...args]);
    this.#cwd = cwd;
    this.#spawn = spawn;
    this.#sourceEnvironment = environment;
    this.#restartDelaysMs = Object.freeze([...restartDelaysMs]);
  }

  get running() {
    return Boolean(this.#child && this.#rpc);
  }

  start() {
    if (this.#stopping || this.#child || this.#restartTimer) {
      return;
    }
    this.#spawnCore();
  }

  request(method, params, options) {
    if (!this.#rpc) {
      const error = new Error("The Anchorage core is not available");
      error.code = "CORE_UNAVAILABLE";
      return Promise.reject(error);
    }
    return this.#rpc.request(method, params, options);
  }

  async stop({ gracePeriodMs = 2_000 } = {}) {
    this.#stopping = true;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    clearTimeout(this.#stabilityTimer);
    this.#stabilityTimer = null;

    const child = this.#child;
    this.#child = null;
    this.#rpc?.close("CORE_STOPPED", "The Anchorage desktop app is shutting down");
    this.#rpc = null;

    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      let killTimer = null;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };

      child.once("exit", finish);
      child.kill("SIGTERM");

      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        finish();
      }, gracePeriodMs);
      killTimer.unref?.();
    });
  }

  #spawnCore() {
    this.emit("status", {
      state: this.#restartAttempt === 0 ? "starting" : "restarting",
      attempt: this.#restartAttempt,
    });

    let child;
    try {
      child = this.#spawn(this.#binaryPath, this.#args, {
        cwd: this.#cwd,
        env: createCoreEnvironment(this.#sourceEnvironment),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.#handleSpawnFailure(error);
      return;
    }

    this.#child = child;
    this.#logTail.clear();
    this.#stderrBuffer = "";
    this.#stderrBufferBytes = 0;
    this.#stderrDecoder = new StringDecoder("utf8");

    const rpc = new JsonLineRpcClient();
    this.#rpc = rpc;
    rpc.attach(child);
    rpc.on("notification", (event, payload) => this.emit("notification", event, payload));
    rpc.on("protocol-error", (error) => {
      this.emit("status", { state: "protocol-error", error: publicError(error) });
    });

    child.stderr.on("data", (chunk) => this.#onStderr(chunk));
    child.stderr.on("end", () => this.#flushStderr());
    child.once("spawn", () => {
      this.emit("status", { state: "handshaking", pid: child.pid });
      void rpc
        .request("health", {}, { timeoutMs: 5_000 })
        .then((health) => {
          if (
            this.#child !== child ||
            !health ||
            health.status !== "ok" ||
            health.protocolVersion !== "1"
          ) {
            const error = new Error("The Anchorage core protocol handshake was incompatible");
            error.code = "CORE_PROTOCOL_MISMATCH";
            throw error;
          }

          this.emit("status", { state: "ready", pid: child.pid, health });
          clearTimeout(this.#stabilityTimer);
          this.#stabilityTimer = setTimeout(() => {
            if (this.#child === child) {
              this.#restartAttempt = 0;
            }
          }, 30_000);
          this.#stabilityTimer.unref?.();
        })
        .catch((error) => {
          if (this.#child !== child) {
            return;
          }
          this.emit("status", { state: "incompatible", error: publicError(error) });
          child.kill("SIGTERM");
        });
    });
    child.once("error", (error) => this.#onChildError(child, error));
    child.once("exit", (code, signal) => this.#onChildExit(child, code, signal));
  }

  #handleSpawnFailure(error) {
    this.emit("status", { state: "unavailable", error: publicError(error) });
    this.#scheduleRestart();
  }

  #onChildError(child, error) {
    if (child !== this.#child) {
      return;
    }
    clearTimeout(this.#stabilityTimer);
    this.#stabilityTimer = null;
    this.#flushStderr();
    this.#child = null;
    this.#rpc?.close("CORE_UNAVAILABLE", "The Anchorage core could not be started");
    this.#rpc = null;
    this.emit("status", { state: "unavailable", error: publicError(error) });
    if (!this.#stopping) {
      this.#scheduleRestart();
    }
  }

  #onChildExit(child, code, signal) {
    if (child !== this.#child) {
      return;
    }

    this.#flushStderr();
    clearTimeout(this.#stabilityTimer);
    this.#stabilityTimer = null;
    this.#child = null;
    this.#rpc?.close(
      "CORE_CRASHED",
      `The Anchorage core exited${code === null ? "" : ` with code ${code}`}`,
    );
    this.#rpc = null;

    const status = {
      state: this.#stopping ? "stopped" : "crashed",
      code,
      signal,
      stderrTail: this.#logTail.snapshot(),
    };
    this.emit("status", status);

    if (!this.#stopping) {
      this.#scheduleRestart();
    }
  }

  #scheduleRestart() {
    if (this.#stopping || this.#restartTimer) {
      return;
    }

    const index = Math.min(this.#restartAttempt, this.#restartDelaysMs.length - 1);
    const delayMs = this.#restartDelaysMs[index];
    this.#restartAttempt += 1;
    this.emit("status", { state: "restart-scheduled", attempt: this.#restartAttempt, delayMs });

    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      this.#spawnCore();
    }, delayMs);
    this.#restartTimer.unref?.();
  }

  #onStderr(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    this.#stderrBufferBytes += bytes;
    if (this.#stderrBufferBytes > MAX_STDERR_BUFFER_BYTES) {
      const redacted = this.#logTail.push("[stderr line exceeded buffer limit]");
      console.error(`[anchorage-core] ${redacted}`);
      this.#stderrBuffer = "";
      this.#stderrBufferBytes = 0;
      this.#stderrDecoder = new StringDecoder("utf8");
      return;
    }

    this.#stderrBuffer += this.#stderrDecoder.write(chunk);
    let newlineIndex = this.#stderrBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#stderrBuffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.#stderrBuffer = this.#stderrBuffer.slice(newlineIndex + 1);
      this.#stderrBufferBytes = Buffer.byteLength(this.#stderrBuffer);
      const redacted = this.#logTail.push(line);
      console.error(`[anchorage-core] ${redacted}`);
      newlineIndex = this.#stderrBuffer.indexOf("\n");
    }
  }

  #flushStderr() {
    const remainder = this.#stderrBuffer + this.#stderrDecoder.end();
    this.#stderrBuffer = "";
    this.#stderrBufferBytes = 0;
    if (remainder.length > 0) {
      const redacted = this.#logTail.push(remainder);
      console.error(`[anchorage-core] ${redacted}`);
    }
  }
}
