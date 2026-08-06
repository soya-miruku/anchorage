#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DESIGN_PARITY_STATE_IDS,
  DESIGN_VISUAL_CONFORMANCE_CLAIM,
  DESIGN_VISUAL_CONFORMANCE_THRESHOLD,
  DESIGN_VISUAL_DIVERGENCE_CEILING,
  DESIGN_VISUAL_REVIEW_CRITERIA,
} from "../app/scripts/package-evidence-policy.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "..");
const handoffDirectory = resolve(
  workspaceRoot,
  "docs/design_handoff_anchorage",
);
/**
 * The baseline is generated from the current comp by `tools/capture-design-reference.mjs`, not
 * pasted from the handoff. `docs/design_handoff_anchorage/reference-captures/` holds renders of
 * the **v1** comp taken in the initial commit; measuring the v2 build against them scored
 * 0.098-0.123 on a 0.02 threshold, and the tell was that those same images sit 0.098 from the v2
 * comp itself. The disagreement was between the two comps, so the ruler moved rather than the
 * build. The v1 set is kept as shipped and no longer measured against.
 */
const referenceDirectory = resolve(workspaceRoot, "docs/design-qa/reference");
const referenceProvenancePath = resolve(
  referenceDirectory,
  "reference-provenance.json",
);
const actualDirectory = resolve(
  workspaceRoot,
  process.env.ANCHORAGE_ACTUAL_CAPTURE_DIRECTORY ??
    "docs/design-qa/final-actual",
);
const outputDirectory = resolve(workspaceRoot, "artifacts/design");
const reviewAttestationPath = resolve(
  workspaceRoot,
  "docs/design-qa/visual-review-attestation.json",
);
const reviewThreshold = DESIGN_VISUAL_CONFORMANCE_THRESHOLD;
const masksByState = {
  "container-detail-stats": [
    {
      x: 294,
      y: 430,
      width: 1_284,
      height: 127,
      reason: "CPU history samples are live values; the surrounding panel, label, and chart geometry remain unmasked.",
    },
    {
      x: 294,
      y: 700,
      width: 1_284,
      height: 70,
      reason: "Memory history samples are live values; the surrounding panel, label, and chart geometry remain unmasked.",
    },
  ],
};

const states = DESIGN_PARITY_STATE_IDS;

