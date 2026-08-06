import { XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

/**
 * Mirrors the core's own volume-name rule, so a name it is going to refuse is caught before
 * the copy starts rather than after a long read has already run.
 */
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

/**
 * Asks where a volume should be copied to.
 *
 * Clone is the only volume verb that creates a second resource, so the name it asks for names
 * something that must not exist yet. Docker's volume create is idempotent — it answers with
 * the volume that is already there — so a clone onto an existing name would quietly pour one
 * volume's files into another's. The core refuses that outright, and there is no overwrite to
 * agree to, so this dialog offers none: unlike the archive dialogs, the only answer to a taken
 * name is a different name.
 *
 * The limitation is stated here rather than reported afterwards. A clone carries none of the
 * source's labels or driver options, and an operator who learns that after the copy has
 * already been treated as interchangeable with the original has learned it too late.
 */
export function CloneVolumeDialog({
  volume,
  existingNames,
  busy,
  onCancel,
  onConfirm,
}: {
  volume: string;
  /**
   * The volume names already on screen. Only a first line of defence — the daemon is the
   * authority and the core re-checks — but it turns the common mistake into a sentence in
   * the dialog instead of a failed copy.
   */
  existingNames: readonly string[];
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (target: string) => void;
}) {
  const [target, setTarget] = useState("");
  const targetRef = useRef<HTMLInputElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  // Focus is taken and handed back, so a keyboard user returns to the row they opened this
  // from instead of dropping to <body>. Moved imperatively rather than left to `autoFocus`:
  // React applies that during commit, which is before this effect can record where focus was,
  // and the dialog would then hand focus back to itself.
  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    targetRef.current?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, []);

  const trimmed = target.trim();
  const problem = !trimmed
    ? null
    : trimmed === volume
      ? "A volume cannot be cloned onto itself. The copy needs its own name."
      : trimmed.length > 255 || !VOLUME_NAME.test(trimmed)
        ? "Volume names use letters, digits, dot, dash and underscore, and start with a letter or a digit."
        : existingNames.includes(trimmed)
          ? `“${trimmed}” already exists. A clone is never written into a volume that is already there, so there is nothing to overwrite — choose a free name, or remove that volume first.`
          : null;

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <form
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clone-volume-title"
        aria-describedby="clone-volume-description"
        data-testid="clone-volume-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmed || problem || busy) return;
          onConfirm(trimmed);
        }}
      >
        <div className="dialog-panel__heading">
          <div>
            <h2 id="clone-volume-title">Clone {volume}</h2>
            <p id="clone-volume-description">
              Copies everything in “{volume}” into a new volume. The source is read
              without starting a container and is left exactly as it is.
            </p>
          </div>
          <button type="button" aria-label="Close clone volume" onClick={onCancel}>
            <XIcon aria-hidden="true" size={15} />
          </button>
        </div>

        <p className="volume-limitation" data-testid="clone-volume-limitations">
          The copy is created bare: none of “{volume}”’s labels or driver options
          come with it. A Compose project label would enlist the copy in that
          project, so <code>docker compose down --volumes</code> would destroy the
          copy you took to keep; driver options can name the storage behind the
          source, and reusing them would point the “copy” at the same bytes.
        </p>

        <label>
          <span>New volume name</span>
          <input
            data-testid="clone-volume-target"
            ref={targetRef}
            value={target}
            onChange={(event) => setTarget(event.currentTarget.value)}
            placeholder={`${volume}_copy`}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {problem && (
          <p className="capability-error" role="status" data-testid="clone-volume-problem">
            {problem}
          </p>
        )}

        <div className="dialog-panel__actions">
          <button className="ghost-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="submit"
            data-testid="clone-volume-confirm"
            disabled={!trimmed || Boolean(problem) || busy}
          >
            Clone
          </button>
        </div>
      </form>
    </div>
  );
}
