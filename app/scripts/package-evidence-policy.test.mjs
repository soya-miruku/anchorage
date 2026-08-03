import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTANCE_MATRIX_VERSION,
  ACCEPTANCE_SCHEMA_VERSION,
  SKIPPABLE_ACCEPTANCE_CHECK_IDS,
} from "../../tools/acceptance-check-ids.mjs";
import {
  DESIGN_PARITY_STATE_IDS,
  DESIGN_VISUAL_CONFORMANCE_CLAIM,
  DESIGN_VISUAL_REVIEW_CRITERIA,
  HOST_CANDIDATE_CHECK_IDS,
  HOST_CANDIDATE_SCREEN_IDS,
  HOST_CANDIDATE_SCREEN_SEMANTIC_IDS,
  HOST_UI_INTERACTION_IDS,
  HOST_UI_PERFORMANCE_CHECK_IDS,
  HOST_UI_PERFORMANCE_PROFILE,
  MUTATION_ACCEPTANCE_CHECK_IDS,
  READ_ONLY_ACCEPTANCE_CHECK_IDS,
  RELEASE_PERFORMANCE_CHECK_IDS,
  RELEASE_PERFORMANCE_PROFILE,
  canonicalPackagedPackageJson,
  validateCapabilityEvidence,
  validateDesignLedger,
  validateHostCandidateEvidence,
  validateMutationConformance,
  validatePackagedElectronRuntimeClosure,
  validatePerformanceEvidence,
  validatePinnedDevDependencies,
  validateReadOnlyAcceptance,
  validateStagedCoreEvidenceHashes,
} from "./package-evidence-policy.mjs";

const SHA = "a".repeat(64);
const ISO = "2026-08-02T20:00:00.000Z";

test("release-critical build and icon dependencies must remain exactly pinned", () => {
  const exact = {
    devDependencies: {
      electron: "43.2.0",
      "electron-builder": "26.15.3",
      "lucide-react": "1.28.0",
    },
  };
  assert.doesNotThrow(() => validatePinnedDevDependencies(exact));

  for (const dependency of Object.keys(exact.devDependencies)) {
    const ranged = structuredClone(exact);
    ranged.devDependencies[dependency] =
      `^${ranged.devDependencies[dependency]}`;
    assert.throws(
      () => validatePinnedDevDependencies(ranged),
      new RegExp(`${dependency} must remain exactly pinned`, "u"),
    );
  }
});

test("canonical packaged package metadata matches electron-builder's runtime subset", () => {
  const source = {
    name: "anchorage",
    productName: "Anchorage",
    desktopName: "anchorage",
    version: "0.1.0",
    description: "Docker desktop",
    author: { name: "Anchorage Contributors" },
    private: true,
    type: "module",
    main: "electron/main.mjs",
    scripts: { test: "node --test" },
    devDependencies: { electron: "43.2.0" },
    allowScripts: { "esbuild@0.25.12": true },
  };
  const packaged = JSON.parse(canonicalPackagedPackageJson(
    JSON.stringify(source),
  ));
  assert.deepEqual(packaged, {
    name: source.name,
    productName: source.productName,
    desktopName: source.desktopName,
    version: source.version,
    description: source.description,
    author: source.author,
    private: source.private,
    type: source.type,
    main: source.main,
    allowScripts: source.allowScripts,
  });
  assert.equal(Object.hasOwn(packaged, "scripts"), false);
  assert.equal(Object.hasOwn(packaged, "devDependencies"), false);
});

function acceptanceFixture(mutationsEnabled) {
  const requiredChecks = mutationsEnabled
    ? [...READ_ONLY_ACCEPTANCE_CHECK_IDS, ...MUTATION_ACCEPTANCE_CHECK_IDS].sort()
    : [...READ_ONLY_ACCEPTANCE_CHECK_IDS];
  return {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    matrixVersion: ACCEPTANCE_MATRIX_VERSION,
    startedAt: ISO,
    completedAt: ISO,
    corePath: "/tmp/anchorage-core",
    coreSha256: SHA,
    generator: { path: "/tmp/run-core-acceptance.mjs", sha256: SHA },
    mutationsEnabled,
    status: "passed",
    requiredChecks,
    checks: requiredChecks.map((id) => ({
      id,
      name: `Acceptance check: ${id}`,
      status: "passed",
    })),
    skippedChecks: [],
    cleanup: { status: "passed", errors: [] },
    error: null,
  };
}

test("mutation and read-only acceptance enforce distinct modes and passing checks", () => {
  const mutation = acceptanceFixture(true);
  validateMutationConformance(mutation);
  assert.throws(
    () =>
      validateReadOnlyAcceptance(mutation, {
        expectedCorePath: mutation.corePath,
        expectedCoreSha256: SHA,
      }),
    /mutationsEnabled=false/u,
  );

  const readOnly = acceptanceFixture(false);
  validateReadOnlyAcceptance(readOnly, {
    expectedCorePath: readOnly.corePath,
    expectedCoreSha256: SHA,
  });
  assert.throws(
    () => validateMutationConformance(readOnly),
    /mutationsEnabled=true/u,
  );
  mutation.checks[0].status = "failed";
  assert.throws(() => validateMutationConformance(mutation), /only named checks that passed/u);
});

