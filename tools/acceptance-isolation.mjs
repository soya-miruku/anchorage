/**
 * The parts of the acceptance harness that can be reasoned about without a Docker daemon.
 *
 * run-core-acceptance.mjs is a script with no exports, so nothing inside it can be unit-tested.
 * Orphan classification and teardown ordering are the two pieces where a mistake is silent and
 * expensive — a sweep that matches too widely deletes a running container, one that matches too
 * narrowly leaves a privileged daemon behind — so they live here, where a test can reach them.
 */

/** The label the harness stamps on every container it owns. */
export const ACCEPTANCE_LABEL = "io.anchorage.acceptance";

/**
 * Container and context names the harness creates.
 *
 * Anchored at both ends and exact about the suffix: `anchorage-dind-40d348de-extra` is somebody
 * else's container that happens to start the same way, and sweeping it would be destroying a
 * stranger's work on the strength of a prefix.
 */
export const ACCEPTANCE_RESOURCE_PATTERN =
  /^anchorage-(?:dind|sbx)(?:-sock)?-([0-9a-f]{8})$/u;

/** Scratch directories under artifacts/docker/. */
export const SCRATCH_DIRECTORY_PATTERN = /^acceptance-scratch-([0-9a-f]{8})$/u;

function suffixOf(name, pattern) {
  const match = pattern.exec(name);
  return match ? match[1] : null;
}

/**
 * Splits observed names into "debris from an earlier run" and "not ours / still in use".
 *
 * `activeSuffix` is excluded because the caller runs this while its own resources exist; without
 * that exclusion the preflight would sweep the run that invoked it.
 */
export function classifyOrphans({
  containerNames = [],
  contextNames = [],
  scratchNames = [],
  activeSuffix = null,
} = {}) {
  const orphaned = (names, pattern) =>
    names.filter((name) => {
      const suffix = suffixOf(name, pattern);
      return suffix !== null && suffix !== activeSuffix;
    });

  return {
    containers: orphaned(containerNames, ACCEPTANCE_RESOURCE_PATTERN),
    contexts: orphaned(contextNames, ACCEPTANCE_RESOURCE_PATTERN),
    scratchDirectories: orphaned(scratchNames, SCRATCH_DIRECTORY_PATTERN),
  };
}

/**
 * Teardown steps, run once, in reverse order, with failures recorded rather than thrown.
 *
 * Reverse order because the resources nest: the container must go before the context that points
 * at it, and the scratch directory last because it holds the socket the context named. Failures
 * are collected instead of propagated because the first failing step is exactly when the
 * remaining steps matter most — abandoning them is how a privileged container survives.
 *
 * Idempotent because two callers race for it: the `finally` block on the normal path, and the
 * signal handler when a run is interrupted. Whichever arrives first does the work.
 */
export function createTeardownRegistry() {
  const steps = [];
  let ran = false;

  return {
    add(name, fn) {
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("teardown step needs a name");
      }
      if (typeof fn !== "function") {
        throw new TypeError(`teardown step ${name} needs a function`);
      }
      steps.push({ name, fn });
    },
    get size() {
      return steps.length;
    },
    async run() {
      if (ran) return { alreadyRan: true, steps: [] };
      ran = true;
      const results = [];
      for (const step of [...steps].reverse()) {
        try {
          await step.fn();
          results.push({ name: step.name, ok: true, error: null });
        } catch (error) {
          results.push({
            name: step.name,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { alreadyRan: false, steps: results };
    },
  };
}
