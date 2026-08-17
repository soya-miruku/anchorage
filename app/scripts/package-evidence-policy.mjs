import { isDeepStrictEqual } from "node:util";
import {
  ACCEPTANCE_MATRIX_VERSION,
  ACCEPTANCE_SCHEMA_VERSION,
  MUTATION_ACCEPTANCE_CHECK_IDS as MUTATION_IDS,
  READ_ONLY_ACCEPTANCE_CHECK_IDS as READ_ONLY_IDS,
  SKIPPABLE_ACCEPTANCE_CHECK_IDS,
} from "../../tools/acceptance-check-ids.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/*
Exact, because each of these three is baked into evidence a release ships, and a range would let
the packaged artifact drift from the thing that was measured.

Electron is held at 43.2.0 for a measured reason rather than caution, and it is worth writing down
so the next person does not spend an afternoon rediscovering it. On 43.4.0 the binary in
`node_modules/electron/dist/electron` (221,064,440 bytes) and the executable electron-builder
unpacks (219,917,560) are not the same file, and packaging fails with "unpacked application
executable does not exactly match the host-captured Electron binary". Both really are 43.4.0 —
`~/.cache/electron` holds `electron-v43.4.0-linux-x64.zip` and nothing else for that version — so
it is a difference in what upstream ships through the two channels, not a version mismatch here.
On 43.2.0 the two are byte-identical, which is what lets the host-candidate capture claim it
measured the binary the user will run. Everything else in the August 2026 upgrade was taken:
React 19.2.8, vite 7.3.6, jsdom 30, jest-dom 7, lucide-react 1.31.0.

vite is held at 7.3.6 for a different measured reason, recorded here because the two are usually
bumped together: vite 8 requires @vitejs/plugin-react 6 (its peer range is `^8` alone), and that
pair fails 435 of 664 renderer tests with `ReferenceError: React is not defined` — JSX compiling to
the classic runtime. The production build is unaffected and vitest 4.1.10 declares support for
vite ^8, so it is neither a code fault nor a stated incompatibility. Worth retrying when
plugin-react or vitest moves again.
*/
export const REQUIRED_EXACT_DEV_DEPENDENCIES = Object.freeze({
  electron: "43.2.0",
  "electron-builder": "26.15.3",
  "lucide-react": "1.31.0",
});

/**
 * Wall-clock fields carried by the evidence block, which the shipped manifest must not have.
 *
 * The manifest goes inside the AppImage, so anything in it that changes between two runs of
 * the same source changes the AppImage's digest. These fields do exactly that: two builds of
 * one commit produced `d23d88c7…` and `af1cc20c…` purely because the evidence block recorded
 * when each ran.
 *
 * Nothing is lost by removing them. Every entry binds its evidence document by `sha256` and
 * `bytes`, and that document — which stays in `artifacts/` and is not shipped — keeps its own
 * timestamps. "When did this evidence run" is still answerable; it is just answered by the
 * evidence rather than by the manifest.
 *
 * Removing them does NOT make the AppImage reproducible, and this comment used to imply it did.
 * The evidence digests themselves move between runs because some evidence photographs a live
 * daemon, so the manifest moves with them. What is reproducible is the core and the renderer;
 * `reproducibility` in release-verification.json records which is which.
 */
export const MANIFEST_WALL_CLOCK_FIELDS = Object.freeze([
  "capturedAt",
  "completedAt",
  "generatedAt",
  "observedAt",
  "recordedAt",
  "reviewedAt",
  "startedAt",
]);

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u;

/**
 * Returns the evidence block with its wall-clock fields removed, and fails if a timestamp
 * survives under a name this does not know.
 *
 * Failing closed is the point: a later evidence source that adds `finishedAt` would otherwise
 * silently reintroduce the nondeterminism, and the symptom — two builds of one commit
 * disagreeing — is only visible to whoever thinks to check.
 */
export function manifestEvidenceWithoutWallClock(evidence, path = "evidence") {
  if (Array.isArray(evidence)) {
    return evidence.map((entry, index) =>
      manifestEvidenceWithoutWallClock(entry, `${path}[${index}]`),
    );
  }
  if (evidence === null || typeof evidence !== "object") {
    requireCondition(
      typeof evidence !== "string" || !ISO_TIMESTAMP.test(evidence),
      `${path} carries a timestamp that would make the packaged manifest ` +
        `irreproducible; add its field name to MANIFEST_WALL_CLOCK_FIELDS`,
    );
    return evidence;
  }
  const result = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (MANIFEST_WALL_CLOCK_FIELDS.includes(key)) continue;
    result[key] = manifestEvidenceWithoutWallClock(value, `${path}.${key}`);
  }
  return result;
}

export function validatePinnedDevDependencies(packageMetadata) {
  const devDependencies = packageMetadata?.devDependencies;
  for (const [name, version] of Object.entries(
    REQUIRED_EXACT_DEV_DEPENDENCIES,
  )) {
    if (devDependencies?.[name] !== version) {
      throw new Error(
        `${name} must remain exactly pinned to ${version} for reproducible packaging`,
      );
    }
  }
}

// Re-exported from the single shared definition rather than copied. The previous duplicate
// silently went stale when the matrix grew, so the policy rejected an artifact the runner had
// just produced.
export {
  READ_ONLY_ACCEPTANCE_CHECK_IDS,
  MUTATION_ACCEPTANCE_CHECK_IDS,
} from "../../tools/acceptance-check-ids.mjs";

export const DESIGN_PARITY_STATE_IDS = Object.freeze([
  "containers",
  "containers-current",
  "containers-only-running",
  "containers-search-empty",
  "containers-row-hover",
  "containers-banner-dismissed",
  "container-detail-logs",
  "container-detail-inspect",
  "container-detail-mounts",
  "container-detail-exec",
  "container-detail-files",
  "container-detail-stats",
  "dashboard",
  "images-local",
  "images-registry",
  "volumes",
  "builds",
  // Dev Environments, Extensions and Settings → Kubernetes were removed from the product, so
  // there is nothing left to capture for them. This list is the single definition the capture
  // harness, the measurement and the packaging policy all read; it was missed when the screens
  // went, and nothing noticed because the policy's own test builds its fixtures from this list
  // and so stayed self-consistent with a list describing screens that no longer exist.
  "settings-resources",
  "settings-engine",
  "settings-updates",
  "settings-advanced",
]);

export const DESIGN_VISUAL_CONFORMANCE_CLAIM =
  "reviewed-visual-conformance-not-pixel-identity";
export const DESIGN_VISUAL_CONFORMANCE_THRESHOLD = 0.02;

/**
 * The most a single state may diverge from the design and still ship.
 *
 * A state over `DESIGN_VISUAL_CONFORMANCE_THRESHOLD` is not automatically a defect: the build
 * deliberately carries surfaces the comp does not — the posture paragraphs above all, which exist
 * to say what a capability does not protect. Such a state ships only while its measured error
 * stays at or under a budget a reviewer wrote down, alongside an enumeration of what accounts for
 * it. That keeps the ratchet: a regression on top of an accepted divergence pushes past the
 * budget and fails, and no state can be waved through with prose alone.
 *
 * The ceiling is what stops a budget from being set to "whatever it measures today". Nothing may
 * diverge by more than this without the design or the build changing.
 */
export const DESIGN_VISUAL_DIVERGENCE_CEILING = 0.05;
export const DESIGN_VISUAL_REVIEW_CRITERIA = Object.freeze([
  "geometry",
  "typography",
  "colour",
  "borders-and-radii",
  "spacing",
  "iconography",
  "layer-order",
  "clipping",
  "scroll-behavior",
  "state-specific-content",
]);

/*
 * The keys electron-builder actually writes into the asar's package.json, in its order.
 *
 * Order is load-bearing: canonicalPackagedPackageJson rebuilds the object by iterating this
 * list and the result is compared byte-for-byte against the extracted file, so a key in the
 * wrong position fails as loudly as a missing one. `homepage` joined when the deb and rpm
 * targets did — FpmTarget refuses to build without one, and electron-builder then ships it.
 * Verified against a real --dir build rather than assumed.
 */
const PACKAGED_PACKAGE_JSON_KEYS = Object.freeze([
  "name",
  "productName",
  "desktopName",
  "version",
  "homepage",
  "description",
  "author",
  // electron-builder passes `license` straight through — it is not in the set
  // cleanupPackageJson strips — so the packaged copy carries it and the canonical form must
  // too. Adding the field to app/package.json without adding it here put the two closures
  // exactly 20 bytes apart and failed the release at its last gate.
  "license",
  "private",
  "type",
  "main",
  "allowScripts",
]);

export function canonicalPackagedPackageJson(content) {
  const parsed = JSON.parse(
    Buffer.isBuffer(content) ? content.toString("utf8") : String(content),
  );
  const packaged = {};
  for (const key of PACKAGED_PACKAGE_JSON_KEYS) {
    if (!Object.hasOwn(parsed, key)) {
      throw new Error(
        `Application package metadata is missing packaged key ${key}`,
      );
    }
    packaged[key] = parsed[key];
  }
  return Buffer.from(JSON.stringify(packaged, null, 2));
}

export const HOST_CANDIDATE_CHECK_IDS = Object.freeze([
  "candidate-integrity",
  "clean-shutdown",
  "console-and-page-errors",
  "core-handshake",
  "docker-context-ready",
  "host-bridge-attestation",
  "host-ui-performance",
  "live-resource-screens",
  "literal-cli-run",
  "outside-home-cwd-cli-run",
  "pinned-cli-run",
  "unsupported-host-states",
]);

