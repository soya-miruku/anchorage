import { XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AnchorageIcon } from "../components/AnchorageIcon";
import { ArchivePathDialog } from "../components/ArchivePathDialog";
import { CloneVolumeDialog } from "../components/CloneVolumeDialog";
import { VolumeFilesPanel } from "../components/VolumeFilesPanel";
import { SortableHeader } from "../components/SortableHeader";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { AnchorageVolume } from "../types";
import { useTableSort, type ColumnSort } from "../utils/tableSort";

const VOLUME_COLUMNS: ReadonlyArray<
  ColumnSort<AnchorageVolume, "name" | "driver" | "size" | "usedBy" | "created">
> = [
  { key: "name", label: "Name", kind: "text", value: (row) => row.name },
  { key: "driver", label: "Driver", kind: "text", value: (row) => row.driver },
  // sizeBytes is undefined when usage is unknown; null keeps those rows at the bottom.
  { key: "size", label: "Size", kind: "number", value: (row) => row.sizeBytes ?? null },
  { key: "usedBy", label: "Used by", kind: "number", value: (row) => row.refCount ?? null },
  { key: "created", label: "Created", kind: "text", value: (row) => row.created },
];

/**
 * How each volume transfer names itself in the toast. Keyed off the store's own kind so a
 * clone or an empty cannot report as the "restoring" a two-branch ternary used to make it.
 */
const TRANSFER_VERB: Record<
  NonNullable<AnchorageStore["volumeTransfer"]>["kind"],
  string
> = {
  backup: "Backing up",
  restore: "Restoring",
  clone: "Cloning",
  empty: "Emptying",
};

