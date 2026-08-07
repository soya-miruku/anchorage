import { memo, useState } from "react";

import { AnchorageIcon } from "../components/AnchorageIcon";
import { CreateContainerDialog } from "../components/CreateContainerDialog";
import { SortableHeader } from "../components/SortableHeader";
import { DeleteContainerDialog } from "../components/DeleteContainerDialog";
import { FixedRowWindow } from "../components/FixedRowWindow";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { AnchorageContainer } from "../types";
import { useTableSort, type ColumnSort } from "../utils/tableSort";
import {
  canOfferRemove,
  canPauseContainer,
  canRestartContainer,
  cpuTone,
  formatMemory,
  primaryContainerAction,
  removeUnavailableReason,
  requiresForceRemove,
  statusDetail,
  statusKind,
  statusLabel,
} from "../utils/containerPresentation";

interface RowCallbacks {
  onOpen: (id: string) => void;
  onToggleSelection: (id: string) => void;
  onToggle: (container: AnchorageContainer) => void;
  onRestart: (container: AnchorageContainer) => void;
  onPause: (container: AnchorageContainer) => void;
  onRequestDelete: (container: AnchorageContainer) => void;
}

function ContainerActions({
  container,
  isPending,
  onToggle,
  onRestart,
  onPause,
  onRequestDelete,
}: {
  container: AnchorageContainer;
  isPending: boolean;
} & Omit<RowCallbacks, "onOpen" | "onToggleSelection">) {
  const primaryAction = primaryContainerAction(container);
  const isRunning = primaryAction === "stop";
  const primaryLabel =
    primaryAction === "stop"
      ? "Stop"
      : primaryAction === "start"
        ? "Start"
        : primaryAction === "unpause"
          ? "Resume"
          : "Unavailable";
  const removeBlocked = removeUnavailableReason(container);

  return (
    <div
      className="container-actions"
      data-testid={`container-actions-${container.id}`}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        className={`icon-action icon-action--toggle${
          isRunning ? " icon-action--stop" : ""
        }`}
        data-testid={`container-toggle-${container.id}`}
        type="button"
        title={primaryLabel}
        aria-label={`${primaryLabel} ${container.name}`}
        disabled={isPending || primaryAction === null}
        onClick={() => onToggle(container)}
      >
        {isRunning ? (
          <AnchorageIcon name="pause" size={10} />
        ) : primaryAction === "start" || primaryAction === "unpause" ? (
          <AnchorageIcon name="play" size={10} />
        ) : null}
      </button>
      <button
        className="icon-action"
        data-testid={`container-pause-${container.id}`}
        type="button"
        title={canPauseContainer(container) ? "Pause" : "Pause is only available while running"}
        aria-label={`Pause ${container.name}`}
        disabled={isPending || !canPauseContainer(container)}
        onClick={() => onPause(container)}
      >
        <AnchorageIcon name="pause-freeze" size={12} />
      </button>
      <button
        className="icon-action"
        data-testid={`container-restart-${container.id}`}
        type="button"
        title="Restart"
        aria-label={`Restart ${container.name}`}
        disabled={isPending || !canRestartContainer(container)}
        onClick={() => onRestart(container)}
      >
        <AnchorageIcon name="restart" size={12} />
      </button>
      <button
        className="icon-action icon-action--delete"
        data-testid={`container-delete-${container.id}`}
        type="button"
        // A disabled destructive control must say why it is disabled.
        title={removeBlocked ?? (requiresForceRemove(container) ? "Force delete" : "Delete")}
        aria-label={`Delete ${container.name}`}
        disabled={isPending || !canOfferRemove(container)}
        onClick={() => onRequestDelete(container)}
      >
        <AnchorageIcon name="delete" size={12} />
      </button>
    </div>
  );
}

/**
 * Memoized on purpose. Combined with reconcileContainerIdentity in the store, a poll that
 * changes nothing now re-renders no rows at all; previously every 2s tick rebuilt every row
 * in the table. The props are deliberately narrow — passing the whole store would defeat
 * memoization, because the store object is rebuilt on every render.
 */
