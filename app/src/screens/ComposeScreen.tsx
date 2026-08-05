import { SessionActivityPanel } from "../components/SessionActivityPanel";
import { useEffect, useMemo, useState } from "react";

import { AnchorageIcon } from "../components/AnchorageIcon";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type {
  AnchorageContainer,
  ComposeConfigResult,
  ComposeConfigService,
  ComposeProject,
  ComposeService,
} from "../types";

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
 * `service_healthy` is Compose's key, not a sentence. The prefix is stripped rather than
 * mapped through a table, so a condition Compose adds later still arrives in its own words
 * instead of collapsing into "unknown".
 */
const conditionLabel = (condition: string) =>
  condition.replace(/^service_/u, "").replace(/_/gu, " ") || "started";

/**
 * One service as the screen shows it: what the file declares joined to what is running.
 *
 * `compose ps` and `compose config` answer different questions and neither is a superset —
 * ps knows the container, config knows the ordering and the declarations — so a service can
 * appear in one and not the other. A service with no live row has no container; a live row
 * with no declaration is a container the current file no longer defines.
 */
interface ServiceRow {
  name: string;
  config: ComposeConfigService | null;
  live: ComposeService | null;
}

function joinServices(
  config: ComposeConfigResult | undefined,
  live: ComposeService[],
): ServiceRow[] {
  const liveByService = new Map(live.map((service) => [service.service, service]));
  if (!config) {
    return live.map((service) => ({
      name: service.service,
      config: null,
      live: service,
    }));
  }
  // config.services is already ordered by start order then name (core/compose_config.go),
  // so the file's own ordering is preserved rather than re-derived here.
  const rows: ServiceRow[] = config.services.map((service) => ({
    name: service.name,
    config: service,
    live: liveByService.get(service.name) ?? null,
  }));
  const declared = new Set(config.services.map((service) => service.name));
  for (const service of live) {
    if (!declared.has(service.service)) {
      rows.push({ name: service.service, config: null, live: service });
    }
  }
  return rows;
}

