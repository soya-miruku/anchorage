import { useEffect, useMemo, useState } from "react";

import type { AnchorageStore } from "../store/useAnchorageStore";
import type { AnchorageImage, ImagesScoutResult } from "../types";

/**
 * Scout's own display order, worst first (core/internal/core/scout.go:44).
 *
 * UNSPECIFIED is last because it is unranked, not because it is mild: Scout emits it when the
 * advisory carries no CVSS v3 vector, which says nothing about whether the CVE matters here.
 */
const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNSPECIFIED"] as const;

type Severity = (typeof SEVERITIES)[number];

/** Abbreviated for the rail, where all five chips have to sit on one or two lines at 320px. */
const CHIP_LABEL: Record<Severity, string> = {
  CRITICAL: "crit",
  HIGH: "high",
  MEDIUM: "med",
  LOW: "low",
  UNSPECIFIED: "unspec",
};

/**
 * The CVSS v3 bands Scout's `cvssV3_severity` reports, except the last one, which is the
 * absence of a band. Stating them is what keeps UNSPECIFIED from reading as a sixth, milder
 * step below LOW on a screen whose whole job is a severity ramp.
 */
const SEVERITY_BAND: Record<Severity, string> = {
  CRITICAL: "CVSS 9.0–10.0",
  HIGH: "CVSS 7.0–8.9",
  MEDIUM: "CVSS 4.0–6.9",
  LOW: "CVSS 0.1–3.9",
  UNSPECIFIED: "No CVSS vector — unranked, not harmless",
};

/**
 * Why there is no letter grade here, in the slot the handoff gives one.
 *
 * `docker scout policy` exists on this CLI and prints "(experimental)" beside itself; its own
 * help says the results come from the Scout platform, which needs organisation enrolment.
 * Anchorage has no evaluator, and a grade computed locally from a CVE count would look like
 * the platform's answer while being a different thing entirely.
 */
const GRADE_REASON =
  "Policy grades are evaluated against an organisation's policies on the Docker Scout platform. The local `docker scout policy` command is experimental and needs that enrolment, and this build has no evaluator of its own — so no grade is shown rather than one invented from the counts below.";

/**
 * How many unanalysed images the rail lists before it stops and states the remainder.
 *
 * This host has 1971 of them and none carries information beyond its own name, so a full
 * list would be a scroll surface nobody reads. The count above it is the honest part.
 */
const UNANALYSED_SAMPLE = 40;

/** Scout uses the literal string "not fixed" rather than omitting the field. Duplicated from
 *  ImageDetailPanel rather than shared, because that panel does not export it. */
const isFixable = (fixedVersion?: string) =>
  Boolean(fixedVersion) && fixedVersion !== "not fixed";

/** The key `analyzeImage` stores a result under: a reference when the image has one, and the
 *  immutable ID when it is dangling (ImagesScreen.tsx:665-673). */
const scoutKeyFor = (image: AnchorageImage) => image.reference ?? image.imageId;

const displayNameFor = (image: AnchorageImage) =>
  image.reference ?? image.imageId.slice(0, 19);

/** ISO minutes, not a locale string: this is a record of when a scan ran, and it has to read
 *  the same in a screenshot as it does in a test. */
const formatObserved = (observedAt: string) =>
  observedAt.slice(0, 16).replace("T", " ") + " UTC";

type ScanRow = {
  key: string;
  image: AnchorageImage;
  /** Null means nobody has analysed this image. It never means "nothing was found". */
  scout: ImagesScoutResult | null;
  /** Set when the result was produced under a different tag of the same image ID. */
  inheritedFrom: string | null;
};

type AnalysedRow = ScanRow & { scout: ImagesScoutResult };

const isAnalysed = (row: ScanRow): row is AnalysedRow => row.scout !== null;

const countOf = (scout: ImagesScoutResult, severity: Severity) =>
  scout.summary[severity] ?? 0;

/**
 * Worst first: the point of a cross-image view is which of the analysed images is in the
 * worst state, so the comparison walks the severity ladder before falling back to the name.
 */
const compareRows = (a: AnalysedRow, b: AnalysedRow) => {
  for (const severity of SEVERITIES) {
    const difference = countOf(b.scout, severity) - countOf(a.scout, severity);
    if (difference !== 0) return difference;
  }
  return displayNameFor(a.image).localeCompare(displayNameFor(b.image));
};

