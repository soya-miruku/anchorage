// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { App } from "./App";
import { createFixtureCapabilities } from "./data/commandFixtures";
import type { HostAnchorageApi } from "./types";

const observedAt = "2026-08-02T12:00:00.000Z";

const container = (index: number, name = `container-${index}`) => ({
  id: index.toString(16).padStart(64, "0"),
  name,
  image: "alpine:3.20",
  state: "running",
  status: "Up",
  health: "healthy",
  ports: [
    {
      publicPort: 8_000 + (index % 100),
      privatePort: 80,
      ip: "127.0.0.1",
    },
  ],
});

const containerList = (containers: unknown[]) => ({
  context: "default",
  source: "engine-api",
  apiVersion: "1.55",
  containers,
  observedAt,
  endpointHash: "endpoint",
  limitations: [],
});

const image = (index: number, repository = `registry.test/image-${index}`) => ({
  id: `sha256:${index.toString(16).padStart(64, "0")}`,
  repoTags: [`${repository}:latest`],
  repoDigests: [],
  created: 1_753_000_000 - index,
  sizeBytes: 1_048_576 + index,
  sharedBytes: 0,
  virtualBytes: 1_048_576 + index,
  containers: 0,
  labels: {},
});

const imageList = (images: unknown[]) => ({
  context: "default",
  source: "engine-api",
  apiVersion: "1.55",
  images,
  observedAt,
  endpointHash: "endpoint",
  limitations: [],
});

const volume = (name: string) => ({
  name,
  driver: "local",
  mountpoint: `/var/lib/docker/volumes/${name}/_data`,
  createdAt: observedAt,
  scope: "local",
  labels: {},
  options: {},
  usage: { sizeBytes: 1_024, refCount: 0 },
});

const volumeList = (volumes: unknown[]) => ({
  context: "default",
  source: "engine-api",
  apiVersion: "1.55",
  volumes,
  warnings: [],
  observedAt,
  endpointHash: "endpoint",
  limitations: [],
});

const snapshot = {
  context: "default",
  source: "engine-api",
  apiVersion: "1.55",
  engine: {
    serverVersion: "28.0.0",
    apiVersion: "1.55",
    architecture: "x86_64",
    operatingSystem: "Linux",
    cpus: 16,
    memoryBytes: 32 * 1024 ** 3,
    containers: 1,
    containersRunning: 1,
    containersPaused: 0,
    containersStopped: 0,
    images: 1,
    experimental: false,
    liveRestoreEnabled: false,
    warnings: [],
  },
  diskUsage: {
    layersSizeBytes: 1_048_576,
    builderSizeBytes: 0,
    images: [],
    containers: [],
    volumes: [],
    buildCache: [],
    summary: {
      images: {
        totalCount: 0,
        activeCount: 0,
        sizeBytes: 1_048_576,
        reclaimableBytes: 1_048_576,
      },
      containers: { totalCount: 0, activeCount: 0, sizeBytes: 0, reclaimableBytes: 0 },
      volumes: { totalCount: 0, activeCount: 0, sizeBytes: 0, reclaimableBytes: 0 },
      buildCache: { totalCount: 0, activeCount: 0, sizeBytes: 0, reclaimableBytes: 0 },
    },
  },
  observedAt,
  endpointHash: "endpoint",
  limitations: [],
};

const statsResult = (cpuPercent: number) => ({
  context: "default",
  source: "engine-api",
  apiVersion: "1.55",
  containerId: container(1).id,
  cpuPercent,
  cpuUsageTotal: cpuPercent,
  cpuUsageDelta: cpuPercent,
  systemUsageDelta: 100,
  onlineCpus: 16,
  memoryUsageBytes: 1024,
  memoryWorkingSetBytes: 900,
  memoryLimitBytes: 4096,
  memoryPercent: 22,
  networkRxBytes: 100,
  networkTxBytes: 200,
  blockReadBytes: 300,
  blockWriteBytes: 400,
  pids: 2,
  document: {},
  observedAt,
  endpointHash: "endpoint",
});

function createHost({
  list = vi.fn(async () => containerList([container(1)])),
  listImages = vi.fn(async () => imageList([image(1)])),
  listVolumes = vi.fn(async () => volumeList([volume("cache")])),
  readSnapshot = vi.fn(async () => snapshot),
}: {
  list?: (request: { context: string; all: boolean }) => Promise<unknown>;
  listImages?: (request: {
    context: string;
    all?: boolean;
  }) => Promise<unknown>;
  listVolumes?: (request: { context: string }) => Promise<unknown>;
  readSnapshot?: (request: { context: string }) => Promise<unknown>;
} = {}) {
  const listMock = vi.mocked(list);
  const imageListMock = vi.mocked(listImages);
  const volumeListMock = vi.mocked(listVolumes);
  const snapshotMock = vi.mocked(readSnapshot);
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const subscribe = vi.fn(
    (event: string, listener: (payload: unknown) => void) => {
      const current = listeners.get(event) ?? new Set();
      current.add(listener);
      listeners.set(event, current);
      return () => current.delete(listener);
    },
  );
  const host: HostAnchorageApi = {
    system: {
      capabilities: async () => createFixtureCapabilities("default"),
      snapshot: snapshotMock,
    },
    containers: {
      list: listMock,
      action: vi.fn().mockResolvedValue({ operationId: "operation" }),
      inspect: vi.fn().mockResolvedValue({
        context: "default",
        source: "engine-api",
        apiVersion: "1.55",
        container: {
          id: container(1).id,
          name: "container-1",
          args: [],
          restartCount: 0,
          state: {
            running: true,
            paused: false,
            restarting: false,
            oomKilled: false,
            dead: false,
            pid: 1,
            exitCode: 0,
          },
          entrypoint: [],
          command: [],
          environment: [],
          labels: {},
          mounts: [],
          ports: {},
          networks: {},
        },
        document: { Id: container(1).id },
        observedAt,
      }),
      stats: vi.fn().mockResolvedValue({
        context: "default",
        source: "engine-api",
        apiVersion: "1.55",
        containerId: container(1).id,
        cpuPercent: 2,
        cpuUsageTotal: 1,
        cpuUsageDelta: 1,
        systemUsageDelta: 10,
        onlineCpus: 16,
        memoryUsageBytes: 1024,
        memoryWorkingSetBytes: 900,
        memoryLimitBytes: 4096,
        memoryPercent: 22,
        networkRxBytes: 100,
        networkTxBytes: 200,
        blockReadBytes: 300,
        blockWriteBytes: 400,
        pids: 2,
        document: {},
        observedAt,
        endpointHash: "endpoint",
      }),
    },
    images: {
      list: imageListMock,
      action: vi.fn().mockResolvedValue({
        action: "prune",
        receipt: { operationId: "image-operation" },
      }),
    },
    volumes: {
      list: volumeListMock,
      action: vi.fn().mockResolvedValue({ operationId: "volume-operation" }),
    },
    cli: {
      run: vi.fn().mockResolvedValue({
        stdout: { data: "", encoding: "utf-8" },
        stderr: { data: "", encoding: "utf-8" },
      }),
    },
    session: {
      start: vi.fn().mockRejectedValue(new Error("PTY unavailable in test host")),
      input: vi.fn(),
      resize: vi.fn(),
      signal: vi.fn(),
      cancel: vi.fn(),
      ack: vi.fn(),
    },
    subscribe,
  };
  const emit = (event: string, payload: unknown) => {
    listeners.get(event)?.forEach((listener) => listener(payload));
  };
  return {
    host,
    list: listMock,
    listImages: imageListMock,
    listVolumes: volumeListMock,
    readSnapshot: snapshotMock,
    emit,
  };
}

const flushMicrotasks = async () => {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
};

function installMemoryStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

