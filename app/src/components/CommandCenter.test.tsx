// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { createFixtureCapabilities } from "../data/commandFixtures";
import { TerminalSurface } from "./CommandTerminal";
import type {
  HostAnchorageApi,
  SessionEvent,
  SessionOutputPayload,
  SessionStartParams,
} from "../types";

const fullId = "a".repeat(64);
const canonicalSessionId = "11111111-1111-4111-8111-111111111111";
const projection = {
  context: "staging",
  source: "engine-api",
  containers: [
    {
      id: fullId,
      name: "context-api",
      image: "node:22-alpine",
      state: "running",
      status: "Up",
      health: "healthy",
      ports: [],
      cpu: 2,
      memory: 128,
      memoryLimit: 512,
    },
  ],
};

function createHostHarness(
  options: { plugins?: unknown } = {},
) {
  const eventListeners = new Map<
    string,
    Set<(payload: unknown) => void>
  >();
  const capabilities = vi.fn(
    async (request?: { context?: string }) =>
      createFixtureCapabilities(request?.context ?? "staging"),
  );
  const list = vi.fn().mockResolvedValue(projection);
  const action = vi.fn().mockResolvedValue({ operationId: "operation-1" });
  const cliRun = vi.fn().mockResolvedValue({
    stdout: {
      data: "2026-08-02T12:00:00.000Z INFO context log\n",
      encoding: "utf-8",
      bytes: 45,
      truncated: false,
    },
    stderr: { data: "", encoding: "utf-8", bytes: 0, truncated: false },
  });
  const start = vi.fn(async (request: SessionStartParams) => ({
    // The docker events stream is a separate long-lived session; give it its own id so it
    // cannot be mistaken for the command session under test.
    sessionId:
      request.argv[0] === "events" ? "events-session" : canonicalSessionId,
    mode: request.mode,
    targetMode: request.targetMode ?? "pinned",
    pid: 777,
    context: request.context,
    executable: "/usr/bin/docker",
    argv:
      request.targetMode === "literal"
        ? request.argv
        : ["--context", request.context, ...request.argv],
    cwd: request.cwd ?? "/home/soya",
    rows: request.rows,
    cols: request.cols,
    outputWindowBytes: 262_144,
    maxOutputBytes: 0,
    startedAt: "2026-08-02T12:00:00.000Z",
  }));
  const input = vi.fn().mockResolvedValue({
    sessionId: canonicalSessionId,
    acceptedBytes: 1,
    eof: false,
  });
  const resize = vi.fn().mockResolvedValue({
    sessionId: canonicalSessionId,
    rows: 44,
    cols: 160,
  });
  const signal = vi.fn().mockResolvedValue({ accepted: true });
  const cancel = vi.fn().mockResolvedValue({
    sessionId: canonicalSessionId,
    accepted: true,
    state: "canceling",
  });
  const ack = vi.fn().mockResolvedValue({
    sessionId: canonicalSessionId,
    throughSequence: 1,
    outstandingBytes: 0,
  });
  const subscribe = vi.fn(
    (event: string, listener: (payload: unknown) => void) => {
      const listeners = eventListeners.get(event) ?? new Set();
      listeners.add(listener);
      eventListeners.set(event, listeners);
      return () => listeners.delete(listener);
    },
  );
  const plugins = vi.fn(async () => options.plugins ?? {
    protocolVersion: "1",
    plugins: [],
    searchPath: [],
    warnings: [],
    observedAt: "2026-08-06T00:00:00.000Z",
  });
  const host: HostAnchorageApi = {
    system: { capabilities, plugins },
    containers: { list, action },
    cli: { run: cliRun },
    session: { start, input, resize, signal, cancel, ack },
    subscribe,
  };
  const emit = <T extends SessionEvent>(
    event: T["event"],
    payload: T["payload"],
  ) => {
    eventListeners.get(event)?.forEach((listener) => listener(payload));
  };
  const emitHost = (event: string, payload: unknown) => {
    eventListeners.get(event)?.forEach((listener) => listener(payload));
  };
  return {
    host,
    capabilities,
    plugins,
    list,
    action,
    cliRun,
    start,
    input,
    resize,
    cancel,
    ack,
    subscribe,
    emit,
    emitHost,
  };
}

async function openCommandCenter() {
  fireEvent.keyDown(window, {
    key: "P",
    ctrlKey: true,
    shiftKey: true,
  });
  return screen.findByRole("dialog", { name: "Run a Docker command" });
}

