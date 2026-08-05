// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliPluginHealth } from "./CliPluginHealth";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { SystemPlugins } from "../types";

/**
 * The pane reads the report from the store rather than fetching it.
 *
 * It used to fetch on mount, which is why every assertion below waits. The report now lives in
 * the store because the sidebar gates rows on the same value and a repair here has to reach it —
 * so these render synchronously, and the waits are kept only where they still describe something.
 */
function createStore(
  report: SystemPlugins | Error,
  overrides: Partial<AnchorageStore> = {},
): AnchorageStore {
  const failed = report instanceof Error;
  return {
    dockerContext: "default",
    pluginReport: failed ? null : report,
    pluginReportStatus: failed ? "error" : "ready",
    pluginReportError: failed ? report.message : null,
    pluginRepairPending: null,
    refreshPlugins: vi.fn(async () => undefined),
    repairPlugin: vi.fn(async () => true),
    revealPath: vi.fn(async () => undefined),
    bridge: { desktop: { revealPath: vi.fn() } },
    ...overrides,
  } as unknown as AnchorageStore;
}

const HEALTHY: SystemPlugins = {
  protocolVersion: "1",
  plugins: [
    {
      name: "buildx",
      version: "0.35.0",
      status: "available",
      discoverySource: "docker-info",
      path: "/usr/lib/docker/cli-plugins/docker-buildx",
    },
  ],
  searchPath: ["/home/tester/.docker/cli-plugins", "/usr/lib/docker/cli-plugins"],
  warnings: [],
  observedAt: "2026-08-04T00:00:00.000Z",
};

const WITH_DANGLING_LINK: SystemPlugins = {
  ...HEALTHY,
  plugins: [
    ...HEALTHY.plugins,
    {
      name: "mcp",
      status: "broken",
      // The fault, not its wording, is what decides which repair the pane offers.
      fault: "dangling-link",
      discoverySource: "cli-plugins-dir",
      path: "/home/tester/.docker/cli-plugins/docker-mcp",
      availabilityNote:
        "A symbolic link pointing at /usr/lib/docker/cli-plugins/docker-mcp, which does not exist. Usually left behind when Docker Desktop was removed.",
    },
  ],
};

afterEach(cleanup);

describe("CliPluginHealth", () => {
  it("names the plugin the CLI silently ignored, and why", async () => {
    render(<CliPluginHealth store={createStore(WITH_DANGLING_LINK)} />);

    const faults = await screen.findByTestId("plugin-health-faults");
    // The command the user actually typed, so the row is findable from the symptom.
    expect(faults).toHaveTextContent("docker mcp");
    expect(faults).toHaveTextContent("Broken");
    // Without the missing target the user cannot tell stale Desktop residue from a plugin
    // that was never installed — which is the whole diagnosis.
    expect(faults).toHaveTextContent("/usr/lib/docker/cli-plugins/docker-mcp");
  });

  it("says plainly when nothing is being ignored, rather than showing an empty list", async () => {
    render(<CliPluginHealth store={createStore(HEALTHY)} />);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-health")).toHaveTextContent(
        "Nothing in the plugin directories is being ignored",
      );
    });
    expect(screen.queryByTestId("plugin-health-faults")).toBeNull();
  });

  it("counts loaded plugins separately from ignored ones", async () => {
    render(<CliPluginHealth store={createStore(WITH_DANGLING_LINK)} />);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-health")).toHaveTextContent(
        "1 loaded by the Docker CLI, 1 present but not loaded",
      );
    });
  });

  it("shows the search path in the CLI's own order", async () => {
    render(<CliPluginHealth store={createStore(HEALTHY)} />);

    await waitFor(() => {
      const paths = Array.from(
        screen.getByTestId("plugin-health").querySelectorAll("ol code"),
      ).map((node) => node.textContent);
      expect(paths).toEqual([
        "/home/tester/.docker/cli-plugins",
        "/usr/lib/docker/cli-plugins",
      ]);
    });
  });

  it("reports its own failure rather than implying a clean installation", async () => {
    render(<CliPluginHealth store={createStore(new Error("permission denied"))} />);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-health")).toHaveTextContent(
        "Could not read the plugin directories: permission denied",
      );
    });
    // An unreadable directory must not render as "nothing is being ignored".
    expect(screen.getByTestId("plugin-health")).not.toHaveTextContent(
      "Nothing in the plugin directories is being ignored",
    );
  });
});

/**
 * The remedies, which the pane used to describe and leave to the operator.
 *
 * Each fault the core reports names its own fix. What matters here is that the fix offered is the
 * one that applies: a link with no target can only be removed, and a file that merely lacks its
 * execute bit must not be deleted to solve that.
 */
describe("CliPluginHealth repairs", () => {
  const NOT_EXECUTABLE: SystemPlugins = {
    ...HEALTHY,
    plugins: [
      ...HEALTHY.plugins,
      {
        name: "model",
        status: "broken",
        fault: "not-executable",
        discoverySource: "cli-plugins-dir",
        path: "/home/tester/.docker/cli-plugins/docker-model",
        availabilityNote:
          "Present but not executable, so the Docker CLI does not load it. `chmod +x` makes it available.",
      },
    ],
  };

  it("asks before deleting, and deletes with the confirmation the core requires", () => {
    const store = createStore(WITH_DANGLING_LINK);
    render(<CliPluginHealth store={store} />);

    // One click arms it rather than acting: this removes a file from the operator's machine.
    fireEvent.click(screen.getByTestId("plugin-remove-mcp"));
    expect(store.repairPlugin).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("plugin-remove-confirm-mcp"));
    expect(store.repairPlugin).toHaveBeenCalledWith({
      name: "mcp",
      path: "/home/tester/.docker/cli-plugins/docker-mcp",
      action: "remove",
      confirmed: true,
    });
  });

  it("offers the execute bit only for the fault that is actually a missing execute bit", () => {
    const store = createStore(NOT_EXECUTABLE);
    render(<CliPluginHealth store={store} />);

    fireEvent.click(screen.getByTestId("plugin-enable-model"));
    // No confirmation: this adds a permission bit to a file that is already there, and the core
    // refuses the flag for this action precisely so agreeing to it cannot mean agreeing to a
    // deletion.
    expect(store.repairPlugin).toHaveBeenCalledWith({
      name: "model",
      path: "/home/tester/.docker/cli-plugins/docker-model",
      action: "enable",
    });

    cleanup();
    // A dangling link has no target to make executable, so the button is absent rather than
    // present and failing.
    render(<CliPluginHealth store={createStore(WITH_DANGLING_LINK)} />);
    expect(screen.queryByTestId("plugin-enable-mcp")).toBeNull();
  });

  it("re-reads on demand, because a plugin installed in a terminal changes nothing here", () => {
    const store = createStore(HEALTHY);
    render(<CliPluginHealth store={store} />);

    fireEvent.click(screen.getByTestId("plugin-health-recheck"));
    expect(store.refreshPlugins).toHaveBeenCalled();
  });

  it("keeps the report on screen when a repair fails, and says which act did not happen", () => {
    // The entries are still worth reading, and replacing them with the error would lose the
    // context the failure is about.
    render(
      <CliPluginHealth
        store={createStore(WITH_DANGLING_LINK, {
          pluginReportError: "permission denied",
        })}
      />,
    );

    expect(screen.getByTestId("plugin-health")).toHaveTextContent("permission denied");
    expect(screen.getByTestId("plugin-health-faults")).toHaveTextContent("docker mcp");
  });
});
