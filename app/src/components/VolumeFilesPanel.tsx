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
 * Docker exposes no way to read a volume directly, so the core mounts it into a helper
 * container mounted read-only, listing it with `ls` and stat-ing each entry, then reads
 * endpoint — the same mechanism the container file browser uses. Nothing is executed, and the
 * helper is removed even if the request is cancelled.
 *
 * Reads mount read-only so a browse can never alter what it inspects; only an upload asks for
 * write access, and only for that request. Writing into a volume a running container holds is
 * refused by the core until it is explicitly acknowledged.
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
            Read through a helper container with the volume mounted read-only. It
            runs nothing but a sleep loop — the image&rsquo;s own program is
            overridden — with no network and every capability dropped. Uploads
            mount it writable for that request alone.
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

      <div className="files-toolbar">
        <label className="ghost-button files-upload">
          Upload
          <input
            type="file"
            data-testid="volume-upload"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              // Reset so re-selecting the same file fires change again.
              event.currentTarget.value = "";
              if (file) void store.uploadVolumeFile(file);
            }}
          />
        </label>
        <span className="resource-dim">into {store.volumePath}</span>
      </div>

      <nav className="files-breadcrumb" aria-label="Volume path">
        {crumbs.map((crumb, index) => (
          <span key={crumb.path}>
            {/* Not after the root: its own label is already "/", so a separator here rendered
                the first hop as "/ / global". */}
            {index > 1 && <span aria-hidden="true">/</span>}
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

      {/* Docker permits mounting a volume into a second container while one is running, so
          this is a decision rather than a failure: the operator is told what is holding it
          and only a deliberate retry carries the acknowledgement. */}
      {store.volumeInUseUpload && (
        <div className="volume-inuse-warning" role="alert" data-testid="volume-in-use-warning">
          <p>
            <strong>{volume}</strong> is attached to a running container. Writing
            to it now can corrupt data that container is using.
          </p>
          <div className="volume-inuse-warning__actions">
            <button
              type="button"
              className="ghost-button"
              onClick={store.dismissVolumeInUseUpload}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              data-testid="volume-in-use-confirm"
              onClick={() => {
                const pending = store.volumeInUseUpload;
                if (pending) void store.uploadVolumeFile(pending.file, true);
              }}
            >
              Upload anyway
            </button>
          </div>
        </div>
      )}

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

      <div
        className="files-table"
        data-testid="volume-files-table"
        data-busy={store.volumeBrowsing && listing ? "true" : undefined}
      >
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
          <p className="files-table__state">Empty directory</p>
        )}
        {!listing && !store.volumeBrowseError && (
          <p className="files-table__state" role="status">
            {/* First open only. Creating the helper container is the slow part — about six
                seconds — and every hop after it reuses that container, so this says what is
                actually happening rather than implying it recurs. */}
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