/** Search, then take the first match. The path every other test starts from. */
async function chooseCommand(dialog: HTMLElement, term: string) {
  fireEvent.change(within(dialog).getByPlaceholderText("e.g. compose up"), {
    target: { value: term },
  });
  fireEvent.click(
    await within(dialog).findByRole("option", {
      name: new RegExp(term, "iu"),
    }),
  );
}

beforeEach(() => {
  delete window.anchorage;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Docker Command Center", () => {
  it("stays invisible until invoked, discovers recursive leaves, and restores search after closing", async () => {
    render(<App />);
    await screen.findByTestId("container-row-a91f2c4d");
    expect(screen.queryByTestId("command-center")).not.toBeInTheDocument();

    const dialog = await openCommandCenter();
    fireEvent.change(within(dialog).getByPlaceholderText("e.g. compose up"), {
      target: { value: "compose up" },
    });
    const composeUp = await within(dialog).findByRole("option", {
      name: /compose up/i,
    });
    fireEvent.click(composeUp);
    expect(within(dialog).getByLabelText("Argument 0")).toHaveValue("compose");
    expect(within(dialog).getByLabelText("Argument 1")).toHaveValue("up");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("command-center")).not.toBeInTheDocument(),
    );

    const globalSearch = screen.getByTestId("global-search");
    fireEvent.change(globalSearch, { target: { value: "postgres" } });
    fireEvent.change(globalSearch, { target: { value: ">image prune" } });
    const reopened = await screen.findByRole("dialog");
    expect(within(reopened).getByPlaceholderText("e.g. compose up")).toHaveValue(
      "image prune",
    );
    fireEvent.click(
      within(reopened).getByRole("button", {
        name: "Close Command Center",
      }),
    );
    await waitFor(() => expect(globalSearch).toHaveValue("postgres"));
  });

  /**
   * The complexity complaint, as a test.
   *
   * Discovery, an argv composer and a terminal used to be on screen together from the moment
   * the dialog opened, so the first thing an operator saw included an empty terminal for a
   * session that did not exist and an editor for a command they had not picked. Each step now
   * appears when there is something in it, and this asserts that ordering rather than the
   * markup that currently implements it.
   */
  it("shows one step at a time: search, then the command, then its output", async () => {
    const harness = createHostHarness();
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId(`container-row-${fullId}`);
    const dialog = await openCommandCenter();

    expect(within(dialog).getByPlaceholderText("e.g. compose up")).toBeVisible();
    expect(within(dialog).queryByTestId("argv-rows")).toBeNull();
    expect(
      within(dialog).queryByTestId("command-terminal-transcript"),
    ).toBeNull();

    await chooseCommand(dialog, "version");
    expect(within(dialog).getByTestId("argv-rows")).toBeInTheDocument();
    expect(within(dialog).queryByPlaceholderText("e.g. compose up")).toBeNull();
    expect(
      within(dialog).queryByTestId("command-terminal-transcript"),
    ).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Run command" }));
    await waitFor(() =>
      expect(
        within(dialog).getByTestId("command-terminal-transcript"),
      ).toBeInTheDocument(),
    );
  });

  it("names the exact command line, context included, before anything runs", async () => {
    // "Check what it will do" is a step, and it cannot be done from a column of argv boxes
    // that says nothing about the context Anchorage will insert in front of them.
    const harness = createHostHarness();
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId(`container-row-${fullId}`);
    const dialog = await openCommandCenter();
    await chooseCommand(dialog, "compose up");

    expect(within(dialog).getByTestId("command-preview")).toHaveTextContent(
      "docker --context staging compose up",
    );

    fireEvent.change(
      within(dialog).getByLabelText("Docker target mode"),
      { target: { value: "literal" } },
    );
    // Literal mode does not insert the context, and the preview stops claiming it does.
    expect(within(dialog).getByTestId("command-preview")).toHaveTextContent(
      "docker compose up",
    );
    expect(
      within(dialog).getByTestId("command-preview"),
    ).not.toHaveTextContent("--context");
  });

  it("moves through the results with the arrow keys and chooses with Enter", async () => {
    // A command palette that can only be driven with the mouse is not a command palette. The
    // fixture's compose leaves sort down, logs, ps, up, watch — one press lands on the second.
    const harness = createHostHarness();
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId(`container-row-${fullId}`);
    const dialog = await openCommandCenter();

    const search = within(dialog).getByPlaceholderText("e.g. compose up");
    fireEvent.change(search, { target: { value: "compose" } });
    await within(dialog).findByRole("option", { name: /compose down/i });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(
      within(dialog).getByRole("option", { name: /compose logs/i }),
    ).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(search, { key: "Enter" });
    expect(within(dialog).getByLabelText("Argument 0")).toHaveValue("compose");
    expect(within(dialog).getByLabelText("Argument 1")).toHaveValue("logs");
  });

  it("keeps hand-edited argv when the operator goes back to the list", async () => {
    // Going back to look at the list is not the same as abandoning the command, and losing an
    // edited argv to a misclick on "Choose another" would make the step feel like a trapdoor.
    const harness = createHostHarness();
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId(`container-row-${fullId}`);
    const dialog = await openCommandCenter();
    await chooseCommand(dialog, "compose up");
    fireEvent.change(within(dialog).getByLabelText("Argument 1"), {
      target: { value: "down" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Choose another" }));
    expect(within(dialog).getByPlaceholderText("e.g. compose up")).toBeVisible();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Back to compose down" }),
    );
    expect(within(dialog).getByLabelText("Argument 1")).toHaveValue("down");
  });

  it("propagates explicit literal targeting into start, copy, and history, then resets to pinned", async () => {
    const harness = createHostHarness();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId(`container-row-${fullId}`);
    const dialog = await openCommandCenter();
    const targetMode = within(dialog).getByLabelText("Docker target mode");
    expect(targetMode).toHaveValue("pinned");
    fireEvent.change(targetMode, { target: { value: "literal" } });

    // The escalation is stated wherever the operator is, not tucked into the run options.
    // `tools/capture-host-candidate.mjs` waits on this exact opening phrase before it records
    // the literal-target evidence screen, so a reword has to break a test here first.
    expect(
      within(dialog).getByText(/^Literal target mode is enabled/u),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/is not applied to the run/u),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /without an override, Docker uses its ambient default/u,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Treat DOCKER_CONFIG as target-sensitive/u),
    ).toBeInTheDocument();

    await chooseCommand(dialog, "version");
    fireEvent.change(within(dialog).getByLabelText("Argument 0"), {
      target: { value: "--host=tcp://docker.example.test:2376" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Add token/ }));
    fireEvent.change(within(dialog).getByLabelText("Argument 1"), {
      target: { value: "version" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy argv JSON" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse(writeText.mock.calls[0][0])).toMatchObject({
      context: "staging",
      targetMode: "literal",
      argv: ["--host=tcp://docker.example.test:2376", "version"],
    });

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Run command" }),
    );
    await waitFor(() =>
      expect(harness.start).toHaveBeenCalledWith({
        context: "staging",
        targetMode: "literal",
        argv: ["--host=tcp://docker.example.test:2376", "version"],
        mode: "pipes",
      }),
    );
    expect(within(dialog).getByText(/"targetMode":"literal"/u))
      .toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close Command Center" }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("command-center")).not.toBeInTheDocument(),
    );
    const reopened = await openCommandCenter();
    expect(within(reopened).getByLabelText("Docker target mode"))
      .toHaveValue("pinned");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  });

  it("propagates a discovered non-default context through workspace and literal session requests", async () => {
    const harness = createHostHarness();
    window.anchorage = harness.host;
    render(<App />);

    const row = await screen.findByTestId(`container-row-${fullId}`);
    expect(harness.list).toHaveBeenCalledWith({
      context: "staging",
      all: true,
    });

    fireEvent.click(screen.getByTestId(`container-toggle-${fullId}`));
    await waitFor(() =>
      expect(harness.action).toHaveBeenCalledWith({
        context: "staging",
        id: fullId,
        action: "stop",
      }),
    );
    fireEvent.click(row);
    await waitFor(() =>
      expect(harness.cliRun).toHaveBeenCalledWith({
        context: "staging",
        argv: ["logs", "--timestamps", "--tail", "200", fullId],
        timeoutSeconds: 30,
      }),
    );

    const dialog = await openCommandCenter();
    const contextSelect = within(dialog).getByLabelText("Docker context");
    expect(contextSelect).toHaveValue("staging");
    fireEvent.change(contextSelect, { target: { value: "default" } });
    await waitFor(() =>
      expect(harness.capabilities).toHaveBeenCalledWith({ context: "default" }),
    );
    fireEvent.change(contextSelect, { target: { value: "staging" } });
    await waitFor(() =>
      expect(harness.capabilities).toHaveBeenCalledWith({ context: "staging" }),
    );

    await chooseCommand(dialog, "compose up");
    fireEvent.click(within(dialog).getByRole("button", { name: /Add token/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Add token/ }));
    fireEvent.change(within(dialog).getByLabelText("Argument 2"), {
      target: { value: "--label" },
    });
    fireEvent.change(within(dialog).getByLabelText("Argument 3"), {
      target: { value: "$(whoami); echo x y" },
    });
    fireEvent.change(within(dialog).getByLabelText("Working directory"), {
      target: { value: "/home/soya/project with spaces" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: /Add variable/ }),
    );
    fireEvent.change(within(dialog).getByLabelText("Environment key 0"), {
      target: { value: "DOCKER_BUILDKIT" },
    });
    fireEvent.change(within(dialog).getByLabelText("Environment value 0"), {
      target: { value: "1" },
    });

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Run command" }),
    );
    await waitFor(() =>
      expect(harness.start).toHaveBeenCalledWith({
        context: "staging",
        targetMode: "pinned",
        argv: ["compose", "up", "--label", "$(whoami); echo x y"],
        cwd: "/home/soya/project with spaces",
        env: { DOCKER_BUILDKIT: "1" },
        mode: "pipes",
      }),
    );
    expect(within(dialog).getByText(/In-memory history \(1\)/))
      .toBeInTheDocument();
    expect(within(dialog).getByText(/project with spaces/)).toBeInTheDocument();
  });

  it("ACKs sustained output independently of the bounded display ring and controls a PTY exactly", async () => {
    const harness = createHostHarness();
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId(`container-row-${fullId}`);
    const dialog = await openCommandCenter();

    await chooseCommand(dialog, "version");
    fireEvent.click(within(dialog).getByLabelText("PTY"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Run command" }),
    );
    await waitFor(() => expect(harness.start).toHaveBeenCalled());

    act(() => {
      harness.emit("session.output", {
        sessionId: canonicalSessionId,
        sequence: 1,
        stream: "pty",
        data: "hello ",
        encoding: "utf-8",
        bytes: 6,
      });
      harness.emit("session.output", {
        sessionId: canonicalSessionId,
        sequence: 2,
        stream: "pty",
        data: "d29ybGQ=",
        encoding: "base64",
        bytes: 5,
      });
    });
    await waitFor(() =>
      expect(harness.ack).toHaveBeenCalledWith({
        sessionId: canonicalSessionId,
        throughSequence: 2,
      }),
    );
    expect(within(dialog).getByTestId("command-terminal-transcript"))
      .toHaveTextContent("hello world");

    act(() => {
      for (let sequence = 3; sequence <= 902; sequence += 1) {
        harness.emit("session.output", {
          sessionId: canonicalSessionId,
          sequence,
          stream: "pty",
          data: "x",
          encoding: "utf-8",
          bytes: 1,
        });
      }
    });
    // The docker events stream acks on its own session; count only this command's acks.
    const commandAcks = () =>
      harness.ack.mock.calls.filter(
        (call) => call[0].sessionId !== "events-session",
      ).length;
    await waitFor(() => expect(commandAcks()).toBe(902));
    expect(within(dialog).getByText(/older renderer bytes were released/))
      .toBeInTheDocument();

    const stdin = within(dialog).getByLabelText("Literal stdin");
    fireEvent.change(stdin, { target: { value: "raw-bytes" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send bytes" }));
    await waitFor(() =>
      expect(harness.input).toHaveBeenCalledWith({
        sessionId: canonicalSessionId,
        data: "raw-bytes",
        encoding: "utf-8",
        eof: undefined,
      }),
    );
    fireEvent.change(stdin, { target: { value: "line" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send line" }));
    await waitFor(() =>
      expect(harness.input).toHaveBeenCalledWith({
        sessionId: canonicalSessionId,
        data: "line\n",
        encoding: "utf-8",
        eof: undefined,
      }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "EOF" }));
    await waitFor(() =>
      expect(harness.input).toHaveBeenCalledWith({
        sessionId: canonicalSessionId,
        data: undefined,
        encoding: "utf-8",
        eof: true,
      }),
    );

    fireEvent.change(within(dialog).getByLabelText("PTY rows"), {
      target: { value: "44" },
    });
    fireEvent.change(within(dialog).getByLabelText("PTY columns"), {
      target: { value: "160" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resize" }));
    await waitFor(() =>
      expect(harness.resize).toHaveBeenCalledWith({
        sessionId: canonicalSessionId,
        rows: 44,
        cols: 160,
      }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(harness.cancel).toHaveBeenCalledWith({
        sessionId: canonicalSessionId,
        gracePeriodMs: 1_500,
      }),
    );
    act(() => {
      harness.emit("session.exited", {
        sessionId: canonicalSessionId,
        state: "exited",
        exitCode: 143,
        signal: "SIGTERM",
        timedOut: false,
        canceled: true,
        startedAt: "2026-08-02T12:00:00.000Z",
        exitedAt: "2026-08-02T12:00:01.000Z",
        durationMs: 1_000,
        output: {
          stdoutBytes: 0,
          stderrBytes: 0,
          ptyBytes: 911,
          emittedBytes: 911,
          droppedBytes: 0,
          truncated: false,
          lastSequence: 902,
        },
      });
    });
    expect(within(dialog).getByText(/Exited 143 · canceled/))
      .toBeInTheDocument();
    // stdin belongs to a live process. Once it has exited there is nothing to write to.
    expect(within(dialog).queryByLabelText("Literal stdin")).toBeNull();
  });

  it("warns before a destructive command is pressed and again before it is confirmed", async () => {
    const harness = createHostHarness();
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId(`container-row-${fullId}`);
    const dialog = await openCommandCenter();

    await chooseCommand(dialog, "container rm");
    // Said while the command is still being written, not sprung at the moment of pressing Run.
    expect(
      within(dialog).getByText(/permanently change Docker resources/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).toBeNull();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Run command" }),
    );
    expect(
      harness.start.mock.calls.filter((call) => call[0].argv[0] !== "events"),
    ).toHaveLength(0);
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      /Check the target and the command line above/u,
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Confirm and run" }),
    );
    await waitFor(() =>
      expect(harness.start).toHaveBeenCalledWith({
        context: "staging",
        targetMode: "pinned",
        argv: ["container", "rm"],
        mode: "pipes",
      }),
    );
  });

  it("re-arms the destructive confirmation when the command changes underneath it", async () => {
    // The sentence the operator agreed to was about the argv as it stood. Editing it and
    // pressing Run again must not inherit consent given for a different command.
    const harness = createHostHarness();
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId(`container-row-${fullId}`);
    const dialog = await openCommandCenter();

    await chooseCommand(dialog, "container rm");
    fireEvent.click(within(dialog).getByRole("button", { name: "Run command" }));
    expect(
      within(dialog).getByRole("button", { name: "Confirm and run" }),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /Add token/ }));
    fireEvent.change(within(dialog).getByLabelText("Argument 2"), {
      target: { value: "--force" },
    });
    expect(
      within(dialog).getByRole("button", { name: "Run command" }),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Run command" }));
    expect(
      harness.start.mock.calls.filter((call) => call[0].argv[0] !== "events"),
    ).toHaveLength(0);
  });

  it("masks login -p secrets and excludes them from copy and history", async () => {
    const harness = createHostHarness();
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId(`container-row-${fullId}`);
    const dialog = await openCommandCenter();
    await chooseCommand(dialog, "version");
    fireEvent.change(within(dialog).getByLabelText("Argument 0"), {
      target: { value: "login" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Add token/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Add token/ }));
    fireEvent.change(within(dialog).getByLabelText("Argument 1"), {
      target: { value: "-p" },
    });
    fireEvent.change(within(dialog).getByLabelText("Argument 2"), {
      target: { value: "hunter2" },
    });

    expect(within(dialog).getByLabelText("Argument 2")).toHaveAttribute(
      "type",
      "password",
    );
    expect(
      within(dialog).getByRole("button", { name: "Copy argv JSON" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByText(/excluded from history/),
    ).toBeInTheDocument();
    // Including the command-line preview, which would otherwise echo it back in plain text.
    expect(within(dialog).queryByText("hunter2")).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("command-preview")).not.toHaveTextContent(
      "hunter2",
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Run command" }),
    );
    await waitFor(() =>
      expect(harness.start).toHaveBeenCalledWith({
        context: "staging",
        targetMode: "pinned",
        argv: ["login", "-p", "hunter2"],
        mode: "pipes",
      }),
    );
    expect(within(dialog).queryByText(/In-memory history/))
      .not.toBeInTheDocument();
  });

  it("masks nested env flag secrets and excludes their values from copy and history", async () => {
    const harness = createHostHarness();
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId(`container-row-${fullId}`);
    const dialog = await openCommandCenter();
    await chooseCommand(dialog, "version");
    fireEvent.click(within(dialog).getByRole("button", { name: /Add token/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Add token/ }));
    fireEvent.change(within(dialog).getByLabelText("Argument 0"), {
      target: { value: "run" },
    });
    fireEvent.change(within(dialog).getByLabelText("Argument 1"), {
      target: { value: "--env=PASSWORD=hunter2" },
    });
    fireEvent.change(within(dialog).getByLabelText("Argument 2"), {
      target: { value: "app" },
    });

    expect(within(dialog).getByLabelText("Argument 1")).toHaveAttribute(
      "type",
      "password",
    );
    expect(
      within(dialog).getByRole("button", { name: "Copy argv JSON" }),
    ).toBeDisabled();
    expect(within(dialog).queryByText("hunter2")).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("command-preview")).not.toHaveTextContent(
      "hunter2",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Run command" }),
    );
    await waitFor(() =>
      expect(harness.start).toHaveBeenCalledWith({
        context: "staging",
        targetMode: "pinned",
        argv: ["run", "--env=PASSWORD=hunter2", "app"],
        mode: "pipes",
      }),
    );
    expect(within(dialog).queryByText(/In-memory history/))
      .not.toBeInTheDocument();
  });

  it("masks a secret-named environment value and refuses to copy it", async () => {
    // The env editor is the other way a credential reaches a run, and it is the one that is
    // easy to forget because the value never appears in the argv rows.
    const harness = createHostHarness();
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId(`container-row-${fullId}`);
    const dialog = await openCommandCenter();
    await chooseCommand(dialog, "version");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /Add variable/ }),
    );
    fireEvent.change(within(dialog).getByLabelText("Environment key 0"), {
      target: { value: "REGISTRY_TOKEN" },
    });
    fireEvent.change(within(dialog).getByLabelText("Environment value 0"), {
      target: { value: "hunter2" },
    });

    expect(within(dialog).getByLabelText("Environment value 0")).toHaveAttribute(
      "type",
      "password",
    );
    expect(
      within(dialog).getByRole("button", { name: "Copy argv JSON" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByText(/excluded from history/),
    ).toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Reveal environment value 0",
      }),
    );
    expect(within(dialog).getByLabelText("Environment value 0")).toHaveAttribute(
      "type",
      "text",
    );
  });

  it("buffers start-race events and replays only the returned session id", async () => {
    const harness = createHostHarness();
    window.anchorage = harness.host;
    // Not mockImplementationOnce: the docker events stream starts first and would consume it.
    let raced = false;
    harness.start.mockImplementation(async (request) => {
      if (request.argv[0] === "events" || raced) {
        return {
          sessionId:
            request.argv[0] === "events" ? "events-session" : canonicalSessionId,
          mode: request.mode,
          targetMode: request.targetMode ?? "pinned",
          pid: 777,
          context: request.context,
          executable: "/usr/bin/docker",
          argv: request.argv,
          cwd: request.cwd ?? "/home/soya",
          rows: request.rows,
          cols: request.cols,
          outputWindowBytes: 262_144,
          maxOutputBytes: 0,
          startedAt: "2026-08-02T12:00:00.000Z",
        };
      }
      raced = true;
      harness.emit("session.output", {
        sessionId: "unrelated-session",
        sequence: 1,
        stream: "stdout",
        data: "must-not-render",
        encoding: "utf-8",
        bytes: 15,
      });
      harness.emit("session.output", {
        sessionId: canonicalSessionId,
        sequence: 2,
        stream: "stdout",
        data: "owned-output",
        encoding: "utf-8",
        bytes: 12,
      });
      return {
        sessionId: canonicalSessionId,
        mode: request.mode,
        targetMode: request.targetMode ?? "pinned",
        pid: 777,
        context: request.context,
        executable: "/usr/bin/docker",
        argv: request.argv,
        cwd: request.cwd ?? "/home/soya",
        rows: request.rows,
        cols: request.cols,
        outputWindowBytes: 262_144,
        maxOutputBytes: 0,
        startedAt: "2026-08-02T12:00:00.000Z",
      };
    });
    render(<App />);
    await screen.findByTestId(`container-row-${fullId}`);
    const dialog = await openCommandCenter();
    await chooseCommand(dialog, "version");
    fireEvent.click(within(dialog).getByRole("button", { name: "Run command" }));

    await waitFor(() =>
      expect(
        within(dialog).getByTestId("command-terminal-transcript"),
      ).toHaveTextContent("owned-output"),
    );
    expect(
      within(dialog).getByTestId("command-terminal-transcript"),
    ).not.toHaveTextContent("must-not-render");
    expect(harness.ack).toHaveBeenCalledWith({
      sessionId: canonicalSessionId,
      throughSequence: 2,
    });
    expect(harness.ack).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "unrelated-session" }),
    );
  });

  it("interrupts an owned session on core loss without canceling the restarted core", async () => {
    const harness = createHostHarness();
    window.anchorage = harness.host;
    render(<App />);
    await screen.findByTestId(`container-row-${fullId}`);
    const dialog = await openCommandCenter();
    await chooseCommand(dialog, "version");
    fireEvent.click(within(dialog).getByRole("button", { name: "Run command" }));
    await waitFor(() => expect(harness.start).toHaveBeenCalled());

    act(() => {
      harness.emitHost("core.status", {
        state: "crashed",
        reason: "test restart",
      });
    });

    expect(
      await within(dialog).findByText(/session was interrupted/i),
    ).toBeInTheDocument();
    expect(
      harness.cancel.mock.calls.filter(
        (call) => call[0].sessionId !== "events-session",
      ),
    ).toHaveLength(0);
    act(() => {
      harness.emit("session.output", {
        sessionId: canonicalSessionId,
        sequence: 3,
        stream: "stdout",
        data: "late-output",
        encoding: "utf-8",
        bytes: 11,
      });
    });
    expect(
      within(dialog).getByTestId("command-terminal-transcript"),
    ).not.toHaveTextContent("late-output");
  });

  it("uses the computed terminal theme and keeps early output across the idle-to-owned lifecycle without duplicate ACKs", async () => {
    const writes: string[] = [];
    const acknowledgements: number[] = [];
    const computedColors: Record<string, string> = {
      "--anc-terminal-background": "#f5f7fc",
      "--anc-terminal-foreground": "#17213d",
      "--anc-terminal-cursor": "#4c6fc5",
      "--anc-terminal-selection": "#c7d6f6",
      "--anc-terminal-black": "#17213d",
      "--anc-terminal-red": "#b33b35",
      "--anc-terminal-green": "#247a50",
      "--anc-terminal-yellow": "#85580e",
      "--anc-terminal-blue": "#2670ad",
      "--anc-terminal-magenta": "#6857b7",
      "--anc-terminal-cyan": "#087989",
      "--anc-terminal-white": "#6b7692",
    };
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (property: string) => computedColors[property] ?? "",
    } as CSSStyleDeclaration);
    let instances = 0;
    let terminalTheme: Record<string, string> | undefined;
    class MockTerminal {
      rows = 30;
      cols = 120;

      constructor(options?: { theme?: Record<string, string> }) {
        instances += 1;
        terminalTheme = options?.theme;
      }

      open() {}

      onData() {
        return { dispose() {} };
      }

      write(text: string, accepted?: () => void) {
        writes.push(text);
        accepted?.();
      }

      resize(cols: number, rows: number) {
        this.cols = cols;
        this.rows = rows;
      }

      reset() {
        writes.length = 0;
      }

      dispose() {}
    }
    type Surface = Parameters<
      ComponentProps<typeof TerminalSurface>["registerSink"]
    >[0];
    let surface: Surface = null;
    const earlyPayload: SessionOutputPayload = {
      sessionId: canonicalSessionId,
      sequence: 1,
      stream: "stdout",
      data: "early-output",
      encoding: "utf-8",
      bytes: 12,
    };
    const props: ComponentProps<typeof TerminalSurface> = {
      chunks: [],
      active: false,
      mode: "pipes",
      rows: 30,
      cols: 120,
      onAccepted: (payload) => acknowledgements.push(payload.sequence),
      onInput: vi.fn(),
      onDimensions: vi.fn(),
      registerSink: (next) => {
        surface = next;
      },
      preferFallback: false,
      terminalLoader: async () => ({
        Terminal:
          MockTerminal as unknown as typeof import("@xterm/xterm").Terminal,
      }),
    };
    const rendered = render(<TerminalSurface {...props} />);
    await waitFor(() => expect(surface).not.toBeNull());
    expect(terminalTheme).toEqual({
      background: "#f5f7fc",
      foreground: "#17213d",
      cursor: "#4c6fc5",
      selectionBackground: "#c7d6f6",
      black: "#17213d",
      red: "#b33b35",
      green: "#247a50",
      yellow: "#85580e",
      blue: "#2670ad",
      magenta: "#6857b7",
      cyan: "#087989",
      white: "#6b7692",
    });

    act(() => {
      surface?.write({ payload: earlyPayload, text: "early-output" });
    });
    expect(writes.join("")).toBe("early-output");
    expect(acknowledgements).toEqual([1]);

    rendered.rerender(
      <TerminalSurface
        {...props}
        active
        chunks={[{ payload: earlyPayload, text: "early-output" }]}
      />,
    );
    expect(instances).toBe(1);
    expect(writes.join("")).toBe("early-output");
    expect(acknowledgements).toEqual([1]);

    act(() => {
      surface?.write({
        payload: { ...earlyPayload, sequence: 2, data: "later-output" },
        text: "later-output",
      });
    });
    expect(writes.join("")).toBe("early-outputlater-output");
    expect(acknowledgements).toEqual([1, 2]);
  });
});

