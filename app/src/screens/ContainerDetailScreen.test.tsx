// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    killContainer: vi.fn(async () => undefined),
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

/**
 * A read-only tab that cannot read has to say so.
 *
 * `docker top` answers 409 for a container that is not running, and the tab strip does not gate
 * on state, so this is an ordinary path rather than an edge case. Both loaders used to discard
 * the rejection, which left the loading message on screen permanently — a refusal that read as
 * a hang, and the only detail tabs with no terminal state.
 */
function renderTab(
  detailTab: "processes" | "changes",
  detailErrors: Record<string, string> = {},
) {
  const store = {
    isHost: true,
    selectedContainer: container(),
    detailTab,
    pendingIds: new Set<string>(),
    logsByContainer: {},
    inspectByContainer: {},
    mountsByContainer: {},
    containers: [],
    bridge: { containers: { mounts: vi.fn(async () => ({ mounts: [] })) } },
    dockerContext: "default",
    selectedInspect: null,
    selectedDetailErrors: detailErrors,
    processes: null,
    changes: null,
    imageTransfer: null,
    openCommandCenter: vi.fn(),
    setDetailTab: vi.fn(),
    clearSelection: vi.fn(),
  } as unknown as AnchorageStore;
  render(<ContainerDetailScreen store={store} />);
  return store;
}

describe("ContainerDetailScreen read-only tab failures", () => {
  it("reports why the process list could not be read", () => {
    renderTab("processes", {
      processes: "Docker Engine rejected the process list request.",
    });
    expect(
      screen.getByText("Docker Engine rejected the process list request."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Reading container processes/u)).toBeNull();
  });

  it("reports why the filesystem changes could not be read", () => {
    renderTab("changes", {
      changes: "Docker Engine rejected the filesystem changes request.",
    });
    expect(
      screen.getByText("Docker Engine rejected the filesystem changes request."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Reading filesystem changes/u)).toBeNull();
  });

  it("still shows the loading message while a read is genuinely in flight", () => {
    renderTab("processes");
    expect(screen.getByText(/Reading container processes/u)).toBeInTheDocument();
  });
});

/**
 * The Resources dialog has to distinguish "leave it alone" from Docker's `no` policy.
 *
 * They shared the value `"no"`, so the option an operator picks to stop a container restarting
 * was indistinguishable from an untouched field and was dropped before the patch was built.
 * The core has always accepted both — `allowedRestartPolicies` in core/internal/core/domain.go
 * lists `""` and `"no"` separately.
 */
function renderLimits() {
  const store = {
    isHost: true,
    selectedContainer: container(),
    detailTab: "mounts",
    pendingIds: new Set<string>(),
    logsByContainer: {},
    inspectByContainer: {},
    mountsByContainer: {},
    containers: [],
    bridge: { containers: { mounts: vi.fn(async () => ({ mounts: [] })) } },
    dockerContext: "default",
    selectedInspect: null,
    selectedDetailErrors: {},
    imageTransfer: null,
    updateContainer: vi.fn(async () => undefined),
    setDetailTab: vi.fn(),
    clearSelection: vi.fn(),
  } as unknown as AnchorageStore;
  render(<ContainerDetailScreen store={store} />);
  fireEvent.click(screen.getByTestId("container-limits-open"));
  return store;
}

describe("ContainerDetailScreen resources dialog", () => {
  it("sends Docker's `no` policy when it is chosen", () => {
    const store = renderLimits();
    fireEvent.change(screen.getByTestId("container-limits-restart"), {
      target: { value: "no" },
    });
    fireEvent.click(screen.getByTestId("container-limits-apply"));
    expect(store.updateContainer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "abc123def456" }),
      { restartPolicy: "no" },
    );
  });

  it("cannot be applied while nothing has been changed", () => {
    const store = renderLimits();
    expect(screen.getByTestId("container-limits-apply")).toBeDisabled();
    fireEvent.click(screen.getByTestId("container-limits-apply"));
    // `docker update` with no flags is a usage error, so this must not reach the daemon.
    expect(store.updateContainer).not.toHaveBeenCalled();
  });

  it("becomes applicable once a memory limit is entered", () => {
    renderLimits();
    fireEvent.change(screen.getByTestId("container-limits-memory"), {
      target: { value: "512" },
    });
    expect(screen.getByTestId("container-limits-apply")).toBeEnabled();
  });
});

/**
 * A paused container's primary button has to say what pressing it does.
 *
 * `primaryContainerAction` returns `unpause`, the handler acts on it, and the disabled binding
 * treats it as available — but the label fell through to "Unavailable". The result was an
 * enabled button reading "Unavailable" that resumed the container, which is worse than an
 * absent control: it contradicts itself and the operator has no reason to press it.
 */
describe("ContainerDetailScreen primary action label", () => {
  it("offers to resume a paused container rather than calling it unavailable", () => {
    renderDetail({ state: "paused", rawState: "paused", status: "Paused" });
    const button = screen.getByRole("button", { name: "Resume" });
    expect(button).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Unavailable" })).toBeNull();
  });

  it("still says Stop for a serving container and Start for a stopped one", () => {
    renderDetail({ state: "running", rawState: "running", status: "Up 2 hours" });
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    cleanup();
    renderDetail();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });
});

/**
 * Kill was wired the whole way down and never reachable.
 *
 * The store's killContainer, the bridge method, the IPC channel, its contract validator and the
 * core verb all existed; no surface called any of them, while the README listed kill among the
 * things you can do. It is offered only in the states the store will act on, because a control
 * that resolves without doing anything is worse than an absent one.
 */
describe("ContainerDetailScreen kill", () => {
  it("offers kill while the container is running", () => {
    renderDetail({ state: "running", rawState: "running", status: "Up 2 hours" });
    expect(screen.getByTestId("container-kill")).toBeInTheDocument();
  });

  it("does not offer kill for a container that is already stopped", () => {
    renderDetail();
    expect(screen.queryByTestId("container-kill")).toBeNull();
  });

  it("confirms before sending SIGKILL, and says what SIGKILL means", () => {
    const store = renderDetail({
      state: "running",
      rawState: "running",
      status: "Up 2 hours",
    });

    fireEvent.click(screen.getByTestId("container-kill"));
    expect(screen.getByTestId("container-kill-dialog")).toHaveTextContent(
      "cannot be caught or ignored",
    );
    expect(store.killContainer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("container-kill-confirm"));
    expect(store.killContainer).toHaveBeenCalledWith(store.selectedContainer);
  });
});
