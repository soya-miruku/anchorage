// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type {
  BuildBuilder,
  DockerCliPlugin,
  SystemPlugins,
  SystemSnapshot,
} from "../types";
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
    // The engine pane reads the plugin installation from the store, and the Capabilities section
    // beside it reads which absent destinations the operator asked to keep.
    pluginReport: {
      protocolVersion: "1" as const,
      plugins: [],
      searchPath: [],
      warnings: [],
      observedAt: "2026-08-04T00:00:00.000Z",
    },
    pluginReportStatus: "ready",
    pluginReportError: null,
    pluginRepairPending: null,
    refreshPlugins: vi.fn(async () => undefined),
    repairPlugin: vi.fn(async () => true),
    revealedCapabilities: [],
    setCapabilityRevealed: vi.fn(),
    runBuilderAction: vi.fn(async () => true),
    builderActionPending: null,
    builderActionError: null,
    revealPath: vi.fn(async () => undefined),
    bridge: { desktop: { revealPath: vi.fn() } },
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

  it("still offers no control that would change the active builder", () => {
    // The pane used to have no controls at all, and this asserted exactly that. It now starts
    // and removes a builder, because reporting an unreachable one while telling the operator to
    // go and run buildx themselves was the gap. What has not changed is the reason the original
    // assertion existed: `docker buildx use` rewrites the CLI configuration every tool on the
    // machine reads, so choosing the active builder is still not offered — and the core has no
    // verb for it either. This pins the narrower property instead of dropping the test.
    render(
      <SettingsScreen store={createStore("builders", { buildBuilders: BUILDERS })} />,
    );

    const labels = screen
      .queryAllByRole("button")
      .map((control) => (control.textContent ?? "").toLowerCase());
    for (const label of labels) {
      expect(label).not.toMatch(/\buse\b|make active|set active|switch to/u);
    }
    // The switches and sliders the host-candidate gate forbids stay absent.
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.getByTestId("builders-read-only")).toHaveTextContent(
      "Anchorage does not switch builders",
    );
  });

  it("starts an unreachable builder with buildx's own bootstrap, and asks before removing one", () => {
    const store = createStore("builders", { buildBuilders: BUILDERS });
    render(<SettingsScreen store={store} />);

    // `desktop-linux` is unreachable in the fixture, which is the case this exists for.
    fireEvent.click(screen.getByTestId("builder-bootstrap-desktop-linux"));
    expect(store.runBuilderAction).toHaveBeenCalledWith({
      name: "desktop-linux",
      action: "bootstrap",
    });

    // Removal is armed rather than performed, and states what goes with it — a build cache
    // nothing restores — in a row wide enough to read.
    fireEvent.click(screen.getByTestId("builder-remove-desktop-linux"));
    expect(
      screen.getByTestId("builder-remove-question-desktop-linux"),
    ).toHaveTextContent("build cache");
    fireEvent.click(screen.getByTestId("builder-remove-confirm-desktop-linux"));
    expect(store.runBuilderAction).toHaveBeenCalledWith({
      name: "desktop-linux",
      action: "remove",
      confirmed: true,
    });
  });

  it("does not offer to start a builder that is already running", () => {
    // `default` is running in the fixture. A bootstrap button there would be a control whose
    // whole effect is to succeed at something already true.
    render(
      <SettingsScreen store={createStore("builders", { buildBuilders: BUILDERS })} />,
    );

    expect(screen.queryByTestId("builder-bootstrap-default")).toBeNull();
    expect(screen.getByTestId("builder-remove-default")).toBeInTheDocument();
  });

  it("reports buildx's own refusal rather than restating it", () => {
    render(
      <SettingsScreen
        store={createStore("builders", {
          buildBuilders: BUILDERS,
          builderActionError: "ERROR: cannot remove the default builder",
        })}
      />,
    );

    expect(screen.getByTestId("builder-action-error")).toHaveTextContent(
      "cannot remove the default builder",
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

/**
 * Three panes that describe a machine this build is often not running on.
 *
 * v2.5's File sharing and Virtualisation are written for Docker Desktop: one picks a sharing
 * implementation, the other opens by asserting the Linux kernel "comes from a virtual machine".
 * Against a native Linux engine neither is true, and rendering either as controls would offer
 * settings that reach nothing. The rows exist rather than being omitted, because an operator who
 * goes looking should be told which case they are in, not find the row missing.
 */
describe("SettingsScreen host-shaped panes", () => {
  const withEngine = (operatingSystem: string, tab: SettingsPaneId) =>
    render(
      <SettingsScreen
        store={createStore(tab, {
          systemSnapshot: {
            ...SNAPSHOT,
            engine: { ...SNAPSHOT.engine, operatingSystem, osType: "linux" },
          },
        } as Partial<AnchorageStore>)}
      />,
    );

  it("says there is nothing to configure when the engine is native", () => {
    withEngine("CachyOS", "fileSharing");
    const pane = screen.getByTestId("file-sharing-native");
    expect(pane).toHaveTextContent(/Nothing to configure/i);
    expect(pane).toHaveTextContent("CachyOS");
  });

  it("does not claim a virtual machine it has not seen", () => {
    withEngine("CachyOS", "virtualisation");
    expect(screen.getByTestId("virtualisation-native")).toHaveTextContent(
      /No virtual machine is involved/i,
    );
    expect(screen.queryByTestId("virtualisation-desktop")).toBeNull();
  });

  it("defers to Docker Desktop when Docker reports Desktop", () => {
    // The opposite error matters too: telling someone with a VM that they do not have one.
    withEngine("Docker Desktop 4.30.0", "virtualisation");
    expect(screen.getByTestId("virtualisation-desktop")).toHaveTextContent(
      /Docker Desktop owns this setting/i,
    );
    expect(screen.queryByTestId("virtualisation-native")).toBeNull();
  });

  it("says Enterprise policy is unreadable rather than showing an empty list", () => {
    // An empty list would read as "no policies apply", which is a different claim.
    render(<SettingsScreen store={createStore("enterprise")} />);
    expect(screen.getByTestId("enterprise-unavailable")).toHaveTextContent(
      /cannot read what is in force/i,
    );
  });

  it("calls the engine pane what the handoff calls it", () => {
    render(<SettingsScreen store={createStore("engine")} />);
    const rail = screen.getByTestId("settings-navigation");
    expect(rail).toHaveTextContent("Engine");
    expect(rail.textContent).not.toMatch(/Docker Engine/);
  });
});

/**
 * Where a hidden destination goes.
 *
 * Gating the sidebar on an installed plugin only stops being a loss if the destination is still
 * named somewhere, with what it needs and a way to bring it back. That is this section, and it is
 * the half of the change that makes the other half honest.
 */
describe("SettingsScreen capabilities", () => {
  const installation = (
    plugins: Array<{
      name: string;
      status: DockerCliPlugin["status"];
      version?: string;
    }>,
  ): SystemPlugins => ({
    protocolVersion: "1" as const,
    plugins: plugins.map((plugin) => ({
      ...plugin,
      discoverySource: "cli-plugins-dir",
      path: `/home/tester/.docker/cli-plugins/docker-${plugin.name}`,
    })),
    searchPath: ["/home/tester/.docker/cli-plugins"],
    warnings: [],
    observedAt: "2026-08-04T00:00:00.000Z",
  });

  it("names every gated capability, installed or not", () => {
    render(
      <SettingsScreen
        store={createStore("engine", {
          pluginReport: installation([
            { name: "compose", status: "available", version: "v5.3.1" },
            { name: "mcp", status: "broken" },
          ]),
        })}
      />,
    );

    const pane = screen.getByTestId("settings-capabilities");
    // Including the ones with nothing installed: an absent row in the sidebar is only tolerable
    // because the capability is still listed here.
    for (const plugin of ["ai", "model", "agent", "mcp", "sbx", "compose", "buildx", "scout"]) {
      expect(screen.getByTestId(`capability-row-${plugin}`), plugin).toBeInTheDocument();
    }
    expect(pane).toHaveTextContent("Anchorage does not install these");
    expect(screen.getByTestId("capability-row-compose")).toHaveTextContent("v5.3.1");
  });

  it("offers to restore a hidden row, and only for a row that is actually hidden", () => {
    const store = createStore("engine", {
      pluginReport: installation([{ name: "compose", status: "available" }]),
    });
    render(<SettingsScreen store={store} />);

    fireEvent.click(screen.getByTestId("capability-reveal-toggle-model"));
    expect(store.setCapabilityRevealed).toHaveBeenCalledWith("models", true);

    // Compose and Scout are plugin-backed but never lose their rows, so a control here would be
    // a switch with nothing on the other end — Scout is absent in this fixture and still has
    // none, which is the point: the control follows whether the row can be hidden, not whether
    // the plugin is missing.
    expect(screen.queryByTestId("capability-reveal-toggle-compose")).toBeNull();
    expect(screen.queryByTestId("capability-reveal-toggle-scout")).toBeNull();
    // Nor does an installed capability: there is nothing to restore.
    cleanup();
    render(
      <SettingsScreen
        store={createStore("engine", {
          pluginReport: installation([{ name: "model", status: "available" }]),
        })}
      />,
    );
    expect(screen.queryByTestId("capability-reveal-toggle-model")).toBeNull();
  });

  it("reports a revealed row as pressed rather than as a switch", () => {
    // A role="switch" in any settings pane fails the host-candidate gate, which exists because
    // this application once shipped fixture switches that could not reach the engine.
    render(
      <SettingsScreen
        store={createStore("engine", {
          pluginReport: installation([]),
          revealedCapabilities: ["models"],
        })}
      />,
    );

    const toggle = screen.getByTestId("capability-reveal-toggle-model");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveTextContent("Shown in sidebar");
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });
});
