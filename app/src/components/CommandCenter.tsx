import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
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
import { CommandResults } from "./CommandResults";
import {
  TerminalSurface,
  type OutputChunk,
  type OutputSurface,
} from "./CommandTerminal";
import {
  decodeSessionOutput,
  flattenAvailableCommandLeaves,
  searchUnavailablePlugins,
  isDestructiveArgv,
  isSecretName,
  searchCommandLeaves,
  secretArgumentIndices,
} from "./commandCenterModel";

/*
 * The Command Center: find a Docker command, see what it will do, run it, read the output.
 *
 * Those four things happen in that order, so the dialog shows them in that order and shows one
 * of them at a time. The previous version put discovery, an argv composer and a terminal on
 * screen simultaneously, which meant the operator had to hold the whole surface in their head
 * to answer the only question that matters at any moment — and the first of the four steps was
 * competing for attention with a terminal that had nothing in it yet.
 *
 * What is NOT staged, deliberately, is anything that says what a run will touch. The target
 * strip, the literal-target warning, the destructive-command warning, the secret notice and the
 * retention line are visible from wherever you are in the flow. Progressive disclosure is for
 * controls; it is not for consequences.
 */

/* The exec panel in ContainerDetailScreen renders a session terminal too, and imports it from
   this module. Re-exported rather than moved outright so that file does not have to change. */
export { TerminalSurface } from "./CommandTerminal";
export type { OutputChunk, OutputSurface } from "./CommandTerminal";

interface ArgumentRow {
  id: number;
  value: string;
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

type SessionState = "idle" | "starting" | "running" | "canceling" | "exited";

/** Which of the two editable steps is on screen. Output appears under whichever it is. */
type Stage = "find" | "command";

const isJSDOM =
  typeof navigator !== "undefined" && /jsdom/iu.test(navigator.userAgent);
const MAX_RENDERER_OUTPUT_BYTES = 1_048_576;
const MAX_RENDERER_OUTPUT_CHUNKS = 800;
const RESULTS_LIST_ID = "command-center-results";
const resultOptionId = (index: number) => `command-center-result-${index}`;

/*
 * The full tree is thousands of leaves, so the list is capped. `commandMatches` keeps the total
 * before capping: a silently truncated list reads as "that is all there is", which is the one
 * thing this palette must never imply about the installed command surface.
 */
const COMMAND_RESULT_LIMIT = 100;

export function CommandCenter({ store }: { store: AnchorageStore }) {
  const { bridge } = store;
  const [capabilities, setCapabilities] = useState<SystemCapabilities | null>(
    null,
  );
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [context, setContext] = useState("");
  const [targetMode, setTargetMode] = useState<SessionTargetMode>("pinned");
  const [stage, setStage] = useState<Stage>("find");
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedCommand, setSelectedCommand] = useState<CommandNode | null>(
    null,
  );
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
  const firstArgumentRef = useRef<HTMLInputElement>(null);
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
    const populated = environmentRows.filter((row) => row.key || row.value);
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
  const containsSecrets = secretIndices.size > 0 || environmentContainsSecrets;
  const destructive = useMemo(() => isDestructiveArgv(argv), [argv]);
  const availableCommands = useMemo(
    () =>
      capabilities
        ? flattenAvailableCommandLeaves(capabilities.commandInventory.root)
        : [],
    [capabilities],
  );
  const commandMatches = useMemo(
    () => searchCommandLeaves(availableCommands, query),
    [availableCommands, query],
  );
  /*
   * Installed plugins that cannot be offered, and why.
   *
   * Kept apart from `commandMatches` on purpose: those are runnable and these are not, and the
   * palette's whole contract is that selecting a row runs something. Read from the plugin report
   * the store already holds, which is a walk of the operator's own plugin directories — so this
   * finds whatever is installed rather than a list of names known when this was written.
   */
  const unavailablePluginMatches = useMemo(
    () => searchUnavailablePlugins(store.pluginReport, query),
    [store.pluginReport, query],
  );
  const commandResults = useMemo(
    () => commandMatches.slice(0, COMMAND_RESULT_LIMIT),
    [commandMatches],
  );
  const running =
    sessionState === "starting" ||
    sessionState === "running" ||
    sessionState === "canceling";
  const sessionVisible =
    sessionState !== "idle" ||
    outputChunks.length > 0 ||
    Boolean(sessionError) ||
    Boolean(exitSummary);
  const warnings = [
    ...(capabilities?.warnings ?? []),
    ...(capabilities?.commandInventory.warnings ?? []),
  ];

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
    setStage("find");
    setActiveIndex(0);
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