export function VolumesScreen({ store }: { store: AnchorageStore }) {
  // window.prompt used to back this. Electron short-circuits prompt() in the renderer and
  // returns null, so in the packaged application "Create volume" silently did nothing.
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDriver, setCreateDriver] = useState("local");
  const [pruneOpen, setPruneOpen] = useState(false);
  const [pruneIncludeNamed, setPruneIncludeNamed] = useState(false);
  const [backupTarget, setBackupTarget] = useState<AnchorageVolume | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<AnchorageVolume | null>(null);
  const [cloneTarget, setCloneTarget] = useState<AnchorageVolume | null>(null);
  const [emptyTarget, setEmptyTarget] = useState<AnchorageVolume | null>(null);
  const emptyConfirmRef = useRef<HTMLButtonElement>(null);
  const focusedBeforeEmpty = useRef<Element | null>(null);

  // The destructive confirmation takes focus and gives it back, the same way
  // DeleteContainerDialog does: without it focus drops to <body> and a keyboard user loses
  // the row they were on.
  useEffect(() => {
    if (!emptyTarget) return;
    focusedBeforeEmpty.current = document.activeElement;
    emptyConfirmRef.current?.focus();
    return () => {
      if (focusedBeforeEmpty.current instanceof HTMLElement) {
        focusedBeforeEmpty.current.focus();
      }
    };
  }, [emptyTarget]);

  const reclaimable = useMemo(
    () =>
      store.volumes.filter(
        (volume) => volume.usageKnown && volume.refCount === 0,
      ),
    [store.volumes],
  );
  // Docker's default prune removes only anonymous volumes. The daemon is the authority on
  // which those are; a 64-hex name is how they look in practice, so this is a best-effort
  // preview only and must never gate the action itself.
  const likelyAnonymous = useMemo(
    () => reclaimable.filter((volume) => /^[0-9a-f]{64}$/u.test(volume.name)),
    [reclaimable],
  );
  const pruneTargets = pruneIncludeNamed ? reclaimable : likelyAnonymous;

  const { sorted: volumeRows, headerProps } = useTableSort(
    store.filteredVolumes,
    VOLUME_COLUMNS,
  );
  // The titlebar search is the only thing narrowing this table, so an empty body is either
  // "nothing matched" or "no volumes at all" — two different things to tell the operator.
  const searchQuery = store.search.trim();
  // Every one of these verbs reads or writes a volume through the core's fixed set of volume
  // slots, and a second one arriving while the first is streaming is answered with
  // volume_browse_busy. Rather than let the operator earn that error, the controls that would
  // produce it stand down until the running transfer reports done.
  const transferRunning = store.volumeTransfer?.status === "running";
  const volumeNames = useMemo(
    () => store.volumes.map((volume) => volume.name),
    [store.volumes],
  );

  const openCreate = () => {
    setCreateName("");
    setCreateDriver("local");
    setCreateOpen(true);
  };

  const submitCreate = (event: React.FormEvent) => {
    event.preventDefault();
    const name = createName.trim();
    if (!name) return;
    setCreateOpen(false);
    void store.createVolume(name, { driver: createDriver.trim() || undefined });
  };

  const confirmPrune = () => {
    setPruneOpen(false);
    void store.pruneVolumes(pruneIncludeNamed);
  };

  return (
    <section className="resource-screen screen" data-testid="volumes-screen">
      <header className="resource-header resource-header--volumes">
        <div>
          <h1>Volumes</h1>
          <p>
            {store.volumeSummary}
            {store.isHost &&
              store.hostDomainState.volumes.status === "loading" &&
              " · refreshing live volumes…"}
          </p>
          {store.isHost && store.hostDomainState.volumes.status === "error" && (
            <p className="capability-error" role="status">
              Live volumes unavailable: {store.hostDomainState.volumes.error}
            </p>
          )}
          {/* Backup, restore, clone and empty all report their failures on the same channel
              the file browser uses, and the browser is usually closed when a row verb runs —
              a refused clone or a half-finished empty would otherwise have nowhere to appear.
              Shown only while the browser is closed, because it prints the same message and
              two copies would read as two failures. */}
          {store.volumeBrowseError && !store.browsedVolume && (
            <p
              className="capability-error"
              role="alert"
              data-testid="volume-operation-error"
            >
              {store.volumeBrowseError}
            </p>
          )}
        </div>
        <div className="screen-header__actions">
          {store.isHost && (
            <button
              className="ghost-button"
              type="button"
              disabled={
                store.volumeMutationPending ||
                store.volumes.length === 0 ||
                !store.volumes.every((volume) => volume.usageKnown) ||
                !store.volumes.some(
                  (volume) => volume.usageKnown && volume.refCount === 0,
                )
              }
              onClick={() => {
                setPruneIncludeNamed(false);
                setPruneOpen(true);
              }}
            >
              Clean up
            </button>
          )}
          <button
            className="primary-button"
            type="button"
            disabled={store.volumeMutationPending}
            onClick={openCreate}
          >
            Create volume
          </button>
        </div>
      </header>

      <div className="volumes-table__head">
        <SortableHeader label="Name" ariaSort={headerProps("name")["aria-sort"]} onClick={headerProps("name").onClick} />
        <SortableHeader label="Driver" ariaSort={headerProps("driver")["aria-sort"]} onClick={headerProps("driver").onClick} />
        <SortableHeader label="Size" ariaSort={headerProps("size")["aria-sort"]} onClick={headerProps("size").onClick} />
        <SortableHeader label="Used by" ariaSort={headerProps("usedBy")["aria-sort"]} onClick={headerProps("usedBy").onClick} />
        <SortableHeader label="Created" ariaSort={headerProps("created")["aria-sort"]} onClick={headerProps("created").onClick} />
      </div>
      <div className="volumes-table__body">
        {volumeRows.map((volume) => (
          <div
            className="volume-row"
            key={volume.name}
            data-testid={`volume-${volume.name}`}
          >
            <span className="resource-mono volume-row__name">{volume.name}</span>
            <span className="resource-muted">{volume.driver}</span>
            <span className="resource-mono resource-secondary">{volume.size}</span>
            <span className={volume.usedBy ? "resource-secondary" : "resource-faint"}>
              {!volume.usageKnown
                ? "Unknown"
                : volume.usedBy ?? "Not in use"}
            </span>
            <span className="resource-dim volume-row__created">
              <span className="volume-row__created-at">{volume.created}</span>
              {store.isHost && (
                <span className="volume-row__actions">
                  <button
                    className="volume-row__browse"
                    type="button"
                    aria-label={`Back up volume ${volume.name}`}
                    title="Write this volume's contents to a tar archive"
                    disabled={transferRunning}
                    onClick={() => setBackupTarget(volume)}
                  >
                    Back up
                  </button>
                  <button
                    className="volume-row__browse"
                    type="button"
                    aria-label={`Restore volume ${volume.name}`}
                    title="Replace this volume's contents from a backup archive"
                    disabled={transferRunning}
                    onClick={() => setRestoreTarget(volume)}
                  >
                    Restore
                  </button>
                  <button
                    className="volume-row__browse"
                    type="button"
                    aria-label={`Browse volume ${volume.name}`}
                    title="Browse this volume's contents"
                    onClick={() => void store.browseVolume(volume.name)}
                  >
                    Browse
                  </button>
                  <button
                    className="volume-row__browse"
                    type="button"
                    aria-label={`Clone volume ${volume.name}`}
                    title="Copy this volume's contents into a new volume"
                    disabled={transferRunning}
                    onClick={() => setCloneTarget(volume)}
                  >
                    Clone
                  </button>
                  <button
                    className="volume-row__browse volume-row__empty"
                    type="button"
                    aria-label={`Empty volume ${volume.name}`}
                    title="Delete everything in this volume, keeping the volume"
                    disabled={transferRunning || store.volumeMutationPending}
                    onClick={() => setEmptyTarget(volume)}
                  >
                    Empty
                  </button>
                  <button
                    className="volume-row__remove"
                    type="button"
                    aria-label={`Remove volume ${volume.name}`}
                    disabled={
                      !volume.usageKnown ||
                      Boolean(volume.usedBy) ||
                      store.volumeMutationPending
                    }
                    onClick={() => void store.removeVolume(volume)}
                  >
                    <AnchorageIcon name="delete" size={12} />
                  </button>
                </span>
              )}
            </span>
          </div>
        ))}
        {volumeRows.length === 0 && (
          <div className="empty-state" data-testid="volumes-empty-state">
            <span className="empty-state__icon" aria-hidden="true">
              <AnchorageIcon
                className="empty-state__glyph"
                name="empty"
                size={19}
              />
            </span>
            {searchQuery ? (
              <>
                <strong>No volumes match “{searchQuery}”</strong>
                <p>Clear the search, or create a volume with that name.</p>
              </>
            ) : (
              <>
                <strong>No volumes yet</strong>
                <p>
                  Create one here, or start a container that declares a volume.
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {backupTarget && (
        <ArchivePathDialog
          testId="volume-backup-dialog"
          title={`Back up ${backupTarget.name}`}
          description="Writes the volume's contents to a tar archive rooted at its own files, so any tool can read it."
          disclosure="The archive is a plaintext copy of everything in this volume. Once written it is protected by the permissions of the directory you name here, and by nothing that protected the volume."
          placeholder="/home/you/backups/project_data.tar"
          confirmLabel="Back up"
          allowOverwrite
          onCancel={() => setBackupTarget(null)}
          onConfirm={(archivePath, overwrite) => {
            const target = backupTarget;
            setBackupTarget(null);
            void store.backupVolume(target.name, archivePath, overwrite);
          }}
        />
      )}

      {restoreTarget && (
        <ArchivePathDialog
          testId="volume-restore-dialog"
          title={`Restore ${restoreTarget.name}`}
          description="Extracts a backup archive into the volume. Files already there with the same names are replaced."
          placeholder="/home/you/backups/project_data.tar"
          confirmLabel="Restore"
          onCancel={() => setRestoreTarget(null)}
          onConfirm={(archivePath) => {
            const target = restoreTarget;
            setRestoreTarget(null);
            void store.restoreVolume(target.name, archivePath);
          }}
        />
      )}

      {cloneTarget && (
        <CloneVolumeDialog
          volume={cloneTarget.name}
          existingNames={volumeNames}
          busy={transferRunning}
          onCancel={() => setCloneTarget(null)}
          onConfirm={(target) => {
            const source = cloneTarget;
            setCloneTarget(null);
            void store.cloneVolume(source.name, target);
          }}
        />
      )}

      {emptyTarget && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setEmptyTarget(null);
            }
          }}
        >
          <div
            className="dialog-panel"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="empty-volume-title"
            aria-describedby="empty-volume-description"
            data-testid="empty-volume-dialog"
          >
            <div className="dialog-panel__heading">
              <div>
                <h2 id="empty-volume-title">Empty {emptyTarget.name}</h2>
                <p id="empty-volume-description">
                  Every file in “{emptyTarget.name}” is deleted
                  {/* Only when the daemon actually measured it — "Unavailable of
                      contents" would read as a figure. */}
                  {emptyTarget.sizeBytes !== undefined &&
                    ` — ${emptyTarget.size} of contents`}
                  . Nothing is copied out first, so a database&rsquo;s data goes with
                  it. This cannot be undone.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close empty volume"
                onClick={() => setEmptyTarget(null)}
              >
                <XIcon aria-hidden="true" size={15} />
              </button>
            </div>

            <p className="volume-limitation" data-testid="empty-volume-limitations">
              Docker cannot empty a volume in place, so the volume is removed and
              recreated from its own declaration. It keeps its name, driver, labels
              and options — a Compose project still finds it — but its mount point
              and creation time are new.
            </p>

            {emptyTarget.usageKnown && Boolean(emptyTarget.usedBy) && (
              // Not an acknowledgeable warning like the in-use restore below: Docker refuses
              // to remove a volume anything references, so there is no version of this that
              // proceeds and nothing to offer beyond saying so.
              <p
                className="capability-error"
                role="status"
                data-testid="empty-volume-in-use"
              >
                Docker reports {emptyTarget.usedBy} using this volume. It will not
                release a volume a container still references, so this cannot run
                until those containers are stopped. There is no way to force it.
              </p>
            )}

            <div className="dialog-panel__actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setEmptyTarget(null)}
              >
                Cancel
              </button>
              <button
                className="primary-button primary-button--danger"
                type="button"
                ref={emptyConfirmRef}
                data-testid="empty-volume-confirm"
                disabled={
                  (emptyTarget.usageKnown && Boolean(emptyTarget.usedBy)) ||
                  transferRunning ||
                  store.volumeMutationPending
                }
                onClick={() => {
                  const target = emptyTarget;
                  setEmptyTarget(null);
                  void store.emptyVolume(target.name);
                }}
              >
                Delete contents
              </button>
            </div>
          </div>
        </div>
      )}

      {store.volumeInUseRestore && (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="dialog-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="volume-restore-inuse-title"
            data-testid="volume-restore-in-use"
          >
            <div className="dialog-panel__heading">
              <div>
                <h2 id="volume-restore-inuse-title">
                  {store.volumeInUseRestore.volume} is in use
                </h2>
                <p>
                  A running container has this volume mounted. Restoring over it
                  can corrupt data that container is using right now.
                </p>
              </div>
            </div>
            <div className="dialog-panel__actions">
              <button
                className="ghost-button"
                type="button"
                onClick={store.dismissVolumeTransfer}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                data-testid="volume-restore-in-use-confirm"
                onClick={() => {
                  const pending = store.volumeInUseRestore;
                  if (pending) {
                    void store.restoreVolume(
                      pending.volume,
                      pending.archivePath,
                      true,
                    );
                  }
                }}
              >
                Restore anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {store.volumeTransfer && (
        <div
          className="volume-transfer-toast"
          role="status"
          data-testid="volume-transfer"
        >
          <span>
            {TRANSFER_VERB[store.volumeTransfer.kind]}{" "}
            <strong>{store.volumeTransfer.volume}</strong>
            {store.volumeTransfer.status === "done" ? " · done" : "…"}
          </span>
          {store.volumeTransfer.detail && (
            <span className="resource-dim">{store.volumeTransfer.detail}</span>
          )}
          {store.volumeTransfer.status === "done" && (
            <button type="button" onClick={store.dismissVolumeTransfer}>
              Dismiss
            </button>
          )}
        </div>
      )}

      {store.browsedVolume && <VolumeFilesPanel store={store} />}

      {createOpen && (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="dialog-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-volume-title"
            data-testid="create-volume-dialog"
            onSubmit={submitCreate}
          >
            <div className="dialog-panel__heading">
              <div>
                <h2 id="create-volume-title">Create volume</h2>
                <p>Anchorage passes the name to Docker without shell interpolation.</p>
              </div>
              <button
                type="button"
                aria-label="Close create volume"
                onClick={() => setCreateOpen(false)}
              >
                <XIcon aria-hidden="true" size={15} />
              </button>
            </div>
            <label>
              <span>Name</span>
              <input
                data-testid="create-volume-name"
                value={createName}
                onChange={(event) => setCreateName(event.currentTarget.value)}
                placeholder="project_data"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </label>
            <label>
              <span>Driver</span>
              <input
                data-testid="create-volume-driver"
                value={createDriver}
                onChange={(event) => setCreateDriver(event.currentTarget.value)}
                placeholder="local"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="dialog-panel__actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={!createName.trim() || store.volumeMutationPending}
              >
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {pruneOpen && (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="dialog-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="prune-volumes-title"
            data-testid="prune-volumes-dialog"
          >
            <div className="dialog-panel__heading">
              <div>
                <h2 id="prune-volumes-title">Clean up volumes</h2>
                <p>Volume data cannot be recovered.</p>
              </div>
              <button
                type="button"
                aria-label="Close clean up volumes"
                onClick={() => setPruneOpen(false)}
              >
                <XIcon aria-hidden="true" size={15} />
              </button>
            </div>
            <label className="prune-option">
              <input
                type="checkbox"
                data-testid="prune-include-named"
                checked={pruneIncludeNamed}
                onChange={(event) =>
                  setPruneIncludeNamed(event.currentTarget.checked)
                }
              />
              <span>
                Also remove <strong>named</strong> unused volumes (
                <code>--all</code>)
                <small>
                  Named volumes are ones you created deliberately, such as a
                  stopped database&rsquo;s data volume.
                </small>
              </span>
            </label>
            <div className="prune-preview" data-testid="prune-preview">
              {pruneIncludeNamed ? (
                <p>
                  All {reclaimable.length} unused volume
                  {reclaimable.length === 1 ? "" : "s"} will be removed,
                  including named ones:
                </p>
              ) : (
                <p>
                  Docker will remove unused <strong>anonymous</strong> volumes.
                  Named volumes are kept.
                  {likelyAnonymous.length === 0 &&
                    " None of the unused volumes below look anonymous, so this may remove nothing."}
                </p>
              )}
              {pruneTargets.length > 0 && (
                <>
                  <ul>
                    {pruneTargets.slice(0, 8).map((volume) => (
                      <li key={volume.name} className="resource-mono">
                        {volume.name}
                      </li>
                    ))}
                  </ul>
                  {pruneTargets.length > 8 && (
                    <p className="resource-dim">
                      and {pruneTargets.length - 8} more
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="dialog-panel__actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setPruneOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                data-testid="prune-confirm"
                disabled={
                  reclaimable.length === 0 || store.volumeMutationPending
                }
                onClick={confirmPrune}
              >
                {pruneIncludeNamed
                  ? `Remove ${reclaimable.length} unused`
                  : "Remove anonymous"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
