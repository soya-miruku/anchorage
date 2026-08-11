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
 * VERDICT (2026-08-11, host Docker 29.7.2, DinD 29.7.1, six runs): GO for the transport hop,
 * and only for that hop.
 *
 * Driven by the core against a bridged socket, both checks return what they return against a
 * bind-mounted one: same entries, same 900,000-byte payload digest, same `exec` listing
 * instrument, and the same single parked helper for the whole tree walk. The instrument matters
 * because a transport that fails the helper's `POST /containers/{id}/start` degrades silently —
 * that error is swallowed (volumes_browse.go:283-286), the archive walk answers, and every
 * condition the harness checks still holds. The same core over the same daemon's TCP port refuses
 * all five probes with context_transport_unsupported, and stopping the bridge turns the bridged
 * context into engine_unreachable, so the pipe is what carried them.
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
import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "..");
// sockaddr_un.sun_path on Linux. Measured on this worktree rather than estimated: the checkout
// root is 77 bytes, the brief's socket path under it
// (artifacts/docker/spike-bridge/docker.sock) is 119, and the path the acceptance harness would
// use (artifacts/docker/acceptance-scratch-<suffix>/engine/docker.sock) is 141. Two of the three
// are already over the limit and the third leaves 31 bytes for everything a deeper checkout
// would add, so the scratch root for this spike is short by necessity, not by preference — and
// the same limit will bind any sbx bridge.
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
function startBridge({ socketPath, host, port, onFatalError }) {
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
    const listenFailed = (error) => failed(error);
    server.once("error", listenFailed);
    server.listen(socketPath, () => {
      // Handing the one-shot handler over. `server.once("error", failed)` stops meaning anything
      // the moment this promise settles, so an error after listen — EMFILE on accept, the socket
      // file removed under it — would have been swallowed by an already-resolved promise and the
      // bridge would sit there accepting nothing. The verdict run reads a dead bridge as
      // engine_unreachable, which is its exclusivity control's *expected* result, so a silent
      // failure here is a silent wrong answer.
      server.off("error", listenFailed);
      server.on("error", (error) => {
        if (onFatalError) onFatalError(error);
        else throw error;
      });
      ready({ server, stats });
    });
  });
}

/**
 * Remove a socket a previous bridge left behind, and refuse anything else.
 *
 * This was `rm(socketPath, {force: true})` on whatever argv handed it, which means
 * `bridge 127.0.0.1:2375 /var/run/docker.sock` tried to delete the host's real Docker socket and
 * was stopped only by the permissions on /var/run. A user-owned socket would not have been.
 *
 * Clearable means both: the path is a socket, and nothing answers on it. A live socket is
 * somebody's, whoever they are.
 */
async function clearStaleSocket(socketPath) {
  let entry;
  try {
    entry = await lstat(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!entry.isSocket()) {
    throw new Error(
      `Refusing to replace ${socketPath}: it exists and is not a socket (${
        entry.isDirectory() ? "directory" : "file"
      }).`,
    );
  }
  const answered = await new Promise((decide) => {
    const probe = connect(socketPath);
    let settled = false;
    // A connect that neither succeeds nor errors is treated as answered. Deleting a socket that
    // might be live is the failure worth avoiding here; refusing to start is not.
    const timer = setTimeout(() => settle(true), 2_000);
    function settle(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.destroy();
      decide(value);
    }
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false));
  });
  if (answered) {
    throw new Error(`Refusing to replace ${socketPath}: something is listening on it.`);
  }
  await rm(socketPath, { force: true });
}

// stdout to a pipe is asynchronous, and `process.exit()` does not drain it. The verdict run reads
// the bridge's counters off exactly one line of this stream, so a write that races the exit can
// lose the evidence that the traffic went through the bridge at all.
function writeFlushed(stream, text) {
  return new Promise((flushed) => {
    stream.write(text, flushed);
  });
}

/*
 * Every child this process starts, while it is still alive.
 *
 * Teardown's first act is to empty this, and it has to be, because a `docker run` client outlives
 * the process that spawned it. Measured: a SIGTERM 1.5 s into a run exited through a teardown
 * that verified the host was clean — correctly, at that instant — and the orphaned client then
 * created the privileged container seconds later, with nothing left alive to remove it. Worse,
 * the daemon recreated the removed scratch directory as the bind-mount source, owned by root,
 * which this process could not then have deleted even if it had still been running. Teardown that
 * does not first stop the run from creating things is only ever tidying up behind a race.
 */
const liveChildren = new Map();

function track(child, { drain = false } = {}) {
  liveChildren.set(child, { drain });
  child.once("exit", () => liveChildren.delete(child));
  return child;
}