  /*
   * Focus follows the step. Choosing a command with the keyboard has to leave the caret on the
   * thing you would edit next, and going back to search has to leave it in the search box —
   * otherwise arrowing to a command and pressing Enter strands focus on a control that is no
   * longer rendered, and the next keystroke goes to the document.
   */
  useEffect(() => {
    if (!store.commandCenterOpen) return;
    if (stage === "command") firstArgumentRef.current?.focus();
    else queryRef.current?.focus();
  }, [stage, store.commandCenterOpen]);

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
  }, [acceptOwnedSessionEvent, bridge, store.commandCenterOpen]);

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

  /* Any edit invalidates a pending destructive confirmation: the sentence the operator agreed
     to was about the argv as it stood, not as it stands now. */
  const invalidateConfirmation = () => {
    setDestructiveConfirmation(null);
    setCopyNotice(null);
  };

  const updateArgument = (id: number, value: string) => {
    setArgumentRows((current) =>
      current.map((argument) =>
        argument.id === id ? { ...argument, value } : argument,
      ),
    );
    invalidateConfirmation();
  };

  const addArgument = () => {
    setArgumentRows((current) => [
      ...current,
      { id: nextArgumentIdRef.current++, value: "" },
    ]);
    invalidateConfirmation();
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
    invalidateConfirmation();
  };

  const moveArgument = (index: number, offset: -1 | 1) => {
    setArgumentRows((current) => {
      const destination = index + offset;
      if (destination < 0 || destination >= current.length) return current;
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
    invalidateConfirmation();
  };

  const addEnvironmentVariable = () => {
    setEnvironmentRows((current) => [
      ...current,
      { id: nextEnvironmentIdRef.current++, key: "", value: "" },
    ]);
    invalidateConfirmation();
  };

  const updateEnvironmentVariable = (
    id: number,
    field: "key" | "value",
    value: string,
  ) => {
    setEnvironmentRows((current) =>
      current.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    );
    invalidateConfirmation();
  };

  const removeEnvironmentVariable = (id: number) => {
    setEnvironmentRows((current) => current.filter((row) => row.id !== id));
    setRevealedSecrets((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    invalidateConfirmation();
  };

  const toggleRevealed = (id: number) => {
    setRevealedSecrets((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    setStage("command");
  };

  const startFromScratch = () => {
    setSelectedCommand(null);
    setArgumentRows([{ id: nextArgumentIdRef.current++, value: "" }]);
    setRevealedSecrets(new Set());
    setDestructiveConfirmation(null);
    setStage("command");
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

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void close();
      return;
    }
    /* The palette's submit chord. Plain Enter is left alone because it belongs to whichever
       field has focus, and because a bare Enter that starts a Docker command is too easy to
       hit by accident. This does not skip the destructive confirmation. */
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      stage === "command" &&
      !running &&
      argv.length > 0 &&
      Boolean(context)
    ) {
      event.preventDefault();
      void runCommand();
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

  /* Arrow keys drive the list from the search box, which is where the caret already is. */
  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (commandResults.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) =>
        Math.min(current + 1, commandResults.length - 1),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      const command = commandResults[activeIndex];
      if (!command) return;
      event.preventDefault();
      selectCommand(command);
    }
  };

  if (!store.commandCenterOpen) return null;

  const selectedLabel = argv.join(" ");
  /*
   * The command line as the host will assemble it. Pinned mode prepends the context; literal
   * mode passes argv through untouched, which is exactly why literal mode is worth a warning.
   *
   * Built as tokens rather than a string so a credential can be dotted out individually, and
   * joined with real spaces rather than a flex gap: a gap is not in the text, so the preview
   * would have been read aloud and copied as one unbroken word.
   */
  const previewTokens: { text: string; className?: string }[] = [
    { text: "docker", className: "command-preview__exe" },
    ...(targetMode === "pinned" && context
      ? [
          { text: "--context", className: "command-preview__target" },
          { text: context, className: "command-preview__target" },
        ]
      : []),
    ...argv.map((token, index) =>
      secretIndices.has(index)
        ? { text: "••••••", className: "command-preview__secret" }
        : { text: token || "''" },
    ),
  ];

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
            <h1 id="command-center-title">Run a Docker command</h1>
            <p id="command-center-description">
              Everything the Docker CLI on this machine can do, including
              installed plugins.
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

        {/* Where the command will land, kept above the command itself and visible at every step.
            Both controls answer the same question, so they sit together rather than one in a
            toolbar and the other buried in run options. */}
        <div className="command-target">
          <label>
            <span>Context</span>
            <select
              aria-label="Docker context"
              value={context}
              disabled={running || capabilitiesLoading}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setContext(next);
                setSelectedCommand(null);
                setArgumentRows([]);
                setStage("find");
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
            <span>Target</span>
            <select
              aria-label="Docker target mode"
              value={targetMode}
              disabled={running}
              onChange={(event) => {
                setTargetMode(event.currentTarget.value as SessionTargetMode);
                setDestructiveConfirmation(null);
                setCopyNotice(null);
              }}
            >
              <option value="pinned">Pin to the selected context</option>
              <option value="literal">Let the command choose (literal)</option>
            </select>
          </label>
          {targetMode === "pinned" && (
            <p className="command-target__summary">
              Runs against <code>{context || "no context selected"}</code>.
              Anchorage passes the context itself, so nothing you type can move
              the command to another engine.
            </p>
          )}
        </div>

        {targetMode === "literal" && (
          <div className="command-banner command-banner--warning" role="status">
            {/* "Literal target mode is enabled" is also the phrase `tools/capture-host-candidate.mjs`
                waits for before it records the literal-target evidence screen. CommandCenter.test.tsx
                pins the opening words so a reword fails here rather than silently there. */}
            <strong>
              Literal target mode is enabled because you selected it.
            </strong>
            <p>
              The context above is used to discover commands and is not applied
              to the run. Where this actually lands is decided by the Docker
              global target, config and TLS tokens you type, plus any DOCKER_*
              values you set below; without an override, Docker uses its ambient
              default. Treat DOCKER_CONFIG as target-sensitive — it carries the
              credentials the run will use.
            </p>
          </div>
        )}

        {(Boolean(capabilityError) || warnings.length > 0) && (
          <div className="command-banner" role="status">
            {capabilityError ?? warnings.join(" · ")}
          </div>
        )}

        <div className="command-center__body">
          {stage === "find" ? (
            <section className="command-find" aria-label="Find a command">
              <label className="command-search">
                <span>Find an installed command</span>
                <input
                  ref={queryRef}
                  type="search"
                  role="combobox"
                  aria-expanded="true"
                  aria-controls={RESULTS_LIST_ID}
                  aria-activedescendant={
                    commandResults.length > 0
                      ? resultOptionId(activeIndex)
                      : undefined
                  }
                  value={query}
                  placeholder="e.g. compose up"
                  autoComplete="off"
                  onChange={(event) => {
                    setQuery(event.currentTarget.value);
                    setActiveIndex(0);
                  }}
                  onKeyDown={handleSearchKeyDown}
                />
              </label>
              <p
                className="command-find__inventory"
                data-testid="command-center-inventory"
              >
                {capabilitiesLoading
                  ? "Reading the installed command list…"
                  : capabilities
                    ? `${availableCommands.length} runnable commands${
                        capabilities.commandInventory.complete
                          ? ""
                          : " · the list is partial"
                      } · ↑↓ to move, Enter to choose`
                    : "The installed command list is unavailable."}
              </p>

              <CommandResults
                results={commandResults}
                totalMatches={commandMatches.length}
                unavailable={unavailablePluginMatches}
                activeIndex={activeIndex}
                loading={capabilitiesLoading}
                listId={RESULTS_LIST_ID}
                optionId={resultOptionId}
                onChoose={selectCommand}
                onActivate={setActiveIndex}
              />

              <div className="command-find__escape">
                {argumentRows.length > 0 ? (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setStage("command")}
                  >
                    Back to {selectedLabel || "the command"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={startFromScratch}
                  >
                    Write the arguments myself
                  </button>
                )}
              </div>
            </section>
          ) : (
            <section className="command-build" aria-label="Check and run">
              <div className="command-build__chosen">
                <div>
                  <code
                    className="command-preview"
                    data-testid="command-preview"
                  >
                    {previewTokens.map((token, index) => (
                      // Tokens are reorderable and duplicable, so position is the identity here.
                      <span key={index} className={token.className}>
                        {index > 0 ? " " : ""}
                        {token.text}
                      </span>
                    ))}
                  </code>
                  <p className="command-build__description">
                    {selectedCommand?.description ??
                      "Each row below is one literal argument, passed exactly as written."}
                  </p>
                </div>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={running}
                  onClick={() => setStage("find")}
                >
                  Choose another
                </button>
              </div>

              <div className="argv-rows" data-testid="argv-rows">
                {argumentRows.map((argument, index) => {
                  const secret = secretIndices.has(index);
                  const revealed = revealedSecrets.has(argument.id);
                  return (
                    <div className="argv-row" key={argument.id}>
                      <span className="argv-row__index">{index}</span>
                      <input
                        ref={index === 0 ? firstArgumentRef : undefined}
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
                      <div className="argv-row__actions">
                        {secret && (
                          <button
                            type="button"
                            aria-label={`${revealed ? "Hide" : "Reveal"} argument ${index}`}
                            onClick={() => toggleRevealed(argument.id)}
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
                    </div>
                  );
                })}
                {argumentRows.length === 0 && (
                  <p className="argv-rows__empty">
                    No arguments yet. Add the first Docker argument, or choose a
                    command.
                  </p>
                )}
              </div>

              <button
                type="button"
                className="command-build__add ghost-button"
                onClick={addArgument}
                disabled={running}
              >
                Add token
              </button>

              {/*
                Secondary, not hidden. Working directory, transport and environment change what a
                run does, so a disclosure that has to be opened to see whether any of them are set
                would be a surface for surprises. They are quiet and one line tall until used.
              */}
              <div className="command-options">
                <label className="command-options__cwd">
                  <span>Working directory</span>
                  <input
                    aria-label="Working directory"
                    value={cwd}
                    disabled={running}
                    placeholder="Host home (default)"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      setCwd(event.currentTarget.value);
                      invalidateConfirmation();
                    }}
                  />
                </label>
                {/* A div rather than a fieldset, matching the prune scope on ImagesScreen: a
                    legend cannot be laid out inline with the controls it labels without fighting
                    the UA's own fieldset rendering, and this group is one row tall. */}
                <div
                  className="command-options__transport"
                  role="radiogroup"
                  aria-label="Transport"
                >
                  <span>Transport</span>
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
                </div>
                <button
                  type="button"
                  className="command-options__env-add"
                  onClick={addEnvironmentVariable}
                  disabled={running}
                >
                  Add variable
                  {environmentRows.length > 0
                    ? ` · ${environmentRows.length} set`
                    : ""}
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
                        <div className="argv-row__actions">
                          {secret && (
                            <button
                              type="button"
                              onClick={() => toggleRevealed(row.id)}
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
                      </div>
                    );
                  })}
                </div>
              )}

              {environmentError && (
                <div className="command-banner command-banner--danger" role="alert">
                  {environmentError}
                </div>
              )}

              {/*
                Both notices are rendered from the argv itself, so they appear while the command is
                still being written rather than at the moment of pressing Run. The confirmation
                sentence is a separate element with role="alert" because it is the only part that
                is genuinely new information at press time.
              */}
              {containsSecrets && (
                <div className="command-banner command-banner--secret" role="status">
                  <strong>A credential is in this command.</strong>
                  <p>
                    It is masked here, excluded from history, and copy is
                    disabled. It is still sent to Docker exactly as typed.
                  </p>
                </div>
              )}

              {destructive && (
                <div className="command-banner command-banner--danger">
                  <strong>
                    This can remove or permanently change Docker resources.
                  </strong>
                  {destructiveConfirmation && (
                    <p role="alert">
                      Check the target and the command line above, then press
                      Confirm and run.
                    </p>
                  )}
                </div>
              )}

              <div className="command-build__actions">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={
                    containsSecrets ||
                    argv.length === 0 ||
                    Boolean(environmentError)
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
                {copyNotice && (
                  <span className="command-build__copy-notice" role="status">
                    {copyNotice}
                  </span>
                )}
                <button
                  type="button"
                  className={
                    destructiveConfirmation
                      ? "primary-button primary-button--danger"
                      : "primary-button"
                  }
                  disabled={running || argv.length === 0 || !context}
                  onClick={() => void runCommand()}
                >
                  {sessionState === "starting"
                    ? "Starting…"
                    : destructiveConfirmation
                      ? "Confirm and run"
                      : "Run command"}
                </button>
              </div>
            </section>
          )}

          {/* Output arrives only once there is a run to have produced it. An empty terminal
              beside the search box was the single largest piece of the old dialog and it never
              said anything until the last step. */}
          {sessionVisible && (
            <section className="command-output" aria-label="Session output">
              <div className="command-output__heading">
                <h2>Output</h2>
                <span className="command-output__state">
                  {sessionId
                    ? `${mode.toUpperCase()} · ${sessionState} · ${sessionId}`
                    : `${mode.toUpperCase()} · ${sessionState}`}
                </span>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={sessionState !== "running"}
                  onClick={() => void cancelSession()}
                >
                  Cancel
                </button>
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

              {(sessionError ||
                exitSummary ||
                truncationNotice ||
                localDroppedBytes > 0) && (
                <div
                  className={`command-output__status${sessionError ? " command-output__status--error" : ""}`}
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

              {/* Writing to a process that has exited is not a thing an operator can want, so
                  stdin appears with the running process and leaves with it. */}
              {sessionState === "running" && (
                <div className="session-controls">
                  <label className="session-input">
                    <span>Literal stdin</span>
                    <input
                      value={sessionInput}
                      onChange={(event) =>
                        setSessionInput(event.currentTarget.value)
                      }
                      placeholder="Sent exactly as entered"
                      autoComplete="off"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!sessionInput}
                    onClick={() => void sendInput(sessionInput)}
                  >
                    Send bytes
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void sendInput(`${sessionInput}\n`);
                      setSessionInput("");
                    }}
                  >
                    Send line
                  </button>
                  <button type="button" onClick={() => void sendInput("", true)}>
                    EOF
                  </button>
                  {mode === "pty" && (
                    <>
                      <label>
                        <span>Rows</span>
                        <input
                          aria-label="PTY rows"
                          type="number"
                          min="8"
                          max="200"
                          value={rows}
                          onChange={(event) =>
                            setRows(Number(event.currentTarget.value))
                          }
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
                          onChange={(event) =>
                            setCols(Number(event.currentTarget.value))
                          }
                        />
                      </label>
                      <button type="button" onClick={() => void resizeSession()}>
                        Resize
                      </button>
                    </>
                  )}
                </div>
              )}
            </section>
          )}
        </div>

        <footer className="command-center__footer">
          <p className="command-center__privacy">
            History is memory-only and never written to disk. A command carrying
            a credential is not copied and not remembered.
          </p>
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
        </footer>
      </div>
    </div>
  );
}
