// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContainersScreen } from "./ContainersScreen";
import type { AnchorageStore } from "../store/useAnchorageStore";

afterEach(cleanup);

function renderContainers(overrides: Partial<AnchorageStore> = {}) {
  const store = {
    isHost: false,
    containers: [],
    filteredContainers: [],
    composeProjects: [],
    composeFilter: null,
    onlyRunning: false,
    runningCount: 0,
    stoppedCount: 0,
    selectedContainerIds: new Set<string>(),
    pendingIds: new Set<string>(),
    containerCreatePending: false,
    ...overrides,
  } as unknown as AnchorageStore;
  return render(<ContainersScreen store={store} />);
}

describe("ContainersScreen isolation posture", () => {
  it("says what a container boundary is not", () => {
    renderContainers();

    const posture = screen.getByTestId("containers-isolation-posture");
    expect(posture).toHaveTextContent(/one kernel/);
    expect(posture).toHaveTextContent(
      /process boundary, not a security boundary/,
    );
    expect(posture).toHaveTextContent(/Docker socket/);
  });

  it("stands with the header rather than waiting for a container to exist", () => {
    renderContainers();

    expect(screen.getByTestId("containers-empty-state")).toBeInTheDocument();
    expect(
      screen.getByTestId("containers-isolation-posture"),
    ).toBeInTheDocument();
  });
});
