// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { EngineStatus } from "../types";
import { WorkspaceStateScreen } from "./WorkspaceStateScreen";

function createStore(engineStatus: EngineStatus): AnchorageStore {
  return {
    engineStatus,
    engineStatusMessage: "",
    retryEngine: vi.fn(async () => undefined),
  } as unknown as AnchorageStore;
}

afterEach(cleanup);

describe("WorkspaceStateScreen", () => {
  it("announces the transient loading state politely", () => {
    render(<WorkspaceStateScreen store={createStore("loading")} />);

    expect(screen.getByTestId("engine-state-loading")).toHaveAttribute(
      "role",
      "status",
    );
  });

  it.each<Exclude<EngineStatus, "ready" | "loading">>([
    "disconnected",
    "permission",
    "error",
  ])("announces the %s state assertively", (engineStatus) => {
    render(<WorkspaceStateScreen store={createStore(engineStatus)} />);

    expect(screen.getByTestId(`engine-state-${engineStatus}`)).toHaveAttribute(
      "role",
      "alert",
    );
  });

  it("renders nothing once the engine is ready", () => {
    const { container } = render(
      <WorkspaceStateScreen store={createStore("ready")} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