const stillRunning = (child) => child.exitCode === null && child.signalCode === null;
const exited = (child) => new Promise((done) => child.once("exit", done));

/*
 * Stop the run from creating anything else, and killing is the wrong tool for half of it.
 *
 * A Docker client is a request already sent. SIGKILLing `docker run --detach` does not cancel the
 * daemon's work — measured, on the third attempt at this: with the client killed, the removals
 * run and the verification a second later found nothing, and the privileged container appeared
 * afterwards anyway. So the commands that create things are *drained*, not killed: waiting for
 * the client to exit is what makes the container exist in time to be removed. Only the long-lived
 * children — a core mid-request, the bridge — are killed, because they will never exit on their
 * own and they create nothing further once teardown has started.
 */
async function stopLiveChildren(graceMs = 20_000) {
  const draining = [...liveChildren]
    .filter(([child, options]) => options.drain && stillRunning(child))
    .map(([child]) => child);
  await Promise.race([Promise.all(draining.map(exited)), wait(graceMs)]);
  const remaining = [...liveChildren.keys()].filter(stillRunning);
  for (const child of remaining) child.kill("SIGKILL");
  await Promise.race([Promise.all(remaining.map(exited)), wait(10_000)]);
  return { drained: draining.length, killed: remaining.length };
}

