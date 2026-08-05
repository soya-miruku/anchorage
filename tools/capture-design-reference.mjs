#!/usr/bin/env node

/**
 * Renders the design handoff comp to the 24 canonical reference captures.
 *
 * Why this exists: the baseline shipped in `docs/design_handoff_anchorage/reference-captures/`
 * is a render of the **v1** comp, taken in the initial commit. The build has since migrated to
 * the v2 handoff, so every state measured 0.098-0.123 normalized MAE against a 0.02 threshold —
 * not because the build drifted, but because the ruler did. The proof is that the v1 baseline is
 * just as far from the v2 comp (0.098 on Containers) as it is from the build (0.110): the
 * disagreement is between the two comps, and the build sits with the newer one.
 *
 * The baseline is therefore generated rather than pasted, from whichever comp is the current
 * source of record, and its provenance records the comp's own hash so a stale baseline is a
 * detectable fact rather than a silent one.
 *
 * Run: `node tools/capture-design-reference.mjs [--comp <path>] [--out <dir>]`
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "..");

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const compPath = resolve(
  workspaceRoot,
  flag("comp", "docs/design_handoff_anchorage/Anchorage v2.dc.html"),
);
const outputDirectory = resolve(
  workspaceRoot,
  flag("out", "docs/design-qa/reference"),
);
const electronPath = resolve(
  workspaceRoot,
  "app/node_modules/electron/dist/electron",
);
const canonicalViewport = { width: 1656, height: 1056 };

/**
 * The comp carries no test ids — it is a `<sc-for>`/`<sc-if>` template document rendered by
 * `support.js`, so every step is expressed against what the design actually puts on screen.
 * `--comp` accepts the v1 file too, which is what makes the two directly comparable.
 */
const states = [
  { id: "containers" },
  { id: "containers-current", click: ["Containers 5"] },
  { id: "containers-only-running", click: ["Only running"] },
  { id: "containers-search-empty", type: "no-match-container" },
  { id: "containers-row-hover", hoverFirstContainerRow: true },
  { id: "containers-banner-dismissed", click: ["Dismiss"] },
  { id: "container-detail-logs", openContainer: true, click: ["Logs"] },
  { id: "container-detail-inspect", openContainer: true, click: ["Inspect"] },
  { id: "container-detail-mounts", openContainer: true, click: ["Bind mounts"] },
  { id: "container-detail-exec", openContainer: true, click: ["Exec"] },
  { id: "container-detail-files", openContainer: true, click: ["Files"] },
  { id: "container-detail-stats", openContainer: true, click: ["Stats"] },
  { id: "dashboard", click: ["Dashboard"] },
  { id: "images-local", click: ["Images"] },
  { id: "images-registry", click: ["Images", "Registry search"] },
  { id: "volumes", click: ["Volumes"] },
  { id: "builds", click: ["Builds"] },
  { id: "dev-environments", click: ["Dev Environments"] },
  { id: "extensions", click: ["Extensions"] },
  { id: "settings-resources", click: ["Settings", "Resources"] },
  { id: "settings-engine", click: ["Settings", "Engine"] },
  { id: "settings-kubernetes", click: ["Settings", "Kubernetes"] },
  { id: "settings-updates", click: ["Settings", "Software updates"] },
  { id: "settings-advanced", click: ["Settings", "Advanced"] },
];

async function fileEvidence(path) {
  const bytes = await readFile(path);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const runnerDirectory = resolve(outputDirectory, ".runner");
await mkdir(runnerDirectory, { recursive: true });
await writeFile(
  resolve(runnerDirectory, "package.json"),
  `${JSON.stringify({ name: "anchorage-design-reference", main: "main.cjs" }, null, 2)}\n`,
);
await writeFile(
  resolve(runnerDirectory, "main.cjs"),
  await readFile(resolve(dirname(scriptPath), "design-reference-runner.cjs")),
);

const child = spawn(
  electronPath,
  [runnerDirectory, compPath, outputDirectory, JSON.stringify(states)],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let stdout = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  process.stdout.write(chunk);
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const exitCode = await new Promise((resolveExit) => {
  child.on("close", resolveExit);
});
if (exitCode !== 0) {
  process.stderr.write(stderr);
  throw new Error(`Reference capture runner exited with ${exitCode}`);
}

const report = JSON.parse(
  await readFile(resolve(outputDirectory, "capture-report.json"), "utf8"),
);
const misses = report.filter((entry) =>
  entry.steps.some((step) => String(step).startsWith("MISS")),
);
if (misses.length > 0) {
  throw new Error(
    `States whose steps did not resolve against the comp: ${misses
      .map((entry) => `${entry.id} (${entry.steps.join(", ")})`)
      .join("; ")}`,
  );
}

await rm(runnerDirectory, { recursive: true, force: true });
await rm(resolve(outputDirectory, "capture-report.json"), { force: true });

const captured = (await readdir(outputDirectory)).filter((name) =>
  name.endsWith(".png"),
);
if (captured.length !== states.length) {
  throw new Error(
    `Expected ${states.length} captures, wrote ${captured.length}`,
  );
}

const provenance = {
  schemaVersion: 1,
  captureMode: "design-comp",
  capturedAt: new Date().toISOString(),
  comp: {
    path: relative(workspaceRoot, compPath),
    ...(await fileEvidence(compPath)),
  },
  compRuntime: {
    path: relative(
      workspaceRoot,
      resolve(dirname(compPath), "support.js"),
    ),
    ...(await fileEvidence(resolve(dirname(compPath), "support.js"))),
  },
  canonicalViewport,
  harness: {
    path: relative(workspaceRoot, scriptPath),
    ...(await fileEvidence(scriptPath)),
  },
  runner: {
    path: "tools/design-reference-runner.cjs",
    ...(await fileEvidence(resolve(dirname(scriptPath), "design-reference-runner.cjs"))),
  },
  // The comp drives seven timers over randomised values, so two captures of one state are never
  // byte-identical. Measured self-disagreement is 0.0001-0.0002 normalized MAE, two orders of
  // magnitude under the review threshold, which is why a live comp can still serve as a baseline.
  determinism:
    "The comp animates from Math.random() on seven intervals; each capture fixes one sample. Measured state-to-state noise is ~0.0002 normalized MAE.",
  states: await Promise.all(
    states.map(async (state) => ({
      state: state.id,
      path: `${relative(workspaceRoot, outputDirectory)}/${state.id}.png`,
      ...(await fileEvidence(resolve(outputDirectory, `${state.id}.png`))),
      steps: report.find((entry) => entry.id === state.id)?.steps ?? [],
    })),
  ),
};

await writeFile(
  resolve(outputDirectory, "reference-provenance.json"),
  `${JSON.stringify(provenance, null, 2)}\n`,
);

process.stdout.write(
  `Captured ${captured.length} reference states from ${basename(compPath)}\n`,
);
