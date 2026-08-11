#!/usr/bin/env node
/*
Regenerates the core evidence set only when it does not already describe this core.

The three artifacts — mutation conformance, the capability ledger, performance and the RSS soak
— are bound by SHA-256 to one core binary, and package-desktop.mjs refuses any set that names a
different one. That binding is what makes reuse safe rather than optimistic: evidence about a
binary is evidence about that binary whenever it was measured, and the gate already checks the
name matches. Re-measuring an unchanged core takes forty minutes to produce a slightly different
number about the same bytes.

So this is a content-addressed skip, the same idea a build cache uses: hash the inputs, and if
the recorded output already names that hash, do nothing. Most commits touch the renderer and
not the Go source, and for those this turns a forty-minute release build into a few seconds.

The key is not the core hash alone. Acceptance and the capability ledger measure the core
*against a daemon*, so evidence gathered against Docker 29.7 says nothing certain about 30.0,
and the soak's figures belong to the machine that produced them. Core hash, daemon version and
architecture together are what has to match for the earlier run to still be about this one.

The key also covers the harness, not only its subject. Evidence is the output of a measuring
program, and editing that program can change what the measurement means without touching a byte
of Go — this is not hypothetical, it is what the branch that added the host-clear sweep did.
Every reason this script skips must therefore be a reason package-desktop.mjs would also accept,
because a skip it does not share is not a saved forty minutes: it is a release that fails at the
gate having been told there was nothing to regenerate.

Deliberately not cached: anything measured by looking at a live daemon's contents, which is
every check in the read-only half. Those are re-run by package:linux itself against the freshly
staged core, and this only governs the expensive generation step ahead of it.

  node tools/ensure-core-evidence.mjs           # regenerate only what is stale
  node tools/ensure-core-evidence.mjs --force   # regenerate regardless
*/
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
const corePath = resolve(workspaceRoot, "core/bin/anchorage-core");
const acceptanceGeneratorPath = resolve(
  workspaceRoot,
  "tools/run-core-acceptance.mjs",
);
const force = process.argv.includes("--force");

function run(command, args, environment = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: { ...process.env, ...environment },
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code) =>
      code === 0
        ? resolveRun()
        : rejectRun(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
  });
}

function capture(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: workspaceRoot });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", () => resolveRun(null));
    child.once("exit", (code) => resolveRun(code === 0 ? stdout.trim() : null));
  });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(resolve(workspaceRoot, path), "utf8"));
  } catch {
    return null;
  }
}

const core = await readFile(corePath).catch(() => null);
if (!core) {
  console.error(
    `No core at ${corePath}. Build it first:\n` +
      "  cd core && CGO_ENABLED=0 go build -trimpath -buildvcs=false " +
      '-ldflags="-s -w -buildid=" -o bin/anchorage-core ./cmd/anchorage-core',
  );
  process.exit(1);
}
const coreSha256 = createHash("sha256").update(core).digest("hex");
/*
 * The harness that produced the acceptance evidence, hashed the same way the packaging gate
 * hashes it (assertCurrentFileHash, package-desktop.mjs), so the two agree on what "current"
 * means. Without this, editing the harness alone left every other part of the key matching: the
 * script reported "nothing to regenerate", and package:linux then refused the very evidence it
 * had just been told was fine — twice over, once for the generator hash and once for the
 * host-clear claim below that older runs never recorded at all.
 */
const acceptanceGenerator = await readFile(acceptanceGeneratorPath).catch(
  () => null,
);
const acceptanceGeneratorSha256 = acceptanceGenerator
  ? createHash("sha256").update(acceptanceGenerator).digest("hex")
  : null;
const dockerServer =
  (await capture("docker", ["version", "--format", "{{.Server.Version}}"])) ??
  "unknown";
const architecture = os.arch();

const [conformance, capability, performanceEnvironment] = await Promise.all([
  readJson("artifacts/docker/conformance-results.json"),
  readJson("artifacts/docker/capability-generation.json"),
  readJson("artifacts/performance/environment.json"),
]);

/*
 * Every part of the key must match, and a missing artifact is a mismatch rather than a pass.
 * `mutationsEnabled` is in here because the read-only run writes the same file with a smaller
 * matrix: reusing that as if it were the full 26 would be exactly the kind of quiet
 * substitution the binding exists to prevent.
 */
const recordedDockerServer =
  performanceEnvironment?.tools?.docker?.server?.version ?? null;
