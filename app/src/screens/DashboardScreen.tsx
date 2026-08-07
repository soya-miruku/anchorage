import { aggregateEngineCpuPercent } from "../store/engineUtilisation";
import { useEffect, useState, type CSSProperties } from "react";

import { SystemPruneDialog } from "../components/SystemPruneDialog";
import {
  DASHBOARD_ACTIVITY,
  DASHBOARD_CPU_HISTORY,
  DASHBOARD_MEMORY_HISTORY,
  DISK_USAGE_FIXTURES,
} from "../data/fixtures";
import type { AnchorageStore } from "../store/useAnchorageStore";
import { formatBytes } from "../utils/bytes";

interface StatCardProps {
  label: string;
  value: string;
  unit: string;
  detail: string;
  /** null when the value is a capacity rather than a share, so no meter is drawn. */
  percent: number | null;
  tone: "accent" | "warning" | "violet" | "blue";
}

function StatCard({
  label,
  value,
  unit,
  detail,
  percent,
  tone,
}: StatCardProps) {
  return (
    <article className={`dashboard-stat dashboard-tone--${tone}`}>
      <div className="dashboard-stat__label">{label}</div>
      <div className="dashboard-stat__value-row">
        <strong>{value}</strong>
        <span>{unit}</span>
      </div>
      {/* A null percent means the figure is a capacity, or its share is unknown. Drawing an
          empty bar would still assert "0% used", so the bar is omitted rather than emptied. */}
      {percent !== null && (
        <div className="dashboard-progress" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      <div className="dashboard-stat__detail">{detail}</div>
    </article>
  );
}

function Bars({
  values,
  kind,
}: {
  values: number[];
  kind: "cpu" | "memory";
}) {
  return (
    <div className={`dashboard-bars dashboard-bars--${kind}`} aria-hidden="true">
      {values.map((value, index) => (
        <span
          key={`${kind}-${index}`}
          style={{ "--bar-height": `${value}%` } as CSSProperties}
        />
      ))}
    </div>
  );
}

function HostDashboard({ store }: { store: AnchorageStore }) {
  const [pruneOpen, setPruneOpen] = useState(false);
  const [prunePreset, setPrunePreset] = useState<{ all: boolean; volumes: boolean } | undefined>(undefined);
  /*
   * Above the early return, and it has to stay there.
   *
   * This effect used to sit two hundred lines down, past the `if (!snapshot) return`. That made
   * the hook count 2 on the empty render and 3 on the populated one, and React does not warn
   * about that — it throws "Rendered more hooks than during the previous render" and unmounts
   * the tree. With no error boundary in the app, that is a blank window until relaunch.
   *
   * The transition is ordinary: `selectDockerContext` nulls the snapshot and reloads it, so
   * switching Docker context did it every time. Cold start can too, because `engineStatus`
   * becomes "ready" before the snapshot is awaited.
   *
   * Compose is still loaded here rather than at startup: it costs a subprocess and the startup
   * path carries measured SLOs. Loading it while the snapshot is still in flight is harmless —
   * it was never the snapshot this waited on.
   */
  useEffect(() => {
    void store.refreshCompose();
  }, [store.refreshCompose]);
  const snapshot = store.systemSnapshot;
  if (!snapshot) {
    return (
      <section className="dashboard-screen screen" data-testid="dashboard-screen">
        <header className="dashboard-header">
          <div>
            <h1>Overview</h1>
            <p>{store.dockerContext} · live Docker context</p>
          </div>
        </header>
        <div className="unsupported-surface__content" role="status">
          <strong>
            {store.hostDomainState.snapshot.status === "loading"
              ? "Loading system snapshot"
              : "System snapshot unavailable"}
          </strong>
          <p>
            {store.hostDomainState.snapshot.error ??
              "Containers are already live; the slower disk and engine snapshot is still loading."}
          </p>
        </div>
      </section>
    );
  }

  const engine = snapshot.engine;
  // The honest share of the engine's cores in use, or null when it cannot be computed.
  const engineCpuShare = aggregateEngineCpuPercent(store.containers ?? [], engine.cpus);
  // Use the daemon's own deduplicated aggregates. Summing per-image sizeBytes repeats every
  // shared parent layer, which overstated the headline figures by more than 10x on a real
  // host (133 GB reclaimable reported against `docker system df`'s 9.3 GB).
  const summary = snapshot.diskUsage.summary;
  const reclaimableImages = summary.images.reclaimableBytes;
  const reclaimableCache = summary.buildCache.reclaimableBytes;
  const diskItems = [
    {
      id: "images",
      label: "Images",
      bytes: summary.images.sizeBytes,
      detail: `${summary.images.activeCount} in use of ${summary.images.totalCount}`,
      tone: "accent" as const,
    },
    {
      id: "containers",
      label: "Containers",
      bytes: summary.containers.sizeBytes,
      detail: `${summary.containers.activeCount} running of ${summary.containers.totalCount}`,
      tone: "warning" as const,
    },
    {
      id: "volumes",
      label: "Volumes",
      bytes: summary.volumes.sizeBytes,
      detail: `${summary.volumes.activeCount} in use of ${summary.volumes.totalCount}`,
      tone: "violet" as const,
    },
    {
      id: "build-cache",
      label: "Build cache",
      bytes: summary.buildCache.sizeBytes,
      detail: `${summary.buildCache.totalCount} cache records`,
      tone: "blue" as const,
    },
  ];
  const maximumDiskBytes = Math.max(
    1,
    ...diskItems.map((item) => item.bytes),
  );
  const memoryGb = engine.memoryBytes / 1024 ** 3;


  return (
    <section className="dashboard-screen screen" data-testid="dashboard-screen">
      <header className="dashboard-header">
        <div>
          <h1>Overview</h1>
          <p>
            {store.dockerContext} · {engine.operatingSystem ?? engine.osType ?? "Docker Engine"} ·{" "}
            {engine.architecture ?? "unknown architecture"} · Docker{" "}
            {engine.serverVersion ?? engine.apiVersion}
          </p>
        </div>
        <div className="screen-header__actions">
          <button
            className="ghost-button"
            type="button"
            data-testid="system-prune-open"
            disabled={store.systemPrunePending}
            onClick={() => setPruneOpen(true)}
          >
            Prune system
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => store.openCommandCenter("compose up")}
          >
            Compose up
          </button>
        </div>
      </header>

      <div className="dashboard-stat-grid">
        <StatCard
          label="Containers running"
          value={String(engine.containersRunning)}
          unit={`/ ${engine.containers}`}
          detail={`${engine.containersStopped} stopped · ${engine.containersPaused} paused`}
          percent={
            (engine.containersRunning / Math.max(1, engine.containers)) * 100
          }
          tone="accent"
        />
        {/* Capacity, not consumption. This drew `(engine.cpus / 64) * 100`, so on a 64-core
            host the bar was permanently full and read as every CPU being used up, while
            measuring nothing. The meter now shows the aggregate share of those cores that
            running containers are actually using, and is omitted entirely when the engine has
            not reported a core count — there is no honest share without one. */}
        <StatCard
          label="Engine CPUs"
          value={String(engine.cpus)}
          unit="logical CPUs"
          detail={
            engineCpuShare === null
              ? (engine.architecture ?? "architecture unavailable")
              : `${engineCpuShare.toFixed(1)}% in use by running containers`
          }
          percent={engineCpuShare === null ? null : Math.min(100, engineCpuShare)}
          tone="warning"
        />
        {/* Also a capacity rather than a share: the old `/ 128` denominator was invented, so
            the bar told an operator with 128 GB that their memory was full. */}
        <StatCard
          label="Engine memory"
          value={memoryGb.toFixed(1)}
          unit="GB capacity"
          detail="Reported by the selected Docker engine"
          percent={null}
          tone="violet"
        />
        <StatCard
          label="Reclaimable"
          value={formatBytes(reclaimableImages + reclaimableCache)}
          unit=""
          detail="unused images and build cache"
          percent={
            ((reclaimableImages + reclaimableCache) /
              Math.max(
                1,
                snapshot.diskUsage.layersSizeBytes +
                  snapshot.diskUsage.builderSizeBytes,
              )) *
            100
          }
          tone="blue"
        />
      </div>

      {/* One click to the common cleanups, with the confirmation intact. Prune is irreversible
          and `--volumes` destroys data no registry can rebuild, so these preselect the dialog
          rather than firing straight at the daemon. There is deliberately no shortcut that
          includes volumes: the one destructive choice stays a deliberate one. */}
      <div className="dashboard-reclaim-actions" data-testid="dashboard-reclaim-actions">
        <span className="dashboard-reclaim-actions__label">Reclaim</span>
        <button
          type="button"
          className="ghost-button"
          data-testid="reclaim-dangling"
          title="Removes stopped containers, unused networks, dangling images and build cache"
          onClick={() => {
            setPrunePreset({ all: false, volumes: false });
            setPruneOpen(true);
          }}
        >
          Build cache &amp; dangling
        </button>
        <button
          type="button"
          className="ghost-button"
          data-testid="reclaim-all-images"
          title="Everything above, plus unused images that still carry tags"
          onClick={() => {
            setPrunePreset({ all: true, volumes: false });
            setPruneOpen(true);
          }}
        >
          All unused images
        </button>
        <span className="dashboard-reclaim-actions__note resource-dim">
          {formatBytes(reclaimableImages + reclaimableCache)} reclaimable · volumes are
          excluded and stay a deliberate choice
        </span>
      </div>

      <div className="dashboard-main-grid">
        <article className="dashboard-panel dashboard-chart-panel">
          <div className="dashboard-panel__heading">
            <h2>Engine</h2>
            <div className="chart-legend">
              <span>
                <i className="chart-legend__swatch chart-legend__swatch--cpu" />
                CPU {Math.round(store.engineCpu)}%
              </span>
              <span>
                <i className="chart-legend__swatch chart-legend__swatch--memory" />
                MEM {store.engineMemory.toFixed(1)} GB
              </span>
            </div>
          </div>
          {/*
            Accumulated from live per-container samples since launch. The Engine keeps no
            aggregate history, so the series starts empty and fills — it is never backfilled
            with zeroes, which would draw an idle engine that was never observed.
          */}
          {store.engineHistory.cpu.length > 1 ? (
            <>
              <Bars values={store.engineHistory.cpu} kind="cpu" />
              <div className="dashboard-chart-divider" />
              <Bars values={store.engineHistory.memory} kind="memory" />
              <div className="dashboard-chart-axis">
                <span>{store.engineHistory.cpu.length} samples</span>
                <span>now</span>
              </div>
            </>
          ) : (
            <p className="resource-dim" role="status">
              Collecting samples. The Engine reports per-container statistics only and keeps
              no history, so this series builds from launch rather than loading a past.
            </p>
          )}
          <div className="host-engine-facts">
            <span>API</span>
            <strong>{snapshot.apiVersion}</strong>
            <span>Storage driver</span>
            <strong>{engine.driver ?? "Unavailable"}</strong>
            <span>Docker root</span>
            <strong>{engine.dockerRootDir ?? "Unavailable"}</strong>
            <span>Observed</span>
            <strong>{new Date(snapshot.observedAt).toLocaleString()}</strong>
          </div>
        </article>
        <article className="dashboard-panel dashboard-activity-panel">
          <h2>Snapshot limitations</h2>
          <div className="activity-list">
            {snapshot.limitations.length > 0 ? (
              snapshot.limitations.map((limitation) => (
                <div className="activity-item" key={limitation}>
                  <span
                    className="activity-item__dot activity-item__dot--muted"
                    aria-hidden="true"
                  />
                  <div className="activity-item__text">{limitation}</div>
                </div>
              ))
            ) : (
              <div className="activity-item__text">
                No limitations reported by the host.
              </div>
            )}
          </div>
        </article>
      </div>

      <article className="dashboard-panel dashboard-disk-panel">
        <h2>Disk usage</h2>
        <div className="disk-grid">
          {diskItems.map((item) => (
            <div
              className={`disk-item dashboard-tone--${item.tone}`}
              key={item.id}
            >
              <div className="disk-item__heading">
                <span>{item.label}</span>
                <strong>{formatBytes(item.bytes)}</strong>
              </div>
              <div className="disk-item__track" aria-hidden="true">
                <span
                  style={{ width: `${(item.bytes / maximumDiskBytes) * 100}%` }}
                />
              </div>
              <div className="disk-item__detail">{item.detail}</div>
            </div>
          ))}
        </div>
      </article>

      {pruneOpen && (
        <SystemPruneDialog
          snapshot={snapshot}
          pending={store.systemPrunePending}
          preset={prunePreset}
          onCancel={() => setPruneOpen(false)}
          onConfirm={(options) => {
            setPruneOpen(false);
            void store.pruneSystem(options);
          }}
        />
      )}

      {store.systemPruneResult && (
        <div
          className="prune-result"
          role="status"
          aria-live="polite"
          data-testid="system-prune-result"
        >
          <div>
            <strong>
              Reclaimed {formatBytes(store.systemPruneResult.spaceReclaimedBytes)}
            </strong>
            <ul>
              {store.systemPruneResult.stages.map((stage) => (
                <li key={stage.resource}>
                  {stage.resource}:{" "}
                  {stage.error
                    ? `failed — ${stage.error}`
                    : `${stage.deleted.length} removed, ${formatBytes(stage.spaceReclaimedBytes)}`}
                </li>
              ))}
            </ul>
          </div>
          <button
            className="ghost-button"
            type="button"
            onClick={store.dismissSystemPruneResult}
          >
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
}

export function DashboardScreen({ store }: { store: AnchorageStore }) {
  if (store.isHost) return <HostDashboard store={store} />;
  const total = store.containers.length;
  const cpu = Math.round(store.engineCpu);
  const memory = store.engineMemory;
  const { cpus: allocatedCpus, memoryGb: allocatedMemoryGb } = store.resources;
  const memoryPercent = Math.max(
    2,
    Math.min(100, (memory / allocatedMemoryGb) * 100),
  );

  return (
    <section
      className="dashboard-screen screen"
      data-testid="dashboard-screen"
    >
      <header className="dashboard-header">
        <div>
          <h1>Overview</h1>
          <p>
            Local engine · linux/amd64 · {allocatedCpus} CPUs ·{" "}
            {allocatedMemoryGb} GB allocated
          </p>
        </div>
        <div className="screen-header__actions">
          <button
            className="ghost-button"
            type="button"
            onClick={() => void store.pruneSystem()}
          >
            Prune system
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => store.openCommandCenter("compose up")}
          >
            Compose up
          </button>
        </div>
      </header>

      <div className="dashboard-stat-grid">
        <StatCard
          label="Containers running"
          value={String(store.runningCount)}
          unit={`/ ${total}`}
          detail={`${store.stoppedCount} stopped · 1 unhealthy`}
          percent={(store.runningCount / Math.max(1, total)) * 100}
          tone="accent"
        />
        <StatCard
          label="CPU usage"
          value={`${cpu}%`}
          unit={`of ${allocatedCpus} cores`}
          detail="peak 84% in last hour"
          percent={cpu}
          tone="warning"
        />
        <StatCard
          label="Memory"
          value={memory.toFixed(1)}
          unit={`GB / ${allocatedMemoryGb} GB`}
          detail="engine overhead 0.8 GB"
          percent={memoryPercent}
          tone="violet"
        />
        <StatCard
          label="Reclaimable"
          value="9.4"
          unit="GB"
          detail="images, cache and dangling layers"
          percent={31}
          tone="blue"
        />
      </div>

      <div className="dashboard-main-grid">
        <article className="dashboard-panel dashboard-chart-panel">
          <div className="dashboard-panel__heading">
            <h2>Aggregate CPU</h2>
            <div className="chart-legend">
              <span>
                <i className="chart-legend__swatch chart-legend__swatch--cpu" />
                CPU {cpu}%
              </span>
              <span>
                <i className="chart-legend__swatch chart-legend__swatch--memory" />
                MEM {memory.toFixed(1)} GB
              </span>
            </div>
          </div>
          <Bars values={DASHBOARD_CPU_HISTORY} kind="cpu" />
          <div className="dashboard-chart-divider" />
          <Bars values={DASHBOARD_MEMORY_HISTORY} kind="memory" />
          <div className="dashboard-chart-axis">
            <span>−60s</span>
            <span>now</span>
          </div>
        </article>

        <article className="dashboard-panel dashboard-activity-panel">
          <h2>Recent activity</h2>
          <div className="activity-list">
            {DASHBOARD_ACTIVITY.map((activity) => (
              <div className="activity-item" key={activity.id}>
                <span
                  className={`activity-item__dot activity-item__dot--${activity.tone}`}
                  aria-hidden="true"
                />
                <div>
                  <div className="activity-item__text">{activity.text}</div>
                  <time>{activity.time}</time>
                </div>
              </div>
            ))}
          </div>
        </article>
      </div>

      {store.composeStatus !== "unavailable" &&
        store.composeProjectList.length > 0 && (
          <article
            className="dashboard-panel dashboard-compose-panel"
            data-testid="dashboard-compose"
          >
            <div className="dashboard-panel__heading">
              <h2>Compose projects</h2>
              <button
                type="button"
                className="ghost-button"
                onClick={() => store.navigate("compose")}
              >
                Open Compose
              </button>
            </div>
            <div className="dashboard-compose-grid">
              {store.composeProjectList.map((project) => (
                <button
                  type="button"
                  className="dashboard-compose-card"
                  key={project.name}
                  data-testid={`dashboard-compose-${project.name}`}
                  onClick={() => store.navigate("compose")}
                >
                  <span className="dashboard-compose-card__name">
                    {project.name}
                  </span>
                  <span
                    className={`dashboard-compose-card__count${
                      project.runningCount === 0
                        ? " dashboard-compose-card__count--idle"
                        : ""
                    }`}
                  >
                    {project.runningCount}
                    <small>/{project.totalCount} running</small>
                  </span>
                </button>
              ))}
            </div>
          </article>
        )}

      <article className="dashboard-panel dashboard-disk-panel">
        <h2>Disk usage</h2>
        <div className="disk-grid">
          {DISK_USAGE_FIXTURES.map((item) => (
            <div
              className={`disk-item dashboard-tone--${item.tone}`}
              key={item.id}
            >
              <div className="disk-item__heading">
                <span>{item.label}</span>
                <strong>{item.size}</strong>
              </div>
              <div className="disk-item__track" aria-hidden="true">
                <span style={{ width: `${item.percent}%` }} />
              </div>
              <div className="disk-item__detail">{item.detail}</div>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}
