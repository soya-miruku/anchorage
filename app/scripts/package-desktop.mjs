import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { extractFile, listPackage, statFile } from "@electron/asar";
import {
  HOST_CANDIDATE_SCREEN_IDS,
  canonicalPackagedPackageJson,
  validateCapabilityEvidence,
  validateDesignLedger,
  validateHostCandidateEvidence,
  validateMutationConformance,
  validatePackagedElectronRuntimeClosure,
  validatePerformanceEvidence,
  manifestEvidenceWithoutWallClock,
  validatePinnedDevDependencies,
  validateReadOnlyAcceptance,
  validateStagedCoreEvidenceHashes,
} from "./package-evidence-policy.mjs";

const APP_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_DIRECTORY = resolve(APP_DIRECTORY, "..");
const CORE_DIRECTORY = join(REPOSITORY_DIRECTORY, "core");
const PROTOCOL_DIRECTORY = join(REPOSITORY_DIRECTORY, "protocol");
const CORE_STAGE_DIRECTORY = join(APP_DIRECTORY, "build", "core");
const CORE_STAGE_BINARY = join(CORE_STAGE_DIRECTORY, "anchorage-core");
const CORE_MANIFEST = join(CORE_STAGE_DIRECTORY, "manifest.json");
const RELEASE_DIRECTORY = join(APP_DIRECTORY, "release");
const CORE_ACCEPTANCE_SCRIPT = join(
  REPOSITORY_DIRECTORY,
  "tools",
  "run-core-acceptance.mjs",
);
const SECURITY_EVIDENCE_SCRIPT = join(
  REPOSITORY_DIRECTORY,
  "tools",
  "generate-security-evidence.mjs",
);
const SECURITY_EVIDENCE_HELPER_TEST = join(
  REPOSITORY_DIRECTORY,
  "tools",
  "security-evidence-helpers.test.mjs",
);
const SECURITY_EVIDENCE_HELPER = join(
  REPOSITORY_DIRECTORY,
  "tools",
  "security-evidence-helpers.mjs",
);
const PACKAGE_EVIDENCE_POLICY = join(
  APP_DIRECTORY,
  "scripts",
  "package-evidence-policy.mjs",
);
const PACKAGE_EVIDENCE_POLICY_TEST = join(
  APP_DIRECTORY,
  "scripts",
  "package-evidence-policy.test.mjs",
);
const READ_ONLY_ACCEPTANCE_EVIDENCE = join(
  REPOSITORY_DIRECTORY,
  "artifacts",
  "docker",
  "read-only-acceptance.json",
);
const MUTATION_CONFORMANCE_EVIDENCE = join(
  REPOSITORY_DIRECTORY,
  "artifacts",
  "docker",
  "conformance-results.json",
);
const CAPABILITY_LEDGER_EVIDENCE = join(
  REPOSITORY_DIRECTORY,
  "artifacts",
  "docker",
  "capability-ledger.json",
);
const CAPABILITY_GENERATION_EVIDENCE = join(
  REPOSITORY_DIRECTORY,
  "artifacts",
  "docker",
  "capability-generation.json",
);
const SYSTEM_CAPABILITIES_EVIDENCE = join(
  REPOSITORY_DIRECTORY,
  "artifacts",
  "docker",
  "system-capabilities.json",
);
const DESIGN_LEDGER_EVIDENCE = join(
  REPOSITORY_DIRECTORY,
  "artifacts",
  "design",
  "design-ledger.json",
);
const DESIGN_HANDOFF_DIRECTORY = join(
  REPOSITORY_DIRECTORY,
  "docs",
  "design_handoff_anchorage",
);
/**
 * The measured baseline: renders of the current comp produced by
 * `tools/capture-design-reference.mjs`. It lives outside the handoff directory because it is
 * generated output, and because the handoff's own `reference-captures/` are v1 renders that the
 * v2 build can no longer be measured against.
 */
const DESIGN_REFERENCE_DIRECTORY = join(
  REPOSITORY_DIRECTORY,
  "docs",
  "design-qa",
  "reference",
);
const PERFORMANCE_RESULTS_EVIDENCE = join(
  REPOSITORY_DIRECTORY,
  "artifacts",
  "performance",
  "results.json",
);
const PERFORMANCE_ENVIRONMENT_EVIDENCE = join(
  REPOSITORY_DIRECTORY,
  "artifacts",
  "performance",
  "environment.json",
);
const ELECTRON_SECURITY_EVIDENCE = join(
  REPOSITORY_DIRECTORY,
  "artifacts",
  "security",
  "electron-config.json",
);
const DEPENDENCY_AUDIT_EVIDENCE = join(
  REPOSITORY_DIRECTORY,
  "artifacts",
  "security",
  "dependency-audit.json",
);
const DESIGN_EVIDENCE_SCRIPT = join(
  REPOSITORY_DIRECTORY,
  "tools",
  "measure-design-parity.mjs",
);
const DESIGN_CAPTURE_SCRIPT = join(
  REPOSITORY_DIRECTORY,
  "tools",
  "capture-design-parity.mjs",
);
const DESIGN_CAPTURE_PROVENANCE = join(
  REPOSITORY_DIRECTORY,
  "docs",
  "design-qa",
  "final-actual",
  "capture-provenance.json",
);
const DESIGN_VISUAL_REVIEW_ATTESTATION = join(
  REPOSITORY_DIRECTORY,
  "docs",
  "design-qa",
  "visual-review-attestation.json",
);
const HOST_CANDIDATE_SCRIPT = join(
  REPOSITORY_DIRECTORY,
  "tools",
  "capture-host-candidate.mjs",
);
const HOST_CANDIDATE_DIRECTORY = join(
  REPOSITORY_DIRECTORY,
  "artifacts",
  "host-candidate",
);
const HOST_CANDIDATE_EVIDENCE = join(
  HOST_CANDIDATE_DIRECTORY,
  "host-candidate.json",
);
const ELECTRON_BINARY = join(
  APP_DIRECTORY,
  "node_modules",
  "electron",
  "dist",
  "electron",
);
const CAPABILITY_EVIDENCE_SCRIPT = join(
  REPOSITORY_DIRECTORY,
  "tools",
  "generate-capability-ledger.mjs",
);
const PERFORMANCE_EVIDENCE_SCRIPT = join(
  REPOSITORY_DIRECTORY,
  "tools",
  "run-performance-evidence.mjs",
);
const UNPACKED_DIRECTORY = join(RELEASE_DIRECTORY, "linux-unpacked");
const PACKAGED_EXECUTABLE = join(UNPACKED_DIRECTORY, "anchorage");
const PACKAGED_ASAR = join(UNPACKED_DIRECTORY, "resources", "app.asar");
const PACKAGED_CORE = join(
  UNPACKED_DIRECTORY,
  "resources",
  "core",
  "anchorage-core",
);
const PACKAGED_MANIFEST = join(
  UNPACKED_DIRECTORY,
  "resources",
  "core",
  "manifest.json",
);
const RELEASE_VERIFICATION_REPORT = join(
  RELEASE_DIRECTORY,
  "release-verification.json",
);
const BUILDER_ENTRY = join(
  APP_DIRECTORY,
  "node_modules",
  "electron-builder",
  "out",
  "cli",
  "cli.js",
);
const BUILDER_CONFIG = join(APP_DIRECTORY, "electron-builder.yml");
const MODE = process.argv[2];
const VALID_MODES = new Set(["--preflight", "--dir", "--linux"]);
let candidateWorkStarted = false;

function fail(message) {
  throw new Error(message);
}

function log(message) {
  process.stdout.write(`[anchorage-package] ${message}\n`);
}

function normalizedRelative(parent, child) {
  return relative(parent, child).split(sep).join("/");
}

function assertGeneratedDirectory(candidate, parent, expectedName) {
  if (
    resolve(candidate) !== join(resolve(parent), expectedName) ||
    normalizedRelative(parent, candidate) !== expectedName
  ) {
    fail(`Refusing to clean unexpected generated directory: ${candidate}`);
  }
}

async function assertFile(path, description) {
  let info;
  try {
    info = await stat(path);
  } catch {
    fail(`${description} is missing: ${path}`);
  }
  if (!info.isFile()) {
    fail(`${description} is not a regular file: ${path}`);
  }
  return info;
}

async function collectFiles(directory, predicate = () => true) {
  const result = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && predicate(path)) {
        result.push(path);
      }
    }
  }
  await visit(directory);
  return result;
}

function run(command, args, {
  cwd = APP_DIRECTORY,
  env = process.env,
  capture = false,
  timeoutMs = 0,
} = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    let timer = null;
    let timedOut = false;

    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      }, timeoutMs);
      timer.unref();
    }

    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) {
        resolveRun({ stdout, stderr });
        return;
      }
      const detail = capture
        ? `\n${stdout}${stderr}`.trimEnd()
        : "";
      rejectRun(
        new Error(
          `${basename(command)} failed${timedOut ? " after timing out" : ""} ` +
            `(code ${String(code)}, signal ${String(signal)})${detail}`,
        ),
      );
    });
  });
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function hashNamedContents(entries) {
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
  return {
    sha256: hash.digest("hex"),
    files: entries.length,
    bytes,
  };
}

