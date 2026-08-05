import { useEffect } from "react";

import { BUILD_STEP_FIXTURES } from "../data/fixtures";
import type { AnchorageStore } from "../store/useAnchorageStore";

const formatDuration = (milliseconds?: number) => {
  if (!milliseconds || milliseconds <= 0) return "—";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

const cacheRatio = (cached: number, total: number) =>
  total > 0 ? `${Math.round((cached / total) * 100)}%` : "—";

const KNOWN_BUILD_STATUSES = new Set<string>([
  "success",
  "failed",
  "cancelled",
  "running",
  "unknown",
]);

/**
 * The class modifier for a build status.
 *
 * BuildKit reports five statuses (`normalizeBuildStatus` in core/internal/core/builds.go) and
 * only `failed` is a failure — a running or cancelled build painted red would be a false
 * statement about the engine. A status this build does not know falls back to the neutral
 * `unknown` style rather than to a modifier with no rule behind it, which would leave the dot
 * invisible.
 */
const buildStatusModifier = (status: string) =>
  KNOWN_BUILD_STATUSES.has(status) ? status : "unknown";

/**
 * Live build history, backed by buildx.
 *
 * Buildx records what it built but not how: `history ls` and `history inspect` give the
 * record, its source and its step counts, with no per-step breakdown. The fixture screen
 * shows a step list; reproducing that here against a real engine would mean inventing it, so
 * this states plainly that the plugin does not report it.
 */
function HostBuilds({ store }: { store: AnchorageStore }) {
  useEffect(() => {
    void store.refreshBuilds();
  }, [store.refreshBuilds]);

  const records = store.buildRecords;
  const detail = store.buildDetail;
  const selectedRef = store.selectedBuildRef;

  if (store.buildsStatus === "unavailable") {
    return (
      <section className="resource-screen screen" data-testid="builds-screen">
        <header className="resource-header">
          <div>
            <h1>Builds</h1>
            <p>Image builds recorded by BuildKit.</p>
          </div>
        </header>
        <div className="empty-state" data-testid="builds-unavailable">
          <strong>The Docker Buildx plugin is not installed</strong>
          <p>
            Build history comes from BuildKit through <code>docker buildx</code>.
            Without the plugin the legacy builder is used, which keeps no history.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="builds-screen screen" data-testid="builds-screen">
      <aside className="builds-master">
        <div className="builds-master__heading">
          <h1>Builds</h1>
          <p>
            {store.buildsStatus === "loading"
              ? "Reading build history…"
              : `${records.length} record${records.length === 1 ? "" : "s"}`}
          </p>
        </div>

        {store.buildBuilders.length > 0 && (
          <div className="builders-strip" data-testid="builders-strip">
            {store.buildBuilders.map((builder) => (
              <span
                key={builder.name}
                className={`builder-chip${
                  builder.error ? " builder-chip--error" : ""
                }${builder.current ? " builder-chip--current" : ""}`}
                // A builder buildx cannot reach is reported with its own reason rather
                // than hidden, because "no builders" and "unreachable builders" are
                // different problems with different fixes.
                title={builder.error || `${builder.driver} · ready`}
              >
                {builder.name}
                {builder.current && <b>·</b>}
              </span>
            ))}
          </div>
        )}

        <div className="build-list" aria-label="Build history">
          {records.length === 0 && store.buildsStatus === "ready" && (
            <div className="empty-state">
              <strong>No builds recorded</strong>
              <p>BuildKit records a build the first time you run one.</p>
            </div>
          )}
          {records.map((record) => (
            <button
              key={record.ref}
              type="button"
              className={`build-list-item${
                record.ref === selectedRef ? " build-list-item--active" : ""
              }`}
              data-testid={`build-${record.id}`}
              onClick={() => void store.selectBuildRecord(record)}
            >
              <span
                className={`build-status-dot build-status-dot--${buildStatusModifier(
                  record.status,
                )}`}
                aria-hidden="true"
              />
              <span className="build-list-item__name">{record.name}</span>
              <span className="build-list-item__duration">
                {formatDuration(record.durationMs)}
              </span>
              <span className="build-list-item__meta">
                {record.createdAt.slice(0, 10)} · cache{" "}
                {cacheRatio(record.cachedSteps, record.totalSteps)}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="build-detail">
        {!selectedRef ? (
          <div className="empty-state">
            <strong>Select a build</strong>
            <p>Its source, timing and base images appear here.</p>
          </div>
        ) : store.buildDetailError ? (
          // A failed `buildx history inspect` used to leave this pane reading "Reading build
          // record…" indefinitely, with its reason routed to Settings → Builders — a screen the
          // operator who clicked the build was not looking at.
          <div className="empty-state" role="status">
            <strong>Could not read this build</strong>
            <p>{store.buildDetailError}</p>
          </div>
        ) : !detail ? (
          <p className="resource-dim" role="status">
            Reading build record…
          </p>
        ) : (
          <>
            <header className="build-detail__header">
              <div className="build-detail__title">
                <h2>{detail.name}</h2>
                <span
                  className={`build-status-pill build-status-pill--${buildStatusModifier(
                    detail.status,
                  )}`}
                >
                  {detail.status}
                </span>
              </div>
              <p>
                {formatDuration(detail.durationMs)} · {detail.completedSteps}/
                {detail.totalSteps} steps · cache{" "}
                {cacheRatio(detail.cachedSteps, detail.totalSteps)}
              </p>
            </header>

            <div className="build-stat-grid">
              <article>
                <span>Build context</span>
                <strong>{detail.buildContext || "—"}</strong>
              </article>
              <article>
                <span>Dockerfile</span>
                <strong>{detail.dockerfile || "—"}</strong>
              </article>
              <article className="build-stat--output">
                <span>Cached steps</span>
                <strong>{detail.cachedSteps}</strong>
              </article>
            </div>

            {detail.vcsRepository && (
              <div className="build-vcs" data-testid="build-vcs">
                <span className="resource-dim">Source</span>
                <strong className="resource-mono">{detail.vcsRepository}</strong>
                {detail.vcsRevision && (
                  <code>{detail.vcsRevision.slice(0, 12)}</code>
                )}
              </div>
            )}

            <h3>Base images</h3>
            {detail.materials.length === 0 ? (
              <p className="resource-dim">
                BuildKit recorded no base images for this build.
              </p>
            ) : (
              <ul className="build-materials" data-testid="build-materials">
                {detail.materials.map((material) => (
                  <li key={material} className="resource-mono">
                    {material}
                  </li>
                ))}
              </ul>
            )}

            {/* The fixture screen lists individual steps. buildx history does not report
                them, and inventing them against a live engine would be worse than saying so. */}
            <p className="resource-dim build-steps-note">
              Buildx records step counts but not the individual steps, so there is no
              per-step breakdown to show.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

export function BuildsScreen({ store }: { store: AnchorageStore }) {
  if (store.isHost) {
    return <HostBuilds store={store} />;
  }
  const selected = store.selectedBuild;
  if (!selected) return null;

  return (
    <section className="builds-screen screen" data-testid="builds-screen">
      <aside className="builds-master">
        <header>
          <h1>Builds</h1>
          <p>6 builds today · 4 succeeded · avg 1m 02s</p>
        </header>
        <div className="build-list" aria-label="Build history">
          {store.builds.map((build) => {
            const active = build.id === selected.id;
            return (
              <button
                className={`build-list-item${
                  active ? " build-list-item--active" : ""
                }`}
                data-testid={`build-${build.id}`}
                key={build.id}
                type="button"
                aria-pressed={active}
                onClick={() => store.setSelectedBuildId(build.id)}
              >
                <span
                  className={`build-status-dot build-status-dot--${build.status}`}
                  aria-hidden="true"
                />
                <strong>{build.name}</strong>
                <span className="build-list-item__duration">{build.duration}</span>
                <span className="build-list-item__meta">{build.meta}</span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="build-detail">
        <header className="build-detail__header">
          <div className="build-detail__title">
            <h2>{selected.name}</h2>
            <span className={`build-status-pill build-status-pill--${selected.status}`}>
              {selected.status}
            </span>
          </div>
          <p>
            {selected.meta} · {selected.duration} · cache {selected.cache}
          </p>
        </header>

        <div className="build-stat-grid">
          <article>
            <span>Build context</span>
            <strong>{selected.context}</strong>
          </article>
          <article>
            <span>Layers</span>
            <strong>{selected.layers}</strong>
          </article>
          <article className="build-stat--output">
            <span>Output size</span>
            <strong>{selected.output}</strong>
          </article>
        </div>

        <h3>Build steps</h3>
        <div className="build-steps">
          {BUILD_STEP_FIXTURES.map((step, index) => (
            <div className="build-step" key={`${index}-${step.command}`}>
              <span>
                {index + 1}/{BUILD_STEP_FIXTURES.length}
              </span>
              <code>{step.command}</code>
              <span className={step.cached ? "build-step__cached" : ""}>
                {step.cached ? "CACHED" : "—"}
              </span>
              <span>{step.duration}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
