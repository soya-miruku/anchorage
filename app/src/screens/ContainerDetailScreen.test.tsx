// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContainerDetailScreen } from "./ContainerDetailScreen";
import type { AnchorageContainer } from "../types";
import type { AnchorageStore } from "../store/useAnchorageStore";

afterEach(cleanup);

/**
 * Republishing ports replaces the container, so it is offered only when nothing is being served.
 *
 * "Running" is the wrong test on its own: a paused container is running by Docker's reckoning,
 * but its processes are frozen and it answers nothing, so replacing it interrupts no traffic.
 * A container that is actually serving must not be replaceable from here — the core refuses it
 * as well, but an affordance that leads to a refusal is a worse experience than no affordance.
 */
const container = (overrides: Partial<AnchorageContainer> = {}): AnchorageContainer =>
  ({
    id: "abc123def456",
    name: "api",
    image: "nginx:1.27",
    ports: "8080:80/tcp",
    state: "stopped",
    rawState: "exited",
    status: "Exited (0)",
    exitCode: 0,
    kind: "http",
    health: "—",
    cpu: 0,
    memory: 0,
    memoryLimit: 0,
    cpuHistory: [],
    memoryHistory: [],
    labels: {},
    composeProject: null,
    ...overrides,
  }) as unknown as AnchorageContainer;

function renderDetail(overrides: Partial<AnchorageContainer> = {}, isHost = true) {
  const store = {
    isHost,
    selectedContainer: container(overrides),
    detailTab: "mounts",
    pendingIds: new Set<string>(),
    logsByContainer: {},
    inspectByContainer: {},
    mountsByContainer: {},
    containers: [],
    // The header is what is under test; the panels below it only need a bridge to exist.
    bridge: {
      containers: {
        mounts: vi.fn(async () => ({ mounts: [] })),
        inspect: vi.fn(async () => ({})),
        logs: vi.fn(async () => ({ lines: [] })),
      },
    },
    dockerContext: "default",
    selectedInspect: null,
    selectedDetailErrors: {},
    imageTransfer: null,
    rebindPorts: vi.fn(async () => undefined),
    renameContainer: vi.fn(async () => undefined),
    toggleContainer: vi.fn(async () => undefined),
    restartContainer: vi.fn(async () => undefined),
    setDetailTab: vi.fn(),
    clearSelection: vi.fn(),
  } as unknown as AnchorageStore;
  render(<ContainerDetailScreen store={store} />);
  return store;
}

describe("ContainerDetailScreen port republishing", () => {
  it("offers it for a stopped container", () => {
    renderDetail();
    expect(screen.getByTestId("detail-rebind-ports")).toBeInTheDocument();
  });

  it("offers it for a paused container, whose processes are frozen", () => {
    renderDetail({ state: "running", rawState: "paused", status: "Paused" });
    expect(screen.getByTestId("detail-rebind-ports")).toBeInTheDocument();
  });

  it("does not offer it while the container is serving", () => {
    renderDetail({ state: "running", rawState: "running", status: "Up 2 hours" });
    expect(screen.queryByTestId("detail-rebind-ports")).toBeNull();
  });

  it("does not offer it in the browser preview, which has no daemon to recreate against", () => {
    renderDetail({}, false);
    expect(screen.queryByTestId("detail-rebind-ports")).toBeNull();
  });
});
