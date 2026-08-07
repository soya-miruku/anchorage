import { useEffect, useState } from "react";

import { CapabilitySetup } from "../components/CapabilitySetup";
import { SessionActivityPanel } from "../components/SessionActivityPanel";
import { UnsupportedSurface } from "../components/UnsupportedSurface";
import { capabilityForView } from "../data/capabilities";
import type { AnchorageStore, TransferSession } from "../store/useAnchorageStore";
import { diagnoseModelPull } from "../store/modelPullDiagnosis";
import { parseTransferProgress } from "../store/transferProgress";
import type { DockerModel, ModelSearchResult } from "../types";

/**
 * Docker Model Runner.
 *
 * This was a stub that said "install docker-model-plugin" and nothing else. It is the one AI
 * destination that survived the removal of the rest, because it is the only one a standalone
 * Linux Engine can actually run: the plugin is packaged, the runner is an ordinary container on
 * this engine, inference is local, and no Docker account or subscription is involved.
 *
 * Three things share the screen because they only mean something together. An empty model list
 * reads as "nothing pulled yet" when the runner is up and as "nothing here is going to work"
 * when it is not, and the disk figures are the reason to remove a model at all. Showing any one
 * without the others would leave the operator to guess which situation they are in.
 *
 * Search is deliberately behind a button rather than run on mount. It is the only thing here
 * that leaves the machine, and opening a screen is not consent to reach a registry.
 */

const POSTURE =
  "The inference endpoint has no authentication by default. Anything that can reach the port can run inference, pull models and burn GPU — a model on this list is reachable by every process on the host, not only by you.";

/** Bytes as Docker Hub reports them for a search hit. The local list arrives pre-formatted. */
function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

function formatCount(count: number | undefined): string {
  if (!count || count <= 0) return "—";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return String(count);
}