beforeEach(() => {
  delete window.anchorage;
  installMemoryStorage();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-color-mode");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("host renderer integration", () => {
  it("unlocks containers before the slow snapshot and bounds 10k container/image DOMs", async () => {
    const never = new Promise<never>(() => undefined);
    const containers = Array.from({ length: 10_000 }, (_, index) =>
      container(index),
    );
    const images = Array.from({ length: 10_000 }, (_, index) => image(index));
    const harness = createHost({
      list: vi.fn(async () => containerList(containers)),
      listImages: vi.fn(async () => imageList(images)),
      readSnapshot: vi.fn(async () => never),
    });
    window.anchorage = harness.host;
    render(<App />);

    expect(await screen.findByTestId("containers-screen")).toBeInTheDocument();
    expect(screen.getByText("10000 running · 0 stopped · 10000 total"))
      .toBeInTheDocument();
    expect(screen.getByTestId("container-table-body")).toHaveAttribute(
      "data-virtualized",
      "true",
    );
    expect(screen.getAllByTestId(/container-row-/u).length).toBeLessThanOrEqual(
      40,
    );
    expect(
      screen.getByTestId(`container-row-${container(0).id}`),
    ).toBeInTheDocument();
    expect(harness.readSnapshot).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("nav-images"));
    expect(
      await screen.findByText(/10000 images/u),
    ).toBeInTheDocument();
    expect(screen.getByTestId("images-table-body")).toHaveAttribute(
      "data-virtualized",
      "true",
    );
    expect(screen.getAllByTestId(/^image-sha256:/u).length).toBeLessThanOrEqual(
      40,
    );
    // Matches `docker image ls`: untagged layers are opt-in, not the default view.
    expect(harness.listImages).toHaveBeenCalledWith({
      context: "default",
      all: false,
      includeDangling: false,
    });
    act(() => {
      harness.emit("reconciliation.requested", {
        operationId: "external-image-refresh",
        context: "default",
        domain: "image",
        resourceId: image(0).id,
        action: "pull",
        reason: "mutation_completed",
      });
    });
    await act(flushMicrotasks);
    expect(harness.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("polls authoritative host state without overlap and stops on disconnect/unmount", async () => {
    vi.useFakeTimers();
    let currentName = "before-external-cli";
    let pendingResolve: ((value: unknown) => void) | null = null;
    let holdNext = false;
    const list = vi.fn(() => {
      if (holdNext) {
        holdNext = false;
        return new Promise<unknown>((resolve) => {
          pendingResolve = resolve;
        });
      }
      return Promise.resolve(
        containerList([container(1, currentName)]),
      );
    });
    const harness = createHost({ list });
    window.anchorage = harness.host;
    const rendered = render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();
    });
    expect(screen.getByText("before-external-cli")).toBeInTheDocument();

    currentName = "after-external-cli";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await flushMicrotasks();
    });
    expect(screen.getByText("after-external-cli")).toBeInTheDocument();

    holdNext = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await flushMicrotasks();
    });
    const callsWhilePending = list.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
      await flushMicrotasks();
    });
    expect(list).toHaveBeenCalledTimes(callsWhilePending);
    await act(async () => {
      pendingResolve?.(containerList([container(1, "after-pending")]));
      await flushMicrotasks();
    });
    expect(screen.getByText("after-pending")).toBeInTheDocument();

    act(() => {
      harness.emit("core.status", { state: "unavailable" });
    });
    expect(screen.getByTestId("engine-state-disconnected")).toBeInTheDocument();
    const callsAtDisconnect = list.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
      await flushMicrotasks();
    });
    expect(list).toHaveBeenCalledTimes(callsAtDisconnect);

    currentName = "after-core-reconnect";
    await act(async () => {
      harness.emit("core.status", { state: "ready" });
      await flushMicrotasks();
    });
    expect(screen.getByText("after-core-reconnect")).toBeInTheDocument();
    const callsAtReconnect = list.mock.calls.length;
    rendered.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
      await flushMicrotasks();
    });
    expect(list).toHaveBeenCalledTimes(callsAtReconnect);
  });

  it("refreshes images and volumes on entry and a bounded slower cadence", async () => {
    vi.useFakeTimers();
    let imageRepository = "registry.test/before";
    let volumeName = "before-volume";
    const listImages = vi.fn(() =>
      Promise.resolve(imageList([image(1, imageRepository)])),
    );
    const listVolumes = vi.fn(() =>
      Promise.resolve(volumeList([volume(volumeName)])),
    );
    const harness = createHost({ listImages, listVolumes });
    window.anchorage = harness.host;
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();
    });
    expect(screen.getByTestId("containers-screen")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("nav-images"));
    await act(flushMicrotasks);
    expect(screen.getByText("registry.test/before")).toBeInTheDocument();
    imageRepository = "registry.test/after";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await flushMicrotasks();
    });
    expect(screen.getByText("registry.test/after")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("nav-volumes"));
    await act(flushMicrotasks);
    expect(screen.getByText("before-volume")).toBeInTheDocument();
    volumeName = "after-volume";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await flushMicrotasks();
    });
    expect(screen.getByText("after-volume")).toBeInTheDocument();
    expect(listImages.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(listVolumes.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("renders explicit actionable host-only unsupported states without fixture data", async () => {
    const harness = createHost();
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");

    for (const view of ["builds", "devenv", "extensions"]) {
      fireEvent.click(screen.getByTestId(`nav-${view}`));
      const surface = screen.getByTestId(`${view}-screen`);
      expect(
        within(surface).getAllByText(
          /unavailable in this build|unavailable/u,
        ).length,
      ).toBeGreaterThan(0);
      expect(
        within(surface).getByRole("button", { name: "Open Command Center" }),
      ).toBeInTheDocument();
    }

    fireEvent.click(screen.getByTestId("nav-settings"));
    const settings = screen.getByTestId("settings-screen");
    expect(
      within(settings).getByRole("button", { name: "Appearance" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(settings).getByRole("heading", { name: "Appearance" }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(settings).getByRole("radio", { name: /GitHub/u }),
    );
    expect(document.documentElement).toHaveAttribute("data-theme", "github");
    expect(
      within(settings).getByText(/Using GitHub · Dark/u),
    ).toBeInTheDocument();

    fireEvent.click(
      within(settings).getByRole("button", { name: "Resources" }),
    );
    expect(
      within(settings).getByText("Resources is unavailable in this build"),
    ).toBeInTheDocument();
    expect(
      within(settings).getByRole("button", { name: "Open Command Center" }),
    ).toBeInTheDocument();

    expect(screen.queryByText("acme/worker:2.3")).not.toBeInTheDocument();
    expect(screen.queryByText("Trivy Scanner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("daemon-json")).not.toBeInTheDocument();
  });

  it("keeps host capture settings on canonical Resources", async () => {
    window.history.replaceState({}, "", "/?capture=settings-resources");
    const harness = createHost();
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");

    fireEvent.click(screen.getByTestId("nav-settings"));
    const settings = screen.getByTestId("settings-screen");
    expect(
      within(settings).getByRole("button", { name: "Resources" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(settings).queryByRole("button", { name: "Appearance" }),
    ).not.toBeInTheDocument();
    expect(
      within(settings).getByText("Resources is unavailable in this build"),
    ).toBeInTheDocument();
  });

  it("confirms structured image/volume mutations and owns an early-event pull session", async () => {
    const ownedSessionId = "22222222-2222-4222-8222-222222222222";
    let currentImages = [image(10, "registry.test/remove-me")];
    let currentVolumes = [volume("remove-me")];
    const listImages = vi.fn(async () => imageList(currentImages));
    const listVolumes = vi.fn(async () => volumeList(currentVolumes));
    const harness = createHost({ listImages, listVolumes });
    const imageAction = vi.fn(
      async (request: {
        action: "remove" | "prune" | "pull" | "save" | "load" | "tag";
        id?: string;
        reference?: string;
      }) => {
        if (request.action === "remove") {
          currentImages = currentImages.filter(
            (candidate) => candidate.id !== request.id,
          );
          return {
            action: "remove",
            receipt: { operationId: "remove-image" },
          };
        }
        if (request.action === "prune") {
          currentImages = [];
          return {
            action: "prune",
            receipt: { operationId: "prune-images" },
          };
        }
        harness.emit("session.output", {
          sessionId: "33333333-3333-4333-8333-333333333333",
          sequence: 1,
          stream: "stdout",
          data: "rogue-output",
          encoding: "utf-8",
          bytes: 12,
        });
        harness.emit("session.output", {
          sessionId: ownedSessionId,
          sequence: 2,
          stream: "stdout",
          data: "owned-pull-output",
          encoding: "utf-8",
          bytes: 17,
        });
        return {
          action: "pull",
          receipt: { operationId: "pull-image" },
          session: {
            sessionId: ownedSessionId,
            mode: "pipes",
            pid: 10,
            context: "default",
            executable: "/usr/bin/docker",
            argv: ["pull", request.reference ?? ""],
            cwd: "/home/soya",
            outputWindowBytes: 64 * 1024,
            maxOutputBytes: 64 * 1024 * 1024,
            startedAt: observedAt,
          },
        };
      },
    );
    const volumeAction = vi.fn(
      async (request: {
        action: "create" | "remove" | "prune";
        name?: string;
        filters?: Record<string, string[]>;
      }) => {
        if (request.action === "create" && request.name) {
          currentVolumes = [...currentVolumes, volume(request.name)];
        } else if (request.action === "remove" && request.name) {
          currentVolumes = currentVolumes.filter(
            (candidate) => candidate.name !== request.name,
          );
        } else if (request.action === "prune") {
          // Mirror Docker: the default prune only removes anonymous volumes, and every volume
          // in this fixture is named. Only the --all variant clears named unused volumes.
          if (request.filters?.all?.includes("true")) {
            currentVolumes = [];
          }
        }
        return { operationId: `volume-${request.action}` };
      },
    );
    if (harness.host.images) harness.host.images.action = imageAction;
    if (harness.host.volumes) harness.host.volumes.action = volumeAction;
    window.anchorage = harness.host;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await screen.findByTestId("containers-screen");

    fireEvent.click(screen.getByTestId("nav-images"));
    const removable = await screen.findByRole("button", {
      name: "Remove registry.test/remove-me:latest",
    });
    fireEvent.click(removable);
    fireEvent.click(await screen.findByTestId("delete-image-confirm"));
    await waitFor(() =>
      expect(imageAction).toHaveBeenCalledWith({
        context: "default",
        action: "remove",
        id: image(10).id,
        reference: "registry.test/remove-me:latest",
        confirmed: true,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("registry.test/remove-me")).not.toBeInTheDocument(),
    );

    currentImages = [{ ...image(11, "registry.test/prune-me"), repoTags: [] }];
    act(() => {
      harness.emit("reconciliation.requested", {
        operationId: "repopulate-images",
        context: "default",
        domain: "image",
        action: "pull",
        reason: "mutation_completed",
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Clean up" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clean up" }));
    // Clean up now asks which Docker prune it should run instead of silently picking one.
    fireEvent.click(await screen.findByTestId("clean-up-confirm"));
    await waitFor(() =>
      expect(imageAction).toHaveBeenCalledWith({
        context: "default",
        action: "prune",
        confirmed: true,
        filters: { dangling: ["true"] },
      }),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Registry search" }));
    fireEvent.change(screen.getByTestId("registry-search"), {
      target: { value: "registry.test/new:latest" },
    });
    const pullPanel = screen.getByTestId("registry-search").closest(
      ".host-pull-panel",
    );
    expect(pullPanel).not.toBeNull();
    fireEvent.click(
      within(pullPanel as HTMLElement).getByRole("button", {
        name: "Pull image",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("image-transfer-output")).toHaveTextContent(
        "owned-pull-output",
      ),
    );
    expect(screen.getByTestId("image-transfer-output")).not.toHaveTextContent(
      "rogue-output",
    );
    expect(harness.host.session?.ack).toHaveBeenCalledWith({
      sessionId: ownedSessionId,
      throughSequence: 2,
    });

    fireEvent.click(screen.getByTestId("nav-volumes"));
    await screen.findByTestId("volume-remove-me");
    fireEvent.click(screen.getByRole("button", { name: "Create volume" }));
    fireEvent.change(screen.getByTestId("create-volume-name"), {
      target: { value: "created-volume" },
    });
    fireEvent.submit(screen.getByTestId("create-volume-dialog"));
    await screen.findByTestId("volume-created-volume");
    expect(volumeAction).toHaveBeenCalledWith({
      context: "default",
      action: "create",
      name: "created-volume",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove volume created-volume",
      }),
    );
    await waitFor(() =>
      expect(volumeAction).toHaveBeenCalledWith({
        context: "default",
        action: "remove",
        name: "created-volume",
        confirmed: true,
      }),
    );
    // Clean up must default to Docker's own semantics (anonymous volumes only). The --all
    // variant additionally destroys named volumes the user created deliberately, so it is an
    // explicit opt-in rather than the hardcoded default this button used to send.
    fireEvent.click(screen.getByRole("button", { name: "Clean up" }));
    const pruneDialog = await screen.findByTestId("prune-volumes-dialog");
    expect(within(pruneDialog).getByTestId("prune-include-named")).not.toBeChecked();
    fireEvent.click(within(pruneDialog).getByTestId("prune-confirm"));
    await waitFor(() =>
      expect(volumeAction).toHaveBeenCalledWith({
        context: "default",
        action: "prune",
        confirmed: true,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Clean up" }));
    const allDialog = await screen.findByTestId("prune-volumes-dialog");
    fireEvent.click(within(allDialog).getByTestId("prune-include-named"));
    fireEvent.click(within(allDialog).getByTestId("prune-confirm"));
    await waitFor(() =>
      expect(volumeAction).toHaveBeenCalledWith({
        context: "default",
        action: "prune",
        confirmed: true,
        filters: { all: ["true"] },
      }),
    );
  });

  it("uses live inspect/mounts/stats, polls stats only while visible, and never fabricates files", async () => {
    vi.useFakeTimers();
    const harness = createHost();
    const inspect = vi.fn().mockResolvedValue({
      context: "default",
      source: "engine-api",
      apiVersion: "1.55",
      container: {
        id: container(1).id,
        name: "container-1",
        args: [],
        restartCount: 0,
        state: {
          running: true,
          paused: false,
          restarting: false,
          oomKilled: false,
          dead: false,
          pid: 44,
          exitCode: 0,
        },
        entrypoint: [],
        command: [],
        environment: [],
        labels: {},
        mounts: [
          {
            type: "bind",
            source: "/live/source",
            destination: "/live/destination",
            mode: "ro",
            rw: false,
          },
        ],
        ports: {},
        networks: {},
      },
      document: { Id: container(1).id, Live: true },
      observedAt,
    });
    if (harness.host.containers) harness.host.containers.inspect = inspect;
    const stats = vi.mocked(harness.host.containers?.stats);
    window.anchorage = harness.host;
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();
    });
    fireEvent.click(screen.getByTestId(`container-row-${container(1).id}`));
    await act(flushMicrotasks);
    expect(screen.getByTestId("container-detail-screen")).toBeInTheDocument();
    expect(screen.getByText(/Logs unavailable:/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect(screen.getByText(/"Live": true/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bind mounts" }));
    expect(screen.getByText("/live/source")).toBeInTheDocument();
    expect(screen.getByText("/live/destination")).toBeInTheDocument();
    expect(screen.queryByText("core_pgdata")).not.toBeInTheDocument();

    // The Files tab is a real browser now rather than an unavailable state. Without a files
    // capability on this harness it surfaces the failure instead of fabricating a filesystem.
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    await act(flushMicrotasks);
    expect(screen.getByTestId("container-files")).toBeInTheDocument();
    expect(screen.queryByText("/usr/share/nginx/html")).not.toBeInTheDocument();
    expect(screen.queryByText("srv/dist/server.js")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stats" }));
    await act(flushMicrotasks);
    expect(stats).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
      await flushMicrotasks();
    });
    expect(stats?.mock.calls.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    const callsAfterLeavingStats = stats?.mock.calls.length ?? 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
      await flushMicrotasks();
    });
    expect(stats).toHaveBeenCalledTimes(callsAfterLeavingStats);
  });

  it("routes early live-log and exec output only to each returned session id", async () => {
    const logSessionId = "44444444-4444-4444-8444-444444444444";
    const execSessionId = "55555555-5555-4555-8555-555555555555";
    const rogueSessionId = "66666666-6666-4666-8666-666666666666";
    const harness = createHost();
    const sessionStart = vi.fn(
      async (request: {
        context: string;
        argv: string[];
        mode: "pipes" | "pty";
        rows?: number;
        cols?: number;
      }) => {
        // The docker events stream is its own session. Give it a distinct id and no output,
        // so it never masquerades as the logs or exec session under test.
        if (request.argv[0] === "events") {
          return {
            sessionId: "events-session",
            mode: request.mode,
            pid: 99,
            context: request.context,
            executable: "/usr/bin/docker",
            argv: request.argv,
            cwd: "/home/soya",
            outputWindowBytes: 64 * 1024,
            maxOutputBytes: 16 * 1024 * 1024,
            startedAt: observedAt,
          };
        }
        const logs = request.argv[0] === "logs";
        const sessionId = logs ? logSessionId : execSessionId;
        harness.emit("session.output", {
          sessionId: rogueSessionId,
          sequence: 1,
          stream: request.mode === "pty" ? "pty" : "stdout",
          data: logs ? "rogue-log\n" : "rogue-exec",
          encoding: "utf-8",
          bytes: 11,
        });
        harness.emit("session.output", {
          sessionId,
          sequence: 2,
          stream: request.mode === "pty" ? "pty" : "stdout",
          data: logs ? "owned-log\n" : "owned-exec",
          encoding: "utf-8",
          bytes: 11,
        });
        return {
          sessionId,
          mode: request.mode,
          pid: 20,
          context: request.context,
          executable: "/usr/bin/docker",
          argv: request.argv,
          cwd: "/home/soya",
          rows: request.rows,
          cols: request.cols,
          outputWindowBytes: 64 * 1024,
          maxOutputBytes: 16 * 1024 * 1024,
          startedAt: observedAt,
        };
      },
    );
    if (harness.host.session) harness.host.session.start = sessionStart;
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId(`container-row-${container(1).id}`));

    // The docker events stream is also a session; assert against the log session specifically.
    await waitFor(() =>
      expect(
        sessionStart.mock.calls.some((call) => call[0].argv[0] === "logs"),
      ).toBe(true),
    );
    expect(await screen.findByText("owned-log")).toBeInTheDocument();
    expect(screen.queryByText("rogue-log")).not.toBeInTheDocument();
    expect(harness.host.session?.ack).toHaveBeenCalledWith({
      sessionId: logSessionId,
      throughSequence: 2,
    });
    expect(harness.host.session?.ack).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: rogueSessionId }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Exec" }));
    expect(await screen.findByText("owned-exec")).toBeInTheDocument();
    expect(screen.queryByText("rogue-exec")).not.toBeInTheDocument();
    expect(harness.host.session?.ack).toHaveBeenCalledWith({
      sessionId: execSessionId,
      throughSequence: 2,
    });
  });

  it("renders unknown live metrics and usage honestly and blocks every related destructive action", async () => {
    const missingUsageImage = { ...image(21, "registry.test/missing") };
    delete (missingUsageImage as { containers?: number }).containers;
    const harness = createHost({
      listImages: vi.fn(async () =>
        imageList([
          missingUsageImage,
          { ...image(22, "registry.test/negative"), containers: -1 },
        ]),
      ),
      listVolumes: vi.fn(async () =>
        volumeList([
          { ...volume("missing-usage"), usage: undefined },
          {
            ...volume("negative-usage"),
            usage: { sizeBytes: -1, refCount: -1 },
          },
        ]),
      ),
    });
    window.anchorage = harness.host;
    render(<App />);

    const liveRow = await screen.findByTestId(
      `container-row-${container(1).id}`,
    );
    expect(within(liveRow).queryByText("0.0%")).not.toBeInTheDocument();
    expect(within(liveRow).queryByText("0 MB")).not.toBeInTheDocument();
    expect(within(liveRow).getAllByText("—")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("nav-images"));
    expect(
      await screen.findByRole("button", {
        name: "Remove registry.test/missing:latest",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "Remove registry.test/negative:latest",
      }),
    ).toBeDisabled();
    expect(screen.getAllByText("Unknown")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Clean up" })).toBeDisabled();

    fireEvent.click(screen.getByTestId("nav-volumes"));
    expect(
      await screen.findByRole("button", {
        name: "Remove volume missing-usage",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "Remove volume negative-usage",
      }),
    ).toBeDisabled();
    expect(screen.getAllByText("Unknown")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Clean up" })).toBeDisabled();
  });

  it("renders every local and remote tag once, aggregates by image id, and removes only the displayed reference", async () => {
    const local = {
      ...image(31, "localhost:5000/team/app"),
      repoTags: [
        "localhost:5000/team/app:dev",
        "localhost:5000/team/app:latest",
      ],
    };
    const ollama = {
      ...image(32, "ollama/ollama"),
      repoTags: ["ollama/ollama:0.11.4", "ollama/ollama:latest"],
    };
    const harness = createHost({
      listImages: vi.fn(async () => imageList([local, ollama])),
    });
    const imageAction = vi.mocked(harness.host.images?.action);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId("nav-images"));

    expect(await screen.findByText("0.11.4")).toBeInTheDocument();
    expect(screen.getAllByText("latest")).toHaveLength(2);
    expect(screen.getAllByTestId(`image-${local.id}`)).toHaveLength(2);
    expect(screen.getAllByTestId(`image-${ollama.id}`)).toHaveLength(2);
    expect(screen.getByText(/2 images · .* listed size · 2 unused/u))
      .toBeInTheDocument();
    // Both images are unused, so clean-up is offered. It used to be disabled here because it
    // could only ever prune untagged layers, while the header advertised the unused total.
    expect(screen.getByRole("button", { name: "Clean up" })).toBeEnabled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove ollama/ollama:latest",
      }),
    );
    // Removing one tag of a multi-tag image must still send only that reference.
    fireEvent.click(await screen.findByTestId("delete-image-confirm"));
    await waitFor(() =>
      expect(imageAction).toHaveBeenCalledWith({
        context: "default",
        action: "remove",
        id: ollama.id,
        reference: "ollama/ollama:latest",
        confirmed: true,
      }),
    );
    expect(imageAction).toHaveBeenCalledTimes(1);
  });

  it("keeps stats polling single-flight when a sample takes longer than the cadence", async () => {
    vi.useFakeTimers();
    const harness = createHost({
      list: vi.fn(async () =>
        containerList([container(1), container(2)]),
      ),
    });
    let concurrent = 0;
    let maximumConcurrent = 0;
    const pending: Array<(value: ReturnType<typeof statsResult>) => void> = [];
    const stats = vi.fn(
      () =>
        new Promise<ReturnType<typeof statsResult>>((resolve) => {
          concurrent += 1;
          maximumConcurrent = Math.max(maximumConcurrent, concurrent);
          pending.push((value) => {
            concurrent -= 1;
            resolve(value);
          });
        }),
    );
    if (harness.host.containers) harness.host.containers.stats = stats;
    window.anchorage = harness.host;
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();
    });
    fireEvent.click(screen.getByTestId(`container-row-${container(1).id}`));
    await act(flushMicrotasks);
    fireEvent.click(screen.getByRole("button", { name: "Stats" }));
    await act(flushMicrotasks);
    expect(stats).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_100);
      await flushMicrotasks();
    });
    expect(stats).toHaveBeenCalledTimes(1);
    expect(maximumConcurrent).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "All containers" }));
    fireEvent.click(screen.getByTestId(`container-row-${container(2).id}`));
    await act(flushMicrotasks);
    fireEvent.click(screen.getByRole("button", { name: "Stats" }));
    await act(flushMicrotasks);
    expect(stats).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.shift()?.(statsResult(11));
      await flushMicrotasks();
    });
    expect(screen.queryByText("11.0%")).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await flushMicrotasks();
    });
    expect(stats).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.shift()?.(statsResult(22));
      await flushMicrotasks();
    });
    expect(screen.getByText("22.0%")).toBeInTheDocument();
    expect(screen.queryByText("11.0%")).not.toBeInTheDocument();
    expect(maximumConcurrent).toBe(1);
  });

  it("fills the list CPU and MEMORY columns from batched stats", async () => {
    const harness = createHost();
    const statsBatch = vi.fn(async (request: { ids: string[] }) => ({
      context: "default",
      source: "engine-api",
      samples: request.ids.map((id, index) => ({
        id,
        stats: {
          ...statsResult(index === 0 ? 42.5 : 7.25),
          containerId: id,
          memoryWorkingSetBytes: 256 * 1024 * 1024,
          memoryLimitBytes: 512 * 1024 * 1024,
        },
      })),
      observedAt,
    }));
    if (harness.host.containers) {
      harness.host.containers.statsBatch = statsBatch;
    }
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");

    // These columns rendered a permanent em-dash before batched sampling existed.
    await waitFor(() => expect(statsBatch).toHaveBeenCalled());
    const requested = statsBatch.mock.calls[0][0];
    expect(requested.ids.length).toBeGreaterThan(0);
    // Only running containers are sampled.
    expect(requested.ids.length).toBeLessThanOrEqual(40);

    const row = await screen.findByTestId(`container-row-${container(1).id}`);
    await waitFor(() => expect(row).toHaveTextContent("42.5%"));
    expect(row).toHaveTextContent("256 MB");
  });

  it("reconciles from the docker events stream instead of waiting for the next poll", async () => {
    const harness = createHost();
    let eventsSession: string | null = null;
    const sessionStart = vi.fn(async (request: { context: string; argv: string[] }) => {
      if (request.argv[0] !== "events") throw new Error("unexpected session");
      eventsSession = "events-session";
      return {
        sessionId: eventsSession,
        mode: "pipes",
        pid: 42,
        context: request.context,
        executable: "/usr/bin/docker",
        argv: request.argv,
        cwd: "/home/soya",
        outputWindowBytes: 64 * 1024,
        maxOutputBytes: 0,
        startedAt: observedAt,
      };
    });
    if (harness.host.session) harness.host.session.start = sessionStart;
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");

    await waitFor(() => expect(eventsSession).not.toBeNull());
    const before = harness.listImages.mock.calls.length;

    // A change made outside Anchorage should not wait up to 10s for the images poll.
    act(() => {
      harness.emit("session.output", {
        sessionId: "events-session",
        sequence: 1,
        stream: "stdout",
        data: JSON.stringify({ Type: "image", Action: "delete" }) + "\n",
        encoding: "utf-8",
        bytes: 40,
      });
    });
    await waitFor(
      () => expect(harness.listImages.mock.calls.length).toBeGreaterThan(before),
      { timeout: 3_000 },
    );

    // Output for a session we do not own must never drive reconciliation.
    const settled = harness.listImages.mock.calls.length;
    act(() => {
      harness.emit("session.output", {
        sessionId: "someone-elses-session",
        sequence: 2,
        stream: "stdout",
        data: JSON.stringify({ Type: "image", Action: "delete" }) + "\n",
        encoding: "utf-8",
        bytes: 40,
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(harness.listImages.mock.calls.length).toBe(settled);
  });

  it("lists, creates and removes networks, and never offers to remove built-ins", async () => {
    const networks = [
      {
        id: "bbbbbbbbbbbb2222",
        name: "app-net",
        driver: "bridge",
        scope: "local",
        internal: false,
        attachable: false,
        ingress: false,
        enableIpv6: false,
        subnets: ["172.20.0.0/16"],
        gateways: ["172.20.0.1"],
        labels: {},
        options: {},
        predefined: false,
        containerCount: -1,
      },
      {
        id: "aaaaaaaaaaaa1111",
        name: "bridge",
        driver: "bridge",
        scope: "local",
        internal: false,
        attachable: false,
        ingress: false,
        enableIpv6: false,
        subnets: [],
        gateways: [],
        labels: {},
        options: {},
        predefined: true,
        containerCount: -1,
      },
    ];
    const harness = createHost();
    const networksList = vi.fn(async () => ({
      context: "default",
      source: "engine-api",
      apiVersion: "1.55",
      networks,
      observedAt,
      limitations: [],
    }));
    const networksAction = vi.fn(async () => ({ action: "create", receipt: {} }));
    harness.host.networks = { list: networksList, action: networksAction };
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId("nav-networks"));

    await screen.findByTestId("network-bbbbbbbbbbbb2222");
    expect(screen.getByText("172.20.0.0/16")).toBeInTheDocument();
    // The list endpoint cannot report attachments, and unknown must stay unknown rather than
    // being rendered as zero.
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);

    // Docker rejects removing its built-in networks, so the control must say so, not just fail.
    const builtIn = screen.getByRole("button", { name: "Remove network bridge" });
    expect(builtIn).toBeDisabled();
    expect(builtIn).toHaveAttribute(
      "title",
      "Docker's built-in networks cannot be removed",
    );

    fireEvent.click(screen.getByTestId("networks-create-open"));
    fireEvent.change(screen.getByTestId("create-network-name"), {
      target: { value: "team-net" },
    });
    fireEvent.change(screen.getByTestId("create-network-subnet"), {
      target: { value: "10.8.0.0/16" },
    });
    fireEvent.submit(screen.getByTestId("create-network-dialog"));
    await waitFor(() =>
      expect(networksAction).toHaveBeenCalledWith({
        context: "default",
        action: "create",
        name: "team-net",
        driver: "bridge",
        subnet: "10.8.0.0/16",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove network app-net" }));
    fireEvent.click(await screen.findByTestId("remove-network-confirm"));
    await waitFor(() =>
      expect(networksAction).toHaveBeenCalledWith({
        context: "default",
        action: "remove",
        id: "bbbbbbbbbbbb2222",
        confirmed: true,
      }),
    );
  });

  it("runs docker system prune with safe defaults and reports each stage", async () => {
    const harness = createHost();
    const systemAction = vi.fn(async () => ({
      context: "default",
      action: "prune",
      source: "engine-api",
      stages: [
        { resource: "containers", deleted: ["dead"], spaceReclaimedBytes: 1_024 },
        { resource: "networks", deleted: [], spaceReclaimedBytes: 0 },
        { resource: "images", deleted: ["sha256:abc"], spaceReclaimedBytes: 2_048 },
        { resource: "build-cache", deleted: [], spaceReclaimedBytes: 512 },
      ],
      spaceReclaimedBytes: 3_584,
      receipt: {},
      observedAt,
    }));
    if (harness.host.system) harness.host.system.action = systemAction;
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId("nav-dashboard"));

    fireEvent.click(await screen.findByTestId("system-prune-open"));
    const dialog = await screen.findByTestId("system-prune-dialog");
    // Both destructive switches must default off, exactly as Docker does: --all deletes
    // tagged images and --volumes deletes unrecoverable data.
    expect(within(dialog).getByTestId("system-prune-all")).not.toBeChecked();
    expect(within(dialog).getByTestId("system-prune-volumes")).not.toBeChecked();

    fireEvent.click(within(dialog).getByTestId("system-prune-confirm"));
    await waitFor(() =>
      expect(systemAction).toHaveBeenCalledWith({
        context: "default",
        action: "prune",
        confirmed: true,
      }),
    );

    const result = await screen.findByTestId("system-prune-result");
    expect(result).toHaveTextContent("containers: 1 removed");
    expect(result).toHaveTextContent("build-cache: 0 removed");
  });

  it("passes --all and --volumes only when explicitly opted in", async () => {
    const harness = createHost();
    const systemAction = vi.fn(async () => ({
      context: "default",
      action: "prune",
      source: "engine-api",
      stages: [],
      spaceReclaimedBytes: 0,
      receipt: {},
      observedAt,
    }));
    if (harness.host.system) harness.host.system.action = systemAction;
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId("nav-dashboard"));

    fireEvent.click(await screen.findByTestId("system-prune-open"));
    const dialog = await screen.findByTestId("system-prune-dialog");
    fireEvent.click(within(dialog).getByTestId("system-prune-all"));
    fireEvent.click(within(dialog).getByTestId("system-prune-volumes"));
    fireEvent.click(within(dialog).getByTestId("system-prune-confirm"));

    await waitFor(() =>
      expect(systemAction).toHaveBeenCalledWith({
        context: "default",
        action: "prune",
        all: true,
        volumes: true,
        confirmed: true,
      }),
    );
  });

  it("renames a container inline and updates its resource limits", async () => {
    const harness = createHost();
    const action = vi.fn(async () => ({ operationId: "op" }));
    if (harness.host.containers) harness.host.containers.action = action;
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId(`container-row-${container(1).id}`));

    // Rename is an inline edit on the title, the way Docker Desktop does it.
    fireEvent.doubleClick(await screen.findByTestId("container-title"));
    const input = screen.getByTestId("container-rename-input");
    fireEvent.change(input, { target: { value: "renamed-api" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith({
        context: "default",
        id: container(1).id,
        action: "rename",
        options: { name: "renamed-api" },
      }),
    );

    fireEvent.click(screen.getByTestId("container-limits-open"));
    fireEvent.change(screen.getByTestId("container-limits-memory"), {
      target: { value: "512" },
    });
    fireEvent.change(screen.getByTestId("container-limits-restart"), {
      target: { value: "unless-stopped" },
    });
    fireEvent.submit(screen.getByTestId("container-limits-dialog"));
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith({
        context: "default",
        id: container(1).id,
        action: "update",
        // MB converted to bytes; an empty field is omitted rather than sent as zero.
        options: { memoryBytes: 536_870_912, restartPolicy: "unless-stopped" },
      }),
    );
  });

  it("browses the container filesystem and previews a file", async () => {
    const harness = createHost();
    const listings: Record<string, unknown> = {
      "/": {
        context: "default",
        source: "engine-api",
        path: "/",
        entries: [
          { name: "etc", path: "/etc", sizeBytes: 0, mode: "drwxr-xr-x", isDir: true },
          { name: "hello.txt", path: "/hello.txt", sizeBytes: 12, mode: "-rw-r--r--", isDir: false },
        ],
        truncated: false,
        observedAt,
        limitations: [],
      },
      "/etc": {
        context: "default",
        source: "engine-api",
        path: "/etc",
        entries: [
          { name: "hosts", path: "/etc/hosts", sizeBytes: 20, mode: "-rw-r--r--", isDir: false },
        ],
        truncated: false,
        observedAt,
        limitations: [],
      },
    };
    const files = vi.fn(async (request: { path?: string }) => listings[request.path ?? "/"]);
    const fileRead = vi.fn(async (request: { path: string }) => ({
      context: "default",
      path: request.path,
      sizeBytes: 20,
      encoding: "utf-8",
      content: "127.0.0.1 localhost",
      truncated: false,
      observedAt,
    }));
    if (harness.host.containers) {
      harness.host.containers.files = files;
      harness.host.containers.fileRead = fileRead;
    }
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId(`container-row-${container(1).id}`));
    fireEvent.click(await screen.findByRole("button", { name: "Files" }));

    // Root listing.
    await screen.findByTestId("file-etc");
    expect(files).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/", id: container(1).id }),
    );

    // Directories navigate.
    fireEvent.click(screen.getByTestId("file-etc"));
    await screen.findByTestId("file-hosts");
    expect(files).toHaveBeenCalledWith(expect.objectContaining({ path: "/etc" }));

    // Files preview rather than navigate.
    fireEvent.click(screen.getByTestId("file-hosts"));
    const preview = await screen.findByTestId("file-preview");
    expect(preview).toHaveTextContent("127.0.0.1 localhost");
    expect(fileRead).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/etc/hosts" }),
    );
  });

  it("shows processes and filesystem changes for a container", async () => {
    const harness = createHost();
    if (harness.host.containers) {
      harness.host.containers.top = vi.fn(async () => ({
        context: "default",
        titles: ["PID", "CMD"],
        processes: [{ values: ["1", "nginx -g daemon off;"] }],
        observedAt,
      }));
      harness.host.containers.diff = vi.fn(async () => ({
        context: "default",
        changes: [
          { path: "/var/log/nginx/access.log", kind: "modified" },
          { path: "/tmp/upload", kind: "added" },
        ],
        observedAt,
      }));
    }
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId(`container-row-${container(1).id}`));

    fireEvent.click(await screen.findByRole("button", { name: "Processes" }));
    const processes = await screen.findByTestId("container-processes");
    expect(processes).toHaveTextContent("nginx -g daemon off;");

    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    const changes = await screen.findByTestId("container-changes");
    // Docker's numeric kinds are projected to names the UI renders directly.
    expect(changes).toHaveTextContent("modified");
    expect(changes).toHaveTextContent("/tmp/upload");
  });

  it("opens image detail with layers ordered by size", async () => {
    const target = image(31, "registry.test/detail");
    const harness = createHost({
      listImages: vi.fn(async () => imageList([target])),
    });
    const inspect = vi.fn(async () => ({
      context: "default",
      source: "engine-api",
      image: {
        id: target.id,
        repoTags: ["registry.test/detail:latest"],
        repoDigests: [],
        sizeBytes: 10_485_760,
        created: "2026-01-01T00:00:00Z",
        architecture: "amd64",
        os: "linux",
        labels: {},
        env: [],
        entrypoint: [],
        command: [],
        exposedPorts: ["80/tcp"],
        rootFsLayers: ["sha256:a", "sha256:b"],
      },
      history: [
        { created: 1, createdBy: "ENV PATH", sizeBytes: 0, tags: [], emptyLayer: true },
        { created: 2, createdBy: "COPY big-asset", sizeBytes: 9_000_000, tags: [], emptyLayer: false },
        { created: 3, createdBy: "RUN apt-get", sizeBytes: 1_400_000, tags: [], emptyLayer: false },
      ],
      document: {},
      observedAt,
    }));
    if (harness.host.images) harness.host.images.inspect = inspect;
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId("nav-images"));

    fireEvent.click(await screen.findByTestId(`image-${target.id}`));
    const panel = await screen.findByTestId("image-detail-panel");
    await waitFor(() => expect(inspect).toHaveBeenCalled());

    // Layers are ordered largest-first: the panel exists to answer "what is using the space".
    const layers = within(panel).getByTestId("image-detail-layers");
    const captions = within(layers)
      .getAllByRole("listitem")
      .map((item) => item.querySelector("code")?.textContent ?? "");
    expect(captions[0]).toContain("COPY big-asset");
    expect(captions[1]).toContain("RUN apt-get");
    // A zero-size history entry is labelled rather than shown as a real layer.
    expect(panel).toHaveTextContent("metadata only");

    fireEvent.click(within(panel).getByTestId("image-detail-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("image-detail-panel")).toBeNull(),
    );
  });

  it("saves and loads image archives by absolute host path", async () => {
    const target = image(41, "registry.test/archivable");
    const harness = createHost({
      listImages: vi.fn(async () => imageList([target])),
    });
    const imageAction = vi.fn(async () => ({
      action: "save",
      receipt: { operationId: "archive" },
    }));
    if (harness.host.images) harness.host.images.action = imageAction;
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId("nav-images"));

    // Save is reached from the image's own detail panel, where the reference is unambiguous.
    fireEvent.click(await screen.findByTestId(`image-${target.id}`));
    fireEvent.click(await screen.findByTestId("image-detail-save"));
    const saveDialog = await screen.findByTestId("save-image-dialog");

    // A path that would be re-read as a Docker option is refused before any request is made.
    fireEvent.change(within(saveDialog).getByTestId("save-image-dialog-path"), {
      target: { value: "-o/tmp/evil.tar" },
    });
    expect(within(saveDialog).getByTestId("save-image-dialog-confirm")).toBeDisabled();
    // So is a relative path: it would resolve against a working directory the operator
    // cannot see, so the archive would land somewhere they did not choose.
    fireEvent.change(within(saveDialog).getByTestId("save-image-dialog-path"), {
      target: { value: "images/api.tar" },
    });
    expect(within(saveDialog).getByTestId("save-image-dialog-confirm")).toBeDisabled();
    expect(imageAction).not.toHaveBeenCalled();

    fireEvent.change(within(saveDialog).getByTestId("save-image-dialog-path"), {
      target: { value: "/home/operator/api.tar" },
    });
    fireEvent.click(within(saveDialog).getByTestId("save-image-dialog-confirm"));
    await waitFor(() =>
      expect(imageAction).toHaveBeenCalledWith({
        context: "default",
        action: "save",
        reference: "registry.test/archivable:latest",
        archivePath: "/home/operator/api.tar",
        outputWindowBytes: 65_536,
      }),
    );

    // Load is the inverse and names no image: the archive carries its own.
    fireEvent.click(screen.getByTestId("images-load-archive"));
    const loadDialog = await screen.findByTestId("load-image-dialog");
    fireEvent.change(within(loadDialog).getByTestId("load-image-dialog-path"), {
      target: { value: "/home/operator/api.tar" },
    });
    fireEvent.click(within(loadDialog).getByTestId("load-image-dialog-confirm"));
    await waitFor(() =>
      expect(imageAction).toHaveBeenCalledWith({
        context: "default",
        action: "load",
        archivePath: "/home/operator/api.tar",
        outputWindowBytes: 65_536,
      }),
    );
  });

  it("tags an image by immutable id, not by the tag shown in the row", async () => {
    const target = image(42, "registry.test/taggable");
    const harness = createHost({
      listImages: vi.fn(async () => imageList([target])),
    });
    const imageAction = vi.fn(async () => ({
      action: "tag",
      receipt: { operationId: "tag" },
    }));
    if (harness.host.images) harness.host.images.action = imageAction;
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId("nav-images"));

    fireEvent.click(await screen.findByTestId(`image-${target.id}`));
    fireEvent.click(await screen.findByTestId("image-detail-tag"));
    const dialog = await screen.findByTestId("tag-image-dialog");

    // A flag-shaped reference never reaches the bridge.
    fireEvent.change(within(dialog).getByTestId("tag-image-reference"), {
      target: { value: "--force" },
    });
    expect(within(dialog).getByTestId("tag-image-confirm")).toBeDisabled();
    expect(imageAction).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByTestId("tag-image-reference"), {
      target: { value: "registry.test/taggable:v2" },
    });
    fireEvent.click(within(dialog).getByTestId("tag-image-confirm"));
    await waitFor(() =>
      expect(imageAction).toHaveBeenCalledWith({
        context: "default",
        action: "tag",
        // The immutable ID, never "registry.test/taggable:latest".
        id: target.id,
        reference: "registry.test/taggable:v2",
      }),
    );
  });

  it("analyses an image for vulnerabilities only when asked", async () => {
    const target = image(51, "registry.test/scannable");
    const harness = createHost({
      listImages: vi.fn(async () => imageList([target])),
    });
    const inspect = vi.fn(async () => ({
      context: "default",
      source: "engine-api",
      image: {
        id: target.id,
        repoTags: ["registry.test/scannable:latest"],
        repoDigests: [],
        sizeBytes: 1_048_576,
        created: "2026-01-01T00:00:00Z",
        architecture: "amd64",
        os: "linux",
        labels: {},
        env: [],
        entrypoint: [],
        command: [],
        exposedPorts: [],
        rootFsLayers: ["sha256:a"],
      },
      history: [],
      document: {},
      observedAt,
    }));
    const scout = vi.fn(async () => ({
      context: "default",
      reference: "registry.test/scannable:latest",
      source: "cli-sarif",
      scanner: "docker scout 1.18.3",
      summary: { CRITICAL: 1, HIGH: 0, MEDIUM: 1, LOW: 0, UNSPECIFIED: 0 },
      total: 2,
      findings: [
        {
          id: "CVE-2026-1",
          severity: "CRITICAL" as const,
          score: 9.8,
          package: "openssl",
          installedVersion: "1.1.1",
          fixedVersion: "1.1.2",
        },
        {
          id: "CVE-2026-2",
          severity: "MEDIUM" as const,
          score: 5.3,
          package: "perl",
          installedVersion: "5.36",
          // Scout's own wording when nothing resolves the CVE.
          fixedVersion: "not fixed",
        },
      ],
      observedAt,
      limitations: [],
    }));
    if (harness.host.images) {
      harness.host.images.inspect = inspect;
      harness.host.images.scout = scout;
    }
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId("nav-images"));
    fireEvent.click(await screen.findByTestId(`image-${target.id}`));
    await screen.findByTestId("image-detail-panel");

    // Opening the panel must never trigger an analysis: the first run indexes the image.
    expect(scout).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByTestId("image-scout-run"));
    await waitFor(() =>
      expect(scout).toHaveBeenCalledWith({
        context: "default",
        reference: "registry.test/scannable:latest",
      }),
    );

    const findings = await screen.findByTestId("scout-findings");
    const rows = within(findings).getAllByRole("listitem");
    // Worst first: a vulnerability list ordered any other way buries the thing that matters.
    expect(rows[0]).toHaveTextContent("CVE-2026-1");
    expect(rows[0]).toHaveTextContent("fixed in 1.1.2");
    // "not fixed" is Scout's wording, not a version to upgrade to.
    expect(rows[1]).toHaveTextContent("no fix available");
    expect(rows[1]).not.toHaveTextContent("fixed in not fixed");
  });

  it("browses a volume through the helper container and previews a file", async () => {
    const harness = createHost();
    const files = vi.fn(async (request: { name: string; path?: string }) => ({
      context: "default",
      volume: request.name,
      source: "engine-api",
      // Paths come back relative to the volume root, never the helper's mount point.
      path: request.path ?? "/",
      entries:
        (request.path ?? "/") === "/"
          ? [
              {
                name: "sub",
                path: "/sub",
                sizeBytes: 0,
                mode: "drwxr-xr-x",
                modifiedAt: observedAt,
                isDir: true,
              },
              {
                name: "note.txt",
                path: "/note.txt",
                sizeBytes: 18,
                mode: "-rw-r--r--",
                modifiedAt: observedAt,
                isDir: false,
              },
            ]
          : [
              {
                name: "deep.txt",
                path: "/sub/deep.txt",
                sizeBytes: 7,
                mode: "-rw-r--r--",
                modifiedAt: observedAt,
                isDir: false,
              },
            ],
      truncated: false,
      observedAt,
      limitations: [],
    }));
    const fileRead = vi.fn(async () => ({
      context: "default",
      volume: "cache",
      path: "/note.txt",
      sizeBytes: 18,
      encoding: "utf-8" as const,
      content: "hello-from-volume\n",
      truncated: false,
      observedAt,
    }));
    if (harness.host.volumes) {
      harness.host.volumes.files = files;
      harness.host.volumes.fileRead = fileRead;
    }
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId("nav-volumes"));

    fireEvent.click(
      await screen.findByRole("button", { name: "Browse volume cache" }),
    );
    const browser = await screen.findByTestId("volume-browser");
    await waitFor(() =>
      expect(files).toHaveBeenCalledWith({
        context: "default",
        name: "cache",
        path: "/",
      }),
    );

    // A directory descends; the path stays volume-relative.
    fireEvent.click(within(browser).getByTestId("volume-file-sub"));
    await waitFor(() =>
      expect(files).toHaveBeenLastCalledWith({
        context: "default",
        name: "cache",
        path: "/sub",
      }),
    );

    // Back to the root, then a file opens a preview rather than descending.
    fireEvent.click(
      within(await screen.findByTestId("volume-browser")).getByRole("button", {
        name: "/",
      }),
    );
    fireEvent.click(await screen.findByTestId("volume-file-note.txt"));
    await waitFor(() =>
      expect(fileRead).toHaveBeenCalledWith({
        context: "default",
        name: "cache",
        path: "/note.txt",
      }),
    );
    expect(await screen.findByTestId("volume-file-preview")).toHaveTextContent(
      "hello-from-volume",
    );
  });

  it("lists Compose projects and gates take-down behind confirmation", async () => {
    const harness = createHost();
    const composeList = vi.fn(async () => ({
      context: "default",
      source: "cli-json",
      projects: [
        {
          name: "storefront",
          status: "exited(1), running(3)",
          states: [
            { state: "exited", count: 1 },
            { state: "running", count: 3 },
          ],
          configFiles: ["/srv/storefront/compose.yaml"],
          runningCount: 3,
          totalCount: 4,
        },
      ],
      observedAt,
      limitations: [],
    }));
    const composePs = vi.fn(async () => ({
      context: "default",
      project: "storefront",
      source: "cli-json",
      services: [
        {
          name: "storefront-api-1",
          service: "api",
          containerId: "abcdef012345",
          image: "team/api",
          state: "running",
          status: "Up 2 hours",
          health: "healthy",
          exitCode: 0,
          ports: "8080->80/tcp",
        },
      ],
      observedAt,
      limitations: [],
    }));
    const composeAction = vi.fn(async () => ({
      action: "down",
      project: "storefront",
      receipt: { operationId: "compose" },
    }));
    harness.host.compose = {
      list: composeList,
      ps: composePs,
      action: composeAction,
    };
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId("nav-compose"));

    // Compose's own status wording is broken into terms rather than shown as a raw string.
    const row = await screen.findByTestId("compose-project-storefront");
    expect(row).toHaveTextContent("running");
    expect(row).toHaveTextContent("exited");

    // Services load only when a project is expanded.
    expect(composePs).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("compose-expand-storefront"));
    await waitFor(() => expect(composePs).toHaveBeenCalled());
    expect(
      await screen.findByTestId("compose-services-storefront"),
    ).toHaveTextContent("api");

    // up carries the configuration files, because Compose cannot recreate without them.
    fireEvent.click(screen.getByTestId("compose-up-storefront"));
    await waitFor(() =>
      expect(composeAction).toHaveBeenCalledWith({
        context: "default",
        project: "storefront",
        action: "up",
        configFiles: ["/srv/storefront/compose.yaml"],
      }),
    );

    composeAction.mockClear();
    // down removes containers and networks, so it asks first.
    fireEvent.click(screen.getByTestId("compose-down-storefront"));
    expect(composeAction).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId("compose-down-dialog");
    // Volumes are opt-in inside the confirmation, never implied by the button.
    fireEvent.click(within(dialog).getByTestId("compose-down-volumes"));
    fireEvent.click(within(dialog).getByTestId("compose-down-confirm"));
    await waitFor(() =>
      expect(composeAction).toHaveBeenCalledWith({
        context: "default",
        project: "storefront",
        action: "down",
        confirmed: true,
        removeVolumes: true,
        // Ticking the box is the agreement to destroy data, which the core requires
        // separately from the confirmation to take the project down.
        confirmedRemoveVolumes: true,
      }),
    );
  });

  it("opens a Compose service in the container detail it maps to", async () => {
    // Compose does not need its own logs or exec surfaces: each service is a container the
    // detail screen already handles, so the row links through instead.
    const target = container(1);
    const harness = createHost({
      list: vi.fn(async () => containerList([target])),
    });
    harness.host.compose = {
      list: vi.fn(async () => ({
        context: "default",
        source: "cli-json",
        projects: [
          {
            name: "storefront",
            status: "running(1)",
            states: [{ state: "running", count: 1 }],
            configFiles: ["/srv/storefront/compose.yaml"],
            runningCount: 1,
            totalCount: 1,
          },
        ],
        observedAt,
        limitations: [],
      })),
      ps: vi.fn(async () => ({
        context: "default",
        project: "storefront",
        source: "cli-json",
        services: [
          {
            name: "storefront-api-1",
            service: "api",
            // Matches the container above, so the row is linkable.
            containerId: target.id,
            image: "alpine:3.20",
            state: "running",
            status: "Up",
            exitCode: 0,
          },
          {
            name: "storefront-gone-1",
            service: "gone",
            // No container: Compose can report a service whose container was removed.
            containerId: "",
            image: "alpine:3.20",
            state: "exited",
            status: "Exited",
            exitCode: 0,
          },
        ],
        observedAt,
        limitations: [],
      })),
      action: vi.fn(),
    };
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId("nav-compose"));
    fireEvent.click(await screen.findByTestId("compose-expand-storefront"));

    // The service without a container is plain text, not a link to nothing.
    expect(
      await screen.findByTestId("compose-service-open-api"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("compose-service-open-gone")).toBeNull();

    fireEvent.click(screen.getByTestId("compose-service-open-api"));
    // Lands on the container's own detail screen, on its logs.
    await screen.findByTestId("container-detail-screen");
  });

  it("reports an absent Compose plugin as a state rather than an error", async () => {
    const harness = createHost();
    harness.host.compose = {
      list: vi.fn(async () => {
        throw new Error(
          "compose_unavailable: The Docker Compose plugin is not installed for this Docker CLI.",
        );
      }),
      ps: vi.fn(),
      action: vi.fn(),
    };
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId("nav-compose"));

    // Compose is optional, so this is a described state with a fix, not a failure banner.
    const notice = await screen.findByTestId("compose-unavailable");
    expect(notice).toHaveTextContent("not installed");
  });

  it("exports a container filesystem to a host archive", async () => {
    const harness = createHost();
    const exportContainer = vi.fn(async () => ({
      action: "export",
      receipt: { operationId: "export" },
    }));
    if (harness.host.containers) {
      harness.host.containers.export = exportContainer;
    }
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(
      await screen.findByTestId(`container-row-${container(1).id}`),
    );

    fireEvent.click(await screen.findByTestId("container-export-open"));
    const dialog = await screen.findByTestId("container-export-dialog");
    fireEvent.change(
      within(dialog).getByTestId("container-export-dialog-path"),
      { target: { value: "/home/operator/container-1.tar" } },
    );
    fireEvent.click(
      within(dialog).getByTestId("container-export-dialog-confirm"),
    );
    await waitFor(() =>
      expect(exportContainer).toHaveBeenCalledWith({
        context: "default",
        id: container(1).id,
        archivePath: "/home/operator/container-1.tar",
      }),
    );
  });

  it("removes a dangling image by immutable id and force-removes an in-use image", async () => {
    // Both cases were previously unreachable: the delete control was disabled whenever the
    // image had no repo tag or still backed a container.
    const dangling = { ...image(21), repoTags: [], containers: 0 };
    const inUse = { ...image(22, "registry.test/busy"), containers: 2 };
    const harness = createHost({
      listImages: vi.fn(async () => imageList([dangling, inUse])),
    });
    const imageAction = vi.fn(
      async (request: Record<string, unknown>) => {
        void request;
        return { operationId: "image-remove" };
      },
    );
    if (harness.host.images) harness.host.images.action = imageAction;
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");
    fireEvent.click(screen.getByTestId("nav-images"));

    const danglingButton = await screen.findByRole("button", {
      name: "Remove <none>:<none>",
    });
    expect(danglingButton).not.toBeDisabled();
    fireEvent.click(danglingButton);
    fireEvent.click(await screen.findByTestId("delete-image-confirm"));
    await waitFor(() =>
      expect(imageAction).toHaveBeenCalledWith({
        context: "default",
        action: "remove",
        id: dangling.id,
        confirmed: true,
      }),
    );
    // No reference field at all: there is no tag to re-resolve.
    expect(imageAction.mock.calls[0][0]).not.toHaveProperty("reference");

    const busyButton = screen.getByRole("button", {
      name: "Remove registry.test/busy:latest",
    });
    expect(busyButton).not.toBeDisabled();
    expect(busyButton).toHaveAttribute("title", "In use — removing requires force");
    fireEvent.click(busyButton);
    const dialog = await screen.findByTestId("delete-image-dialog");
    expect(within(dialog).getByTestId("delete-image-confirm")).toHaveTextContent(
      "Force remove",
    );
    fireEvent.click(within(dialog).getByTestId("delete-image-confirm"));
    await waitFor(() =>
      expect(imageAction).toHaveBeenCalledWith({
        context: "default",
        action: "remove",
        id: inUse.id,
        reference: "registry.test/busy:latest",
        confirmed: true,
        force: true,
      }),
    );
  });

  it("reports successful mutations separately when reconciliation fails and never repeats the action", async () => {
    let failContainers = false;
    const list = vi.fn(async () => {
      if (failContainers) throw new Error("container refresh offline");
      return containerList([
        {
          ...container(1, "stopped-api"),
          state: "exited",
          status: "Exited (0)",
        },
      ]);
    });
    const harness = createHost({ list });
    const containerAction = vi.mocked(harness.host.containers?.action);
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId(`container-row-${container(1).id}`);
    failContainers = true;
    fireEvent.click(screen.getByTestId(`container-toggle-${container(1).id}`));

    expect(
      await screen.findByText(
        /Container start succeeded, but the live view could not be reconciled/u,
      ),
    ).toBeInTheDocument();
    expect(containerAction).toHaveBeenCalledTimes(1);
  });

  it("keeps successful image and volume removals authoritative when their list refreshes fail", async () => {
    let failImages = false;
    let failVolumes = false;
    const listImages = vi.fn(async () => {
      if (failImages) throw new Error("image refresh offline");
      return imageList([image(41, "registry.test/safe-remove")]);
    });
    const listVolumes = vi.fn(async () => {
      if (failVolumes) throw new Error("volume refresh offline");
      return volumeList([volume("safe-remove")]);
    });
    const harness = createHost({ listImages, listVolumes });
    const imageAction = vi.mocked(harness.host.images?.action);
    const volumeAction = vi.mocked(harness.host.volumes?.action);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId("containers-screen");

    fireEvent.click(screen.getByTestId("nav-images"));
    const removeImage = await screen.findByRole("button", {
      name: "Remove registry.test/safe-remove:latest",
    });
    await act(flushMicrotasks);
    failImages = true;
    fireEvent.click(removeImage);
    fireEvent.click(await screen.findByTestId("delete-image-confirm"));
    expect(
      await screen.findByText(
        /Image removal succeeded, but the live view could not be reconciled/u,
      ),
    ).toBeInTheDocument();
    expect(imageAction).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("nav-volumes"));
    const removeVolume = await screen.findByRole("button", {
      name: "Remove volume safe-remove",
    });
    await act(flushMicrotasks);
    failVolumes = true;
    fireEvent.click(removeVolume);
    expect(
      await screen.findByText(
        /Volume removal succeeded, but the live view could not be reconciled/u,
      ),
    ).toBeInTheDocument();
    expect(volumeAction).toHaveBeenCalledTimes(1);
  });
});