async function hashDirectory(directory) {
  const files = await collectFiles(directory);
  const entries = [];
  for (const file of files) {
    entries.push({
      name: normalizedRelative(directory, file),
      content: await readFile(file),
    });
  }
  return hashNamedContents(entries);
}

async function fileFingerprint(path) {
  const [content] = await Promise.all([
    readFile(path),
    assertFile(path, `candidate input ${path}`),
  ]);
  return {
    path: normalizedRelative(REPOSITORY_DIRECTORY, path),
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
  };
}

async function hashPackagedElectronRuntime() {
  const moduleFiles = await collectFiles(
    join(APP_DIRECTORY, "electron"),
    (path) =>
      path.endsWith(".mjs") && !path.endsWith(".test.mjs"),
  );
  const files = [
    ...moduleFiles,
    join(APP_DIRECTORY, "electron", "preload.cjs"),
    join(APP_DIRECTORY, "package.json"),
  ];
  const entries = [];
  for (const file of files) {
    const content = await readFile(file);
    entries.push({
      name: normalizedRelative(APP_DIRECTORY, file),
      content:
        file === join(APP_DIRECTORY, "package.json")
          ? canonicalPackagedPackageJson(content)
          : content,
    });
  }
  return {
    scope: "packaged-electron-runtime-v1",
    ...hashNamedContents(entries),
  };
}

async function hashDesignHandoffSource() {
  // Must reproduce `tools/measure-design-parity.mjs`'s digest byte for byte: same files, same
  // workspace-relative names, same sort. The baseline moved out of the handoff directory when it
  // was regenerated from the v2 comp, so the names are relative to the repository root now.
  const files = [
    join(DESIGN_HANDOFF_DIRECTORY, "Anchorage v2.dc.html"),
    join(DESIGN_HANDOFF_DIRECTORY, "README.md"),
    join(DESIGN_HANDOFF_DIRECTORY, "support.js"),
    ...(await collectFiles(DESIGN_REFERENCE_DIRECTORY)),
  ];
  const entries = [];
  for (const file of files) {
    entries.push({
      name: normalizedRelative(REPOSITORY_DIRECTORY, file),
      content: await readFile(file),
    });
  }
  return {
    scope: "anchorage-design-handoff-v2",
    ...hashNamedContents(entries),
  };
}

function pngDimensions(content, description) {
  const pngSignature = "89504e470d0a1a0a";
  if (
    content.length < 24 ||
    content.subarray(0, 8).toString("hex") !== pngSignature
  ) {
    fail(`${description} is not a valid PNG`);
  }
  return {
    width: content.readUInt32BE(16),
    height: content.readUInt32BE(20),
  };
}

function hashAsarDirectory(archive, directory) {
  const normalizedDirectory = directory.replace(/^\/+|\/+$/gu, "");
  const prefix = `/${normalizedDirectory}/`;
  const entries = [];
  for (const archiveEntry of listPackage(archive, { isPack: false })) {
    const normalizedEntry = archiveEntry.replaceAll("\\", "/");
    if (!normalizedEntry.startsWith(prefix)) {
      continue;
    }
    const packagePath = normalizedEntry.slice(1);
    if (statFile(archive, packagePath).files) {
      continue;
    }
    entries.push({
      name: normalizedEntry.slice(prefix.length),
      content: extractFile(archive, packagePath),
    });
  }
  return hashNamedContents(entries);
}

function hashAsarPackagedElectronRuntime(archive) {
  const entries = [];
  for (const archiveEntry of listPackage(archive, { isPack: false })) {
    const normalizedEntry = archiveEntry.replaceAll("\\", "/");
    const packagePath = normalizedEntry.replace(/^\/+/u, "");
    const included =
      packagePath === "package.json" ||
      packagePath === "electron/preload.cjs" ||
      (
        packagePath.startsWith("electron/") &&
        packagePath.endsWith(".mjs") &&
        !packagePath.endsWith(".test.mjs")
      );
    if (!included || statFile(archive, packagePath).files) {
      continue;
    }
    entries.push({
      name: packagePath,
      content: extractFile(archive, packagePath),
    });
  }
  return {
    scope: "packaged-electron-runtime-v1",
    ...hashNamedContents(entries),
  };
}

async function validateSources() {
  const required = [
    [join(APP_DIRECTORY, "package.json"), "application manifest"],
    [BUILDER_CONFIG, "electron-builder configuration"],
    [BUILDER_ENTRY, "pinned electron-builder installation"],
    [join(APP_DIRECTORY, "build", "icon.png"), "Linux application icon"],
    [join(APP_DIRECTORY, "src", "main.jsx"), "renderer entry"],
    [join(APP_DIRECTORY, "electron", "main.mjs"), "Electron main process"],
    [join(APP_DIRECTORY, "electron", "preload.cjs"), "Electron preload"],
    [
      join(APP_DIRECTORY, "electron", "core-launch-policy.mjs"),
      "Electron core launch policy",
    ],
    [
      join(APP_DIRECTORY, "electron", "security-policy.mjs"),
      "pure Electron security policy",
    ],
    [join(CORE_DIRECTORY, "go.mod"), "Go core module"],
    [join(PROTOCOL_DIRECTORY, "types.ts"), "shared protocol types"],
    [join(PROTOCOL_DIRECTORY, "v1.schema.json"), "shared protocol schema"],
    [join(PROTOCOL_DIRECTORY, "tsconfig.json"), "protocol typecheck configuration"],
    [
      join(CORE_DIRECTORY, "cmd", "anchorage-core", "main.go"),
      "Go core entry",
    ],
    [join(APP_DIRECTORY, "tests", "sites-worker.test.mjs"), "Sites test"],
    [CORE_ACCEPTANCE_SCRIPT, "read-only core acceptance runner"],
    [SECURITY_EVIDENCE_SCRIPT, "security evidence generator"],
    [SECURITY_EVIDENCE_HELPER, "security evidence helper"],
    [SECURITY_EVIDENCE_HELPER_TEST, "security evidence helper tests"],
    [PACKAGE_EVIDENCE_POLICY, "package evidence policy"],
    [PACKAGE_EVIDENCE_POLICY_TEST, "package evidence policy tests"],
    [DESIGN_EVIDENCE_SCRIPT, "visual conformance evidence generator"],
    [DESIGN_CAPTURE_SCRIPT, "visual conformance capture harness"],
    [DESIGN_CAPTURE_PROVENANCE, "design capture provenance"],
    [
      DESIGN_VISUAL_REVIEW_ATTESTATION,
      "canonical handoff visual review attestation",
    ],
    [HOST_CANDIDATE_SCRIPT, "production HostBridge candidate harness"],
    [CAPABILITY_EVIDENCE_SCRIPT, "capability evidence generator"],
    [PERFORMANCE_EVIDENCE_SCRIPT, "performance evidence generator"],
    [DESIGN_LEDGER_EVIDENCE, "visual conformance ledger"],
    [MUTATION_CONFORMANCE_EVIDENCE, "mutation conformance evidence"],
    [CAPABILITY_LEDGER_EVIDENCE, "Docker capability ledger"],
    [CAPABILITY_GENERATION_EVIDENCE, "Docker capability generation record"],
    [SYSTEM_CAPABILITIES_EVIDENCE, "Docker capability system snapshot"],
    [PERFORMANCE_RESULTS_EVIDENCE, "performance results"],
    [PERFORMANCE_ENVIRONMENT_EVIDENCE, "performance environment"],
  ];
  for (const [path, description] of required) {
    await assertFile(path, description);
  }

  const rendererTests = await collectFiles(
    join(APP_DIRECTORY, "src"),
    (path) => /\.test\.[cm]?[jt]sx?$/u.test(path),
  );
  const electronTests = await collectFiles(
    join(APP_DIRECTORY, "electron"),
    (path) => path.endsWith(".test.mjs"),
  );
  const coreTests = await collectFiles(
    CORE_DIRECTORY,
    (path) => path.endsWith("_test.go"),
  );
  const protocolTests = await collectFiles(
    PROTOCOL_DIRECTORY,
    (path) => path.endsWith(".test.mjs") || path.endsWith(".type-test.ts"),
  );
  const securityEvidenceTests = await collectFiles(
    join(REPOSITORY_DIRECTORY, "tools"),
    (path) => path.endsWith("security-evidence-helpers.test.mjs"),
  );
  const packageEvidenceTests = await collectFiles(
    join(APP_DIRECTORY, "scripts"),
    (path) => path.endsWith("package-evidence-policy.test.mjs"),
  );
  if (rendererTests.length === 0) {
    fail("Renderer tests are absent");
  }
  if (electronTests.length === 0) {
    fail("Electron tests are absent");
  }
  if (coreTests.length === 0) {
    fail("Core tests are absent");
  }
  if (protocolTests.length === 0) {
    fail("Protocol contract tests are absent");
  }
  if (securityEvidenceTests.length === 0) {
    fail("Security evidence tests are absent");
  }
  if (packageEvidenceTests.length === 0) {
    fail("Package evidence tests are absent");
  }

  const icon = await readFile(join(APP_DIRECTORY, "build", "icon.png"));
  const pngSignature = "89504e470d0a1a0a";
  if (icon.length < 24 || icon.subarray(0, 8).toString("hex") !== pngSignature) {
    fail("Linux application icon is not a valid PNG");
  }
  const width = icon.readUInt32BE(16);
  const height = icon.readUInt32BE(20);
  if (width !== height || width < 512) {
    fail(`Linux application icon must be square and at least 512 px, got ${width}x${height}`);
  }

  return {
    rendererTests: rendererTests.length,
    protocolTests: protocolTests.length,
    securityEvidenceTests: securityEvidenceTests.length,
    packageEvidenceTests: packageEvidenceTests.length,
    electronTests: electronTests.length,
    coreTests: coreTests.length,
  };
}