export const HOST_CANDIDATE_SCREEN_IDS = Object.freeze([
  "host-dashboard",
  "host-containers",
  "host-container-detail",
  "host-files-live",
  "host-images",
  "host-volumes",
  "host-command-center-pinned",
  "host-command-center-literal",
  "host-builds-live",
  "host-settings-engine",
]);

export const HOST_CANDIDATE_SCREEN_SEMANTIC_IDS = Object.freeze({
  "host-dashboard": Object.freeze([
    "host-dashboard-visible",
    "host-dashboard-live-context",
    "host-dashboard-snapshot-state-explicit",
  ]),
  "host-containers": Object.freeze([
    "host-containers-visible",
    "host-containers-live-row",
    "host-containers-fixture-banner-absent",
  ]),
  "host-container-detail": Object.freeze([
    "host-container-detail-visible",
    "host-container-detail-identity",
  ]),
  // Renamed when the Files tab stopped being a declared gap and became a real browser. The
  // no-synthetic-filesystem property survives the rename: it is the one that matters.
  "host-files-live": Object.freeze([
    "host-files-live-panel",
    "host-files-live-settled",
    "host-files-no-synthetic-filesystem",
  ]),
  "host-images": Object.freeze([
    "host-images-visible",
    "host-images-capability-error-absent",
  ]),
  "host-volumes": Object.freeze([
    "host-volumes-visible",
    "host-volumes-capability-error-absent",
  ]),
  "host-command-center-pinned": Object.freeze([
    "host-command-inventory-visible",
    "host-command-target-pinned",
  ]),
  "host-command-center-literal": Object.freeze([
    "host-command-target-literal",
    "host-command-literal-disclosure-visible",
  ]),
  // Renamed when buildx-backed history replaced the declared gap. The property that
  // survives the rename is the one that matters: no fixture data on a live engine.
  "host-builds-live": Object.freeze([
    "host-builds-live-settled",
    "host-builds-no-fixture-data",
  ]),
  // Settings shipped a hardcoded daemon.json against live engines: registry mirrors and
  // insecure registries belonging to the design fixture, presented as the operator's own
  // configuration. Nothing in this gate covered Settings, so nothing caught it. This is that
  // cover — the same no-fixture-data property Files and Builds are held to, plus the
  // property that no pane offers a control which cannot reach the engine.
  "host-settings-engine": Object.freeze([
    "host-settings-engine-live-facts",
    "host-settings-no-fixture-daemon-json",
    "host-settings-no-inert-controls",
  ]),
});

export const HOST_UI_PERFORMANCE_PROFILE = Object.freeze({
  id: "anchorage-host-ui-v1",
  thresholds: Object.freeze({
    spawnToHostReadyMs: 60_000,
    navigationDomContentLoadedMs: 10_000,
    firstContentfulPaintMs: 10_000,
    scriptedInteractionSettleMaxMs: 30_000,
    domNodeCount: 5_000,
    visibleContainerRows: 200,
    // The two discovery verbs, measured through the real bridge.
    //
    // system.contexts is what a launch waits for, and it is two sub-100ms Docker calls; a
    // second of headroom catches it regressing back onto the recursive help walk (~3.1s on
    // the reference machine) without failing on a loaded machine.
    //
    // system.capabilities legitimately walks that tree, but by the time this runs the walk
    // was started at core spawn and has had the whole harness to finish. Holding it to the
    // same limit is what fails if the walk stops being warmed or stops being cached — the
    // launch would still look fine here, and the operator would still be waiting.
    bridgeContextsMs: 1_500,
    bridgeCapabilitiesMs: 1_500,
  }),
});

const HOST_UI_PERFORMANCE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "spawn-to-host-ready",
    metric: "spawnToHostReadyMs",
    threshold: "spawnToHostReadyMs",
  }),
  Object.freeze({
    id: "navigation-dom-content-loaded",
    metric: "navigationDomContentLoadedMs",
    threshold: "navigationDomContentLoadedMs",
  }),
  Object.freeze({
    id: "first-contentful-paint",
    metric: "firstContentfulPaintMs",
    threshold: "firstContentfulPaintMs",
  }),
  Object.freeze({
    id: "scripted-interaction-settle-max",
    metric: "scriptedInteractionSettleMaxMs",
    threshold: "scriptedInteractionSettleMaxMs",
  }),
  Object.freeze({
    id: "bounded-dom-nodes",
    metric: "domNodeCount",
    threshold: "domNodeCount",
  }),
  Object.freeze({
    id: "bounded-visible-container-rows",
    metric: "visibleContainerRows",
    threshold: "visibleContainerRows",
  }),
  Object.freeze({
    id: "launch-path-contexts",
    metric: "bridgeContextsMs",
    threshold: "bridgeContextsMs",
  }),
  Object.freeze({
    id: "warmed-command-inventory",
    metric: "bridgeCapabilitiesMs",
    threshold: "bridgeCapabilitiesMs",
  }),
]);

export const HOST_UI_PERFORMANCE_CHECK_IDS = Object.freeze(
  HOST_UI_PERFORMANCE_DEFINITIONS.map(({ id }) => id),
);

export const HOST_UI_INTERACTION_IDS = Object.freeze([
  "open-container-detail",
  "open-files-live",
  "navigate-dashboard",
  "navigate-images",
  "navigate-volumes",
  "navigate-builds",
  "navigate-settings-engine",
  "open-command-center",
  "select-literal-target",
]);

const HOST_BRIDGE_FUNCTIONS = Object.freeze([
  "cli.run",
  "containers.inspect",
  "containers.list",
  "containers.stats",
  "images.list",
  "session.start",
  "subscribe",
  "system.capabilities",
  "system.contexts",
  "system.snapshot",
  "volumes.list",
  "window.close",
]);

const DESIGN_HANDOFF_DECLARED_SOURCES = Object.freeze([
  "docs/design_handoff_anchorage/Anchorage v2.dc.html",
  "docs/design_handoff_anchorage/README.md",
  "docs/design_handoff_anchorage/support.js",
]);

export const RELEASE_PERFORMANCE_PROFILE = Object.freeze({
  id: "anchorage-desktop-release-v1",
  thresholds: Object.freeze({
    coldHealthLatencyMs: 2_000,
    warmHealthP95LatencyMs: 100,
    containersFirstLatencyMs: 5_000,
    containersWarmP95LatencyMs: 2_000,
    imagesFirstLatencyMs: 10_000,
    imagesWarmP95LatencyMs: 5_000,
    volumesFirstLatencyMs: 15_000,
    volumesWarmP95LatencyMs: 5_000,
    snapshotFirstLatencyMs: 5_000,
    snapshotWarmP95LatencyMs: 1_000,
    capabilitiesFirstLatencyMs: 10_000,
    capabilitiesWarmP95LatencyMs: 500,
    statsFanoutWallLatencyMs: 3_000,
    statsIndividualP95LatencyMs: 3_000,
    warmHealthMinimumSamples: 20,
    listWarmMinimumSamples: 20,
    statsMinimumRounds: 20,
    sessionCancelToExitMs: 2_000,
    coreRssP95Bytes: 128 * 1024 * 1024,
    coreRssMaxBytes: 160 * 1024 * 1024,
    coreRssGrowthBytes: 32 * 1024 * 1024,
  }),
});

