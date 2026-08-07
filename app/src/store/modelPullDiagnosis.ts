/**
 * Why a model pull failed, when the reason is not about the model.
 *
 * `docker model pull` does not only download. It first starts Docker Model Runner, which is
 * itself a container, and when that container cannot start the pull fails before a byte moves.
 * The output says so, but it says so at the bottom of a wall of registry chatter, in one
 * sentence built out of five nested causes:
 *
 *     Successfully pulled docker/model-runner:latest-cuda
 *     Starting model runner container docker-model-runner...
 *     unable to initialize standalone model runner: unable to initialize standalone model
 *     runner container: failed to start container docker-model-runner: Error response from
 *     daemon: failed to create task for container: failed to create shim task: OCI runtime
 *     create failed: runc create failed: unable to start container process: error during
 *     container init: failed to fulfil mount request:
 *     open /usr/lib/libnvidia-gtk3.so.610.57.04: no such file or directory
 *
 * Every word of that is Docker's, and none of it is wrong; what it does not do is separate the
 * one fact that matters — a file the GPU runtime asked for is not on this machine — from six
 * layers of plumbing that will mean nothing to the person reading it. On the machine this was
 * found on, the answer was a driver upgrade that left a CDI spec pointing at a library only the
 * un-upgraded `nvidia-settings` package shipped. It looked exactly like "models are broken".
 *
 * So this reads the output and says which failure it is, in a sentence. It states nothing it
 * cannot see: the missing path is quoted from the output rather than guessed at, and where the
 * runner fails for some other reason it says only that, rather than inventing a cause. Docker's
 * full text stays on screen underneath — this is a heading for it, not a replacement.
 */

export type ModelPullDiagnosis = {
  /** One sentence naming the failure. */
  summary: string;
  /** The file the container runtime asked for and did not find, when the output names one. */
  missingPath?: string;
  /** Where to look, when that is knowable from the output alone. */
  hint?: string;
};

/** The runner is a container; this is that container failing to start, not a download failing. */
const RUNNER_INIT_FAILED = /unable to initialize standalone model runner/iu;

/**
 * A mount the container runtime could not satisfy.
 *
 * `failed to fulfil mount request` is the Docker spelling; the CDI machinery underneath spells
 * it "fulfill". Both are matched because which one appears depends on versions this cannot see.
 */
const MISSING_MOUNT =
  /failed to fulfil?l? mount request:\s*open\s+(\S+):\s*no such file or directory/iu;

/** A library shipped by a GPU driver package, as opposed to any other absent path. */
const DRIVER_LIBRARY = /libnvidia|libcuda|nvidia-smi|libnvcuvid/iu;

export function diagnoseModelPull(output: string): ModelPullDiagnosis | null {
  if (!RUNNER_INIT_FAILED.test(output)) return null;

  const mount = MISSING_MOUNT.exec(output);
  if (!mount) {
    return {
      summary:
        "Docker Model Runner could not start its own container, so the download never began. This is the runner, not the model — Docker's reason is below.",
    };
  }

  const missingPath = mount[1];
  if (DRIVER_LIBRARY.test(missingPath)) {
    return {
      summary:
        "Docker Model Runner could not start its own container, so the download never began. The container asked for a GPU driver library that is not on this machine.",
      missingPath,
      // Named because it is where the request comes from and it is checkable in one command.
      // Not phrased as the fix: this cannot see which runtime is configured, and telling someone
      // to regenerate a file that may not be the one in play is worse than telling them where
      // to look. A driver upgrade that leaves one NVIDIA package behind produces exactly this.
      hint: "That path is requested by the container runtime's device spec, usually under /etc/cdi/. A driver upgrade that left one package at the old version will produce this, because the spec is written for the new version and the file is still the old one.",
    };
  }

  return {
    summary:
      "Docker Model Runner could not start its own container, so the download never began. A file the container needs is missing from this machine.",
    missingPath,
  };
}
