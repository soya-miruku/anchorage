// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CapabilitySetup } from "./CapabilitySetup";
import { capabilityForView } from "../data/capabilities";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { DockerCliPlugin, SystemPlugins } from "../types";

/**
 * The screen behind a destination that is nothing but a Docker CLI plugin.
 *
 * What it replaced said "this is unavailable in this build" whether or not the plugin was there,
 * and offered one button that opened the Command Center. So these assert the three things it can
 * now do that the old screen could not: report the real state, carry out the repair when the
 * fault is repairable here, and give an install instruction that is true for this machine.
 */

const report = (plugins: DockerCliPlugin[]): SystemPlugins => ({
  protocolVersion: "1",
  plugins,
  // Detected by the core; without it no command is offered, which is its own test below.
  packageManager: { name: "apt-get" },
  searchPath: ["/home/tester/.docker/cli-plugins", "/usr/lib/docker/cli-plugins"],
  warnings: [],
  observedAt: "2026-08-05T00:00:00.000Z",
});

function createStore(overrides: Partial<AnchorageStore> = {}): AnchorageStore {
  return {
    isHost: true,
    pluginReport: report([]),
    pluginReportStatus: "ready",
    pluginReportError: null,
    pluginRepairPending: null,
    revealedCapabilities: [],
    refreshPlugins: vi.fn(async () => undefined),
    repairPlugin: vi.fn(async () => true),
    installCapability: vi.fn(async () => true),
    dismissCapabilityInstall: vi.fn(),
    capabilityInstalling: null,
    capabilityInstallError: null,
    capabilityInstalled: null,
    setCapabilityRevealed: vi.fn(),
    revealPath: vi.fn(async () => undefined),
    openCommandCenter: vi.fn(),
    bridge: { desktop: { revealPath: vi.fn() } },
    ...overrides,
  } as unknown as AnchorageStore;
}

function renderModels(overrides: Partial<AnchorageStore> = {}) {
  const capability = capabilityForView("models");
  if (!capability) throw new Error("models is missing from the catalogue");
  const store = createStore(overrides);
  render(
    <CapabilitySetup
      store={store}
      capability={capability}
      testId="models-screen"
      posture="The inference endpoint has no authentication by default."
    />,
  );
  return store;
}

afterEach(cleanup);

describe("CapabilitySetup state", () => {
  it("reports the plugin's real state rather than asserting it is unavailable", () => {
    renderModels({ pluginReport: report([]) });
    expect(screen.getByTestId("capability-state-absent")).toHaveTextContent(
      "Not installed",
    );

    cleanup();
    renderModels({
      pluginReport: report([
        {
          name: "model",
          version: "1.2.0",
          status: "available",
          discoverySource: "docker-info",
        },
      ]),
    });
    // Installed but with no screen behind it yet: the honest statement is that the missing
    // thing is the screen, and no install command will change that.
    expect(screen.getByTestId("capability-state-installed")).toBeInTheDocument();
    expect(screen.getByTestId("models-screen")).toHaveTextContent(
      "What is missing is this screen, not the capability",
    );
    expect(screen.queryByText("Installing it")).toBeNull();
  });

  it("says nothing about the machine when the installation has not been read", () => {
    renderModels({ pluginReport: null, pluginReportStatus: "idle" });
    expect(screen.getByTestId("capability-state-unknown")).toBeInTheDocument();
    // Not "not installed": nobody has looked.
    expect(screen.getByTestId("models-screen")).toHaveTextContent(
      "nothing here is a claim about what is installed",
    );
  });

  it("states the posture whether or not the capability is reachable", () => {
    // Saying so only when a plugin happens to be installed would make the honesty a side
    // effect of the installation. Guarded by screens/destinations.test.tsx too.
    for (const pluginReport of [null, report([]), report([
      { name: "model", status: "available", discoverySource: "docker-info" },
    ])]) {
      renderModels({ pluginReport });
      expect(screen.getByTestId("models-screen-posture")).toHaveTextContent(
        "no authentication by default",
      );
      cleanup();
    }
  });
});

