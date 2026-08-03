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
    ["created", "Created", "start", false, true],
    ["running", "Running", "stop", true, false],
    // Paused used to expose no primary action at all, which combined with a disabled
    // delete button made it an unmanageable dead end.
    ["paused", "Paused", "unpause", true, false],
    ["restarting", "Restarting", "stop", false, false],
    ["removing", "Removing", null, false, false],
    ["exited", "Exited (137)", "start", true, true],
    ["dead", "Dead", null, false, true],
    ["unknown", "Unknown (unknown)", null, false, false],
  ] as const)(
    "keeps %s distinct and exposes only truthful actions",
    (state, label, primary, restart, remove) => {
      const subject = container(state, {
        exitCode: state === "exited" ? 137 : null,
      });
      expect(statusLabel(subject)).toBe(label);
      expect(primaryContainerAction(subject)).toBe(primary);
      expect(canRestartContainer(subject)).toBe(restart);
      expect(canRemoveContainer(subject)).toBe(remove);
    },
  );

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

  it("preserves the daemon's raw status text and non-zero exit code", () => {
    expect(
      statusLabel(
        container("exited", {
          status: "Exited (137) 12 seconds ago",
          exitCode: 137,
        }),
      ),
    ).toBe("Exited (137) 12 seconds ago");
    expect(
      statusLabel(container("running", { status: "Up 3 minutes (healthy)" })),
    ).toBe("Up 3 minutes (healthy)");
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
