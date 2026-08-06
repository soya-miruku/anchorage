import { useEffect, useRef, useState } from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { SessionMode, SessionOutputPayload } from "../types";

/*
 * The xterm surface, lifted out of CommandCenter.
 *
 * It has two callers — the Command Center and the container exec panel — and it is the only
 * part of either that owns a third-party imperative object with its own lifetime. Keeping it
 * beside the palette's state machine meant every read of that state machine scrolled past a
 * ResizeObserver and a disposal path that have nothing to do with running a command.
 */

export interface OutputChunk {
  payload: SessionOutputPayload;
  text: string;
}

export interface OutputSurface {
  write(chunk: OutputChunk): void;
  reset(): void;
}

type TerminalLoader = () => Promise<{
  Terminal: typeof import("@xterm/xterm").Terminal;
}>;

const isJSDOM =
  typeof navigator !== "undefined" && /jsdom/iu.test(navigator.userAgent);

/*
 * xterm cannot read CSS custom properties, so the theme is resolved here and handed over as
 * literal colours. The fallbacks are only reached if the host element is unstyled; every real
 * render answers from whichever theme family and mode the document is currently set to.
 */
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
    const loadTerminal = terminalLoader ?? (() => import("@xterm/xterm"));
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
