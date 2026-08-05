// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ENGINE_RESOURCES } from "../data/fixtures";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { EngineResources, SystemSnapshot } from "../types";
import { DashboardScreen } from "./DashboardScreen";

function createFixtureStore(
  resources: Partial<EngineResources> = {},
): AnchorageStore {
  return {
    isHost: false,
    containers: [{ id: "a" }, { id: "b" }],
    runningCount: 1,
    stoppedCount: 1,
    engineCpu: 42.4,
    engineMemory: 6,
    resources: { ...DEFAULT_ENGINE_RESOURCES, ...resources },
    composeStatus: "unavailable",
    composeProjectList: [],
    cleanUpImages: vi.fn(async () => undefined),
    pruneSystem: vi.fn(async () => undefined),
    openCommandCenter: vi.fn(),
    navigate: vi.fn(),
  } as unknown as AnchorageStore;
}

function createHostStore(
  overrides: Partial<AnchorageStore> = {},
): AnchorageStore {
  const bucket = {
    sizeBytes: 0,
    reclaimableBytes: 0,
    activeCount: 0,
    totalCount: 0,
  };
  const snapshot = {
    apiVersion: "1.45",
    observedAt: "2026-01-01T00:00:00.000Z",
    limitations: [],
    engine: {
      containers: 2,
      containersRunning: 1,
      containersStopped: 1,
      containersPaused: 0,
      cpus: 8,
      memoryBytes: 16 * 1024 ** 3,
      architecture: "x86_64",
      serverVersion: "27.0.0",
      apiVersion: "1.45",
    },
    diskUsage: {
      layersSizeBytes: 0,
      builderSizeBytes: 0,
      summary: {
        images: bucket,
        containers: bucket,
        volumes: bucket,
        buildCache: bucket,
      },
    },
  } as unknown as SystemSnapshot;

  return {
    isHost: true,
    engineCpu: 12,
    engineMemory: 3.4,
    engineHistory: { cpu: [], memory: [] },
    dockerContext: "default",
    systemSnapshot: snapshot,
    systemPrunePending: false,
    systemPruneResult: null,
    hostDomainState: { snapshot: { status: "ready", error: null } },
    refreshCompose: vi.fn(async () => undefined),
    openCommandCenter: vi.fn(),
      ...overrides,
  } as unknown as AnchorageStore;
}

afterEach(cleanup);

describe("DashboardScreen resource binding", () => {
  it("states the allocation from the resource settings, not a fixed 8/16", () => {
    render(<DashboardScreen store={createFixtureStore()} />);

    expect(screen.getByText("of 8 cores")).toBeInTheDocument();
    expect(screen.getByText("GB / 16 GB")).toBeInTheDocument();
  });

  it("follows the resource settings when they move", () => {
    render(
      <DashboardScreen
        store={createFixtureStore({ cpus: 12, memoryGb: 24 })}
      />,
    );

    expect(screen.getByText("of 12 cores")).toBeInTheDocument();
    expect(screen.getByText("GB / 24 GB")).toBeInTheDocument();
    expect(
      screen.getByText(/Local engine · linux\/amd64 · 12 CPUs · 24 GB allocated/),
    ).toBeInTheDocument();
  });

  it("scales the memory bar against the allocated memory", () => {
    const { container } = render(
      <DashboardScreen
        store={createFixtureStore({ memoryGb: 24 })}
      />,
    );

    // engineMemory 6 GB of 24 GB allocated.
    const memoryBar = container.querySelector(
      ".dashboard-tone--violet .dashboard-progress span",
    );
    expect(memoryBar).toHaveStyle({ width: "25%" });
  });
});

describe("DashboardScreen action labels", () => {
  it("prunes across all three domains behind the label the design specifies", async () => {
    // The button previously called an images-only handler, so it had to be relabelled to the
    // narrower verb. The fix was to widen the action, not to narrow the words: fixture mode
    // now reclaims images, stopped containers and unused volumes like a real system prune.
    const store = createFixtureStore();
    render(<DashboardScreen store={store} />);

    const prune = screen.getByRole("button", { name: "Prune system" });
    fireEvent.click(prune);
    expect(store.pruneSystem).toHaveBeenCalled();
    expect(store.cleanUpImages).not.toHaveBeenCalled();
  });

  it("labels the host action as the system prune it opens", () => {
    render(<DashboardScreen store={createHostStore()} />);

    expect(screen.getByTestId("system-prune-open")).toHaveTextContent(
      "Prune system",
    );
  });
});
describe("DashboardScreen engine history", () => {
  it("says it is collecting rather than drawing a series it does not have", () => {
    // The Engine keeps no aggregate history, so there is nothing to backfill. A chart of
    // invented zeroes would read as an idle engine that was never observed.
    render(<DashboardScreen store={createHostStore({ engineHistory: { cpu: [], memory: [] } })} />);

    expect(screen.getByText(/Collecting samples/u)).toBeInTheDocument();
    expect(document.querySelector(".dashboard-bars")).toBeNull();
  });

  it("draws the charts once real samples have accumulated", () => {
    render(
      <DashboardScreen
        store={createHostStore({
          engineHistory: { cpu: [4, 9, 12], memory: [1.1, 1.4, 1.6] },
        })}
      />,
    );

    expect(document.querySelectorAll(".dashboard-bars")).toHaveLength(2);
    expect(screen.getByText("3 samples")).toBeInTheDocument();
  });
});


/**
 * Quick reclaim actions must not become a quick way to lose data.
 *
 * `docker system prune` is irreversible, and with `--volumes` it removes data no registry can
 * rebuild. The shortcuts save the operator ticking a box; they must not save them the sentence
 * explaining what is about to go, and nothing here may reach the daemon without confirmation.
 */
describe("DashboardScreen reclaim shortcuts", () => {
  const renderHost = () => {
    const store = createHostStore({ pruneSystem: vi.fn(async () => undefined) });
    render(<DashboardScreen store={store} />);
    return store;
  };

  it("opens the confirmation rather than pruning on click", () => {
    const store = renderHost();
    fireEvent.click(screen.getByTestId("reclaim-dangling"));
    expect(screen.getByTestId("system-prune-preview")).toBeInTheDocument();
    expect(store.pruneSystem).not.toHaveBeenCalled();
  });

  it("preselects tagged images for the shortcut that says it removes them", () => {
    renderHost();
    fireEvent.click(screen.getByTestId("reclaim-all-images"));
    expect(screen.getByTestId("system-prune-all")).toBeChecked();
    expect(screen.getByTestId("system-prune-volumes")).not.toBeChecked();
  });

  it("offers no shortcut that removes volumes", () => {
    // The one destructive choice stays deliberate: no shortcut reaches it, and the one that
    // mentions volumes does so only to say they are excluded.
    renderHost();
    const buttons = Array.from(
      screen.getByTestId("dashboard-reclaim-actions").querySelectorAll("button"),
    );
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.textContent ?? "").not.toMatch(/volume/i);
    }
    fireEvent.click(screen.getByTestId("reclaim-dangling"));
    expect(screen.getByTestId("system-prune-volumes")).not.toBeChecked();
  });
});