async function removeEvidenceFiles() {
  await Promise.all([
    rm(READ_ONLY_ACCEPTANCE_EVIDENCE, { force: true }),
    rm(ELECTRON_SECURITY_EVIDENCE, { force: true }),
    rm(DEPENDENCY_AUDIT_EVIDENCE, { force: true }),
    rm(HOST_CANDIDATE_DIRECTORY, { recursive: true, force: true }),
  ]);
}

async function invalidateCandidateOutputs() {
  assertGeneratedDirectory(RELEASE_DIRECTORY, APP_DIRECTORY, "release");
  assertGeneratedDirectory(
    CORE_STAGE_DIRECTORY,
    join(APP_DIRECTORY, "build"),
    "core",
  );
  await Promise.all([
    rm(RELEASE_DIRECTORY, { recursive: true, force: true }),
    rm(CORE_STAGE_DIRECTORY, { recursive: true, force: true }),
    removeEvidenceFiles(),
  ]);
}

async function readJsonArtifact(path, description) {
  const [content, info] = await Promise.all([
    readFile(path, "utf8"),
    assertFile(path, description),
  ]);
  let evidence;
  try {
    evidence = JSON.parse(content);
  } catch {
    fail(`${description} is not valid JSON: ${path}`);
  }
  return {
    evidence,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content),
    modifiedMs: info.mtimeMs,
  };
}

async function readPassedEvidence(path, description) {
  const artifact = await readJsonArtifact(path, description);
  if (artifact.evidence.status !== "passed") {
    fail(`${description} did not report a passing result`);
  }
  return artifact;
}

async function assertCurrentFileHash(path, expectedSha256, description) {
  await assertFile(path, description);
  const currentSha256 = await sha256File(path);
  if (currentSha256 !== expectedSha256) {
    fail(
      `${description} hash is stale: expected ${expectedSha256}, ` +
        `current ${currentSha256}`,
    );
  }
}

async function assertArtifactNewerThan(
  artifact,
  dependencies,
  description,
) {
  for (const [path, dependencyDescription] of dependencies) {
    const dependency = await assertFile(path, dependencyDescription);
    if (artifact.modifiedMs < dependency.mtimeMs) {
      fail(
        `${description} is stale relative to ${dependencyDescription}: ${path}`,
      );
    }
  }
}

function manifestEvidenceEntry(path, artifact, metadata = {}) {
  return {
    path: normalizedRelative(REPOSITORY_DIRECTORY, path),
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    ...metadata,
  };
}

