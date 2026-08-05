import { describe, expect, it } from "vitest";
import type {
  AnchorageContainer,
  ContainerState,
} from "../types";
import {
  canKillContainer,
  canOfferRemove,
  canPauseContainer,
  canRemoveContainer,
  canRestartContainer,
  primaryContainerAction,
  removeUnavailableReason,
  requiresForceRemove,
  statusDetail,
  statusKind,
  statusLabel,
} from "./containerPresentation";

const container = (
  state: ContainerState,
  {
    status = "",
    exitCode = null,
    health = "—",
  }: {
    status?: string;
    exitCode?: number | null;
    health?: AnchorageContainer["health"];
  } = {},
): AnchorageContainer => ({
  id: state,
  name: state,
  image: "alpine:3.20",
  ports: "—",
  state,
  rawState: state,
  status,
  exitCode,
  kind: "container",
  cpu: null,
  memory: null,
  memoryLimit: null,
  health,
  cpuHistory: [],
  memoryHistory: [],
  labels: {},
  composeProject: null,
});

describe("Docker container presentation and action eligibility", () => {
  it.each([
    ["created", "Created", "stopped", "start", false, true],
    ["running", "Running", "running", "stop", true, false],
    // Paused used to expose no primary action at all, which combined with a disabled
    // delete button made it an unmanageable dead end.
    ["paused", "Paused", "transition", "unpause", true, false],
    ["restarting", "Restarting", "transition", "stop", false, false],
    ["removing", "Removing", "transition", null, false, false],
    ["pulling", "Pulling", "pulling", null, false, false],
    ["exited", "Exited (137)", "stopped", "start", true, true],
    ["dead", "Dead", "stopped", null, false, true],
    ["unknown", "Unknown (unknown)", "stopped", null, false, false],
  ] as const)(
    "keeps %s distinct and exposes only truthful actions",
    (state, label, kind, primary, restart, remove) => {
      const subject = container(state, {
        exitCode: state === "exited" ? 137 : null,
      });
      expect(statusLabel(subject)).toBe(label);
      expect(statusKind(subject)).toBe(kind);
      expect(primaryContainerAction(subject)).toBe(primary);
      expect(canRestartContainer(subject)).toBe(restart);
      expect(canRemoveContainer(subject)).toBe(remove);
    },
  );

  it("does not paint in-transition states in the pull hue", () => {
    for (const state of ["paused", "restarting", "removing"] as const) {
      expect(statusKind(container(state))).not.toBe("pulling");
    }
    expect(statusKind(container("pulling"))).toBe("pulling");
  });

  it("groups an unhealthy running container away from a healthy one", () => {
    expect(statusKind(container("running", { health: "unhealthy" }))).toBe(
      "unhealthy",
    );
    expect(statusKind(container("running", { health: "healthy" }))).toBe(
      "running",
    );
  });

  it.each([
    ["created", false, false, true],
    ["running", true, true, true],
    ["paused", false, true, true],
    ["restarting", false, true, true],
    ["removing", false, false, false],
    ["exited", false, false, true],
    ["dead", false, false, true],
    ["unknown", false, false, false],
  ] as const)(
    "offers pause, kill and force-remove for %s only where Docker accepts them",
    (state, pause, kill, offerRemove) => {
      const subject = container(state);
      expect(canPauseContainer(subject)).toBe(pause);
      expect(canKillContainer(subject)).toBe(kill);
      expect(canOfferRemove(subject)).toBe(offerRemove);
    },
  );

  it("explains why removal is unavailable instead of silently disabling", () => {
    expect(removeUnavailableReason(container("running"))).toBeNull();
    expect(removeUnavailableReason(container("removing"))).toBe(
      "Already being removed",
    );
    expect(removeUnavailableReason(container("unknown"))).toMatch(
      /Cannot remove a container in the unknown state/u,
    );
  });

  it("requires force only for containers with a live process", () => {
    expect(requiresForceRemove(container("running"))).toBe(true);
    expect(requiresForceRemove(container("paused"))).toBe(true);
    expect(requiresForceRemove(container("exited"))).toBe(false);
  });

  it("keeps the chip on the vocabulary rather than the daemon's sentence", () => {
    // The real exit code still survives: the chip reports 137, not the spec's hardcoded 0.
    expect(
      statusLabel(
        container("exited", {
          status: "Exited (137) 12 seconds ago",
          exitCode: 137,
        }),
      ),
    ).toBe("Exited (137)");
    expect(
      statusLabel(container("running", { status: "Up 3 minutes (healthy)" })),
    ).toBe("Running");
  });

  it("keeps the daemon's sentence available as tooltip detail", () => {
    expect(
      statusDetail(container("running", { status: "Up 3 minutes (healthy)" })),
    ).toBe("Up 3 minutes (healthy)");
    expect(
      statusDetail(
        container("exited", {
          status: "Exited (137) 12 seconds ago",
          exitCode: 137,
        }),
      ),
    ).toBe("Exited (137) 12 seconds ago");
    // Nothing to add in fixture mode, or when the daemon only repeats the chip.
    expect(statusDetail(container("running"))).toBeNull();
    expect(statusDetail(container("running", { status: " Running " }))).toBeNull();
  });

  it("prioritizes unhealthy health over a generic running status", () => {
    expect(
      statusLabel(
        container("running", {
          health: "unhealthy",
          status: "Running",
        }),
      ),
    ).toBe("Unhealthy");
  });
});
