// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliPluginHealth } from "./CliPluginHealth";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { SystemPlugins } from "../types";

function createStore(report: SystemPlugins | Error): AnchorageStore {
  return {
    dockerContext: "default",
    bridge: {
      system: {
        plugins: vi.fn(async () => {
          if (report instanceof Error) throw report;
          return report;
        }),
      },
    },
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
