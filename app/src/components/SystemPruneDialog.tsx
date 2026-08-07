import { XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import type { SystemPruneOptions, SystemSnapshot } from "../types";
import { formatBytes } from "../utils/bytes";

/**
 * `docker system prune`.
 *
 * Both switches default off, matching Docker. `--all` additionally deletes tagged images
 * nothing is running, and `--volumes` deletes volume data that cannot be recovered, so
 * neither is something to opt a user into silently.
 */
export function SystemPruneDialog({
  snapshot,
  pending,
  preset,
  onCancel,
  onConfirm,
}: {
  snapshot: SystemSnapshot | null;
  pending: boolean;
  /**
   * What a quick action asked for. It preselects the options; it does not skip the dialog.
   * Prune is irreversible — with `--volumes` it destroys data no registry can rebuild — so the
   * shortcuts save the tick, never the confirmation or the sentence explaining what goes.
   */
  preset?: { all?: boolean; volumes?: boolean };
  onCancel: () => void;
  onConfirm: (options: SystemPruneOptions) => void;
}) {
  const [all, setAll] = useState(preset?.all ?? false);
  const [volumes, setVolumes] = useState(preset?.volumes ?? false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    confirmRef.current?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, []);

  const summary = snapshot?.diskUsage.summary;
  // Always-reclaimed: stopped containers, unused networks and dangling image layers.
  const baseline =
    (summary?.containers.reclaimableBytes ?? 0) +
    (summary?.buildCache.reclaimableBytes ?? 0);
  const withImages = all ? (summary?.images.reclaimableBytes ?? 0) : 0;
  const withVolumes = volumes ? (summary?.volumes.reclaimableBytes ?? 0) : 0;
  const estimate = baseline + withImages + withVolumes;

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
        aria-labelledby="system-prune-title"
        aria-describedby="system-prune-description"
        data-testid="system-prune-dialog"
      >
        <div className="dialog-panel__heading">
          <div>
            <h2 id="system-prune-title">Clean up Docker</h2>
            <p id="system-prune-description">
              Removes stopped containers, unused networks, dangling images and
              build cache. This cannot be undone.
            </p>
          </div>
          <button type="button" aria-label="Close clean up Docker" onClick={onCancel}>
            <XIcon aria-hidden="true" size={15} />
          </button>
        </div>

        <label className="prune-option">
          <input
            type="checkbox"
            data-testid="system-prune-all"
            checked={all}
            onChange={(event) => setAll(event.currentTarget.checked)}
          />
          <span>
            Also remove unused <strong>tagged</strong> images (<code>--all</code>)
            <small>
              Anything no container is running, not just untagged layers. They
              would need pulling or rebuilding again.
            </small>
          </span>
        </label>

        <label className="prune-option">
          <input
            type="checkbox"
            data-testid="system-prune-volumes"
            checked={volumes}
            onChange={(event) => setVolumes(event.currentTarget.checked)}
          />
          <span>
            Also remove unused <strong>volumes</strong> (<code>--volumes</code>)
            <small>
              Volume data is not recoverable — this includes stopped databases&rsquo;
              data volumes.
            </small>
          </span>
        </label>

        <div className="prune-preview" data-testid="system-prune-preview">
          {summary ? (
            <p>
              Estimated reclaim: <strong>{formatBytes(estimate)}</strong>
              <small>
                {" "}
                Based on the last disk-usage reading; the daemon decides the exact
                set.
              </small>
            </p>
          ) : (
            <p>Disk usage has not been read yet, so no estimate is available.</p>
          )}
        </div>

        <div className="dialog-panel__actions">
          <button className="ghost-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary-button primary-button--danger"
            type="button"
            ref={confirmRef}
            data-testid="system-prune-confirm"
            disabled={pending}
            onClick={() =>
              onConfirm({
                ...(all ? { all: true } : {}),
                ...(volumes ? { volumes: true } : {}),
              })
            }
          >
            {pending ? "Cleaning up…" : "Clean up"}
          </button>
        </div>
      </div>
    </div>
  );
}
