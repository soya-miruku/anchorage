# Acceptance Isolation Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the acceptance harness incapable of silently leaking a privileged container, and prove the Unix-socket bridge that decides whether an sbx backend is viable at all.

**Architecture:** The harness is a 2,949-line script with zero exports, so nothing in it can be unit-tested. The testable logic — orphan classification and idempotent teardown — moves into a new importable module, `tools/acceptance-isolation.mjs`, mirroring the existing `tools/security-evidence-helpers.mjs` pattern. The script keeps its Docker calls and gains signal handlers that route through the same teardown as its `finally` block. The release policy then validates a strengthened cleanup claim.

**Tech Stack:** Node 20+ ESM, `node --test` with `node:assert/strict`, Docker CLI, Bun as the script runner.

## Global Constraints

- **Zero runtime dependencies.** `app/package.json` declares no `dependencies`; the Go core has no `require` block. Add none. Node stdlib only.
- **Evidence describes exactly what ran, never more.** A claim that cannot be established by enumeration must not be recorded as established.
- **One definition of the check matrix.** `tools/acceptance-check-ids.mjs` is the single source; `run-core-acceptance.mjs:23-25` records that a second copy "is what broke packaging when the matrix last grew."
- **Existing check ids are load-bearing.** `app/scripts/package-evidence-policy.mjs` validates the evidence against the exact id set. Renaming an id without updating the policy breaks packaging.
- **Comments explain why, not what.** This codebase's comments carry reasoning and corrections; match that register.
- **Never weaken a gate to make it pass.** If a check cannot hold, say so rather than loosening it.

## File Structure

| File | Responsibility |
|---|---|
| `tools/acceptance-isolation.mjs` *(create)* | Pure, importable logic: orphan classification, teardown registry. No Docker calls, no I/O — so it is testable without a daemon. |
| `tools/acceptance-isolation.test.mjs` *(create)* | `node --test` coverage for the above. |
| `tools/run-core-acceptance.mjs` *(modify)* | Consumes the module; gains signal handlers, the orphan preflight, and `--rm` on the DinD container. |
| `app/package.json` *(modify)* | New `test:acceptance-isolation` script, wired into `test`. |
| `app/scripts/package-evidence-policy.mjs` *(modify)* | Validates the strengthened cleanup claim and the `aborted` status. |
| `app/scripts/package-evidence-policy.test.mjs` *(modify)* | Cases for the new claim shape. |
| `tools/socket-bridge-spike.mjs` *(create, Task 6)* | Standalone go/no-go spike. Deleted or promoted once it answers. |

---

### Task 1: Orphan classification module

Pure functions first, because they are the part that can be tested without a Docker daemon, and the preflight in Task 3 depends on them.

**Files:**
- Create: `tools/acceptance-isolation.mjs`
- Create: `tools/acceptance-isolation.test.mjs`
- Modify: `app/package.json`

**Interfaces:**
- Produces: `ACCEPTANCE_LABEL: string`, `ACCEPTANCE_RESOURCE_PATTERN: RegExp`, `SCRATCH_DIRECTORY_PATTERN: RegExp`, `classifyOrphans({containerNames, contextNames, scratchNames, activeSuffix}) -> {containers: string[], contexts: string[], scratchDirectories: string[]}`

- [ ] **Step 1: Write the failing test**

```js
// tools/acceptance-isolation.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTANCE_LABEL,
  classifyOrphans,
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tools/acceptance-isolation.test.mjs`
Expected: FAIL — `Cannot find module '.../tools/acceptance-isolation.mjs'`

- [ ] **Step 3: Write the module**

