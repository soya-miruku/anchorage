import { XIcon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";

import type {
  AnchorageImage,
  ImagesInspectResult,
  ImagesScoutResult,
} from "../types";

const SCOUT_SEVERITIES = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNSPECIFIED",
] as const;

/** Scout uses the literal string "not fixed" rather than omitting the field. */
const isFixable = (fixedVersion?: string) =>
  Boolean(fixedVersion) && fixedVersion !== "not fixed";

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

/**
 * Image detail: configuration, layer history and size breakdown.
 *
 * The Images screen previously had no detail surface, so an image's layers, provenance and
 * where its size actually came from were only discoverable by leaving the application.
 */
export function ImageDetailPanel({
  image,
  detail,
  error,
  onClose,
  onSave,
  onTag,
  scout,
  scoutPending,
  scoutError,
  onAnalyze,
}: {
  image: AnchorageImage;
  detail: ImagesInspectResult | null;
  error: string | null;
  onClose: () => void;
  /** Omitted when the image cannot be saved — no reference, or a transfer is already running. */
  onSave?: () => void;
  /** Omitted off-host. Tagging works on any image, including a dangling one. */
  onTag?: () => void;
  scout?: ImagesScoutResult | null;
  scoutPending?: boolean;
  scoutError?: string | null;
  /** Omitted off-host. Never called automatically — the first analysis indexes the image. */
  onAnalyze?: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, []);

  // Largest layers first: the question this panel exists to answer is "what is taking up
  // the space", which layer order alone does not reveal.
  const layers = detail
    ? [...detail.history].sort((a, b) => b.sizeBytes - a.sizeBytes)
    : [];
  const largest = layers[0]?.sizeBytes ?? 0;

  return (
    <aside
      className="image-detail"
      role="dialog"
      aria-modal="false"
      aria-labelledby="image-detail-title"
      data-testid="image-detail-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="image-detail__header">
        <div>
          <h2 id="image-detail-title">
            {image.repository}
            <span className="resource-secondary">:{image.tag}</span>
          </h2>
          <p className="resource-mono resource-dim">{image.imageId.slice(0, 24)}</p>
        </div>
        <div className="image-detail__actions">
          {onTag && (
            <button
              type="button"
              className="ghost-button"
              data-testid="image-detail-tag"
              onClick={onTag}
            >
              Tag
            </button>
          )}
          {onSave && (
            <button
              type="button"
              className="ghost-button"
              data-testid="image-detail-save"
              onClick={onSave}
            >
              Save
            </button>
          )}
          <button
            type="button"
            ref={closeRef}
            aria-label="Close image detail"
            data-testid="image-detail-close"
            onClick={onClose}
          >
            <XIcon aria-hidden="true" size={15} />
          </button>
        </div>
      </header>

      {error && (
        <p className="capability-error" role="status">
          {error}
        </p>
      )}

      {!detail && !error && (
        <p className="resource-dim" role="status">
          Loading image detail…
        </p>
      )}

      {detail && (
        <>
          <dl className="image-detail__facts">
            <dt>Size</dt>
            <dd>{formatBytes(detail.image.sizeBytes)}</dd>
            <dt>Created</dt>
            <dd>{detail.image.created ?? "Unknown"}</dd>
            <dt>Platform</dt>
            <dd>
              {detail.image.os ?? "unknown"}/{detail.image.architecture ?? "unknown"}
            </dd>
            <dt>Layers</dt>
            <dd>{detail.image.rootFsLayers.length}</dd>
            {detail.image.workingDir && (
              <>
                <dt>Working dir</dt>
                <dd className="resource-mono">{detail.image.workingDir}</dd>
              </>
            )}
            {detail.image.exposedPorts.length > 0 && (
              <>
                <dt>Exposed</dt>
                <dd className="resource-mono">
                  {detail.image.exposedPorts.join(", ")}
                </dd>
              </>
            )}
          </dl>

          {detail.image.repoTags.length > 0 && (
            <section className="image-detail__section">
              <h3>Tags</h3>
              <ul className="image-detail__tags">
                {detail.image.repoTags.map((tag) => (
                  <li key={tag} className="resource-mono">
                    {tag}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="image-detail__section">
            <h3>Vulnerabilities</h3>
            {!onAnalyze ? (
              <p className="resource-dim">
                Analysis needs the Docker Scout plugin on a live engine.
              </p>
            ) : scoutPending ? (
              <p className="resource-dim" role="status">
                Analyzing… the first analysis of an image indexes it, which can
                take a few minutes for a large one. Later runs are cached.
              </p>
            ) : scout ? (
              <div data-testid="image-scout">
                <div className="scout-summary">
                  {SCOUT_SEVERITIES.map((severity) => (
                    <span
                      key={severity}
                      className={`scout-pill scout-pill--${severity.toLowerCase()}${
                        (scout.summary[severity] ?? 0) === 0
                          ? " scout-pill--empty"
                          : ""
                      }`}
                    >
                      <b>{scout.summary[severity] ?? 0}</b>
                      {severity.toLowerCase()}
                    </span>
                  ))}
                </div>
                {scout.total === 0 ? (
                  <p className="resource-dim">
                    No known vulnerabilities. {scout.scanner ?? "Scout"} found
                    nothing against its current advisory data.
                  </p>
                ) : (
                  <>
                    {scout.limitations.map((limitation) => (
                      <p className="files-truncated" key={limitation}>
                        {limitation}
                      </p>
                    ))}
                    <ol className="scout-findings" data-testid="scout-findings">
                      {scout.findings.map((finding) => (
                        <li key={`${finding.id}-${finding.package ?? ""}`}>
                          <div className="scout-finding__head">
                            <span
                              className={`scout-tag scout-tag--${finding.severity.toLowerCase()}`}
                            >
                              {finding.severity.toLowerCase()}
                            </span>
                            <strong className="resource-mono">{finding.id}</strong>
                            {finding.score ? <span>{finding.score}</span> : null}
                          </div>
                          <div className="scout-finding__body">
                            <span className="resource-mono">
                              {finding.package ?? "unknown package"}
                              {finding.installedVersion
                                ? ` ${finding.installedVersion}`
                                : ""}
                            </span>
                            {/* Scout reports the literal string "not fixed" when no
                                upgrade resolves the CVE; saying so is the useful part. */}
                            <span
                              className={
                                isFixable(finding.fixedVersion)
                                  ? "scout-fix"
                                  : "scout-fix scout-fix--none"
                              }
                            >
                              {isFixable(finding.fixedVersion)
                                ? `fixed in ${finding.fixedVersion}`
                                : "no fix available"}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </div>
            ) : (
              <div className="scout-invite">
                <p className="resource-dim">
                  {scoutError ??
                    "Scan this image against Docker Scout's advisory data."}
                </p>
                <button
                  type="button"
                  className="ghost-button"
                  data-testid="image-scout-run"
                  onClick={onAnalyze}
                >
                  Analyze
                </button>
              </div>
            )}
          </section>

          <section className="image-detail__section">
            <h3>Layers by size</h3>
            {layers.length === 0 ? (
              <p className="resource-dim">
                The daemon did not report layer history for this image.
              </p>
            ) : (
              <ol className="image-detail__layers" data-testid="image-detail-layers">
                {layers.map((layer, index) => (
                  <li key={`${layer.id ?? "layer"}-${index}`}>
                    <div className="image-detail__layer-head">
                      <span className="resource-mono">
                        {formatBytes(layer.sizeBytes)}
                      </span>
                      {layer.emptyLayer && (
                        <span className="usage-pill">metadata only</span>
                      )}
                    </div>
                    <div className="image-detail__layer-track" aria-hidden="true">
                      <span
                        style={{
                          width: `${largest > 0 ? (layer.sizeBytes / largest) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <code>{layer.createdBy || layer.comment || "—"}</code>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
