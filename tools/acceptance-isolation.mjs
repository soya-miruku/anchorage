/**
 * The parts of the acceptance harness that can be reasoned about without a Docker daemon.
 *
 * run-core-acceptance.mjs is a script with no exports, so nothing inside it can be unit-tested.
 * Deciding which resources a sweep may touch is where a mistake is silent and expensive — match
 * too widely and a running container is destroyed, too narrowly and a privileged daemon is left
 * behind — so that judgement lives here, where a test can reach it.
 *
 * Teardown *ordering* deliberately does not. It was drafted here as a step registry and shipped
 * as `runTeardown()` in the harness instead, because the ordering is inseparable from the
 * resources it orders: the shared in-flight promise that stops a second signal cutting the first
 * teardown short, the drain that must precede the removals, and the verification passes that
 * follow them are all statements about Docker clients and a live daemon. A registry here could
 * only have re-tested itself. Nothing exported from this file claims anything about when
 * teardown runs.
 */

/** The label the harness stamps on every container it owns. */
export const ACCEPTANCE_LABEL = "io.anchorage.acceptance";

/**
 * The label that says which process created a container, so a later run can ask whether that
 * process is still here rather than guessing.
 *
 * Two acceptance runs share one Docker daemon on a developer machine, and the label above cannot
 * tell "debris from a run that died" from "the container a run started ninety seconds ago and is
 * using right now". Sweeping the second is destroying a colleague's work; refusing to sweep the
 * first is the leak this whole task exists to close. The creator identity is what separates them.
 */
export const ACCEPTANCE_CREATOR_LABEL = "io.anchorage.acceptance.creator";

/**
 * How old an acceptance resource must be before a run that cannot identify its creator treats it
 * as debris.
 *
 * Only the fallback: a resource stamped by this harness is judged by whether its creating process
 * is still running, which is exact and needs no clock. This bound covers the cases where that
 * question cannot be asked — a container created by a checkout that predates the creator label, or
 * by a different kernel boot, or from another machine sharing this daemon. It is deliberately far
 * longer than a run: a mutation suite takes minutes, so half an hour is roughly a ten-times margin
 * over the longest run measured here, and the cost of being wrong in this direction is only that
 * unidentifiable debris waits for a later run.
 */
export const ORPHAN_MIN_AGE_MS = 30 * 60_000;

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
 * The run suffix a name belongs to, whichever of the two conventions it follows.
 *
 * One suffix ties a container, its two contexts and its scratch directory together, which is what
 * lets a verdict reached about the container decide the fate of the rest.
 */
export function acceptanceSuffixOf(name) {
  return (
    suffixOf(name, ACCEPTANCE_RESOURCE_PATTERN) ??
    suffixOf(name, SCRATCH_DIRECTORY_PATTERN)
  );
}

/** `boot=<uuid>;ns=<pid-namespace-inode>;pid=<pid>;start=<clock ticks since boot>` */
export function formatCreatorIdentity({
  bootId = null,
  pidNamespace = null,
  pid = null,
  startTicks = null,
} = {}) {
  return [
    `boot=${bootId ?? ""}`,
    `ns=${pidNamespace ?? ""}`,
    `pid=${pid ?? ""}`,
    `start=${startTicks ?? ""}`,
  ].join(";");
}

/**
 * Reads back what `formatCreatorIdentity` wrote, or null when the value is not one of ours.
 *
 * `null` rather than a partly-filled object: a half-understood identity would be evaluated as
 * though it were understood, and the resource on the other end of it is a privileged daemon
 * somebody may still be using.
 */
export function parseCreatorIdentity(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const fields = new Map();
  for (const part of raw.split(";")) {
    const at = part.indexOf("=");
    if (at > 0) fields.set(part.slice(0, at), part.slice(at + 1));
  }
  const bootId = fields.get("boot");
  const pid = Number(fields.get("pid"));
  if (!bootId || !Number.isInteger(pid) || pid <= 0) return null;
  const startTicks = Number(fields.get("start"));
  return {
    bootId,
    pidNamespace: fields.get("ns") || null,
    pid,
    startTicks: Number.isFinite(startTicks) && fields.get("start") !== ""
      ? startTicks
      : null,
  };
}

/**
 * Field 22 of `/proc/<pid>/stat`: the process's start time, in clock ticks since boot.
 *
 * The comm field is parenthesised and may itself contain spaces and parentheses, so the split
 * starts after the last `)`. Fields 1 and 2 are dropped by that slice, which puts field 22 at
 * index 19.
 */
export function parseProcessStartTicks(raw) {
  if (typeof raw !== "string") return null;
  const closing = raw.lastIndexOf(")");
  if (closing < 0) return null;
  const fields = raw.slice(closing + 1).trim().split(/\s+/u);
  const ticks = Number(fields[19]);
  return Number.isFinite(ticks) ? ticks : null;
}