function runProcess(executable, args, { input = "", timeoutMs = 60_000 } = {}) {
  return new Promise((settle, failed) => {
    // Drained rather than killed by teardown: these are the commands that create the things
    // teardown then removes, and a half-issued create is worse than a finished one.
    const child = track(
      spawn(executable, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] }),
      { drain: true },
    );
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

async function dockerLines(args, options) {
  return (await docker(args, options)).split("\n").filter((line) => line.trim().length > 0);
}

// The helper containers the core parks, asked for the way the harness asks: by label, against the
// daemon itself, including stopped ones.
const HELPER_QUERY = [
  "container",
  "ls",
  "--all",
  "--quiet",
  "--no-trunc",
  "--filter",
  "label=io.anchorage.helper=volume-browse",
];

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// The core speaks newline-delimited JSON on stdio. Trimmed to what a spike needs: no events, no
// session plumbing, same request envelope as tools/run-core-acceptance.mjs.
class CoreClient {
  constructor(path, allowedCWD) {
    // Tracked like every other child: an interrupted browse otherwise orphans a core that is
    // holding a parked helper container, and the helper outlives both of them.
    this.child = track(
      spawn(path, ["--allow-cwd", allowedCWD], {
        cwd: allowedCWD,
        env: process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
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
 * `parkedDuringBrowse` is the harness's remaining conjunct — "one container for a whole tree
 * walk, not one per directory" (run-core-acceptance.mjs:3186). It is counted here, not assumed,
 * because a transport that broke helper reuse would satisfy everything else on this list: the
 * entries, the digests and the instrument would all be identical, and the run would end with
 * `leakedHelpers: []` because the helpers created per directory would each be tidied up. Nothing
 * else in this file can tell one helper from five.
 *
 * Each context gets its own core process. The core parks a volume helper for 90s keyed by
 * volume and mount mode, and `takeVolumeHelper` will hand a helper created over one transport to
 * a request arriving over another as long as both reach the same daemon — so a shared core would
 * let the bridged run inherit a container the direct socket built, and the bridge's own
 * container-create path would go unmeasured.
 */
async function browseThrough(
  corePath,
  scratch,
  contextName,
  volume,
  marker,
  largeDigest,
  helperContext,
) {
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
    // While this core is still up. A parked helper is removed when its core shuts down, so a
    // count taken after client.close() would report zero however many the walk created.
    const parkedDuringBrowse = (
      await dockerLines(["--context", helperContext, ...HELPER_QUERY])
    ).length;
    const steps = [root, nested, fileRead, fanout, large];
    const failures = steps.filter((step) => !step.ok);
    if (failures.length > 0) {
      return {
        context: contextName,
        passed: false,
        parkedDuringBrowse,
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
    // The harness's own bound, unchanged: three directories walked, at most one helper standing.
    const helperReuseHeld = parkedDuringBrowse <= 1;
    const fanoutHeld =
      fanoutListing.entries.length === FANOUT_ENTRIES && !fanoutListing.truncated;
    const largeHeld =
      largeResult.sizeBytes === LARGE_FILE_BYTES &&
      !largeResult.truncated &&
      sha256(largeResult.content) === largeDigest;

    return {
      context: contextName,
      passed: harnessPredicate && helperReuseHeld && fanoutHeld && largeHeld,
      harnessPredicate,
      helperReuseHeld,
      parkedDuringBrowse,
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

  let teardownPromise = null;
  let interrupted = null;
  let abortRecord = null;
  let failure = null;
  let stopBridge = async () => {};
  const report = { suffix, scratch, directSocket, bridgeSocket, corePath, steps: [] };
  const note = (message) => {
    report.steps.push(message);
    console.error(`[spike] ${message}`);
  };

  /*
   * Every removal this run can ever owe, known before it creates anything.
   *
   * The first version of this pushed each remover after its resource came back, which loses the
   * race it exists for: a signal landing between `docker run` being issued and its client
   * returning leaves a privileged container the stack has never heard of. Measured, not
   * theorised — an interrupt 1.5 s in caught the container in `Created`. Every name here is
   * chosen by this process before anything exists, so nothing has to be discovered to be removed,
   * and a force-remove of a name that was never created costs one nonzero exit code nobody reads.
   *
   * Ordered as teardown should run it: the bridge first so the socket stops being served, the
   * volume while its context still exists, the contexts, the container, and the scratch tree the
   * container's socket lives in last.
   */
  const removals = [
    ["bridge", async () => stopBridge()],
    [
      "volume",
      async () =>
        runProcess("docker", ["--context", tcpContext, "volume", "rm", "--force", volume], {
          timeoutMs: 60_000,
        }),
    ],
    ...[tcpContext, directContext, bridgeContext].map((name) => [
      `context ${name}`,
      async () => runProcess("docker", ["context", "rm", "--force", name], { timeoutMs: 30_000 }),
    ]),
    [
      "container",
      async () => runProcess("docker", ["rm", "--force", containerName], { timeoutMs: 60_000 }),
    ],
    ["scratch", async () => rm(scratch, { recursive: true, force: true })],
  ];

  /*
   * What survived, asked of the host rather than inferred from the removals having been issued.
   *
   * Scoped to this run's own names and nothing else: one container name, three context names, one
   * scratch path. It says nothing about the host in general and is not a sweep.
   */
  async function findSurvivors() {
    const survivors = { containers: [], contexts: [], scratchDirectories: [] };
    const containers = await runProcess(
      "docker",
      ["container", "ls", "--all", "--filter", `name=^${containerName}$`, "--format", "{{.Names}}"],
      { timeoutMs: 30_000 },
    );
    if (containers.code === 0) {
      survivors.containers = containers.stdout.split("\n").filter((line) => line.trim());
    }
    const contexts = await runProcess("docker", ["context", "ls", "--format", "{{.Name}}"], {
      timeoutMs: 30_000,
    });
    if (contexts.code === 0) {
      const named = new Set([tcpContext, directContext, bridgeContext]);
      survivors.contexts = contexts.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => named.has(line));
    }
    try {
      await lstat(scratch);
      survivors.scratchDirectories = [scratch];
    } catch {
      survivors.scratchDirectories = [];
    }
    return survivors;
  }

  /*
   * Teardown, run once, by whoever reaches it first.
   *
   * A shared in-flight promise rather than a `done` boolean, for the reason
   * run-core-acceptance.mjs:1253 gives: with a boolean, a signal arriving while the finally block
   * is mid-teardown returns instantly and the handler's process.exit() then kills the teardown in
   * flight — which leaves the privileged daemon running, the failure the whole plan this spike
   * sits inside exists to remove. Returning the promise makes the second caller wait for the
   * first rather than race past it.
   *
   * Three things in order, and the order is the whole design:
   *
   * 1. Stop the run creating anything else — draining the clients that create, killing the rest.
   * 2. Run the removals.
   * 3. Ask the host what is left, after a pause long enough for anything the daemon was already
   *    asked for to have appeared, and go round again if the answer is not "nothing".
   *
   * Without (1), (3) answers honestly and still misses: measured, a run interrupted at 1.5 s
   * verified itself clean and its orphaned client created the privileged container afterwards.
   * Without (3), (2) only establishes that the removals were issued.
   */
  function runTeardown() {
    if (teardownPromise) return teardownPromise;
    teardownPromise = (async () => {
      let survivors = null;
      let passes = 0;
      let children = { drained: 0, killed: 0 };
      try {
        children = await stopLiveChildren();
      } catch (error) {
        report.steps.push(`teardown could not stop its children: ${error.message}`);
      }
      for (; passes < 3; passes += 1) {
        for (const [label, step] of removals) {
          try {
            await step();
          } catch (error) {
            report.steps.push(`teardown error (${label}): ${error.message}`);
          }
        }
        // The removals are asked to prove themselves against a settled host rather than against
        // the instant they finished, and three passes of this is six seconds of watching for
        // anything that arrives late.
        await wait(2_000);
        try {
          survivors = await findSurvivors();
        } catch (error) {
          report.steps.push(`teardown verification failed: ${error.message}`);
          survivors = null;
          break;
        }
        if (
          survivors.containers.length === 0 &&
          survivors.contexts.length === 0 &&
          survivors.scratchDirectories.length === 0
        ) {
          break;
        }
      }
      report.teardown = {
        passes: Math.min(passes + 1, 3),
        children,
        // Only ever the names above: this run's container, its three contexts, its scratch tree.
        // Not a claim about the host, and not a sweep — this spike's debris carries
        // `io.anchorage.spike` and `anchorage-spike-*` precisely so it can never be confused
        // with the acceptance harness's, and nothing else sweeps that namespace.
        verifiedAbsent:
          Boolean(survivors) &&
          survivors.containers.length === 0 &&
          survivors.contexts.length === 0 &&
          survivors.scratchDirectories.length === 0,
        survivors,
      };
    })();
    return teardownPromise;
  }

  /*
   * What a Ctrl-C used to leave on this host.
   *
   * Teardown lived only in the finally block, so a signal ended the process where it stood: a
   * privileged, root-equivalent DinD container still running, three Docker contexts, a bound
   * socket and a scratch tree. `--rm` does not cover it — the harness measured that a detached
   * container is still `Up` 20 seconds after its client is killed
   * (run-core-acceptance.mjs:2505-2509) — and nothing in this repository would ever collect it,
   * because the sweep built by this plan keys on `io.anchorage.acceptance` and
   * `anchorage-dind-*`, while this spike deliberately uses `io.anchorage.spike` and
   * `anchorage-spike-*` so that its debris can never be mistaken for acceptance evidence. That
   * namespace split is worth keeping, and it is exactly why this handler has to exist: nothing
   * else is looking.
   */
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (interrupted) return;
      // Both assignments before the first await, so the epilogue can never see one without the
      // other and go back to racing this handler for the report.
      interrupted = signal;
      abortRecord = (async () => {
        process.stderr.write(`\n[spike] ${signal} received; tearing down before exit.\n`);
        await runTeardown();
        report.status = "aborted";
        report.abortedBy = signal;
        report.verdict = null;
        // Flushed before the exit, not written into a pipe the exit then discards.
        await writeFlushed(process.stdout, `${JSON.stringify(report, null, 2)}\n`);
        process.exit(130);
      })().catch(async (error) => {
        // Nothing above rejects today: every teardown step is individually caught and the write
        // is to stdout. The guard is here because the epilogue parks on this promise, so a future
        // unguarded await would hang the run instead of ending it — and teardown has already
        // settled by the time any rejection can arrive, so exiting here cannot cut it short.
        process.stderr.write(`[spike] interrupt handling failed: ${error.message}\n`);
        process.exit(130);
      });
    });
  }

  try {
    await mkdir(engineDirectory, { recursive: true, mode: 0o700 });
    await mkdir(bridgeDirectory, { recursive: true, mode: 0o700 });

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
    const bridge = track(
      spawn(process.execPath, [scriptPath, "bridge", `127.0.0.1:${port}`, bridgeSocket], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
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
    // Assigned into the variable the pre-registered teardown step calls, in the same synchronous
    // turn as the spawn above, so there is no instant at which the child exists and teardown
    // cannot reach it. Until then that step calls the no-op default: nothing spawned, nothing to
    // stop.
    stopBridge = async () => {
      if (bridgeStopped) return;
      bridgeStopped = true;
      bridge.kill("SIGTERM");
      await Promise.race([bridgeExited, wait(5_000)]);
      // A bridge that is still alive after five seconds of SIGTERM is not going to report, and
      // leaving it holding the socket is worse than losing the counters.
      if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill("SIGKILL");
      const line = bridgeOutput.split("\n").find((entry) => entry.startsWith("bridge-stats "));
      report.bridgeStats = line ? JSON.parse(line.slice("bridge-stats ".length)) : null;
    };
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
    note(`seeded volume ${volume}`);

    // Order matters: the negative control first, so a bridge result cannot be a stale cache of a
    // direct one, and the direct control before the bridge so the comparison is against a fresh
    // measurement of the same daemon and the same volume.
    // The parked-helper count is taken through the TCP context throughout — the docker CLI is
    // happy over TCP, it is only the core's two archive verbs that are not, so this reads the
    // daemon's own container list without going near the transport under test.
    report.tcp = await browseThrough(
      corePath,
      scratch,
      tcpContext,
      volume,
      marker,
      largeDigest,
      tcpContext,
    );
    note(`tcp: ${report.tcp.passed ? "passed" : "refused"}`);
    report.direct = await browseThrough(
      corePath,
      scratch,
      directContext,
      volume,
      marker,
      largeDigest,
      tcpContext,
    );
    note(
      `direct socket: ${report.direct.passed ? "passed" : "failed"} ` +
        `(parked helpers ${report.direct.parkedDuringBrowse})`,
    );
    report.bridge = await browseThrough(
      corePath,
      scratch,
      bridgeContext,
      volume,
      marker,
      largeDigest,
      tcpContext,
    );
    note(
      `bridged socket: ${report.bridge.passed ? "passed" : "failed"} ` +
        `(parked helpers ${report.bridge.parkedDuringBrowse})`,
    );

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
      tcpContext,
    );
    note(`bridge stopped: ${report.bridgeAbsent.passed ? "STILL PASSED (bad)" : "refused"}`);

    // A helper left running holds a reference on the volume it mounted, so this is checked the
    // way the harness checks it: after the reads, by label, against the daemon itself. Distinct
    // from parkedDuringBrowse above — that one counts what a walk stands up while its core is
    // alive, this one counts what outlives the core entirely.
    report.leakedHelpers = await dockerLines(["--context", tcpContext, ...HELPER_QUERY]);
  } catch (error) {
    failure = error;
  } finally {
    await runTeardown();
  }

  // An interrupted run's verdict is the handler's to state, and it states it by exiting. Without
  // this the two paths converge here: the handler tears down, whatever was in flight fails, the
  // catch and finally unwind through an already-settled runTeardown(), and this function prints a
  // second report over the aborted one. Awaiting a promise that only settles by way of
  // process.exit() is what keeps there being one narrator.
  if (interrupted) await abortRecord;

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
    sameJSON(report.direct.listing, report.bridge.listing) &&
    // And the same number of helper containers to answer with. Every field above compares what
    // came back; this one compares what it cost. A bridge that broke helper reuse would return
    // byte-identical results off one container per directory.
    report.direct.parkedDuringBrowse === report.bridge.parkedDuringBrowse;
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
    // The harness's "one container for a whole tree walk" bound, held on both transports.
    helperReuseHeld: report.direct.helperReuseHeld && report.bridge.helperReuseHeld,
    parkedDuringBrowse: {
      direct: report.direct.parkedDuringBrowse,
      bridge: report.bridge.parkedDuringBrowse,
    },
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
  try {
    await clearStaleSocket(socketPath);
  } catch (error) {
    // A refusal is a usage error, not a crash: the caller pointed this at a path it does not own.
    console.error(error.message);
    process.exit(64);
  }
  let stopping = null;
  const { server, stats } = await startBridge({
    socketPath,
    host,
    port: Number(port),
    onFatalError: (error) => {
      process.stderr.write(`bridge-failed ${error.message}\n`);
      process.exitCode = 1;
      void stop();
    },
  });
  // Reported once, by whoever gets here first, and the exit waits on the same promise the second
  // caller gets — a SIGINT arriving while SIGTERM's shutdown is mid-flight must not exit past it.
  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      await writeFlushed(process.stdout, `bridge-stats ${JSON.stringify(stats)}\n`);
      await new Promise((closed) => server.close(closed));
      // The bind leaves the socket file behind; the process that made it is the one that knows
      // it is stale. Only ever this path, which startBridge bound and nothing else owns.
      await rm(socketPath, { force: true });
      process.exit(process.exitCode ?? 0);
    })().catch(async (error) => {
      process.stderr.write(`bridge-shutdown-failed ${error.message}\n`);
      process.exit(1);
    });
    return stopping;
  }
  await writeFlushed(process.stdout, `bridge-ready unix://${socketPath} -> tcp://${target}\n`);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else if (mode === "verdict") {
  // Not artifacts/docker: the socket path the brief puts there is 119 bytes under this checkout
  // and the harness's own is 141, against a 108-byte sun_path — see SUN_PATH_MAX above. The
  // scratch root is overridable so the spike is not tied to one machine's /tmp.
  await runVerdict(rest[0] ?? process.env.ANCHORAGE_SPIKE_ROOT ?? "/tmp");
} else {
  console.error("usage: node tools/socket-bridge-spike.mjs bridge <host:port> <socket-path>");
  console.error("       node tools/socket-bridge-spike.mjs verdict [scratch-root]");
  process.exit(64);
}