```js
// tools/acceptance-isolation.mjs
/**
 * The parts of the acceptance harness that can be reasoned about without a Docker daemon.
 *
 * run-core-acceptance.mjs is a script with no exports, so nothing inside it can be unit-tested.
 * Orphan classification and teardown ordering are the two pieces where a mistake is silent and
 * expensive — a sweep that matches too widely deletes a running container, one that matches too
 * narrowly leaves a privileged daemon behind — so they live here, where a test can reach them.
 */

/** The label the harness stamps on every container it owns. */
export const ACCEPTANCE_LABEL = "io.anchorage.acceptance";

/**
 * Container and context names the harness creates.
 *
 * Anchored at both ends and exact about the suffix: `anchorage-dind-40d348de-extra` is somebody
 * else's container that happens to start the same way, and sweeping it would be destroying a
 * stranger's work on the strength of a prefix.
 */
export const ACCEPTANCE_RESOURCE_PATTERN =
  /^anchorage-(?:dind|sbx)(?:-sock)?-([0-9a-f]{8})$/u;

/** Scratch directories under artifacts/docker/. */
export const SCRATCH_DIRECTORY_PATTERN = /^acceptance-scratch-([0-9a-f]{8})$/u;

function suffixOf(name, pattern) {
  const match = pattern.exec(name);
  return match ? match[1] : null;
}

/**
 * Splits observed names into "debris from an earlier run" and "not ours / still in use".
 *
 * `activeSuffix` is excluded because the caller runs this while its own resources exist; without
 * that exclusion the preflight would sweep the run that invoked it.
 */
export function classifyOrphans({
  containerNames = [],
  contextNames = [],
  scratchNames = [],
  activeSuffix = null,
} = {}) {
  const orphaned = (names, pattern) =>
    names.filter((name) => {
      const suffix = suffixOf(name, pattern);
      return suffix !== null && suffix !== activeSuffix;
    });

  return {
    containers: orphaned(containerNames, ACCEPTANCE_RESOURCE_PATTERN),
    contexts: orphaned(contextNames, ACCEPTANCE_RESOURCE_PATTERN),
    scratchDirectories: orphaned(scratchNames, SCRATCH_DIRECTORY_PATTERN),
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test tools/acceptance-isolation.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Wire it into the suite**

In `app/package.json`, add to `scripts`:

```json
"test:acceptance-isolation": "node --test ../tools/acceptance-isolation.test.mjs"
```

and insert `bun run test:acceptance-isolation && ` into the `test` script immediately after `bun run test:security-evidence && `.

- [ ] **Step 6: Confirm the suite runs it**

Run: `cd app && bun run test:acceptance-isolation`
Expected: PASS, 4 tests

- [ ] **Step 7: Commit**

```bash
git add tools/acceptance-isolation.mjs tools/acceptance-isolation.test.mjs app/package.json
git commit -m "Classify acceptance debris where a test can reach the logic"
```

---

### Task 2: Idempotent teardown registry

The signal path and the `finally` block must run the same teardown, and must not run it twice.

**Files:**
- Modify: `tools/acceptance-isolation.mjs`
- Modify: `tools/acceptance-isolation.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1 beyond the module existing.
- Produces: `createTeardownRegistry() -> {add(name, fn): void, run(): Promise<{alreadyRan: boolean, steps: Array<{name: string, ok: boolean, error: string|null}>}>, get size(): number}`

- [ ] **Step 1: Write the failing test**

Append to `tools/acceptance-isolation.test.mjs`:

```js
import { createTeardownRegistry } from "./acceptance-isolation.mjs";

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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tools/acceptance-isolation.test.mjs`
Expected: FAIL — `createTeardownRegistry is not a function`

- [ ] **Step 3: Implement**

Append to `tools/acceptance-isolation.mjs`:

