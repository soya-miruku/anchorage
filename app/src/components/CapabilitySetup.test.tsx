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
