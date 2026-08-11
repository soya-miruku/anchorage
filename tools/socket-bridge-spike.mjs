#!/usr/bin/env node
/**
 * Does a Unix socket, piped byte-for-byte to a TCP Docker endpoint, satisfy the two Engine-API
 * checks that refuse to run over TCP?
 *
 * volumes.files and volumes.fileRead need a directly reachable Unix socket and fail with
 * context_transport_unsupported (core/internal/core/domain.go:1871) over TCP. DinD satisfies
 * that by bind-mounting a socket into the scratch directory; sbx forwards a TCP port and cannot.
 *
 * The Docker API is plain HTTP, so a byte pipe should be transparent. "Should be" is why this
 * exists: if it is not, the sbx matrix loses two checks and the backend is not worth building.
 *
 * VERDICT (2026-08-11, host Docker 29.7.2, DinD 29.7.1, two runs): GO for the transport hop,
 * and only for that hop.
 *
 * Driven by the core against a bridged socket, both checks return what they return against a
 * bind-mounted one: same entries, same 900,000-byte payload digest, same `exec` listing
 * instrument — so the hijacked /exec/{id}/start stream survives the pipe, not just the plain
 * archive read. The same core over the same daemon's TCP port refuses all five probes with
 * context_transport_unsupported, and stopping the bridge turns the bridged context into
 * engine_unreachable, so the pipe is what carried them.
 *
 * NOT PROVEN — no part of this touched sbx. sbx v0.38.0 is installed here, but sandboxd is not
 * running and the CLI is not signed in to Docker, and authenticating was out of scope for the
 * task that produced this. The TCP endpoint measured was a published DinD port. What remains
 * open is whether an sbx port-forward is the same transparent byte pipe a published port is;
 * a forward that buffers, that reaps idle connections, or that cannot carry a hijacked stream
 * would fail where this succeeded, and nothing here would have caught it.
 *
 * Also untested, and cheaper than this whole file if it works: whether a Unix socket created
 * inside an sbx bind-mounted workspace is connectable from the host, which would remove the need
 * for a bridge entirely. That depends on whether the workspace mount is a real bind mount or a
 * virtiofs/9p share, and it was not measured either.
 */
import { connect, createServer } from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "..");
// sockaddr_un.sun_path on Linux. This worktree's own path is already 141 bytes, so a socket
// placed beside the evidence tree cannot be bound at all — the scratch root for this spike is
// short by necessity, not by preference, and the same limit will bind any sbx bridge.
const SUN_PATH_MAX = 108;
// Large enough to cross many read() boundaries and Docker's own chunking, small enough to stay
// under the core's 1 MiB maxFileReadBytes so the payload is compared whole rather than truncated.
const LARGE_FILE_BYTES = 900_000;
// Enough entries that the listing's per-entry `HEAD /archive` stats (fan-out 16) run genuinely
// concurrently over the transport, which a two-entry directory never does.
const FANOUT_ENTRIES = 250;

function assertSocketPathFits(socketPath) {
  const bytes = Buffer.byteLength(socketPath);
  if (bytes >= SUN_PATH_MAX) {
    throw new Error(
      `Socket path is ${bytes} bytes; the kernel accepts at most ${SUN_PATH_MAX - 1}: ${socketPath}`,
    );
  }
}

/**
 * The bridge itself: one Unix socket, one TCP endpoint, nothing in between.
 *
 * Half-open is allowed on both ends because the Engine's hijacked streams (exec, attach) end by
 * closing one direction while the other stays live. Node's default would tear the peer down on
 * the first FIN, which would truncate exactly the responses this spike exists to carry.
 *
 * The byte counters are not instrumentation for its own sake. Without them "the checks passed
 * through the bridge" rests on the socket path alone, and a spike that cannot show its own
 * traffic is one misconfiguration away from measuring the direct socket twice.
 */
