// @vitest-environment jsdom

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
