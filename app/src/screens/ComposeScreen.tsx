import { useEffect, useState } from "react";

import { AnchorageIcon } from "../components/AnchorageIcon";
import { SortableHeader } from "../components/SortableHeader";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { ComposeProject } from "../types";
import { useTableSort, type ColumnSort } from "../utils/tableSort";

const PROJECT_COLUMNS: ReadonlyArray<
  ColumnSort<ComposeProject, "name" | "running" | "total">
> = [
  { key: "name", label: "Project", kind: "text", value: (row) => row.name },
  {
    key: "running",
    label: "Running",
    kind: "number",
    value: (row) => row.runningCount,
  },
  {
    key: "total",
    label: "Containers",
    kind: "number",
    value: (row) => row.totalCount,
  },
];

/** Compose's own wording, shown verbatim, with the counts it carries broken out. */
function ProjectStates({ project }: { project: ComposeProject }) {
  if (project.states.length === 0) {
    return <span className="resource-faint">No containers</span>;
  }
  return (
    <span className="compose-states">
      {project.states.map((term) => (
        <span
          key={term.state}
          className={`compose-state compose-state--${
            term.state === "running" ? "running" : "idle"
          }`}
        >
          {term.state}
          {term.count >= 0 && <b>{term.count}</b>}
        </span>
      ))}
    </span>
  );
}

/**
 * Project-level Compose control.
 *
 * Compose is a CLI plugin with no Engine API, and it is optional, so an absent plugin is a
 * first-class state here rather than an error banner. The plugin is also the only source for
 * two things the container list cannot supply: projects whose containers have all exited, and
 * the configuration file paths that `up` cannot run without.
 */