/**
 * What this capability does and does not tell you, stated on the screen rather than in a
 * tooltip. Rendered on every branch, including the one where no analysis is possible at all.
 */
function ScanPosture() {
  return (
    <p className="scan-posture" data-testid="scan-screen-posture">
      Scanning finds known vulnerabilities, not unknown ones. A clean report is a
      statement about the CVE database on the day it ran, not about the software
      — and a clean grade can also mean a VEX exception was filed, or that the
      finding sat in something the SBOM never captured.
    </p>
  );
}

function SeverityChips({ scout }: { scout: ImagesScoutResult }) {
  return (
    <span className="scan-chips">
      {SEVERITIES.map((severity) => {
        const count = countOf(scout, severity);
        return (
          <span
            key={severity}
            className={`scan-chip scan-chip--${severity.toLowerCase()}${
              count === 0 ? " scan-chip--empty" : ""
            }`}
            // The word rides with the number. Four themes ship here, one of them greyscale,
            // so a bare count in a coloured pill would say nothing at all in Monochrome —
            // and nothing to anyone reading by colour in the other three either.
            title={`${count} ${severity.toLowerCase()}`}
          >
            <b>{count}</b>
            {CHIP_LABEL[severity]}
          </span>
        );
      })}
    </span>
  );
}

type ScoutAvailability =
  | { state: "checking" }
  | { state: "installed"; version?: string }
  | { state: "missing" }
  | { state: "faulty"; note: string }
  /*
   * The probe finished without an answer.
   *
   * `checking` used to absorb both failures — a host with no plugin inventory capability
   * returned early and left it set, and a rejected probe set it back deliberately. Either way
   * the screen went on saying "Checking for the Docker Scout plugin…" for the rest of the
   * session, describing work that had already stopped. Not knowing is genuinely different from
   * knowing the plugin is absent, so it keeps its own state rather than collapsing into
   * `missing` — it just has to stop claiming to be in progress.
   */
  | { state: "unknown"; note: string };

/**
 * Whether `docker scout` is installed, asked before anything is analysed.
 *
 * Without this the screen cannot tell "nothing has been analysed yet" from "nothing here can
 * be analysed at all", and an operator reading an empty Scan screen would have to start an
 * eight-minute scan to find out which. Reading the plugin inventory is a directory walk, not
 * an analysis, so it costs nothing.
 */
function useScoutAvailability(store: AnchorageStore): ScoutAvailability {
  const [availability, setAvailability] = useState<ScoutAvailability>({
    state: "checking",
  });
  const bridge = store.bridge;
  const context = store.dockerContext;

  useEffect(() => {
    if (typeof bridge?.system?.plugins !== "function") {
      setAvailability({
        state: "unknown",
        note: "This host cannot report its Docker CLI plugins, so whether Scout is installed is unknown.",
      });
      return;
    }
    let active = true;
    void bridge.system
      .plugins(context)
      .then((report) => {
        if (!active) return;
        const plugin = report.plugins.find((entry) => entry.name === "scout");
        if (!plugin) {
          setAvailability({ state: "missing" });
        } else if (plugin.status === "available") {
          setAvailability({ state: "installed", version: plugin.version });
        } else {
          // A plugin that is present but not loaded is a broken installation, which is a
          // different problem from an absent one and gets its own words.
          setAvailability({
            state: "faulty",
            note:
              plugin.availabilityNote ??
              `The Docker CLI reports the Scout plugin as ${plugin.status}.`,
          });
        }
      })
      .catch((reason: unknown) => {
        if (!active) return;
        // Not knowing is not the same as it being missing, so the failure keeps its own state
        // rather than reading as an absent plugin — but the check has ended either way.
        setAvailability({
          state: "unknown",
          note: `Could not read the Docker CLI plugin inventory: ${
            reason instanceof Error ? reason.message : "the check failed"
          }`,
        });
      });
    return () => {
      active = false;
    };
  }, [bridge, context]);

  return availability;
}

