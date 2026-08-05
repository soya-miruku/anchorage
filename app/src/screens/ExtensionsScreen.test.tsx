// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { AnchorageExtension } from "../types";
import { ExtensionsScreen } from "./ExtensionsScreen";

const EXTENSIONS: AnchorageExtension[] = [
  {
    name: "Disk usage",
    publisher: "Docker Inc.",
    description: "Reclaim space taken by images and build cache.",
    rating: "4.8",
    installs: "1.2M",
  },
];

function createStore(isHost: boolean): AnchorageStore {
  return {
    isHost,
    extensions: isHost ? [] : EXTENSIONS,
    installedExtensions: new Set<string>(),
    extensionSummary: "0 installed · 1 available in the marketplace",
    toggleExtension: vi.fn(),
    openCommandCenter: vi.fn(),
  } as unknown as AnchorageStore;
}

afterEach(cleanup);

describe("ExtensionsScreen", () => {
  it("states what an install grants before offering the install affordance", () => {
    render(<ExtensionsScreen store={createStore(false)} />);

    const disclosure = screen.getByTestId("extensions-privilege-disclosure");
    expect(disclosure).toHaveTextContent(/backend containers/);
    expect(disclosure).toHaveTextContent(/Docker\s+socket access/);
    expect(disclosure).toHaveTextContent(/executables on the host/);
    expect(
      disclosure.compareDocumentPosition(
        screen.getByRole("button", { name: "Install" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("declares itself unsupported rather than offering installs in host mode", () => {
    render(<ExtensionsScreen store={createStore(true)} />);

    expect(
      screen.queryByRole("button", { name: "Install" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Extensions is unavailable in this build"),
    ).toBeInTheDocument();
  });

  it("keeps the privilege disclosure in host mode, where the install is absent", () => {
    // The packaged build is the one users get. A disclosure that only appears where the
    // marketplace happens to be reachable is honesty as a side effect of the marketplace.
    render(<ExtensionsScreen store={createStore(true)} />);

    const posture = screen.getByTestId("extensions-screen-posture");
    expect(posture).toHaveTextContent(/backend containers/);
    expect(posture).toHaveTextContent(/Docker\s+socket access/);
    expect(posture).toHaveTextContent(/executables on the host/);
  });
});
