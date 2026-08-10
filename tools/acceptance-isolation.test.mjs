import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTANCE_LABEL,
  classifyOrphans,
  createTeardownRegistry,
} from "./acceptance-isolation.mjs";

test("the acceptance label is the one the harness stamps on its containers", () => {
  assert.equal(ACCEPTANCE_LABEL, "io.anchorage.acceptance");
});

test("classifyOrphans finds debris from previous runs and spares the active one", () => {
  const result = classifyOrphans({
    containerNames: ["anchorage-dind-40d348de", "anchorage-dind-aabbccdd", "unrelated-app"],
    contextNames: [
      "anchorage-dind-40d348de",
      "anchorage-dind-sock-40d348de",
      "anchorage-dind-aabbccdd",
      "default",
    ],
    scratchNames: ["acceptance-scratch-40d348de", "acceptance-scratch-aabbccdd", "notes"],
    activeSuffix: "aabbccdd",
  });

  // The active run's own resources are not orphans — sweeping them would destroy the run.
  assert.deepEqual(result.containers, ["anchorage-dind-40d348de"]);
  assert.deepEqual(result.contexts, [
    "anchorage-dind-40d348de",
    "anchorage-dind-sock-40d348de",
  ]);
  assert.deepEqual(result.scratchDirectories, ["acceptance-scratch-40d348de"]);
});

test("classifyOrphans matches sbx-backed names too, so a backend swap cannot smuggle debris past the sweep", () => {
  const result = classifyOrphans({
    containerNames: [],
    contextNames: ["anchorage-sbx-11223344", "anchorage-sbx-sock-11223344"],
    scratchNames: [],
    activeSuffix: null,
  });
  assert.deepEqual(result.contexts, ["anchorage-sbx-11223344", "anchorage-sbx-sock-11223344"]);
});

test("classifyOrphans ignores names that merely resemble the convention", () => {
  const result = classifyOrphans({
    containerNames: ["anchorage-dind-XYZ", "anchorage-dind-", "anchorage-dind-40d348de-extra"],
    contextNames: [],
    scratchNames: ["acceptance-scratch-nope"],
    activeSuffix: null,
  });
  assert.deepEqual(result.containers, []);
  assert.deepEqual(result.scratchDirectories, []);
});

test("teardown runs every step in reverse order of registration", async () => {
  const order = [];
  const registry = createTeardownRegistry();
  registry.add("context", async () => { order.push("context"); });
  registry.add("container", async () => { order.push("container"); });

  const result = await registry.run();

  // Reverse order: the container must go before the context that points at it.
  assert.deepEqual(order, ["container", "context"]);
  assert.equal(result.alreadyRan, false);
  assert.deepEqual(result.steps.map((s) => [s.name, s.ok]), [
    ["container", true],
    ["context", true],
  ]);
});

test("teardown is idempotent, because the signal path and the finally block both call it", async () => {
  let calls = 0;
  const registry = createTeardownRegistry();
  registry.add("once", async () => { calls += 1; });

  await registry.run();
  const second = await registry.run();

  assert.equal(calls, 1);
  assert.equal(second.alreadyRan, true);
  assert.deepEqual(second.steps, []);
});

test("one failing step does not abandon the rest, and the failure is recorded", async () => {
  const done = [];
  const registry = createTeardownRegistry();
  registry.add("first", async () => { done.push("first"); });
  registry.add("explodes", async () => { throw new Error("daemon gone"); });
  registry.add("last", async () => { done.push("last"); });

  const result = await registry.run();

  // "last" registered last so runs first; "first" must still run despite the middle failure.
  assert.deepEqual(done, ["last", "first"]);
  const failed = result.steps.find((s) => s.name === "explodes");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /daemon gone/u);
});