async function collectRequiredReleaseEvidence(expectedRendererBuild) {
  const [
    designLedger,
    designCaptureProvenance,
    designVisualReviewAttestation,
    mutationConformance,
    capabilityLedger,
    capabilityGeneration,
    systemCapabilities,
    performanceResults,
    performanceEnvironment,
  ] = await Promise.all([
    readJsonArtifact(DESIGN_LEDGER_EVIDENCE, "visual conformance ledger"),
    readJsonArtifact(
      DESIGN_CAPTURE_PROVENANCE,
      "design capture provenance",
    ),
    readJsonArtifact(
      DESIGN_VISUAL_REVIEW_ATTESTATION,
      "canonical handoff visual review attestation",
    ),
    readJsonArtifact(
      MUTATION_CONFORMANCE_EVIDENCE,
      "mutation conformance evidence",
    ),
    readJsonArtifact(CAPABILITY_LEDGER_EVIDENCE, "Docker capability ledger"),
    readJsonArtifact(
      CAPABILITY_GENERATION_EVIDENCE,
      "Docker capability generation record",
    ),
    readJsonArtifact(
      SYSTEM_CAPABILITIES_EVIDENCE,
      "Docker capability system snapshot",
    ),
    readJsonArtifact(PERFORMANCE_RESULTS_EVIDENCE, "performance results"),
    readJsonArtifact(
      PERFORMANCE_ENVIRONMENT_EVIDENCE,
      "performance environment",
    ),
  ]);

  const [
    designCaptureHarnessSha256,
    designGeneratorSha256,
    performanceHarnessSha256,
    expectedDesignHandoffSource,
    expectedVisualReviewSource,
  ] = await Promise.all([
    sha256File(DESIGN_CAPTURE_SCRIPT),
    sha256File(DESIGN_EVIDENCE_SCRIPT),
    sha256File(PERFORMANCE_EVIDENCE_SCRIPT),
    hashDesignHandoffSource(),
    fileFingerprint(DESIGN_VISUAL_REVIEW_ATTESTATION),
  ]);
  validateDesignLedger(designLedger.evidence, {
    expectedRendererBuild,
    expectedCaptureHarnessSha256: designCaptureHarnessSha256,
    expectedDesignGeneratorSha256: designGeneratorSha256,
    expectedDesignHandoffSource,
    expectedVisualReviewAttestation:
      designVisualReviewAttestation.evidence,
    expectedVisualReviewSource,
  });
  if (
    !isDeepStrictEqual(
      designLedger.evidence.captureProvenance,
      designCaptureProvenance.evidence,
    )
  ) {
    fail(
      "Visual conformance ledger must embed the exact design capture provenance",
    );
  }
  for (const state of designCaptureProvenance.evidence.states) {
    const expectedRelativePath = `final-actual/${state.state}.png`;
    if (state.path !== expectedRelativePath) {
      fail(
        `Design capture state ${state.state} has an unexpected path: ${state.path}`,
      );
    }
    const actualPath = join(
      REPOSITORY_DIRECTORY,
      "docs",
      "design-qa",
      "final-actual",
      `${state.state}.png`,
    );
    const [content, info] = await Promise.all([
      readFile(actualPath),
      assertFile(actualPath, `design capture ${state.state}`),
    ]);
    const dimensions = pngDimensions(
      content,
      `Design capture ${state.state}`,
    );
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (
      sha256 !== state.sha256 ||
      info.size !== state.bytes ||
      dimensions.width !== state.dimensions.width ||
      dimensions.height !== state.dimensions.height
    ) {
      fail(
        `Design capture ${state.state} does not match its recorded provenance`,
      );
    }
  }
  validateMutationConformance(mutationConformance.evidence);
  validateCapabilityEvidence({
    generation: capabilityGeneration.evidence,
    ledger: capabilityLedger.evidence,
    systemCapabilities: systemCapabilities.evidence,
  });
  validatePerformanceEvidence({
    results: performanceResults.evidence,
    environment: performanceEnvironment.evidence,
  }, {
    expectedHarnessSha256: performanceHarnessSha256,
  });

  const evidenceCorePaths = [
    mutationConformance.evidence.corePath,
    capabilityGeneration.evidence.corePath,
    performanceEnvironment.evidence.tools.core.path,
  ].map((path) => resolve(path));
  const evidenceCoreHashes = [
    mutationConformance.evidence.coreSha256,
    capabilityGeneration.evidence.coreSha256,
    performanceEnvironment.evidence.tools.core.sha256,
  ];
  if (
    evidenceCorePaths.some((path) => path !== evidenceCorePaths[0]) ||
    evidenceCorePaths[0] !== join(CORE_DIRECTORY, "bin", "anchorage-core") ||
    evidenceCoreHashes.some((sha256) => sha256 !== evidenceCoreHashes[0])
  ) {
    fail(
      "Mutation, capability, and performance evidence must cover the same " +
        "current development core binary and hash",
    );
  }
  const developmentCore = await assertFile(
    evidenceCorePaths[0],
    "evidence-tested development core",
  );
  const coreSourceFiles = await collectFiles(
    CORE_DIRECTORY,
    (path) =>
      path.endsWith(".go") ||
      path.endsWith("/go.mod") ||
      path.endsWith("/go.sum"),
  );
  await assertArtifactNewerThan(
    { modifiedMs: developmentCore.mtimeMs },
    coreSourceFiles.map((path) => [path, "Go core source"]),
    "Evidence-tested development core",
  );

  if (
    resolve(mutationConformance.evidence.generator.path) !==
    CORE_ACCEPTANCE_SCRIPT
  ) {
    fail("Mutation conformance evidence identifies an unexpected generator");
  }
  await Promise.all([
    assertCurrentFileHash(
      CORE_ACCEPTANCE_SCRIPT,
      mutationConformance.evidence.generator.sha256,
      "mutation conformance generator",
    ),
    assertCurrentFileHash(
      mutationConformance.evidence.corePath,
      mutationConformance.evidence.coreSha256,
      "mutation-tested core",
    ),
  ]);

  if (
    resolve(capabilityGeneration.evidence.generator.path) !==
    CAPABILITY_EVIDENCE_SCRIPT
  ) {
    fail("Docker capability evidence identifies an unexpected generator");
  }
  await Promise.all([
    assertCurrentFileHash(
      CAPABILITY_EVIDENCE_SCRIPT,
      capabilityGeneration.evidence.generator.sha256,
      "Docker capability generator",
    ),
    assertCurrentFileHash(
      capabilityGeneration.evidence.corePath,
      capabilityGeneration.evidence.coreSha256,
      "capability-tested core",
    ),
    assertCurrentFileHash(
      systemCapabilities.evidence.binary.realPath ??
        systemCapabilities.evidence.binary.path,
      capabilityGeneration.evidence.dockerBinarySha256,
      "installed Docker CLI",
    ),
    assertCurrentFileHash(
      performanceEnvironment.evidence.tools.core.path,
      performanceEnvironment.evidence.tools.core.sha256,
      "performance-tested core",
    ),
  ]);

  const designSourceFiles = await Promise.all([
    collectFiles(
      join(APP_DIRECTORY, "src"),
      (path) => !/\.test\.[cm]?[jt]sx?$/u.test(path),
    ),
    collectFiles(DESIGN_REFERENCE_DIRECTORY),
    collectFiles(
      join(REPOSITORY_DIRECTORY, "docs", "design-qa", "final-actual"),
    ),
    [
      join(DESIGN_HANDOFF_DIRECTORY, "Anchorage v2.dc.html"),
      join(DESIGN_HANDOFF_DIRECTORY, "README.md"),
      join(DESIGN_HANDOFF_DIRECTORY, "support.js"),
    ],
  ]);
  await assertArtifactNewerThan(
    designLedger,
    [
      [DESIGN_EVIDENCE_SCRIPT, "visual conformance generator"],
      [DESIGN_CAPTURE_SCRIPT, "visual conformance capture harness"],
      [
        DESIGN_VISUAL_REVIEW_ATTESTATION,
        "canonical handoff visual review attestation",
      ],
      ...designSourceFiles
        .flat()
        .map((path) => [path, "visual conformance input"]),
    ],
    "Visual conformance ledger",
  );
  await Promise.all([
    assertArtifactNewerThan(
      mutationConformance,
      [[CORE_ACCEPTANCE_SCRIPT, "mutation conformance generator"]],
      "Mutation conformance evidence",
    ),
    assertArtifactNewerThan(
      capabilityGeneration,
      [[CAPABILITY_EVIDENCE_SCRIPT, "Docker capability generator"]],
      "Docker capability generation record",
    ),
    assertArtifactNewerThan(
      performanceResults,
      [[PERFORMANCE_EVIDENCE_SCRIPT, "performance evidence harness"]],
      "Performance results",
    ),
    assertArtifactNewerThan(
      performanceEnvironment,
      [[PERFORMANCE_EVIDENCE_SCRIPT, "performance evidence harness"]],
      "Performance environment",
    ),
  ]);

  return {
    designConformance: manifestEvidenceEntry(
      DESIGN_LEDGER_EVIDENCE,
      designLedger,
      {
        generatedAt: designLedger.evidence.generatedAt,
        reviewedStates: designLedger.evidence.rows.length,
        generatorSha256: designGeneratorSha256,
        handoffSource: designLedger.evidence.handoffSource,
        visualReviewAttestation: manifestEvidenceEntry(
          DESIGN_VISUAL_REVIEW_ATTESTATION,
          designVisualReviewAttestation,
          {
            claim:
              designVisualReviewAttestation.evidence.claim,
            reviewedAt:
              designVisualReviewAttestation.evidence.reviewedAt,
            states:
              designVisualReviewAttestation.evidence.states.length,
          },
        ),
        rendererBuild: designLedger.evidence.rendererBuild,
        captureProvenance: manifestEvidenceEntry(
          DESIGN_CAPTURE_PROVENANCE,
          designCaptureProvenance,
          {
            capturedAt:
              designCaptureProvenance.evidence.capturedAt,
            captureMode:
              designCaptureProvenance.evidence.captureMode,
            bridgeMode:
              designCaptureProvenance.evidence.bridgeMode,
            harnessSha256: designCaptureHarnessSha256,
          },
        ),
      },
    ),
    mutationConformance: manifestEvidenceEntry(
      MUTATION_CONFORMANCE_EVIDENCE,
      mutationConformance,
      {
        completedAt: mutationConformance.evidence.completedAt,
        schemaVersion: mutationConformance.evidence.schemaVersion,
        matrixVersion: mutationConformance.evidence.matrixVersion,
        mutationsEnabled: true,
        coreSha256: mutationConformance.evidence.coreSha256,
        checks: mutationConformance.evidence.checks.length,
        requiredChecks: mutationConformance.evidence.requiredChecks,
      },
    ),
    dockerCapabilities: {
      generation: manifestEvidenceEntry(
        CAPABILITY_GENERATION_EVIDENCE,
        capabilityGeneration,
        {
          completedAt: capabilityGeneration.evidence.completedAt,
          leafCount: capabilityGeneration.evidence.leafCount,
          transportCovered:
            capabilityGeneration.evidence.transportCovered,
          commandExecutedConformancePassed:
            capabilityGeneration.evidence.commandExecutedConformancePassed,
          coreSha256: capabilityGeneration.evidence.coreSha256,
          dockerBinarySha256:
            capabilityGeneration.evidence.dockerBinarySha256,
        },
      ),
      ledger: manifestEvidenceEntry(
        CAPABILITY_LEDGER_EVIDENCE,
        capabilityLedger,
      ),
      systemSnapshot: manifestEvidenceEntry(
        SYSTEM_CAPABILITIES_EVIDENCE,
        systemCapabilities,
      ),
    },
    performance: {
      results: manifestEvidenceEntry(
        PERFORMANCE_RESULTS_EVIDENCE,
        performanceResults,
        {
          completedAt: performanceResults.evidence.completedAt,
          soakDurationSeconds:
            performanceResults.evidence.requestedSoakDurationSeconds,
          harnessSha256: performanceHarnessSha256,
        },
      ),
      environment: manifestEvidenceEntry(
        PERFORMANCE_ENVIRONMENT_EVIDENCE,
        performanceEnvironment,
        {
          coreSha256:
            performanceEnvironment.evidence.tools.core.sha256,
        },
      ),
    },
  };
}

async function generateHostCandidateEvidence(coreSha256, rendererBuild) {
  log("Running staged production HostBridge candidate capture");
  await run(
    process.execPath,
    [HOST_CANDIDATE_SCRIPT],
    {
      cwd: REPOSITORY_DIRECTORY,
      env: {
        ...process.env,
        ANCHORAGE_HOST_CANDIDATE_CORE: CORE_STAGE_BINARY,
        ANCHORAGE_HOST_CANDIDATE_OUTPUT: HOST_CANDIDATE_DIRECTORY,
      },
      timeoutMs: 240_000,
    },
  );
  const hostCandidate = await readPassedEvidence(
    HOST_CANDIDATE_EVIDENCE,
    "staged production HostBridge candidate evidence",
  );
  const [
    expectedCore,
    expectedElectronBinary,
    expectedElectronMain,
    expectedElectronPreload,
    expectedElectronRuntimeClosure,
    expectedProtocolSchema,
    expectedHarnessSha256,
  ] = await Promise.all([
    fileFingerprint(CORE_STAGE_BINARY),
    fileFingerprint(ELECTRON_BINARY),
    fileFingerprint(join(APP_DIRECTORY, "electron", "main.mjs")),
    fileFingerprint(join(APP_DIRECTORY, "electron", "preload.cjs")),
    hashPackagedElectronRuntime(),
    fileFingerprint(join(PROTOCOL_DIRECTORY, "v1.schema.json")),
    sha256File(HOST_CANDIDATE_SCRIPT),
  ]);
  if (expectedCore.sha256 !== coreSha256) {
    fail("Host candidate core fingerprint did not match the staged core");
  }
  const observedScreens = [];
  for (const id of HOST_CANDIDATE_SCREEN_IDS) {
    const path = join(HOST_CANDIDATE_DIRECTORY, "screens", `${id}.png`);
    const [content, info] = await Promise.all([
      readFile(path),
      assertFile(path, `host candidate screen ${id}`),
    ]);
    observedScreens.push({
      id,
      path: `screens/${id}.png`,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: info.size,
      dimensions: pngDimensions(content, `Host candidate screen ${id}`),
    });
  }
  validateHostCandidateEvidence(hostCandidate.evidence, {
    expectedRendererBuild: rendererBuild,
    expectedCore,
    expectedElectronBinary,
    expectedElectronMain,
    expectedElectronPreload,
    expectedElectronRuntimeClosure,
    expectedProtocolSchema,
    expectedHarnessSha256,
    observedScreens,
  });
  return {
    ...manifestEvidenceEntry(
      HOST_CANDIDATE_EVIDENCE,
      hostCandidate,
    ),
    completedAt: hostCandidate.evidence.completedAt,
    scope: hostCandidate.evidence.scope,
    bridgeMode: hostCandidate.evidence.bridgeMode,
    checks: hostCandidate.evidence.checks.length,
    requiredChecks: hostCandidate.evidence.requiredChecks,
    screens: observedScreens,
    rendererBuild: hostCandidate.evidence.candidate.rendererBuild,
    coreSha256: hostCandidate.evidence.candidate.core.sha256,
    electronBinary:
      hostCandidate.evidence.candidate.electron.binary,
    electronRuntimeClosure:
      hostCandidate.evidence.candidate.electron.runtimeClosure,
    harnessSha256: expectedHarnessSha256,
  };
}