const recordedArchitecture = performanceEnvironment?.host?.architecture ?? null;

/*
 * The performance artifacts carry no core hash of their own — package-desktop.mjs computes that
 * binding at packaging time — so they are checked by age against the binary instead, the same
 * technique assertArtifactNewerThan uses elsewhere here.
 *
 * Without it the set could be checked as if it were one thing when it is three. The first run of
 * this script was interrupted during the soak, which left conformance and the capability ledger
 * naming the new core and the soak still describing the old one; every hash matched and it
 * reported nothing to regenerate. Found by interrupting it, not by reading it.
 */
const performanceMeasuredMs = await stat(
  resolve(workspaceRoot, "artifacts/performance/results.json"),
)
  .then((info) => info.mtimeMs)
  .catch(() => 0);
const coreBuiltMs = (await stat(corePath)).mtimeMs;
const performanceStale = performanceMeasuredMs < coreBuiltMs;

/*
 * A run that could not establish the host was clear of acceptance debris is not evidence this
 * release may reuse — package-desktop.mjs requires the claim, and every artifact written before
 * the sweep existed lacks the field entirely. `!== true` rather than `=== false` is what makes
 * absence count as stale: the alternative reads a missing claim as a satisfied one.
 */
const recordedHostVerifiedClear =
  conformance?.cleanup?.evidence?.hostVerifiedClear ?? null;

const stale =
  force ||
  conformance?.coreSha256 !== coreSha256 ||
  conformance?.generator?.sha256 !== acceptanceGeneratorSha256 ||
  conformance?.mutationsEnabled !== true ||
  recordedHostVerifiedClear !== true ||
  capability?.coreSha256 !== coreSha256 ||
  recordedDockerServer !== dockerServer ||
  recordedArchitecture !== architecture ||
  performanceStale;

if (!stale) {
  console.log(
    `Core evidence already describes core ${coreSha256.slice(0, 16)} on ` +
      `Docker ${dockerServer}/${architecture}; nothing to regenerate.`,
  );
  console.log(
    "  Pass --force to measure it again anyway. Changing any core/**/*.go " +
      "invalidates this by changing the hash.",
  );
  process.exit(0);
}

const reason = force
  ? "--force"
  : !conformance || !capability
    // A first run, or one whose predecessor was interrupted before writing. Worth its own words:
    // "core changed (evidence names undefined)" describes a comparison that never happened.
    ? "no core evidence has been recorded yet"
    : conformance?.coreSha256 !== coreSha256
    ? `core changed (evidence names ${String(conformance?.coreSha256).slice(0, 16)}, ` +
      `this core is ${coreSha256.slice(0, 16)})`
    : conformance?.generator?.sha256 !== acceptanceGeneratorSha256
    ? `the acceptance harness changed (evidence was produced by ` +
      `${String(conformance?.generator?.sha256).slice(0, 16)}, ` +
      `tools/run-core-acceptance.mjs is now ${String(acceptanceGeneratorSha256).slice(0, 16)})`
    : conformance?.mutationsEnabled !== true
      ? "the recorded acceptance run did not include disposable mutations"
      : recordedHostVerifiedClear !== true
      ? recordedHostVerifiedClear === null
        ? "the recorded acceptance run predates the host-clear sweep and makes no claim at cleanup.evidence.hostVerifiedClear"
        : "the recorded acceptance run could not establish that the host was clear of acceptance resources"
      : capability?.coreSha256 !== coreSha256
        ? "the capability ledger names a different core"
        : recordedDockerServer !== dockerServer
          ? `daemon changed (evidence measured against ${recordedDockerServer}, this is ${dockerServer})`
          : recordedArchitecture !== architecture
            ? `architecture changed (evidence measured on ${recordedArchitecture}, this is ${architecture})`
            : "the soak predates this core binary";
console.log(`Regenerating core evidence: ${reason}.`);

// In this order, and never overlapping. The soak's latency SLO is a threshold on a shared
// daemon, so an acceptance run beside it measures the daemon rather than the core: one such
// overlap recorded 542 ms against a 500 ms limit where a clean re-run recorded 298 ms.
await run("node", ["tools/run-core-acceptance.mjs"], {
  ANCHORAGE_ACCEPTANCE_MUTATIONS: "1",
});
await run("node", ["tools/generate-capability-ledger.mjs"]);
await run("node", ["tools/run-performance-evidence.mjs"]);
console.log(`Core evidence now describes core ${coreSha256.slice(0, 16)}.`);