/**
 * What one attempt to read `/proc/<pid>/stat` established: `running`, `absent`, or `unreadable`.
 *
 * Three states rather than two, because "there is no such process" and "I was not allowed to look"
 * are different facts and only the first is evidence of absence. A host with `hidepid=1`/`2` or
 * systemd's `ProtectProc=` refuses a run access to processes owned by other users; folding that
 * refusal into "gone" hands the sweep the one answer that authorises removing a privileged
 * container, in the case where the container belongs to another user's live run.
 *
 * A stat that was read but could not be parsed is `unreadable` for the same reason: the entry
 * exists, so calling the process gone would be a positive claim made out of a failure to
 * understand.
 */
export function interpretProcStatRead({ contents = null, error = null } = {}) {
  if (error) {
    const code = typeof error === "object" && error !== null ? error.code : null;
    // ENOENT is the kernel saying no such pid. Everything else — EACCES, EPERM, an unmounted
    // /proc, an I/O error — is this run failing to see, which is not the same observation.
    return code === "ENOENT"
      ? { state: "absent", startTicks: null }
      : { state: "unreadable", startTicks: null };
  }
  const startTicks = parseProcessStartTicks(contents);
  return startTicks === null
    ? { state: "unreadable", startTicks: null }
    : { state: "running", startTicks };
}

/**
 * `"alive" | "pid-held" | "gone" | "unknown"` for a creator identity already known to share this
 * boot and pid namespace.
 *
 * Two independent observations, because neither alone can be trusted with the answer that
 * authorises a removal:
 *
 * - `statRead` is `/proc/<pid>/stat`, which is the only thing that can tell the creator from a
 *   later process wearing its pid — but which a filtered `/proc` can make look empty.
 * - `signalRead` is `kill(pid, 0)`, which no `hidepid=` or `ProtectProc=` setting suppresses, and
 *   which can therefore contradict an absence. It cannot identify a process, only report that
 *   something holds the number.
 *
 * So `"gone"` comes from exactly two places: a stat that names a *different* start time, and an
 * absence that the signal probe independently confirms. A missing stat on its own never gets there.
 *
 * `"alive"` and `"pid-held"` both spare the resource, and they are separate answers because they
 * are separate facts. `"alive"` is the creator itself, identified: this boot, this namespace, this
 * pid, and a start time equal to the one stamped on the container. `"pid-held"` is only that
 * *something* holds that pid number while the stat could not be compared — a filtered `/proc`, or
 * an identity written without start ticks. Sparing on that is right, but reporting it as the
 * creator being alive asserts an identity the run never established, so the caller can keep the
 * two apart in what it writes down.
 *
 * A held pid whose start time could not be compared spares rather than returning `"unknown"`. The
 * difference matters: `"unknown"` sends the resource to the age rule, which condemns anything past
 * the bound, so a peer's run lasting longer than that would still lose its container on a host
 * where `/proc` is filtered. The cost of sparing is that debris on such a host waits for a run that
 * can read the stat; the cost of the alternative is a destroyed peer.
 */
export function judgeCreatorProcess({
  identity = null,
  statRead = null,
  signalRead = "unknown",
} = {}) {
  const observed = statRead ?? { state: "unreadable", startTicks: null };
  const expected =
    typeof identity?.startTicks === "number" ? identity.startTicks : null;
  if (observed.state === "running" && expected !== null) {
    return observed.startTicks === expected ? "alive" : "gone";
  }
  if (signalRead === "held") return "pid-held";
  if (observed.state === "absent" && signalRead === "absent") return "gone";
  return "unknown";
}

/** Docker names an anonymous volume with 64 hex characters; a named volume never looks like this. */
export const ANONYMOUS_VOLUME_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * The anonymous volumes among a container's mounts.
 *
 * `docker rm --volumes` removes only these, so these are the only ones a removal may claim to have
 * taken — and the only ones whose survival is worth failing a run over.
 */
export function anonymousVolumeNames(volumes = []) {
  return volumes.filter(
    (name) => typeof name === "string" && ANONYMOUS_VOLUME_PATTERN.test(name),
  );
}

/** Docker's answer when the name it was given is not on this daemon at all. */
const NO_SUCH_CONTAINER = /No such (?:object|container)/iu;

/**
 * What `docker container inspect` established about a container's mounts, as a fact rather than as
 * a list: `enumerated`, `container-absent`, or `unknown`.
 *
 * The bare empty array is a claim — "this container carries no volumes" — and it is the claim that
 * authorises removing the container with `--volumes` and recording nothing. A non-zero exit or a
 * timeout is a different observation entirely, and returning `[]` for it is how a thirty-second
 * timeout came to be indistinguishable from a container with nothing attached, with anonymous
 * volumes deleted that no artifact ever named.
 *
 * `container-absent` is split out from the other failures because collapsing the two makes the
 * caller say two false things at once. A container that vanished between being listed and being
 * inspected — a concurrent run sweeping the same debris, a manual `docker rm`, an exited `--rm`
 * husk autoreaped — is not an unenumerable unknown: the enumeration question no longer has a
 * subject. Treating it as one produced "it was removed without --volumes, so any anonymous volume
 * it held is still on <context>", of which both halves are untrue — this run removed nothing, and
 * whoever did remove it may well have passed `--volumes`. `docker rm --force` then exits 0 on the
 * missing name, so the run also recorded a removal it did not perform. The caller needs to be able
 * to say nothing at all here, and this state is what lets it.
 */
