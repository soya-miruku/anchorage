import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { JsonLineRpcClient } from "./jsonl-rpc.mjs";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killedWith = null;

  kill(signal) {
    this.killedWith = signal;
    return true;
  }
}

test("correlates fragmented JSON-lines responses by request id", async () => {
  const child = new FakeChild();
  const client = new JsonLineRpcClient();
  client.attach(child);

  let requestLine = "";
  child.stdin.once("data", (chunk) => {
    requestLine = chunk.toString("utf8");
  });

  const pending = client.request("containers.list");
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(requestLine);

  child.stdout.write(`{"id":"${request.id}","res`);
  child.stdout.write('ult":[{"id":"abc"}]}\n');

  assert.deepEqual(await pending, [{ id: "abc" }]);
});

test("emits notifications without leaking them into request responses", async () => {
  const child = new FakeChild();
  const client = new JsonLineRpcClient();
  client.attach(child);

  const notification = once(client, "notification");
  child.stdout.write('{"event":"containers.changed","payload":{"revision":2}}\n');

  assert.deepEqual(await notification, ["containers.changed", { revision: 2 }]);
});

test("accepts the protocol health method used by the supervisor handshake", async () => {
  const child = new FakeChild();
  const client = new JsonLineRpcClient();
  client.attach(child);

  child.stdin.once("data", (chunk) => {
    const request = JSON.parse(chunk.toString("utf8"));
    child.stdout.write(
      `${JSON.stringify({
        id: request.id,
        result: { status: "ok", protocolVersion: "1", pid: 123 },
      })}\n`,
    );
  });

  const health = await client.request("health", {});
  assert.equal(health.status, "ok");
  assert.equal(health.protocolVersion, "1");
});

test("preserves structured core error codes and details for the desktop bridge", async () => {
  const child = new FakeChild();
  const client = new JsonLineRpcClient();
  client.attach(child);

  child.stdin.once("data", (chunk) => {
    const request = JSON.parse(chunk.toString("utf8"));
    child.stdout.write(
      `${JSON.stringify({
        id: request.id,
        error: {
          code: "confirmation_required",
          message: "Destructive mutation requires confirmed=true.",
          details: {
            domain: "image",
            resourceId: "sha256:abc",
            action: "remove",
          },
        },
      })}\n`,
    );
  });

  await assert.rejects(
    client.request("images.action", {
      context: "default",
      action: "remove",
    }),
    (error) => {
      assert.equal(error.code, "confirmation_required");
      assert.equal(error.message, "Destructive mutation requires confirmed=true.");
      assert.deepEqual(error.details, {
        domain: "image",
        resourceId: "sha256:abc",
        action: "remove",
      });
      return true;
    },
  );
});

test("terminates an oversized protocol line and rejects pending calls", async () => {
  const child = new FakeChild();
  const client = new JsonLineRpcClient({ maximumLineBytes: 128 });
  client.attach(child);

  const pending = client.request("containers.list").catch((error) => error);
  child.stdout.write("x".repeat(129));

  const error = await pending;
  assert.equal(error.code, "RPC_LINE_TOO_LARGE");
  assert.equal(child.killedWith, "SIGTERM");
});
