import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type {
  CommandNode,
  SessionEvent,
  SessionMode,
  SessionOutputPayload,
  SessionStartParams,
  SessionTargetMode,
  SystemCapabilities,
} from "../types";
import {
  decodeSessionOutput,
  flattenAvailableCommandLeaves,
  isDestructiveArgv,
  isSecretName,
  searchCommandLeaves,
  secretArgumentIndices,
} from "./commandCenterModel";

interface ArgumentRow {
  id: number;
  value: string;
}

export interface OutputChunk {
  payload: SessionOutputPayload;
  text: string;
}

interface HistoryEntry {
  context: string;
  targetMode: SessionTargetMode;
  argv: string[];
  mode: SessionMode;
  cwd?: string;
  env?: Record<string, string>;
}

interface EnvironmentRow {
  id: number;
  key: string;
  value: string;
}

export interface OutputSurface {
  write(chunk: OutputChunk): void;
  reset(): void;
}

type TerminalLoader = () => Promise<{
  Terminal: typeof import("@xterm/xterm").Terminal;
}>;

type SessionState = "idle" | "starting" | "running" | "canceling" | "exited";

const isJSDOM =
  typeof navigator !== "undefined" && /jsdom/iu.test(navigator.userAgent);
const MAX_RENDERER_OUTPUT_BYTES = 1_048_576;
const MAX_RENDERER_OUTPUT_CHUNKS = 800;

function readTerminalTheme(element: HTMLElement) {
  const styles = window.getComputedStyle(element);
  const color = (property: string, fallback: string) =>
    styles.getPropertyValue(property).trim() || fallback;

  return {
    background: color("--anc-terminal-background", "#0d1736"),
    foreground: color("--anc-terminal-foreground", "#dfe5f5"),
    cursor: color("--anc-terminal-cursor", "#8ba8f0"),
    selectionBackground: color("--anc-terminal-selection", "#405b9a"),
    black: color("--anc-terminal-black", "#0d1736"),
    red: color("--anc-terminal-red", "#e07a72"),
    green: color("--anc-terminal-green", "#74c69d"),
    yellow: color("--anc-terminal-yellow", "#e2b062"),
    blue: color("--anc-terminal-blue", "#7fb4e8"),
    magenta: color("--anc-terminal-magenta", "#a89bf0"),
    cyan: color("--anc-terminal-cyan", "#8ba8f0"),
    white: color("--anc-terminal-white", "#dfe5f5"),
  };
}

export function TerminalSurface({
  chunks,
  active,
  mode,
  rows,
  cols,
  onAccepted,
  onInput,
  onDimensions,
  registerSink,
  terminalLoader,
  preferFallback,
}: {
  chunks: OutputChunk[];
  active: boolean;
  mode: SessionMode;
  rows: number;
  cols: number;
  onAccepted: (payload: SessionOutputPayload) => void;
  onInput: (data: string) => void;
  onDimensions: (rows: number, cols: number) => void;
  registerSink: (sink: OutputSurface | null) => void;
  terminalLoader?: TerminalLoader;
  preferFallback?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const callbackRef = useRef({
    onAccepted,
    onInput,
    onDimensions,
    registerSink,
  });
  const useFallback = preferFallback ?? isJSDOM;
  const [fallback, setFallback] = useState(useFallback);
  const [ready, setReady] = useState(useFallback);

  callbackRef.current = { onAccepted, onInput, onDimensions, registerSink };

  useEffect(() => {
    if (useFallback || !hostRef.current) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    let inputDisposable: { dispose(): void } | undefined;
    const loadTerminal =
      terminalLoader ?? (() => import("@xterm/xterm"));
    void loadTerminal()
      .then(({ Terminal }) => {
        const host = hostRef.current;
        if (disposed || !host) return;
        const terminal = new Terminal({
          convertEol: false,
          cursorBlink: true,
          cursorStyle: "bar",
          disableStdin: false,
          fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
          fontSize: 12,
          lineHeight: 1.25,
          rows,
          cols,
          screenReaderMode: true,
          scrollback: 5_000,
          theme: readTerminalTheme(host),
        });
        terminal.open(host);
        terminalRef.current = terminal;
        inputDisposable = terminal.onData((data) =>
          callbackRef.current.onInput(data),
        );
        const measure = () => {
          const host = hostRef.current;
          if (!host) return;
          const nextCols = Math.max(40, Math.floor(host.clientWidth / 7.5));
          const nextRows = Math.max(8, Math.floor(host.clientHeight / 18));
          callbackRef.current.onDimensions(nextRows, nextCols);
        };
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(measure);
          resizeObserver.observe(host);
        }
        setReady(true);
      })
      .catch(() => {
        if (disposed) return;
        terminalRef.current?.dispose();
        terminalRef.current = null;
        setFallback(true);
        setReady(true);
      });
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      inputDisposable?.dispose();
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
    // Rows and columns are updated by the dedicated effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalLoader, useFallback]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !ready) return;
    if (terminal.rows !== rows || terminal.cols !== cols) {
      terminal.resize(cols, rows);
    }
  }, [cols, ready, rows]);

  useEffect(() => {
    if (!ready) return;
    const sink: OutputSurface = {
      write: (chunk) => {
        const accepted = () => callbackRef.current.onAccepted(chunk.payload);
        if (terminalRef.current) {
          terminalRef.current.write(chunk.text, accepted);
        } else {
          window.queueMicrotask(accepted);
        }
      },
      reset: () => {
        terminalRef.current?.reset();
      },
    };
    callbackRef.current.registerSink(sink);
    return () => callbackRef.current.registerSink(null);
  }, [ready]);

  return (
    <div
      className="command-terminal"
      aria-label="Docker session terminal"
      data-mode={mode}
      data-active={active}
    >
      <div ref={hostRef} className="command-terminal__xterm" />
      {fallback && (
        <pre
          className="command-terminal__fallback"
          data-testid="command-terminal-transcript"
        >
          {chunks.map((chunk) => chunk.text).join("")}
        </pre>
      )}
    </div>
  );
}

