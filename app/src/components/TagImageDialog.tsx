import { XIcon } from "@phosphor-icons/react";
import { useState } from "react";

import type { AnchorageImage } from "../types";

/**
 * Gives an image an additional reference.
 *
 * The source is the immutable image ID, never the tag shown in the row: a tag can be moved to
 * a different image between the list being rendered and the operator acting on it, so tagging
 * "what this row says" could label something else entirely.
 *
 * Only the shapes Docker cannot accept at all are caught here — a leading `-` reads as an
 * option, and whitespace would split the argument. Whether the repository name itself is
 * acceptable is the daemon's judgement, reported back through the normal error surface.
 */
export function TagImageDialog({
  image,
  busy,
  onCancel,
  onConfirm,
}: {
  image: AnchorageImage;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reference: string) => void;
}) {
  const [reference, setReference] = useState("");
  const trimmed = reference.trim();
  const problem = !trimmed
    ? null
    : trimmed.startsWith("-")
      ? "A reference starting with '-' would be read as a Docker option."
      : /\s/u.test(trimmed)
        ? "A reference cannot contain spaces."
        : null;

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-image-title"
        data-testid="tag-image-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmed || problem || busy) return;
          onConfirm(trimmed);
        }}
      >
        <div className="dialog-panel__heading">
          <div>
            <h2 id="tag-image-title">Tag image</h2>
            <p>
              Adds a reference to <code>{image.imageId.slice(0, 19)}</code>. The
              existing tags are kept; nothing is removed.
            </p>
          </div>
          <button type="button" aria-label="Close tag image" onClick={onCancel}>
            <XIcon aria-hidden="true" size={15} />
          </button>
        </div>
        <label>
          <span>New reference</span>
          <input
            data-testid="tag-image-reference"
            value={reference}
            onChange={(event) => setReference(event.currentTarget.value)}
            placeholder="registry.example.com/team/api:v2"
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
        <div className="dialog-panel__actions">
          <button className="ghost-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="submit"
            data-testid="tag-image-confirm"
            disabled={!trimmed || Boolean(problem) || busy}
          >
            Tag
          </button>
        </div>
      </form>
    </div>
  );
}