function ScoutAvailabilityLine({
  availability,
}: {
  availability: ScoutAvailability;
}) {
  if (availability.state === "missing") {
    return (
      <p className="capability-error" data-testid="scan-scout-missing">
        The Docker Scout plugin is not installed for this Docker CLI, so no image
        here can be analysed.
      </p>
    );
  }
  if (availability.state === "faulty") {
    return (
      <p className="capability-error" data-testid="scan-scout-faulty">
        {availability.note}
      </p>
    );
  }
  if (availability.state === "unknown") {
    return (
      <p className="capability-error" data-testid="scan-scout-unknown">
        {availability.note}
      </p>
    );
  }
  return (
    <p className="scan-rail__plugin">
      {availability.state === "installed"
        ? `Docker Scout${
            availability.version ? ` ${availability.version}` : ""
          } runs the analysis, one image at a time.`
        : "Checking for the Docker Scout plugin…"}
    </p>
  );
}

/** The findings themselves, in the handoff's table minus its exception column. */
function FindingsTable({ scout }: { scout: ImagesScoutResult }) {
  return (
    <div className="scan-cves" data-testid="scan-findings">
      <div className="scan-cves__head">
        <span>CVE</span>
        <span>SEVERITY</span>
        <span>PACKAGE</span>
        <span>INSTALLED</span>
        <span>FIXED IN</span>
      </div>
      {scout.findings.map((finding) => (
        <div className="scan-cve" key={`${finding.id}-${finding.package ?? ""}`}>
          <span className="resource-mono scan-cve__id">{finding.id}</span>
          <span>
            <span
              className={`scan-chip scan-chip--${finding.severity.toLowerCase()}`}
            >
              {finding.severity.toLowerCase()}
            </span>
          </span>
          <span className="resource-mono scan-cve__package">
            {finding.package ?? "unknown package"}
          </span>
          <span className="resource-mono scan-cve__version">
            {finding.installedVersion || "—"}
          </span>
          {/* Scout reports the literal string "not fixed" when no upgrade resolves the CVE.
              An unfixable finding must not read as advice the operator failed to take. */}
          <span
            className={`resource-mono scan-cve__fix${
              isFixable(finding.fixedVersion) ? "" : " scan-cve__fix--none"
            }`}
          >
            {isFixable(finding.fixedVersion)
              ? finding.fixedVersion
              : "no fix available"}
          </span>
        </div>
      ))}
    </div>
  );
}

function AnalysedDetail({
  scout,
  inheritedFrom,
}: {
  scout: ImagesScoutResult;
  inheritedFrom: string | null;
}) {
  return (
    <>
      <p className="scan-detail__meta resource-mono">
        {scout.scanner ?? "Docker Scout"} · analysed {formatObserved(scout.observedAt)}{" "}
        · {scout.total} finding{scout.total === 1 ? "" : "s"}
      </p>

      {inheritedFrom && (
        // Two tags on one image ID are the same layers, so the result is the same result.
        // Saying which reference produced it keeps the row from claiming a scan it never had.
        <p className="scan-detail__inherited" data-testid="scan-inherited">
          Analysed as <code>{inheritedFrom}</code>, which is the same image ID.
        </p>
      )}

      <div className="scan-stats" data-testid="scan-severity-summary">
        {SEVERITIES.map((severity) => (
          <article
            key={severity}
            className={`scan-stat scan-stat--${severity.toLowerCase()}`}
            data-testid={`scan-stat-${severity.toLowerCase()}`}
          >
            <span>{severity.toLowerCase()}</span>
            <strong>{countOf(scout, severity)}</strong>
            <small>{SEVERITY_BAND[severity]}</small>
          </article>
        ))}
      </div>

      <section className="scan-policy" data-testid="scan-policy">
        <h3>Policy</h3>
        <p className="scan-policy__state">Grade unavailable</p>
        <p>{GRADE_REASON}</p>
      </section>

      {scout.total === 0 ? (
        <p className="scan-detail__clean" data-testid="scan-clean">
          No known vulnerabilities. {scout.scanner ?? "Scout"} found nothing
          against its current advisory data.
        </p>
      ) : (
        <>
          {scout.limitations.map((limitation) => (
            // The count in the summary above is never capped; the list below is. Losing the
            // tail of a long list is the price of a response the transport will carry.
            <p className="files-truncated" key={limitation}>
              {limitation}
            </p>
          ))}
          <FindingsTable scout={scout} />
          <p className="scan-detail__note">
            Anchorage files no VEX exceptions and suppresses nothing: this is
            what <code>docker scout cves</code> matched against its advisory data,
            in full.
          </p>
        </>
      )}
    </>
  );
}