async function generateReleaseEvidence(coreSha256, rendererBuild) {
  log(
    "Validating current design, installed-command, mutation, and performance evidence",
  );
  const requiredEvidence =
    await collectRequiredReleaseEvidence(rendererBuild);
  validateStagedCoreEvidenceHashes(coreSha256, {
    mutation: requiredEvidence.mutationConformance.coreSha256,
    capability:
      requiredEvidence.dockerCapabilities.generation.coreSha256,
    performance: requiredEvidence.performance.environment.coreSha256,
  });

  const hostCandidate =
    await generateHostCandidateEvidence(coreSha256, rendererBuild);

  log("Running read-only acceptance against the freshly staged core");
  await run(
    process.execPath,
    [CORE_ACCEPTANCE_SCRIPT],
    {
      cwd: REPOSITORY_DIRECTORY,
      env: {
        ...process.env,
        ANCHORAGE_CORE_PATH: CORE_STAGE_BINARY,
        ANCHORAGE_ACCEPTANCE_MUTATIONS: "0",
        ANCHORAGE_ACCEPTANCE_OUTPUT: READ_ONLY_ACCEPTANCE_EVIDENCE,
      },
      timeoutMs: 180_000,
    },
  );
  const acceptance = await readPassedEvidence(
    READ_ONLY_ACCEPTANCE_EVIDENCE,
    "read-only staged-core acceptance evidence",
  );
  validateReadOnlyAcceptance(acceptance.evidence, {
    expectedCorePath: CORE_STAGE_BINARY,
    expectedCoreSha256: coreSha256,
  });
  await assertCurrentFileHash(
    CORE_ACCEPTANCE_SCRIPT,
    acceptance.evidence.generator.sha256,
    "read-only core acceptance generator",
  );

  log("Running behavioral Electron security and dependency audit evidence");
  await run(
    process.execPath,
    [SECURITY_EVIDENCE_SCRIPT],
    {
      cwd: REPOSITORY_DIRECTORY,
      timeoutMs: 180_000,
    },
  );
  const [electronSecurity, dependencyAudit] = await Promise.all([
    readPassedEvidence(
      ELECTRON_SECURITY_EVIDENCE,
      "Electron security evidence",
    ),
    readPassedEvidence(
      DEPENDENCY_AUDIT_EVIDENCE,
      "dependency audit evidence",
    ),
  ]);
  if (
    !Array.isArray(electronSecurity.evidence.checks) ||
    electronSecurity.evidence.checks.length === 0 ||
    electronSecurity.evidence.checks.some((check) => check.status !== "passed")
  ) {
    fail("Electron security evidence did not contain passing behavioral checks");
  }
  if (
    !Number.isSafeInteger(dependencyAudit.evidence.auditReportVersion) ||
    dependencyAudit.evidence.vulnerabilities?.total !== 0
  ) {
    fail("Dependency audit evidence was incomplete or reported vulnerabilities");
  }
  await Promise.all([
    assertCurrentFileHash(
      join(APP_DIRECTORY, "electron", "main.mjs"),
      electronSecurity.evidence.sourceHashes?.main,
      "security-evaluated Electron main process",
    ),
    assertCurrentFileHash(
      join(APP_DIRECTORY, "electron", "preload.cjs"),
      electronSecurity.evidence.sourceHashes?.preload,
      "security-evaluated Electron preload",
    ),
    assertCurrentFileHash(
      join(APP_DIRECTORY, "electron", "contracts.mjs"),
      electronSecurity.evidence.sourceHashes?.contracts,
      "security-evaluated Electron contracts",
    ),
    assertCurrentFileHash(
      join(APP_DIRECTORY, "electron", "core-launch-policy.mjs"),
      electronSecurity.evidence.sourceHashes?.coreLaunchPolicy,
      "security-evaluated core launch policy",
    ),
    assertCurrentFileHash(
      join(PROTOCOL_DIRECTORY, "v1.schema.json"),
      electronSecurity.evidence.sourceHashes?.protocolSchema,
      "security-evaluated protocol schema",
    ),
    assertCurrentFileHash(
      join(APP_DIRECTORY, "electron", "security-policy.mjs"),
      electronSecurity.evidence.sourceHashes?.securityPolicy,
      "security-evaluated Electron policy",
    ),
    assertCurrentFileHash(
      SECURITY_EVIDENCE_HELPER,
      electronSecurity.evidence.sourceHashes?.securityEvidenceHelpers,
      "security evidence helper",
    ),
    assertCurrentFileHash(
      SECURITY_EVIDENCE_SCRIPT,
      electronSecurity.evidence.sourceHashes?.generator,
      "security evidence generator",
    ),
    assertCurrentFileHash(
      join(APP_DIRECTORY, "package-lock.json"),
      dependencyAudit.evidence.packageLockSha256,
      "dependency-audited lockfile",
    ),
  ]);

  return {
    ...requiredEvidence,
    hostCandidate,
    coreAcceptance: {
      ...manifestEvidenceEntry(
        READ_ONLY_ACCEPTANCE_EVIDENCE,
        acceptance,
      ),
      coreSha256,
      completedAt: acceptance.evidence.completedAt,
      schemaVersion: acceptance.evidence.schemaVersion,
      matrixVersion: acceptance.evidence.matrixVersion,
      mutationsEnabled: false,
      checks: acceptance.evidence.checks.length,
      requiredChecks: acceptance.evidence.requiredChecks,
    },
    electronSecurity: {
      ...manifestEvidenceEntry(
        ELECTRON_SECURITY_EVIDENCE,
        electronSecurity,
      ),
      generatedAt: electronSecurity.evidence.generatedAt,
      policyVersion: electronSecurity.evidence.policyVersion,
    },
    dependencyAudit: {
      ...manifestEvidenceEntry(
        DEPENDENCY_AUDIT_EVIDENCE,
        dependencyAudit,
      ),
      generatedAt: dependencyAudit.evidence.generatedAt,
      vulnerabilities:
        dependencyAudit.evidence.vulnerabilities?.total,
    },
  };
}