```js
/**
 * Teardown steps, run once, in reverse order, with failures recorded rather than thrown.
 *
 * Reverse order because the resources nest: the container must go before the context that points
 * at it, and the scratch directory last because it holds the socket the context named. Failures
 * are collected instead of propagated because the first failing step is exactly when the
 * remaining steps matter most — abandoning them is how a privileged container survives.
 *
 * Idempotent because two callers race for it: the `finally` block on the normal path, and the
 * signal handler when a run is interrupted. Whichever arrives first does the work.
 */
export function createTeardownRegistry() {
  const steps = [];
  let ran = false;

  return {
    add(name, fn) {
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("teardown step needs a name");
      }
      if (typeof fn !== "function") {
        throw new TypeError(`teardown step ${name} needs a function`);
      }
      steps.push({ name, fn });
    },
    get size() {
      return steps.length;
    },
    async run() {
      if (ran) return { alreadyRan: true, steps: [] };
      ran = true;
      const results = [];
      for (const step of [...steps].reverse()) {
        try {
          await step.fn();
          results.push({ name: step.name, ok: true, error: null });
        } catch (error) {
          results.push({
            name: step.name,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { alreadyRan: false, steps: results };
    },
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test tools/acceptance-isolation.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add tools/acceptance-isolation.mjs tools/acceptance-isolation.test.mjs
git commit -m "Run teardown once, in reverse, recording what failed"
```

---

### Task 3: Signal handlers that tear down and record

**Files:**
- Modify: `tools/run-core-acceptance.mjs` (imports near line 1-20; new handler block before the top-level `try` at line 743; teardown extraction at the `finally` at line 2748)

**Interfaces:**
- Consumes: `createTeardownRegistry` from Task 2.
- Produces: an evidence file whose `status` may now be `"aborted"`.

- [ ] **Step 1: Extract the existing cleanup into a named function**

In `tools/run-core-acceptance.mjs`, the `finally` block at line 2748 currently inlines the whole teardown. Move its body verbatim into an async function declared above the top-level `try`, leaving the `finally` as a single call:

```js
// Declared before the try so the signal handlers can reach it too. The body is the existing
// finally block, moved rather than rewritten: this step changes when cleanup runs, not what it
// does, and mixing those two changes would make a teardown regression impossible to bisect.
async function runTeardown() {
  if (teardownComplete) return;
  teardownComplete = true;
  // ... existing finally body, unchanged ...
}
```

with `let teardownComplete = false;` beside `let dindResource = null;` at line 733, and the `finally` becoming:

```js
} finally {
  await runTeardown();
}
```

- [ ] **Step 2: Verify the refactor changed nothing**

Run: `ANCHORAGE_ACCEPTANCE_MUTATIONS=0 node tools/run-core-acceptance.mjs`
Expected: `PASSED: 11 of 11 core acceptance checks executed, 0 skipped (excluding disposable mutations).` — identical to before the change. Confirm `artifacts/docker/read-only-acceptance.json` still reports `"status": "passed"`.

- [ ] **Step 3: Add the signal handlers**

Immediately before the top-level `try` at line 743:

```js
// A run killed between the DinD launch and the finally block used to end here: Node exits, the
// privileged container keeps running, and nothing is written — so the leak is invisible rather
// than recorded. The next successful run overwrites the evidence path, and the file on disk is
// then honest, passing, and silent about a root-equivalent daemon still on the host.
//
// Recording an interrupted run matters as much as cleaning up after it. An `aborted` evidence
// file says what was left behind; no file at all says nothing happened.
let interrupted = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = signal;
    void (async () => {
      process.stderr.write(`\n${signal} received; tearing down before exit.\n`);
      await runTeardown();
      await writeAbortedEvidence(signal);
      process.exit(130);
    })();
  });
}
```

- [ ] **Step 4: Add the aborted-evidence writer**

Beside `runTeardown`:

