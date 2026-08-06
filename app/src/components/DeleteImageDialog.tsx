import { XIcon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";

import type { AnchorageImage } from "../types";

/**
 * Confirmation for `docker rmi`.
 *
 * Three cases the previous `window.confirm` could not express:
 *  - a dangling image has no tag, so it is removed by immutable ID;
 *  - an in-use image needs `--force`, which must be consented to explicitly;
 *  - an image with several tags loses only the selected tag unless it is the last one.
 */
export function DeleteImageDialog({
  image,
  onCancel,
  onConfirm,
}: {
  image: AnchorageImage;
  onCancel: () => void;
  onConfirm: (options: { force?: boolean }) => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<Element | null>(null);
  const dangling = !image.reference;

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    confirmRef.current?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, []);

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
      <div
        className="dialog-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-image-title"
        aria-describedby="delete-image-description"
        data-testid="delete-image-dialog"
      >
        <div className="dialog-panel__heading">
          <div>
            <h2 id="delete-image-title">
              {image.inUse ? "Force remove image" : "Remove image"}
            </h2>
            <p id="delete-image-description">
              {image.inUse
                ? "This image still backs one or more containers. Docker will only remove it with force, which can leave those containers unable to restart."
                : dangling
                  ? "This untagged image will be removed by its image ID."
                  : `The tag ${image.repository}:${image.tag} will be removed. Layers are deleted only if no other tag references them.`}
            </p>
          </div>
          <button type="button" aria-label="Close remove image" onClick={onCancel}>
            <XIcon aria-hidden="true" size={15} />
          </button>
        </div>

        <p className="resource-mono resource-dim" data-testid="delete-image-target">
          {dangling ? image.imageId : image.reference} · {image.size}
        </p>

        <div className="dialog-panel__actions">
          <button className="ghost-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary-button primary-button--danger"
            type="button"
            ref={confirmRef}
            data-testid="delete-image-confirm"
            onClick={() => onConfirm(image.inUse ? { force: true } : {})}
          >
            {image.inUse ? "Force remove" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}
