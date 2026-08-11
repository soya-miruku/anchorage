import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ACCEPTANCE_CREATOR_LABEL,
  ACCEPTANCE_LABEL,
  ORPHAN_MIN_AGE_MS,
  acceptanceSuffixOf,
  anonymousVolumeNames,
  classifyOrphans,
  createTeardownRegistry,
  formatCreatorIdentity,
  interpretMountInspect,
  interpretProcStatRead,
  judgeCreatorProcess,
  judgeResourceLiveness,
  parseCreatorIdentity,
  parseProcessStartTicks,
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

// --- the probe that decides whether a creator process is still there ---------------------------

// pid, a comm field that itself contains spaces and parentheses, then fields 3 to 21 — nineteen of
// them, which is what puts starttime (field 22) at index 19 of the split — then starttime.
const STAT_LINE = (ticks) =>
  `4242 (node (the (comm) field)) ${
    ["S", 1, 4242, 4242, 0, -1, 4194560, 91, 0, 0, 0, 12, 3, 0, 0, 20, 0, 11, 0].join(" ")
  } ${ticks} 12345678 900 18446744073709551615`;

test("a stat line is parsed past a comm field containing spaces and parentheses", () => {
  assert.equal(parseProcessStartTicks(STAT_LINE(991_733)), 991_733);
  for (const raw of [null, "", "no closing paren", "(x) 1 2 3"]) {
    assert.equal(parseProcessStartTicks(raw), null, `should not parse: ${raw}`);
  }
  // Against this kernel's real format, not only against the fixture above: a parser that agrees
  // with a hand-written line and disagrees with /proc would silently make every liveness answer
  // "unreadable", and the sweep would quietly stop sweeping.
  let real = null;
  try {
    real = readFileSync("/proc/self/stat", "utf8");
  } catch {
    real = null;
  }
  if (real !== null) {
    const ticks = parseProcessStartTicks(real);
    assert.equal(typeof ticks, "number");
    assert.ok(ticks > 0, `starttime read from /proc/self/stat should be positive: ${ticks}`);
  }
});

test("a /proc read that was refused is not the same observation as one that found nothing", () => {
  // ENOENT is the kernel saying there is no such pid — the only error that is evidence of absence.
  assert.deepEqual(
    interpretProcStatRead({ error: Object.assign(new Error("no entry"), { code: "ENOENT" }) }),
    { state: "absent", startTicks: null },
  );
  // EACCES is hidepid=1 or ProtectProc= refusing this run a look at another user's process. The
  // process is there; this run is not allowed to see it. Collapsing the two is what let a peer's
  // live privileged container be classified as debris and force-removed.
  for (const code of ["EACCES", "EPERM", "EIO", undefined]) {
    assert.deepEqual(
      interpretProcStatRead({ error: Object.assign(new Error("denied"), { code }) }),
      { state: "unreadable", startTicks: null },
      `errno ${code} must not read as absence`,
    );
  }
  assert.deepEqual(interpretProcStatRead({ contents: STAT_LINE(4_242) }), {
    state: "running",
    startTicks: 4_242,
  });
  // Present but unparseable: the entry exists, so "gone" would be a positive claim made out of a
  // failure to understand.
  assert.deepEqual(interpretProcStatRead({ contents: "garbage" }), {
    state: "unreadable",
    startTicks: null,
  });
});