const RELEASE_PERFORMANCE_MAXIMUM_CHECKS = Object.freeze([
  Object.freeze({
    id: "cold-health-latency",
    metric: "health.cold.latencyMs",
    threshold: "coldHealthLatencyMs",
    observed: (results) => results.health?.cold?.latencyMs,
  }),
  Object.freeze({
    id: "warm-health-p95-latency",
    metric: "health.warm.latencyMs.p95",
    threshold: "warmHealthP95LatencyMs",
    observed: (results) => results.health?.warm?.latencyMs?.p95,
  }),
  Object.freeze({
    id: "containers-first-latency",
    metric: "nativeLists.containers.firstLatencyMs",
    threshold: "containersFirstLatencyMs",
    observed: (results) => results.nativeLists?.containers?.firstLatencyMs,
  }),
  Object.freeze({
    id: "containers-warm-p95-latency",
    metric: "nativeLists.containers.subsequentLatencyMs.p95",
    threshold: "containersWarmP95LatencyMs",
    observed: (results) =>
      results.nativeLists?.containers?.subsequentLatencyMs?.p95,
  }),
  Object.freeze({
    id: "images-first-latency",
    metric: "nativeLists.images.firstLatencyMs",
    threshold: "imagesFirstLatencyMs",
    observed: (results) => results.nativeLists?.images?.firstLatencyMs,
  }),
  Object.freeze({
    id: "images-warm-p95-latency",
    metric: "nativeLists.images.subsequentLatencyMs.p95",
    threshold: "imagesWarmP95LatencyMs",
    observed: (results) =>
      results.nativeLists?.images?.subsequentLatencyMs?.p95,
  }),
  Object.freeze({
    id: "volumes-first-latency",
    metric: "nativeLists.volumes.firstLatencyMs",
    threshold: "volumesFirstLatencyMs",
    observed: (results) => results.nativeLists?.volumes?.firstLatencyMs,
  }),
  Object.freeze({
    id: "volumes-warm-p95-latency",
    metric: "nativeLists.volumes.subsequentLatencyMs.p95",
    threshold: "volumesWarmP95LatencyMs",
    observed: (results) =>
      results.nativeLists?.volumes?.subsequentLatencyMs?.p95,
  }),
  Object.freeze({
    id: "snapshot-first-latency",
    metric: "nativeLists.snapshot.firstLatencyMs",
    threshold: "snapshotFirstLatencyMs",
    observed: (results) => results.nativeLists?.snapshot?.firstLatencyMs,
  }),
  Object.freeze({
    id: "snapshot-warm-p95-latency",
    metric: "nativeLists.snapshot.subsequentLatencyMs.p95",
    threshold: "snapshotWarmP95LatencyMs",
    observed: (results) =>
      results.nativeLists?.snapshot?.subsequentLatencyMs?.p95,
  }),
  Object.freeze({
    id: "capabilities-first-latency",
    metric: "nativeLists.capabilities.firstLatencyMs",
    threshold: "capabilitiesFirstLatencyMs",
    observed: (results) => results.nativeLists?.capabilities?.firstLatencyMs,
  }),
  Object.freeze({
    id: "capabilities-warm-p95-latency",
    metric: "nativeLists.capabilities.subsequentLatencyMs.p95",
    threshold: "capabilitiesWarmP95LatencyMs",
    observed: (results) =>
      results.nativeLists?.capabilities?.subsequentLatencyMs?.p95,
  }),
  Object.freeze({
    id: "stats-fanout-wall-latency",
    metric: "visibleContainerStats.wallLatencyMs.p95",
    threshold: "statsFanoutWallLatencyMs",
    observed: (results) => results.visibleContainerStats?.wallLatencyMs?.p95,
  }),
  Object.freeze({
    id: "stats-individual-p95-latency",
    metric: "visibleContainerStats.individualLatencyMs.p95",
    threshold: "statsIndividualP95LatencyMs",
    observed: (results) =>
      results.visibleContainerStats?.individualLatencyMs?.p95,
  }),
  Object.freeze({
    id: "session-cancel-to-exit",
    metric: "streamingSoak.cancellation.cancelToExitMs",
    threshold: "sessionCancelToExitMs",
    observed: (results) =>
      results.streamingSoak?.cancellation?.cancelToExitMs,
  }),
  Object.freeze({
    id: "core-rss-p95",
    metric: "streamingSoak.rssBytes.p95",
    threshold: "coreRssP95Bytes",
    observed: (results) => results.streamingSoak?.rssBytes?.p95,
  }),
  Object.freeze({
    id: "core-rss-max",
    metric: "streamingSoak.rssBytes.max",
    threshold: "coreRssMaxBytes",
    observed: (results) => results.streamingSoak?.rssBytes?.max,
  }),
  Object.freeze({
    id: "core-rss-growth",
    metric: "max(0, streamingSoak.rssDeltaBytes)",
    threshold: "coreRssGrowthBytes",
    observed: (results) => Math.max(0, results.streamingSoak?.rssDeltaBytes),
  }),
]);

const RELEASE_PERFORMANCE_MINIMUM_CHECKS = Object.freeze([
  Object.freeze({
    id: "warm-health-sample-floor",
    metric: "health.warm.latencyMs.count",
    threshold: "warmHealthMinimumSamples",
    observed: (results) => results.health?.warm?.latencyMs?.count,
  }),
  Object.freeze({
    id: "containers-warm-sample-floor",
    metric: "nativeLists.containers.subsequentLatencyMs.count",
    threshold: "listWarmMinimumSamples",
    observed: (results) =>
      results.nativeLists?.containers?.subsequentLatencyMs?.count,
  }),
  Object.freeze({
    id: "images-warm-sample-floor",
    metric: "nativeLists.images.subsequentLatencyMs.count",
    threshold: "listWarmMinimumSamples",
    observed: (results) =>
      results.nativeLists?.images?.subsequentLatencyMs?.count,
  }),
  Object.freeze({
    id: "volumes-warm-sample-floor",
    metric: "nativeLists.volumes.subsequentLatencyMs.count",
    threshold: "listWarmMinimumSamples",
    observed: (results) =>
      results.nativeLists?.volumes?.subsequentLatencyMs?.count,
  }),
  Object.freeze({
    id: "stats-round-sample-floor",
    metric: "visibleContainerStats.actualRounds",
    threshold: "statsMinimumRounds",
    observed: (results) => results.visibleContainerStats?.actualRounds,
  }),
]);

const RELEASE_PERFORMANCE_EQUAL_CHECKS = Object.freeze([
  Object.freeze({
    id: "stats-fanout-complete",
    metric: "visibleContainerStats.actualFanout",
    observed: (results) => results.visibleContainerStats?.actualFanout,
    expected: (results) => results.visibleContainerStats?.requestedFanout,
  }),
  Object.freeze({
    id: "stats-rounds-complete",
    metric: "visibleContainerStats.actualRounds",
    observed: (results) => results.visibleContainerStats?.actualRounds,
    expected: (results) => results.visibleContainerStats?.requestedRounds,
  }),
  Object.freeze({
    id: "stats-sample-matrix-complete",
    metric: "visibleContainerStats.samples.length",
    observed: (results) => results.visibleContainerStats?.samples?.length,
    expected: (results) =>
      results.visibleContainerStats?.actualFanout *
        results.visibleContainerStats?.actualRounds,
  }),
  Object.freeze({
    id: "session-output-not-dropped",
    metric: "streamingSoak.cancellation.exit.output.droppedBytes",
    observed: (results) =>
      results.streamingSoak?.cancellation?.exit?.output?.droppedBytes,
    expected: () => 0,
  }),
  Object.freeze({
    id: "session-output-not-truncated",
    metric: "streamingSoak.cancellation.exit.output.truncated",
    observed: (results) =>
      results.streamingSoak?.cancellation?.exit?.output?.truncated,
    expected: () => false,
  }),
  Object.freeze({
    id: "session-event-acknowledgements",
    metric: "streamingSoak.sessionOutput.acknowledgements",
    observed: (results) =>
      results.streamingSoak?.sessionOutput?.acknowledgements,
    expected: (results) => results.streamingSoak?.sessionOutput?.events,
  }),
  Object.freeze({
    id: "session-byte-acknowledgements",
    metric: "streamingSoak.sessionOutput.acknowledgedBytes",
    observed: (results) =>
      results.streamingSoak?.sessionOutput?.acknowledgedBytes,
    expected: (results) => results.streamingSoak?.sessionOutput?.bytes,
  }),
]);

export const RELEASE_PERFORMANCE_CHECK_IDS = Object.freeze([
  ...RELEASE_PERFORMANCE_MAXIMUM_CHECKS.map(({ id }) => id),
  ...RELEASE_PERFORMANCE_MINIMUM_CHECKS.map(({ id }) => id),
  ...RELEASE_PERFORMANCE_EQUAL_CHECKS.map(({ id }) => id),
]);

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function requireSchemaVersion(evidence, description, expected = 1) {
  requireCondition(
    evidence?.schemaVersion === expected,
    `${description} must use schemaVersion ${expected}`,
  );
}

function requireSha256(value, description) {
  requireCondition(
    typeof value === "string" && SHA256_PATTERN.test(value),
    `${description} must be a lowercase SHA-256 digest`,
  );
}

function requireIsoDate(value, description) {
  requireCondition(
    typeof value === "string" && Number.isFinite(Date.parse(value)),
    `${description} must be an ISO date`,
  );
}

function acceptanceCheckIds(mutationsEnabled) {
  return mutationsEnabled
    ? [...READ_ONLY_IDS, ...MUTATION_IDS].sort()
    : [...READ_ONLY_IDS];
}

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function sameBuildFingerprint(actual, expected) {
  return (
    actual?.sha256 === expected?.sha256 &&
    actual?.files === expected?.files &&
    actual?.bytes === expected?.bytes
  );
}

function sameFileFingerprint(actual, expected) {
  return (
    actual?.path === expected?.path &&
    actual?.sha256 === expected?.sha256 &&
    actual?.bytes === expected?.bytes
  );
}

function samePlainRecord(actual, expected) {
  const actualEntries =
    actual && typeof actual === "object" && !Array.isArray(actual)
      ? Object.entries(actual).sort(([left], [right]) =>
        left.localeCompare(right, "en"))
      : [];
  const expectedEntries = Object.entries(expected).sort(
    ([left], [right]) => left.localeCompare(right, "en"),
  );
  return (
    actualEntries.length === expectedEntries.length &&
    actualEntries.every(
      ([key, value], index) =>
        key === expectedEntries[index][0] &&
        Object.is(value, expectedEntries[index][1]),
    )
  );
}

function hasCanonicalDimensions(value) {
  return value?.width === 1_656 && value?.height === 1_056;
}

function validHostSemanticObservation(id, actual, evidence) {
  switch (id) {
    case "host-dashboard-live-context":
      return actual === evidence.docker?.context;
    case "host-containers-live-row":
      return Number.isSafeInteger(actual) && actual > 0;
    case "host-container-detail-identity":
      return typeof actual === "string" && actual.trim().length > 0;
    case "host-command-target-pinned":
      return actual === "pinned";
    case "host-command-target-literal":
      return actual === "literal";
    // Records which tabs were walked rather than only that something passed: a check that
    // reported a bare `true` could not distinguish "every tab was clean" from "the walk
    // never ran". The named tabs are the ones that used to carry inert controls.
    case "host-settings-no-inert-controls":
      return (
        typeof actual === "string" &&
        /^visited .+; no inert control$/u.test(actual) &&
        // The tabs that used to carry inert controls, named so the record distinguishes "every
        // tab was clean" from "the walk never ran". This list has now been wrong twice, and both
        // times for the same reason — it names labels rather than deriving them, so it keeps
        // asserting a product that no longer exists. First "Docker Engine", which became
        // "Engine" when the tab took the handoff's own name. Then "Kubernetes", which was
        // removed outright: it needs cluster state Anchorage does not read, and Desktop can only
        // offer it because it manages a VM. The walk visits eight tabs and no Kubernetes among
        // them, so requiring one made a passing capture unpackageable.
        ["Resources", "Engine", "Software updates", "Advanced"].every(
          (label) => actual.includes(label),
        )
      );
    default:
      return actual === true;
  }
}