function commandLabel(command: CommandNode) {
  return command.path.join(" ");
}

export function CommandCenter({ store }: { store: AnchorageStore }) {
  const { bridge } = store;
  const [capabilities, setCapabilities] =
    useState<SystemCapabilities | null>(null);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [context, setContext] = useState("");
  const [targetMode, setTargetMode] =
    useState<SessionTargetMode>("pinned");
  const [query, setQuery] = useState("");
  const [selectedCommand, setSelectedCommand] =
    useState<CommandNode | null>(null);
  const [argumentRows, setArgumentRows] = useState<ArgumentRow[]>([]);
  const [revealedSecrets, setRevealedSecrets] = useState<Set<number>>(
    new Set(),
  );
  const [mode, setMode] = useState<SessionMode>("pipes");
  const [cwd, setCwd] = useState("");
  const [environmentRows, setEnvironmentRows] = useState<EnvironmentRow[]>([]);
  const [rows, setRows] = useState(30);
  const [cols, setCols] = useState(120);
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionInput, setSessionInput] = useState("");
  const [outputChunks, setOutputChunks] = useState<OutputChunk[]>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [exitSummary, setExitSummary] = useState<string | null>(null);
  const [truncationNotice, setTruncationNotice] = useState<string | null>(null);
  const [localDroppedBytes, setLocalDroppedBytes] = useState(0);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [destructiveConfirmation, setDestructiveConfirmation] = useState<
    string | null
  >(null);
  const nextArgumentIdRef = useRef(1);
  const nextEnvironmentIdRef = useRef(1_000_000);
  const capabilityRequestRef = useRef(0);
  const activeSessionRef = useRef<string | null>(null);
  const sessionStartPendingRef = useRef(false);
  const pendingSessionEventsRef = useRef<SessionEvent[]>([]);
  const queryRef = useRef<HTMLInputElement>(null);
  const outputRingRef = useRef<OutputChunk[]>([]);
  const outputRingBytesRef = useRef(0);
  const outputSinkRef = useRef<OutputSurface | null>(null);
  const pendingOutputRef = useRef<OutputChunk[]>([]);
  const outputResetPendingRef = useRef(false);
  const acknowledgedSequenceRef = useRef<Map<string, number>>(new Map());

  const argv = useMemo(
    () => argumentRows.map((argument) => argument.value),
    [argumentRows],
  );
  const secretIndices = useMemo(() => secretArgumentIndices(argv), [argv]);
  const environment = useMemo(
    () =>
      Object.fromEntries(
        environmentRows
          .filter((row) => row.key)
          .map((row) => [row.key, row.value]),
      ),
    [environmentRows],
  );
  const environmentError = useMemo(() => {
    const populated = environmentRows.filter(
      (row) => row.key || row.value,
    );
    const invalid = populated.find(
      (row) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(row.key),
    );
    if (invalid) return "Environment keys must be valid variable names.";
    const keys = populated.map((row) => row.key);
    return new Set(keys).size === keys.length
      ? null
      : "Environment keys must be unique.";
  }, [environmentRows]);
  const environmentContainsSecrets = environmentRows.some((row) =>
    isSecretName(row.key),
  );
  const containsSecrets =
    secretIndices.size > 0 || environmentContainsSecrets;
  const destructive = useMemo(() => isDestructiveArgv(argv), [argv]);
  const availableCommands = useMemo(
    () =>
      capabilities
        ? flattenAvailableCommandLeaves(capabilities.commandInventory.root)
        : [],
    [capabilities],
  );
  const commandResults = useMemo(
    () => searchCommandLeaves(availableCommands, query).slice(0, 100),
    [availableCommands, query],
  );
  const running =
    sessionState === "starting" ||
    sessionState === "running" ||
    sessionState === "canceling";

  const loadCapabilities = useCallback(
    async (requestedContext?: string) => {
      const requestId = ++capabilityRequestRef.current;
      setCapabilitiesLoading(true);
      setCapabilityError(null);
      try {
        const next = await bridge.system.capabilities(requestedContext);
        if (capabilityRequestRef.current !== requestId) return;
        setCapabilities(next);
        const selected =
          requestedContext ??
          next.selectedContext ??
          next.currentContext ??
          next.contexts.find((candidate) => candidate.current)?.name ??
          next.contexts[0]?.name ??
          "";
        setContext(selected);
      } catch (reason) {
        if (capabilityRequestRef.current !== requestId) return;
        setCapabilities(null);
        setCapabilityError(
          reason instanceof Error
            ? reason.message
            : "Docker command discovery failed",
        );
      } finally {
        if (capabilityRequestRef.current === requestId) {
          setCapabilitiesLoading(false);
        }
      }
    },
    [bridge],
  );

  useEffect(() => {
    if (!store.commandCenterOpen) return;
    setQuery(store.commandCenterInitialQuery);
    setTargetMode("pinned");
    setSelectedCommand(null);
    setArgumentRows([]);
    setCwd("");
    setEnvironmentRows([]);
    setRevealedSecrets(new Set());
    setSessionError(null);
    setExitSummary(null);
    setTruncationNotice(null);
    setLocalDroppedBytes(0);
    outputRingRef.current = [];
    outputRingBytesRef.current = 0;
    pendingOutputRef.current = [];
    setOutputChunks([]);
    setCopyNotice(null);
    setDestructiveConfirmation(null);
    sessionStartPendingRef.current = false;
    pendingSessionEventsRef.current = [];
    void loadCapabilities();
  }, [
    loadCapabilities,
    store.commandCenterInitialQuery,
    store.commandCenterOpen,
  ]);

  useEffect(() => {
    if (!store.commandCenterOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => queryRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      previouslyFocused?.focus();
    };
  }, [store.commandCenterOpen]);

  const appendOutput = useCallback((payload: SessionOutputPayload) => {
    const chunk = { payload, text: decodeSessionOutput(payload) };
    outputRingRef.current.push(chunk);
    outputRingBytesRef.current += payload.bytes;
    let droppedBytes = 0;
    while (
      outputRingRef.current.length > MAX_RENDERER_OUTPUT_CHUNKS ||
      outputRingBytesRef.current > MAX_RENDERER_OUTPUT_BYTES
    ) {
      const dropped = outputRingRef.current.shift();
      if (!dropped) break;
      outputRingBytesRef.current -= dropped.payload.bytes;
      droppedBytes += dropped.payload.bytes;
    }
    if (droppedBytes > 0) {
      setLocalDroppedBytes((current) => current + droppedBytes);
    }
    setOutputChunks([...outputRingRef.current]);

    const sink = outputSinkRef.current;
    if (sink) sink.write(chunk);
    else pendingOutputRef.current.push(chunk);
  }, []);

  const registerOutputSink = useCallback((sink: OutputSurface | null) => {
    outputSinkRef.current = sink;
    if (!sink) return;
    if (outputResetPendingRef.current) {
      sink.reset();
      outputResetPendingRef.current = false;
    }
    if (pendingOutputRef.current.length === 0) return;
    const pending = pendingOutputRef.current;
    pendingOutputRef.current = [];
    pending.forEach((chunk) => sink.write(chunk));
  }, []);

  const acceptOwnedSessionEvent = useCallback(
    (event: SessionEvent) => {
      switch (event.event) {
        case "session.started":
          setSessionState("running");
          break;
        case "session.output":
          appendOutput(event.payload);
          break;
        case "session.output.truncated":
          setTruncationNotice(
            `${event.payload.droppedBytes.toLocaleString()} output bytes were dropped`,
          );
          break;
        case "session.error":
          setSessionError(`${event.payload.code}: ${event.payload.message}`);
          break;
        case "session.exited": {
          activeSessionRef.current = null;
          setSessionState("exited");
          const qualifier = event.payload.canceled
            ? " · canceled"
            : event.payload.timedOut
              ? " · timed out"
              : event.payload.signal
                ? ` · ${event.payload.signal}`
                : "";
          setExitSummary(
            `Exited ${event.payload.exitCode}${qualifier} · ${event.payload.durationMs} ms`,
          );
          break;
        }
      }
    },
    [appendOutput],
  );

  useEffect(() => {
    if (!store.commandCenterOpen) return;
    return bridge.sessions.subscribe((event: SessionEvent) => {
      const activeSessionId = activeSessionRef.current;
      if (!activeSessionId) {
        if (sessionStartPendingRef.current) {
          pendingSessionEventsRef.current = [
            ...pendingSessionEventsRef.current.slice(-99),
            event,
          ];
        }
        return;
      }
      if (event.payload.sessionId !== activeSessionId) return;
      acceptOwnedSessionEvent(event);
    });
  }, [
    acceptOwnedSessionEvent,
    bridge,
    store.commandCenterOpen,
  ]);

  useEffect(() => {
    if (
      !store.commandCenterOpen ||
      store.engineStatus === "ready" ||
      (!activeSessionRef.current && !sessionStartPendingRef.current)
    ) {
      return;
    }
    activeSessionRef.current = null;
    sessionStartPendingRef.current = false;
    pendingSessionEventsRef.current = [];
    setSessionId(null);
    setSessionState("exited");
    setSessionError(
      "Docker core restarted or disconnected; this session was interrupted.",
    );
  }, [store.commandCenterOpen, store.engineStatus]);

  const updateArgument = (id: number, value: string) => {
    setArgumentRows((current) =>
      current.map((argument) =>
        argument.id === id ? { ...argument, value } : argument,
      ),
    );
    setDestructiveConfirmation(null);
    setCopyNotice(null);
  };

  const addArgument = () => {
    setArgumentRows((current) => [
      ...current,
      { id: nextArgumentIdRef.current++, value: "" },
    ]);
    setDestructiveConfirmation(null);
  };

  const removeArgument = (id: number) => {
    setArgumentRows((current) =>
      current.filter((argument) => argument.id !== id),
    );
    setRevealedSecrets((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setDestructiveConfirmation(null);
  };

  const moveArgument = (index: number, offset: -1 | 1) => {
    setArgumentRows((current) => {
      const destination = index + offset;
      if (destination < 0 || destination >= current.length) return current;
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
    setDestructiveConfirmation(null);
  };

  const addEnvironmentVariable = () => {
    setEnvironmentRows((current) => [
      ...current,
      { id: nextEnvironmentIdRef.current++, key: "", value: "" },
    ]);
    setDestructiveConfirmation(null);
  };

  const updateEnvironmentVariable = (
    id: number,
    field: "key" | "value",
    value: string,
  ) => {
    setEnvironmentRows((current) =>
      current.map((row) =>
        row.id === id ? { ...row, [field]: value } : row,
      ),
    );
    setDestructiveConfirmation(null);
    setCopyNotice(null);
  };

  const removeEnvironmentVariable = (id: number) => {
    setEnvironmentRows((current) => current.filter((row) => row.id !== id));
    setRevealedSecrets((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setDestructiveConfirmation(null);
  };

  const selectCommand = (command: CommandNode) => {
    setSelectedCommand(command);
    setArgumentRows(
      command.path.map((value) => ({
        id: nextArgumentIdRef.current++,
        value,
      })),
    );
    setRevealedSecrets(new Set());
    setDestructiveConfirmation(null);
    setSessionError(null);
  };

  const copyArgv = async () => {
    if (containsSecrets) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            context,
            targetMode,
            argv,
            ...(cwd ? { cwd } : {}),
            ...(environmentRows.length > 0 ? { env: environment } : {}),
          },
          null,
          2,
        ),
      );
      setCopyNotice("Literal argv JSON copied");
    } catch {
      setCopyNotice("Clipboard access is unavailable");
    }
  };

  const handleSessionEventAccepted = useCallback(
    (payload: SessionOutputPayload) => {
      const acknowledged =
        acknowledgedSequenceRef.current.get(payload.sessionId) ?? 0;
      if (payload.sequence <= acknowledged) return;
      acknowledgedSequenceRef.current.set(payload.sessionId, payload.sequence);
      void bridge.sessions
        .ack({
          sessionId: payload.sessionId,
          throughSequence: payload.sequence,
        })
        .catch((reason) => {
          setSessionError(
            reason instanceof Error ? reason.message : "Output ACK failed",
          );
        });
    },
    [bridge],
  );

  const sendInput = useCallback(
    async (data: string, eof = false) => {
      const activeSessionId = activeSessionRef.current;
      if (!activeSessionId || sessionState !== "running") return;
      try {
        await bridge.sessions.input({
          sessionId: activeSessionId,
          data: data || undefined,
          encoding: "utf-8",
          eof: eof || undefined,
        });
        if (data === sessionInput) setSessionInput("");
      } catch (reason) {
        setSessionError(
          reason instanceof Error ? reason.message : "Session input failed",
        );
      }
    },
    [bridge, sessionInput, sessionState],
  );

  const resizeSession = useCallback(async () => {
    const activeSessionId = activeSessionRef.current;
    if (!activeSessionId || sessionState !== "running" || mode !== "pty") return;
    try {
      await bridge.sessions.resize({
        sessionId: activeSessionId,
        rows,
        cols,
      });
    } catch (reason) {
      setSessionError(
        reason instanceof Error ? reason.message : "PTY resize failed",
      );
    }
  }, [bridge, cols, mode, rows, sessionState]);

  const runCommand = async () => {
    setSessionError(null);
    setCopyNotice(null);
    if (!context) {
      setSessionError("Select a Docker context before running.");
      return;
    }
    if (argv.length === 0 || argv[0] === "") {
      setSessionError("Select a command or enter the first Docker argument.");
      return;
    }
    if (argv[0].toLocaleLowerCase() === "docker") {
      setSessionError(
        "argv must contain Docker arguments only; remove the docker executable.",
      );
      return;
    }
    if (environmentError) {
      setSessionError(environmentError);
      return;
    }
    const fingerprint = JSON.stringify({
      context,
      targetMode,
      argv,
      cwd,
      environment,
    });
    if (destructive && destructiveConfirmation !== fingerprint) {
      setDestructiveConfirmation(fingerprint);
      return;
    }

    setDestructiveConfirmation(null);
    outputResetPendingRef.current = true;
    outputSinkRef.current?.reset();
    if (outputSinkRef.current) outputResetPendingRef.current = false;
    outputRingRef.current = [];
    outputRingBytesRef.current = 0;
    pendingOutputRef.current = [];
    setOutputChunks([]);
    setLocalDroppedBytes(0);
    setExitSummary(null);
    setTruncationNotice(null);
    setSessionId(null);
    activeSessionRef.current = null;
    sessionStartPendingRef.current = true;
    pendingSessionEventsRef.current = [];
    setSessionState("starting");
    if (!containsSecrets) {
      setHistory((current) =>
        [
          {
            context,
            targetMode,
            argv: [...argv],
            mode,
            ...(cwd ? { cwd } : {}),
            ...(environmentRows.length > 0
              ? { env: structuredClone(environment) }
              : {}),
          },
          ...current,
        ].slice(0, 8),
      );
    }

    const request: SessionStartParams = {
      context,
      targetMode,
      argv: [...argv],
      mode,
      ...(cwd ? { cwd } : {}),
      ...(environmentRows.length > 0
        ? { env: structuredClone(environment) }
        : {}),
      ...(mode === "pty" ? { rows, cols } : {}),
    };
    try {
      const result = await bridge.sessions.start(request);
      sessionStartPendingRef.current = false;
      activeSessionRef.current = result.sessionId;
      setSessionId(result.sessionId);
      setSessionState("running");
      const pending = pendingSessionEventsRef.current;
      pendingSessionEventsRef.current = [];
      pending
        .filter((event) => event.payload.sessionId === result.sessionId)
        .forEach(acceptOwnedSessionEvent);
    } catch (reason) {
      sessionStartPendingRef.current = false;
      pendingSessionEventsRef.current = [];
      activeSessionRef.current = null;
      setSessionState("idle");
      setSessionError(
        reason instanceof Error ? reason.message : "Session start failed",
      );
    }
  };

  const cancelSession = useCallback(async () => {
    const activeSessionId = activeSessionRef.current;
    if (!activeSessionId) return;
    setSessionState("canceling");
    try {
      await bridge.sessions.cancel({
        sessionId: activeSessionId,
        gracePeriodMs: 1_500,
      });
    } catch (reason) {
      setSessionState("running");
      setSessionError(
        reason instanceof Error ? reason.message : "Session cancel failed",
      );
    }
  }, [bridge]);

  const close = useCallback(async () => {
    const activeSessionId = activeSessionRef.current;
    if (activeSessionId) {
      try {
        await bridge.sessions.cancel({
          sessionId: activeSessionId,
          gracePeriodMs: 1_500,
        });
      } catch {
        // Closing is still allowed; the host owns the bounded session lifetime.
      }
      activeSessionRef.current = null;
    }
    sessionStartPendingRef.current = false;
    pendingSessionEventsRef.current = [];
    setSessionState("idle");
    setTargetMode("pinned");
    store.closeCommandCenter();
  }, [bridge, store]);

  const handleDialogKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void close();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.offsetParent !== null || isJSDOM);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!store.commandCenterOpen) return null;

  return (
    <div className="command-center-backdrop" data-testid="command-center">
      <div
        className="command-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-center-title"
        aria-describedby="command-center-description"
        onKeyDown={handleDialogKeyDown}
      >
        <header className="command-center__header">
          <div>
            <div className="command-center__eyebrow">DOCKER COMMAND CENTER</div>
            <h1 id="command-center-title">Run any installed Docker command</h1>
            <p id="command-center-description">
              Select a discovered command, then edit each literal argv token.
            </p>
          </div>
          <button
            className="command-center__close"
            type="button"
            aria-label="Close Command Center"
            onClick={() => void close()}
          >
            ×
          </button>
        </header>

        <div className="command-center__toolbar">
          <label>
            <span>Docker context</span>
            <select
              aria-label="Docker context"
              value={context}
              disabled={running || capabilitiesLoading}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setContext(next);
                setSelectedCommand(null);
                setArgumentRows([]);
                setDestructiveConfirmation(null);
                void loadCapabilities(next);
              }}
            >
              {capabilities?.contexts.map((candidate) => (
                <option
                  key={candidate.name}
                  value={candidate.name}
                  disabled={Boolean(candidate.error)}
                >
                  {candidate.name}
                  {candidate.current ? " · current" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Target mode</span>
            <select
              aria-label="Docker target mode"
              value={targetMode}
              disabled={running}
              onChange={(event) => {
                setTargetMode(
                  event.currentTarget.value as SessionTargetMode,
                );
                setDestructiveConfirmation(null);
                setCopyNotice(null);
              }}
            >
              <option value="pinned">Pinned selected context</option>
              <option value="literal">Literal argv / environment</option>
            </select>
          </label>
          <div className="command-center__inventory">
            {capabilitiesLoading
              ? "Discovering installed commands…"
              : capabilities
                ? `${availableCommands.length} runnable leaves · ${capabilities.commandInventory.complete ? "complete inventory" : "partial inventory"}`
                : "Inventory unavailable"}
          </div>
          <div className="command-center__privacy">
            History is memory-only · secret-bearing argv is never copied or saved
          </div>
        </div>

        {targetMode === "literal" && (
          <div className="command-center__target-notice" role="status">
            Literal target mode is enabled by your explicit selection. The
            selected context is discovery metadata only and is not applied.
            Exact Docker global target, config, and TLS argv tokens plus
            DOCKER_* target environment values determine the target; without
            an override, Docker uses its ambient default. Treat DOCKER_CONFIG
            as target-sensitive.
          </div>
        )}

        {(Boolean(capabilityError) ||
          (capabilities?.warnings.length ?? 0) > 0 ||
          (capabilities?.commandInventory.warnings.length ?? 0) > 0) && (
          <div className="command-center__notice" role="status">
            {capabilityError ??
              [
                ...(capabilities?.warnings ?? []),
                ...(capabilities?.commandInventory.warnings ?? []),
              ].join(" · ")}
          </div>
        )}

        <div className="command-center__body">
          <section className="command-center__discovery">
            <label className="command-search">
              <span>Find an installed command</span>
              <input
                ref={queryRef}
                type="search"
                value={query}
                placeholder="e.g. compose up"
                autoComplete="off"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <div
              className="command-results"
              role="listbox"
              aria-label="Installed Docker commands"
            >
              {commandResults.map((command) => {
                const selected =
                  selectedCommand?.path.join("\0") === command.path.join("\0");
                return (
                  <button
                    key={command.path.join("\0")}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={selected ? "command-result--selected" : ""}
                    onClick={() => selectCommand(command)}
                    disabled={running}
                  >
                    <code>{commandLabel(command)}</code>
                    <span>{command.description || "Installed Docker command"}</span>
                    <small>
                      {command.kind === "plugin-command" ? "PLUGIN" : "BUILT-IN"}
                    </small>
                  </button>
                );
              })}
              {!capabilitiesLoading && commandResults.length === 0 && (
                <p className="command-results__empty">
                  No installed command leaf matches this query.
                </p>
              )}
            </div>
          </section>

          <section className="command-center__composer">
            <div className="command-center__section-heading">
              <div>
                <h2>Literal argv</h2>
                <p>One row equals one argument. Empty rows remain empty arguments.</p>
              </div>
              <button
                type="button"
                className="command-center__secondary"
                onClick={addArgument}
                disabled={running}
              >
                + Add token
              </button>
            </div>

            <div className="argv-context">
              <span>context</span>
              <code>{context || "not selected"}</code>
              <label htmlFor="command-center-cwd">cwd</label>
              <input
                id="command-center-cwd"
                aria-label="Working directory"
                value={cwd}
                disabled={running}
                placeholder="Host home (default)"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setCwd(event.currentTarget.value);
                  setDestructiveConfirmation(null);
                  setCopyNotice(null);
                }}
              />
            </div>
            <div className="argv-rows" data-testid="argv-rows">
              {argumentRows.map((argument, index) => {
                const secret = secretIndices.has(index);
                const revealed = revealedSecrets.has(argument.id);
                return (
                  <div className="argv-row" key={argument.id}>
                    <span className="argv-row__index">{index}</span>
                    <input
                      aria-label={`Argument ${index}`}
                      type={secret && !revealed ? "password" : "text"}
                      value={argument.value}
                      autoComplete={secret ? "new-password" : "off"}
                      spellCheck={false}
                      disabled={running}
                      onChange={(event) =>
                        updateArgument(argument.id, event.currentTarget.value)
                      }
                    />
                    {secret && (
                      <button
                        type="button"
                        aria-label={`${revealed ? "Hide" : "Reveal"} argument ${index}`}
                        onClick={() =>
                          setRevealedSecrets((current) => {
                            const next = new Set(current);
                            if (next.has(argument.id)) next.delete(argument.id);
                            else next.add(argument.id);
                            return next;
                          })
                        }
                      >
                        {revealed ? "Hide" : "Show"}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`Move argument ${index} up`}
                      onClick={() => moveArgument(index, -1)}
                      disabled={running || index === 0}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move argument ${index} down`}
                      onClick={() => moveArgument(index, 1)}
                      disabled={running || index === argumentRows.length - 1}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove argument ${index}`}
                      onClick={() => removeArgument(argument.id)}
                      disabled={running}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              {argumentRows.length === 0 && (
                <p className="argv-rows__empty">
                  Select a command leaf or add the first Docker argument.
                </p>
              )}
            </div>

            <div className="environment-editor">
              <div className="environment-editor__heading">
                <span>
                  Environment
                  {environmentRows.length > 0
                    ? ` · ${environmentRows.length}`
                    : " · optional"}
                </span>
                <button
                  type="button"
                  onClick={addEnvironmentVariable}
                  disabled={running}
                >
                  + Add variable
                </button>
              </div>
              {environmentRows.length > 0 && (
                <div className="environment-rows">
                  {environmentRows.map((row, index) => {
                    const secret = isSecretName(row.key);
                    const revealed = revealedSecrets.has(row.id);
                    return (
                      <div className="environment-row" key={row.id}>
                        <input
                          aria-label={`Environment key ${index}`}
                          value={row.key}
                          placeholder="NAME"
                          autoComplete="off"
                          spellCheck={false}
                          disabled={running}
                          onChange={(event) =>
                            updateEnvironmentVariable(
                              row.id,
                              "key",
                              event.currentTarget.value,
                            )
                          }
                        />
                        <input
                          aria-label={`Environment value ${index}`}
                          type={secret && !revealed ? "password" : "text"}
                          value={row.value}
                          placeholder="value"
                          autoComplete={secret ? "new-password" : "off"}
                          spellCheck={false}
                          disabled={running}
                          onChange={(event) =>
                            updateEnvironmentVariable(
                              row.id,
                              "value",
                              event.currentTarget.value,
                            )
                          }
                        />
                        {secret && (
                          <button
                            type="button"
                            onClick={() =>
                              setRevealedSecrets((current) => {
                                const next = new Set(current);
                                if (next.has(row.id)) next.delete(row.id);
                                else next.add(row.id);
                                return next;
                              })
                            }
                            aria-label={`${revealed ? "Hide" : "Reveal"} environment value ${index}`}
                          >
                            {revealed ? "Hide" : "Show"}
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={`Remove environment variable ${index}`}
                          onClick={() => removeEnvironmentVariable(row.id)}
                          disabled={running}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {environmentError && (
                <div className="environment-editor__error" role="alert">
                  {environmentError}
                </div>
              )}
            </div>

            <div className="command-center__run-options">
              <fieldset>
                <legend>Transport</legend>
                <label>
                  <input
                    type="radio"
                    name="session-mode"
                    value="pipes"
                    checked={mode === "pipes"}
                    disabled={running}
                    onChange={() => setMode("pipes")}
                  />
                  Pipes
                </label>
                <label>
                  <input
                    type="radio"
                    name="session-mode"
                    value="pty"
                    checked={mode === "pty"}
                    disabled={running}
                    onChange={() => setMode("pty")}
                  />
                  PTY
                </label>
              </fieldset>
              <button
                type="button"
                className="command-center__secondary"
                disabled={
                  containsSecrets || argv.length === 0 || Boolean(environmentError)
                }
                title={
                  containsSecrets
                    ? "Copy is disabled because this argv contains a secret-bearing argument"
                    : "Copy exact target mode, context metadata, and argv as JSON"
                }
                onClick={() => void copyArgv()}
              >
                Copy argv JSON
              </button>
              <button
                type="button"
                className={
                  destructiveConfirmation
                    ? "command-center__run command-center__run--danger"
                    : "command-center__run"
                }
                disabled={running || argv.length === 0 || !context}
                onClick={() => void runCommand()}
              >
                {sessionState === "starting"
                  ? "Starting…"
                  : destructiveConfirmation
                    ? "Confirm & run"
                    : "Run command"}
              </button>
            </div>
            {destructiveConfirmation && (
              <div className="command-center__danger" role="alert">
                This command can remove or permanently change Docker resources.
                Review the target mode, context metadata, and literal argv,
                then confirm once more.
              </div>
            )}
            {(copyNotice || containsSecrets) && (
              <div className="command-center__copy-status" role="status">
                {containsSecrets
                  ? "Secret detected · masked, excluded from history, and copy disabled"
                  : copyNotice}
              </div>
            )}
          </section>
        </div>

        <section className="command-center__session">
          <div className="command-center__section-heading">
            <div>
              <h2>Session output</h2>
              <p>
                {sessionId
                  ? `${sessionId} · ${sessionState}`
                  : `No active ${mode.toUpperCase()} session`}
              </p>
            </div>
            <div className="session-actions">
              <button
                type="button"
                className="command-center__secondary"
                disabled={sessionState !== "running"}
                onClick={() => void cancelSession()}
              >
                Cancel
              </button>
            </div>
          </div>

          <TerminalSurface
            chunks={outputChunks}
            active={sessionState === "running"}
            mode={mode}
            rows={rows}
            cols={cols}
            onAccepted={handleSessionEventAccepted}
            onInput={(data) => {
              if (mode === "pty") void sendInput(data);
            }}
            onDimensions={(nextRows, nextCols) => {
              setRows(nextRows);
              setCols(nextCols);
            }}
            registerSink={registerOutputSink}
          />

          <div className="session-controls">
            <label className="session-input">
              <span>Literal stdin</span>
              <input
                value={sessionInput}
                disabled={sessionState !== "running"}
                onChange={(event) => setSessionInput(event.currentTarget.value)}
                placeholder="Sent exactly as entered"
                autoComplete="off"
              />
            </label>
            <button
              type="button"
              disabled={sessionState !== "running" || !sessionInput}
              onClick={() => void sendInput(sessionInput)}
            >
              Send bytes
            </button>
            <button
              type="button"
              disabled={sessionState !== "running"}
              onClick={() => {
                void sendInput(`${sessionInput}\n`);
                setSessionInput("");
              }}
            >
              Send line
            </button>
            <button
              type="button"
              disabled={sessionState !== "running"}
              onClick={() => void sendInput("", true)}
            >
              EOF
            </button>
            <label>
              <span>Rows</span>
              <input
                aria-label="PTY rows"
                type="number"
                min="8"
                max="200"
                value={rows}
                disabled={mode !== "pty"}
                onChange={(event) => setRows(Number(event.currentTarget.value))}
              />
            </label>
            <label>
              <span>Cols</span>
              <input
                aria-label="PTY columns"
                type="number"
                min="40"
                max="400"
                value={cols}
                disabled={mode !== "pty"}
                onChange={(event) => setCols(Number(event.currentTarget.value))}
              />
            </label>
            <button
              type="button"
              disabled={sessionState !== "running" || mode !== "pty"}
              onClick={() => void resizeSession()}
            >
              Resize
            </button>
          </div>

          {(sessionError ||
            exitSummary ||
            truncationNotice ||
            localDroppedBytes > 0) && (
            <div
              className={`session-status${sessionError ? " session-status--error" : ""}`}
              role={sessionError ? "alert" : "status"}
            >
              {[
                sessionError,
                exitSummary,
                truncationNotice,
                localDroppedBytes > 0
                  ? `${localDroppedBytes.toLocaleString()} older renderer bytes were released`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
        </section>

        {history.length > 0 && (
          <details className="command-history">
            <summary>In-memory history ({history.length})</summary>
            <ol>
              {history.map((entry, index) => (
                <li key={`${entry.targetMode}-${entry.context}-${index}`}>
                  <code>
                    {JSON.stringify({
                      context: entry.context,
                      targetMode: entry.targetMode,
                      argv: entry.argv,
                      mode: entry.mode,
                      ...(entry.cwd ? { cwd: entry.cwd } : {}),
                      ...(entry.env ? { env: entry.env } : {}),
                    })}
                  </code>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </div>
  );
}