function ServiceStartOrder({
  project,
  rows,
  resolved,
  store,
}: {
  project: string;
  rows: ServiceRow[];
  resolved: boolean;
  store: AnchorageStore;
}) {
  // Which services are open. Local rather than in the store: it is view state that means nothing
  // once the operator leaves the project, and persisting it would restore rows they did not open.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  return (
    <section className="compose-panel">
      <div className="compose-panel__heading">
        <h3>{resolved ? "Start order" : "Services"}</h3>
        <p>
          {resolved
            ? "Wave 0 waits for nothing; every later wave is gated by the conditions its services declare."
            : "Reported by compose ps. The resolved file is what carries start order."}
        </p>
      </div>
      <div
        className="compose-service-list"
        data-testid={`compose-services-${project}`}
      >
        {rows.length === 0 && (
          <p className="resource-dim">Reading services…</p>
        )}
        {rows.map((row) => {
          // A service only links through when its container is actually in the list;
          // Compose can report a service whose container has since been removed, and a
          // detail screen with nothing to show is worse than plain text.
          // The container this service actually produced, when it still exists. Compose keeps
          // reporting a service after its container is removed, and the detail below needs the
          // container for the one thing Compose never reports: published ports.
          const matched =
            (row.live?.containerId.length ?? 0) > 0
              ? store.containers.find(
                  (candidate) => candidate.id === row.live?.containerId,
                )
              : undefined;
          const linkable = matched !== undefined;
          const running = row.live?.state === "running";
          return (
            <div className="compose-service-entry" key={row.name}>
            <div
              className="compose-service-row"
              data-testid={`compose-service-${project}-${row.name}`}
            >
              <button
                type="button"
                className="compose-service-row__expand"
                aria-expanded={expanded.has(row.name)}
                aria-label={`${expanded.has(row.name) ? "Collapse" : "Expand"} ${row.name}`}
                data-testid={`compose-service-expand-${row.name}`}
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(row.name)) next.delete(row.name);
                    else next.add(row.name);
                    return next;
                  })
                }
              >
                <span aria-hidden="true">{expanded.has(row.name) ? "▾" : "▸"}</span>
              </button>
              <span
                className="compose-service-row__wave resource-mono"
                title={
                  row.config
                    ? `Starts in wave ${row.config.startOrder}`
                    : "Not in the resolved file, so it has no place in the start order"
                }
              >
                {row.config ? row.config.startOrder : "—"}
              </span>
              <span
                className={`compose-service-row__dot compose-service-row__dot--${
                  running ? "running" : row.live ? "idle" : "absent"
                }`}
                aria-hidden="true"
              />
              {linkable ? (
                <button
                  type="button"
                  className="compose-service-row__name compose-service__link resource-mono"
                  data-testid={`compose-service-open-${row.name}`}
                  title={`Open ${row.live?.name} logs`}
                  onClick={() =>
                    void store.selectContainer(row.live?.containerId ?? "")
                  }
                >
                  {row.name}
                </button>
              ) : (
                <span className="compose-service-row__name resource-mono">
                  {row.name}
                </span>
              )}
              <span className="compose-service-row__image resource-mono resource-dim">
                {row.config?.image ?? row.live?.image ?? "—"}
              </span>
              <span className="compose-service-row__deps">
                {row.config === null ? (
                  <span className="resource-faint">
                    not in the resolved file
                  </span>
                ) : row.config.dependsOn.length === 0 ? (
                  <span className="resource-faint">waits for nothing</span>
                ) : (
                  row.config.dependsOn.map((dependency) => (
                    <span
                      className="compose-dep-chip resource-mono"
                      key={dependency.service}
                    >
                      {dependency.service} · {conditionLabel(dependency.condition)}
                      {/* required:false means Compose starts this service anyway, which
                          changes what the condition above actually guarantees. */}
                      {dependency.required ? "" : " · optional"}
                      {dependency.restart ? " · restarts" : ""}
                    </span>
                  ))
                )}
                {row.config?.profiles && row.config.profiles.length > 0 && (
                  <span className="compose-tag compose-tag--accent">
                    profile {row.config.profiles.join(", ")}
                  </span>
                )}
              </span>
              <span
                className={`compose-service-row__state resource-mono${
                  running ? " compose-service-row__state--running" : ""
                }`}
              >
                {row.live
                  ? `${row.live.state}${row.live.health ? ` · ${row.live.health}` : ""}`
                  : "no container"}
              </span>
            </div>
            {expanded.has(row.name) && (
              <ServiceDetail
                row={row}
                container={matched}
                onOpenFull={
                  matched ? () => void store.selectContainer(matched.id) : undefined
                }
              />
            )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * What a service is, without leaving the project.
 *
 * The row already linked through to the container screen, which switched the whole view and
 * opened that container's logs — a reasonable destination and a poor default, since checking a
 * binding or an exit code meant navigating away and back. Ports are the reason this exists:
 * Compose reports a service's state but never its published bindings, so they are read from the
 * container the project produced.
 */
function ServiceDetail({
  row,
  container,
  onOpenFull,
}: {
  row: ServiceRow;
  container: AnchorageContainer | undefined;
  onOpenFull?: () => void;
}) {
  return (
    <div
      className="compose-service-detail"
      data-testid={`compose-service-detail-${row.name}`}
    >
      <dl>
        <div>
          <dt>Container</dt>
          <dd className="resource-mono">
            {container ? container.name : "no container — Compose reports this service, but the container it names is gone"}
          </dd>
        </div>
        <div>
          <dt>Image</dt>
          <dd className="resource-mono">
            {container?.image ?? row.config?.image ?? row.live?.image ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Ports</dt>
          <dd className="resource-mono">
            {/* Compose does not report bindings at all, so an empty field here would be
                ambiguous between "none" and "not known". */}
            {container?.ports?.trim() ? container.ports : "No published ports"}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd className="resource-mono">
            {container?.status ?? row.live?.status ?? "—"}
          </dd>
        </div>
      </dl>
      {onOpenFull && (
        <div className="compose-service-detail__actions">
          <button
            type="button"
            className="ghost-button"
            data-testid={`compose-service-open-full-${row.name}`}
            onClick={onOpenFull}
          >
            Open in Containers
          </button>
        </div>
      )}
    </div>
  );
}

function WatchPanel({ config }: { config: ComposeConfigResult }) {
  const rules = config.services.flatMap((service) =>
    service.watch.map((rule) => ({ service: service.name, rule })),
  );
  return (
    <section className="compose-panel" data-testid="compose-watch">
      <div className="compose-panel__heading">
        <h3>Watch rules</h3>
        <p>
          What <code>compose watch</code> would act on. Anchorage does not run it, so
          nothing here is live.
        </p>
      </div>
      {rules.length === 0 ? (
        <p className="resource-dim">
          No service in this project declares a <code>develop.watch</code> rule.
        </p>
      ) : (
        rules.map(({ service, rule }, index) => {
          // What the rule narrows itself to. Written as one string rather than three
          // conditional spans so an absent filter leaves no empty element behind.
          const filters = [
            rule.include?.length ? `include ${rule.include.join(", ")}` : "",
            rule.ignore?.length ? `ignore ${rule.ignore.join(", ")}` : "",
            rule.command?.length ? `runs ${rule.command.join(" ")}` : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <div
              className="compose-watch-row"
              key={`${service}-${rule.path}-${index}`}
            >
              <span className="compose-tag">{rule.action}</span>
              <span className="compose-watch-row__path resource-mono">
                {rule.path}
              </span>
              <span className="compose-watch-row__meta resource-mono resource-dim">
                {service}
                {rule.target ? ` → ${rule.target}` : ""}
              </span>
              {filters && (
                <span className="compose-watch-row__filters resource-dim">
                  {filters}
                </span>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}

function HooksPanel({ config }: { config: ComposeConfigResult }) {
  const hooks = config.services.flatMap((service) =>
    service.hooks.map((hook, index) => ({ service: service.name, hook, index })),
  );
  return (
    <section className="compose-panel" data-testid="compose-hooks">
      <div className="compose-panel__heading">
        <h3>Lifecycle hooks</h3>
        <p>
          A hook can run as a different user from the service it belongs to, so a
          container that stays unprivileged can still execute one privileged step.
        </p>
      </div>
      {hooks.length === 0 ? (
        <p className="resource-dim">
          No service declares a <code>post_start</code> or <code>pre_stop</code> hook.
        </p>
      ) : (
        hooks.map(({ service, hook, index }) => (
          <div
            className="compose-hook-row"
            key={`${service}-${hook.phase}-${index}`}
            data-testid={`compose-hook-${service}-${hook.phase}-${index}`}
          >
            <span className="compose-hook-row__head">
              <span className="compose-tag compose-tag--accent">
                {hook.phase === "post_start" ? "post start" : "pre stop"}
              </span>
              <span className="resource-mono resource-dim">{service}</span>
              <span className="compose-hook-row__flags">
                {/* The security-relevant case: a hook resolved to root has more authority
                    than the service it runs beside, and the file states it explicitly.
                    An unstated user is not claimed to be root — what it resolves to lives
                    in the image, which this call cannot read. */}
                {hook.runsAsRoot && (
                  <span className="compose-tag compose-tag--warning">runs as root</span>
                )}
                {hook.privileged && (
                  <span className="compose-tag compose-tag--danger">privileged</span>
                )}
                <span className="resource-mono resource-dim">
                  user {hook.user || "unstated"}
                </span>
              </span>
            </span>
            <code className="compose-hook-row__command">
              {hook.command.join(" ")}
            </code>
            {hook.workingDir && (
              <span className="resource-mono resource-dim">
                in {hook.workingDir}
              </span>
            )}
          </div>
        ))
      )}
    </section>
  );
}

function DependenciesPanel({ config }: { config: ComposeConfigResult }) {
  return (
    <section className="compose-panel" data-testid="compose-dependencies">
      <div className="compose-panel__heading">
        <h3>Declared dependencies</h3>
        <p>What the project declares but does not itself run.</p>
      </div>
      {config.dependencies.length === 0 ? (
        <p className="resource-dim">
          This project declares no volumes, secrets, models or providers.
        </p>
      ) : (
        config.dependencies.map((dependency) => (
          <div
            className="compose-dependency-row"
            key={`${dependency.kind}-${dependency.name}`}
          >
            <span className="compose-tag">{dependency.kind}</span>
            <span className="compose-dependency-row__body">
              <span className="resource-mono">{dependency.name}</span>
              <span className="resource-mono resource-dim">
                {dependency.resource ? `${dependency.resource} · ` : ""}
                {dependency.external ? "external · " : ""}
                {dependency.services.length > 0
                  ? `used by ${dependency.services.join(", ")}`
                  : "declared, unreferenced"}
              </span>
            </span>
          </div>
        ))
      )}
    </section>
  );
}

/**
 * What the resolved configuration could not answer.
 *
 * The core reports these deliberately — includes are merged away before Compose renders
 * anything, the top-level `models` section is absent from the JSON, and Compose's own
 * stderr warnings say where a value was substituted rather than stated. Dropping them
 * would let the panels above read as the whole file when they are a projection of it.
 */
function LimitationsPanel({ config }: { config: ComposeConfigResult }) {
  if (config.limitations.length === 0) return null;
  return (
    <section
      className="compose-panel compose-panel--limitations"
      data-testid="compose-limitations"
    >
      <div className="compose-panel__heading">
        <h3>What this does not show</h3>
      </div>
      <ul className="compose-limitations">
        {config.limitations.map((limitation) => (
          <li key={limitation}>{limitation}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Project-level Compose control.
 *
 * Compose is a CLI plugin with no Engine API, and it is optional, so an absent plugin is a
 * first-class state here rather than an error banner. The plugin is also the only source for
 * two things the container list cannot supply: projects whose containers have all exited, and
 * the configuration file paths that `up` cannot run without.
 *
 * The rail selects; the detail column resolves. `compose config` renders the whole file, so
 * it runs for the selected project only — never for the list — and never at all for a project
 * discovered by label, which has no file to render.
 *
 * Two panels from the handoff are deliberately absent rather than stubbed. Watch has no live
 * half: Anchorage exposes up/down/start/stop/restart and no `compose watch`, so the toggle and
 * its event log would be a control that does nothing. "Includes" cannot be listed at all —
 * Compose merges included files before rendering and drops the include entries, which the
 * limitations panel states in the core's own words.
 */
export function ComposeScreen({ store }: { store: AnchorageStore }) {
  const [pendingDown, setPendingDown] = useState<ComposeProject | null>(null);
  const [downVolumes, setDownVolumes] = useState(false);
  // One config request per project per visit. The store reports failure through a single
  // error string with no project attached, so "no config yet" cannot be the trigger — an
  // effect keyed off that would re-run the failing call forever. State rather than a ref
  // because this also decides which project a failure belongs to, and a ref mutation
  // renders nothing.
  const [requested, setRequested] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  useEffect(() => {
    void store.refreshCompose();
    // Refreshing is driven by the screen opening and by compose actions completing; a poll
    // would run `docker compose ls` continuously for a surface that changes rarely.
  }, [store.refreshCompose]);

  const projects = useMemo(
    () =>
      [...store.composeProjectList].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    [store.composeProjectList],
  );

  // The rail's selection *is* the expanded project: selecting one loads its services exactly
  // as expanding a row used to, so `compose ps` still runs for one project at a time.
  const selectedName = store.expandedComposeProject;
  const selected = projects.find((project) => project.name === selectedName) ?? null;
  const config = selectedName ? store.composeConfigs[selectedName] : undefined;
  const resolvable = (selected?.configFiles.length ?? 0) > 0;

  useEffect(() => {
    if (!selected || !resolvable) return;
    if (store.composeConfigs[selected.name]) return;
    if (requested.has(selected.name)) return;
    setRequested((current) => new Set(current).add(selected.name));
    void store.loadComposeConfig(selected.name, selected.configFiles);
  }, [
    requested,
    resolvable,
    selected,
    store.composeConfigs,
    store.loadComposeConfig,
  ]);

  // Only a Compose action blocks these controls. The session slot is shared with image
  // transfers, so without the `kind` check a background `docker pull` greyed out every Compose
  // button with nothing on screen to explain why.
  const busy =
    store.imageTransfer?.kind === "compose" &&
    (store.imageTransfer.status === "starting" ||
      store.imageTransfer.status === "running");

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

  const services = selectedName ? (store.composeServices[selectedName] ?? []) : [];
  const rows = joinServices(config, services);
  const configPending =
    selected !== null && store.composeConfigPending === selected.name;
  // The error string is global, so it is only attributed to a project this screen actually
  // asked about and is not still waiting on.
  const configError =
    selected && !config && !configPending && requested.has(selected.name)
      ? store.composeConfigError
      : null;

  return (
    <section className="compose-screen screen" data-testid="compose-screen">
      <aside className="compose-rail">
        <div className="compose-rail__heading">
          <div>
            <h1>Compose</h1>
            <p>
              {!store.isHost
                ? "Browser preview · no Docker CLI"
                : store.composeStatus === "loading"
                  ? "Reading Compose projects…"
                  : `${projects.length} project${projects.length === 1 ? "" : "s"}`}
            </p>
          </div>
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
        {store.composeError && store.composeStatus === "error" && (
          <p className="capability-error" role="status">
            {store.composeError}
          </p>
        )}

        <div className="compose-rail__list" aria-label="Compose projects">
          {projects.length === 0 && store.composeStatus === "ready" && (
            <div className="empty-state">
              <strong>No Compose projects</strong>
              <p>Projects appear here once a Compose file has been brought up.</p>
            </div>
          )}
          {projects.map((project) => {
            const active = project.name === selectedName;
            return (
              // The wrapper carries the project's own id and the control carries the
              // selection: a rail item is one button, but "the row for this project" and
              // "the control that opens it" are still two different things to address.
              <div
                key={project.name}
                data-testid={`compose-project-${project.name}`}
              >
                <button
                  type="button"
                  className={`compose-rail-item${
                    active ? " compose-rail-item--active" : ""
                  }`}
                  aria-pressed={active}
                  data-testid={`compose-expand-${project.name}`}
                  onClick={() => {
                    // toggleComposeProject collapses on a second click, which in a rail
                    // would clear the detail column the operator is reading. Selecting the
                    // current project is a no-op instead.
                    if (!active) void store.toggleComposeProject(project.name);
                  }}
                >
                  <span className="compose-rail-item__top">
                    <span
                      className={`compose-rail-item__dot compose-rail-item__dot--${
                        project.runningCount > 0 ? "running" : "idle"
                      }`}
                      aria-hidden="true"
                    />
                    <span className="compose-rail-item__name">{project.name}</span>
                    <span className="compose-rail-item__count resource-mono">
                      {project.runningCount}/{project.totalCount}
                    </span>
                  </span>
                  <ProjectStates project={project} />
                  <span className="compose-rail-item__file resource-mono">
                    {project.configFiles[0] ?? "discovered by label · no compose file"}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      <div className="compose-detail">
        {/* `down` on a real project takes tens of seconds, and until this panel existed the only
            visible effect of pressing the button was that the action buttons greyed out — which
            reads as a hang. Compose narrates its own work (`Stopping …`, `Removing network …`)
            and the store already captured every line; nothing rendered them. The error case
            mattered most: a failed action reported itself only on Images, a screen the operator
            was not looking at.

            Above the selection branch, so it survives moving through the rail while an action
            runs, and filtered by `kind` because image transfers share this slot. */}
        {store.imageTransfer?.kind === "compose" && (
          <SessionActivityPanel
            session={store.imageTransfer}
            testId="compose-action-output"
            runningMessage="Working — waiting for Compose to report."
            idleMessage="Waiting for Docker…"
          />
        )}
        {!selected ? (
          <div className="empty-state">
            <strong>
              {store.isHost
                ? "Select a project"
                : "Compose is unavailable in the browser preview"}
            </strong>
            <p>
              {store.isHost
                ? "Its services, start order, watch rules, lifecycle hooks and declared dependencies are resolved from its Compose file when you open it."
                : "Projects and the configuration behind them are read from the Docker CLI on the host. No simulated project is shown here."}
            </p>
          </div>
        ) : (
          <>
            <header className="compose-detail__header">
              <div className="compose-detail__title">
                <h2>{selected.name}</h2>
                <ProjectStates project={selected} />
              </div>
              <div className="compose-detail__actions">
                <button
                  type="button"
                  className="ghost-button"
                  data-testid={`compose-up-${selected.name}`}
                  disabled={busy || !resolvable}
                  title={
                    resolvable
                      ? "Recreate the project from its Compose file"
                      : "Compose did not report a usable configuration file for this project"
                  }
                  onClick={() =>
                    void store.runComposeAction({
                      project: selected.name,
                      action: "up",
                      configFiles: selected.configFiles,
                    })
                  }
                >
                  Up
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  data-testid={`compose-restart-${selected.name}`}
                  disabled={busy || selected.totalCount === 0}
                  onClick={() =>
                    void store.runComposeAction({
                      project: selected.name,
                      action: "restart",
                    })
                  }
                >
                  Restart
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  data-testid={`compose-stop-${selected.name}`}
                  disabled={busy || selected.runningCount === 0}
                  onClick={() =>
                    void store.runComposeAction({
                      project: selected.name,
                      action: "stop",
                    })
                  }
                >
                  Stop
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  data-testid={`compose-start-${selected.name}`}
                  disabled={busy || selected.runningCount === selected.totalCount}
                  onClick={() =>
                    void store.runComposeAction({
                      project: selected.name,
                      action: "start",
                    })
                  }
                >
                  Start
                </button>
                <button
                  type="button"
                  className="ghost-button compose-detail__down"
                  data-testid={`compose-down-${selected.name}`}
                  disabled={busy}
                  title="Remove the project's containers and networks"
                  onClick={() => {
                    setDownVolumes(false);
                    setPendingDown(selected);
                  }}
                >
                  Down
                </button>
              </div>
            </header>

            <p className="compose-detail__files resource-mono">
              {selected.configFiles.length > 0
                ? selected.configFiles.join(" · ")
                : "no compose file reported"}
              {/* Reveal, never open. The main process refuses `shell.openPath`, so this shows
                  where the project lives and cannot launch anything with a path that came from
                  a Docker daemon. Absent for a project discovered by label, which has no file. */}
              {selected.configFiles.length > 0 && (
                <button
                  type="button"
                  className="compose-detail__reveal"
                  data-testid="compose-reveal-location"
                  title="Show this project's compose file in your file manager"
                  onClick={() => void store.revealPath(selected.configFiles[0])}
                >
                  Show in folder
                </button>
              )}
            </p>


            {/* A project found on container labels alone cannot be rendered at all: `config`
                resolves files by path, and asking without one would resolve whatever happens
                to sit in the working directory. The store refuses it for the same reason. */}
            {!resolvable && (
              <div className="compose-notice" data-testid="compose-unresolvable">
                <strong>This project cannot be resolved</strong>
                <p>
                  {selected.name} was discovered by label and reports no compose file,
                  so its configuration cannot be resolved. Start order, watch rules,
                  lifecycle hooks and declared dependencies all come from that file.
                </p>
              </div>
            )}

            {resolvable && configPending && (
              <p className="resource-dim" role="status">
                Resolving the Compose file…
              </p>
            )}

            {configError && (
              <div className="compose-notice" data-testid="compose-config-error">
                <strong>The Compose file could not be resolved</strong>
                <p className="capability-error">{configError}</p>
                <button
                  className="ghost-button"
                  type="button"
                  data-testid="compose-config-retry"
                  // Forgetting the project is the whole retry: the effect above requests
                  // again on the next render, so there is one call path rather than two.
                  onClick={() =>
                    setRequested((current) => {
                      const next = new Set(current);
                      next.delete(selected.name);
                      return next;
                    })
                  }
                >
                  Try again
                </button>
              </div>
            )}

            <ServiceStartOrder
              project={selected.name}
              rows={rows}
              resolved={config !== undefined}
              store={store}
            />

            {config && (
              <>
                <div className="compose-panel-grid">
                  <WatchPanel config={config} />
                  <HooksPanel config={config} />
                </div>
                <DependenciesPanel config={config} />
                <LimitationsPanel config={config} />
              </>
            )}
          </>
        )}
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
                    // The checkbox is the agreement; the core requires it separately from
                    // the confirmation to take the project down at all.
                    ...(downVolumes
                      ? { removeVolumes: true, confirmedRemoveVolumes: true }
                      : {}),
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