export function validateHostCandidateEvidence(
  evidence,
  {
    expectedRendererBuild,
    expectedCore,
    expectedElectronBinary,
    expectedElectronMain,
    expectedElectronPreload,
    expectedElectronRuntimeClosure,
    expectedProtocolSchema,
    expectedHarnessSha256,
    observedScreens,
  } = {},
) {
  const description = "Staged production HostBridge candidate evidence";
  requireSchemaVersion(evidence, description);
  requireCondition(
    evidence?.matrixVersion === 1 &&
      evidence.status === "passed" &&
      evidence.candidateMode === "staged-inputs" &&
      evidence.scope === "host-integration-smoke-not-pixel-parity" &&
      evidence.bridgeMode === "host" &&
      evidence.source === "app/dist/client",
    `${description} must attest the real HostBridge staged-input candidate`,
  );
  requireIsoDate(evidence.startedAt, `${description} startedAt`);
  requireIsoDate(evidence.completedAt, `${description} completedAt`);
  requireCondition(
    Date.parse(evidence.completedAt) >= Date.parse(evidence.startedAt),
    `${description} completedAt must not precede startedAt`,
  );
  requireCondition(
    hasCanonicalDimensions(evidence.canonicalViewport),
    `${description} must use the canonical 1656x1056 viewport`,
  );
  requireCondition(
    sameStringArray(evidence.requiredChecks, HOST_CANDIDATE_CHECK_IDS),
    `${description} requiredChecks must equal matrix v${ACCEPTANCE_MATRIX_VERSION}`,
  );
  requireCondition(
    Array.isArray(evidence.checks) &&
      evidence.checks.length === HOST_CANDIDATE_CHECK_IDS.length &&
      evidence.checks.every(
        (check) =>
          check &&
          typeof check.id === "string" &&
          typeof check.name === "string" &&
          check.name.length > 0 &&
          check.status === "passed",
      ),
    `${description} must contain the exact required check set as named passing checks`,
  );
  const actualCheckIds = evidence.checks.map((check) => check.id);
  requireCondition(
    new Set(actualCheckIds).size === actualCheckIds.length,
    `${description} must contain unique check ids`,
  );
  requireCondition(
    sameStringArray(
      [...actualCheckIds].sort(),
      [...HOST_CANDIDATE_CHECK_IDS].sort(),
    ),
    `${description} must contain the exact required check set`,
  );

  requireCondition(
    sameBuildFingerprint(
      evidence.candidate?.rendererBuild,
      expectedRendererBuild,
    ),
    `${description} must identify the exact freshly built renderer`,
  );
  requireCondition(
    sameFileFingerprint(evidence.candidate?.core, expectedCore),
    `${description} must identify the exact staged core`,
  );
  requireCondition(
    sameFileFingerprint(
      evidence.candidate?.electron?.binary,
      expectedElectronBinary,
    ),
    `${description} must identify the exact Electron binary`,
  );
  requireCondition(
    sameFileFingerprint(
      evidence.candidate?.electron?.main,
      expectedElectronMain,
    ),
    `${description} must identify the exact Electron main process`,
  );
  requireCondition(
    sameFileFingerprint(
      evidence.candidate?.electron?.preload,
      expectedElectronPreload,
    ),
    `${description} must identify the exact Electron preload`,
  );
  requireCondition(
    evidence.candidate?.electron?.runtimeClosure?.scope ===
      "packaged-electron-runtime-v1" &&
      sameBuildFingerprint(
        evidence.candidate.electron.runtimeClosure,
        expectedElectronRuntimeClosure,
      ),
    `${description} must identify the exact packaged Electron runtime closure`,
  );
  requireCondition(
    sameFileFingerprint(
      evidence.candidate?.protocolSchema,
      expectedProtocolSchema,
    ),
    `${description} must identify the exact protocol schema`,
  );
  requireCondition(
    evidence.candidate?.harness?.path ===
      "tools/capture-host-candidate.mjs" &&
      evidence.candidate.harness.sha256 === expectedHarnessSha256 &&
      Number.isSafeInteger(evidence.candidate.harness.bytes) &&
      evidence.candidate.harness.bytes > 0,
    `${description} must identify the current host capture harness`,
  );
  requireCondition(
    typeof evidence.runtime?.product === "string" &&
      evidence.runtime.product.startsWith("Chrome/") &&
      typeof evidence.runtime.protocolVersion === "string" &&
      evidence.runtime.protocolVersion.length > 0 &&
      typeof evidence.runtime.revision === "string" &&
      evidence.runtime.revision.length > 0 &&
      typeof evidence.runtime.userAgent === "string" &&
      evidence.runtime.userAgent.includes("Electron/") &&
      typeof evidence.runtime.jsVersion === "string" &&
      evidence.runtime.jsVersion.length > 0,
    `${description} must record its Electron and Chromium runtime`,
  );
  requireCondition(
    evidence.bridge?.hostApiPresent === true &&
      evidence.bridge.fixtureBridgeAbsent === true &&
      sameStringArray(evidence.bridge.functions, HOST_BRIDGE_FUNCTIONS),
    `${description} must attest the complete real HostBridge shape`,
  );
  requireCondition(
    evidence.docker?.ready === true &&
      evidence.docker.containerAvailable === true &&
      typeof evidence.docker.context === "string" &&
      evidence.docker.context.length > 0,
    `${description} must record a ready Docker context and live container`,
  );
  requireCondition(
    evidence.cli?.pinned?.targetMode === "pinned" &&
      evidence.cli.pinned.exitCode === 0 &&
      evidence.cli.pinned.outputPresent === true &&
      evidence.cli?.literal?.targetMode === "literal" &&
      evidence.cli.literal.exitCode === 0 &&
      evidence.cli.literal.outputPresent === true,
    `${description} must prove pinned and literal CLI execution`,
  );
  requireCondition(
    evidence.cli?.cwdSensitive?.targetMode === "pinned" &&
      evidence.cli.cwdSensitive.exitCode === 0 &&
      evidence.cli.cwdSensitive.timedOut === false &&
      evidence.cli.cwdSensitive.composeConfigValidated === true &&
      evidence.cli.cwdSensitive.outsideHome === true &&
      typeof evidence.cli.cwdSensitive.requestedCwd === "string" &&
      evidence.cli.cwdSensitive.requestedCwd.startsWith("/") &&
      evidence.cli.cwdSensitive.resultCwd ===
        evidence.cli.cwdSensitive.requestedCwd &&
      sameStringArray(
        evidence.cli.cwdSensitive.executedArgv,
        [
          "--context",
          evidence.docker.context,
          "compose",
          "--project-name",
          "anchorage-cwd-proof",
          "config",
          "--quiet",
        ],
      ),
    `${description} must prove a cwd-sensitive Compose command outside HOME`,
  );
  const uiPerformance = evidence.uiPerformance;
  requireCondition(
    uiPerformance?.schemaVersion === 1 &&
      uiPerformance.profile === HOST_UI_PERFORMANCE_PROFILE.id &&
      uiPerformance.status === "passed" &&
      samePlainRecord(
        uiPerformance.thresholds,
        HOST_UI_PERFORMANCE_PROFILE.thresholds,
      ),
    `${description} must use the exact passing host UI performance profile`,
  );
  requireCondition(
    uiPerformance.observations?.liveContainerCount ===
      evidence.docker.containerCount &&
      Number.isSafeInteger(uiPerformance.observations.liveContainerCount) &&
      uiPerformance.observations.liveContainerCount > 0,
    `${description} UI performance must identify the live container workload`,
  );
  requireCondition(
    Array.isArray(uiPerformance.checks) &&
      uiPerformance.checks.length === HOST_UI_PERFORMANCE_CHECK_IDS.length &&
      new Set(uiPerformance.checks.map((check) => check?.id)).size ===
        HOST_UI_PERFORMANCE_CHECK_IDS.length &&
      sameStringArray(
        uiPerformance.checks.map((check) => check?.id).sort(),
        [...HOST_UI_PERFORMANCE_CHECK_IDS].sort(),
      ),
    `${description} must contain the exact host UI performance check set`,
  );
  const uiChecksById = new Map(
    uiPerformance.checks.map((check) => [check.id, check]),
  );
  requireCondition(
    HOST_UI_PERFORMANCE_DEFINITIONS.every((definition) => {
      const check = uiChecksById.get(definition.id);
      const observed =
        uiPerformance.observations?.[definition.metric];
      const limit =
        HOST_UI_PERFORMANCE_PROFILE.thresholds[definition.threshold];
      return (
        check?.metric === definition.metric &&
        check.comparison === "<=" &&
        Object.is(check.observed, observed) &&
        Object.is(check.limit, limit) &&
        check.status === "passed" &&
        Number.isFinite(observed) &&
        (
          definition.metric.endsWith("Ms")
            ? observed > 0
            : observed >= 0
        ) &&
        observed <= limit
      );
    }),
    `${description} host UI performance observations must satisfy policy`,
  );
  requireCondition(
    Array.isArray(uiPerformance.interactionTimings) &&
      uiPerformance.interactionTimings.length ===
        HOST_UI_INTERACTION_IDS.length &&
      new Set(
        uiPerformance.interactionTimings.map((timing) => timing?.id),
      ).size === HOST_UI_INTERACTION_IDS.length &&
      sameStringArray(
        uiPerformance.interactionTimings.map((timing) => timing?.id),
        HOST_UI_INTERACTION_IDS,
      ) &&
      uiPerformance.interactionTimings.every(
        (timing) =>
          Number.isFinite(timing.durationMs) &&
          timing.durationMs > 0 &&
          timing.durationMs <=
            HOST_UI_PERFORMANCE_PROFILE.thresholds
              .scriptedInteractionSettleMaxMs,
      ) &&
      Object.is(
        Math.max(
          ...uiPerformance.interactionTimings.map(
            (timing) => timing.durationMs,
          ),
        ),
        uiPerformance.observations.scriptedInteractionSettleMaxMs,
      ),
    `${description} must record the exact passing host UI interaction matrix`,
  );
  requireCondition(
    Array.isArray(evidence.diagnostics?.consoleErrors) &&
      evidence.diagnostics.consoleErrors.length === 0 &&
      Array.isArray(evidence.diagnostics?.pageErrors) &&
      evidence.diagnostics.pageErrors.length === 0 &&
      Array.isArray(evidence.diagnostics?.processErrors) &&
      evidence.diagnostics.processErrors.length === 0,
    `${description} must report zero console, page, and process errors`,
  );
  requireCondition(
    evidence.processExit?.code === 0 && evidence.processExit.signal === null,
    `${description} Electron process must exit cleanly`,
  );
  requireCondition(
    sameStringArray(evidence.requiredScreens, HOST_CANDIDATE_SCREEN_IDS),
    `${description} requiredScreens must equal matrix v1`,
  );
  requireCondition(
    Array.isArray(evidence.screens) &&
      evidence.screens.length === HOST_CANDIDATE_SCREEN_IDS.length &&
      sameStringArray(
        evidence.screens.map((screen) => screen?.id).sort(),
        [...HOST_CANDIDATE_SCREEN_IDS].sort(),
      ),
    `${description} must contain the exact required screen set`,
  );
  requireCondition(
    evidence.screens.every(
      (screen) => {
        const expectedSemanticIds =
          HOST_CANDIDATE_SCREEN_SEMANTIC_IDS[screen.id];
        const actualSemanticIds = Array.isArray(screen.semanticChecks)
          ? screen.semanticChecks.map((check) => check?.id)
          : [];
        return (
          screen.path === `screens/${screen.id}.png` &&
          SHA256_PATTERN.test(screen.sha256 ?? "") &&
          Number.isSafeInteger(screen.bytes) &&
          screen.bytes > 0 &&
          hasCanonicalDimensions(screen.dimensions) &&
          Array.isArray(expectedSemanticIds) &&
          actualSemanticIds.length === expectedSemanticIds.length &&
          new Set(actualSemanticIds).size === actualSemanticIds.length &&
          sameStringArray(
            [...actualSemanticIds].sort(),
            [...expectedSemanticIds].sort(),
          ) &&
          screen.semanticChecks.every(
            (check) =>
              typeof check?.name === "string" &&
              check.name.length > 0 &&
              check.status === "passed" &&
              validHostSemanticObservation(
                check.id,
                check.actual,
                evidence,
              ),
          )
        );
      },
    ),
    `${description} must contain the exact policy-owned passing screen semantics`,
  );
  requireCondition(
    Array.isArray(observedScreens) &&
      observedScreens.length === HOST_CANDIDATE_SCREEN_IDS.length &&
      sameStringArray(
        observedScreens.map((screen) => screen?.id).sort(),
        [...HOST_CANDIDATE_SCREEN_IDS].sort(),
      ),
    `${description} must be paired with every recomputed screen file`,
  );
  const declaredScreens = new Map(
    evidence.screens.map((screen) => [screen.id, screen]),
  );
  requireCondition(
    observedScreens.every((observed) => {
      const declared = declaredScreens.get(observed.id);
      return (
        observed.path === `screens/${observed.id}.png` &&
        observed.sha256 === declared?.sha256 &&
        observed.bytes === declared?.bytes &&
        observed.dimensions?.width === declared?.dimensions?.width &&
        observed.dimensions?.height === declared?.dimensions?.height
      );
    }),
    `${description} declared screenshots must match recomputed PNG files`,
  );
}