function run(command, args, { expected = [0] } = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    shell: false,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!expected.includes(result.status)) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}: ${result.stderr}`,
    );
  }
  return result;
}

function dimensions(path) {
  const result = run("magick", ["identify", "-format", "%w %h", path]);
  const [width, height] = result.stdout.trim().split(/\s+/u).map(Number);
  return { width, height };
}

function compare(reference, actual, diff) {
  const result = run(
    "magick",
    ["compare", "-metric", "MAE", reference, actual, diff],
    { expected: [0, 1] },
  );
  const match = result.stderr
    .trim()
    .match(/([0-9]+(?:\.[0-9]+)?)\s+\(([0-9.eE+-]+)\)/u);
  if (!match) {
    throw new Error(`Could not parse ImageMagick MAE: ${result.stderr}`);
  }
  return {
    absolute: Number(match[1]),
    normalized: Number(match[2]),
  };
}

async function hashDirectory(directory) {
  const files = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(directory);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const path of files) {
    const content = await readFile(path);
    hash.update(relative(directory, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(String(content.byteLength));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
    bytes += content.byteLength;
  }
  return { sha256: hash.digest("hex"), files: files.length, bytes };
}

async function hashDesignHandoffSource() {
  const files = [
    resolve(handoffDirectory, "Anchorage v2.dc.html"),
    resolve(handoffDirectory, "README.md"),
    resolve(handoffDirectory, "support.js"),
  ];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(referenceDirectory);
  // Sorted and hashed by the same workspace-relative name that `app/scripts/package-desktop.mjs`
  // uses, because preflight compares the two digests. The file list now spans two trees, so
  // sorting by absolute path and hashing by relative name would only agree by coincidence.
  const entries = await Promise.all(
    files.map(async (path) => ({
      name: relative(workspaceRoot, path).split(sep).join("/"),
      content: await readFile(path),
    })),
  );
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const hash = createHash("sha256");
  let bytes = 0;
  for (const { name, content } of entries) {
    hash.update(name);
    hash.update("\0");
    hash.update(String(content.byteLength));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
    bytes += content.byteLength;
  }
  const provenance = JSON.parse(await readFile(referenceProvenancePath, "utf8"));
  return {
    scope: "anchorage-design-handoff-v2",
    sha256: hash.digest("hex"),
    files: entries.length,
    bytes,
    declaredSources: [
      "docs/design_handoff_anchorage/Anchorage v2.dc.html",
      "docs/design_handoff_anchorage/README.md",
      "docs/design_handoff_anchorage/support.js",
    ],
    referenceDirectory: "docs/design-qa/reference",
    // The baseline is a render of the comp, so the comp's own hash travels with it. A handoff
    // that moves again leaves this disagreeing with the file on disk, which is the whole point:
    // the v1 baseline went stale silently and cost a release cycle of unexplained failures.
    referenceGeneratedFrom: provenance.comp,
    referenceHarness: provenance.harness,
    supersededBaseline: {
      path: "docs/design_handoff_anchorage/reference-captures",
      note: "Renders of Anchorage.dc.html (v1) from the initial commit, kept as shipped. Stored as quality-80 JPEG under a .png extension, which alone costs ~0.004 normalized MAE against any exact render.",
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sameBuild(left, right) {
  return (
    left?.sha256 === right.sha256 &&
    left?.files === right.files &&
    left?.bytes === right.bytes
  );
}

async function fileEvidence(path) {
  const content = await readFile(path);
  return {
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
    dimensions: dimensions(path),
  };
}

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function sameImageEvidence(actual, expected) {
  return (
    actual?.sha256 === expected.sha256 &&
    actual?.bytes === expected.bytes &&
    actual?.dimensions?.width === expected.dimensions.width &&
    actual?.dimensions?.height === expected.dimensions.height
  );
}

function applyMasks(input, output, masks) {
  const args = [input];
  for (const mask of masks) {
    args.push(
      "-fill",
      "#000000",
      "-draw",
      `rectangle ${mask.x},${mask.y} ${mask.x + mask.width - 1},${mask.y + mask.height - 1}`,
    );
  }
  args.push(output);
  run("magick", args);
}

await Promise.all([
  mkdir(resolve(outputDirectory, "reference"), { recursive: true }),
  mkdir(resolve(outputDirectory, "actual"), { recursive: true }),
  mkdir(resolve(outputDirectory, "diffs"), { recursive: true }),
  mkdir(resolve(outputDirectory, "masked", "reference"), { recursive: true }),
  mkdir(resolve(outputDirectory, "masked", "actual"), { recursive: true }),
]);

const rendererBuild = await hashDirectory(
  resolve(workspaceRoot, "app/dist/client"),
);
const handoffSource = await hashDesignHandoffSource();
const captureProvenance = JSON.parse(
  await readFile(
    resolve(actualDirectory, "capture-provenance.json"),
    "utf8",
  ),
);
assert(
  captureProvenance.schemaVersion === 1 &&
    captureProvenance.captureMode === "fixture-browser" &&
    captureProvenance.bridgeMode === "fixture" &&
    captureProvenance.source === "app/dist/client",
  "Capture provenance must identify the deterministic fixture-browser renderer source",
);
assert(
  captureProvenance.canonicalViewport?.width === 1656 &&
    captureProvenance.canonicalViewport?.height === 1056,
  "Capture provenance must use the canonical 1656 x 1056 viewport",
);
assert(
  sameBuild(captureProvenance.rendererBuild, rendererBuild),
  "Capture provenance does not match the current renderer build",
);
assert(
  captureProvenance.harness?.path ===
    "tools/capture-design-parity.mjs" &&
    /^[0-9a-f]{64}$/u.test(captureProvenance.harness?.sha256 ?? ""),
  "Capture provenance must identify the capture harness",
);
assert(
  typeof captureProvenance.runtime?.product === "string" &&
    captureProvenance.runtime.product.length > 0 &&
    typeof captureProvenance.runtime?.userAgent === "string" &&
    captureProvenance.runtime.userAgent.includes("Electron"),
  "Capture provenance must identify the Electron and Chromium runtime",
);
const captureStates = new Map(
  (captureProvenance.states ?? []).map((entry) => [entry.state, entry]),
);
assert(
  captureStates.size === states.length &&
    states.every((state) => captureStates.has(state)),
  "Capture provenance must contain exactly the canonical states",
);

const reviewAttestationContent = await readFile(reviewAttestationPath);
const reviewAttestation = JSON.parse(
  reviewAttestationContent.toString("utf8"),
);
const reviewAttestationSource = {
  path: "docs/design-qa/visual-review-attestation.json",
  sha256: createHash("sha256")
    .update(reviewAttestationContent)
    .digest("hex"),
  bytes: reviewAttestationContent.byteLength,
};
assert(
  reviewAttestation.schemaVersion === 1 &&
    reviewAttestation.claim === DESIGN_VISUAL_CONFORMANCE_CLAIM &&
    typeof reviewAttestation.reviewedAt === "string" &&
    Number.isFinite(Date.parse(reviewAttestation.reviewedAt)) &&
    Date.parse(reviewAttestation.reviewedAt) <= Date.now(),
  "Visual review attestation must identify a completed reviewed-conformance claim",
);
const reviewStates = new Map(
  (reviewAttestation.states ?? []).map((entry) => [
    entry.state,
    entry,
  ]),
);
assert(
  Array.isArray(reviewAttestation.states) &&
    reviewAttestation.states.length === states.length &&
    reviewStates.size === states.length &&
    states.every((state) => reviewStates.has(state)),
  "Visual review attestation must contain exactly the canonical states",
);
for (const state of states) {
  const review = reviewStates.get(state);
  assert(
    review?.status === "approved" &&
      review.reviewer?.kind === "agent-visual-review" &&
      typeof review.reviewer?.name === "string" &&
      review.reviewer.name.trim().length > 0 &&
      sameStringArray(
        review.criteria,
        DESIGN_VISUAL_REVIEW_CRITERIA,
      ) &&
      typeof review.notes === "string" &&
      review.notes.trim().length >= 20,
    `Visual review attestation is incomplete for ${state}`,
  );
}

const rows = [];
for (const state of states) {
  const filename = `${state}.png`;
  const reference = resolve(referenceDirectory, filename);
  const actual = resolve(actualDirectory, filename);
  const diff = resolve(outputDirectory, "diffs", filename);
  let referenceSize;
  let actualSize;
  let referenceEvidence;
  let actualEvidence;
  try {
    referenceSize = dimensions(reference);
    actualSize = dimensions(actual);
    referenceEvidence = await fileEvidence(reference);
    actualEvidence = await fileEvidence(actual);
    const recorded = captureStates.get(state);
    assert(
      recorded?.sha256 === actualEvidence.sha256 &&
        recorded?.bytes === actualEvidence.bytes &&
        recorded?.dimensions?.width === actualEvidence.dimensions.width &&
        recorded?.dimensions?.height === actualEvidence.dimensions.height,
      `Capture provenance does not match ${filename}`,
    );
    const review = reviewStates.get(state);
    assert(
      review.reference?.path === `docs/design-qa/reference/${filename}` &&
        sameImageEvidence(review.reference, referenceEvidence) &&
        review.actual?.path ===
          `docs/design-qa/final-actual/${filename}` &&
        sameImageEvidence(review.actual, actualEvidence),
      `Visual review attestation does not bind ${filename}. The attestation is bound by SHA-256 to both images it describes, so regenerating either side invalidates it on purpose — an approval may not outlive what it approved. Re-review the state and update docs/design-qa/visual-review-attestation.json with the new fingerprints.`,
    );
  } catch (error) {
    rows.push({
      state,
      status: "missing",
      reason: error.message,
      reference: `reference/${filename}`,
      actual: `actual/${filename}`,
      diff: `diffs/${filename}`,
    });
    continue;
  }

  const sameDimensions =
    referenceSize.width === actualSize.width &&
    referenceSize.height === actualSize.height;
  if (!sameDimensions) {
    rows.push({
      state,
      status: "failed",
      reason: "Capture dimensions do not match the canonical reference",
      referenceSize,
      actualSize,
      reference: `reference/${filename}`,
      actual: `actual/${filename}`,
      diff: null,
    });
    continue;
  }

  const masks = masksByState[state] ?? [];
  let comparisonReference = reference;
  let comparisonActual = actual;
  if (masks.length > 0) {
    comparisonReference = resolve(
      outputDirectory,
      "masked",
      "reference",
      filename,
    );
    comparisonActual = resolve(
      outputDirectory,
      "masked",
      "actual",
      filename,
    );
    applyMasks(reference, comparisonReference, masks);
    applyMasks(actual, comparisonActual, masks);
  }
  const mae = compare(comparisonReference, comparisonActual, diff);
  const withinReviewThreshold = mae.normalized <= reviewThreshold;
  const review = reviewStates.get(state);
  /**
   * A state over the threshold is `budgeted` rather than `failed` only when the review wrote down
   * both a ceiling and what accounts for it, and the measurement is still under that ceiling.
   * Anything else — no record, empty reasons, or error grown past the recorded number — fails.
   */
  const divergence = review?.divergence;
  const budgeted =
    !withinReviewThreshold &&
    typeof divergence?.budget === "number" &&
    divergence.budget <= DESIGN_VISUAL_DIVERGENCE_CEILING &&
    divergence.budget > reviewThreshold &&
    Array.isArray(divergence.reasons) &&
    divergence.reasons.length > 0 &&
    mae.normalized <= divergence.budget;
  const status = withinReviewThreshold
    ? "passed"
    : budgeted
      ? "budgeted"
      : "failed";
  rows.push({
    state,
    status,
    canonicalDimensions: referenceSize,
    mae,
    reviewThreshold,
    divergenceCeiling: DESIGN_VISUAL_DIVERGENCE_CEILING,
    ...(divergence
      ? {
          divergence: {
            ...divergence,
            headroom: Number((divergence.budget - mae.normalized).toFixed(6)),
            // A budget on a state that now measures under the threshold has been earned back
            // and should be deleted rather than left to quietly authorise future drift.
            retirable: withinReviewThreshold,
          },
        }
      : {}),
    maskedRegions: masks,
    referenceEvidence,
    actualEvidence,
    visualReview: {
      status: review.status,
      reviewer: review.reviewer,
      criteria: review.criteria,
      notes: review.notes,
    },
    reviewScope:
      "Visible geometry, typography, colour, borders, radii, spacing, icons, layer order, clipping, and scroll behavior. Only the recorded Stats history masks and operating-system font rasterization are expected variance in this deterministic fixture capture.",
    reference: `reference/${filename}`,
    actual: `actual/${filename}`,
    diff: `diffs/${filename}`,
  });
  await Promise.all([
    copyFile(reference, resolve(outputDirectory, "reference", filename)),
    copyFile(actual, resolve(outputDirectory, "actual", filename)),
  ]);
}

const counts = rows.reduce(
  (summary, row) => {
    summary[row.status] = (summary[row.status] ?? 0) + 1;
    return summary;
  },
  {},
);
const ledger = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  claim: DESIGN_VISUAL_CONFORMANCE_CLAIM,
  canonicalViewport: { width: 1656, height: 1056 },
  designViewport: { width: 1600, height: 1000 },
  referenceSource:
    "docs/design-qa/reference, generated from docs/design_handoff_anchorage/Anchorage v2.dc.html",
  reviewRecorded: true,
  generator: {
    path: "tools/measure-design-parity.mjs",
    sha256: createHash("sha256")
      .update(await readFile(scriptPath))
      .digest("hex"),
  },
  handoffSource,
  visualReviewAttestation: {
    source: reviewAttestationSource,
    attestation: reviewAttestation,
  },
  rendererBuild,
  captureProvenance,
  automatedMetric:
    "ImageMagick normalized mean absolute pixel error, used for triage rather than as a substitute for paired visual review",
  summary: {
    total: rows.length,
    ...counts,
  },
  rows,
};

await writeFile(
  resolve(outputDirectory, "design-ledger.json"),
  `${JSON.stringify(ledger, null, 2)}\n`,
);

const complete = rows.every(
  (row) => row.status === "passed" || row.status === "budgeted",
);
process.stdout.write(
  `${complete ? "PASS" : "INCOMPLETE"}: ${basename(actualDirectory)} — ${JSON.stringify(counts)}\n`,
);
if (!complete) process.exitCode = 1;
