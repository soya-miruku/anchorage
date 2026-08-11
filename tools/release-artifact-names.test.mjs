/**
 * The names a release publishes, pinned.
 *
 * One property is the reason this file exists: every name in SHA256SUMS must be a name the
 * release actually contains. It did not hold. SHA256SUMS covered `release-verification.json` and
 * the release workflow renamed that file immediately afterwards, so `sha256sum -c` — the publish
 * job's own check, and the command README.md gives a downloader — answered "FAILED open or read"
 * and exited non-zero on every release that had ever been built. The first test below is that
 * property; the rest are the ways a set of names can be wrong.
 *
 * Directory listings rather than directories: these are decisions about names, and a decision
 * that needs a built release to test is a decision that does not get tested.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHITECTURE_TOKEN,
  coverableArtifacts,
  publicationRenames,
  publishedNames,
} from "./release-artifact-names.mjs";

/**
 * app/release as `bun run package:linux` leaves it, with electron-builder's own artifact names —
 * including the two things that must never be covered or published: the debug log it writes
 * beside the installers, and the unpacked tree the AppImage was built from.
 */
const PACKAGED = {
  x64: [
    "Anchorage-0.1.0-x86_64.AppImage",
    "anchorage-0.1.0.x86_64.pacman",
    "anchorage-0.1.0.x86_64.rpm",
    "anchorage_0.1.0_amd64.deb",
    "builder-debug.yml",
    "linux-unpacked",
    "release-verification.json",
  ],
  arm64: [
    "Anchorage-0.1.0-arm_aarch64.AppImage",
    "anchorage-0.1.0.aarch64.pacman",
    "anchorage-0.1.0.aarch64.rpm",
    "anchorage_0.1.0_arm64.deb",
    "builder-debug.yml",
    "linux-arm64-unpacked",
    "release-verification.json",
  ],
};

/** The listing after the renames have been applied, which is what the release publishes. */
function published(architecture) {
  let names = [...PACKAGED[architecture]];
  for (const { from, to } of publicationRenames(names, architecture)) {
    names = names.map((name) => (name === from ? to : name));
  }
  return names;
}

test("every covered name is a file the release publishes", () => {
  for (const architecture of ["x64", "arm64"]) {
    const names = published(architecture);
    const covered = coverableArtifacts(names, architecture);
    assert.equal(covered.ok, true);
    for (const name of covered.names) {
      assert.ok(
        names.includes(name),
        `SHA256SUMS-${architecture} would cover ${name}, which the release does not contain`,
      );
    }
  }
});

test("the covered set is the four installers and the verification report", () => {
  const covered = coverableArtifacts(published("x64"), "x64");
  assert.deepEqual(covered.names, [
    "Anchorage-0.1.0-x86_64.AppImage",
    "anchorage-0.1.0.x86_64.pacman",
    "anchorage-0.1.0.x86_64.rpm",
    "anchorage_0.1.0_amd64.deb",
    "release-verification-x64.json",
  ]);
});

test("a report still under packaging's name is refused rather than covered", () => {
  // The exact shape of the bug: an architecture to publish for, and a verification report that
  // has not been named for it. Covering `release-verification.json` here is what wrote a checksum
  // line for a file the release would not contain, and silently omitting it would leave the
  // release's own evidence uncovered — so neither, and the build stops.
  const covered = coverableArtifacts(PACKAGED.x64, "x64");
  assert.equal(covered.ok, false);
  assert.equal(covered.reason, "no-verification-report");
  assert.match(covered.summary, /release-verification-x64\.json/u);
});

test("two architectures publish disjoint names, so merging them cannot collide", () => {
  const x64 = published("x64").filter((name) => name !== "builder-debug.yml");
  const arm64 = published("arm64").filter((name) => name !== "builder-debug.yml");
  const shared = x64.filter((name) => arm64.includes(name));
  assert.deepEqual(shared, []);
  for (const architecture of ["x64", "arm64"]) {
    const names = publishedNames(architecture);
    assert.deepEqual(
      [names.checksums, names.signature, names.signingReceipt, names.verificationReport],
      [
        `SHA256SUMS-${architecture}`,
        `SHA256SUMS-${architecture}.asc`,
        `release-signature-${architecture}.json`,
        `release-verification-${architecture}.json`,
      ],
    );
  }
});

test("without an architecture the names stay as packaging wrote them", () => {
  const names = publishedNames(undefined);
  assert.deepEqual(names, {
    checksums: "SHA256SUMS",
    signature: "SHA256SUMS.asc",
    signingReceipt: "release-signature.json",
    verificationReport: "release-verification.json",
  });
  assert.deepEqual(publicationRenames(PACKAGED.x64, undefined), []);
  const covered = coverableArtifacts(PACKAGED.x64, undefined);
  assert.equal(covered.ok, true);
  assert.ok(covered.names.includes("release-verification.json"));
});

test("naming the report for its architecture happens once and repeats safely", () => {
  assert.deepEqual(publicationRenames(PACKAGED.x64, "x64"), [
    { from: "release-verification.json", to: "release-verification-x64.json" },
  ]);
  // A second run over the same directory — `--verify-only`, or a re-sign — has nothing to do.
  assert.deepEqual(publicationRenames(published("x64"), "x64"), []);
});

test("the debug log and the unpacked tree are never covered", () => {
  const covered = coverableArtifacts(
    [...published("x64"), "linux-unpacked", "builder-debug.yml", "notes.md"],
    "x64",
  );
  assert.equal(covered.ok, true);
  for (const name of ["linux-unpacked", "builder-debug.yml", "notes.md"]) {
    assert.ok(!covered.names.includes(name));
  }
});

test("latest-linux.yml is not covered, because packaging never writes one", () => {
  // It was in the covered set and has never existed: packaging passes `--publish never`, so
  // electron-builder resolves no publish configuration and emits no update metadata. A name that
  // is never on disk is the same broken checksum line as a name that was renamed away.
  const covered = coverableArtifacts([...published("x64"), "latest-linux.yml"], "x64");
  assert.equal(covered.ok, true);
  assert.ok(!covered.names.includes("latest-linux.yml"));
});

test("the checksum file and its signature are not covered", () => {
  const covered = coverableArtifacts(
    [...published("x64"), "SHA256SUMS-x64", "SHA256SUMS-x64.asc", "release-signature-x64.json"],
    "x64",
  );
  assert.equal(covered.ok, true);
  for (const name of ["SHA256SUMS-x64", "SHA256SUMS-x64.asc", "release-signature-x64.json"]) {
    assert.ok(!covered.names.includes(name));
  }
});

test("a directory with no AppImage is refused", () => {
  const covered = coverableArtifacts(
    published("x64").filter((name) => !name.endsWith(".AppImage")),
    "x64",
  );
  assert.equal(covered.ok, false);
  assert.equal(covered.reason, "no-appimage");
});

test("an architecture is a plain token, because it becomes part of a published file name", () => {
  for (const accepted of ["x64", "arm64", "arm_aarch64"]) {
    assert.ok(ARCHITECTURE_TOKEN.test(accepted), accepted);
  }
  // `--arch --key` and `--arch ../..` would otherwise name and cover files nobody asked for.
  for (const rejected of ["", "--key", "../x64", "x64 arm64", "x64/", "X64"]) {
    assert.ok(!ARCHITECTURE_TOKEN.test(rejected), rejected);
  }
});
