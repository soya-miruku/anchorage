// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogsScreen } from "./LogsScreen";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { AnchorageContainer, LogLine } from "../types";

afterEach(cleanup);

const container = (name: string, state = "running"): AnchorageContainer =>
  ({
    id: `${name}-id`,
    name,
    image: `${name}:latest`,
    ports: "",
    state,
    rawState: state,
    status: "",
    exitCode: null,
    kind: "container",
    cpu: null,
    memory: null,
    memoryLimit: null,
    health: "—",
    cpuHistory: [],
    memoryHistory: [],
    labels: {},
    composeProject: null,
  }) as AnchorageContainer;

const line = (source: string, message: string): LogLine => ({
  id: `${source}-${message}`,
  timestamp: "12:00:00",
  level: "INFO",
  message,
  source,
});

function renderLogs(overrides: Partial<AnchorageStore> = {}) {
  const store = {
    isHost: true,
    containers: [container("api"), container("db"), container("old", "exited")],
    logSources: [],
    mergedLogLines: [],
    filteredLogLines: [],
    logStreamErrors: {},
    mergedLogFilter: "",
    mergedLogSourceLimit: 6,
    setMergedLogFilter: vi.fn(),
    toggleLogSource: vi.fn(),
    clearMergedLogs: vi.fn(),
    openCommandCenter: vi.fn(),
    ...overrides,
  } as unknown as AnchorageStore;
  render(<LogsScreen store={store} />);
  return store;
}

describe("LogsScreen", () => {
  it("offers only running containers as sources", () => {
    renderLogs();

    const sources = screen.getByTestId("logs-sources");
    expect(sources).toHaveTextContent("api");
    expect(sources).toHaveTextContent("db");
    // A stopped container has nothing to follow; offering it would produce a dead stream.
    expect(sources).not.toHaveTextContent("old");
  });

  it("asks for a source rather than showing an empty stream as if it were quiet", () => {
    renderLogs();

    expect(screen.getByTestId("logs-stream")).toHaveTextContent(
      "Select a container to start following",
    );
  });

  it("distinguishes a stream with nothing written from a filter that matched nothing", () => {
    renderLogs({ logSources: ["api-id"] });
    expect(screen.getByTestId("logs-stream")).toHaveTextContent(
      "Nothing has been written since the stream opened",
    );

    cleanup();
    renderLogs({
      logSources: ["api-id"],
      mergedLogLines: [line("api", "hello")],
      filteredLogLines: [],
      mergedLogFilter: "nope",
    });
    expect(screen.getByTestId("logs-stream")).toHaveTextContent(
      "No held line matches “nope”",
    );
  });

  it("labels every line with the container it came from", () => {
    // The whole point of an interleaved stream: a line with no source is unattributable.
    renderLogs({
      logSources: ["api-id", "db-id"],
      mergedLogLines: [line("api", "started"), line("db", "ready")],
      filteredLogLines: [line("api", "started"), line("db", "ready")],
    });

    const stream = screen.getByTestId("logs-stream");
    expect(stream).toHaveTextContent("api");
    expect(stream).toHaveTextContent("started");
    expect(stream).toHaveTextContent("db");
    expect(stream).toHaveTextContent("ready");
  });

  it("states the source cap instead of silently refusing the next selection", () => {
    renderLogs({
      logSources: ["a", "b", "c", "d", "e", "f"],
      mergedLogSourceLimit: 6,
    });

    expect(screen.getByTestId("logs-sources")).toHaveTextContent(
      "Following the maximum of 6",
    );
    // Unselected sources are disabled at the cap — but the reason is on screen above them.
    expect(screen.getAllByRole("checkbox")[0]).toBeDisabled();
  });

  it("reports a per-source stream failure without blanking the others", () => {
    renderLogs({
      logSources: ["api-id", "db-id"],
      logStreamErrors: { db: "The daemon stopped this log stream." },
      mergedLogLines: [line("api", "still going")],
      filteredLogLines: [line("api", "still going")],
    });

    expect(screen.getByTestId("logs-errors")).toHaveTextContent("db");
    // One unreadable source must not read as a dead stream for the rest.
    expect(screen.getByTestId("logs-stream")).toHaveTextContent("still going");
  });

  it("clears the held view without stopping the streams", () => {
    const store = renderLogs({
      logSources: ["api-id"],
      mergedLogLines: [line("api", "one")],
      filteredLogLines: [line("api", "one")],
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear view" }));
    expect(store.clearMergedLogs).toHaveBeenCalled();
    // Sources are untouched: "clear" that also unfollowed would be two actions in one label.
    expect(store.toggleLogSource).not.toHaveBeenCalled();
  });

  it("does not claim a live stream in browser preview", () => {
    renderLogs({ isHost: false });

    expect(screen.getByTestId("logs-screen")).toHaveTextContent(
      "never connects to one",
    );
    expect(screen.queryByTestId("logs-stream")).toBeNull();
  });
});