describe("CapabilitySetup install guidance", () => {
  it("gives the command Docker publishes, and the directory any plugin goes in", () => {
    const store = renderModels();
    const screenNode = screen.getByTestId("models-screen");

    expect(screenNode).toHaveTextContent("docker-model-plugin");
    // The mechanics are what make the re-check meaningful: the operator can put a binary in
    // place from anywhere and Anchorage notices without a restart.
    expect(screenNode).toHaveTextContent("docker-<name>");
    // The first search-path entry, taken from the report rather than assembled — it honours
    // DOCKER_CONFIG, which the renderer cannot see.
    expect(screenNode).toHaveTextContent("/home/tester/.docker/cli-plugins");

    fireEvent.click(screen.getByTestId("capability-reveal-model"));
    expect(store.revealPath).toHaveBeenCalledWith("/home/tester/.docker/cli-plugins");
  });

  it("offers no command at all when the host's package manager is unknown", () => {
    // A fallback would look authoritative and fail. The directory route is true everywhere and
    // is what the screen leans on instead.
    renderModels({
      pluginReport: {
        protocolVersion: "1",
        plugins: [],
        searchPath: ["/home/tester/.docker/cli-plugins"],
        warnings: [],
        observedAt: "2026-08-06T00:00:00.000Z",
      } as SystemPlugins,
    });
    expect(screen.getByTestId("models-screen")).not.toHaveTextContent("apt-get");
    expect(screen.getByTestId("models-screen")).toHaveTextContent("docker-<name>");
  });

  it("gives an Arch host its own command, not a Debian one", () => {
    renderModels({
      pluginReport: {
        protocolVersion: "1",
        plugins: [],
        packageManager: { name: "pacman", helper: "paru" },
        searchPath: ["/home/tester/.docker/cli-plugins"],
        warnings: [],
        observedAt: "2026-08-06T00:00:00.000Z",
      } as SystemPlugins,
    });
    const node = screen.getByTestId("models-screen");
    expect(node).toHaveTextContent("paru -S docker-model-plugin");
    expect(node).not.toHaveTextContent("apt-get");
    // The recipe is third-party even where the source it builds is Docker's own.
    expect(node).toHaveTextContent("maintained outside Docker");
  });

  it("re-reads the installation on demand", () => {
    // The gap this closes: a plugin installed in a terminal while the screen was open used to
    // be invisible until the operator navigated away and back.
    const store = renderModels();
    fireEvent.click(screen.getByTestId("capability-recheck-model"));
    expect(store.refreshPlugins).toHaveBeenCalled();
  });
});

describe("CapabilitySetup repairs", () => {
  const brokenTools = (
    note: string,
    fault: DockerCliPlugin["fault"] = "dangling-link",
  ) => {
    const capability = capabilityForView("tools");
    if (!capability) throw new Error("tools is missing from the catalogue");
    const store = createStore({
      pluginReport: report([
        {
          name: "mcp",
          status: "broken",
          fault,
          discoverySource: "cli-plugins-dir",
          path: "/home/tester/.docker/cli-plugins/docker-mcp",
          availabilityNote: note,
        },
      ]),
    });
    render(
      <CapabilitySetup
        store={store}
        capability={capability}
        testId="tools-screen"
        posture="Containerising a tool server does not reduce the authority you granted it."
      />,
    );
    return store;
  };

  it("offers to clear a link whose target is gone, and asks first", () => {
    const store = brokenTools(
      "A symbolic link pointing at /usr/lib/docker/cli-plugins/docker-mcp, which does not exist. Usually left behind when Docker Desktop was removed.",
    );

    expect(screen.getByTestId("capability-state-broken")).toBeInTheDocument();
    // The core's own diagnosis, which is the difference between Desktop residue and a plugin
    // that was never installed.
    expect(screen.getByTestId("capability-repair-mcp")).toHaveTextContent(
      "which does not exist",
    );

    fireEvent.click(screen.getByTestId("capability-remove-mcp"));
    expect(store.repairPlugin).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("capability-remove-confirm-mcp"));
    expect(store.repairPlugin).toHaveBeenCalledWith({
      name: "mcp",
      path: "/home/tester/.docker/cli-plugins/docker-mcp",
      action: "remove",
      confirmed: true,
    });
  });

  it("offers the execute bit only for the fault that is a missing execute bit", () => {
    brokenTools("A symbolic link pointing at /gone, which does not exist.");
    // A dangling link has no target to chmod, so the button is absent rather than present
    // and failing.
    expect(screen.queryByTestId("capability-enable-mcp")).toBeNull();

    cleanup();
    const store = brokenTools(
      "Present but not executable, so the Docker CLI does not load it. `chmod +x` makes it available.",
      "not-executable",
    );
    fireEvent.click(screen.getByTestId("capability-enable-mcp"));
    expect(store.repairPlugin).toHaveBeenCalledWith({
      name: "mcp",
      path: "/home/tester/.docker/cli-plugins/docker-mcp",
      action: "enable",
    });
  });

  it("still explains how to install it, since a broken entry means it is not there either", () => {
    brokenTools("A symbolic link pointing at /gone, which does not exist.");
    expect(screen.getByTestId("tools-screen")).toHaveTextContent("Installing it");
  });
});