export function ComposeScreen({ store }: { store: AnchorageStore }) {
  const [pendingDown, setPendingDown] = useState<ComposeProject | null>(null);
  const [downVolumes, setDownVolumes] = useState(false);

  useEffect(() => {
    void store.refreshCompose();
    // Refreshing is driven by the screen opening and by compose actions completing; a poll
    // would run `docker compose ls` continuously for a surface that changes rarely.
  }, [store.refreshCompose]);

  const { sorted: projects, headerProps } = useTableSort(
    store.composeProjectList,
    PROJECT_COLUMNS,
    { key: "name", direction: "asc" },
  );
  const busy =
    store.imageTransfer?.status === "starting" ||
    store.imageTransfer?.status === "running";

  if (store.composeStatus === "unavailable") {
    return (
      <section className="resource-screen screen" data-testid="compose-screen">
        <header className="resource-header">
          <div>
            <h1>Compose</h1>
            <p>Multi-container projects defined by a Compose file.</p>
          </div>
        </header>
        <div className="empty-state" data-testid="compose-unavailable">
          <strong>The Docker Compose plugin is not installed</strong>
          <p>
            Anchorage drives Compose through the plugin rather than reimplementing
            it, so project controls need <code>docker compose</code> available on
            this Docker CLI.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="resource-screen screen" data-testid="compose-screen">
      <header className="resource-header">
        <div>
          <h1>Compose</h1>
          <p>
            {store.composeStatus === "loading"
              ? "Reading Compose projects…"
              : `${projects.length} project${projects.length === 1 ? "" : "s"}`}
          </p>
          {store.composeError && store.composeStatus === "error" && (
            <p className="capability-error" role="status">
              {store.composeError}
            </p>
          )}
        </div>
        <div className="screen-header__actions">
          <button
            className="ghost-button"
            type="button"
            data-testid="compose-refresh"
            disabled={store.composeStatus === "loading"}
            onClick={() => void store.refreshCompose()}
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="compose-table__head">
        <SortableHeader
          label="Project"
          ariaSort={headerProps("name")["aria-sort"]}
          onClick={headerProps("name").onClick}
        />
        <span>STATUS</span>
        <SortableHeader
          label="Running"
          ariaSort={headerProps("running")["aria-sort"]}
          onClick={headerProps("running").onClick}
        />
        <SortableHeader
          label="Containers"
          ariaSort={headerProps("total")["aria-sort"]}
          onClick={headerProps("total").onClick}
        />
        <span>ACTIONS</span>
      </div>

      <div className="compose-table__body" data-testid="compose-table-body">
        {projects.length === 0 && store.composeStatus === "ready" && (
          <div className="empty-state">
            <strong>No Compose projects</strong>
            <p>Projects appear here once a Compose file has been brought up.</p>
          </div>
        )}
        {projects.map((project) => {
          const expanded = store.expandedComposeProject === project.name;
          const services = store.composeServices[project.name] ?? [];
          // Compose reports the files as one comma-joined string, so a path that itself
          // contains a comma cannot be recovered. `up` is disabled rather than run against
          // a path that would be wrong.
          const canBringUp = project.configFiles.length > 0;
          return (
            <div className="compose-group" key={project.name}>
              <div
                className="compose-row"
                data-testid={`compose-project-${project.name}`}
              >
                <button
                  type="button"
                  className="compose-row__name"
                  aria-expanded={expanded}
                  data-testid={`compose-expand-${project.name}`}
                  onClick={() => void store.toggleComposeProject(project.name)}
                >
                  <span
                    className={`compose-row__caret${
                      expanded ? " compose-row__caret--open" : ""
                    }`}
                    aria-hidden="true"
                  />
                  {project.name}
                </button>
                <ProjectStates project={project} />
                <span className="resource-mono resource-secondary">
                  {project.runningCount}
                </span>
                <span className="resource-mono resource-secondary">
                  {project.totalCount}
                </span>
                <span className="compose-row__actions">
                  <button
                    type="button"
                    className="ghost-button"
                    data-testid={`compose-up-${project.name}`}
                    disabled={busy || !canBringUp}
                    title={
                      canBringUp
                        ? "Recreate the project from its Compose file"
                        : "Compose did not report a usable configuration file for this project"
                    }
                    onClick={() =>
                      void store.runComposeAction({
                        project: project.name,
                        action: "up",
                        configFiles: project.configFiles,
                      })
                    }
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    data-testid={`compose-restart-${project.name}`}
                    disabled={busy || project.totalCount === 0}
                    onClick={() =>
                      void store.runComposeAction({
                        project: project.name,
                        action: "restart",
                      })
                    }
                  >
                    Restart
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    data-testid={`compose-stop-${project.name}`}
                    disabled={busy || project.runningCount === 0}
                    onClick={() =>
                      void store.runComposeAction({
                        project: project.name,
                        action: "stop",
                      })
                    }
                  >
                    Stop
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    data-testid={`compose-start-${project.name}`}
                    disabled={
                      busy || project.runningCount === project.totalCount
                    }
                    onClick={() =>
                      void store.runComposeAction({
                        project: project.name,
                        action: "start",
                      })
                    }
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    className="ghost-button compose-row__down"
                    data-testid={`compose-down-${project.name}`}
                    disabled={busy}
                    title="Remove the project's containers and networks"
                    onClick={() => {
                      setDownVolumes(false);
                      setPendingDown(project);
                    }}
                  >
                    Down
                  </button>
                </span>
              </div>

              {expanded && (
                <div
                  className="compose-services"
                  data-testid={`compose-services-${project.name}`}
                >
                  {services.length === 0 ? (
                    <p className="resource-dim">Reading services…</p>
                  ) : (
                    services.map((service) => {
                      // A service only links through when its container is actually in the
                      // list; Compose can report a service whose container has since been
                      // removed, and a detail screen with nothing to show is worse than
                      // plain text.
                      const linkable =
                        service.containerId.length > 0 &&
                        store.containers.some(
                          (candidate) => candidate.id === service.containerId,
                        );
                      return (
                      <div className="compose-service" key={service.name}>
                        {linkable ? (
                          <button
                            type="button"
                            className="compose-service__name compose-service__link"
                            data-testid={`compose-service-open-${service.service}`}
                            title={`Open ${service.name} logs`}
                            onClick={() =>
                              void store.selectContainer(service.containerId)
                            }
                          >
                            {service.service}
                          </button>
                        ) : (
                          <span className="compose-service__name">
                            {service.service}
                          </span>
                        )}
                        <span className="resource-mono resource-dim">
                          {service.containerId.slice(0, 12) || "—"}
                        </span>
                        <span
                          className={`compose-state compose-state--${
                            service.state === "running" ? "running" : "idle"
                          }`}
                        >
                          {service.state}
                          {service.health ? ` · ${service.health}` : ""}
                        </span>
                        <span className="resource-dim">
                          {service.ports || "—"}
                        </span>
                      </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {pendingDown && (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="create-environment-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="compose-down-title"
            data-testid="compose-down-dialog"
          >
            <div className="create-environment-dialog__heading">
              <div>
                <h2 id="compose-down-title">
                  Take down {pendingDown.name}
                </h2>
                <p>
                  Removes the project&rsquo;s containers and networks. The Compose
                  file is untouched, so <code>Up</code> can recreate them.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close take down"
                onClick={() => setPendingDown(null)}
              >
                <AnchorageIcon name="delete" size={13} />
              </button>
            </div>
            <label className="prune-option">
              <input
                type="checkbox"
                data-testid="compose-down-volumes"
                checked={downVolumes}
                onChange={(event) => setDownVolumes(event.currentTarget.checked)}
              />
              <span>
                Also remove named volumes (<code>--volumes</code>)
                <small>
                  Volume data cannot be recovered. Without this, a database keeps
                  its contents and <code>Up</code> resumes where it left off.
                </small>
              </span>
            </label>
            <div className="create-environment-dialog__actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setPendingDown(null)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                data-testid="compose-down-confirm"
                onClick={() => {
                  const target = pendingDown;
                  setPendingDown(null);
                  void store.runComposeAction({
                    project: target.name,
                    action: "down",
                    confirmed: true,
                    ...(downVolumes ? { removeVolumes: true } : {}),
                  });
                }}
              >
                {downVolumes ? "Remove with volumes" : "Take down"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