async function buildAndStage(sourceCounts, packageMetadata) {
  log("Running renderer tests");
  await run("npm", ["run", "test:renderer"]);
  log("Running strict renderer typecheck");
  await run("npm", ["run", "typecheck:renderer"]);
  log("Running shared protocol contract tests");
  await run("npm", ["run", "test:protocol"]);
  log("Running security evidence helper tests");
  await run("npm", ["run", "test:security-evidence"]);
  log("Running package evidence policy tests");
  await run("npm", ["run", "test:package-evidence"]);
  log("Running Electron shell tests");
  await run("npm", ["run", "test:electron"]);
  log("Running Sites handoff tests");
  await run("npm", ["run", "test:sites"]);
  log("Running Go core race tests");
  await run("go", ["test", "-race", "./..."], { cwd: CORE_DIRECTORY });
  log("Running Go vet");
  await run("go", ["vet", "./..."], { cwd: CORE_DIRECTORY });
  log("Building renderer and Sites artifacts");
  await run("npm", ["run", "build"]);

  assertGeneratedDirectory(CORE_STAGE_DIRECTORY, join(APP_DIRECTORY, "build"), "core");
  await rm(CORE_STAGE_DIRECTORY, { recursive: true, force: true });
  await mkdir(CORE_STAGE_DIRECTORY, { recursive: true });

  log("Building a fresh static, stripped Go core");
  const goBuildFlags = [
    "build",
    "-trimpath",
    "-buildvcs=false",
    "-ldflags=-s -w -buildid=",
    "-o",
    CORE_STAGE_BINARY,
    "./cmd/anchorage-core",
  ];
  await run("go", goBuildFlags, {
    cwd: CORE_DIRECTORY,
    env: { ...process.env, CGO_ENABLED: "0" },
  });
  await chmod(CORE_STAGE_BINARY, 0o755);
  const coreInfo = await assertFile(CORE_STAGE_BINARY, "staged core binary");
  await access(CORE_STAGE_BINARY, constants.X_OK);
  const coreSha256 = await sha256File(CORE_STAGE_BINARY);

  // Proves the determinism the release report claims, rather than asserting it.
  //
  // The AppImage is NOT byte-reproducible — it carries digests of evidence that photographs a
  // live daemon — so the core binary is the thing a reader can actually compare across two
  // builds of one commit. That is only worth stating if it is true, and the build flags that
  // make it true (-trimpath, -buildvcs=false, -buildid=, CGO_ENABLED=0) are easy to weaken by
  // accident. A second build costs well under a second because the Go build cache is warm.
  // Built into a temp directory rather than beside the staged core, and removed in a `finally`
  // so no failure path can leave it behind.
  //
  // Corrected justification: an earlier version of this comment claimed a stray replay would be
  // packaged, because extraResources copies `build/core`. It would not — that entry carries an
  // explicit `filter: [anchorage-core, manifest.json]`, so the release was never at risk. The
  // reason to keep this is narrower: build scratch does not belong in the staged payload
  // directory, and a `finally` is honest where cleanup after the fact can be skipped by a throw.
  const coreReplayDirectory = await mkdtemp(join(tmpdir(), "anchorage-core-replay-"));
  const coreReplayPath = join(coreReplayDirectory, "anchorage-core");
  let coreReplaySha256;
  try {
    await run("go", [...goBuildFlags.slice(0, -2), coreReplayPath, "./cmd/anchorage-core"], {
      cwd: CORE_DIRECTORY,
      env: { ...process.env, CGO_ENABLED: "0" },
    });
    coreReplaySha256 = await sha256File(coreReplayPath);
  } finally {
    await rm(coreReplayDirectory, { recursive: true, force: true });
  }
  if (coreReplaySha256 !== coreSha256) {
    fail(
      "The Go core is not reproducible: rebuilding the same source produced " +
        `${coreReplaySha256} after ${coreSha256}. The release report claims core determinism, ` +
        "so either the build flags regressed or a source of nondeterminism entered the core.",
    );
  }
  log(`Core rebuild reproduced ${coreSha256.slice(0, 12)} exactly`);

  const { stdout: versionOutput } = await run(
    CORE_STAGE_BINARY,
    ["--version"],
    { capture: true },
  );
  const version = versionOutput.trim();
  const expectedVersion = `anchorage-core ${packageMetadata.version} protocol 1 `;
  if (!version.startsWith(expectedVersion)) {
    fail(
      `Core version mismatch; expected prefix ${JSON.stringify(expectedVersion)}, ` +
        `got ${JSON.stringify(version)}`,
    );
  }

  const renderer = await hashDirectory(join(APP_DIRECTORY, "dist", "client"));
  if (renderer.files === 0 || renderer.bytes === 0) {
    fail("Renderer production build is absent");
  }
  await assertFile(
    join(APP_DIRECTORY, "dist", "client", "index.html"),
    "renderer production entry",
  );

  const { stdout: goVersionOutput } = await run("go", ["version"], {
    capture: true,
  });
  const evidence = await generateReleaseEvidence(coreSha256, renderer);
  const manifest = {
    schemaVersion: 1,
    application: {
      name: packageMetadata.name,
      productName: packageMetadata.productName,
      version: packageMetadata.version,
      electronVersion: packageMetadata.devDependencies.electron,
    },
    core: {
      path: "core/anchorage-core",
      sha256: coreSha256,
      bytes: coreInfo.size,
      version,
      goToolchain: goVersionOutput.trim(),
      build: {
        cgoEnabled: false,
        trimpath: true,
        stripped: true,
      },
    },
    renderer: {
      path: "app.asar/dist/client",
      ...renderer,
    },
    // Stripped of wall-clock fields, which removes the timestamps but does NOT make the
    // AppImage reproducible, and this used to claim it did.
    //
    // The manifest binds each evidence document by digest, and some of that evidence
    // photographs a live system — host-candidate screenshots of a running daemon, measured
    // timings. Its content differs every run whatever we do to the timestamps, so the digests
    // differ, so the manifest differs, so the asar and the AppImage differ. Two builds of one
    // commit measured 119202907 and 119202913 bytes.
    //
    // What IS reproducible is the product: the core binary and the renderer bundle are
    // byte-identical across builds of one commit, which is the property worth having and the
    // one `reproducibility` in release-verification.json states. Do not compare AppImage
    // digests to decide whether two builds carry the same software — compare those two.
    evidence: manifestEvidenceWithoutWallClock(evidence),
    tests: sourceCounts,
  };
  await writeFile(CORE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
  log(
    `Staged core ${manifest.core.sha256.slice(0, 12)} (${manifest.core.bytes} bytes) ` +
      `and renderer ${renderer.sha256.slice(0, 12)} (${renderer.files} files)`,
  );
  return manifest;
}

async function verifyPackagedPayload(
  manifest,
  {
    executable,
    archive,
    core,
    manifestPath,
    label,
  },
) {
  const executableInfo = await assertFile(
    executable,
    `${label} Anchorage executable`,
  );
  if ((executableInfo.mode & 0o111) === 0) {
    fail(`${label} Anchorage executable is not executable`);
  }
  const archiveInfo = await assertFile(
    archive,
    `${label} application archive`,
  );
  const coreInfo = await assertFile(core, `${label} core binary`);
  const manifestInfo = await assertFile(
    manifestPath,
    `${label} core manifest`,
  );
  await access(executable, constants.X_OK);
  await access(core, constants.X_OK);

  const expectedElectronBinary =
    manifest.evidence?.hostCandidate?.electronBinary;
  const executableSha256 = await sha256File(executable);
  if (
    expectedElectronBinary?.sha256 !== executableSha256 ||
    expectedElectronBinary?.bytes !== executableInfo.size
  ) {
    fail(
      `${label} executable does not exactly match the host-captured Electron ` +
        `binary: ${JSON.stringify({
          expected: {
            sha256: expectedElectronBinary?.sha256,
            bytes: expectedElectronBinary?.bytes,
          },
          observed: {
            sha256: executableSha256,
            bytes: executableInfo.size,
          },
        })}`,
    );
  }

  const stagedHash = manifest.core.sha256;
  const packagedHash = await sha256File(core);
  if (packagedHash !== stagedHash) {
    fail(
      `${label} core hash ${packagedHash} does not match staged core ${stagedHash}`,
    );
  }
  if (coreInfo.size !== manifest.core.bytes) {
    fail(
      `${label} core size ${coreInfo.size} does not match staged core ` +
        `${manifest.core.bytes}`,
    );
  }
  const packagedManifestContent = await readFile(manifestPath, "utf8");
  const packagedManifest = JSON.parse(packagedManifestContent);
  if (!isDeepStrictEqual(packagedManifest, manifest)) {
    fail(`${label} manifest does not exactly match the staged release manifest`);
  }
  const [packagedManifestSha256, stagedManifestSha256] = await Promise.all([
    sha256File(manifestPath),
    sha256File(CORE_MANIFEST),
  ]);
  if (packagedManifestSha256 !== stagedManifestSha256) {
    fail(`${label} manifest bytes do not exactly match the staged manifest`);
  }

  const entries = listPackage(archive, { isPack: false }).map((entry) =>
    entry.replaceAll("\\", "/"),
  );
  for (const required of [
    "/package.json",
    "/electron/main.mjs",
    "/electron/preload.cjs",
    "/electron/security-policy.mjs",
    "/dist/client/index.html",
  ]) {
    if (!entries.includes(required)) {
      fail(`Packaged archive is missing ${required}`);
    }
  }
  for (const forbidden of [
    "/src/",
    "/scripts/",
    "/tests/",
    "/node_modules/",
  ]) {
    if (entries.some((entry) => entry === forbidden.slice(0, -1) || entry.startsWith(forbidden))) {
      fail(`Packaged archive unexpectedly contains ${forbidden}`);
    }
  }
  if (entries.some((entry) => entry.endsWith(".test.mjs"))) {
    fail("Packaged archive unexpectedly contains Electron tests");
  }
  const packagedElectronRuntime =
    hashAsarPackagedElectronRuntime(archive);
  const hostCapturedElectronRuntime =
    manifest.evidence.hostCandidate.electronRuntimeClosure;
  validatePackagedElectronRuntimeClosure(
    packagedElectronRuntime,
    hostCapturedElectronRuntime,
  );
  const packagedRenderer = hashAsarDirectory(archive, "dist/client");
  const stagedRenderer = {
    sha256: manifest.renderer.sha256,
    files: manifest.renderer.files,
    bytes: manifest.renderer.bytes,
  };
  if (!isDeepStrictEqual(packagedRenderer, stagedRenderer)) {
    fail(
      `Packaged renderer hash does not match the staged renderer: ` +
        `${JSON.stringify({ packagedRenderer, stagedRenderer })}`,
    );
  }

  const packagedMetadata = JSON.parse(
    extractFile(archive, "package.json").toString("utf8"),
  );
  if (
    packagedMetadata.name !== "anchorage" ||
    packagedMetadata.version !== manifest.application.version ||
    packagedMetadata.main !== "electron/main.mjs"
  ) {
    fail("Packaged application metadata is inconsistent");
  }

  const { stdout: versionOutput } = await run(core, ["--version"], {
    capture: true,
  });
  if (versionOutput.trim() !== manifest.core.version) {
    fail(`${label} core did not report the staged version`);
  }

  return {
    label,
    executable: {
      sha256: executableSha256,
      bytes: executableInfo.size,
    },
    archive: {
      sha256: await sha256File(archive),
      bytes: archiveInfo.size,
    },
    core: {
      sha256: packagedHash,
      bytes: coreInfo.size,
    },
    manifest: {
      sha256: packagedManifestSha256,
      bytes: manifestInfo.size,
    },
    electronRuntimeClosure: packagedElectronRuntime,
    renderer: packagedRenderer,
  };
}

/**
 * The slowest a mounted AppImage may take to reach a shown window, in milliseconds.
 *
 * The AppImage smoke below sets `APPIMAGE_EXTRACT_AND_RUN`, which unpacks to a temp directory and
 * runs from plain files — correct, because a CI host need not have FUSE, but it means the release
 * gate never exercised the path a user actually double-clicks. A build shipped at 57.8 s to first
 * window while every gate stayed green: `compression: maximum` had built the squashfs with xz at
 * 1 MB blocks, and Electron demand-pages a 220 MB binary, so each fault cost a whole block
 * decompressed through squashfuse on every launch. Rebuilt with gzip it is 7.4 s, exactly the
 * unpacked figure.
 *
 * The budget is loose against 7.4 s because packaging hosts vary, and still an order of magnitude
 * under the failure it exists to catch. The measurement is recorded in the release receipt either
 * way, so drift is visible long before it trips.
 */
const APPIMAGE_MOUNTED_STARTUP_BUDGET_MS = 20_000;

/**
 * One message for every way the mounted AppImage can be too slow, because the actionable part is
 * identical either way: this is what squashfs compression costs.
 */
function failMountedStartup(elapsedMs, why) {
  fail(
    `Mounted AppImage startup failed: ${why} after ${(elapsedMs / 1000).toFixed(1)} s, against a ` +
      `${APPIMAGE_MOUNTED_STARTUP_BUDGET_MS / 1000} s budget.\n` +
      "  This is almost always squashfs compression in app/electron-builder.yml. `maximum` builds\n" +
      "  the filesystem with xz at 1 MB blocks; Electron demand-pages a 220 MB binary, so every\n" +
      "  fault costs a whole block decompressed through squashfuse, on every launch. Measured\n" +
      "  here: xz 57.8 s, gzip 7.4 s, unpacked 7.4 s. Use `compression: normal`.",
  );
}


/**
 * Times the AppImage over its real squashfs mount.
 *
 * Returns the measurement rather than only asserting it, and reports an explicit `unavailable`
 * when the host has no FUSE — a gate that quietly skips is how this defect stayed invisible.
 */
async function measureMountedAppImageStartup(appImage) {
  if (!existsSync("/dev/fuse")) {
    log(
      "  AppImage mounted-startup NOT MEASURED: this host has no /dev/fuse, so the launch path " +
        "a user double-clicks was not exercised",
    );
    return { status: "unavailable", reason: "no /dev/fuse on the packaging host" };
  }

  log("Timing the AppImage over its own squashfs mount");
  const startedAt = process.hrtime.bigint();
  // Ceiling well above the budget so a slow start is reported as a slow start, with the
  // diagnostic below, rather than as a bare `xvfb-run failed after timing out`.
  let smoke;
  try {
    smoke = await run(
      "xvfb-run",
      ["-a", "-s", "-screen 0 1920x1200x24", appImage.path],
      {
        capture: true,
        timeoutMs: APPIMAGE_MOUNTED_STARTUP_BUDGET_MS * 6,
        // Deliberately without APPIMAGE_EXTRACT_AND_RUN: the point is the mounted path.
        env: { ...process.env, ANCHORAGE_PACKAGED_SMOKE: "1" },
      },
    );
  } catch (error) {
    failMountedStartup(
      Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      `it never reached a window (${error.message})`,
    );
  }
  const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
  const output = `${smoke.stdout}\n${smoke.stderr}`;
  if (!output.includes("ANCHORAGE_DESKTOP_SMOKE_OK")) {
    fail(`Mounted AppImage smoke did not report success:\n${output.trim()}`);
  }
  if (elapsedMs > APPIMAGE_MOUNTED_STARTUP_BUDGET_MS) {
    failMountedStartup(elapsedMs, "it is over budget");
  }
  log(
    `  AppImage mounted startup: ${(elapsedMs / 1000).toFixed(1)} s ` +
      `(budget ${APPIMAGE_MOUNTED_STARTUP_BUDGET_MS / 1000} s)`,
  );
  return {
    status: "measured",
    elapsedMs,
    budgetMs: APPIMAGE_MOUNTED_STARTUP_BUDGET_MS,
  };
}

async function smokePackagedApplication(
  executable,
  {
    label,
    environment = {},
  },
) {
  log(
    `Smoke-testing ${label} Electron, preload bridge, core handshake, ` +
      "runtime-observable security preferences, renderer isolation, and viewport",
  );
  const smoke = await run(
    "xvfb-run",
    [
      "-a",
      "-s",
      "-screen 0 1920x1200x24",
      executable,
    ],
    {
      capture: true,
      timeoutMs: 45_000,
      env: {
        ...process.env,
        ...environment,
        ANCHORAGE_PACKAGED_SMOKE: "1",
      },
    },
  );
  const output = `${smoke.stdout}\n${smoke.stderr}`;
  if (!output.includes("ANCHORAGE_DESKTOP_SMOKE_OK")) {
    fail(`${label} smoke did not report success:\n${output.trim()}`);
  }
  log(`${label} smoke passed`);
}

async function verifyAppImagePayload(appImage, manifest) {
  const extractionDirectory = await mkdtemp(
    resolve(tmpdir(), "anchorage-appimage-verify-"),
  );
  try {
    log(`Extracting ${appImage.name} for exact payload verification`);
    await run(appImage.path, ["--appimage-extract"], {
      cwd: extractionDirectory,
      capture: true,
      timeoutMs: 120_000,
    });
    const extractionRoot = resolve(
      extractionDirectory,
      "squashfs-root",
    );
    const archiveCandidates = await collectFiles(
      extractionRoot,
      (path) => basename(path) === "app.asar",
    );
    if (archiveCandidates.length !== 1) {
      fail(
        `Expected one app.asar in the extracted AppImage; found ` +
          `${JSON.stringify(archiveCandidates)}`,
      );
    }
    const archive = archiveCandidates[0];
    const resourcesDirectory = resolve(archive, "..");
    const core = join(
      resourcesDirectory,
      "core",
      "anchorage-core",
    );
    const manifestPath = join(
      resourcesDirectory,
      "core",
      "manifest.json",
    );

    const expectedElectronBinary =
      manifest.evidence.hostCandidate.electronBinary;
    const executableCandidates = await collectFiles(
      extractionRoot,
      (path) => basename(path) === "anchorage",
    );
    const executableMatches = [];
    for (const candidate of executableCandidates) {
      const info = await stat(candidate);
      if (
        info.size === expectedElectronBinary.bytes &&
        await sha256File(candidate) === expectedElectronBinary.sha256
      ) {
        executableMatches.push(candidate);
      }
    }
    if (executableMatches.length !== 1) {
      fail(
        `Expected exactly one extracted Anchorage executable matching the ` +
          `host-captured Electron binary; found ` +
          `${JSON.stringify(executableMatches)} among ` +
          `${JSON.stringify(executableCandidates)}`,
      );
    }

    return await verifyPackagedPayload(manifest, {
      executable: executableMatches[0],
      archive,
      core,
      manifestPath,
      label: "extracted AppImage payload",
    });
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }
}

async function verifyInstallers() {
  const artifacts = (await readdir(RELEASE_DIRECTORY, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const appImages = artifacts.filter((name) => name.endsWith(".AppImage"));
  if (appImages.length !== 1) {
    fail(`Expected one AppImage artifact; found ${JSON.stringify(appImages)}`);
  }
  const installers = [];
  for (const name of appImages) {
    const path = join(RELEASE_DIRECTORY, name);
    const info = await assertFile(path, "Linux release artifact");
    if (info.size === 0) {
      fail(`Linux release artifact is empty: ${path}`);
    }
    if ((info.mode & 0o111) === 0) {
      fail(`Linux release artifact is not executable: ${path}`);
    }
    await access(path, constants.X_OK);
    const sha256 = await sha256File(path);
    log(`${name}: ${info.size} bytes, sha256 ${sha256}`);
    installers.push({
      name,
      path,
      sha256,
      bytes: info.size,
    });
  }
  return installers;
}

async function main() {
  if (!VALID_MODES.has(MODE) || process.argv.length !== 3) {
    fail("Usage: package-desktop.mjs --preflight|--dir|--linux");
  }
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail(`Linux x64 packaging requires linux/x64, got ${process.platform}/${process.arch}`);
  }

  candidateWorkStarted = true;
  log("Invalidating stale release, staged core, and generated release evidence");
  await invalidateCandidateOutputs();

  const packageMetadata = JSON.parse(
    await readFile(join(APP_DIRECTORY, "package.json"), "utf8"),
  );
  validatePinnedDevDependencies(packageMetadata);

  const sourceCounts = await validateSources();
  log(
    `Validated source gates (${sourceCounts.rendererTests} renderer, ` +
      `${sourceCounts.protocolTests} protocol, ` +
      `${sourceCounts.securityEvidenceTests} security evidence, ` +
      `${sourceCounts.packageEvidenceTests} package evidence, ` +
      `${sourceCounts.electronTests} Electron, ` +
      `${sourceCounts.coreTests} core tests)`,
  );
  const manifest = await buildAndStage(sourceCounts, packageMetadata);
  if (MODE === "--preflight") {
    log("Preflight passed; fresh renderer and core staging artifacts are ready");
    return;
  }

  const builderArgs = [
    BUILDER_ENTRY,
    "--config",
    BUILDER_CONFIG,
    "--linux",
    "--x64",
    "--publish",
    "never",
  ];
  if (MODE === "--dir") {
    builderArgs.push("--dir");
  }
  log(MODE === "--dir" ? "Building unpacked Linux application" : "Building Linux installers");
  await run(process.execPath, builderArgs);

  const unpackedPayload = await verifyPackagedPayload(manifest, {
    executable: PACKAGED_EXECUTABLE,
    archive: PACKAGED_ASAR,
    core: PACKAGED_CORE,
    manifestPath: PACKAGED_MANIFEST,
    label: "unpacked application",
  });
  await smokePackagedApplication(PACKAGED_EXECUTABLE, {
    label: "unpacked application",
  });
  let appImageVerification = null;
  if (MODE === "--linux") {
    const [appImage] = await verifyInstallers();
    const extractedPayload = await verifyAppImagePayload(
      appImage,
      manifest,
    );
    await smokePackagedApplication(appImage.path, {
      label: "AppImage",
      environment: {
        APPIMAGE_EXTRACT_AND_RUN: "1",
      },
    });
    // The check above runs the payload from a temp directory. This one runs it the way a user
    // does, over the squashfs mount, and is the only place startup cost is visible.
    const mountedStartup = await measureMountedAppImageStartup(appImage);
    appImageVerification = {
      artifact: {
        path: normalizedRelative(REPOSITORY_DIRECTORY, appImage.path),
        sha256: appImage.sha256,
        bytes: appImage.bytes,
      },
      extractedPayload,
      mountedStartup,
    };
  }
  const stagedManifestInfo = await assertFile(
    CORE_MANIFEST,
    "staged release manifest",
  );
  const releaseVerification = {
    schemaVersion: 1,
    status: "passed",
    mode: MODE === "--linux" ? "linux-appimage" : "linux-unpacked",
    completedAt: new Date().toISOString(),
    stagedManifest: {
      path: normalizedRelative(REPOSITORY_DIRECTORY, CORE_MANIFEST),
      sha256: await sha256File(CORE_MANIFEST),
      bytes: stagedManifestInfo.size,
    },
    hostCapturedElectronBinary:
      manifest.evidence.hostCandidate.electronBinary,
    unpackedPayload,
    appImage: appImageVerification,
    // Says which digests survive a rebuild of the same commit, because the answer is not "all
    // of them" and a reader comparing the wrong one would conclude two identical builds carry
    // different software.
    reproducibility: {
      // Verified by building this commit twice: both digests were identical, while the
      // AppImage differed by six bytes.
      deterministic: [
        {
          what: "core",
          sha256: manifest.core.sha256,
          // The strongest of the two claims, and the only one re-derived here.
          verified: "rebuilt-this-run",
          why:
            "Built with -trimpath -buildvcs=false -ldflags=-s -w -buildid= and CGO_ENABLED=0, " +
            "then rebuilt during this run and confirmed byte-identical.",
        },
        {
          what: "renderer",
          sha256: manifest.renderer.sha256,
          // Weaker on purpose. Vite output over pinned inputs has been identical across
          // builds of one commit, but this run does not re-derive it, so say so rather than
          // let it borrow the core's confidence.
          verified: "observed-stable",
          why:
            "Vite output over pinned sources, observed identical across builds of one commit " +
            "but not independently rebuilt during this run.",
        },
      ],
      nonDeterministic: [
        {
          what: "evidence",
          why:
            "Some evidence photographs a live system — host-candidate screenshots of a " +
            "running daemon, measured timings — so its bytes differ every run.",
        },
        {
          what: "appImage",
          why:
            "The manifest binds evidence by digest, so varying evidence varies the manifest, " +
            "the asar and the AppImage. Compare core and renderer instead.",
        },
      ],
    },
  };
  await writeFile(
    RELEASE_VERIFICATION_REPORT,
    `${JSON.stringify(releaseVerification, null, 2)}\n`,
    { mode: 0o644 },
  );
  log(
    `Wrote exact release verification report: ` +
      `${normalizedRelative(REPOSITORY_DIRECTORY, RELEASE_VERIFICATION_REPORT)}`,
  );
  // A build is not a release. Signing happens after packaging, because it needs the
  // operator's passphrase and cannot be automated here, so this reports the state plainly
  // rather than pretending the artifact is publishable.
  //
  // Deliberately not a hard failure: an unsigned local build is a legitimate and common
  // thing to want. What must never happen is an unsigned artifact being mistaken for a
  // signed one, so the distinction is stated at the end of every build, and
  // ANCHORAGE_REQUIRE_SIGNATURE=1 turns it into a gate for a publishing pipeline.
  const signatureReceiptPath = join(RELEASE_DIRECTORY, "release-signature.json");
  let signatureState = "unsigned";
  try {
    const receipt = JSON.parse(await readFile(signatureReceiptPath, "utf8"));
    const appImageEntry = receipt.artifacts?.find((entry) =>
      entry.name?.endsWith(".AppImage"),
    );
    // The receipt has to describe the artifact that was just built, not an earlier one.
    if (receipt.status === "signed" && appImageEntry?.digest !== appImageVerification.sha256) {
      signatureState = "STALE SIGNATURE — the receipt describes a different AppImage";
    } else if (receipt.status === "signed") {
      // The receipt's own claim is not evidence: it is a JSON file that anyone could write.
      // The signature itself is re-verified here, so a hand-written receipt cannot make an
      // unsigned build look signed to a publishing pipeline.
      // gpg exits non-zero on a bad signature, which is a verdict rather than a crash.
      let output = "";
      try {
        const verification = await run(
          "gpg",
          [
            "--verify",
            join(RELEASE_DIRECTORY, "SHA256SUMS.asc"),
            join(RELEASE_DIRECTORY, "SHA256SUMS"),
          ],
          { capture: true, timeoutMs: 60_000 },
        );
        output = `${verification.stdout ?? ""}${verification.stderr ?? ""}`;
      } catch (error) {
        output = String(error?.stderr ?? error?.message ?? error);
      }
      if (
        /Good signature/u.test(output) &&
        output.includes(receipt.signingKeyFingerprint)
      ) {
        signatureState = `signed by ${receipt.signingKeyFingerprint}`;
      } else {
        signatureState = "SIGNATURE DID NOT VERIFY";
      }
    }
  } catch {
    signatureState = "unsigned";
  }
  // Reported, never gated here. Packaging clears the release directory before it builds, so
  // a signature can only ever be applied afterwards — a "require signature" flag on this
  // step could never be satisfied by definition. Enforcement belongs to the publish step,
  // which is `node tools/sign-release.mjs --verify-only`: that re-verifies the signature and
  // every digest against the artifacts actually present.
  log(`Release signature: ${signatureState}`);
  if (!signatureState.startsWith("signed by")) {
    log(
      "  A build is not a release. Sign before publishing: " +
        "node tools/sign-release.mjs --key <fingerprint>",
    );
  }
  log("Linux package verification passed");
}

main().catch(async (error) => {
  if (candidateWorkStarted) {
    try {
      await invalidateCandidateOutputs();
    } catch (cleanupError) {
      process.stderr.write(
        `[anchorage-package] Failed to invalidate the failed candidate: ` +
          `${cleanupError.stack ?? cleanupError.message}\n`,
      );
    }
  }
  process.stderr.write(`[anchorage-package] ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
