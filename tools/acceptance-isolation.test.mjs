import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTANCE_CREATOR_LABEL,
  ACCEPTANCE_LABEL,
  ORPHAN_MIN_AGE_MS,
  acceptanceSuffixOf,
  classifyOrphans,
  createTeardownRegistry,
  formatCreatorIdentity,
  judgeResourceLiveness,
  parseCreatorIdentity,
} from "./acceptance-isolation.mjs";

const LOCAL = { bootId: "boot-a", pidNamespace: "4026531836" };
const identityOf = (overrides = {}) =>
  formatCreatorIdentity({
    bootId: LOCAL.bootId,
    pidNamespace: LOCAL.pidNamespace,
    pid: 4242,
    startTicks: 991_733,
    ...overrides,
  });

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

test("classifyOrphans spares a live peer's resources instead of sweeping them", () => {
  const result = classifyOrphans({
    containerNames: ["anchorage-dind-40d348de", "anchorage-dind-b0b0b0b0"],
    contextNames: [
      "anchorage-dind-40d348de",
      "anchorage-dind-sock-40d348de",
      "anchorage-dind-b0b0b0b0",
      "anchorage-dind-sock-b0b0b0b0",
      "default",
    ],
    scratchNames: ["acceptance-scratch-40d348de", "acceptance-scratch-b0b0b0b0"],
    liveSuffixes: ["b0b0b0b0"],
  });

  // Two runs on one daemon: the peer's whole set is left alone, and named rather than dropped.
  assert.deepEqual(result.containers, ["anchorage-dind-40d348de"]);
  assert.deepEqual(result.contexts, [
    "anchorage-dind-40d348de",
    "anchorage-dind-sock-40d348de",
  ]);
  assert.deepEqual(result.scratchDirectories, ["acceptance-scratch-40d348de"]);
  assert.deepEqual(result.possiblyLive, {
    containers: ["anchorage-dind-b0b0b0b0"],
    contexts: ["anchorage-dind-b0b0b0b0", "anchorage-dind-sock-b0b0b0b0"],
    scratchDirectories: ["acceptance-scratch-b0b0b0b0"],
  });
});

test("acceptanceSuffixOf ties a container, its contexts and its scratch directory together", () => {
  assert.equal(acceptanceSuffixOf("anchorage-dind-40d348de"), "40d348de");
  assert.equal(acceptanceSuffixOf("anchorage-dind-sock-40d348de"), "40d348de");
  assert.equal(acceptanceSuffixOf("acceptance-scratch-40d348de"), "40d348de");
  assert.equal(acceptanceSuffixOf("anchorage-dind-40d348de-extra"), null);
});

test("a creator identity survives the round trip through a Docker label", () => {
  assert.equal(ACCEPTANCE_CREATOR_LABEL, "io.anchorage.acceptance.creator");
  assert.deepEqual(parseCreatorIdentity(identityOf()), {
    bootId: "boot-a",
    pidNamespace: "4026531836",
    pid: 4242,
    startTicks: 991_733,
  });
  // Anything else is not evaluated at all, because a half-understood identity would be acted on
  // as though it were understood.
  for (const raw of [null, "", "pid=4242", "boot=b;pid=zero", "boot=b;pid=-1"]) {
    assert.equal(parseCreatorIdentity(raw), null, `should not parse: ${raw}`);
  }
});

test("a container whose creating process is still running is never swept, however old it is", () => {
  const verdict = judgeResourceLiveness({
    creator: identityOf(),
    ageMs: ORPHAN_MIN_AGE_MS * 10,
    local: LOCAL,
    probeCreator: () => "alive",
  });
  assert.deepEqual(verdict, {
    possiblyLive: true,
    reason: "creator-process-alive",
  });
});

test("a container whose creating process is gone is debris straight away, without waiting out the age bound", () => {
  const verdict = judgeResourceLiveness({
    creator: identityOf(),
    ageMs: 5_000,
    local: LOCAL,
    probeCreator: () => "gone",
  });
  assert.deepEqual(verdict, {
    possiblyLive: false,
    reason: "creator-process-gone",
  });
});

test("a pid from another boot or another namespace is not evaluated as a pid", () => {
  const probeCreator = () => {
    throw new Error("the pid must not be probed when it means nothing here");
  };
  // Same pid, different kernel boot: the fresh one is spared by age, the old one swept.
  assert.deepEqual(
    judgeResourceLiveness({
      creator: identityOf({ bootId: "boot-from-before-the-reboot" }),
      ageMs: 60_000,
      local: LOCAL,
      probeCreator,
    }),
    { possiblyLive: true, reason: "younger-than-min-age" },
  );
  assert.deepEqual(
    judgeResourceLiveness({
      creator: identityOf({ pidNamespace: "4026999999" }),
      ageMs: ORPHAN_MIN_AGE_MS + 1,
      local: LOCAL,
      probeCreator,
    }),
    { possiblyLive: false, reason: "older-than-min-age" },
  );
});

test("a container from a checkout that never heard of the creator label falls back to age", () => {
  const young = judgeResourceLiveness({
    creator: null,
    ageMs: 90_000,
    local: LOCAL,
  });
  const old = judgeResourceLiveness({
    creator: null,
    ageMs: ORPHAN_MIN_AGE_MS + 1,
    local: LOCAL,
  });
  // The peer session on this machine runs an older checkout; sweeping its live container because
  // it carries no identity is the accident this bound exists to prevent.
  assert.equal(young.possiblyLive, true);
  assert.equal(young.reason, "younger-than-min-age");
  assert.equal(old.possiblyLive, false);
  assert.equal(old.reason, "older-than-min-age");
});

test("a resource that cannot be dated at all is left alone", () => {
  // Ties go to sparing: an unanswerable question is not permission to remove a privileged daemon.
  assert.deepEqual(
    judgeResourceLiveness({ creator: null, ageMs: null, local: LOCAL }),
    { possiblyLive: true, reason: "age-unknown" },
  );
  assert.deepEqual(
    judgeResourceLiveness({
      creator: identityOf(),
      ageMs: null,
      local: LOCAL,
      probeCreator: () => "unknown",
    }),
    { possiblyLive: true, reason: "age-unknown" },
  );
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
