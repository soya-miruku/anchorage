// @vitest-environment jsdom

import type { PluginPresence } from "./usePluginPresence";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UnsupportedSurface } from "./UnsupportedSurface";

afterEach(cleanup);

function renderSurface(commandQuery = "") {
  render(
    <UnsupportedSurface
      testId="extensions-screen"
      title="Extensions"
      description="The desktop host does not expose an extension marketplace or installed-extension provider."
      commandQuery={commandQuery}
      onOpenCommand={() => undefined}
    />,
  );
}

describe("UnsupportedSurface", () => {
  it("bounds the unavailability claim to this build, not to a host", () => {
    // Some of these gaps are a Docker feature this installation does not expose and others
    // are a view Anchorage has not built; in browser preview there is no host at all. The
    // one sentence that is true in every case is what this build can reach.
    renderSurface();

    expect(
      screen.getByText(
        "This reports what this Anchorage build can reach, not that the capability does not exist.",
      ),
    ).toBeInTheDocument();
  });

  it("still states that nothing is being simulated in its place", () => {
    renderSurface();

    expect(
      screen.getByText(
        "No fixture or simulated data is shown in packaged host mode.",
      ),
    ).toBeInTheDocument();
  });

  it("gives the block a heading under the screen title rather than a live region", () => {
    // The content is mounted with its text and never changes in place, so a live region here
    // could only ever announce the whole block — headline, prose and button — as one string.
    renderSurface();

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Extensions is unavailable in this build",
      }),
    ).toBeInTheDocument();
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it("promises a targeted palette only when it has a command to open on", () => {
    renderSurface("compose");
    expect(
      screen.getByRole("button", { name: "Open Command Center" }),
    ).toBeInTheDocument();

    cleanup();

    renderSurface();
    expect(
      screen.getByRole("button", { name: "Browse installed commands" }),
    ).toBeInTheDocument();
  });
});

/**
 * A faulty installation must not be reported as a missing one.
 *
 * On the reference host `docker ai` and `docker mcp` are dangling symlinks left by a removed
 * Docker Desktop. Before this, both screens told the operator to install a plugin that was
 * already "installed" — the one action that cannot help, since the dead link is what has to go.
 */
describe("UnsupportedSurface plugin state", () => {
  const surface = (presence: PluginPresence) =>
    render(
      <UnsupportedSurface
        testId="models-screen"
        title="Models"
        description="Needs the docker model plugin."
        commandQuery=""
        onOpenCommand={() => undefined}
        plugin={{ name: "model", presence }}
      />,
    );

  it("says a broken plugin is installed and broken, not missing", () => {
    surface({ kind: "broken", detail: "A symbolic link pointing at a path that does not exist." });
    const state = screen.getByTestId("models-screen-plugin-state");
    expect(state).toHaveTextContent(/installed and broken/i);
    expect(state).toHaveTextContent(/will not help/i);
  });

  it("says an absent plugin was actually checked", () => {
    surface({ kind: "absent" });
    expect(screen.getByTestId("models-screen-plugin-state")).toHaveTextContent(
      /Checked on this host/i,
    );
  });

  it("stops claiming the capability is unavailable once the plugin is present", () => {
    // The screen is what is missing at that point, not the capability, and saying otherwise
    // would send someone to reinstall something that is already working.
    surface({ kind: "present", detail: "version 1.2.0" });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/not built yet/i);
    expect(screen.getByTestId("models-screen-plugin-state")).toHaveTextContent(
      /installed here/i,
    );
  });

  it("asserts nothing before the report has arrived", () => {
    surface({ kind: "unknown" });
    expect(screen.queryByTestId("models-screen-plugin-state")).toBeNull();
  });
});