function ModelRow({
  model,
  busy,
  onRemove,
  onUnload,
}: {
  model: DockerModel;
  busy: boolean;
  onRemove: () => void;
  onUnload: () => void;
}) {
  // Removing a model deletes gigabytes that have to be downloaded again, so the destructive
  // verb is behind a second press rather than a dialog: the row already names what goes.
  const [confirming, setConfirming] = useState(false);

  return (
    <article
      className="model-row"
      data-testid={`model-row-${model.reference}`}
      data-busy={busy ? "true" : undefined}
    >
      <div className="model-row__identity">
        <h3>{model.reference}</h3>
        <dl className="model-row__facts">
          {model.parameters && (
            <div>
              <dt>Parameters</dt>
              <dd>{model.parameters}</dd>
            </div>
          )}
          {model.quantization && (
            <div>
              <dt>Quantization</dt>
              <dd>{model.quantization}</dd>
            </div>
          )}
          {model.architecture && (
            <div>
              <dt>Architecture</dt>
              <dd>{model.architecture}</dd>
            </div>
          )}
          {model.format && (
            <div>
              <dt>Format</dt>
              <dd>{model.format}</dd>
            </div>
          )}
          {model.contextSize !== undefined && (
            <div>
              <dt>Context</dt>
              <dd>{model.contextSize.toLocaleString("en-GB")} tokens</dd>
            </div>
          )}
        </dl>
        {/*
          A model with several tags is one model, not several. Listing the extra tags rather
          than repeating the row stops the disk figures reading as though the weights were
          stored once per tag.
        */}
        {model.tags.length > 1 && (
          <p className="model-row__tags" data-testid="model-extra-tags">
            Also tagged {model.tags.slice(1).join(", ")}
          </p>
        )}
      </div>

      <div className="model-row__size">{model.size ?? "—"}</div>

      <div className="model-row__actions">
        <button
          type="button"
          className="ghost-button"
          onClick={onUnload}
          disabled={busy}
        >
          Unload
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              className="ghost-button ghost-button--danger"
              onClick={() => {
                setConfirming(false);
                onRemove();
              }}
              disabled={busy}
            >
              Delete weights
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="ghost-button ghost-button--danger"
            onClick={() => setConfirming(true)}
            disabled={busy}
          >
            Remove
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * How far a download has actually got.
 *
 * Measured, not animated. `docker model pull` writes "Downloaded 223.94MB of 270.60MB" and
 * nothing else machine-readable, and that line is exact — see store/transferProgress.ts. Where
 * it has not written one yet this renders nothing, rather than a bar at zero or a spinner that
 * implies knowledge it does not have: an indeterminate bar and a stalled download look identical,
 * which is the failure mode worth avoiding on a two-gigabyte file.
 */
function ModelPullProgress({ transfer }: { transfer: TransferSession }) {
  const progress = parseTransferProgress(transfer.output);
  if (!progress || transfer.status === "error") return null;
  const percent = Math.round(progress.fraction * 100);
  return (
    <div className="model-progress" data-testid={`model-progress-${transfer.reference}`}>
      <div
        className="model-progress__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={`${transfer.reference} download`}
      >
        <span className="model-progress__fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="model-progress__figure resource-mono">
        {formatBytes(progress.doneBytes)} / {formatBytes(progress.totalBytes)} · {percent}%
      </span>
    </div>
  );
}

/**
 * The one fact worth pulling out of a failed pull.
 *
 * `docker model pull` starts Model Runner before it downloads anything, and when that container
 * cannot start the reason arrives as five nested causes at the bottom of a wall of registry
 * output. It is all true and none of it is legible — see store/modelPullDiagnosis.ts, and the
 * driver upgrade that produced it here, where the symptom was simply "models are broken".
 *
 * Above Docker's text rather than instead of it. Anchorage does not get to decide the operator
 * has read enough.
 */
function ModelPullFailure({ transfer }: { transfer: TransferSession }) {
  const diagnosis = diagnoseModelPull(transfer.output);
  if (!diagnosis) return null;
  return (
    <div
      className="model-pull-failure"
      role="alert"
      data-testid={`model-pull-failure-${transfer.reference}`}
    >
      <p className="model-pull-failure__summary">{diagnosis.summary}</p>
      {diagnosis.missingPath && (
        <p className="model-pull-failure__path resource-mono">{diagnosis.missingPath}</p>
      )}
      {diagnosis.hint && <p className="model-pull-failure__hint">{diagnosis.hint}</p>}
    </div>
  );
}

function SearchHit({
  hit,
  busy,
  onPull,
}: {
  hit: ModelSearchResult;
  busy: boolean;
  onPull: () => void;
}) {
  return (
    <article className="model-hit" data-testid={`model-hit-${hit.name}`}>
      <div>
        <h4>
          {hit.name}
          {hit.official && (
            <span className="model-hit__official" title="Published by Docker">
              official
            </span>
          )}
        </h4>
        {hit.description && <p>{hit.description}</p>}
        <p className="model-hit__meta">
          {formatBytes(hit.sizeBytes)} · {formatCount(hit.downloads)} pulls
          {hit.backend ? ` · ${hit.backend}` : ""}
          {hit.source ? ` · ${hit.source}` : ""}
        </p>
      </div>
      <button
        type="button"
        className="primary-button"
        onClick={onPull}
        disabled={busy}
      >
        {busy ? "Pulling…" : "Pull"}
      </button>
    </article>
  );
}

export function ModelsScreen({ store }: { store: AnchorageStore }) {
  const capability = capabilityForView("models");
  if (!capability) {
    throw new Error("models is missing from the capability catalogue");
  }

  const {
    isHost,
    modelTransfers,
    models,
    modelRunner,
    modelDisk,
    modelsStatus,
    modelsError,
    modelsBusy,
    modelSearchResults,
    modelSearchStatus,
    modelSearchError,
    refreshModels,
    searchModels,
    clearModelSearch,
    modelAction,
  } = store;

  const [term, setTerm] = useState("");

  useEffect(() => {
    if (isHost) void refreshModels();
  }, [isHost, refreshModels]);

  if (!isHost) {
    return (
      <UnsupportedSurface
        testId="models-screen"
        title="Models"
        description="Model Runner reads from a live engine. The browser preview uses deterministic fixtures and never connects to one."
        posture={POSTURE}
        commandQuery="model"
        onOpenCommand={store.openCommandCenter}
      />
    );
  }

  // The plugin is missing, so the screen is about getting it. This is the same setup surface
  // the destination had before it had anything else, and it is still the right answer here:
  // there is nothing to list until `docker model` exists.
  if (modelsStatus === "unavailable") {
    return (
      <CapabilitySetup
        store={store}
        capability={capability}
        testId="models-screen"
        posture={POSTURE}
      />
    );
  }

  // Past the two early returns, so the store is the real one. This was a useMemo above them,
  // which meant it ran before the host check and read a field the browser-preview path never
  // supplies — memoising a find over two entries bought nothing and cost a crash.
  /*
   * Which references are downloading right now, rather than whether anything is.
   *
   * This was a single boolean, and every Pull button on the screen read it — so starting one
   * download greyed out all the others. Reported as "when we download a model we should be able
   * to download others too". Nothing in the engine required that; it came from the store
   * tracking one transfer at a time, which it no longer does.
   */
  const active = new Map(
    modelTransfers
      .filter((entry) => entry.status === "starting" || entry.status === "running")
      .map((entry) => [entry.reference, entry]),
  );

  const totalDisk = modelDisk.find((entry) =>
    /model/iu.test(entry.label),
  )?.size;

  return (
    <section className="models-screen screen" data-testid="models-screen">
      <header className="models-header">
        <div>
          <h1>Models</h1>
          <p>
            Local inference through Docker Model Runner. Models are OCI artifacts
            pulled from a registry and served by the runner on this engine.
          </p>
        </div>
        <button
          type="button"
          className="ghost-button"
          onClick={() => void refreshModels()}
          disabled={modelsStatus === "loading"}
        >
          {modelsStatus === "loading" ? "Reading…" : "Re-check"}
        </button>
      </header>

      <p className="models-posture" data-testid="models-screen-posture">
        {POSTURE}
      </p>

      {/*
        The runner's own verdict, taken from its sentence rather than inferred from a backend
        row. A backend reporting "Running" while the runner itself is down would otherwise put
        a healthy strip above a list of models that cannot serve a single request.
      */}
      <section className="model-runner" data-testid="model-runner">
        <div className="model-runner__state">
          <span
            className={`model-runner__dot model-runner__dot--${
              modelRunner.running ? "running" : "stopped"
            }`}
            aria-hidden="true"
          />
          <strong>
            {modelRunner.reported ??
              (modelRunner.running
                ? "Runner is running"
                : "Runner state not reported")}
          </strong>
          {totalDisk && (
            <span className="model-runner__disk">{totalDisk} on disk</span>
          )}
        </div>
        {modelRunner.backends.length > 0 && (
          <ul className="model-backends">
            {modelRunner.backends.map((backend) => (
              <li key={backend.name} data-testid={`model-backend-${backend.name}`}>
                <span className="model-backends__name">{backend.name}</span>
                <span className="model-backends__status">{backend.status}</span>
                {backend.detail && (
                  <span className="model-backends__detail">{backend.detail}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {modelsError && (
        <div className="compose-notice" role="alert" data-testid="models-error">
          {modelsError}
        </div>
      )}

      {/*
        One panel per download, because there can now be several. The first keeps the original
        test id: it is what the screen's own tests and the design captures name, and a stable
        handle for "the pull that is happening" is worth more than symmetry.
      */}
      {modelTransfers.map((transfer, index) => (
        <SessionActivityPanel
          key={transfer.reference}
          session={transfer}
          testId={index === 0 ? "model-pull-output" : `model-pull-output-${transfer.reference}`}
          runningMessage="Pulling — waiting for the registry."
          idleMessage="Waiting for Docker…"
        >
          <ModelPullProgress transfer={transfer} />
          <ModelPullFailure transfer={transfer} />
        </SessionActivityPanel>
      ))}

      <section className="models-local">
        <h2>On this machine</h2>
        {models.length === 0 ? (
          <p className="models-empty" data-testid="models-empty">
            No models pulled yet. Search below to find one — everything runs
            locally once it is here.
          </p>
        ) : (
          <div className="models-list">
            {models.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                busy={modelsBusy === model.reference}
                onRemove={() =>
                  void modelAction({
                    action: "remove",
                    reference: model.reference,
                  })
                }
                onUnload={() =>
                  void modelAction({
                    action: "unload",
                    reference: model.reference,
                  })
                }
              />
            ))}
          </div>
        )}
      </section>

      <section className="models-search">
        <h2>Find a model</h2>
        <form
          className="models-search__form"
          onSubmit={(event) => {
            event.preventDefault();
            void searchModels(term);
          }}
        >
          <label className="sr-only" htmlFor="model-search-term">
            Search Docker Hub for a model
          </label>
          <input
            id="model-search-term"
            type="search"
            placeholder="Search Docker Hub — leave empty to browse"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
          />
          <button
            type="submit"
            className="primary-button"
            disabled={modelSearchStatus === "loading"}
          >
            {modelSearchStatus === "loading" ? "Searching…" : "Search"}
          </button>
          {modelSearchResults && (
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setTerm("");
                clearModelSearch();
              }}
            >
              Clear
            </button>
          )}
        </form>
        <p className="models-search__note">
          Reaches Docker Hub. Nothing else on this screen leaves the machine.
        </p>

        {modelSearchError && (
          <div
            className="compose-notice"
            role="alert"
            data-testid="model-search-error"
          >
            {modelSearchError}
          </div>
        )}

        {modelSearchResults && modelSearchResults.length === 0 && (
          <p className="models-empty" data-testid="model-search-empty">
            Nothing matched that term on Docker Hub.
          </p>
        )}

        {modelSearchResults && modelSearchResults.length > 0 && (
          <div className="models-hits" data-testid="model-search-results">
            {modelSearchResults.map((hit) => (
              <SearchHit
                key={hit.name}
                hit={hit}
                busy={active.has(hit.reference) || modelsBusy === hit.reference}
                onPull={() =>
                  // `hit.reference`, never `hit.name`. They differ for every Hugging Face
                  // result, and sending the name pulls from Docker Hub, where it is not.
                  void modelAction({ action: "pull", reference: hit.reference })
                }
              />
            ))}
          </div>
        )}
      </section>

      {modelDisk.length > 0 && (
        <section className="models-disk" data-testid="models-disk">
          <h2>Disk</h2>
          <dl>
            {modelDisk.map((entry) => (
              <div key={entry.label}>
                <dt>{entry.label}</dt>
                <dd>{entry.size}</dd>
              </div>
            ))}
          </dl>
          <p className="models-disk__note">
            Reported by <code>docker model df</code>, shown exactly as it prints
            them.
          </p>
        </section>
      )}
    </section>
  );
}
