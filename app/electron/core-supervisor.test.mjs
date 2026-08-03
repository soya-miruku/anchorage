import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CoreSupervisor } from "./core-supervisor.mjs";

class FakeCoreProcess extends EventEmitter {
  constructor(pid, onRequest) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killedWith = [];
    this.buffer = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) {
          onRequest(this, JSON.parse(line));
        }
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  respond(id, result) {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  notify(event, payload) {
    this.stdout.write(`${JSON.stringify({ event, payload })}\n`);
  }

  crash(code = 17) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  kill(signal) {
    this.killedWith.push(signal);
    if (this.exitCode !== null || this.signalCode !== null) {
      return false;
    }
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

function waitForStatus(supervisor, predicate) {
  return new Promise((resolve) => {
    const listener = (status) => {
      if (!predicate(status)) {
        return;
      }
      supervisor.removeListener("status", listener);
      resolve(status);
    };
    supervisor.on("status", listener);
  });
}

test("launches from HOME with filesystem-wide cwd reach and restores after a crash", async () => {
  const children = [];
  const spawnCalls = [];
  const notifications = [];
  const statuses = [];
  const spawn = (binary, args, options) => {
    const generation = children.length + 1;
    const child = new FakeCoreProcess(4_000 + generation, (process, request) => {
      if (request.method === "health") {
        process.respond(request.id, {
          status: "ok",
          protocolVersion: "1",
          pid: process.pid,
        });
        return;
      }
      if (generation > 1) {
        process.respond(request.id, { generation, method: request.method });
      }
    });
    children.push(child);
    spawnCalls.push({ binary, args: [...args], options });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };

  const supervisor = new CoreSupervisor({
    binaryPath: "/opt/anchorage/core/anchorage-core",
    args: ["--allow-cwd", "/"],
    cwd: "/home/tester",
    spawn,
    environment: {
      HOME: "/home/tester",
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///run/user/1000/docker.sock",
      ANCHORAGE_SECRET: "must-not-reach-core",
    },
    restartDelaysMs: [1],
  });
  supervisor.on("status", (status) => statuses.push(status));
  supervisor.on("notification", (event, payload) => {
    notifications.push({ event, payload });
  });

  const firstReady = waitForStatus(
    supervisor,
    (status) => status.state === "ready" && status.pid === 4_001,
  );
  supervisor.start();
  await firstReady;

  assert.deepEqual(spawnCalls[0].args, ["--allow-cwd", "/"]);
  assert.equal(spawnCalls[0].options.cwd, "/home/tester");
  assert.equal(spawnCalls[0].options.shell, false);
  assert.deepEqual(spawnCalls[0].options.env, {
    HOME: "/home/tester",
    PATH: "/usr/bin",
    DOCKER_HOST: "unix:///run/user/1000/docker.sock",
  });

  const pending = supervisor
    .request(
      "session.ack",
      {
        sessionId: "01234567-89ab-cdef-0123-456789abcdef",
        throughSequence: 1,
      },
      { timeoutMs: 5_000 },
    )
    .catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));

  const secondReady = waitForStatus(
    supervisor,
    (status) => status.state === "ready" && status.pid === 4_002,
  );
  children[0].crash();
  const crashError = await pending;
  assert.equal(crashError.code, "CORE_CRASHED");
  await assert.rejects(
    supervisor.request("session.cancel", {}, { timeoutMs: 100 }),
    (error) => error.code === "CORE_UNAVAILABLE",
  );

  children[0].notify("session.output", { stale: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, []);

  await secondReady;
  const recovered = await supervisor.request(
    "session.cancel",
    { sessionId: "01234567-89ab-cdef-0123-456789abcdef" },
    { timeoutMs: 1_000 },
  );
  assert.deepEqual(recovered, {
    generation: 2,
    method: "session.cancel",
  });

  const notification = once(supervisor, "notification");
  children[1].notify("session.output", { sequence: 2 });
  assert.deepEqual(await notification, [
    "session.output",
    { sequence: 2 },
  ]);
  assert.equal(
    statuses.some(
      (status) => status.state === "restart-scheduled" && status.attempt === 1,
    ),
    true,
  );
  assert.equal(
    statuses.some(
      (status) => status.state === "restarting" && status.attempt === 1,
    ),
    true,
  );

  await supervisor.stop({ gracePeriodMs: 100 });
});
