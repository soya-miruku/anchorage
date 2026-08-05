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

function logStore(overrides: Partial<AnchorageStore> = {}): AnchorageStore {
  return {
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
}

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

/**
 * A live stream that cannot be read while it is live.
 *
 * Two problems, one cause. The buffer holds 2000 lines and every one of them was rendered, so a
 * chunk arriving forced layout over the whole buffer — measured around 36 ms a frame. And the
 * pane scrolled itself to the bottom on every change, so scrolling up to read something was
 * undone by the next line to arrive.
 *
 * Virtualisation is the wrong tool here: `.logs-line__message` is `pre-wrap` with
 * `overflow-wrap: anywhere`, so rows have no fixed height and a fixed-row window would
 * mispositon every row after the first wrapped one. A tail window is the right shape instead —
 * output is followed, so the tail is what is being read — with the rest reachable on request.
 */
const manyLines = (count: number): LogLine[] =>
  Array.from({ length: count }, (_, i) => line("api", `message ${i}`));

describe("LogsScreen render window", () => {
  it("renders every line when the buffer is small", () => {
    renderLogs({
      logSources: ["api"],
      mergedLogLines: manyLines(20),
      filteredLogLines: manyLines(20),
    });
    expect(screen.getAllByText(/^message /u)).toHaveLength(20);
    expect(screen.queryByTestId("logs-earlier")).toBeNull();
  });

  it("holds back the earliest lines once the buffer is deep", () => {
    renderLogs({
      logSources: ["api"],
      mergedLogLines: manyLines(1200),
      filteredLogLines: manyLines(1200),
    });
    const rendered = screen.getAllByText(/^message /u);
    expect(rendered.length).toBeLessThan(1200);
    // The tail is what is being followed, so the newest line must be on screen.
    expect(screen.getByText("message 1199")).toBeInTheDocument();
    expect(screen.queryByText("message 0")).toBeNull();
  });

  it("says how many it is holding back rather than silently truncating", () => {
    // Silently dropping history from a log view is worse than a slow log view.
    renderLogs({
      logSources: ["api"],
      mergedLogLines: manyLines(1200),
      filteredLogLines: manyLines(1200),
    });
    expect(screen.getByTestId("logs-earlier")).toHaveTextContent(/earlier/i);
  });

  it("shows the whole buffer when asked", () => {
    renderLogs({
      logSources: ["api"],
      mergedLogLines: manyLines(1200),
      filteredLogLines: manyLines(1200),
    });
    fireEvent.click(screen.getByTestId("logs-show-earlier"));
    expect(screen.getByText("message 0")).toBeInTheDocument();
    expect(screen.queryByTestId("logs-earlier")).toBeNull();
  });
});

/**
 * Following the tail must not fight a reader who has scrolled up.
 *
 * The pane scrolled itself to the bottom on every change, so looking at something further back
 * was undone by the next line to arrive. jsdom performs no layout, so the geometry is injected —
 * the same approach the sidebar overflow test uses — because without it every offset is 0 and
 * the view reads as pinned no matter what.
 */
describe("LogsScreen follow behaviour", () => {
  // Only the geometry is stubbed. `scrollTop` is left as jsdom's own writable property: stubbing
  // it too made these tests pass with the fix reverted, because the stub's fallback fed the
  // effect's own writes back into the pin calculation.
  const stubGeometry = () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 1000,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 400,
    });
  };

  afterEach(() => {
    for (const prop of ["scrollHeight", "clientHeight"]) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  });

  const store = (count: number) =>
    logStore({
      logSources: ["api"],
      filteredLogLines: manyLines(count),
      mergedLogLines: manyLines(count),
    });

  it("keeps following while the reader is at the bottom", () => {
    stubGeometry();
    const { rerender } = render(<LogsScreen store={store(10)} />);
    const stream = screen.getByTestId("logs-stream");

    // 1000 - 600 - 400 = 0 from the bottom: still following.
    stream.scrollTop = 600;
    fireEvent.scroll(stream);
    rerender(<LogsScreen store={store(11)} />);

    expect(stream.scrollTop).toBe(1000);
  });

  it("stops following once the reader scrolls away from the bottom", () => {
    stubGeometry();
    const { rerender } = render(<LogsScreen store={store(10)} />);
    const stream = screen.getByTestId("logs-stream");

    // 1000 - 100 - 400 = 500 from the bottom: the reader is looking at something.
    stream.scrollTop = 100;
    fireEvent.scroll(stream);
    rerender(<LogsScreen store={store(11)} />);

    expect(stream.scrollTop).toBe(100);
  });
});