function requirePassingChecks(evidence, description, mutationsEnabled) {
  const expectedIds = acceptanceCheckIds(mutationsEnabled);
  requireSchemaVersion(evidence, description, ACCEPTANCE_SCHEMA_VERSION);
  requireCondition(
    evidence?.matrixVersion === ACCEPTANCE_MATRIX_VERSION,
    `${description} must use matrixVersion ${ACCEPTANCE_MATRIX_VERSION}`,
  );
  requireCondition(
    evidence?.status === "passed",
    `${description} must report status passed`,
  );
  requireCondition(
    Array.isArray(evidence.checks) && evidence.checks.length > 0,
    `${description} must include at least one check`,
  );
  // Compose and Scout are optional Docker CLI plugins, so a release machine can genuinely
  // lack them; blocking a release for that would be wrong. Every other check must pass — a
  // skip elsewhere means the matrix did not exercise something it claims to cover, which is
  // precisely how a session-cancellation defect survived eighteen passing checks.
  const skippable = new Set(SKIPPABLE_ACCEPTANCE_CHECK_IDS);
  requireCondition(
    evidence.checks.every(
      (check) =>
        check &&
        typeof check.id === "string" &&
        check.id.length > 0 &&
        typeof check.name === "string" &&
        check.name.length > 0 &&
        (check.status === "passed" ||
          (check.status === "skipped" && skippable.has(check.id))),
    ),
    `${description} must contain only named checks that passed, or were skipped for an absent optional plugin`,
  );
  // A permitted skip is still not a pass: it has to be recorded where a person signing the
  // release off will see it, and the record has to agree with the checks themselves.
  const skippedInChecks = evidence.checks
    .filter((check) => check?.status === "skipped")
    .map((check) => check.id)
    .sort();
  /*
   * Each entry is `{ id, reason }`, not a bare id — the reason is the whole point of recording
   * a skip where a release signer will see it, so it is required rather than merely tolerated.
   *
   * This compared the entries against a list of id strings, which is only ever equal when both
   * are empty. Every local run had nothing skipped, so it passed for as long as the machine
   * happened to have Compose and Scout; the first run on one without Scout failed the release
   * — blocking precisely the case the comment above says is allowed.
   */
  requireCondition(
    Array.isArray(evidence.skippedChecks) &&
      evidence.skippedChecks.every(
        (entry) =>
          entry &&
          typeof entry.id === "string" &&
          typeof entry.reason === "string" &&
          entry.reason.trim().length > 0,
      ) &&
      sameStringArray(
        evidence.skippedChecks.map((entry) => entry.id).sort(),
        skippedInChecks,
      ),
    `${description} skippedChecks must record exactly the checks that were skipped, each with a reason`,
  );
  const actualIds = evidence.checks.map((check) => check.id);
  requireCondition(
    new Set(actualIds).size === actualIds.length,
    `${description} must contain unique check ids`,
  );
  requireCondition(
    sameStringArray([...actualIds].sort(), expectedIds),
    `${description} must contain the exact required check set`,
  );
  requireCondition(
    sameStringArray(evidence.requiredChecks, expectedIds),
    `${description} requiredChecks must equal matrix v${ACCEPTANCE_MATRIX_VERSION}`,
  );
}

export function validateStagedCoreEvidenceHashes(
  stagedCoreSha256,
  { mutation, capability, performance },
) {
  const description = "Fresh staged core evidence binding";
  requireSha256(stagedCoreSha256, `${description} staged sha256`);
  for (const [name, sha256] of Object.entries({
    mutation,
    capability,
    performance,
  })) {
    requireSha256(sha256, `${description} ${name} sha256`);
    requireCondition(
      sha256 === stagedCoreSha256,
      `${description} must match the ${name}-tested core`,
    );
  }
}

export function validatePackagedElectronRuntimeClosure(
  packaged,
  hostCaptured,
) {
  const description = "Packaged Electron runtime closure";
  requireCondition(
    packaged?.scope === "packaged-electron-runtime-v1" &&
      hostCaptured?.scope === "packaged-electron-runtime-v1" &&
      sameBuildFingerprint(packaged, hostCaptured),
    `${description} must match the HostBridge-captured runtime`,
  );
}

