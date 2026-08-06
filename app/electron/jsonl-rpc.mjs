import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

import { normalizeRpcError } from "./contracts.mjs";

export const MAX_RPC_LINE_BYTES = 8 * 1_024 * 1_024;

function makeError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export class JsonLineRpcClient extends EventEmitter {
  #child = null;
  #counter = 0;
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #bufferBytes = 0;
  #pending = new Map();
  #maximumLineBytes;
  #defaultTimeoutMs;
  #closed = false;

  constructor({ maximumLineBytes = MAX_RPC_LINE_BYTES, defaultTimeoutMs = 30_000 } = {}) {
    super();
    this.#maximumLineBytes = maximumLineBytes;
    this.#defaultTimeoutMs = defaultTimeoutMs;
  }

  attach(child) {
    if (this.#child) {
      throw makeError("RPC_ALREADY_ATTACHED", "The RPC client already has a core process");
    }
    if (!child?.stdin || !child?.stdout) {
      throw makeError("RPC_INVALID_PROCESS", "The core process must expose stdin and stdout");
    }

    this.#child = child;
    this.#closed = false;
    child.stdout.on("data", (chunk) => this.#onData(chunk));
    child.stdout.on("end", () => this.#onStreamEnd());
    child.stdin.on("error", (error) => this.#close("CORE_STDIN_ERROR", error.message, error));
  }

  async request(method, params, { timeoutMs } = {}) {
    /*
     * Dot-separated segments, each starting lowercase, camelCase within a segment.
     *
     * This pattern was `[a-z][a-z0-9]*`, which rejected every camelCase verb in the protocol —
     * eight of the fifty-two, silently, at the transport rather than at any boundary that
     * explains itself. `containers.statsBatch`, both file reads and both file writes,
     * `containers.rebindPorts`, `system.pluginAction` and `builds.builderAction` all reached
     * this line and were refused as malformed names, having passed the renderer allowlist, the
     * preload switch, the IPC channel map and the schema on the way. The core accepts every one
     * of them; nothing downstream was wrong.
     *
     * Nothing caught it because the lockstep test compares the schema against the renderer
     * allowlist and never asks whether the transport would carry what both agreed on. It does
     * now — see "every protocol method survives the RPC transport" in protocol-contract.test.mjs.
     */
    if (
      typeof method !== "string" ||
      method.length === 0 ||
      method.length > 128 ||
      !/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/u.test(method)
    ) {
      throw makeError("RPC_INVALID_METHOD", "The RPC method name is invalid");
    }
    if (!this.#child || this.#closed || this.#child.stdin.destroyed) {
      throw makeError("CORE_UNAVAILABLE", "The Anchorage core is not available");
    }

    const id = String(++this.#counter);
    const envelope = params === undefined ? { id, method } : { id, method, params };
    const serialized = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(serialized) > this.#maximumLineBytes) {
      throw makeError("RPC_REQUEST_TOO_LARGE", "The core request exceeds the maximum line size");
    }

    const effectiveTimeout = timeoutMs ?? this.#defaultTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer =
        effectiveTimeout > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              // Tell the core to stop: otherwise a request we have already given up on runs
              // to completion, holding a goroutine, an Engine connection and any docker
              // subprocess it started.
              this.#cancelRemote(id);
              reject(makeError("CORE_TIMEOUT", `The core did not answer ${method} in time`));
            }, effectiveTimeout)
          : null;
      timer?.unref?.();

      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(serialized, "utf8", (error) => {
        if (!error) {
          return;
        }
        const pending = this.#pending.get(id);
        if (!pending) {
          return;
        }
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        reject(makeError("CORE_WRITE_FAILED", "Could not write to the Anchorage core", error));
      });
    });
  }

  /**
   * Best-effort abandonment of an in-flight request. Fire-and-forget: the core answers
   * request.cancel with its own id, which has no pending entry, so the reply is ignored.
   */
  #cancelRemote(targetId) {
    if (!this.#child || this.#closed || this.#child.stdin.destroyed) {
      return;
    }
    const id = String(++this.#counter);
    try {
      this.#child.stdin.write(
        `${JSON.stringify({ id, method: "request.cancel", params: { targetId } })}\n`,
        "utf8",
        () => {},
      );
    } catch {
      // The core is going away anyway; nothing to reclaim.
    }
  }

  close(code = "CORE_STOPPED", message = "The Anchorage core stopped") {
    this.#close(code, message);
  }

  #onData(chunk) {
    if (this.#closed) {
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    this.#bufferBytes += bytes;
    if (this.#bufferBytes > this.#maximumLineBytes) {
      const child = this.#child;
      this.emit(
        "protocol-error",
        makeError("RPC_LINE_TOO_LARGE", "The core emitted a line larger than the protocol limit"),
      );
      this.#close("RPC_LINE_TOO_LARGE", "The core emitted an oversized protocol line");
      child?.kill?.("SIGTERM");
      return;
    }

    this.#buffer += this.#decoder.write(chunk);

    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      this.#bufferBytes = Buffer.byteLength(this.#buffer);

      if (line.length > 0) {
        this.#onLine(line);
      }
      newlineIndex = this.#buffer.indexOf("\n");
    }
  }

  #onStreamEnd() {
    if (this.#closed) {
      return;
    }
    const remainder = this.#buffer + this.#decoder.end();
    this.#buffer = "";
    this.#bufferBytes = 0;
    if (remainder.trim().length > 0) {
      this.emit(
        "protocol-error",
        makeError("RPC_TRUNCATED_LINE", "The core closed stdout with a partial JSON line"),
      );
    }
  }

  #onLine(line) {
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch (error) {
      this.emit(
        "protocol-error",
        makeError("RPC_INVALID_JSON", "The core emitted invalid JSON", error),
      );
      return;
    }

    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
      this.emit(
        "protocol-error",
        makeError("RPC_INVALID_ENVELOPE", "The core emitted an invalid protocol envelope"),
      );
      return;
    }

    if (typeof envelope.event === "string" && !Object.hasOwn(envelope, "id")) {
      this.emit("notification", envelope.event, envelope.payload);
      return;
    }

    const id = typeof envelope.id === "number" ? String(envelope.id) : envelope.id;
    if (typeof id !== "string") {
      this.emit(
        "protocol-error",
        makeError("RPC_INVALID_ENVELOPE", "The core response did not include a request id"),
      );
      return;
    }

    const pending = this.#pending.get(id);
    if (!pending) {
      this.emit(
        "protocol-error",
        makeError("RPC_UNKNOWN_ID", `The core answered unknown request id ${id.slice(0, 128)}`),
      );
      return;
    }

    this.#pending.delete(id);
    clearTimeout(pending.timer);

    if (Object.hasOwn(envelope, "error")) {
      const normalized = normalizeRpcError(envelope.error);
      const error = makeError(normalized.code, normalized.message);
      if (normalized.details !== undefined) {
        error.details = normalized.details;
      }
      pending.reject(error);
      return;
    }

    pending.resolve(envelope.result);
  }

  #close(code, message, cause) {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const error = makeError(code, message, cause);
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
    this.#child = null;
    this.emit("closed", error);
  }
}