function HostScan({ store }: { store: AnchorageStore }) {
  const availability = useScoutAvailability(store);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const images = store.images;
  const scoutByReference = store.scoutByReference;

  const { analysed, unanalysed } = useMemo(() => {
    // A result belongs to an image ID, not to a tag: analysing `app:v1` analysed the same
    // layers `app:latest` points at. Without this, the second tag would read "not analysed"
    // — which is at least the safe direction, but it is not the true one.
    const byImageId = new Map<string, ImagesScoutResult>();
    for (const image of images) {
      const direct = scoutByReference[scoutKeyFor(image)];
      if (direct && !byImageId.has(image.imageId)) {
        byImageId.set(image.imageId, direct);
      }
    }

    const rows: ScanRow[] = images.map((image) => {
      const key = scoutKeyFor(image);
      const direct = scoutByReference[key] ?? null;
      const sibling = direct ? null : byImageId.get(image.imageId) ?? null;
      return {
        key,
        image,
        scout: direct ?? sibling,
        inheritedFrom: sibling ? sibling.reference : null,
      };
    });

    return {
      analysed: rows.filter(isAnalysed).sort(compareRows),
      unanalysed: rows.filter((row) => !isAnalysed(row)),
    };
  }, [images, scoutByReference]);

  const selected =
    [...analysed, ...unanalysed].find((row) => row.key === selectedKey) ??
    analysed[0] ??
    unanalysed[0] ??
    null;

  const totals = SEVERITIES.map((severity) =>
    analysed.reduce((sum, row) => sum + countOf(row.scout, severity), 0),
  );
  const pending = selected ? store.scoutPending === selected.key : false;
  const busy = store.scoutPending !== null;
  const sample = unanalysed.slice(0, UNANALYSED_SAMPLE);

  return (
    <section className="scan-screen screen" data-testid="scan-screen">
      <div className="scan-body">
        <aside className="scan-rail">
          <div className="scan-rail__heading">
            <h1>Scan</h1>
            <p data-testid="scan-coverage">
              {analysed.length === 0
                ? `No image analysed yet · ${images.length} on this engine`
                : `${analysed.length} of ${images.length} analysed · ${totals[0]} critical, ${totals[1]} high across them`}
            </p>
            <ScoutAvailabilityLine availability={availability} />
          </div>

          <div className="scan-list" aria-label="Images by analysis state">
            {analysed.length > 0 && (
              <p className="scan-list__group">Analysed · {analysed.length}</p>
            )}
            {analysed.map((row) => (
              <button
                key={row.key}
                type="button"
                className={`scan-row${
                  selected?.key === row.key ? " scan-row--active" : ""
                }`}
                data-testid={`scan-row-${row.key}`}
                aria-pressed={selected?.key === row.key}
                onClick={() => setSelectedKey(row.key)}
              >
                <span className="scan-row__name resource-mono">
                  {displayNameFor(row.image)}
                </span>
                <SeverityChips scout={row.scout} />
                <span className="scan-row__meta">
                  {formatObserved(row.scout.observedAt)}
                  {row.inheritedFrom ? " · same image ID as an analysed tag" : ""}
                </span>
              </button>
            ))}

            {unanalysed.length > 0 && (
              <>
                <p className="scan-list__group">
                  Not analysed · {unanalysed.length}
                </p>
                {/*
                  The one sentence on this screen that must not be misread. Scout analysis is
                  opt-in per image and the first run on a large one takes minutes, so most of
                  an engine is always unanalysed — and an unanalysed image with no findings
                  listed looks exactly like a clean one unless the screen says otherwise.
                */}
                <p className="scan-list__note" data-testid="scan-unanalysed-note">
                  Not analysed is not clean. Nothing has looked at these, so
                  nothing is known about them. Analysis is opt-in per image, from
                  Images.
                </p>
                {sample.map((row) => (
                  <button
                    key={row.key}
                    type="button"
                    className={`scan-row scan-row--unanalysed${
                      selected?.key === row.key ? " scan-row--active" : ""
                    }`}
                    data-testid={`scan-row-${row.key}`}
                    aria-pressed={selected?.key === row.key}
                    onClick={() => setSelectedKey(row.key)}
                  >
                    <span className="scan-row__name resource-mono">
                      {displayNameFor(row.image)}
                    </span>
                    <span className="scan-row__unanalysed">Not analysed</span>
                  </button>
                ))}
                {unanalysed.length > sample.length && (
                  <p className="scan-list__note">
                    {unanalysed.length - sample.length} more have not been
                    analysed either.
                  </p>
                )}
              </>
            )}
          </div>
        </aside>

        <div className="scan-detail">
          {!selected ? (
            <div className="empty-state">
              <strong>No images on this engine</strong>
              <p>
                Pull or build an image, then analyse it. Scout matches the
                packages it finds against its advisory data; with no image there
                is nothing to match.
              </p>
            </div>
          ) : (
            <>
              <header className="scan-detail__header">
                <h2 className="resource-mono">{displayNameFor(selected.image)}</h2>
                {/* The handoff puts a policy grade here. Rendering the slot as explicitly
                    unavailable keeps the absence visible instead of quietly dropping it. */}
                <span className="scan-grade" title={GRADE_REASON}>
                  no policy grade
                </span>
                <button
                  type="button"
                  className="ghost-button scan-detail__analyze"
                  data-testid="scan-analyze"
                  // Scout indexes one image at a time (`scout_busy` in scout.go), so a second
                  // request while one is running would only be rejected by the core — and
                  // with no plugin installed the request has nothing to reach at all.
                  disabled={busy || availability.state === "missing"}
                  title={
                    availability.state === "missing"
                      ? "The Docker Scout plugin is not installed"
                      : busy
                        ? "Scout analyses one image at a time"
                        : "Runs docker scout cves against this image"
                  }
                  onClick={() => void store.analyzeImage(selected.key)}
                >
                  {selected.scout ? "Re-analyse" : "Analyse"}
                </button>
              </header>

              {store.scoutError && (
                <p className="capability-error" role="status">
                  {store.scoutError}
                </p>
              )}

              {pending ? (
                <p className="resource-dim" role="status" data-testid="scan-pending">
                  Analysing… the first analysis of an image indexes it, which can
                  take a few minutes for a large one. Later runs are cached.
                </p>
              ) : selected.scout ? (
                <AnalysedDetail
                  scout={selected.scout}
                  inheritedFrom={selected.inheritedFrom}
                />
              ) : (
                <div className="scan-unanalysed" data-testid="scan-unanalysed">
                  <strong>This image has not been analysed</strong>
                  <p>
                    There are no findings to show because nothing has looked for
                    any — not because none were found. Analysing indexes the image
                    the first time, which takes minutes for a large one and
                    seconds thereafter.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <ScanPosture />
    </section>
  );
}

/**
 * Off-host there is no engine and no Scout, and there is no fixture standing in for either.
 *
 * A simulated CVE list would be indistinguishable from a real one at a glance, and this is
 * the screen where that mistake costs the most, so the preview says what it cannot show.
 */
function PreviewScan({ store }: { store: AnchorageStore }) {
  return (
    <section className="scan-screen screen" data-testid="scan-screen">
      <header className="screen-header">
        <div>
          <h1>Scan</h1>
          <p>Docker Scout findings for the images on this engine.</p>
        </div>
      </header>
      <div className="empty-state">
        <strong>No engine to analyse</strong>
        <p>
          Scan projects the results of <code>docker scout cves</code>, which needs
          a live Docker engine and the Scout CLI plugin. Neither is reachable in
          browser preview.
        </p>
        <p>
          No fixture findings are shown here. A simulated CVE list reads exactly
          like a real one, and on this screen that is the most expensive possible
          mistake.
        </p>
        <button
          className="primary-button"
          type="button"
          onClick={() => store.openCommandCenter("scout")}
        >
          Open Command Center
        </button>
      </div>
      <ScanPosture />
    </section>
  );
}

export function ScanScreen({ store }: { store: AnchorageStore }) {
  return store.isHost ? <HostScan store={store} /> : <PreviewScan store={store} />;
}
