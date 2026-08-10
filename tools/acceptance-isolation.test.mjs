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