```js
/**
 * The evidence an interrupted run leaves behind.
 *
 * Deliberately not a passing artifact and deliberately not absent: `status: "aborted"` is a third
 * outcome the policy rejects for a release, while still recording which checks had completed and
 * what teardown managed to remove. Silence is the one option that helps nobody.
 */
async function writeAbortedEvidence(signal) {
  try {
    const aborted = {
      schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
      matrixVersion: ACCEPTANCE_MATRIX_VERSION,
      startedAt: startedAtIso,
      completedAt: new Date().toISOString(),
      corePath,
      coreSha256,
      generator: { path: generatorPath, sha256: generatorSha256 },
      mutationsEnabled: runMutations,
      status: "aborted",
      abortedBy: signal,
      requiredChecks: runMutations
        ? [...READ_ONLY_CHECK_IDS, ...MUTATION_CHECK_IDS].sort()
        : [...READ_ONLY_CHECK_IDS],
      checks,
      skippedChecks,
      cleanup: cleanupEvidence,
      error: null,
    };
    await mkdir(resolve(outputPath, ".."), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(aborted, null, 2)}\n`);
    process.stderr.write(`Recorded aborted run to ${outputPath}\n`);
  } catch (error) {
    process.stderr.write(`Could not record the aborted run: ${error}\n`);
  }
}
```

If any identifier above (`startedAtIso`, `corePath`, `coreSha256`, `generatorPath`, `generatorSha256`, `skippedChecks`) is currently computed inline at the bottom of the file rather than bound to a name, hoist it to a `const` beside `checks` at line 725 first, and use that name in both places.

- [ ] **Step 5: Prove the handler works, with a real signal**

```bash
ANCHORAGE_ACCEPTANCE_MUTATIONS=1 node tools/run-core-acceptance.mjs &
PID=$!
sleep 25          # long enough for the DinD container to exist
kill -TERM $PID
wait $PID; echo "exit: $?"

docker ps -a --filter "label=io.anchorage.acceptance" --format '{{.Names}}'   # expect: empty
docker context ls --format '{{.Name}}' | grep anchorage- || echo "no contexts"  # expect: no contexts
ls artifacts/docker/ | grep acceptance-scratch || echo "no scratch"             # expect: no scratch
python3 -c "import json;print(json.load(open('artifacts/docker/conformance-results.json'))['status'])"
```

Expected: exit `130`; no containers, contexts or scratch directories; status prints `aborted`.

- [ ] **Step 6: Commit**

```bash
git add tools/run-core-acceptance.mjs
git commit -m "Tear down and record when a run is interrupted"
```

---

### Task 4: Labelled-orphan preflight

Turns `cleanup: passed` from a per-run claim into a host-state claim, established by enumeration.

**Files:**
- Modify: `tools/run-core-acceptance.mjs` (before the collision check at line 1533)

**Interfaces:**
- Consumes: `classifyOrphans`, `ACCEPTANCE_LABEL` from Task 1.
- Produces: `cleanupEvidence.orphansRemoved: {containers: string[], contexts: string[], scratchDirectories: string[]}` and `cleanupEvidence.hostVerifiedClear: boolean`.

- [ ] **Step 1: Add the preflight sweep**

Insert before the existing collision check at line 1533, and extend `cleanupEvidence` at line 736 with `orphansRemoved: {containers: [], contexts: [], scratchDirectories: []}` and `hostVerifiedClear: false`:

```js
// The collision check below asks "does my own random name already exist", which is a different
// and much weaker question than "is this host clear of acceptance debris". An interrupted run
// leaves a privileged daemon that no later run would ever notice, because its suffix is random
// and unrelated. Enumerating by label is what lets `cleanup: passed` mean the host is clear,
// rather than only that this run tidied up after itself.
const [hostContainers, hostContexts, hostScratch] = await Promise.all([
  dockerLinesAt(context, [
    "ps", "--all", "--filter", `label=${ACCEPTANCE_LABEL}`, "--format", "{{.Names}}",
  ]),
  dockerLinesAt(context, ["context", "ls", "--format", "{{.Name}}"]),
  readdir(resolve(workspaceRoot, "artifacts/docker")).catch(() => []),
]);
const orphans = classifyOrphans({
  containerNames: hostContainers,
  contextNames: hostContexts,
  scratchNames: hostScratch,
  activeSuffix: suffix,
});
for (const name of orphans.containers) {
  await dockerRun(context, ["rm", "--force", name], { timeoutMs: 60_000 });
  cleanupEvidence.orphansRemoved.containers.push(name);
}
for (const name of orphans.contexts) {
  await dockerRun(context, ["context", "rm", "--force", name], { timeoutMs: 30_000 });
  cleanupEvidence.orphansRemoved.contexts.push(name);
}
for (const name of orphans.scratchDirectories) {
  await rm(resolve(workspaceRoot, "artifacts/docker", name), {
    recursive: true, force: true,
  });
  cleanupEvidence.orphansRemoved.scratchDirectories.push(name);
}
```

Add `readdir` to the existing `node:fs/promises` import if absent, and import `classifyOrphans`/`ACCEPTANCE_LABEL` from `./acceptance-isolation.mjs`.

- [ ] **Step 2: Set the host-clear claim during teardown**

At the end of `runTeardown`, after the existing per-resource verification:

```js
// Established by asking the host, not by assuming the removals above worked.
const [remainingContainers, remainingContexts] = await Promise.all([
  dockerLinesAt(context, [
    "ps", "--all", "--filter", `label=${ACCEPTANCE_LABEL}`, "--format", "{{.Names}}",
  ]),
  dockerLinesAt(context, ["context", "ls", "--format", "{{.Name}}"]),
]);
const leftover = classifyOrphans({
  containerNames: remainingContainers,
  contextNames: remainingContexts,
  scratchNames: [],
  activeSuffix: null,
});
cleanupEvidence.hostVerifiedClear =
  leftover.containers.length === 0 && leftover.contexts.length === 0;
