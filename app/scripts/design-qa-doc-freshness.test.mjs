import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Keeps `design-qa.md` from outliving the evidence it cites.
 *
 * This is the defect that started the v2 design review rather than a hypothetical one. The file
 * asserted "Result: 24 of 24 states passed" and "final result: passed" against a baseline that
 * had been superseded, a renderer build 21 files out of date, and three themes when four ship.
 * Every hash in it was individually plausible and collectively describing a release that no
 * longer existed, and nothing in the repository disagreed.
 *
 * A recorded SHA-256 is only evidence while it still matches the file it names. Three inputs are
 * checked: the comp the whole comparison is against, the attestation that carries the per-state
 * review, and the provenance binding the captures. The renderer and ledger digests are generated
 * into `artifacts/`, which is not committed, so they are checked only when present.
 *
 * The comp is now in that second category too. It is a full 21-screen design document, kept out
 * of the published repository on purpose, so its digest can no longer be verified from a clean
 * checkout — only on a machine that has it. That is a real reduction and it is skipped out loud
 * rather than dropped, because the hash in `design-qa.md` still means something to anyone
 * holding the file, and a check that quietly stops running is worse than one that says why.
 */

const repositoryRoot = new URL("../../", import.meta.url);
const docPath = fileURLToPath(new URL("design-qa.md", repositoryRoot));
const doc = readFileSync(docPath, "utf8");

function sha256(relativePath) {
  return createHash("sha256")
    .update(readFileSync(fileURLToPath(new URL(relativePath, repositoryRoot))))
    .digest("hex");
}

/** The Evidence section only — a hash quoted in prose elsewhere is not a claim about a file. */
function evidenceSection() {
  const start = doc.indexOf("## Evidence");
  assert.ok(start !== -1, "design-qa.md must carry an Evidence section");
  const end = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

const TRACKED_INPUTS = [
  {
    label: "the v2 design comp",
    path: "docs/design_handoff_anchorage/Anchorage v2.dc.html",
    why: "the comp every state is measured against; a stale digest here means the document describes a superseded handoff",
    onlyWhenPresent: true,
  },
  {
    label: "the visual review attestation",
    path: "docs/design-qa/visual-review-attestation.json",
    why: "the per-state review; a stale digest here means the recorded approvals are not the ones on disk",
  },
  {
    label: "the capture provenance",
    path: "docs/design-qa/final-actual/capture-provenance.json",
    why: "binds the 24 captures to the renderer that produced them",
  },
];

for (const input of TRACKED_INPUTS) {
  test(`design-qa.md cites the current digest for ${input.label}`, (context) => {
    if (input.onlyWhenPresent && !existsSync(fileURLToPath(new URL(input.path, repositoryRoot)))) {
      context.skip(`${input.path} is not in this checkout`);
      return;
    }
    const expected = sha256(input.path);
    assert.ok(
      evidenceSection().includes(expected),
      `design-qa.md does not cite the current SHA-256 of ${input.path} (${expected}) — ${input.why}. Regenerate the evidence block rather than editing the hash by hand.`,
    );
  });
}

test("design-qa.md does not claim a pixel-parity pass it cannot hold", () => {
  // The superseded document ended with a bare "final result: passed" that no longer reflected
  // any measurement. Divergences now ship on recorded budgets, so a blanket pass claim is a
  // stronger statement than the gate makes.
  assert.ok(
    !/^final result:\s*passed\s*$/imu.test(doc),
    "design-qa.md ends with an unqualified pass claim; the gate reports passed and budgeted states separately",
  );
});

test("design-qa.md records the baseline it actually measures against", () => {
  assert.ok(
    doc.includes("docs/design-qa/reference"),
    "design-qa.md must name the generated baseline directory",
  );
  assert.ok(
    doc.includes("tools/capture-design-reference.mjs"),
    "design-qa.md must name the harness that regenerates the baseline, or the baseline is unreproducible",
  );
});
