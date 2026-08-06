import { useEffect, useRef } from "react";
import type { CommandNode, DockerCliPlugin } from "../types";

/*
 * The search results, and the installed things that cannot be results.
 *
 * Split out of CommandCenter because it is the whole of the first step and none of the rest:
 * it holds no session state, starts nothing, and answers exactly one question — which of the
 * commands on this machine matches what has been typed.
 */

export function CommandResults({
  results,
  totalMatches,
  unavailable,
  activeIndex,
  loading,
  listId,
  optionId,
  onChoose,
  onActivate,
}: {
  results: CommandNode[];
  totalMatches: number;
  unavailable: DockerCliPlugin[];
  /** The row Enter would choose. Owned by the search box, which is where the arrow keys land. */
  activeIndex: number;
  loading: boolean;
  listId: string;
  optionId: (index: number) => string;
  onChoose: (command: CommandNode) => void;
  onActivate: (index: number) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Arrowing past the fold has to move the fold. Guarded because jsdom has no layout and
    // does not implement scrollIntoView at all.
    const element = activeRef.current;
    if (typeof element?.scrollIntoView === "function") {
      element.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  return (
    <>
      <div
        className="command-results"
        id={listId}
        role="listbox"
        aria-label="Installed Docker commands"
      >
        {results.map((command, index) => {
          const active = index === activeIndex;
          return (
            <button
              key={command.path.join("\0")}
              ref={active ? activeRef : undefined}
              id={optionId(index)}
              type="button"
              role="option"
              aria-selected={active}
              className={
                active ? "command-result command-result--active" : "command-result"
              }
              onClick={() => onChoose(command)}
              onMouseMove={() => onActivate(index)}
            >
              <code>{command.path.join(" ")}</code>
              <span className="command-result__kind">
                {command.kind === "plugin-command" ? "plugin" : "built-in"}
              </span>
              <span className="command-result__description">
                {command.description || "Installed Docker command"}
              </span>
            </button>
          );
        })}

        {/* Says when the list is capped. An undisclosed cut reads as a complete answer. */}
        {totalMatches > results.length && (
          <p className="command-results__truncated" role="status">
            Showing {results.length} of {totalMatches} matching commands. Narrow
            the search to see the rest.
          </p>
        )}

        {!loading && results.length === 0 && unavailable.length === 0 && (
          <p className="command-results__empty">
            No installed command leaf matches this query.
          </p>
        )}
      </div>

      {/* Installed, found on disk, and not runnable. Outside the listbox above because nothing
          here can be selected and run — presenting it as an option would be a worse answer than
          the "no match" this replaces. */}
      {unavailable.length > 0 && (
        <div className="command-unavailable" data-testid="command-center-unavailable">
          <p className="command-unavailable__lede">
            {unavailable.length === 1
              ? "One installed plugin matches but cannot run:"
              : `${unavailable.length} installed plugins match but cannot run:`}
          </p>
          {unavailable.map((plugin) => (
            <div
              className="command-unavailable__row"
              key={plugin.path ?? plugin.name}
              data-testid={`command-center-unavailable-${plugin.name}`}
            >
              <code>docker {plugin.name}</code>
              <span className="command-unavailable__reason">
                {plugin.availabilityNote ??
                  "The Docker CLI found it and would not load it."}
              </span>
              {plugin.path && (
                <span className="command-unavailable__path resource-mono">
                  {plugin.path}
                </span>
              )}
            </div>
          ))}
          <p className="command-unavailable__route">
            Settings → Engine → CLI plugins can remove or repair these.
          </p>
        </div>
      )}
    </>
  );
}