export function interpretMountInspect({
  code = null,
  stdout = "",
  stderr = "",
  timedOut = false,
} = {}) {
  if (timedOut) {
    return {
      state: "unknown",
      volumes: [],
      reason: "docker container inspect timed out",
    };
  }
  if (code !== 0) {
    const detail = typeof stderr === "string" ? stderr.trim() : "";
    if (NO_SUCH_CONTAINER.test(detail)) {
      return {
        state: "container-absent",
        volumes: [],
        reason: detail,
      };
    }
    return {
      state: "unknown",
      volumes: [],
      reason: detail || `docker container inspect exited ${code}`,
    };
  }
  return {
    state: "enumerated",
    volumes: String(stdout)
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean),
    reason: null,
  };
}

/**
 * Whether an observed acceptance resource may belong to a run that is still going.
 *
 * The whole sweep turns on this one question, so the order of the answers is the order of their
 * certainty:
 *
 * 1. The creator identity was written by this kernel boot and this pid namespace, so the pid in it
 *    means here what it meant there. A probe that finds that exact process still running is the
 *    only positive proof of liveness available, and a probe that finds it gone is proof of debris
 *    — which is what lets a killed run's container be swept seconds later rather than after a
 *    timeout.
 * 2. Anything else — no identity, an identity from another boot or another namespace, a probe that
 *    cannot decide — falls back to age. Age cannot prove liveness; it only bounds how long a live
 *    run could plausibly have been running, so it is used to spare, never to condemn quickly.
 *
 * Ties go to sparing throughout. Leaving debris costs a later run one sweep; removing a live run's
 * privileged daemon destroys that run and blames it for the wreckage.
 */
export function judgeResourceLiveness({
  creator = null,
  ageMs = null,
  local = {},
  minAgeMs = ORPHAN_MIN_AGE_MS,
  probeCreator = () => "unknown",
} = {}) {
  const identity = parseCreatorIdentity(creator);
  const comparable =
    identity !== null &&
    typeof local.bootId === "string" &&
    local.bootId.length > 0 &&
    identity.bootId === local.bootId &&
    identity.pidNamespace === (local.pidNamespace ?? null);
  if (comparable) {
    const verdict = probeCreator(identity);
    // Two sparing verdicts, kept apart all the way into the artifact: `creator-process-alive` is
    // the creating process identified by its start time, `creator-pid-held` is only that the pid
    // number is taken while the stat could not be compared. Both leave the resource alone; only
    // the first is a statement about whose resource it is.
    if (verdict === "alive") {
      return { possiblyLive: true, reason: "creator-process-alive" };
    }
    if (verdict === "pid-held") {
      return { possiblyLive: true, reason: "creator-pid-held" };
    }
    if (verdict === "gone") {
      return { possiblyLive: false, reason: "creator-process-gone" };
    }
  }
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs)) {
    return { possiblyLive: true, reason: "age-unknown" };
  }
  return ageMs < minAgeMs
    ? { possiblyLive: true, reason: "younger-than-min-age" }
    : { possiblyLive: false, reason: "older-than-min-age" };
}

/**
 * Splits observed names into "debris from an earlier run", "may belong to a live run", and
 * "not ours".
 *
 * `activeSuffix` is excluded because the caller runs this while its own resources exist; without
 * that exclusion the preflight would sweep the run that invoked it.
 *
 * `liveSuffixes` is the same protection extended to everybody else's runs. It is the caller's job
 * to decide which suffixes those are — that needs a daemon and a process table, which this module
 * deliberately does not have — but the separation happens here so that both the preflight and the
 * final host check partition the same names the same way. A resource in `possiblyLive` is not
 * swept and is not counted against the host being clear; it is somebody's, and the artifact says
 * so by name.
 */
export function classifyOrphans({
  containerNames = [],
  contextNames = [],
  scratchNames = [],
  activeSuffix = null,
  liveSuffixes = [],
} = {}) {
  const live = new Set(liveSuffixes);
  const split = (names, pattern) => {
    const orphans = [];
    const spared = [];
    for (const name of names) {
      const suffix = suffixOf(name, pattern);
      if (suffix === null || suffix === activeSuffix) continue;
      (live.has(suffix) ? spared : orphans).push(name);
    }
    return { orphans, spared };
  };

  const containers = split(containerNames, ACCEPTANCE_RESOURCE_PATTERN);
  const contexts = split(contextNames, ACCEPTANCE_RESOURCE_PATTERN);
  const scratch = split(scratchNames, SCRATCH_DIRECTORY_PATTERN);

  return {
    containers: containers.orphans,
    contexts: contexts.orphans,
    scratchDirectories: scratch.orphans,
    possiblyLive: {
      containers: containers.spared,
      contexts: contexts.spared,
      scratchDirectories: scratch.spared,
    },
  };
}
