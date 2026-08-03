import { BUILD_STEP_FIXTURES } from "../data/fixtures";
import { UnsupportedSurface } from "../components/UnsupportedSurface";
import type { AnchorageStore } from "../store/useAnchorageStore";

export function BuildsScreen({ store }: { store: AnchorageStore }) {
  if (store.isHost) {
    return (
      <UnsupportedSurface
        testId="builds-screen"
        title="Builds"
        description="The current renderer protocol does not expose live build history. Build commands remain available through Docker Command Center."
        commandQuery="build"
        onOpenCommand={store.openCommandCenter}
      />
    );
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