test("acceptance evidence permits a skip only for an absent optional plugin, and only on the record", () => {
  // Compose and Scout are optional Docker CLI plugins, so a release machine can lack them.
  // Everything else skipping means the matrix did not exercise what it claims to cover.
  const skippableId = SKIPPABLE_ACCEPTANCE_CHECK_IDS[0];
  const permitted = acceptanceFixture(true);
  permitted.checks = permitted.checks.map((check) =>
    check.id === skippableId ? { ...check, status: "skipped" } : check,
  );
  permitted.skippedChecks = [skippableId];
  validateMutationConformance(permitted, { corePath: "/tmp/anchorage-core", coreSha256: SHA });

  // A skip that is not recorded reads as a pass to anyone signing the release off.
  const unrecorded = acceptanceFixture(true);
  unrecorded.checks = unrecorded.checks.map((check) =>
    check.id === skippableId ? { ...check, status: "skipped" } : check,
  );
  assert.throws(
    () =>
      validateMutationConformance(unrecorded, {
        corePath: "/tmp/anchorage-core",
        coreSha256: SHA,
      }),
    /skippedChecks must record exactly/u,
  );

  // A skip claimed on the record but not actually skipped is equally misleading.
  const overclaimed = acceptanceFixture(true);
  overclaimed.skippedChecks = [skippableId];
  assert.throws(
    () =>
      validateMutationConformance(overclaimed, {
        corePath: "/tmp/anchorage-core",
        coreSha256: SHA,
      }),
    /skippedChecks must record exactly/u,
  );

  // A non-optional check may never skip.
  const mandatory = acceptanceFixture(true);
  const mandatoryId = mandatory.checks
    .map((check) => check.id)
    .find((id) => !SKIPPABLE_ACCEPTANCE_CHECK_IDS.includes(id));
  mandatory.checks = mandatory.checks.map((check) =>
    check.id === mandatoryId ? { ...check, status: "skipped" } : check,
  );
  mandatory.skippedChecks = [mandatoryId];
  assert.throws(
    () =>
      validateMutationConformance(mandatory, {
        corePath: "/tmp/anchorage-core",
        coreSha256: SHA,
      }),
    /only named checks that passed/u,
  );
});

test("acceptance evidence rejects missing, duplicate, extra, and self-declared check matrices", () => {
  const mutation = acceptanceFixture(true);
  mutation.checks.pop();
  assert.throws(
    () => validateMutationConformance(mutation),
    /exact required check set/u,
  );

  const duplicate = acceptanceFixture(true);
  duplicate.checks[1].id = duplicate.checks[0].id;
  assert.throws(
    () => validateMutationConformance(duplicate),
    /unique check ids/u,
  );

  const extra = acceptanceFixture(false);
  extra.checks.push({
    id: "unreviewed-extra-check",
    name: "Unreviewed extra check",
    status: "passed",
  });
  assert.throws(
    () =>
      validateReadOnlyAcceptance(extra, {
        expectedCorePath: extra.corePath,
        expectedCoreSha256: SHA,
      }),
    /exact required check set/u,
  );

  const selfDeclared = acceptanceFixture(false);
  selfDeclared.requiredChecks = selfDeclared.requiredChecks.slice(1);
  assert.throws(
    () =>
      validateReadOnlyAcceptance(selfDeclared, {
        expectedCorePath: selfDeclared.corePath,
        expectedCoreSha256: SHA,
      }),
    /requiredChecks must equal matrix v2/u,
  );
});

