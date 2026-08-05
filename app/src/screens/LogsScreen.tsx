import { useEffect, useRef, type ReactNode, useState} from "react";
import { UnsupportedSurface } from "../components/UnsupportedSurface";
import type { AnchorageStore } from "../store/useAnchorageStore";

/**
 * Holds the scroll pin, so the hook lives with the data it needs. Keeping it on the screen
 * meant reading host-only state above the browser-preview early return — a component that
 * touched the live stream before deciding whether there was one.
 */
/**
 * How many lines are in the DOM at once before the earliest are held back.
 *
 * Deep enough to cover the scrollback a reader following output actually uses, shallow enough
 * that layout on each arriving chunk stays cheap. The buffer itself is unchanged at
 * MERGED_LOG_LINE_LIMIT; this only governs how much of it is rendered.
 */
const LOG_RENDER_WINDOW = 400;

function LogStream({
  lines,
  children,
}: {
  lines: number;
  children: ReactNode;
}) {
  const streamRef = useRef<HTMLDivElement>(null);
  // Whether the reader is still at the bottom. This used to scroll to the end on every change,
  // which meant scrolling up to read something was undone by the next line to arrive — a live
  // log that could not be read while it was live.
  const pinnedRef = useRef(true);

  useEffect(() => {
    const node = streamRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [lines]);

  const handleScroll = () => {
    const node = streamRef.current;
    if (!node) return;
    // A few pixels of slack: browsers report fractional scroll positions, and demanding an
    // exact match would unpin the view for a reader who never moved.
    const distanceFromBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    pinnedRef.current = distanceFromBottom <= 4;
  };

  return (
    <div
      className="logs-stream"
      data-testid="logs-stream"
      ref={streamRef}
      onScroll={handleScroll}
      role="log"
      aria-label="Merged container output"
    >
      {children}
    </div>
  );
}

/**
 * The unified log stream: several containers' output in one place, interleaved.
 *
 * Anchorage opens one `docker logs --follow` session per selected container and merges the
 * lines as they arrive. Arrival order rather than timestamp order is deliberate — each
 * container stamps with its own clock, and sorting by those would quietly reorder lines
 * relative to what actually happened.
 *
 * The source count is capped because every source is a subprocess. The cap is stated on
 * screen rather than applied silently: a source list that looks complete and is not would
 * make an absent container read as a quiet one.
 */
export function LogsScreen({ store }: { store: AnchorageStore }) {
  if (!store.isHost) {
    return (
      <UnsupportedSurface
        testId="logs-screen"
        title="Logs"
        description="A merged log stream reads from a live daemon. The browser preview uses deterministic fixtures and never connects to one."
        posture="Log output is what a container chose to write. It is a record of the process, not an audit of it. The daemon caches output locally even for drivers that cannot be read directly, so most of it comes back — unless the container uses the none driver, or the daemon has cache-disabled set, in which case there is nothing to read."
        commandQuery="logs"
        onOpenCommand={store.openCommandCenter}
      />
    );
  }

  const lineCount = store.filteredLogLines.length;
  const [showAll, setShowAll] = useState(false);
  // Every buffered line used to be in the DOM, so a chunk arriving forced layout over the whole
  // 2000-line buffer — about 36 ms a frame while output was flowing. Fixed-row virtualisation is
  // not available here: `.logs-line__message` is `pre-wrap` with `overflow-wrap: anywhere`, so
  // rows have no fixed height and a windowed list would mispositon every row after the first
  // wrapped one. A tail window fits what a log actually is — the end is what is being read — and
  // the rest is one click away rather than dropped.
  const visible =
    showAll || lineCount <= LOG_RENDER_WINDOW
      ? store.filteredLogLines
      : store.filteredLogLines.slice(-LOG_RENDER_WINDOW);
  const held = lineCount - visible.length;
  const running = store.containers.filter(
    (container) => container.state === "running",
  );
  const selected = store.logSources;
  const atLimit = selected.length >= store.mergedLogSourceLimit;
  const errors = Object.entries(store.logStreamErrors);

  return (
    <section className="logs-screen screen" data-testid="logs-screen">
      <header className="screen-header">
        <div>
          <h1>Logs</h1>
          <p>
            {selected.length === 0
              ? `Choose containers to follow. ${running.length} running.`
              : `Following ${selected.length} of ${running.length} running · ${store.mergedLogLines.length} lines held`}
          </p>
          <p className="logs-screen__posture">
            Log output is what a container chose to write — a record of the
            process, not an audit of it. A container using the <code>none</code>{" "}
            logging driver has nothing to read back at all.
          </p>
        </div>
        <div className="logs-screen__controls">
          <label className="logs-filter">
            <span className="sr-only">Filter the merged stream</span>
            <input
              value={store.mergedLogFilter}
              onChange={(event) => store.setMergedLogFilter(event.target.value)}
              placeholder="Filter lines…"
              data-testid="logs-filter"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="ghost-button"
            onClick={store.clearMergedLogs}
            disabled={store.mergedLogLines.length === 0}
            title="Discard the lines held in view. The streams stay open."
          >
            Clear view
          </button>
        </div>
      </header>

      <div className="logs-screen__body">
        <aside className="logs-sources" data-testid="logs-sources">
          <h2>Sources</h2>
          <p className="logs-sources__note">
            {atLimit
              ? `Following the maximum of ${store.mergedLogSourceLimit}. Each source is a separate follow process, so the list is capped — deselect one to add another.`
              : `Up to ${store.mergedLogSourceLimit} at once. Each source is a separate follow process.`}
          </p>
          {running.length === 0 ? (
            <p className="logs-sources__empty">
              No containers are running, so there is nothing to follow.
            </p>
          ) : (
            <ul>
              {running.map((container) => {
                const on = selected.includes(container.id);
                return (
                  <li key={container.id}>
                    <label
                      className={`logs-source${on ? " logs-source--on" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        // Selecting past the cap is refused rather than silently dropping
                        // the oldest source, which would stop a stream the operator was
                        // reading without saying so.
                        disabled={!on && atLimit}
                        onChange={() => store.toggleLogSource(container.id)}
                      />
                      <span className="logs-source__name">{container.name}</span>
                      <span className="logs-source__image">{container.image}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <div className="logs-stream-wrap">
          {errors.length > 0 && (
            <ul className="logs-errors" data-testid="logs-errors" role="status">
              {errors.map(([name, message]) => (
                <li key={name}>
                  <strong>{name}</strong> {message}
                </li>
              ))}
            </ul>
          )}
          {held > 0 && (
            <div className="logs-earlier" data-testid="logs-earlier">
              <span>
                {held.toLocaleString()} earlier line{held === 1 ? "" : "s"} held back
              </span>
              <button
                type="button"
                className="ghost-button"
                data-testid="logs-show-earlier"
                onClick={() => setShowAll(true)}
              >
                Show all
              </button>
            </div>
          )}
          <LogStream lines={lineCount}>
            {selected.length === 0 ? (
              <p className="logs-stream__empty">
                Select a container to start following its output.
              </p>
            ) : lineCount === 0 ? (
              <p className="logs-stream__empty">
                {store.mergedLogLines.length === 0
                  ? "Following. Nothing has been written since the stream opened."
                  : `No held line matches “${store.mergedLogFilter}”.`}
              </p>
            ) : (
              visible.map((line) => (
                <div className="logs-line" key={line.id}>
                  <span className="logs-line__time">{line.timestamp}</span>
                  <span className="logs-line__source">{line.source}</span>
                  <span
                    className={`logs-line__level logs-line__level--${line.level.toLowerCase()}`}
                  >
                    {line.level}
                  </span>
                  <span className="logs-line__message">{line.message}</span>
                </div>
              ))
            )}
          </LogStream>
        </div>
      </div>
    </section>
  );
}