export function validateMutationConformance(evidence) {
  const description = "Mutation conformance evidence";
  requireCondition(
    evidence.mutationsEnabled === true,
    `${description} must have mutationsEnabled=true`,
  );
  requirePassingChecks(evidence, description, true);
  requireCondition(
    evidence.cleanup?.status === "passed" &&
      Array.isArray(evidence.cleanup.errors) &&
      evidence.cleanup.errors.length === 0,
    `${description} must report clean disposable-resource cleanup`,
  );
  /*
   * The check above is satisfied by a run that tidied up after itself, and that is a weaker claim
   * than it reads as: every other field in the cleanup block — `dindContainer`, `scratchDirectory`
   * — reports on a resource this run created, so a run interrupted before it created any of them
   * reports all of them clean while a predecessor's privileged daemon is still on the host.
   * `hostVerifiedClear` is the only field that speaks about resources the run did not create, so
   * it is the only one that can refuse that release.
   *
   * Nested under `cleanup.evidence` because that is where `collectCleanupResult()` writes it;
   * `evidence.cleanup.hostVerifiedClear` is `undefined` in every artifact the harness has ever
   * produced, and `undefined === true` is false, so a wrong path here fails closed rather than
   * silently passing — but it would fail every release, so the path is pinned by a test that
   * builds the fixture at the harness's nesting.
   */
  requireCondition(
    evidence.cleanup?.evidence?.hostVerifiedClear === true,
    `${description} must record the host verified clear at cleanup.evidence.hostVerifiedClear — ` +
      "every acceptance resource the run enumerated and recognised by name accounted for, by one " +
      "of removed by this run, identified as a live concurrent run's, or already gone when the " +
      "sweep reached it. False, or absent as in evidence predating the sweep, means the run did " +
      "not establish that, which is precisely the gap an interrupted predecessor falls into. It " +
      "is not a claim that no acceptance resources exist on the host: what it was established " +
      "over is recorded in cleanup.evidence.livenessRule.enumerationScope",
  );
  requireCondition(
    evidence.error === null,
    `${description} must not contain an error`,
  );
  requireSha256(evidence.coreSha256, `${description} coreSha256`);
  requireSha256(evidence.generator?.sha256, `${description} generator sha256`);
  requireCondition(
    typeof evidence.corePath === "string" && evidence.corePath.length > 0,
    `${description} must identify the tested core`,
  );
  requireCondition(
    typeof evidence.generator?.path === "string" &&
      evidence.generator.path.length > 0,
    `${description} must identify its generator`,
  );
  requireIsoDate(evidence.startedAt, `${description} startedAt`);
  requireIsoDate(evidence.completedAt, `${description} completedAt`);
  requireCondition(
    Date.parse(evidence.completedAt) >= Date.parse(evidence.startedAt),
    `${description} completedAt must not precede startedAt`,
  );
}

export function validateReadOnlyAcceptance(
  evidence,
  { expectedCorePath, expectedCoreSha256 },
) {
  const description = "Read-only staged-core acceptance evidence";
  requireCondition(
    evidence.mutationsEnabled === false,
    `${description} must have mutationsEnabled=false`,
  );
  requirePassingChecks(evidence, description, false);
  requireCondition(
    evidence.cleanup?.status === "passed" &&
      Array.isArray(evidence.cleanup.errors) &&
      evidence.cleanup.errors.length === 0,
    `${description} must report clean cleanup`,
  );
  requireCondition(
    evidence.error === null,
    `${description} must not contain an error`,
  );
  requireCondition(
    evidence.corePath === expectedCorePath,
    `${description} must target the exact staged core path`,
  );
  requireCondition(
    evidence.coreSha256 === expectedCoreSha256,
    `${description} must target the exact staged core hash`,
  );
  requireSha256(evidence.generator?.sha256, `${description} generator sha256`);
}