test("design ledger requires recorded review and every measured state passed", () => {
  const rendererBuild = { sha256: SHA, files: 21, bytes: 1_073_738 };
  const states = DESIGN_PARITY_STATE_IDS.map((state, index) => {
    return {
      state,
      path: `final-actual/${state}.png`,
      sha256: SHA,
      bytes: 10_000 + index,
      dimensions: { width: 1656, height: 1056 },
    };
  });
  const visualReviewStates = states.map((capture, index) => ({
    state: capture.state,
    status: "approved",
    reviewer: {
      kind: "agent-visual-review",
      name: "Codex visual QA",
    },
    criteria: [...DESIGN_VISUAL_REVIEW_CRITERIA],
    notes: `Reviewed canonical state ${capture.state} side by side.`,
    reference: {
      path:
        `docs/design_handoff_anchorage/reference-captures/${capture.state}.png`,
      sha256: SHA,
      bytes: 20_000 + index,
      dimensions: { width: 1656, height: 1056 },
    },
    actual: {
      path: `docs/design-qa/final-actual/${capture.state}.png`,
      sha256: capture.sha256,
      bytes: capture.bytes,
      dimensions: { ...capture.dimensions },
    },
  }));
  const visualReviewAttestation = {
    schemaVersion: 1,
    claim: DESIGN_VISUAL_CONFORMANCE_CLAIM,
    reviewedAt: ISO,
    states: visualReviewStates,
  };
  const ledger = {
    schemaVersion: 1,
    generatedAt: ISO,
    claim: DESIGN_VISUAL_CONFORMANCE_CLAIM,
    canonicalViewport: { width: 1656, height: 1056 },
    reviewRecorded: true,
    generator: {
      path: "tools/measure-design-parity.mjs",
      sha256: SHA,
    },
    handoffSource: {
      scope: "anchorage-design-handoff-v1",
      sha256: SHA,
      files: 27,
      bytes: 2_000_000,
      declaredSources: [
        "docs/design_handoff_anchorage/Anchorage.dc.html",
        "docs/design_handoff_anchorage/README.md",
        "docs/design_handoff_anchorage/support.js",
      ],
      referenceDirectory:
        "docs/design_handoff_anchorage/reference-captures",
    },
    visualReviewAttestation: {
      source: {
        path: "docs/design-qa/visual-review-attestation.json",
        sha256: SHA,
        bytes: 100_000,
      },
      attestation: visualReviewAttestation,
    },
    rendererBuild,
    captureProvenance: {
      schemaVersion: 1,
      captureMode: "fixture-browser",
      bridgeMode: "fixture",
      capturedAt: ISO,
      source: "app/dist/client",
      canonicalViewport: { width: 1656, height: 1056 },
      rendererBuild,
      harness: {
        path: "tools/capture-design-parity.mjs",
        sha256: SHA,
      },
      runtime: {
        executable: "app/node_modules/electron/dist/electron",
        product: "Chrome/142.0.0.0",
        protocolVersion: "1.3",
        revision: "@revision",
        userAgent: "Mozilla/5.0 Electron/43.2.0",
        jsVersion: "14.2.0",
      },
      states,
    },
    summary: { total: 24, passed: 24 },
    rows: states.map((capture, index) => {
      const state = capture.state;
      return {
        state,
        status: "passed",
        mae: { normalized: 0.01 },
        reviewThreshold: 0.02,
        referenceEvidence: {
          sha256: SHA,
          bytes: visualReviewStates[index].reference.bytes,
          dimensions: {
            ...visualReviewStates[index].reference.dimensions,
          },
        },
        reference: `reference/${state}.png`,
        actual: `actual/${state}.png`,
        diff: `diffs/${state}.png`,
        actualEvidence: {
          sha256: capture.sha256,
          bytes: capture.bytes,
          dimensions: capture.dimensions,
        },
        visualReview: {
          status: visualReviewStates[index].status,
          reviewer: visualReviewStates[index].reviewer,
          criteria: visualReviewStates[index].criteria,
          notes: visualReviewStates[index].notes,
        },
      };
    }),
  };
  const options = {
    expectedRendererBuild: rendererBuild,
    expectedCaptureHarnessSha256: SHA,
    expectedDesignGeneratorSha256: SHA,
    expectedDesignHandoffSource: {
      sha256: SHA,
      files: 27,
      bytes: 2_000_000,
    },
    expectedVisualReviewSource: {
      path: "docs/design-qa/visual-review-attestation.json",
      sha256: SHA,
      bytes: 100_000,
    },
    expectedVisualReviewAttestation: visualReviewAttestation,
  };
  validateDesignLedger(ledger, options);
  ledger.generator.sha256 = "b".repeat(64);
  assert.throws(
    () => validateDesignLedger(ledger, options),
    /generator must match the current source/u,
  );
  ledger.generator.sha256 = SHA;
  ledger.claim = "pixel-identical";
  assert.throws(
    () => validateDesignLedger(ledger, options),
    /without claiming pixel identity/u,
  );
  ledger.claim = DESIGN_VISUAL_CONFORMANCE_CLAIM;
  ledger.visualReviewAttestation.source.sha256 = "b".repeat(64);
  assert.throws(
    () => validateDesignLedger(ledger, options),
    /visual review sidecar must match the current source/u,
  );
  ledger.visualReviewAttestation.source.sha256 = SHA;
  ledger.handoffSource.sha256 = "b".repeat(64);
  assert.throws(
    () => validateDesignLedger(ledger, options),
    /handoff source must match the current source files/u,
  );
  ledger.handoffSource.sha256 = SHA;
  ledger.reviewRecorded = false;
  assert.throws(
    () => validateDesignLedger(ledger, options),
    /paired visual review/u,
  );
  ledger.reviewRecorded = true;
  ledger.rendererBuild = { ...rendererBuild, bytes: rendererBuild.bytes - 1 };
  assert.throws(
    () => validateDesignLedger(ledger, options),
    /exact freshly built renderer/u,
  );
  ledger.rendererBuild = rendererBuild;
  ledger.captureProvenance.bridgeMode = "host";
  assert.throws(
    () => validateDesignLedger(ledger, options),
    /fixture bridge provenance/u,
  );
  ledger.captureProvenance.bridgeMode = "fixture";
  ledger.rows[0].actualEvidence.sha256 = "b".repeat(64);
  assert.throws(
    () => validateDesignLedger(ledger, options),
    /actual evidence must match capture provenance/u,
  );
  ledger.rows[0].actualEvidence.sha256 = SHA;
  ledger.rows[0].state = "../../outside";
  assert.throws(
    () => validateDesignLedger(ledger, options),
    /exact canonical state set/u,
  );
});