test("an unreadable creator pid is never resolved to the answer that authorises removal", () => {
  const identity = parseCreatorIdentity(identityOf());
  const denied = interpretProcStatRead({
    error: Object.assign(new Error("denied"), { code: "EACCES" }),
  });

  // hidepid=1: the stat is refused, but kill(pid, 0) still finds the number held, so the peer is
  // spared rather than swept.
  assert.equal(
    judgeCreatorProcess({ identity, statRead: denied, signalRead: "held" }),
    "alive",
  );
  // Nothing to go on at all: "unknown", which sends the resource to the age rule, not to removal.
  assert.equal(
    judgeCreatorProcess({ identity, statRead: denied, signalRead: "unknown" }),
    "unknown",
  );
  // hidepid=2 hides the entry entirely, so the read is ENOENT and looks exactly like a dead pid.
  // The signal probe, which no /proc filtering suppresses, contradicts it — and the contradiction
  // resolves to "alive" rather than "unknown" on purpose. "unknown" would hand the peer to the age
  // rule, which condemns anything past the bound, so a peer run of over thirty minutes would still
  // lose its live container. A held pid spares, whatever /proc says.
  assert.equal(
    judgeCreatorProcess({
      identity,
      statRead: interpretProcStatRead({
        error: Object.assign(new Error("no entry"), { code: "ENOENT" }),
      }),
      signalRead: "held",
    }),
    "alive",
  );
});

test("a creator process is condemned only by an exact mismatch or a confirmed absence", () => {
  const identity = parseCreatorIdentity(identityOf());
  const absent = interpretProcStatRead({
    error: Object.assign(new Error("no entry"), { code: "ENOENT" }),
  });

  // Both probes agree the pid is gone: debris, straight away, without waiting out the age bound.
  assert.equal(
    judgeCreatorProcess({ identity, statRead: absent, signalRead: "absent" }),
    "gone",
  );
  // The pid is held by a process that started at a different tick — a reused number, not the
  // creator. This is the one condemnation that needs no second opinion.
  assert.equal(
    judgeCreatorProcess({
      identity,
      statRead: interpretProcStatRead({ contents: STAT_LINE(991_734) }),
      signalRead: "held",
    }),
    "gone",
  );
  assert.equal(
    judgeCreatorProcess({
      identity,
      statRead: interpretProcStatRead({ contents: STAT_LINE(991_733) }),
      signalRead: "held",
    }),
    "alive",
  );
  // An identity with no start time cannot be compared, so a held pid spares and only the two
  // probes together can condemn.
  const undated = parseCreatorIdentity(identityOf({ startTicks: null }));
  assert.equal(undated.startTicks, null);
  assert.equal(
    judgeCreatorProcess({
      identity: undated,
      statRead: interpretProcStatRead({ contents: STAT_LINE(1) }),
      signalRead: "held",
    }),
    "alive",
  );
  assert.equal(
    judgeCreatorProcess({ identity: undated, statRead: absent, signalRead: "absent" }),
    "gone",
  );
});

// --- an inspect that failed is not a container with nothing attached ---------------------------

test("a failed or timed-out mount inspect is an unknown, never an empty volume list", () => {
  // The empty array is the claim that authorises `docker rm --force --volumes`. A timeout is not
  // that claim, and returning [] for it deleted anonymous volumes that no list and no error named.
  assert.deepEqual(interpretMountInspect({ code: null, timedOut: true }), {
    ok: false,
    volumes: [],
    reason: "docker container inspect timed out",
  });
  assert.deepEqual(
    interpretMountInspect({ code: 1, stderr: "Error: No such container: x\n" }),
    { ok: false, volumes: [], reason: "Error: No such container: x" },
  );
  // A non-zero exit with both streams empty still has to say something a reader can act on.
  assert.deepEqual(interpretMountInspect({ code: 125 }), {
    ok: false,
    volumes: [],
    reason: "docker container inspect exited 125",
  });
  // Only a clean exit produces a claim about what is attached — including the genuine zero.
  assert.deepEqual(interpretMountInspect({ code: 0, stdout: "" }), {
    ok: true,
    volumes: [],
    reason: null,
  });
  assert.deepEqual(
    interpretMountInspect({ code: 0, stdout: " a \n\nb\r\n" }),
    { ok: true, volumes: ["a", "b"], reason: null },
  );
});

test("only anonymous volumes are claimed, because --volumes removes only those", () => {
  const anonymous = "a".repeat(64);
  assert.deepEqual(
    anonymousVolumeNames([anonymous, "postgres-data", `${anonymous}0`, "A".repeat(64), null]),
    [anonymous],
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
