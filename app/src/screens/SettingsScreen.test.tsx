// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { BuildBuilder, SystemSnapshot } from "../types";
import { SettingsScreen, type SettingsPaneId } from "./SettingsScreen";

const SNAPSHOT: SystemSnapshot = {
  context: "default",
  source: "engine-api",
  apiVersion: "1.51",
  engine: {
    apiVersion: "1.51",
    serverVersion: "28.0.0",
    osType: "linux",
    operatingSystem: "Arch Linux",
    architecture: "x86_64",
    cpus: 16,
    memoryBytes: 33 * 1024 ** 3,
    containers: 3,
    containersRunning: 1,
    containersPaused: 0,
    containersStopped: 2,
    images: 12,
    driver: "overlay2",
    dockerRootDir: "/var/lib/docker",
    experimental: false,
    liveRestoreEnabled: true,
    warnings: [],
  },
  diskUsage: {
    layersSizeBytes: 0,
    builderSizeBytes: 0,
    images: [],
    containers: [],
    volumes: [],
    buildCache: [],
    summary: {
      images: { totalCount: 0, activeCount: 0, sizeBytes: 0, reclaimableBytes: 0 },
      containers: { totalCount: 0, activeCount: 0, sizeBytes: 0, reclaimableBytes: 0 },
      volumes: { totalCount: 0, activeCount: 0, sizeBytes: 0, reclaimableBytes: 0 },
      buildCache: { totalCount: 0, activeCount: 0, sizeBytes: 0, reclaimableBytes: 0 },
    },
  },
  observedAt: "2026-08-04T00:00:00.000Z",
  endpointHash: "settings-test-endpoint",
  limitations: [],
} satisfies SystemSnapshot;

/**
 * What `docker buildx ls --format json` reports on a machine that once had Docker Desktop:
 * the working local builder, plus two entries whose sockets went away with the uninstall.
 * Buildx leaves those without a driver, without platforms and without a node status — the
 * error is all it has to say about them.
 */
const BUILDERS: BuildBuilder[] = [
  {
    name: "default",
    driver: "docker",
    current: true,
    nodes: [
      {
        name: "default",
        status: "running",
        version: "v0.0.0+unknown",
        platforms: ["linux/amd64", "linux/386"],
      },
    ],
  },
  {
    name: "desktop-linux",
    driver: "",
    current: false,
    error:
      "failed to connect to the docker API at unix:///home/soya/.docker/desktop/docker.sock: no such file or directory",
    nodes: [{ name: "", status: "", platforms: [] }],
  },
  {
    name: "podman",
    driver: "",
    current: false,
    error:
      "failed to connect to the docker API at unix:///run/user/1000/podman/podman.sock: no such file or directory",
    nodes: [{ name: "", status: "", platforms: [] }],
  },
];

function createStore(
  settingsTab: SettingsPaneId,
  overrides: Partial<AnchorageStore> = {},
): AnchorageStore {
  return {
    isHost: true,
    settingsTab,
    setSettingsTab: vi.fn(),
    systemSnapshot: SNAPSHOT,
    // The builders pane refreshes on mount and reads the same buildx inventory the Builds
    // screen does; an empty one is the honest default for panes that do not use it.
    buildBuilders: [],
    buildsStatus: "ready",
    buildsError: null,
    refreshBuilds: vi.fn(async () => {}),
    featureFlags: {
      kubernetes: false,
      automaticUpdates: true,
      betaChannel: false,
      buildkit: true,
      binaryEmulation: false,
      telemetry: false,
    },
    toggleFeatureFlag: vi.fn(),
    dockerContext: "default",
    // The engine pane reads the plugin directories; without a bridge it cannot render.
    bridge: {
      system: {
        plugins: vi.fn(async () => ({
          protocolVersion: "1" as const,
          plugins: [],
          searchPath: [],
          warnings: [],
          observedAt: "2026-08-04T00:00:00.000Z",
        })),
      },
    },
    ...overrides,
  } as unknown as AnchorageStore;
}

afterEach(cleanup);