test("capability evidence requires unblocked transport coverage without claiming command conformance", () => {
  const generation = {
    schemaVersion: 1,
    startedAt: ISO,
    completedAt: ISO,
    sourceObservedAt: ISO,
    context: "default",
    complete: true,
    nodeCount: 2,
    leafCount: 1,
    transportCovered: 1,
    commandExecutedConformancePassed: 0,
    blocked: 0,
    coreSha256: SHA,
    dockerBinarySha256: SHA,
    generator: { sha256: SHA },
  };
  const ledger = {
    schemaVersion: 1,
    generatedAt: ISO,
    sourceObservedAt: ISO,
    selectedContext: "default",
    inventory: {
      complete: true,
      nodeCount: 2,
      leafCount: 1,
      transportCovered: 1,
      commandExecutedConformancePassed: 0,
      blocked: 0,
      warnings: [],
    },
    rows: [
      {
        id: "docker:version",
        status: "transport-covered",
        blockedReason: null,
        result: {
          coverage: "executable-through-installed-cli",
          commandExecution:
            "not-run-by-ledger-generator; command behavior is not claimed",
        },
        transportEvidence: ["literal argv transport test"],
        commandIdentity: {
          executable: "/usr/bin/docker",
          executableSha256: SHA,
          plugin: null,
          path: ["version"],
          command: "docker version",
          kind: "builtin",
        },
        discovery: {
          status: "available",
          reason: "exact help succeeded",
          usage: null,
          transports: ["cli"],
        },
        invocation: {
          context: "default",
          argvPrefix: ["--context", "default"],
          commandArgv: ["version"],
        },
        uiPath: { selection: "version" },
      },
    ],
  };
  const systemCapabilities = {
    observedAt: ISO,
    selectedContext: "default",
    currentContext: "default",
    binary: { sha256: SHA, realPath: "/usr/bin/docker" },
    commandInventory: {
      complete: true,
      limitReached: false,
      nodeCount: 2,
      warnings: [],
      root: {
        path: [],
        status: "available",
        subcommands: [
          {
            path: ["version"],
            status: "available",
            reason: "exact help succeeded",
            kind: "builtin",
            transports: ["cli"],
            subcommands: [],
          },
        ],
      },
    },
  };
  validateCapabilityEvidence({ generation, ledger, systemCapabilities });
  ledger.inventory.blocked = 1;
  assert.throws(
    () => validateCapabilityEvidence({ generation, ledger, systemCapabilities }),
    /inventory must match/u,
  );
  ledger.inventory.blocked = 0;
  ledger.rows[0].commandIdentity.path = ["info"];
  assert.throws(
    () => validateCapabilityEvidence({ generation, ledger, systemCapabilities }),
    /one-to-one with available leaves/u,
  );
});