const ContainerRow = memo(function ContainerRow({
  container,
  isPending,
  isSelected,
  onOpen,
  onToggleSelection,
  onToggle,
  onRestart,
  onPause,
  onRequestDelete,
}: {
  container: AnchorageContainer;
  isPending: boolean;
  isSelected: boolean;
} & RowCallbacks) {
  const kind = statusKind(container);
  const open = () => onOpen(container.id);

  return (
    <div
      className="container-row"
      data-testid={`container-row-${container.id}`}
      role="button"
      tabIndex={0}
      aria-label={`Open ${container.name}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      <span
        className="container-row__select"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          type="checkbox"
          data-testid={`container-select-${container.id}`}
          aria-label={`Select ${container.name}`}
          checked={isSelected}
          onChange={() => onToggleSelection(container.id)}
        />
        <span
          className={`status-dot status-dot--${kind}`}
          aria-label={statusLabel(container)}
        />
      </span>
      <span className="container-identity">
        <span className="container-identity__title">
          <strong>{container.name}</strong>
          {container.composeProject && (
            <span
              className="compose-badge"
              title={`Compose project ${container.composeProject}`}
            >
              {container.composeProject}
            </span>
          )}
        </span>
        <span className="container-identity__id">
          {container.id.length > 12 ? container.id.slice(0, 12) : container.id}
        </span>
      </span>
      <span className="container-image" title={container.image}>
        {container.image}
      </span>
      <span className="container-status">
        <span
          className={`status-pill status-pill--${kind}`}
          title={statusDetail(container) ?? undefined}
        >
          {statusLabel(container)}
        </span>
        {container.state === "pulling" && (
          <span className="pull-progress" aria-label={`${container.progress}%`}>
            <span style={{ width: `${container.progress ?? 0}%` }} />
          </span>
        )}
      </span>
      <span
        className={`container-metric container-metric--${cpuTone(
          container.cpu,
        )}`}
      >
        {container.state === "running" && container.cpu !== null
          ? `${container.cpu.toFixed(1)}%`
          : "—"}
      </span>
      <span className="container-metric">
        {container.state === "running" && container.memory !== null
          ? formatMemory(container.memory)
          : "—"}
      </span>
      <span className="container-ports" title={container.ports}>
        {container.ports}
      </span>
      <ContainerActions
        container={container}
        isPending={isPending}
        onToggle={onToggle}
        onRestart={onRestart}
        onPause={onPause}
        onRequestDelete={onRequestDelete}
      />
    </div>
  );
});

/**
 * Sort order for the containers table. Status sorts by the user-visible grouping rather than
 * the raw daemon string, so "running" rows cluster instead of scattering by exit code.
 */
const CONTAINER_COLUMNS: ReadonlyArray<
  ColumnSort<AnchorageContainer, "name" | "image" | "status" | "cpu" | "memory">
> = [
  { key: "name", label: "Name", kind: "text", value: (row) => row.name },
  { key: "image", label: "Image", kind: "text", value: (row) => row.image },
  { key: "status", label: "Status", kind: "text", value: (row) => statusKind(row) },
  { key: "cpu", label: "CPU", kind: "number", value: (row) => row.cpu },
  { key: "memory", label: "Memory", kind: "number", value: (row) => row.memory },
];

export function ContainersScreen({ store }: { store: AnchorageStore }) {
  const [pendingDelete, setPendingDelete] = useState<AnchorageContainer | null>(
    null,
  );
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const { sorted: rows, headerProps } = useTableSort(
    store.filteredContainers,
    CONTAINER_COLUMNS,
  );

  const selectedCount = store.selectedContainerIds.size;
  const allSelected =
    store.filteredContainers.length > 0 &&
    store.filteredContainers.every((container) =>
      store.selectedContainerIds.has(container.id),
    );
  const someSelected = selectedCount > 0;
  const selectedContainers = store.containers.filter((container) =>
    store.selectedContainerIds.has(container.id),
  );
  const forcedCount = selectedContainers.filter(requiresForceRemove).length;

  return (
    <section
      className="containers-screen screen"
      data-testid="containers-screen"
    >
      <header className="screen-header containers-screen__header">
        <div>
          <h1>Containers</h1>
          <p>
            {store.runningCount} running · {store.stoppedCount} stopped ·{" "}
            {store.containers.length} total
          </p>
          {/* A table of separated rows implies separated tenants. It is the wrong
              impression to leave unstated on the screen that creates it. */}
          <p data-testid="containers-isolation-posture">
            Every container here runs on this host&rsquo;s one kernel: a
            container is a process boundary, not a security boundary between
            tenants. Anything given the Docker socket has the same authority
            over this host as Anchorage does.
          </p>
        </div>
        <div className="screen-header__actions">
          {store.composeProjects.length > 0 && (
            <select
              className="filter-button"
              data-testid="compose-project-filter"
              aria-label="Filter by compose project"
              value={store.composeFilter ?? ""}
              onChange={(event) =>
                store.setComposeFilter(event.currentTarget.value || null)
              }
            >
              <option value="">All projects</option>
              {store.composeProjects.map((project) => (
                <option key={project} value={project}>
                  {project}
                </option>
              ))}
            </select>
          )}
          <button
            className={`filter-button${
              store.onlyRunning ? " filter-button--active" : ""
            }`}
            data-testid="only-running-filter"
            type="button"
            aria-pressed={store.onlyRunning}
            onClick={() => store.setOnlyRunning(!store.onlyRunning)}
          >
            <span aria-hidden="true" />
            Only running
          </button>
          <button
            className="primary-button"
            type="button"
            data-testid="run-new-container"
            onClick={() =>
              // Host mode gets a real create form; the fixture preview has no daemon to
              // create against, so it keeps the command surface.
              store.isHost ? setCreateOpen(true) : store.openCommandCenter("run")
            }
          >
            Run new
          </button>
        </div>
      </header>

      {/*
        A metrics cap that is not stated reads as a metrics failure. Past the cap the extra rows
        show an empty CPU and MEMORY column, and the engine card totals — summed from these same
        samples — cover only the rows that were sampled.
      */}
      {store.statsPartial && (
        <p
          className="resource-dim"
          role="status"
          data-testid="containers-stats-coverage"
        >
          Live CPU and memory cover {store.statsCoverage.sampled} of{" "}
          {store.statsCoverage.running} running containers. Each sample costs the
          daemon a full collection cycle, so the rest are left unsampled — including
          in the engine totals.
        </p>
      )}

      {someSelected && (
        <div className="bulk-bar" role="toolbar" data-testid="container-bulk-bar">
          <strong>{selectedCount} selected</strong>
          <button
            className="ghost-button"
            type="button"
            data-testid="bulk-start"
            onClick={() => void store.runBulkContainerAction("start")}
          >
            Start
          </button>
          <button
            className="ghost-button"
            type="button"
            data-testid="bulk-stop"
            onClick={() => void store.runBulkContainerAction("stop")}
          >
            Stop
          </button>
          <button
            className="ghost-button ghost-button--danger"
            type="button"
            data-testid="bulk-delete"
            onClick={() => setBulkDeleteOpen(true)}
          >
            Delete
          </button>
          <button
            className="ghost-button"
            type="button"
            data-testid="bulk-clear"
            onClick={store.clearContainerSelection}
          >
            Clear
          </button>
        </div>
      )}

      <div className="container-table" data-testid="container-table">
        <div className="container-table__head" role="row">
          <span>
            <input
              type="checkbox"
              data-testid="container-select-all"
              aria-label={allSelected ? "Clear selection" : "Select all containers"}
              checked={allSelected}
              ref={(node) => {
                // Partial selection is neither checked nor unchecked.
                if (node) node.indeterminate = someSelected && !allSelected;
              }}
              onChange={() =>
                allSelected
                  ? store.clearContainerSelection()
                  : store.setContainerSelection(
                      store.filteredContainers.map((container) => container.id),
                    )
              }
            />
          </span>
          <SortableHeader
            label="Name"
            ariaSort={headerProps("name")["aria-sort"]}
            onClick={headerProps("name").onClick}
          />
          <SortableHeader
            label="Image"
            ariaSort={headerProps("image")["aria-sort"]}
            onClick={headerProps("image").onClick}
          />
          <SortableHeader
            label="Status"
            ariaSort={headerProps("status")["aria-sort"]}
            onClick={headerProps("status").onClick}
          />
          <SortableHeader
            label="CPU"
            ariaSort={headerProps("cpu")["aria-sort"]}
            onClick={headerProps("cpu").onClick}
          />
          <SortableHeader
            label="Memory"
            ariaSort={headerProps("memory")["aria-sort"]}
            onClick={headerProps("memory").onClick}
          />
          <span>PORTS</span>
          <span>ACTIONS</span>
        </div>
        {rows.length > 0 ? (
          <FixedRowWindow
            className="container-table__body"
            testId="container-table-body"
            items={rows}
            rowHeight={56}
            keyFor={(container) => container.id}
            renderRow={(container) => (
              <ContainerRow
                container={container}
                isPending={store.pendingIds.has(container.id)}
                isSelected={store.selectedContainerIds.has(container.id)}
                onOpen={store.selectContainer}
                onToggleSelection={store.toggleContainerSelection}
                onToggle={store.toggleContainer}
                onRestart={store.restartContainer}
                onPause={store.pauseContainer}
                onRequestDelete={setPendingDelete}
              />
            )}
          />
        ) : (
          <div className="container-table__body">
            <div className="empty-state" data-testid="containers-empty-state">
              <span className="empty-state__icon" aria-hidden="true">
                <AnchorageIcon
                  className="empty-state__glyph"
                  name="empty"
                  size={19}
                />
              </span>
              <strong>No containers match</strong>
              <p>
                Clear the search or the “only running” filter, or start a new
                container from an image.
              </p>
            </div>
          </div>
        )}
      </div>

      {createOpen && (
        <CreateContainerDialog
          pending={store.containerCreatePending}
          onCancel={() => setCreateOpen(false)}
          onConfirm={(options) => {
            setCreateOpen(false);
            void store.createContainer(options);
          }}
        />
      )}

      {bulkDeleteOpen && (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="dialog-panel"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="bulk-delete-title"
            data-testid="bulk-delete-dialog"
          >
            <div className="dialog-panel__heading">
              <div>
                <h2 id="bulk-delete-title">Delete {selectedCount} containers</h2>
                <p>
                  {forcedCount > 0
                    ? `${forcedCount} of them are still running and will be killed first. This cannot be undone.`
                    : "This cannot be undone."}
                </p>
              </div>
            </div>
            <div className="prune-preview">
              <ul>
                {selectedContainers.slice(0, 8).map((container) => (
                  <li key={container.id}>{container.name}</li>
                ))}
              </ul>
              {selectedContainers.length > 8 && (
                <p className="resource-dim">
                  and {selectedContainers.length - 8} more
                </p>
              )}
            </div>
            <div className="dialog-panel__actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setBulkDeleteOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button primary-button--danger"
                type="button"
                data-testid="bulk-delete-confirm"
                onClick={() => {
                  setBulkDeleteOpen(false);
                  void store.runBulkContainerAction("delete");
                }}
              >
                Delete {selectedCount}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDelete && (
        <DeleteContainerDialog
          container={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={(options) => {
            const target = pendingDelete;
            setPendingDelete(null);
            void store.deleteContainer(target, options);
          }}
        />
      )}
    </section>
  );
}
