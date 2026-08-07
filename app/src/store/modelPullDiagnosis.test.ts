// @vitest-environment node

import { describe, expect, it } from "vitest";

import { diagnoseModelPull } from "./modelPullDiagnosis";

/*
 * The output below is verbatim from a real failure, tail included.
 *
 * A driver upgrade left `nvidia-settings` a version behind the rest, so /etc/cdi/nvidia.yaml —
 * regenerated one minute after the upgrade — pointed at a library only that package ships, at a
 * version that did not exist. Every model pull then failed before a byte moved, and the symptom
 * an operator saw was "models are broken". Nothing in Docker's message is wrong; the one fact
 * that mattered was the last twelve words of a sentence built from six nested causes.
 */
const RUNNER_CDI_FAILURE = [
  "latest-cuda: Pulling from docker/model-runner",
  "Status: Image is up to date for docker/model-runner:latest-cuda",
  "Successfully pulled docker/model-runner:latest-cuda",
  "Starting model runner container docker-model-runner...",
  "unable to initialize standalone model runner: unable to initialize standalone model runner" +
    " container: failed to start container docker-model-runner: Error response from daemon:" +
    " failed to create task for container: failed to create shim task: OCI runtime create" +
    " failed: runc create failed: unable to start container process: error during container" +
    " init: failed to fulfil mount request:" +
    " open /usr/lib/libnvidia-gtk3.so.610.57.04: no such file or directory",
].join("\n");

describe("diagnoseModelPull", () => {
  it("separates the runner failing to start from the model failing to download", () => {
    const diagnosis = diagnoseModelPull(RUNNER_CDI_FAILURE);
    expect(diagnosis?.summary).toMatch(/could not start its own container/u);
    // The distinction the operator needs: nothing is wrong with the model or the registry.
    expect(diagnosis?.summary).toMatch(/download never began/u);
  });

  it("quotes the missing path rather than describing it", () => {
    // Quoted, not guessed: this is the string someone pastes into `ls` to confirm.
    expect(diagnoseModelPull(RUNNER_CDI_FAILURE)?.missingPath).toBe(
      "/usr/lib/libnvidia-gtk3.so.610.57.04",
    );
    expect(diagnoseModelPull(RUNNER_CDI_FAILURE)?.hint).toMatch(/\/etc\/cdi\//u);
  });

  it("recognises the other spelling, because which one appears is a version detail", () => {
    const spelled = RUNNER_CDI_FAILURE.replace("fulfil mount", "fulfill mount");
    expect(diagnoseModelPull(spelled)?.missingPath).toBe(
      "/usr/lib/libnvidia-gtk3.so.610.57.04",
    );
  });

  it("says only what it can see when the runner fails for another reason", () => {
    const diagnosis = diagnoseModelPull(
      "Starting model runner container docker-model-runner...\n" +
        "unable to initialize standalone model runner: port 12434 already allocated",
    );
    expect(diagnosis?.summary).toMatch(/could not start its own container/u);
    // No path, and no GPU hint. Inventing a cause here would send someone to /etc/cdi/ over a
    // port clash — a confident wrong answer, which is the thing this project exists not to do.
    expect(diagnosis?.missingPath).toBeUndefined();
    expect(diagnosis?.hint).toBeUndefined();
  });

  it("stays silent about failures that are not the runner", () => {
    expect(diagnoseModelPull("Downloaded 12.06MB of 270.60MB")).toBeNull();
    expect(
      diagnoseModelPull(
        'failed to pull model "ai/nope:latest": pull access denied, repository does not exist',
      ),
    ).toBeNull();
    expect(diagnoseModelPull("")).toBeNull();
  });
});