test("performance evidence requires the paired authoritative read-only soak", () => {
  const results = {
    schemaVersion: 1,
    status: "passed",
    readOnly: true,
    context: "default",
    requestedSoakDurationSeconds: 1_800,
    streamingSoak: {
      requestedDurationSeconds: 1_800,
      actualDurationMs: 1_800_001,
      rssSamples: [{}, {}],
      rssBytes: { p95: 80_000_000, max: 90_000_000 },
      rssDeltaBytes: -1_000_000,
      cancellation: {
        cancelToExitMs: 25,
        exit: { output: { droppedBytes: 0, truncated: false } },
      },
      sessionOutput: {
        events: 5,
        acknowledgements: 5,
        bytes: 100,
        acknowledgedBytes: 100,
      },
    },
    health: {
      cold: { latencyMs: 100 },
      warm: { latencyMs: { p95: 10, count: 20 } },
    },
    nativeLists: {
      containers: {
        firstLatencyMs: 100,
        subsequentLatencyMs: { p95: 20, count: 20 },
      },
      images: {
        firstLatencyMs: 200,
        subsequentLatencyMs: { p95: 30, count: 20 },
      },
      volumes: {
        firstLatencyMs: 300,
        subsequentLatencyMs: { p95: 40, count: 20 },
      },
      snapshot: {
        firstLatencyMs: 400,
        subsequentLatencyMs: { p95: 50, count: 20 },
      },
      capabilities: {
        firstLatencyMs: 900,
        subsequentLatencyMs: { p95: 60, count: 20 },
      },
    },
    visibleContainerStats: {
      wallLatencyMs: { p95: 50 },
      individualLatencyMs: { p95: 45 },
      requestedFanout: 4,
      actualFanout: 4,
      requestedRounds: 20,
      actualRounds: 20,
      samples: Array.from({ length: 80 }, (_, index) => ({ index })),
    },
    coreExit: { code: 0, signal: null },
    completedAt: ISO,
  };
  const observedById = {
    "cold-health-latency": results.health.cold.latencyMs,
    "warm-health-p95-latency": results.health.warm.latencyMs.p95,
    "containers-first-latency":
      results.nativeLists.containers.firstLatencyMs,
    "containers-warm-p95-latency":
      results.nativeLists.containers.subsequentLatencyMs.p95,
    "images-first-latency": results.nativeLists.images.firstLatencyMs,
    "images-warm-p95-latency":
      results.nativeLists.images.subsequentLatencyMs.p95,
    "volumes-first-latency": results.nativeLists.volumes.firstLatencyMs,
    "volumes-warm-p95-latency":
      results.nativeLists.volumes.subsequentLatencyMs.p95,
    "snapshot-first-latency": results.nativeLists.snapshot.firstLatencyMs,
    "snapshot-warm-p95-latency":
      results.nativeLists.snapshot.subsequentLatencyMs.p95,
    "capabilities-first-latency":
      results.nativeLists.capabilities.firstLatencyMs,
    "capabilities-warm-p95-latency":
      results.nativeLists.capabilities.subsequentLatencyMs.p95,
    "stats-fanout-wall-latency":
      results.visibleContainerStats.wallLatencyMs.p95,
    "stats-individual-p95-latency":
      results.visibleContainerStats.individualLatencyMs.p95,
    "session-cancel-to-exit":
      results.streamingSoak.cancellation.cancelToExitMs,
    "core-rss-p95": results.streamingSoak.rssBytes.p95,
    "core-rss-max": results.streamingSoak.rssBytes.max,
    "core-rss-growth": Math.max(0, results.streamingSoak.rssDeltaBytes),
    "warm-health-sample-floor": results.health.warm.latencyMs.count,
    "containers-warm-sample-floor":
      results.nativeLists.containers.subsequentLatencyMs.count,
    "images-warm-sample-floor":
      results.nativeLists.images.subsequentLatencyMs.count,
    "volumes-warm-sample-floor":
      results.nativeLists.volumes.subsequentLatencyMs.count,
    "stats-round-sample-floor":
      results.visibleContainerStats.actualRounds,
    "stats-fanout-complete":
      results.visibleContainerStats.actualFanout,
    "stats-rounds-complete":
      results.visibleContainerStats.actualRounds,
    "stats-sample-matrix-complete":
      results.visibleContainerStats.samples.length,
    "session-output-not-dropped":
      results.streamingSoak.cancellation.exit.output.droppedBytes,
    "session-output-not-truncated":
      results.streamingSoak.cancellation.exit.output.truncated,
    "session-event-acknowledgements":
      results.streamingSoak.sessionOutput.acknowledgements,
    "session-byte-acknowledgements":
      results.streamingSoak.sessionOutput.acknowledgedBytes,
  };
  const expectedById = {
    "stats-fanout-complete":
      results.visibleContainerStats.requestedFanout,
    "stats-rounds-complete":
      results.visibleContainerStats.requestedRounds,
    "stats-sample-matrix-complete":
      results.visibleContainerStats.actualFanout *
      results.visibleContainerStats.actualRounds,
    "session-output-not-dropped": 0,
    "session-output-not-truncated": false,
    "session-event-acknowledgements":
      results.streamingSoak.sessionOutput.events,
    "session-byte-acknowledgements":
      results.streamingSoak.sessionOutput.bytes,
  };
  const maximumChecks = [
    ["cold-health-latency", "health.cold.latencyMs", "coldHealthLatencyMs"],
    [
      "warm-health-p95-latency",
      "health.warm.latencyMs.p95",
      "warmHealthP95LatencyMs",
    ],
    [
      "containers-first-latency",
      "nativeLists.containers.firstLatencyMs",
      "containersFirstLatencyMs",
    ],
    [
      "containers-warm-p95-latency",
      "nativeLists.containers.subsequentLatencyMs.p95",
      "containersWarmP95LatencyMs",
    ],
    [
      "images-first-latency",
      "nativeLists.images.firstLatencyMs",
      "imagesFirstLatencyMs",
    ],
    [
      "images-warm-p95-latency",
      "nativeLists.images.subsequentLatencyMs.p95",
      "imagesWarmP95LatencyMs",
    ],
    [
      "volumes-first-latency",
      "nativeLists.volumes.firstLatencyMs",
      "volumesFirstLatencyMs",
    ],
    [
      "volumes-warm-p95-latency",
      "nativeLists.volumes.subsequentLatencyMs.p95",
      "volumesWarmP95LatencyMs",
    ],
    [
      "snapshot-first-latency",
      "nativeLists.snapshot.firstLatencyMs",
      "snapshotFirstLatencyMs",
    ],
    [
      "snapshot-warm-p95-latency",
      "nativeLists.snapshot.subsequentLatencyMs.p95",
      "snapshotWarmP95LatencyMs",
    ],
    [
      "capabilities-first-latency",
      "nativeLists.capabilities.firstLatencyMs",
      "capabilitiesFirstLatencyMs",
    ],
    [
      "capabilities-warm-p95-latency",
      "nativeLists.capabilities.subsequentLatencyMs.p95",
      "capabilitiesWarmP95LatencyMs",
    ],
    [
      "stats-fanout-wall-latency",
      "visibleContainerStats.wallLatencyMs.p95",
      "statsFanoutWallLatencyMs",
    ],
    [
      "stats-individual-p95-latency",
      "visibleContainerStats.individualLatencyMs.p95",
      "statsIndividualP95LatencyMs",
    ],
    [
      "session-cancel-to-exit",
      "streamingSoak.cancellation.cancelToExitMs",
      "sessionCancelToExitMs",
    ],
    [
      "core-rss-p95",
      "streamingSoak.rssBytes.p95",
      "coreRssP95Bytes",
    ],
    [
      "core-rss-max",
      "streamingSoak.rssBytes.max",
      "coreRssMaxBytes",
    ],
    [
      "core-rss-growth",
      "max(0, streamingSoak.rssDeltaBytes)",
      "coreRssGrowthBytes",
    ],
  ];
  const minimumChecks = [
    [
      "warm-health-sample-floor",
      "health.warm.latencyMs.count",
      "warmHealthMinimumSamples",
    ],
    [
      "containers-warm-sample-floor",
      "nativeLists.containers.subsequentLatencyMs.count",
      "listWarmMinimumSamples",
    ],
    [
      "images-warm-sample-floor",
      "nativeLists.images.subsequentLatencyMs.count",
      "listWarmMinimumSamples",
    ],
    [
      "volumes-warm-sample-floor",
      "nativeLists.volumes.subsequentLatencyMs.count",
      "listWarmMinimumSamples",
    ],
    [
      "stats-round-sample-floor",
      "visibleContainerStats.actualRounds",
      "statsMinimumRounds",
    ],
  ];
  const metricsByEqualId = {
    "stats-fanout-complete":
      "visibleContainerStats.actualFanout",
    "stats-rounds-complete":
      "visibleContainerStats.actualRounds",
    "stats-sample-matrix-complete":
      "visibleContainerStats.samples.length",
    "session-output-not-dropped":
      "streamingSoak.cancellation.exit.output.droppedBytes",
    "session-output-not-truncated":
      "streamingSoak.cancellation.exit.output.truncated",
    "session-event-acknowledgements":
      "streamingSoak.sessionOutput.acknowledgements",
    "session-byte-acknowledgements":
      "streamingSoak.sessionOutput.acknowledgedBytes",
  };
  results.performanceSLO = {
    profile: RELEASE_PERFORMANCE_PROFILE.id,
    thresholds: { ...RELEASE_PERFORMANCE_PROFILE.thresholds },
    status: "passed",
    checks: [
      ...maximumChecks.map(([id, metric, threshold]) => ({
        id,
        metric,
        comparison: "<=",
        observed: observedById[id],
        limit: RELEASE_PERFORMANCE_PROFILE.thresholds[threshold],
        status: "passed",
      })),
      ...minimumChecks.map(([id, metric, threshold]) => ({
        id,
        metric,
        comparison: ">=",
        observed: observedById[id],
        limit: RELEASE_PERFORMANCE_PROFILE.thresholds[threshold],
        status: "passed",
      })),
      ...Object.entries(metricsByEqualId).map(([id, metric]) => ({
        id,
        metric,
        comparison: "===",
        observed: observedById[id],
        expected: expectedById[id],
        status: "passed",
      })),
    ],
  };
  const environment = {
    schemaVersion: 1,
    harness: {
      script: "tools/run-performance-evidence.mjs",
      sha256: SHA,
      readOnly: true,
      context: "default",
      requestedSoakDurationSeconds: 1_800,
    },
    tools: {
      core: {
        sha256: SHA,
        runtime: { protocolVersion: "1", dockerReady: true },
      },
    },
    completedAt: ISO,
  };
  const performanceOptions = { expectedHarnessSha256: SHA };
  validatePerformanceEvidence({ results, environment }, performanceOptions);
  environment.harness.sha256 = "b".repeat(64);
  assert.throws(
    () =>
      validatePerformanceEvidence(
        { results, environment },
        performanceOptions,
      ),
    /harness must match the current source/u,
  );
  environment.harness.sha256 = SHA;
  results.requestedSoakDurationSeconds = 5;
  assert.throws(
    () =>
      validatePerformanceEvidence(
        { results, environment },
        performanceOptions,
      ),
    /authoritative soak duration/u,
  );
  results.requestedSoakDurationSeconds = 1_800;
  results.performanceSLO.checks.pop();
  assert.throws(
    () =>
      validatePerformanceEvidence(
        { results, environment },
        performanceOptions,
      ),
    /exact release SLO check set/u,
  );
  results.performanceSLO.checks = results.performanceSLO.checks.concat({
    ...results.performanceSLO.checks[0],
  });
  assert.throws(
    () =>
      validatePerformanceEvidence(
        { results, environment },
        performanceOptions,
      ),
    /unique release SLO check ids/u,
  );
  results.performanceSLO.checks = results.performanceSLO.checks.slice(0, -1);
  results.performanceSLO.checks.push({
    id: "session-byte-acknowledgements",
    metric: "streamingSoak.sessionOutput.acknowledgedBytes",
    comparison: "===",
    observed: 99,
    expected: 100,
    status: "passed",
  });
  assert.throws(
    () =>
      validatePerformanceEvidence(
        { results, environment },
        performanceOptions,
      ),
    /observed values must match results/u,
  );
});

