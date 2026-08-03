import { XIcon } from "@phosphor-icons/react";

import type { AnchorageStore } from "../store/useAnchorageStore";

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

const crumbsFor = (target: string) => {
  const parts = target.split("/").filter(Boolean);
  const crumbs = [{ label: "/", path: "/" }];
  let accumulated = "";
  for (const part of parts) {
    accumulated += `/${part}`;
    crumbs.push({ label: part, path: accumulated });
  }
  return crumbs;
};

/**
 * A volume's contents.
 *
 * Docker exposes no way to read a volume directly, so the core mounts it read-only into a
 * helper container that is created and never started, then walks tar headers from the archive
 * endpoint — the same mechanism the container file browser uses. Nothing is executed, and the
 * helper is removed even if the request is cancelled.
 */
export function VolumeFilesPanel({ store }: { store: AnchorageStore }) {
  const volume = store.browsedVolume;
  if (!volume) return null;

  const listing = store.volumeListing;
  const preview = store.volumePreview;
  const crumbs = crumbsFor(store.volumePath);
  const parent =
    store.volumePath === "/"
      ? null
      : store.volumePath.slice(0, store.volumePath.lastIndexOf("/")) || "/";

  return (
    <aside
      className="volume-browser"
      role="dialog"
      aria-modal="false"
      aria-labelledby="volume-browser-title"
      data-testid="volume-browser"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          store.closeVolumeBrowser();
        }
      }}
    >
      <header className="volume-browser__header">
        <div>
          <h2 id="volume-browser-title">{volume}</h2>
          <p className="resource-dim">
            Mounted read-only into a helper container that is never started.
          </p>
        </div>
        <button
          type="button"
          aria-label="Close volume browser"
          data-testid="volume-browser-close"
          onClick={store.closeVolumeBrowser}
        >
          <XIcon aria-hidden="true" size={15} />
        </button>
      </header>

      <nav className="files-breadcrumb" aria-label="Volume path">
        {crumbs.map((crumb, index) => (
          <span key={crumb.path}>
            {index > 0 && <span aria-hidden="true">/</span>}
            <button
              type="button"
              onClick={() => void store.browseVolume(volume, crumb.path)}
              aria-current={crumb.path === store.volumePath ? "location" : undefined}
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>

      {store.volumeBrowseError && (
        <p className="capability-error" role="status">
          {store.volumeBrowseError}
        </p>
      )}

      {listing?.truncated && listing.limitations[0] && (
        <p className="files-truncated" role="status">
          {listing.limitations[0]}
        </p>
      )}

      <div className="files-table" data-testid="volume-files-table">
        <div className="files-table__head">
          <span>NAME</span>
          <span>SIZE</span>
          <span>MODE</span>
          <span>MODIFIED</span>
        </div>
        {parent && (
          <div className="files-row files-row--up">
            <button
              type="button"
              onClick={() => void store.browseVolume(volume, parent)}
            >
              ..
            </button>
          </div>
        )}
        {listing?.entries.map((entry) => (
          <div className="files-row" key={entry.path}>
            <button
              type="button"
              className={`files-row__name${
                entry.isDir ? " files-row__name--dir" : ""
              }`}
              data-testid={`volume-file-${entry.name}`}
              onClick={() =>
                entry.isDir
                  ? void store.browseVolume(volume, entry.path)
                  : void store.previewVolumeFile(entry.path)
              }
            >
              {entry.name}
              {entry.isDir ? "/" : ""}
              {entry.linkTarget && (
                <span className="resource-dim"> → {entry.linkTarget}</span>
              )}
            </button>
            <span className="resource-mono resource-secondary">
              {entry.isDir ? "—" : formatBytes(entry.sizeBytes)}
            </span>
            <span className="resource-mono resource-dim">{entry.mode}</span>
            <span className="resource-dim">
              {entry.modifiedAt
                ? entry.modifiedAt.slice(0, 19).replace("T", " ")
                : "—"}
            </span>
          </div>
        ))}
        {listing && listing.entries.length === 0 && (
          <div className="empty-state">
            <strong>Empty directory</strong>
          </div>
        )}
        {!listing && !store.volumeBrowseError && (
          <p className="resource-dim" role="status">
            Mounting the volume…
          </p>
        )}
      </div>

      {preview && (
        <section className="file-preview" data-testid="volume-file-preview">
          <header>
            <strong className="resource-mono">{preview.path}</strong>
            <span className="resource-dim">{formatBytes(preview.sizeBytes)}</span>
            <button
              type="button"
              aria-label="Close file preview"
              onClick={store.closeVolumePreview}
            >
              <XIcon aria-hidden="true" size={14} />
            </button>
          </header>
          {preview.encoding === "base64" ? (
            <p className="resource-dim">
              This file is not valid UTF-8, so it is not shown as text.
            </p>
          ) : (
            <pre>{preview.content}</pre>
          )}
          {preview.truncated && (
            <p className="files-truncated">
              Preview truncated at 1 MB; the file is larger.
            </p>
          )}
        </section>
      )}
    </aside>
  );
}
