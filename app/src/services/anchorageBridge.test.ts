// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnchorageBridge } from "./anchorageBridge";

const fullId = "a".repeat(64);
const projection = {
  context: "default",
  source: "engine-api",
  apiVersion: "1.55",
  containers: [
    {
      id: fullId,
      name: "api-gateway",
      image: "node:20-alpine",
      state: "running",
      status: "Up 3 minutes",
      health: "healthy",
      ports: "8080:8080",
      cpu: 3.2,
      memory: 184,
      memoryLimit: 512,
    },
  ],
};

afterEach(() => {
  delete window.anchorage;
  vi.restoreAllMocks();
});

describe("host Anchorage bridge", () => {
  it("preserves every Docker state, raw status, exit code, and unknown metrics", async () => {
    const states = [
      "created",
      "running",
      "paused",
      "restarting",
      "removing",
      "exited",
      "dead",
    ];
    window.anchorage = {
      containers: {
        list: vi.fn().mockResolvedValue({
          ...projection,
          containers: states.map((state, index) => ({
            id: `${index}`.padStart(64, "0"),
            name: state,
            image: "alpine:3.20",
            state,
            status:
              state === "exited"
                ? "Exited (137) 4 seconds ago"
                : state[0].toLocaleUpperCase() + state.slice(1),
            ports: [],
          })),
        }),
        action: vi.fn(),
      },
    };

    const containers = await createAnchorageBridge().containers.list();

    expect(containers.map((item) => item.state)).toEqual(states);
    expect(containers[5]).toMatchObject({
      rawState: "exited",
      status: "Exited (137) 4 seconds ago",
      exitCode: 137,
    });
    expect(containers[0]).toMatchObject({
      cpu: null,
      memory: null,
      memoryLimit: null,
    });
  });

  it("preserves full daemon ids and uses locked explicit action payloads", async () => {
    const list = vi.fn().mockResolvedValue(projection);
    const action = vi.fn().mockResolvedValue({
      operationId: "op-1",
      status: "accepted",
    });
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: {
        data: "2026-08-02T12:34:56.789Z INFO server ready\n",
        encoding: "utf-8",
        bytes: 47,
        truncated: false,
      },
      stderr: { data: "", encoding: "utf-8", bytes: 0, truncated: false },
    });
    window.anchorage = {
      containers: { list, action },
      cli: { run },
    };

    const bridge = createAnchorageBridge();
    const containers = await bridge.containers.list();
    await bridge.containers.start(containers[0].id);
    const logs = await bridge.containers.logs(containers[0].id);

    expect(bridge.mode).toBe("host");
    expect(list).toHaveBeenCalledWith({ context: "default", all: true });
    expect(containers[0].id).toBe(fullId);
    expect(action).toHaveBeenCalledWith({
      context: "default",
      id: fullId,
      action: "start",
    });
    expect(run).toHaveBeenCalledWith({
      context: "default",
      argv: ["logs", "--timestamps", "--tail", "200", fullId],
      timeoutSeconds: 30,
    });
    expect(logs).toEqual([
      {
        id: "cli-log-0-0",
        timestamp: "12:34:56.789",
        level: "INFO",
        message: "INFO server ready",
      },
    ]);
  });

  it("uses allowlisted dotted invoke methods when namespaces are absent", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(projection)
      .mockResolvedValueOnce({ operationId: "op-2", status: "accepted" });
    window.anchorage = { invoke };

    const bridge = createAnchorageBridge();
    const containers = await bridge.containers.list();
    await bridge.containers.stop(containers[0].id);

    expect(invoke).toHaveBeenNthCalledWith(1, "containers.list", {
      context: "default",
      all: true,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "containers.action", {
      context: "default",
      id: fullId,
      action: "stop",
    });
  });

  it("adds the core confirmation proof only to an explicitly confirmed remove", async () => {
    const list = vi.fn().mockResolvedValue(projection);
    const action = vi.fn().mockResolvedValue({ operationId: "op-remove" });
    window.anchorage = { containers: { list, action } };

    const bridge = createAnchorageBridge();
    await bridge.containers.remove(fullId, "staging");

    expect(action).toHaveBeenCalledWith({
      context: "staging",
      id: fullId,
      action: "remove",
      options: { confirmed: true },
    });
  });

  it("routes final snapshot/detail/image/volume contracts with explicit context", async () => {
    const list = vi.fn().mockResolvedValue({
      ...projection,
      containers: [
        {
          ...projection.containers[0],
          ports: [
            {
              publicPort: 8080,
              privatePort: 80,
              hostIp: "127.0.0.1",
            },
          ],
        },
      ],
    });
    const snapshot = vi.fn().mockResolvedValue({
      context: "staging",
      source: "engine-api",
      apiVersion: "1.55",
      engine: {},
      diskUsage: {},
      observedAt: "2026-08-02T12:00:00.000Z",
      endpointHash: "endpoint",
      limitations: [],
    });
    const inspect = vi.fn().mockResolvedValue({
      context: "staging",
      source: "engine-api",
      container: { id: fullId, mounts: [] },
      document: { Id: fullId },
      observedAt: "2026-08-02T12:00:00.000Z",
    });
    const stats = vi.fn().mockResolvedValue({
      context: "staging",
      source: "engine-api",
      containerId: fullId,
      cpuPercent: 1,
      memoryUsageBytes: 2,
    });
    const listImages = vi.fn().mockResolvedValue({
      context: "staging",
      source: "engine-api",
      images: [],
      observedAt: "2026-08-02T12:00:00.000Z",
      limitations: [],
    });
    const imageAction = vi.fn().mockResolvedValue({
      action: "remove",
      receipt: { operationId: "image-operation" },
    });
    const listVolumes = vi.fn().mockResolvedValue({
      context: "staging",
      source: "engine-api",
      volumes: [],
      warnings: [],
      observedAt: "2026-08-02T12:00:00.000Z",
      limitations: [],
    });
    const volumeAction = vi.fn().mockResolvedValue({
      operationId: "volume-operation",
    });
    window.anchorage = {
      system: {
        capabilities: vi.fn(),
        snapshot,
      },
      containers: {
        list,
        action: vi.fn(),
        inspect,
        stats,
      },
      images: { list: listImages, action: imageAction },
      volumes: { list: listVolumes, action: volumeAction },
    };

    const bridge = createAnchorageBridge();
    const containers = await bridge.containers.list("staging");
    await bridge.system.snapshot("staging");
    await bridge.containers.inspect(fullId, "staging");
    await bridge.containers.stats(fullId, "staging");
    await bridge.images.list("staging");
    await bridge.images.action({
      context: "staging",
      action: "remove",
      id: `sha256:${fullId}`,
      reference: "registry.test/app:latest",
      confirmed: true,
    });
    await bridge.volumes.list("staging");
    await bridge.volumes.action({
      context: "staging",
      action: "remove",
      name: "cache",
      confirmed: true,
    });

    expect(containers[0].ports).toBe("127.0.0.1:8080->80");
    expect(snapshot).toHaveBeenCalledWith({ context: "staging" });
    expect(inspect).toHaveBeenCalledWith({ context: "staging", id: fullId });
    expect(stats).toHaveBeenCalledWith({ context: "staging", id: fullId });
    expect(listImages).toHaveBeenCalledWith({
      context: "staging",
      all: false,
      includeDangling: false,
    });
    expect(imageAction).toHaveBeenCalledWith({
      context: "staging",
      action: "remove",
      id: `sha256:${fullId}`,
      reference: "registry.test/app:latest",
      confirmed: true,
    });
    expect(listVolumes).toHaveBeenCalledWith({ context: "staging" });
    expect(volumeAction).toHaveBeenCalledWith({
      context: "staging",
      action: "remove",
      name: "cache",
      confirmed: true,
    });
  });

  it("subscribes to core and reconciliation lifecycle events with cleanup", () => {
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const subscribe = vi.fn(
      (event: string, listener: (payload: unknown) => void) => {
        const current = listeners.get(event) ?? new Set();
        current.add(listener);
        listeners.set(event, current);
        return () => current.delete(listener);
      },
    );
    window.anchorage = { subscribe };
    const bridge = createAnchorageBridge();
    const listener = vi.fn();
    const unsubscribe = bridge.events.subscribe(listener);

    listeners.get("core.status")?.forEach((emit) =>
      emit({ state: "ready" }),
    );
    listeners.get("reconciliation.required")?.forEach((emit) =>
      emit({
        operationId: "operation",
        context: "default",
        domain: "container",
        action: "remove",
        reason: "mutation_outcome_unknown",
      }),
    );

    expect(listener).toHaveBeenNthCalledWith(1, {
      event: "core.status",
      payload: { state: "ready" },
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      event: "reconciliation.required",
      payload: {
        operationId: "operation",
        context: "default",
        domain: "container",
        action: "remove",
        reason: "mutation_outcome_unknown",
      },
    });
    unsubscribe();
    expect(listeners.get("core.status")?.size).toBe(0);
    expect(listeners.get("reconciliation.requested")?.size).toBe(0);
    expect(listeners.get("reconciliation.required")?.size).toBe(0);
  });

  it("normalizes stateful window chrome and filters malformed native events", async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const unsubscribe = vi.fn();
    const minimize = vi.fn();
    const maximize = vi.fn().mockResolvedValue(true);
    const close = vi.fn();
    const isMaximized = vi.fn().mockResolvedValue(true);
    const setBackgroundColor = vi.fn();
    window.anchorage = {
      subscribe: vi.fn((event, listener) => {
        listeners.set(event, listener);
        return unsubscribe;
      }),
      window: {
        minimize,
        maximize,
        close,
        isMaximized,
        setBackgroundColor,
      },
    };

    const bridge = createAnchorageBridge();
    expect(await bridge.windowIsMaximized()).toBe(true);
    expect(await bridge.windowAction("maximize")).toBe(true);
    await bridge.windowAction("minimize");
    await bridge.windowAction("close");
    expect(maximize).toHaveBeenCalledOnce();
    expect(minimize).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();

    const listener = vi.fn();
    const remove = bridge.subscribeWindowMaximized(listener);
    listeners.get("window.maximized")?.("yes");
    listeners.get("window.maximized")?.(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(true);
    remove();
    expect(unsubscribe).toHaveBeenCalledOnce();

    await bridge.setWindowBackgroundColor("#00153C");
    expect(setBackgroundColor).toHaveBeenCalledWith("#00153c");
    await expect(
      bridge.setWindowBackgroundColor("rgb(0 21 60)"),
    ).rejects.toThrow(/opaque six-digit hexadecimal color/u);
    expect(setBackgroundColor).toHaveBeenCalledOnce();
  });
});

describe("fixture Anchorage window chrome", () => {
  it("is inert, restored, and still rejects unsafe native colors", async () => {
    const bridge = createAnchorageBridge();
    expect(bridge.mode).toBe("fixture");
    expect(await bridge.windowIsMaximized()).toBe(false);
    expect(await bridge.windowAction("maximize")).toBeUndefined();
    expect(typeof bridge.subscribeWindowMaximized(() => undefined)).toBe(
      "function",
    );
    await bridge.setWindowBackgroundColor("#ffffff");
    await expect(
      bridge.setWindowBackgroundColor("#ffffffff"),
    ).rejects.toThrow(/opaque six-digit hexadecimal color/u);
  });
});