function hostCandidateFixture() {
  const file = (path) => ({ path, sha256: SHA, bytes: 1_024 });
  const semanticActual = (id) => {
    if (id === "host-dashboard-live-context") return "default";
    if (id === "host-containers-live-row") return 1;
    if (id === "host-container-detail-identity") return "fixture-container";
    if (id === "host-command-target-pinned") return "pinned";
    if (id === "host-command-target-literal") return "literal";
    return true;
  };
  const screens = HOST_CANDIDATE_SCREEN_IDS.map((id, index) => ({
    id,
    path: `screens/${id}.png`,
    sha256: SHA,
    bytes: 10_000 + index,
    dimensions: { width: 1656, height: 1056 },
    semanticChecks: HOST_CANDIDATE_SCREEN_SEMANTIC_IDS[id].map(
      (semanticId) => ({
        id: semanticId,
        name: `Host semantic check: ${semanticId}`,
        status: "passed",
        actual: semanticActual(semanticId),
      }),
    ),
  }));
  const runtimeClosure = {
    scope: "packaged-electron-runtime-v1",
    sha256: SHA,
    files: 10,
    bytes: 50_000,
  };
  const uiMetricsById = {
    "spawn-to-host-ready": "spawnToHostReadyMs",
    "navigation-dom-content-loaded": "navigationDomContentLoadedMs",
    "first-contentful-paint": "firstContentfulPaintMs",
    "scripted-interaction-settle-max":
      "scriptedInteractionSettleMaxMs",
    "bounded-dom-nodes": "domNodeCount",
    "bounded-visible-container-rows": "visibleContainerRows",
  };
  const uiObservations = {
    spawnToHostReadyMs: 5_000,
    navigationDomContentLoadedMs: 500,
    firstContentfulPaintMs: 600,
    scriptedInteractionSettleMaxMs: 800,
    domNodeCount: 1_000,
    visibleContainerRows: 14,
    liveContainerCount: 57,
  };
  const evidence = {
      schemaVersion: 1,
      // The host-candidate matrix is versioned independently of the
      // operation-conformance matrix and is still at v1.
      matrixVersion: 1,
      status: "passed",
      candidateMode: "staged-inputs",
      scope: "host-integration-smoke-not-pixel-parity",
      bridgeMode: "host",
      startedAt: ISO,
      completedAt: ISO,
      source: "app/dist/client",
      canonicalViewport: { width: 1656, height: 1056 },
      requiredChecks: [...HOST_CANDIDATE_CHECK_IDS],
      requiredScreens: [...HOST_CANDIDATE_SCREEN_IDS],
      checks: HOST_CANDIDATE_CHECK_IDS.map((id) => ({
        id,
        name: `Host candidate check: ${id}`,
        status: "passed",
      })),
      candidate: {
        rendererBuild: { sha256: SHA, files: 21, bytes: 1_073_738 },
        core: file("app/build/core/anchorage-core"),
        electron: {
          binary: file("app/node_modules/electron/dist/electron"),
          main: file("app/electron/main.mjs"),
          preload: file("app/electron/preload.cjs"),
          runtimeClosure,
        },
        protocolSchema: file("protocol/v1.schema.json"),
        harness: file("tools/capture-host-candidate.mjs"),
      },
      runtime: {
        product: "Chrome/142.0.0.0",
        protocolVersion: "1.3",
        revision: "@revision",
        userAgent: "Mozilla/5.0 Electron/43.2.0",
        jsVersion: "14.2.0",
      },
      bridge: {
        hostApiPresent: true,
        fixtureBridgeAbsent: true,
        functions: [
          "cli.run",
          "containers.inspect",
          "containers.list",
          "containers.stats",
          "images.list",
          "session.start",
          "subscribe",
          "system.capabilities",
          "system.snapshot",
          "volumes.list",
          "window.close",
        ],
      },
      docker: {
        context: "default",
        ready: true,
        containerAvailable: true,
        containerCount: 57,
      },
      cli: {
        pinned: { targetMode: "pinned", exitCode: 0, outputPresent: true },
        literal: { targetMode: "literal", exitCode: 0, outputPresent: true },
        cwdSensitive: {
          targetMode: "pinned",
          exitCode: 0,
          timedOut: false,
          composeConfigValidated: true,
          outsideHome: true,
          requestedCwd: "/tmp/anchorage-cwd-proof",
          resultCwd: "/tmp/anchorage-cwd-proof",
          executedArgv: [
            "--context",
            "default",
            "compose",
            "--project-name",
            "anchorage-cwd-proof",
            "config",
            "--quiet",
          ],
        },
      },
      diagnostics: {
        consoleErrors: [],
        pageErrors: [],
        processErrors: [],
      },
      processExit: { code: 0, signal: null },
      uiPerformance: {
        schemaVersion: 1,
        profile: HOST_UI_PERFORMANCE_PROFILE.id,
        thresholds: { ...HOST_UI_PERFORMANCE_PROFILE.thresholds },
        status: "passed",
        observations: uiObservations,
        interactionTimings: HOST_UI_INTERACTION_IDS.map((id, index) => ({
          id,
          durationMs: index === HOST_UI_INTERACTION_IDS.length - 1
            ? uiObservations.scriptedInteractionSettleMaxMs
            : 100 + index,
        })),
        checks: HOST_UI_PERFORMANCE_CHECK_IDS.map((id) => {
          const metric = uiMetricsById[id];
          return {
            id,
            metric,
            comparison: "<=",
            observed: uiObservations[metric],
            limit: HOST_UI_PERFORMANCE_PROFILE.thresholds[metric],
            status: "passed",
          };
        }),
      },
      screens,
  };
  return {
    evidence,
    expected: {
      expectedRendererBuild: {
        sha256: SHA,
        files: 21,
        bytes: 1_073_738,
      },
      expectedCore: file("app/build/core/anchorage-core"),
      expectedElectronBinary: file(
        "app/node_modules/electron/dist/electron",
      ),
      expectedElectronMain: file("app/electron/main.mjs"),
      expectedElectronPreload: file("app/electron/preload.cjs"),
      expectedElectronRuntimeClosure: { ...runtimeClosure },
      expectedProtocolSchema: file("protocol/v1.schema.json"),
      expectedHarnessSha256: SHA,
      observedScreens: screens.map((screen) => ({
        id: screen.id,
        path: screen.path,
        sha256: screen.sha256,
        bytes: screen.bytes,
        dimensions: { ...screen.dimensions },
      })),
    },
  };
}