describe("CapabilitySetup sidebar row", () => {
  it("offers to hide the row only when the operator is the reason it is there", () => {
    // Hiding a row that is visible on its own merits would strand the destination.
    renderModels({ revealedCapabilities: [] });
    expect(screen.queryByTestId("capability-hide-model")).toBeNull();

    cleanup();
    const store = renderModels({ revealedCapabilities: ["models"] });
    fireEvent.click(screen.getByTestId("capability-hide-model"));
    expect(store.setCapabilityRevealed).toHaveBeenCalledWith("models", false);
  });

  it("does not offer to hide a row whose plugin is installed", () => {
    renderModels({
      revealedCapabilities: ["models"],
      pluginReport: report([
        { name: "model", status: "available", discoverySource: "docker-info" },
      ]),
    });
    expect(screen.queryByTestId("capability-hide-model")).toBeNull();
  });
});

/**
 * Anchorage installing the plugin itself.
 *
 * These pin the boundary rather than the button. What may be installed is a short allowlist in
 * the core, mirrored in `installableCapability`, and the reason it is an allowlist rather than a
 * property on each catalogue entry is that a general "install this URL" control aimed at a
 * directory the Docker CLI runs is precisely what an attacker reaching the RPC boundary wants.
 */
describe("CapabilitySetup direct install", () => {
  function renderCapability(
    view: "models" | "agents" | "tools",
    overrides: Partial<AnchorageStore> = {},
  ) {
    const capability = capabilityForView(view);
    if (!capability) throw new Error(`${view} is missing from the catalogue`);
    const store = createStore(overrides);
    render(
      <CapabilitySetup
        store={store}
        capability={capability}
        testId={`${view}-screen`}
        posture="A posture statement."
      />,
    );
    return store;
  }

  it("offers to install a plugin binary Docker publishes a release for", () => {
    const store = renderCapability("agents");
    fireEvent.click(screen.getByRole("button", { name: "Install for me" }));
    expect(store.installCapability).toHaveBeenCalledWith("agent");
  });

  it("does not offer to install anything needing root", () => {
    // Models is a distribution package. Installing one needs privilege the core must never
    // have, so the command stays the only honest answer however convenient a button would be.
    renderCapability("models");
    expect(screen.queryByTestId("capability-install-model")).toBeNull();
    expect(screen.queryByRole("button", { name: "Install for me" })).toBeNull();
  });

  it("states the limit of what the digest proves, beside the button rather than after it", () => {
    // A verified digest binds the bytes to what GitHub's API said the release contained. It is
    // not a publisher signature, and an operator deciding whether to run someone else's binary
    // needs that at the moment of deciding.
    renderCapability("tools");
    const pane = screen.getByTestId("capability-install-mcp");
    expect(pane).toHaveTextContent(/SHA-256/u);
    expect(pane).toHaveTextContent(/not a publisher signature/u);
    expect(pane).toHaveTextContent(/No root needed/u);
  });

  it("reports where the plugin landed and what its digest was", () => {
    renderCapability("tools", {
      capabilityInstalled: {
        protocolVersion: "1",
        capability: "mcp",
        plugin: "mcp",
        path: "/home/tester/.docker/cli-plugins/docker-mcp",
        repository: "docker/mcp-gateway",
        release: "v0.43.3",
        asset: "docker-mcp-linux-amd64.tar.gz",
        sha256: "23d33c3b8a988ac7bf7231785b5dca23189a5145c15cec8b7fa2ae08e888cc14",
        assetSha256: "d39702b4c150d5e96e59cf3d90a28b9bb2a85ca81ddd05d87126be0849232049",
        sizeBytes: 46_571_704,
        installedAt: "2026-08-06T12:35:27.159Z",
      },
    });
    const done = screen.getByTestId("capability-installed");
    expect(done).toHaveTextContent("v0.43.3");
    expect(done).toHaveTextContent("/home/tester/.docker/cli-plugins/docker-mcp");
    expect(done).toHaveTextContent("23d33c3b");
  });

  it("does not report one capability's install under another", () => {
    // The result is a single slot on the store, so a stale one from a previous install would
    // otherwise appear as a success under whichever capability is on screen next.
    renderCapability("agents", {
      capabilityInstalled: {
        plugin: "mcp",
        path: "/home/tester/.docker/cli-plugins/docker-mcp",
        release: "v0.43.3",
        sha256: "23d33c3b",
      } as never,
    });
    expect(screen.queryByTestId("capability-installed")).toBeNull();
  });

  it("disables the button while that install is running", () => {
    renderCapability("tools", { capabilityInstalling: "mcp" });
    expect(screen.getByRole("button", { name: "Installing…" })).toBeDisabled();
  });
});
