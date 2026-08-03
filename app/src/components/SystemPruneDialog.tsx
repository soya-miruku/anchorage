import { XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import type { SystemPruneOptions, SystemSnapshot } from "../types";

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
};

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
  onCancel,
  onConfirm,
}: {
  snapshot: SystemSnapshot | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (options: SystemPruneOptions) => void;
}) {
  const [all, setAll] = useState(false);
  const [volumes, setVolumes] = useState(false);
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
        className="create-environment-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="system-prune-title"
        aria-describedby="system-prune-description"
        data-testid="system-prune-dialog"
      >
        <div className="create-environment-dialog__heading">
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

        <div className="create-environment-dialog__actions">
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