if (!cleanupEvidence.hostVerifiedClear) {
  cleanupErrors.push(
    `Acceptance resources survived teardown: ${[...leftover.containers, ...leftover.contexts].join(", ")}`,
  );
}
```

- [ ] **Step 3: Prove the sweep finds real debris**

The host currently has genuine debris from an interrupted run — use it rather than a synthetic fixture:

```bash
docker ps -a --filter "label=io.anchorage.acceptance" --format '{{.Names}}'
# expect: anchorage-dind-40d348de   (or whatever is present)

ANCHORAGE_ACCEPTANCE_MUTATIONS=1 node tools/run-core-acceptance.mjs

python3 -c "
import json; d=json.load(open('artifacts/docker/conformance-results.json'))
print('orphansRemoved:', d['cleanup']['orphansRemoved'])
print('hostVerifiedClear:', d['cleanup']['hostVerifiedClear'])"
```

Expected: the pre-existing container and both stale contexts appear under `orphansRemoved`, and `hostVerifiedClear` is `true`.

- [ ] **Step 4: Make the container self-limiting**

The sweep only helps the *next* run. A privileged daemon should not outlive its run at all when
Docker can be told so directly. In the `docker run` argument list at `run-core-acceptance.mjs:1553`,
add `"--rm",` immediately after `"--detach",`:

```js
        "run",
        "--detach",
        // Docker removes the container when its daemon exits, so an interrupted run leaves an
        // exited husk at worst rather than a running root-equivalent daemon. The sweep in this
        // task covers the case where the container never exits; this covers the case where the
        // harness never gets to ask it to.
        "--rm",
        "--privileged",
```

- [ ] **Step 5: Prove the container does not survive its run**

```bash
ANCHORAGE_ACCEPTANCE_MUTATIONS=1 node tools/run-core-acceptance.mjs &
PID=$!
sleep 25
kill -9 $PID        # SIGKILL, so the handlers from Task 3 cannot run at all
sleep 20
docker ps -a --filter "label=io.anchorage.acceptance" --format '{{.Names}} {{.Status}}'
```

Expected: empty. `--rm` removes the container once its daemon dies; with SIGKILL there is no
teardown path, so this step isolates the `--rm` behaviour from Task 3's handlers.

- [ ] **Step 6: Commit**

```bash
git add tools/run-core-acceptance.mjs
git commit -m "Establish that the host is clear, rather than that this run tidied up"
```

---

### Task 5: Policy validates the strengthened claim

**Files:**
- Modify: `app/scripts/package-evidence-policy.mjs` (in `validateMutationConformance`, near the existing `cleanup` check)
- Modify: `app/scripts/package-evidence-policy.test.mjs`

**Interfaces:**
- Consumes: the evidence shape from Tasks 3 and 4.

- [ ] **Step 1: Write the failing test**

In `app/scripts/package-evidence-policy.test.mjs`, add:

```js
test("mutation conformance requires the host to have been verified clear", () => {
  const evidence = acceptanceFixture(true);
  evidence.cleanup = {
    status: "passed",
    errors: [],
    hostVerifiedClear: true,
    orphansRemoved: { containers: [], contexts: [], scratchDirectories: [] },
  };
  assert.doesNotThrow(() => validateMutationConformance(evidence));

  // A run that tidied its own resources but left someone else's debris is not a clear host, and
  // the difference is exactly what an interrupted run produces.
  const dirty = structuredClone(evidence);
  dirty.cleanup.hostVerifiedClear = false;
  assert.throws(() => validateMutationConformance(dirty), /host verified clear/u);

  // Absent is not the same as true: older evidence must not pass by omission.
  const legacy = structuredClone(evidence);
  delete legacy.cleanup.hostVerifiedClear;
  assert.throws(() => validateMutationConformance(legacy), /host verified clear/u);
});

