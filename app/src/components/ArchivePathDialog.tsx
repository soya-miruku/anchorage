import { XIcon } from "@phosphor-icons/react";
import { useState } from "react";

/**
 * Asks for the host path of a tar archive.
 *
 * Save, load and export all name a file on the host rather than moving bytes through the
 * application, because an image archive is routinely gigabytes. The path is typed rather
 * than picked from a native file dialog: the core accepts a path only if its parent
 * directory resolves inside the command working-directory allowlist, so a native picker
 * would happily offer destinations the core is then obliged to refuse. Stating the rule up
 * front is more honest than a browse button that leads to a rejection.
 *
 * Only the shapes that would change what the argument *is* are caught here — a leading `-`
 * reads as a flag. Everything else is the core's decision, reported through the same error
 * surface as any other failed operation.
 */
export function ArchivePathDialog({
  title,
  description,
  placeholder,
  confirmLabel,
  testId,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  placeholder: string;
  confirmLabel: string;
  testId: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (archivePath: string) => void;
}) {
  const [archivePath, setArchivePath] = useState("");
  const trimmed = archivePath.trim();
  const looksLikeFlag = trimmed.startsWith("-");
  const isAbsolute = trimmed.startsWith("/");
  const problem = !trimmed
    ? null
    : looksLikeFlag
      ? "A path starting with '-' would be read as a Docker option."
      : !isAbsolute
        ? "Use an absolute path, so the file does not land somewhere unexpected."
        : null;

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="create-environment-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        data-testid={testId}
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmed || problem || busy) return;
          onConfirm(trimmed);
        }}
      >
        <div className="create-environment-dialog__heading">
          <div>
            <h2 id={`${testId}-title`}>{title}</h2>
            <p>{description}</p>
          </div>
          <button type="button" aria-label={`Close ${title.toLowerCase()}`} onClick={onCancel}>
            <XIcon aria-hidden="true" size={15} />
          </button>
        </div>
        <label>
          <span>Archive path</span>
          <input
            data-testid={`${testId}-path`}
            value={archivePath}
            onChange={(event) => setArchivePath(event.currentTarget.value)}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </label>
        {problem && (
          <p className="capability-error" role="status">
            {problem}
          </p>
        )}
        <div className="create-environment-dialog__actions">
          <button className="ghost-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="submit"
            data-testid={`${testId}-confirm`}
            disabled={!trimmed || Boolean(problem) || busy}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
