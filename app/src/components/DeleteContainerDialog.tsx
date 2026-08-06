import { XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import type { AnchorageContainer, ContainerRemoveOptions } from "../types";
import { requiresForceRemove } from "../utils/containerPresentation";

/**
 * Confirmation for `docker rm`.
 *
 * This replaces a `window.confirm` call. Beyond the Electron reliability problem, a native
 * dialog cannot express Docker's own remove options: `--force` (kill a running container
 * first) and `--volumes` (also drop its anonymous volumes). Both are implemented through the
 * protocol, the Go core and both validation layers, and had no way to be reached.
 */
export function DeleteContainerDialog({
  container,
  onCancel,
  onConfirm,
}: {
  container: AnchorageContainer;
  onCancel: () => void;
  onConfirm: (options: ContainerRemoveOptions) => void;
}) {
  const needsForce = requiresForceRemove(container);
  const [removeVolumes, setRemoveVolumes] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  // Focus management: destructive dialogs must take focus and give it back, otherwise focus
  // drops to <body> and keyboard users lose their place in the table.
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
        aria-labelledby="delete-container-title"
        aria-describedby="delete-container-description"
        data-testid="delete-container-dialog"
      >
        <div className="dialog-panel__heading">
          <div>
            <h2 id="delete-container-title">
              Delete {needsForce ? "running " : ""}container
            </h2>
            <p id="delete-container-description">
              {needsForce
                ? `“${container.name}” is ${container.state}. Docker will kill it before removing it. This cannot be undone.`
                : `“${container.name}” will be removed. This cannot be undone.`}
            </p>
          </div>
          <button type="button" aria-label="Close delete container" onClick={onCancel}>
            <XIcon aria-hidden="true" size={15} />
          </button>
        </div>

        <p className="resource-mono resource-dim" data-testid="delete-container-target">
          {container.id.slice(0, 12)}
        </p>

        <label className="prune-option">
          <input
            type="checkbox"
            data-testid="delete-container-volumes"
            checked={removeVolumes}
            onChange={(event) => setRemoveVolumes(event.currentTarget.checked)}
          />
          <span>
            Also remove anonymous volumes (<code>--volumes</code>)
            <small>Named volumes are never removed by this.</small>
          </span>
        </label>

        <div className="dialog-panel__actions">
          <button className="ghost-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary-button primary-button--danger"
            type="button"
            ref={confirmRef}
            data-testid="delete-container-confirm"
            onClick={() =>
              onConfirm({
                ...(needsForce ? { force: true } : {}),
                ...(removeVolumes ? { volumes: true } : {}),
              })
            }
          >
            {needsForce ? "Force delete" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
