import { DownloadSimpleIcon, XIcon } from "@phosphor-icons/react";

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

/** Ancestors of a path, for the breadcrumb. */
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
 * A real container filesystem browser.
 *
 * The listing walks tar headers from the Engine archive endpoint rather than exec'ing `ls`,
 * so it works on scratch and distroless images that contain no shell at all. Previously this
 * tab showed a fabricated tree in the browser preview and an unavailable state against real
 * Docker.
 */
export function ContainerFilesPanel({ store }: { store: AnchorageStore }) {
  const listing = store.fileListing;
  const preview = store.filePreview;
  const crumbs = crumbsFor(store.filePath);
  const parent =
    store.filePath === "/"
      ? null
      : store.filePath.slice(0, store.filePath.lastIndexOf("/")) || "/";

  return (
    <div className="detail-panel container-files" data-testid="container-files">
      <div className="files-toolbar">
        <label className="ghost-button files-upload">
          Upload
          <input
            type="file"
            data-testid="file-upload"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              // Reset so re-selecting the same file fires change again.
              event.currentTarget.value = "";
              if (file) void store.uploadFile(file);
            }}
          />
        </label>
        <span className="resource-dim">into {store.filePath}</span>
      </div>

      <nav className="files-breadcrumb" aria-label="Container path">
        {crumbs.map((crumb, index) => (
          <span key={crumb.path}>
            {index > 0 && <span aria-hidden="true">/</span>}
            <button
              type="button"
              onClick={() => void store.browseFiles(crumb.path)}
              aria-current={crumb.path === store.filePath ? "location" : undefined}
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>

      {store.fileError && (
        <p className="capability-error" role="status">
          {store.fileError}
        </p>
      )}

      {listing?.truncated && (
        <p className="files-truncated" role="status">
          {listing.limitations[0]}
        </p>
      )}

      <div className="files-table" data-testid="container-files-table">
        <div className="files-table__head">
          <span>NAME</span>
          <span>SIZE</span>
          <span>MODE</span>
          <span>MODIFIED</span>
        </div>
        {parent && (
          <div className="files-row files-row--up">
            <button type="button" onClick={() => void store.browseFiles(parent)}>
              ..
            </button>
          </div>
        )}
        {listing?.entries.map((entry) => (
          <div className="files-row" key={entry.path}>
            {entry.isDir ? (
              <button
                type="button"
                className="files-row__name files-row__name--dir"
                data-testid={`file-${entry.name}`}
                onClick={() => void store.browseFiles(entry.path)}
              >
                {entry.name}/
              </button>
            ) : (
              <button
                type="button"
                className="files-row__name"
                data-testid={`file-${entry.name}`}
                onClick={() => void store.previewFile(entry.path)}
              >
                {entry.name}
                {entry.linkTarget && (
                  <span className="resource-dim"> → {entry.linkTarget}</span>
                )}
              </button>
            )}
            <span className="resource-mono resource-secondary">
              {entry.isDir ? "—" : formatBytes(entry.sizeBytes)}
            </span>
            <span className="resource-mono resource-dim">{entry.mode}</span>
            <span className="resource-dim files-row__meta">
              {entry.modifiedAt ? entry.modifiedAt.slice(0, 19).replace("T", " ") : "—"}
              {!entry.isDir && (
                <button
                  type="button"
                  className="files-row__download"
                  aria-label={`Download ${entry.name}`}
                  onClick={() => void store.downloadFile(entry.path)}
                >
                  <DownloadSimpleIcon aria-hidden="true" size={13} />
                </button>
              )}
            </span>
          </div>
        ))}
        {listing && listing.entries.length === 0 && (
          <div className="empty-state">
            <strong>Empty directory</strong>
          </div>
        )}
        {!listing && !store.fileError && (
          <p className="resource-dim" role="status">
            Reading container filesystem…
          </p>
        )}
      </div>

      {preview && (
        <section className="file-preview" data-testid="file-preview">
          <header>
            <strong className="resource-mono">{preview.path}</strong>
            <span className="resource-dim">{formatBytes(preview.sizeBytes)}</span>
            <button
              type="button"
              aria-label="Close file preview"
              onClick={store.closeFilePreview}
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
    </div>
  );
}
