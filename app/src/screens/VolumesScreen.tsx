import { XIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";

import { AnchorageIcon } from "../components/AnchorageIcon";
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

export function VolumesScreen({ store }: { store: AnchorageStore }) {
  // window.prompt used to back this. Electron short-circuits prompt() in the renderer and
  // returns null, so in the packaged application "Create volume" silently did nothing.
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDriver, setCreateDriver] = useState("local");
  const [pruneOpen, setPruneOpen] = useState(false);
  const [pruneIncludeNamed, setPruneIncludeNamed] = useState(false);

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
              {volume.created}
              {store.isHost && (
                <button
                  className="volume-row__browse"
                  type="button"
                  aria-label={`Browse volume ${volume.name}`}
                  title="Browse this volume's contents"
                  onClick={() => void store.browseVolume(volume.name)}
                >
                  Browse
                </button>
              )}
              {store.isHost && (
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
              )}
            </span>
          </div>
        ))}
      </div>

      {store.browsedVolume && <VolumeFilesPanel store={store} />}

      {createOpen && (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="create-environment-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-volume-title"
            data-testid="create-volume-dialog"
            onSubmit={submitCreate}
          >
            <div className="create-environment-dialog__heading">
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
            <div className="create-environment-dialog__actions">
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
            className="create-environment-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="prune-volumes-title"
            data-testid="prune-volumes-dialog"
          >
            <div className="create-environment-dialog__heading">
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
            <div className="create-environment-dialog__actions">
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
