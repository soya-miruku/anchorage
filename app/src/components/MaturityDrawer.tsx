import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { LevelChip, MATURITY_LEVELS, maturityLabel } from "./LevelChip";
import { entitledCount, notGaCount, type MaturityEntry } from "../data/maturity";

/**
 * Feature maturity for the current view — the titlebar chip
 * (Anchorage v2.dc.html:100-102) and the drawer it opens (:2424-2463).
 *
 * This answers a different question from `UnsupportedSurface`. That one says whether
 * this build can do a thing at all; this one says how much you should depend on it when
 * it can. A capability can be present and still be Experimental.
 */

const LEGEND: Record<(typeof MATURITY_LEVELS)[number], string> = {
  ga: "Supported for everyday production use.",
  "early-access": "Supported, with documented limitations.",
  beta: "Fine to evaluate; don't depend on it.",
  experimental: "May change or vanish without notice.",
  deprecated: "Kept temporarily, scheduled for removal.",
};

export function MaturityChip({
  entries,
  onOpen,
}: {
  entries: MaturityEntry[];
  onOpen: () => void;
}) {
  if (entries.length === 0) return null;

  const notGa = notGaCount(entries);
  const gated = entitledCount(entries);

  // "all GA" is a strong claim. A view whose capabilities are all GA but all behind a
  // plan the user may not hold has not earned it, so the entitlement count takes over.
  //
  // The count is every level that is not GA, and Deprecated is one of them — a view like
  // Dev Environments holds nothing but a Deprecated entry, so "pre-GA" would say the
  // opposite of the truth about it.
  const label = notGa
    ? `${notGa} not GA`
    : gated
      ? `${gated} plan-gated`
      : "all GA";
  const tone = notGa ? "not-ga" : gated ? "gated" : "ga";

  return (
    <button
      type="button"
      className={`maturity-chip maturity-chip--${tone}`}
      data-testid="maturity-chip"
      title="Feature maturity in this view"
      onClick={onOpen}
    >
      <span className="maturity-chip__dot" aria-hidden="true" />
      {label}
    </button>
  );
}

export function MaturityDrawer({
  entries,
  viewLabel,
  onClose,
}: {
  entries: MaturityEntry[];
  viewLabel: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Hand focus back where it came from on close, or the user lands at the top of the
    // document having lost the titlebar chip they opened this from.
    const opener = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // aria-modal is a promise that Tab cannot leave, and the browser does not keep it for us.
  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="maturity-overlay">
      <div
        className="maturity-overlay__scrim"
        data-testid="maturity-scrim"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className="maturity-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Maturity · ${viewLabel}`}
        onKeyDown={trapFocus}
      >
        <header className="maturity-panel__header">
          <h2 className="maturity-panel__title">Maturity · {viewLabel}</h2>
          <button
            ref={closeRef}
            type="button"
            className="maturity-panel__close"
            onClick={onClose}
          >
            <span className="sr-only">Close maturity</span>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="maturity-panel__body">
          <p className="maturity-panel__lede">
            Not everything on this screen is production-ready. Anchorage labels
            each capability so you know what you can depend on.
          </p>

          {entries.length === 0 ? (
            <p className="maturity-panel__empty">
              Nothing tracked for this view yet.
            </p>
          ) : (
            <ul className="maturity-list">
              {entries.map((entry) => (
                <li key={entry.name} className="maturity-list__item">
                  <div className="maturity-list__head">
                    <span className="maturity-list__name">{entry.name}</span>
                    {entry.entitlement && (
                      <span className="maturity-list__entitlement">
                        {entry.entitlement}
                      </span>
                    )}
                    <LevelChip level={entry.level} describes={entry.name} />
                  </div>
                  <p className="maturity-list__description">
                    {entry.description}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <section className="maturity-legend">
            <h3 className="maturity-legend__title">WHAT THE LABELS MEAN</h3>
            <dl className="maturity-legend__list">
              {MATURITY_LEVELS.map((level) => (
                <div key={level} className="maturity-legend__row">
                  <dt className={`maturity-legend__term level-chip--${level}`}>
                    {maturityLabel(level)}
                  </dt>
                  <dd className="maturity-legend__definition">
                    {LEGEND[level]}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