function startBridge({ socketPath, host, port }) {
  assertSocketPathFits(socketPath);
  const stats = { connections: 0, bytesToUpstream: 0, bytesFromUpstream: 0 };
  const server = createServer({ allowHalfOpen: true }, (client) => {
    stats.connections += 1;
    const upstream = connect({ host, port, allowHalfOpen: true });
    client.on("data", (chunk) => {
      stats.bytesToUpstream += chunk.length;
    });
    upstream.on("data", (chunk) => {
      stats.bytesFromUpstream += chunk.length;
    });
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", drop);
    upstream.on("error", drop);
  });
  return new Promise((ready, failed) => {
    server.once("error", failed);
    server.listen(socketPath, () => ready({ server, stats }));
  });
}

function runProcess(executable, args, { input = "", timeoutMs = 60_000 } = {}) {
  return new Promise((settle, failed) => {
    const child = spawn(executable, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      failed(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({
        code,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(input);
  });
}

async function docker(args, options) {
  const result = await runProcess("docker", args, options);
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`docker ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// The core speaks newline-delimited JSON on stdio. Trimmed to what a spike needs: no events, no
// session plumbing, same request envelope as tools/run-core-acceptance.mjs.
class CoreClient {
  constructor(path, allowedCWD) {
    this.child = spawn(path, ["--allow-cwd", allowedCWD], {
      cwd: allowedCWD,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = "";
    this.stderr = "";
    this.pending = new Map();
    this.counter = 0;
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-64 * 1024);
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(`core exited (code=${code}, signal=${signal}): ${this.stderr}`);
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
      if (!message.id) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        const error = new Error(`${message.error.code ?? "core_error"}: ${message.error.message}`);
        error.code = message.error.code ?? "core_error";
        error.details = message.error.details;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
    }
  }

  request(method, params, timeoutMs = 120_000) {
    const id = `spike-${++this.counter}`;
    return new Promise((settle, failed) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        failed(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: settle, reject: failed, timeout });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((done) => {
      const killTimer = setTimeout(() => this.child.kill("SIGKILL"), 10_000);
      this.child.once("exit", () => {
        clearTimeout(killTimer);
        done();
      });
      this.child.stdin.end();
    });
  }
}

/**
 * The decisive measurement: the two checks, issued by the core, against one context.
 *
 * The requests and the predicate are the acceptance harness's, copied from
 * tools/run-core-acceptance.mjs:3143-3228 rather than paraphrased, because a weaker assertion
 * here would answer a weaker question than the one that gates the backend. The fan-out listing
 * and the large read are additional load on the same two methods, not substitutes for them.
 *
 * Each context gets its own core process. The core parks a volume helper for 90s keyed by
 * volume and mount mode, and `takeVolumeHelper` will hand a helper created over one transport to
 * a request arriving over another as long as both reach the same daemon — so a shared core would
 * let the bridged run inherit a container the direct socket built, and the bridge's own
 * container-create path would go unmeasured.
 */
async function browseThrough(corePath, scratch, contextName, volume, marker, largeDigest) {
  const client = new CoreClient(corePath, scratch);
  try {
    const attempt = async (label, run) => {
      try {
        return { ok: true, label, value: await run() };
      } catch (error) {
        return {
          ok: false,
          label,
          error: {
            code: error.code ?? "core_error",
            message: error.message,
            details: error.details ?? null,
          },
        };
      }
    };
    const files = (path) =>
      attempt(`volumes.files ${path}`, () =>
        client.request("volumes.files", { context: contextName, name: volume, path }),
      );
    const read = (path) =>
      attempt(`volumes.fileRead ${path}`, () =>
        client.request("volumes.fileRead", { context: contextName, name: volume, path }),
      );

    const root = await files("/");
    const nested = await files("/nested");
    const fileRead = await read("/nested/anchorage.txt");
    const fanout = await files("/many");
    const large = await read("/large/big.txt");
    const steps = [root, nested, fileRead, fanout, large];
    const failures = steps.filter((step) => !step.ok);
    if (failures.length > 0) {
      return {
        context: contextName,
        passed: false,
        failures: failures.map((step) => ({ label: step.label, error: step.error })),
      };
    }

    const rootListing = root.value;
    const nestedListing = nested.value;
    const readResult = fileRead.value;
    const fanoutListing = fanout.value;
    const largeResult = large.value;
    const nestedEntry = rootListing.entries.find((entry) => entry.name === "nested");
    const seededEntry = nestedListing.entries.find((entry) => entry.name === "anchorage.txt");
    // Verbatim from the harness's volume-file-browse predicate.
    const harnessPredicate =
      rootListing.source === "engine-api" &&
      rootListing.path === "/" &&
      Boolean(nestedEntry) &&
      nestedEntry.isDir &&
      nestedEntry.path === "/nested" &&
      nestedListing.path === "/nested" &&
      Boolean(seededEntry) &&
      !seededEntry.isDir &&
      seededEntry.path === "/nested/anchorage.txt" &&
      readResult.path === "/nested/anchorage.txt" &&
      readResult.encoding === "utf-8" &&
      readResult.content.trim() === marker &&
      readResult.sizeBytes === marker.length + 1 &&
      !readResult.truncated;
    const fanoutHeld =
      fanoutListing.entries.length === FANOUT_ENTRIES && !fanoutListing.truncated;
    const largeHeld =
      largeResult.sizeBytes === LARGE_FILE_BYTES &&
      !largeResult.truncated &&
      sha256(largeResult.content) === largeDigest;

    return {
      context: contextName,
      passed: harnessPredicate && fanoutHeld && largeHeld,
      harnessPredicate,
      fanoutHeld,
      largeHeld,
      failures: [],
      listing: {
        root: rootListing.listing,
        nested: nestedListing.listing,
        fanout: fanoutListing.listing,
      },
      rootEntries: rootListing.entries.map((entry) => entry.path).sort(),
      nestedEntries: nestedListing.entries.map((entry) => entry.path).sort(),
      fanoutDigest: sha256(
        JSON.stringify(fanoutListing.entries.map((entry) => entry.path).sort()),
      ),
      fanoutCount: fanoutListing.entries.length,
      read: {
        path: readResult.path,
        sizeBytes: readResult.sizeBytes,
        encoding: readResult.encoding,
        content: readResult.content,
        truncated: readResult.truncated,
      },
      large: {
        path: largeResult.path,
        sizeBytes: largeResult.sizeBytes,
        encoding: largeResult.encoding,
        truncated: largeResult.truncated,
        contentDigest: sha256(largeResult.content),
      },
      raw: { root: rootListing, nested: nestedListing, read: readResult },
    };
  } finally {
    await client.close();
  }
}

async function runVerdict(scratchRoot) {
  const suffix = randomUUID().slice(0, 8);
  const scratch = resolve(scratchRoot, `anch-spike-${suffix}`);
  const engineDirectory = resolve(scratch, "engine");
  const bridgeDirectory = resolve(scratch, "bridge");
  const directSocket = resolve(engineDirectory, "docker.sock");
  const bridgeSocket = resolve(bridgeDirectory, "docker.sock");
  assertSocketPathFits(directSocket);
  assertSocketPathFits(bridgeSocket);

  const containerName = `anchorage-spike-${suffix}`;
  const tcpContext = `anchorage-spike-tcp-${suffix}`;
  const directContext = `anchorage-spike-sock-${suffix}`;
  const bridgeContext = `anchorage-spike-brdg-${suffix}`;
  const volume = `anchorage_browse_${suffix}`;
  const marker = `ANCHORAGE_VOLUME_${suffix}`;
  const largeDigest = sha256("A".repeat(LARGE_FILE_BYTES));
  const token = randomUUID();
  const corePath = resolve(workspaceRoot, "core/bin/anchorage-core");

  const teardown = [];
  let failure = null;
  const report = { suffix, scratch, directSocket, bridgeSocket, corePath, steps: [] };
  const note = (message) => {
    report.steps.push(message);
    console.error(`[spike] ${message}`);
  };

  try {
    await mkdir(engineDirectory, { recursive: true, mode: 0o700 });
    await mkdir(bridgeDirectory, { recursive: true, mode: 0o700 });
    teardown.push(async () => rm(scratch, { recursive: true, force: true }));

    // Launched exactly as tools/run-core-acceptance.mjs launches its DinD, so the control is the
    // harness's own arrangement rather than a friendlier one: privileged, self-removing, serving
    // the same daemon on a published TCP port and on a bind-mounted Unix socket at once.
    await docker(
      [
        "run",
        "--detach",
        "--rm",
        "--privileged",
        "--name",
        containerName,
        "--label",
        `io.anchorage.spike=${token}`,
        "--env",
        "DOCKER_TLS_CERTDIR=",
        "--publish",
        "127.0.0.1::2375",
        "--volume",
        `${engineDirectory}:/anchorage-socket`,
        "docker:29-dind",
        "--storage-driver=vfs",
        "--host=unix:///var/run/docker.sock",
        "--host=tcp://0.0.0.0:2375",
        "--host=unix:///anchorage-socket/docker.sock",
        `--group=${process.getgid()}`,
      ],
      { timeoutMs: 180_000 },
    );
    teardown.push(async () => {
      await runProcess("docker", ["rm", "--force", containerName], { timeoutMs: 60_000 });
    });
    note(`launched ${containerName}`);

    const published = await docker(["container", "port", containerName, "2375/tcp"]);
    const portMatch = published.match(/127\.0\.0\.1:(\d+)/u);
    if (!portMatch) throw new Error(`no published port: ${published}`);
    const port = Number(portMatch[1]);
    report.tcpEndpoint = `tcp://127.0.0.1:${port}`;

    for (const [name, host] of [
      [tcpContext, `tcp://127.0.0.1:${port}`],
      [directContext, `unix://${directSocket}`],
      [bridgeContext, `unix://${bridgeSocket}`],
    ]) {
      await docker(["context", "create", "--docker", `host=${host}`, name]);
      teardown.push(async () => {
        await runProcess("docker", ["context", "rm", "--force", name], { timeoutMs: 30_000 });
      });
    }
    note(`contexts: ${tcpContext} / ${directContext} / ${bridgeContext}`);

    let serverVersion = "";
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const probe = await runProcess(
        "docker",
        ["--context", tcpContext, "version", "--format", "{{.Server.Version}}"],
        { timeoutMs: 15_000 },
      );
      if (probe.code === 0 && probe.stdout.trim()) {
        serverVersion = probe.stdout.trim();
        break;
      }
      await wait(1_000);
    }
    if (!serverVersion) throw new Error("DinD daemon never answered on its TCP endpoint");
    report.dindServerVersion = serverVersion;
    note(`dind server ${serverVersion}`);

    // The bridge runs as its own process, invoked through this file's own `bridge` subcommand,
    // so what is measured is the artifact a backend would ship rather than an in-process
    // approximation of it.
    const bridge = spawn(
      process.execPath,
      [scriptPath, "bridge", `127.0.0.1:${port}`, bridgeSocket],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let bridgeOutput = "";
    bridge.stdout.setEncoding("utf8");
    bridge.stdout.on("data", (chunk) => {
      bridgeOutput += chunk;
    });
    const bridgeExited = new Promise((done) => bridge.once("exit", done));
    let bridgeStopped = false;
    // SIGTERM rather than SIGKILL: the bridge reports its byte counters on the way out, and
    // those counters are the evidence that the traffic went through it.
    const stopBridge = async () => {
      if (bridgeStopped) return;
      bridgeStopped = true;
      bridge.kill("SIGTERM");
      await Promise.race([bridgeExited, wait(5_000)]);
      const line = bridgeOutput.split("\n").find((entry) => entry.startsWith("bridge-stats "));
      report.bridgeStats = line ? JSON.parse(line.slice("bridge-stats ".length)) : null;
    };
    teardown.push(stopBridge);
    await new Promise((ready, failed) => {
      const timer = setTimeout(() => failed(new Error("bridge did not report ready")), 15_000);
      const check = () => {
        if (!bridgeOutput.includes("bridge-ready")) return;
        clearTimeout(timer);
        bridge.stdout.off("data", check);
        ready();
      };
      bridge.stdout.on("data", check);
      bridge.once("exit", (code) => {
        clearTimeout(timer);
        failed(new Error(`bridge exited early (${code})`));
      });
      check();
    });
    note(`bridge unix://${bridgeSocket} -> tcp://127.0.0.1:${port}`);

    // Supporting, not decisive: it only shows the CLI can talk through the pipe at all.
    report.bridgedCliServerVersion = (
      await docker(["--context", bridgeContext, "version", "--format", "{{.Server.Version}}"])
    ).trim();

    await docker(["--context", tcpContext, "pull", "alpine:3.20"], { timeoutMs: 300_000 });
    await docker(["--context", tcpContext, "volume", "create", volume]);
    await docker(
      [
        "--context",
        tcpContext,
        "run",
        "--rm",
        "--volume",
        `${volume}:/data`,
        "alpine:3.20",
        "sh",
        "-c",
        [
          "mkdir -p /data/nested /data/large /data/many",
          `printf '%s\\n' ${marker} > /data/nested/anchorage.txt`,
          // Built a kilobyte at a time and printed with no trailing newline, so the file is
          // exactly LARGE_FILE_BYTES of 'A' and the host can predict its digest without
          // reading it back. `yes A | head -c` would have been half As and half newlines.
          `awk 'BEGIN{s="";for(j=0;j<1000;j++)s=s "A";` +
            `for(i=0;i<${LARGE_FILE_BYTES / 1000};i++)printf "%s",s}' > /data/large/big.txt`,
          `awk 'BEGIN{for(i=0;i<${FANOUT_ENTRIES};i++) printf "%04d\\n", i}' | ` +
            "while read n; do echo $n > /data/many/f$n.txt; done",
        ].join(" && "),
      ],
      { timeoutMs: 180_000 },
    );
    teardown.push(async () => {
      await runProcess("docker", ["--context", tcpContext, "volume", "rm", "--force", volume], {
        timeoutMs: 60_000,
      });
    });
    note(`seeded volume ${volume}`);

    // Order matters: the negative control first, so a bridge result cannot be a stale cache of a
    // direct one, and the direct control before the bridge so the comparison is against a fresh
    // measurement of the same daemon and the same volume.
    report.tcp = await browseThrough(corePath, scratch, tcpContext, volume, marker, largeDigest);
    note(`tcp: ${report.tcp.passed ? "passed" : "refused"}`);
    report.direct = await browseThrough(
      corePath,
      scratch,
      directContext,
      volume,
      marker,
      largeDigest,
    );
    note(`direct socket: ${report.direct.passed ? "passed" : "failed"}`);
    report.bridge = await browseThrough(
      corePath,
      scratch,
      bridgeContext,
      volume,
      marker,
      largeDigest,
    );
    note(`bridged socket: ${report.bridge.passed ? "passed" : "failed"}`);

    // Exclusivity control. Everything above would read the same if the "bridge" socket were
    // secretly the daemon's own — a stray bind-mount, a symlink, a copied path. Stop the bridge
    // and the bridged context must stop working; if it still answers, the run measured the
    // direct socket twice and proves nothing about a pipe.
    await stopBridge();
    report.bridgeAbsent = await browseThrough(
      corePath,
      scratch,
      bridgeContext,
      volume,
      marker,
      largeDigest,
    );
    note(`bridge stopped: ${report.bridgeAbsent.passed ? "STILL PASSED (bad)" : "refused"}`);

    // A helper left running holds a reference on the volume it mounted, so this is checked the
    // way the harness checks it: after the reads, by label, against the daemon itself.
    report.leakedHelpers = (
      await docker([
        "--context",
        tcpContext,
        "container",
        "ls",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        "label=io.anchorage.helper=volume-browse",
      ])
    )
      .split("\n")
      .filter((line) => line.trim().length > 0);
  } catch (error) {
    failure = error;
  } finally {
    for (const step of teardown.reverse()) {
      try {
        await step();
      } catch (error) {
        report.steps.push(`teardown error: ${error.message}`);
      }
    }
  }

  if (failure) {
    report.error = failure.message;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  const sameJSON = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const bridgeMatchesDirect =
    report.direct.passed &&
    report.bridge.passed &&
    sameJSON(report.direct.rootEntries, report.bridge.rootEntries) &&
    sameJSON(report.direct.nestedEntries, report.bridge.nestedEntries) &&
    report.direct.fanoutDigest === report.bridge.fanoutDigest &&
    report.direct.read.content === report.bridge.read.content &&
    report.direct.read.sizeBytes === report.bridge.read.sizeBytes &&
    report.direct.large.contentDigest === report.bridge.large.contentDigest &&
    // The listing instrument must match too. An `exec` control against an `archive` bridge would
    // mean the hijacked stream did not survive the pipe, and the fallback quietly covered it.
    sameJSON(report.direct.listing, report.bridge.listing);
  const carriedRealTraffic =
    Boolean(report.bridgeStats) &&
    report.bridgeStats.bytesFromUpstream > LARGE_FILE_BYTES &&
    report.bridgeStats.connections > 1 &&
    // The bridged context must die with the bridge; see the exclusivity control above.
    !report.bridgeAbsent.passed;
  report.verdict = {
    tcpRefused:
      !report.tcp.passed &&
      report.tcp.failures.length > 0 &&
      report.tcp.failures.every((step) => step.error.code === "context_transport_unsupported"),
    directPassed: report.direct.passed,
    bridgePassed: report.bridge.passed,
    bridgeMatchesDirect,
    bridgeCarriedTheTraffic: carriedRealTraffic,
    bridgedContextDiesWithTheBridge: !report.bridgeAbsent.passed,
    noLeakedHelpers: report.leakedHelpers.length === 0,
    goNoGo: bridgeMatchesDirect && carriedRealTraffic ? "GO" : "NO-GO",
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict.goNoGo !== "GO") process.exitCode = 1;
}

const [, , mode, ...rest] = process.argv;
if (mode === "bridge") {
  const [target, socketPath] = rest;
  if (!target || !socketPath) {
    console.error("usage: node tools/socket-bridge-spike.mjs bridge <host:port> <socket-path>");
    process.exit(64);
  }
  const [host, port] = target.split(":");
  await rm(socketPath, { force: true });
  const { server, stats } = await startBridge({ socketPath, host, port: Number(port) });
  console.log(`bridge-ready unix://${socketPath} -> tcp://${target}`);
  const report = () => {
    console.log(`bridge-stats ${JSON.stringify(stats)}`);
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", report);
  process.on("SIGINT", report);
} else if (mode === "verdict") {
  // Not artifacts/docker: this worktree's own path is 141 bytes, and a socket under it cannot be
  // bound at all. The scratch root is overridable so the spike is not tied to one machine's /tmp.
  await runVerdict(rest[0] ?? process.env.ANCHORAGE_SPIKE_ROOT ?? "/tmp");
} else {
  console.error("usage: node tools/socket-bridge-spike.mjs bridge <host:port> <socket-path>");
  console.error("       node tools/socket-bridge-spike.mjs verdict [scratch-root]");
  process.exit(64);
}