describe("SettingsScreen engine pane", () => {
  it("reports the daemon booleans as facts, not as controls", () => {
    render(<SettingsScreen store={createStore("engine")} />);

    // These come from `docker info` and this build has nowhere to write them back. A
    // disabled switch would claim to be a control that was never here; a fact is a fact.
    expect(screen.getByTestId("engine-live-restore")).toHaveTextContent(
      "Enabled",
    );
    expect(screen.getByTestId("engine-experimental")).toHaveTextContent(
      "Disabled",
    );
    expect(screen.queryByRole("switch", { name: "Live restore" })).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Experimental features" }),
    ).toBeNull();
  });

  it("attributes each daemon fact to the key it was read from", () => {
    render(<SettingsScreen store={createStore("engine")} />);

    expect(screen.getByTestId("engine-live-restore")).toHaveTextContent(
      "daemon.json · live-restore",
    );
    expect(screen.getByTestId("engine-experimental")).toHaveTextContent(
      "daemon.json · experimental",
    );
  });

  it("leaves a real setting operable", () => {
    const store = createStore("kubernetes", { isHost: false });
    render(<SettingsScreen store={store} />);

    const kubernetes = screen.getByRole("switch", {
      name: "Enable Kubernetes",
    });
    expect(kubernetes).toBeEnabled();

    fireEvent.click(kubernetes);
    expect(store.toggleFeatureFlag).toHaveBeenCalledWith("kubernetes");
  });
});

describe("SettingsScreen builders pane", () => {
  it("is reachable from the settings navigation", () => {
    const store = createStore("appearance");
    render(<SettingsScreen store={store} />);

    fireEvent.click(screen.getByRole("button", { name: "Builders" }));
    expect(store.setSettingsTab).toHaveBeenCalledWith("builders");
  });

  it("marks the active builder and no other", () => {
    render(
      <SettingsScreen store={createStore("builders", { buildBuilders: BUILDERS })} />,
    );

    expect(screen.getByTestId("builder-default")).toHaveTextContent("Active");
    expect(screen.getByTestId("builder-desktop-linux")).not.toHaveTextContent(
      "Active",
    );
    expect(screen.getByTestId("builder-podman")).not.toHaveTextContent("Active");
  });

  it("reports each builder's driver, platforms and status", () => {
    render(
      <SettingsScreen store={createStore("builders", { buildBuilders: BUILDERS })} />,
    );

    const active = screen.getByTestId("builder-default");
    expect(active).toHaveTextContent("docker");
    expect(active).toHaveTextContent("linux/386, linux/amd64");
    expect(active).toHaveTextContent("running");
  });

  it("shows an unreachable builder with buildx's own reason", () => {
    render(
      <SettingsScreen store={createStore("builders", { buildBuilders: BUILDERS })} />,
    );

    // Hiding these is why an operator cannot tell why a build went somewhere unexpected:
    // naming one of them fails the build rather than falling back to the active builder.
    expect(screen.getByTestId("builder-desktop-linux")).toHaveTextContent("error");
    expect(screen.getByTestId("builder-error-desktop-linux")).toHaveTextContent(
      "/home/soya/.docker/desktop/docker.sock",
    );
    expect(screen.getByTestId("builders-unreachable-note")).toHaveTextContent(
      "2 builders are configured but unreachable",
    );
  });

  it("offers no control that would change the active builder", () => {
    render(
      <SettingsScreen store={createStore("builders", { buildBuilders: BUILDERS })} />,
    );

    // `docker buildx use` is the write path and this build has no verb for it, so the pane
    // reports the active builder instead of appearing to let anyone pick one.
    const navigation = screen.getByTestId("settings-navigation");
    for (const control of screen.queryAllByRole("button")) {
      expect(navigation).toContainElement(control);
    }
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.getByTestId("builders-read-only")).toHaveTextContent(
      "Anchorage does not switch builders",
    );
  });

  it("says buildx is absent rather than showing an empty inventory", () => {
    render(
      <SettingsScreen
        store={createStore("builders", { buildsStatus: "unavailable" })}
      />,
    );

    expect(screen.getByTestId("builders-unavailable")).toHaveTextContent(
      "the plugin is not installed",
    );
    expect(screen.queryByTestId("builders-table")).toBeNull();
  });

  it("does not present fixture builders as a live inventory", () => {
    render(
      <SettingsScreen
        store={createStore("builders", { isHost: false, buildBuilders: BUILDERS })}
      />,
    );

    expect(screen.queryByTestId("builders-table")).toBeNull();
    expect(screen.queryByText("default")).toBeNull();
    expect(screen.getByTestId("builders-fixture-note")).toHaveTextContent(
      "not connected to one",
    );
  });
});