test("host candidate evidence binds exact staged inputs and real HostBridge semantics", () => {
  const { evidence, expected } = hostCandidateFixture();
  validateHostCandidateEvidence(evidence, expected);

  evidence.bridgeMode = "fixture";
  assert.throws(
    () => validateHostCandidateEvidence(evidence, expected),
    /real HostBridge/u,
  );
  evidence.bridgeMode = "host";
  evidence.candidate.core.sha256 = "b".repeat(64);
  assert.throws(
    () => validateHostCandidateEvidence(evidence, expected),
    /exact staged core/u,
  );
  evidence.candidate.core.sha256 = SHA;
  evidence.candidate.electron.runtimeClosure.sha256 = "b".repeat(64);
  assert.throws(
    () => validateHostCandidateEvidence(evidence, expected),
    /exact packaged Electron runtime closure/u,
  );
  evidence.candidate.electron.runtimeClosure.sha256 = SHA;
  evidence.uiPerformance.checks[0].observed =
    evidence.uiPerformance.checks[0].limit + 1;
  assert.throws(
    () => validateHostCandidateEvidence(evidence, expected),
    /host UI performance observations must satisfy policy/u,
  );
  evidence.uiPerformance.checks[0].observed =
    evidence.uiPerformance.observations.spawnToHostReadyMs;
  evidence.uiPerformance.interactionTimings[0].id = "unowned-interaction";
  assert.throws(
    () => validateHostCandidateEvidence(evidence, expected),
    /exact passing host UI interaction matrix/u,
  );
  evidence.uiPerformance.interactionTimings[0].id =
    HOST_UI_INTERACTION_IDS[0];
  evidence.diagnostics.consoleErrors.push("renderer exploded");
  assert.throws(
    () => validateHostCandidateEvidence(evidence, expected),
    /zero console, page, and process errors/u,
  );
});