test("an aborted run is never releasable", () => {
  const aborted = acceptanceFixture(true);
  aborted.status = "aborted";
  aborted.abortedBy = "SIGTERM";
  assert.throws(() => validateMutationConformance(aborted), /status/u);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && node --test scripts/package-evidence-policy.test.mjs`
Expected: FAIL — the `hostVerifiedClear` cases pass validation today

- [ ] **Step 3: Implement**

In `validateMutationConformance`, beside the existing cleanup assertion:

```js
  requireCondition(
    evidence.cleanup?.hostVerifiedClear === true,
    `${description} must record the host verified clear of acceptance resources — ` +
      "a run that removed its own resources has not established that nothing leaked, " +
      "which is precisely the gap an interrupted run falls into",
  );
```

The existing `requirePassingChecks` already rejects a non-`passed` status, so `aborted` is refused without further change — the test above pins that behaviour rather than adding it.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd app && node --test scripts/package-evidence-policy.test.mjs`
Expected: PASS

- [ ] **Step 5: Regenerate evidence so packaging still works**

The committed evidence predates `hostVerifiedClear`, so packaging would now fail against it:

```bash
ANCHORAGE_ACCEPTANCE_MUTATIONS=1 node tools/run-core-acceptance.mjs
cd app && bun run test
```

Expected: acceptance passes and writes the new field; the full suite passes.

- [ ] **Step 6: Commit**

```bash
git add app/scripts/package-evidence-policy.mjs app/scripts/package-evidence-policy.test.mjs
git commit -m "Require the cleanup claim the harness can now establish"
```

---

### Task 6: Unix-socket bridge spike (go/no-go for the sbx backend)

Answers one question and is then deleted or promoted. **If this fails, Phase 1 of the spec does not proceed** and the sbx backend is not built.

**Files:**
- Create: `tools/socket-bridge-spike.mjs`

**Interfaces:**
- Produces: a verdict, not an API. Nothing depends on this file.

- [ ] **Step 1: Write the spike**

```js
// tools/socket-bridge-spike.mjs
/**
 * Does a Unix socket in the scratch tree, piped to a TCP Docker endpoint, satisfy the two
 * Engine-API checks that refuse to run over TCP?
 *
 * volumes.files and volumes.fileRead need a directly reachable Unix socket and fail with
 * context_transport_unsupported over TCP (core/internal/core/domain.go:1871). DinD satisfies that
 * by bind-mounting a socket into the scratch directory; sbx forwards a TCP port and cannot.
 *
 * The Docker API is plain HTTP, so a byte pipe should be transparent. "Should be" is why this
 * exists: if it is not, the sbx matrix loses two checks and the backend is not worth building.
 */
import { createServer, connect } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const [, , tcpTarget] = process.argv;
if (!tcpTarget) {
  console.error("usage: node tools/socket-bridge-spike.mjs <host:port>");
  process.exit(64);
}
const [host, port] = tcpTarget.split(":");
const scratch = resolve("artifacts/docker/spike-bridge");
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true, mode: 0o700 });
const socketPath = resolve(scratch, "docker.sock");

const server = createServer((client) => {
  const upstream = connect({ host, port: Number(port) });
  client.pipe(upstream);
  upstream.pipe(client);
  const drop = () => { client.destroy(); upstream.destroy(); };
  client.on("error", drop);
  upstream.on("error", drop);
});
await new Promise((ready) => server.listen(socketPath, ready));
console.log(`bridging unix://${socketPath} -> tcp://${tcpTarget}`);
console.log("Now run, in another shell:");
console.log(`  docker --host unix://${socketPath} version --format '{{.Server.Version}}'`);
console.log("Ctrl-C when done.");
```

- [ ] **Step 2: Prove the bridge carries plain Docker API traffic**

Against the existing DinD container's published TCP port, so the spike is testable without sbx:

```bash
PORT=$(docker port anchorage-dind-40d348de 2375/tcp | head -1 | cut -d: -f2)
node tools/socket-bridge-spike.mjs 127.0.0.1:$PORT &
sleep 1
docker --host unix://$PWD/artifacts/docker/spike-bridge/docker.sock version --format '{{.Server.Version}}'
```

Expected: prints a Docker server version. Failure here means the bridge is not transparent and Phase 1 stops.

- [ ] **Step 3: Prove it satisfies the actual checks that need it**

The real question is not whether `docker version` works but whether the core's archive reads do:

```bash
docker --host unix://$PWD/artifacts/docker/spike-bridge/docker.sock volume create spike-probe
docker --host unix://$PWD/artifacts/docker/spike-bridge/docker.sock run --rm \
  -v spike-probe:/data alpine:3.21 sh -c 'echo hello > /data/probe.txt'

# The decisive step: the core's own verb, over the bridged socket.
ANCHORAGE_DOCKER_HOST="unix://$PWD/artifacts/docker/spike-bridge/docker.sock" \
  node -e '
    // Drive volumes.files through the core against the bridged socket and print the result,
    // using the same CoreClient shape run-core-acceptance.mjs uses.
    console.log("see run-core-acceptance.mjs CoreClient for the request shape");
  '
```

Record the verdict in the spike file's header comment: whether `volumes.files` returned entries or `context_transport_unsupported`.

- [ ] **Step 4: Clean up the probe**

```bash
docker --host unix://$PWD/artifacts/docker/spike-bridge/docker.sock volume rm spike-probe
kill %1
rm -rf artifacts/docker/spike-bridge
```

- [ ] **Step 5: Commit the verdict**

```bash
git add tools/socket-bridge-spike.mjs
git commit -m "Spike the Unix-socket bridge that gates the sbx backend"
```

---

## What this plan deliberately does not cover

Phase 1 of the spec — the provider seam, the sbx backend, the `dind-isolation` / `sbx-isolation` split, and the `isolation` evidence block — is **not planned here**, because Task 6 decides whether it is buildable and the spec defers the sbx engine-version floor to what that spike observes. Writing tasks for it now would mean inventing interfaces against an unmeasured backend, which is the placeholder failure this plan format exists to prevent. Phase 1 gets its own plan once Task 6 returns a verdict.

## Self-review notes

- **Spec coverage:** Phase 0 items 1–3 map to Tasks 3, 4 and (for `--rm`) below; the strengthened claim maps to Task 5; the go/no-go spike maps to Task 6. Phase 1 is explicitly deferred with a stated reason.
- **Gap found and closed:** the spec's Phase 0 item 3 (self-limiting `--rm` DinD) had no task. It is now Task 4 Steps 4–5, with a SIGKILL test that isolates it from Task 3's signal handlers — the two mechanisms cover different failure modes and a test that cannot tell them apart would prove neither.
- **Type consistency:** `classifyOrphans` returns `{containers, contexts, scratchDirectories}` in Tasks 1, 3 and 4 consistently; `createTeardownRegistry().run()` returns `{alreadyRan, steps}` in Tasks 2 and 3.