export function validateDesignLedger(
  ledger,
  {
    expectedRendererBuild,
    expectedCaptureHarnessSha256,
    expectedDesignGeneratorSha256,
    expectedDesignHandoffSource,
    expectedVisualReviewAttestation,
    expectedVisualReviewSource,
  } = {},
) {
  const description = "Canonical handoff visual conformance ledger";
  requireSchemaVersion(ledger, description);
  requireIsoDate(ledger.generatedAt, `${description} generatedAt`);
  requireCondition(
    ledger.claim === DESIGN_VISUAL_CONFORMANCE_CLAIM,
    `${description} must identify reviewed conformance without claiming pixel identity`,
  );
  requireSha256(
    ledger.rendererBuild?.sha256,
    `${description} rendererBuild sha256`,
  );
  requireCondition(
    Number.isSafeInteger(ledger.rendererBuild?.files) &&
      ledger.rendererBuild.files > 0 &&
      Number.isSafeInteger(ledger.rendererBuild?.bytes) &&
      ledger.rendererBuild.bytes > 0,
    `${description} rendererBuild must contain positive file and byte counts`,
  );
  if (expectedRendererBuild !== undefined) {
    requireCondition(
      sameBuildFingerprint(ledger.rendererBuild, expectedRendererBuild),
      `${description} must identify the exact freshly built renderer`,
    );
  }
  requireCondition(
    hasCanonicalDimensions(ledger.canonicalViewport),
    `${description} must use the canonical 1656x1056 viewport`,
  );
  requireCondition(
    ledger.generator?.path === "tools/measure-design-parity.mjs",
    `${description} must identify the canonical design generator`,
  );
  requireSha256(
    ledger.generator?.sha256,
    `${description} generator sha256`,
  );
  if (expectedDesignGeneratorSha256 !== undefined) {
    requireCondition(
      ledger.generator.sha256 === expectedDesignGeneratorSha256,
      `${description} generator must match the current source`,
    );
  }
  requireCondition(
    ledger.handoffSource?.scope === "anchorage-design-handoff-v2" &&
      sameStringArray(
        ledger.handoffSource.declaredSources,
        DESIGN_HANDOFF_DECLARED_SOURCES,
      ) &&
      ledger.handoffSource.referenceDirectory === "docs/design-qa/reference" &&
      SHA256_PATTERN.test(ledger.handoffSource.sha256 ?? "") &&
      Number.isSafeInteger(ledger.handoffSource.files) &&
      ledger.handoffSource.files >=
        DESIGN_HANDOFF_DECLARED_SOURCES.length &&
      Number.isSafeInteger(ledger.handoffSource.bytes) &&
      ledger.handoffSource.bytes > 0,
    `${description} must bind the declared design handoff source`,
  );
  if (expectedDesignHandoffSource !== undefined) {
    requireCondition(
      sameBuildFingerprint(
        ledger.handoffSource,
        expectedDesignHandoffSource,
      ),
      `${description} handoff source must match the current source files`,
    );
  }
  const visualReviewBundle = ledger.visualReviewAttestation;
  requireCondition(
    visualReviewBundle?.source?.path ===
      "docs/design-qa/visual-review-attestation.json" &&
      SHA256_PATTERN.test(
        visualReviewBundle.source.sha256 ?? "",
      ) &&
      Number.isSafeInteger(visualReviewBundle.source.bytes) &&
      visualReviewBundle.source.bytes > 0,
    `${description} must bind the visual review attestation sidecar`,
  );
  if (expectedVisualReviewSource !== undefined) {
    requireCondition(
      sameFileFingerprint(
        visualReviewBundle.source,
        expectedVisualReviewSource,
      ),
      `${description} visual review sidecar must match the current source`,
    );
  }
  const visualReviewAttestation = visualReviewBundle.attestation;
  requireCondition(
    visualReviewAttestation?.schemaVersion === 1 &&
      visualReviewAttestation.claim ===
        DESIGN_VISUAL_CONFORMANCE_CLAIM,
    `${description} must embed the reviewed visual conformance attestation`,
  );
  requireIsoDate(
    visualReviewAttestation?.reviewedAt,
    `${description} visual review reviewedAt`,
  );
  requireCondition(
    Date.parse(visualReviewAttestation.reviewedAt) <=
      Date.parse(ledger.generatedAt),
    `${description} visual review must not postdate ledger generation`,
  );
  if (expectedVisualReviewAttestation !== undefined) {
    requireCondition(
      isDeepStrictEqual(
        visualReviewAttestation,
        expectedVisualReviewAttestation,
      ),
      `${description} must embed the exact current visual review attestation`,
    );
  }
  requireCondition(
    Array.isArray(visualReviewAttestation.states) &&
      visualReviewAttestation.states.length ===
        DESIGN_PARITY_STATE_IDS.length &&
      new Set(
        visualReviewAttestation.states.map((state) => state?.state),
      ).size === DESIGN_PARITY_STATE_IDS.length &&
      sameStringArray(
        visualReviewAttestation.states
          .map((state) => state?.state)
          .sort(),
        [...DESIGN_PARITY_STATE_IDS].sort(),
      ),
    `${description} visual review must contain the exact 24-state matrix`,
  );
  const visualReviewByState = new Map(
    visualReviewAttestation.states.map((state) => [
      state.state,
      state,
    ]),
  );
  const capture = ledger.captureProvenance;
  requireCondition(
    capture?.schemaVersion === 1 &&
      capture.captureMode === "fixture-browser" &&
      capture.bridgeMode === "fixture" &&
      capture.source === "app/dist/client",
    `${description} must contain honest fixture bridge provenance`,
  );
  requireIsoDate(capture.capturedAt, `${description} capturedAt`);
  requireCondition(
    Date.parse(capture.capturedAt) <= Date.parse(ledger.generatedAt),
    `${description} capture must not postdate ledger generation`,
  );
  requireCondition(
    hasCanonicalDimensions(capture.canonicalViewport),
    `${description} capture must use the canonical viewport`,
  );
  requireCondition(
    sameBuildFingerprint(capture.rendererBuild, ledger.rendererBuild),
    `${description} capture must bind the measured renderer build`,
  );
  requireCondition(
    capture.harness?.path === "tools/capture-design-parity.mjs",
    `${description} must identify the canonical capture harness`,
  );
  requireSha256(
    capture.harness?.sha256,
    `${description} capture harness sha256`,
  );
  if (expectedCaptureHarnessSha256 !== undefined) {
    requireCondition(
      capture.harness.sha256 === expectedCaptureHarnessSha256,
      `${description} capture harness must match the current source`,
    );
  }
  requireCondition(
    capture.runtime?.executable ===
      "app/node_modules/electron/dist/electron" &&
      typeof capture.runtime.product === "string" &&
      capture.runtime.product.startsWith("Chrome/") &&
      typeof capture.runtime.protocolVersion === "string" &&
      capture.runtime.protocolVersion.length > 0 &&
      typeof capture.runtime.revision === "string" &&
      capture.runtime.revision.length > 0 &&
      typeof capture.runtime.userAgent === "string" &&
      capture.runtime.userAgent.includes("Electron/") &&
      typeof capture.runtime.jsVersion === "string" &&
      capture.runtime.jsVersion.length > 0,
    `${description} must record the Electron and Chromium capture runtime`,
  );
  requireCondition(
    ledger.reviewRecorded === true,
    `${description} must record paired visual review`,
  );
  requireCondition(
    Array.isArray(ledger.rows) &&
      ledger.rows.length === DESIGN_PARITY_STATE_IDS.length,
    `${description} must contain all 24 canonical reviewed states`,
  );
  requireCondition(
    ledger.summary?.total === ledger.rows.length,
    `${description} summary total must match its rows`,
  );
  requireCondition(
    (ledger.summary.passed ?? 0) + (ledger.summary.budgeted ?? 0) ===
      ledger.rows.length,
    `${description} summary must report every state either passed or budgeted`,
  );
  /**
   * A budgeted state ships on a written exception, so the exception is checked here rather than
   * trusted: it must name what accounts for the divergence, cap it at a number under the ceiling
   * and over the threshold, and still measure under that number. Prose alone waves nothing
   * through, and a regression on top of an accepted divergence exceeds the budget and fails.
   */
  for (const row of ledger.rows) {
    if (row?.status !== "budgeted") continue;
    const divergence = row.divergence;
    requireCondition(
      typeof divergence?.budget === "number" &&
        Number.isFinite(divergence.budget) &&
        divergence.budget > DESIGN_VISUAL_CONFORMANCE_THRESHOLD &&
        divergence.budget <= DESIGN_VISUAL_DIVERGENCE_CEILING &&
        typeof row.mae?.normalized === "number" &&
        row.mae.normalized <= divergence.budget &&
        Array.isArray(divergence.reasons) &&
        divergence.reasons.length > 0 &&
        divergence.reasons.every(
          (reason) => typeof reason === "string" && reason.trim().length >= 20,
        ),
      `${description} state ${row.state} is budgeted, so it must record a budget over ${DESIGN_VISUAL_CONFORMANCE_THRESHOLD}, at or under ${DESIGN_VISUAL_DIVERGENCE_CEILING}, that its own measurement does not exceed, with each intended difference stated`,
    );
  }
  requireCondition(
    sameStringArray(
      ledger.rows.map((row) => row?.state).sort(),
      [...DESIGN_PARITY_STATE_IDS].sort(),
    ),
    `${description} must contain the exact canonical state set`,
  );
  requireCondition(
    Array.isArray(capture.states) &&
      capture.states.length === ledger.rows.length &&
      sameStringArray(
        capture.states.map((state) => state?.state).sort(),
        [...DESIGN_PARITY_STATE_IDS].sort(),
      ),
    `${description} capture provenance must contain 24 unique states`,
  );
  const captureByState = new Map(
    capture.states.map((state) => [state?.state, state]),
  );
  requireCondition(
    ledger.rows.every(
      (row) => {
        const stateCapture = captureByState.get(row?.state);
        const stateReview = visualReviewByState.get(row?.state);
        return (
          (row?.status === "passed" || row?.status === "budgeted") &&
          typeof row.state === "string" &&
          row.state.length > 0 &&
          Number.isFinite(row.mae?.normalized) &&
          Object.is(
            row.reviewThreshold,
            DESIGN_VISUAL_CONFORMANCE_THRESHOLD,
          ) &&
          // A passed row is bounded by the threshold; a budgeted one by the budget its own
          // review recorded, which the loop above independently checks is under the ceiling.
          row.mae.normalized <=
            (row.status === "budgeted"
              ? (row.divergence?.budget ?? row.reviewThreshold)
              : row.reviewThreshold) &&
          typeof row.reference === "string" &&
          row.reference.endsWith(`/${row.state}.png`) &&
          typeof row.actual === "string" &&
          row.actual.endsWith(`/${row.state}.png`) &&
          typeof row.diff === "string" &&
          row.diff.endsWith(`/${row.state}.png`) &&
          stateCapture?.path === `final-actual/${row.state}.png` &&
          SHA256_PATTERN.test(stateCapture.sha256 ?? "") &&
          Number.isSafeInteger(stateCapture.bytes) &&
          stateCapture.bytes > 0 &&
          hasCanonicalDimensions(stateCapture.dimensions) &&
          stateReview?.status === "approved" &&
          stateReview.reviewer?.kind === "agent-visual-review" &&
          typeof stateReview.reviewer?.name === "string" &&
          stateReview.reviewer.name.trim().length > 0 &&
          sameStringArray(
            stateReview.criteria,
            DESIGN_VISUAL_REVIEW_CRITERIA,
          ) &&
          typeof stateReview.notes === "string" &&
          stateReview.notes.trim().length >= 20 &&
          stateReview.reference?.path ===
            `docs/design-qa/reference/${row.state}.png` &&
          SHA256_PATTERN.test(
            stateReview.reference?.sha256 ?? "",
          ) &&
          Number.isSafeInteger(stateReview.reference?.bytes) &&
          stateReview.reference.bytes > 0 &&
          hasCanonicalDimensions(
            stateReview.reference?.dimensions,
          ) &&
          stateReview.actual?.path ===
            `docs/design-qa/final-actual/${row.state}.png` &&
          SHA256_PATTERN.test(stateReview.actual?.sha256 ?? "") &&
          Number.isSafeInteger(stateReview.actual?.bytes) &&
          stateReview.actual.bytes > 0 &&
          hasCanonicalDimensions(stateReview.actual?.dimensions) &&
          row.referenceEvidence?.sha256 ===
            stateReview.reference.sha256 &&
          row.referenceEvidence?.bytes ===
            stateReview.reference.bytes &&
          row.referenceEvidence?.dimensions?.width ===
            stateReview.reference.dimensions.width &&
          row.referenceEvidence?.dimensions?.height ===
            stateReview.reference.dimensions.height &&
          row.actualEvidence?.sha256 === stateCapture.sha256 &&
          row.actualEvidence?.bytes === stateCapture.bytes &&
          row.actualEvidence?.dimensions?.width ===
            stateCapture.dimensions.width &&
          row.actualEvidence?.dimensions?.height ===
            stateCapture.dimensions.height &&
          row.actualEvidence.sha256 === stateReview.actual.sha256 &&
          row.actualEvidence.bytes === stateReview.actual.bytes &&
          row.actualEvidence.dimensions.width ===
            stateReview.actual.dimensions.width &&
          row.actualEvidence.dimensions.height ===
            stateReview.actual.dimensions.height &&
          isDeepStrictEqual(row.visualReview, {
            status: stateReview.status,
            reviewer: stateReview.reviewer,
            criteria: stateReview.criteria,
            notes: stateReview.notes,
          })
        );
      },
    ),
    `${description} rows and actual evidence must match capture provenance`,
  );
  requireCondition(
    Object.entries(ledger.summary).every(
      ([name, count]) =>
        name === "total" ||
        name === "passed" ||
        name === "budgeted" ||
        (Number.isSafeInteger(count) && count === 0),
    ),
    `${description} summary must not contain non-passing states`,
  );
}