test("host candidate evidence rejects partial matrices and unbound screenshots", () => {
  const { evidence, expected } = hostCandidateFixture();
  evidence.checks.pop();
  assert.throws(
    () => validateHostCandidateEvidence(evidence, expected),
    /exact required check set/u,
  );

  const duplicate = hostCandidateFixture();
  duplicate.evidence.screens[1].id = duplicate.evidence.screens[0].id;
  assert.throws(
    () =>
      validateHostCandidateEvidence(
        duplicate.evidence,
        duplicate.expected,
      ),
    /exact required screen set/u,
  );

  const badScreen = hostCandidateFixture();
  badScreen.evidence.screens[0].sha256 = "not-a-digest";
  assert.throws(
    () =>
      validateHostCandidateEvidence(
        badScreen.evidence,
        badScreen.expected,
      ),
    /screen semantics/u,
  );

  const selfDeclaredSemantic = hostCandidateFixture();
  selfDeclaredSemantic.evidence.screens[0].semanticChecks[0].id =
    "self-declared-visible";
  assert.throws(
    () =>
      validateHostCandidateEvidence(
        selfDeclaredSemantic.evidence,
        selfDeclaredSemantic.expected,
      ),
    /policy-owned passing screen semantics/u,
  );

  const mismatchedFile = hostCandidateFixture();
  mismatchedFile.expected.observedScreens[0].sha256 = "b".repeat(64);
  assert.throws(
    () =>
      validateHostCandidateEvidence(
        mismatchedFile.evidence,
        mismatchedFile.expected,
      ),
    /match recomputed PNG files/u,
  );
});

test("staged core and packaged Electron closure fail closed on byte drift", () => {
  validateStagedCoreEvidenceHashes(SHA, {
    mutation: SHA,
    capability: SHA,
    performance: SHA,
  });
  assert.throws(
    () =>
      validateStagedCoreEvidenceHashes(SHA, {
        mutation: SHA,
        capability: "b".repeat(64),
        performance: SHA,
      }),
    /capability-tested core/u,
  );

  const closure = {
    scope: "packaged-electron-runtime-v1",
    sha256: SHA,
    files: 10,
    bytes: 50_000,
  };
  validatePackagedElectronRuntimeClosure(closure, closure);
  assert.throws(
    () =>
      validatePackagedElectronRuntimeClosure(
        { ...closure, sha256: "b".repeat(64) },
        closure,
      ),
    /HostBridge-captured runtime/u,
  );
});