/**
 * Searching for a plugin that is installed but broken.
 *
 * The palette is built from a recursive `--help` walk, and a dangling symlink cannot answer
 * `--help` — Docker's own `cli-plugins/manager.ListPlugins` skips invalid candidates for the same
 * reason. So searching for `mcp` on a host with nine Docker Desktop leftovers returned "No
 * installed command leaf matches this query", which is the one answer that is actively wrong:
 * the plugin is on disk, and Settings can repair it.
 */
describe("CommandCenter unavailable plugins", () => {
  const INSTALLATION = {
    protocolVersion: "1",
    plugins: [
      {
        name: "mcp",
        status: "broken",
        fault: "dangling-link",
        discoverySource: "cli-plugins-dir",
        path: "/home/tester/.docker/cli-plugins/docker-mcp",
        availabilityNote:
          "A symbolic link pointing at /usr/lib/docker/cli-plugins/docker-mcp, which does not exist.",
      },
    ],
    searchPath: ["/home/tester/.docker/cli-plugins"],
    warnings: [],
    observedAt: "2026-08-06T00:00:00.000Z",
  };

  it("names the installed plugin instead of claiming nothing matches", async () => {
    const harness = createHostHarness({ plugins: INSTALLATION });
    window.anchorage = harness.host;
    render(<App />);
    const dialog = await openCommandCenter();

    fireEvent.change(
      within(dialog).getByLabelText(/find an installed command/iu),
      { target: { value: "mcp" } },
    );

    const unavailable = await within(dialog).findByTestId(
      "command-center-unavailable-mcp",
    );
    expect(unavailable).toHaveTextContent("docker mcp");
    // The core's own diagnosis, not a restatement.
    expect(unavailable).toHaveTextContent("which does not exist");
    expect(unavailable).toHaveTextContent(
      "/home/tester/.docker/cli-plugins/docker-mcp",
    );
    // The misleading answer is gone, and there is somewhere to go.
    expect(dialog).not.toHaveTextContent(
      "No installed command leaf matches this query",
    );
    expect(dialog).toHaveTextContent("Settings → Engine → CLI plugins");
  });

  it("does not offer it as something that can be run", async () => {
    // Selecting a row in the palette runs it. A broken plugin has to sit outside that listbox
    // or the palette promises something it cannot do.
    const harness = createHostHarness({ plugins: INSTALLATION });
    window.anchorage = harness.host;
    render(<App />);
    const dialog = await openCommandCenter();

    fireEvent.change(
      within(dialog).getByLabelText(/find an installed command/iu),
      { target: { value: "mcp" } },
    );
    await within(dialog).findByTestId("command-center-unavailable-mcp");

    const listbox = within(dialog).getByRole("listbox", {
      name: /installed docker commands/iu,
    });
    expect(within(listbox).queryByText(/docker mcp/iu)).toBeNull();
  });

  it("stays quiet when the query matches nothing on disk either", async () => {
    const harness = createHostHarness({ plugins: INSTALLATION });
    window.anchorage = harness.host;
    render(<App />);
    const dialog = await openCommandCenter();

    fireEvent.change(
      within(dialog).getByLabelText(/find an installed command/iu),
      { target: { value: "zzzznotathing" } },
    );

    expect(
      within(dialog).queryByTestId("command-center-unavailable"),
    ).toBeNull();
    expect(dialog).toHaveTextContent(
      "No installed command leaf matches this query",
    );
  });
});
