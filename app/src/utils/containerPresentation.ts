import type { AnchorageContainer } from "../types";

export type StatusKind =
  | "running"
  | "unhealthy"
  | "stopped"
  | "pulling"
  | "transition";

export function statusKind(container: AnchorageContainer): StatusKind {
  if (container.state === "pulling") return "pulling";
  // Distinct from `pulling`: painting "Paused" in the pull hue said a download was in flight.
  if (
    container.state === "paused" ||
    container.state === "restarting" ||
    container.state === "removing"
  ) {
    return "transition";
  }
  if (
    container.state === "stopped" ||
    container.state === "created" ||
    container.state === "exited" ||
    container.state === "dead" ||
    container.state === "unknown"
  ) {
    return "stopped";
  }
  if (container.health === "unhealthy") return "unhealthy";
  return "running";
}

/**
 * The chip vocabulary, never the daemon's own sentence: in host mode `container.status` is
 * prose like "Up 3 minutes (healthy)" or "Exited (137) 12 seconds ago", and the chip is sized
 * for one or two words. The raw sentence stays reachable through `statusDetail`.
 */
export function statusLabel(container: AnchorageContainer) {
  if (
    container.state === "running" &&
    container.health === "unhealthy"
  ) {
    return "Unhealthy";
  }
  if (container.state === "pulling") return "Pulling";
  if (container.state === "created") return "Created";
  if (container.state === "paused") return "Paused";
  if (container.state === "restarting") return "Restarting";
  if (container.state === "removing") return "Removing";
  if (container.state === "dead") return "Dead";
  if (container.state === "exited" || container.state === "stopped") {
    return container.exitCode === null
      ? "Exited"
      : `Exited (${container.exitCode})`;
  }
  if (container.state === "unknown") {
    return container.rawState ? `Unknown (${container.rawState})` : "Unknown";
  }
  return "Running";
}

/**
 * The daemon's own status sentence, for a title/tooltip beside the chip. Null when it is
 * absent (fixture mode) or says nothing the chip does not already say.
 */
export function statusDetail(container: AnchorageContainer): string | null {
  const raw = container.status.trim();
  if (!raw || raw === statusLabel(container)) return null;
  return raw;
}

export function formatMemory(value: number) {
  return value >= 1024
    ? `${(value / 1024).toFixed(2)} GB`
    : `${Math.round(value)} MB`;
}

export function cpuTone(value: number | null) {
  if (value === null) return "neutral";
  if (value > 70) return "danger";
  if (value > 40) return "warning";
  return "neutral";
}

export type ContainerPrimaryAction = "start" | "stop" | "unpause" | null;

/**
 * A paused container used to return null here, which combined with a disabled delete button
 * made it a complete dead end in the UI: the only offered action was Restart.
 */
export function primaryContainerAction(
  container: AnchorageContainer,
): ContainerPrimaryAction {
  if (container.state === "running" || container.state === "restarting") {
    return "stop";
  }
  if (container.state === "paused") return "unpause";
  if (
    container.state === "created" ||
    container.state === "exited" ||
    container.state === "stopped"
  ) {
    return "start";
  }
  return null;
}

/** Pause is offered only where Docker accepts it. */
export function canPauseContainer(container: AnchorageContainer): boolean {
  return container.state === "running";
}

/** `docker kill` applies to anything with a live process. */
export function canKillContainer(container: AnchorageContainer): boolean {
  return ["running", "paused", "restarting"].includes(container.state);
}

export function canRestartContainer(container: AnchorageContainer): boolean {
  return [
    "running",
    "paused",
    "exited",
    "stopped",
  ].includes(container.state);
}

/**
 * States Docker can remove without `--force`.
 */
export function canRemoveContainer(container: AnchorageContainer): boolean {
  return ["created", "exited", "dead", "stopped"].includes(container.state);
}

/**
 * States that need `docker rm --force`. Docker removes a running, paused or restarting
 * container by killing it first, so these are offered — with force made explicit in the
 * confirmation — rather than left as a disabled control with no explanation.
 */
export function requiresForceRemove(container: AnchorageContainer): boolean {
  return ["running", "paused", "restarting"].includes(container.state);
}

/**
 * Whether removal can be offered at all. `removing` is already in progress and `unknown`
 * means the daemon gave us a state we cannot reason about, so both stay unavailable.
 */
export function canOfferRemove(container: AnchorageContainer): boolean {
  return canRemoveContainer(container) || requiresForceRemove(container);
}

/**
 * Why the remove control is unavailable, for the button's title/tooltip. A disabled
 * destructive control with no explanation is worse than no control.
 */
export function removeUnavailableReason(
  container: AnchorageContainer,
): string | null {
  if (canOfferRemove(container)) return null;
  if (container.state === "removing") return "Already being removed";
  return `Cannot remove a container in the ${container.state} state`;
}