export function validateCapabilityEvidence({
  generation,
  ledger,
  systemCapabilities,
}) {
  const description = "Installed Docker capability evidence";
  requireSchemaVersion(generation, `${description} generation`);
  requireSchemaVersion(ledger, `${description} ledger`);
  const flattenAvailableLeaves = (node, result = []) => {
    const children = Array.isArray(node?.subcommands)
      ? node.subcommands
      : [];
    if (
      children.length === 0 &&
      node?.status === "available" &&
      Array.isArray(node.path) &&
      node.path.length > 0
    ) {
      result.push(node);
      return result;
    }
    for (const child of children) {
      flattenAvailableLeaves(child, result);
    }
    return result;
  };
  const availableLeaves = flattenAvailableLeaves(
    systemCapabilities?.commandInventory?.root,
  );
  const leafKeys = availableLeaves.map((leaf) =>
    JSON.stringify(leaf.path));
  requireCondition(
    availableLeaves.length > 0 &&
      availableLeaves.every((leaf) =>
        leaf.path.every(
          (token) => typeof token === "string" && token.length > 0,
        )) &&
      new Set(leafKeys).size === leafKeys.length,
    `${description} system snapshot must contain unique available leaf identities`,
  );
  const selectedContext =
    systemCapabilities?.selectedContext ??
    systemCapabilities?.currentContext;
  requireCondition(
    typeof selectedContext === "string" &&
      selectedContext.length > 0 &&
      generation.context === selectedContext &&
      ledger.selectedContext === selectedContext,
    `${description} context must match across snapshot, ledger, and generation`,
  );
  requireIsoDate(
    systemCapabilities?.observedAt,
    `${description} source observedAt`,
  );
  requireIsoDate(generation.startedAt, `${description} generation startedAt`);
  requireIsoDate(
    generation.completedAt,
    `${description} generation completedAt`,
  );
  requireIsoDate(ledger.generatedAt, `${description} ledger generatedAt`);
  requireCondition(
    generation.sourceObservedAt === systemCapabilities.observedAt &&
      ledger.sourceObservedAt === systemCapabilities.observedAt &&
      ledger.generatedAt === generation.completedAt &&
      Date.parse(generation.startedAt) <=
        Date.parse(systemCapabilities.observedAt) &&
      Date.parse(systemCapabilities.observedAt) <=
        Date.parse(generation.completedAt),
    `${description} timestamps must identify the same inventory observation`,
  );
  requireCondition(
    generation.complete === true &&
      Number.isSafeInteger(generation.leafCount) &&
      generation.leafCount === availableLeaves.length &&
      generation.nodeCount ===
        systemCapabilities.commandInventory.nodeCount &&
      generation.transportCovered === generation.leafCount &&
      generation.commandExecutedConformancePassed === 0 &&
      generation.blocked === 0,
    `${description} generation counts must match the exact available inventory`,
  );
  requireSha256(generation.coreSha256, `${description} core sha256`);
  requireSha256(
    generation.dockerBinarySha256,
    `${description} Docker binary sha256`,
  );
  requireSha256(
    generation.generator?.sha256,
    `${description} generator sha256`,
  );
  requireCondition(
    ledger.inventory?.complete === true &&
      ledger.inventory.nodeCount === generation.nodeCount &&
      ledger.inventory.leafCount === generation.leafCount &&
      ledger.inventory.transportCovered === generation.transportCovered &&
      ledger.inventory.commandExecutedConformancePassed === 0 &&
      ledger.inventory.blocked === 0 &&
      Array.isArray(ledger.rows) &&
      ledger.rows.length === generation.leafCount,
    `${description} ledger inventory must match its generation record`,
  );
  const rowsByLeafKey = new Map(
    ledger.rows.map((row) => [
      JSON.stringify(row?.commandIdentity?.path),
      row,
    ]),
  );
  requireCondition(
    rowsByLeafKey.size === ledger.rows.length &&
      availableLeaves.every((leaf) => {
        const row = rowsByLeafKey.get(JSON.stringify(leaf.path));
        return (
          row?.id === `docker:${leaf.path.join(":")}` &&
          row.commandIdentity.executable ===
            systemCapabilities.binary.realPath &&
          row.commandIdentity.executableSha256 ===
            generation.dockerBinarySha256 &&
          row.commandIdentity.plugin === (leaf.pluginRoot ?? null) &&
          row.commandIdentity.command ===
            `docker ${leaf.path.join(" ")}` &&
          row.commandIdentity.kind === leaf.kind &&
          row.discovery?.status === "available" &&
          row.discovery.reason === leaf.reason &&
          row.discovery.usage === (leaf.usage ?? null) &&
          sameStringArray(
            row.discovery.transports,
            leaf.transports,
          ) &&
          row.invocation?.context === selectedContext &&
          sameStringArray(
            row.invocation.argvPrefix,
            ["--context", selectedContext],
          ) &&
          sameStringArray(row.invocation.commandArgv, leaf.path) &&
          row.uiPath?.selection === leaf.path.join(" ") &&
          row.status === "transport-covered" &&
          row.blockedReason === null &&
          row.result?.coverage === "executable-through-installed-cli" &&
          typeof row.result?.commandExecution === "string" &&
          row.result.commandExecution.startsWith(
            "not-run-by-ledger-generator",
          ) &&
          Array.isArray(row.transportEvidence) &&
          row.transportEvidence.length > 0
        );
      }),
    `${description} ledger rows must exactly reconcile one-to-one with available leaves`,
  );
  requireCondition(
    ledger.rows.every(
      (row) =>
        row?.status === "transport-covered" &&
        row.blockedReason === null &&
        row.result?.coverage === "executable-through-installed-cli" &&
        typeof row.result?.commandExecution === "string" &&
        row.result.commandExecution.startsWith("not-run-by-ledger-generator") &&
        Array.isArray(row.transportEvidence) &&
        row.transportEvidence.length > 0 &&
        row.commandIdentity?.executableSha256 ===
          generation.dockerBinarySha256
    ),
    `${description} ledger must distinguish transport coverage from command execution`,
  );
  requireCondition(
    systemCapabilities?.binary?.sha256 ===
      generation.dockerBinarySha256,
    `${description} system snapshot must match the Docker binary hash`,
  );
  requireCondition(
    systemCapabilities?.commandInventory?.complete === true &&
      systemCapabilities.commandInventory.limitReached === false &&
      ledger.inventory.nodeCount ===
        systemCapabilities.commandInventory.nodeCount &&
      ledger.inventory.leafCount ===
        availableLeaves.length &&
      Array.isArray(systemCapabilities.commandInventory.warnings) &&
      systemCapabilities.commandInventory.warnings.length === 0 &&
      Array.isArray(ledger.inventory.warnings) &&
      ledger.inventory.warnings.length === 0,
    `${description} system snapshot must contain the complete inventory`,
  );
}

export function validatePerformanceEvidence(
  { results, environment },
  {
    minimumSoakDurationSeconds = 1_800,
    expectedHarnessSha256,
  } = {},
) {
  const description = "Performance evidence";
  requireSchemaVersion(results, `${description} results`);
  requireSchemaVersion(environment, `${description} environment`);
  requireCondition(
    results.status === "passed" && results.error === undefined,
    `${description} must report a passing run without an error`,
  );
  requireCondition(
    results.readOnly === true && environment.harness?.readOnly === true,
    `${description} must be read-only`,
  );
  requireCondition(
    environment.harness?.script ===
      "tools/run-performance-evidence.mjs",
    `${description} must identify the canonical performance harness`,
  );
  requireSha256(
    environment.harness?.sha256,
    `${description} harness sha256`,
  );
  if (expectedHarnessSha256 !== undefined) {
    requireCondition(
      environment.harness.sha256 === expectedHarnessSha256,
      `${description} harness must match the current source`,
    );
  }
  requireCondition(
    results.requestedSoakDurationSeconds >= minimumSoakDurationSeconds &&
      environment.harness?.requestedSoakDurationSeconds ===
        results.requestedSoakDurationSeconds,
    `${description} must contain the authoritative soak duration`,
  );
  requireCondition(
    results.streamingSoak?.requestedDurationSeconds ===
      results.requestedSoakDurationSeconds &&
      results.streamingSoak?.actualDurationMs >=
        results.requestedSoakDurationSeconds * 1_000 &&
      Array.isArray(results.streamingSoak?.rssSamples) &&
      results.streamingSoak.rssSamples.length > 1,
    `${description} must contain the complete streaming soak`,
  );
  const slo = results.performanceSLO;
  requireCondition(
    slo?.profile === RELEASE_PERFORMANCE_PROFILE.id &&
      slo.status === "passed",
    `${description} must use the passing ${RELEASE_PERFORMANCE_PROFILE.id} profile`,
  );
  requireCondition(
    samePlainRecord(
      slo.thresholds,
      RELEASE_PERFORMANCE_PROFILE.thresholds,
    ),
    `${description} must use the exact release SLO thresholds`,
  );
  requireCondition(
    Array.isArray(slo.checks) &&
      slo.checks.length === RELEASE_PERFORMANCE_CHECK_IDS.length,
    `${description} must contain the exact release SLO check set`,
  );
  const actualSloIds = slo.checks.map((check) => check?.id);
  requireCondition(
    new Set(actualSloIds).size === actualSloIds.length,
    `${description} must contain unique release SLO check ids`,
  );
  requireCondition(
    sameStringArray(
      [...actualSloIds].sort(),
      [...RELEASE_PERFORMANCE_CHECK_IDS].sort(),
    ),
    `${description} must contain the exact release SLO check set`,
  );
  const checksById = new Map(slo.checks.map((check) => [check.id, check]));
  requireCondition(
    RELEASE_PERFORMANCE_MAXIMUM_CHECKS.every((definition) => {
      const check = checksById.get(definition.id);
      const observed = definition.observed(results);
      const limit =
        RELEASE_PERFORMANCE_PROFILE.thresholds[definition.threshold];
      return (
        check?.metric === definition.metric &&
        check.comparison === "<=" &&
        Object.is(check.observed, observed) &&
        Object.is(check.limit, limit) &&
        check.status === "passed" &&
        Number.isFinite(observed) &&
        observed <= limit
      );
    }) &&
      RELEASE_PERFORMANCE_MINIMUM_CHECKS.every((definition) => {
        const check = checksById.get(definition.id);
        const observed = definition.observed(results);
        const limit =
          RELEASE_PERFORMANCE_PROFILE.thresholds[definition.threshold];
        return (
          check?.metric === definition.metric &&
          check.comparison === ">=" &&
          Object.is(check.observed, observed) &&
          Object.is(check.limit, limit) &&
          check.status === "passed" &&
          Number.isFinite(observed) &&
          observed >= limit
        );
      }) &&
      RELEASE_PERFORMANCE_EQUAL_CHECKS.every((definition) => {
        const check = checksById.get(definition.id);
        const observed = definition.observed(results);
        const expected = definition.expected(results);
        return (
          check?.metric === definition.metric &&
          check.comparison === "===" &&
          Object.is(check.observed, observed) &&
          Object.is(check.expected, expected) &&
          check.status === "passed" &&
          Object.is(observed, expected)
        );
      }),
    `${description} release SLO observed values must match results`,
  );
  requireCondition(
    results.coreExit?.code === 0 && results.coreExit.signal === null,
    `${description} core must exit cleanly`,
  );
  requireCondition(
    environment.tools?.core?.runtime?.protocolVersion === "1" &&
      environment.tools.core.runtime.dockerReady === true,
    `${description} environment must record a ready protocol-v1 core`,
  );
  requireSha256(
    environment.tools?.core?.sha256,
    `${description} core sha256`,
  );
  requireCondition(
    results.completedAt === environment.completedAt,
    `${description} results and environment must describe the same run`,
  );
  requireCondition(
    results.context === environment.harness?.context,
    `${description} results and environment context must match`,
  );
}
