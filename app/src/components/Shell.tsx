import { ActivityInbox, ActivityToasts } from "./ActivityCentre";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { StatusClock } from "./StatusClock";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { AnchorageBridge, ViewId } from "../types";
import {
  AnchorageIcon,
  type AnchorageIconName,
} from "./AnchorageIcon";
import { MaturityChip, MaturityDrawer } from "./MaturityDrawer";
import { maturityFor } from "../data/maturity";
import { isViewVisible } from "../data/capabilities";

const CommandCenter = lazy(() =>
  import("./CommandCenter").then((module) => ({
    default: module.CommandCenter,
  })),
);

interface NavItem {
  id: ViewId;
  label: string;
  icon: AnchorageIconName;
}

// Group names and ordering follow the v2 handoff nav (Anchorage v2.dc.html:136-236), for the
// destinations that survived it. The handoff named twenty-two; eight of those could never be
// served against a standalone Linux Engine and are gone rather than explained — see the ViewId
// comment in types.ts, which records what each one needed and why it was unreachable.
//
// The three AI rows are gated on the plugin they are made of: with no such plugin installed, the
// row is left out — see data/capabilities.ts. Settings → Engine → Capabilities names every gated
// capability, installed or not, and is where a hidden row is turned back on.
//
// A *faulty* plugin keeps its row. Something was installed on this machine and went wrong, and
// that row is the way into the repair.
//
// Networks has no place in the handoff — it is kept because `docker network` is core
// Engine surface, and filed with the other resource views.
const workspaceNav: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "containers", label: "Containers", icon: "containers" },
  { id: "compose", label: "Compose", icon: "compose" },
  { id: "images", label: "Images", icon: "images" },
  { id: "volumes", label: "Volumes", icon: "volumes" },
  { id: "networks", label: "Networks", icon: "networks" },
  { id: "builds", label: "Builds", icon: "builds" },
  { id: "logs", label: "Logs", icon: "logs" },
];

const aiNav: NavItem[] = [
  { id: "models", label: "Models", icon: "models" },
  { id: "agents", label: "Agents", icon: "agents" },
  { id: "tools", label: "Tools", icon: "tools" },
];

const securityNav: NavItem[] = [
  { id: "scan", label: "Scan", icon: "scan" },
  { id: "secrets", label: "Secrets", icon: "secrets" },
];

const platformNav: NavItem[] = [
  { id: "settings", label: "Settings", icon: "settings" },
];

export function isCaptureSurface(search: string) {
  return new URLSearchParams(search).has("capture");
}

const OPAQUE_HEX_COLOR = /^#[0-9A-Fa-f]{6}$/u;

export function readAppliedWindowBackgroundColor(
  root: HTMLElement = document.documentElement,
): string | null {
  const color = window
    .getComputedStyle(root)
    .getPropertyValue("--anc-app")
    .trim();
  return OPAQUE_HEX_COLOR.test(color)
    ? color.toLocaleLowerCase("en-US")
    : null;
}

function NativeWindowBackgroundSync({
  bridge,
}: {
  bridge: AnchorageBridge;
}) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    let active = true;
    let lastColor: string | null = null;
    const synchronize = () => {
      const color = readAppliedWindowBackgroundColor(root);
      if (!color || color === lastColor) return;
      lastColor = color;
      void bridge.setWindowBackgroundColor(color).catch(() => {
        if (active && lastColor === color) {
          lastColor = null;
        }
      });
    };

    synchronize();
    const observer = new MutationObserver(synchronize);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "data-color-mode"],
    });
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [bridge]);

  return null;
}

/**
 * The Anchorage mark — `docs/design_handoff_anchorage/anchorage-mark.svg`, drawn from the
 * accent triad rather than fixed hex so it retints with the theme. A raster mark reads as
 * a foreign object the moment the surface behind it changes.
 */
function AnchorageMark() {
  return (
    <svg
      className="titlebar__logo"
      width="19"
      height="19"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path d="M16 3.2 26.6 9.1 16 15 5.4 9.1 16 3.2Z" fill="var(--anc-accent-hover)" />
      <path d="M5.4 9.1 16 15v13.8L5.4 22.9V9.1Z" fill="var(--anc-accent-deep)" />
      <path d="M26.6 9.1 16 15v13.8l10.6-5.9V9.1Z" fill="var(--anc-accent)" />
      <path
        d="M10.7 12.05v6.5"
        stroke="var(--anc-app)"
        strokeWidth="1.5"
        strokeOpacity="0.28"
      />
      <path
        d="M21.3 12.05v6.5"
        stroke="var(--anc-app)"
        strokeWidth="1.5"
        strokeOpacity="0.16"
      />
    </svg>
  );
}

function TitleBar({
  store,
  captureSurface,
  onOpenMaturity,
}: {
  store: AnchorageStore;
  /** Capture URLs force Default/Dark and must not offer a control that would break the canvas. */
  captureSurface: boolean;
  onOpenMaturity: () => void;
}) {
  const inSettings = store.view === "settings";
  const searchRef = useRef<HTMLInputElement>(null);
  const windowStateRevisionRef = useRef(0);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        store.openCommandCenter();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [store.openCommandCenter]);

  useEffect(() => {
    let active = true;
    let observedEvent = false;
    const unsubscribe = store.bridge.subscribeWindowMaximized((value) => {
      observedEvent = true;
      windowStateRevisionRef.current += 1;
      if (active) setMaximized(value);
    });
    void store.bridge
      .windowIsMaximized()
      .then((value) => {
        if (active && !observedEvent) setMaximized(value);
      })
      .catch(() => {
        // Browser fixtures and partially available hosts default to restored.
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [store.bridge]);

  const toggleMaximized = () => {
    const stateRevision = windowStateRevisionRef.current;
    void store.bridge
      .windowAction("maximize")
      .then((value) => {
        if (
          typeof value === "boolean" &&
          windowStateRevisionRef.current === stateRevision
        ) {
          setMaximized(value);
        }
      })
      .catch(() => {
        // Main-process events remain authoritative if the invocation races.
      });
  };

  return (
    <header className="titlebar" data-testid="titlebar">
      <div className="titlebar__brand">
        <AnchorageMark />
        <span className="titlebar__wordmark">Anchorage</span>
        <span className="titlebar__version">{__ANCHORAGE_VERSION__}</span>
      </div>

      <div className="titlebar__search-wrap">
        <label className="global-search titlebar__no-drag">
          <span className="sr-only">Search the current view</span>
          <AnchorageIcon name="search" size={13} />
          <input
            ref={searchRef}
            data-testid="global-search"
            value={store.search}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (next.startsWith(">")) {
                store.openCommandCenter(next.slice(1).trimStart());
                return;
              }
              store.setSearch(next);
            }}
            placeholder="Search containers, images, volumes…"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>⌘K</kbd>
        </label>
      </div>

      <div className="titlebar__actions titlebar__no-drag">
        {/* Suppressed in capture mode for the same reason as the maturity chip: the 24 canonical
            design states must stay comparable against the handoff, and an unread badge is live
            state that would differ between runs. */}
        {!captureSurface && (
          <ActivityInbox
            activities={store.activities ?? []}
            unreadCount={store.unreadActivityCount ?? 0}
            onMarkRead={store.markActivitiesRead ?? (() => undefined)}
            onOpen={store.openActivity}
          />
        )}
        {!captureSurface && (
          <MaturityChip
            entries={maturityFor(store.view)}
            onOpen={onOpenMaturity}
          />
        )}
        {!captureSurface && (
          <button
            className="titlebar__settings"
            type="button"
            data-testid="mode-toggle"
            aria-label={
              store.colorMode === "dark"
                ? "Switch to light mode"
                : "Switch to dark mode"
            }
            title={
              store.colorMode === "dark"
                ? "Switch to light mode"
                : "Switch to dark mode"
            }
            onClick={() =>
              store.setColorMode(store.colorMode === "dark" ? "light" : "dark")
            }
          >
            <AnchorageIcon
              name={store.colorMode === "dark" ? "mode-light" : "mode-dark"}
              size={14}
            />
          </button>
        )}
        {/* v2.5 makes this a toggle rather than a one-way door: in Settings it shows a close
            glyph and returns to whatever the operator was looking at. Without that, leaving
            Settings meant picking some other destination and losing your place. */}
        <button
          className="titlebar__settings"
          type="button"
          data-testid="settings-toggle"
          aria-label={inSettings ? "Close settings" : "Open settings"}
          title={inSettings ? "Close Settings" : "Settings"}
          aria-pressed={inSettings}
          onClick={() =>
            store.navigate(inSettings ? (store.settingsReturnView ?? "dashboard") : "settings")
          }
        >
          <AnchorageIcon name={inSettings ? "close" : "settings"} size={14} />
        </button>
        <div className="window-controls" aria-label="Window controls">
          <button
            className="window-control window-control--neutral"
            type="button"
            aria-label="Minimize window"
            onClick={() => void store.bridge.windowAction("minimize")}
          />
          <button
            className="window-control window-control--neutral"
            type="button"
            aria-label={maximized ? "Restore window" : "Maximize window"}
            title={maximized ? "Restore window" : "Maximize window"}
            data-window-state={maximized ? "maximized" : "restored"}
            onClick={toggleMaximized}
          />
          <button
            className="window-control window-control--close"
            type="button"
            aria-label="Close window"
            onClick={() => void store.bridge.windowAction("close")}
          />
        </div>
      </div>
    </header>
  );
}

/**
 * What the browser preview is.
 *
 * This slot shipped a fabricated update notice — "Anchorage 4.32.0 is available", beside an
 * "Update now" button with no handler — from a build whose version is 0.1.0 and which has no
 * update channel, no publish target and no released artifact to update to. It came from the
 * comp, where it is a mockup `<span>`; rendering it as a real `<button>` turned a placeholder
 * into a claim, and the claim was false in three ways at once.
 *
 * The slot now carries what the preview was actually missing. `docs/unimplemented.md` records
 * that the status bar and engine card "assert a connected engine with no preview indicator" —
 * this is that indicator, in the one place the comp already reserves for a banner. Everything
 * behind it is fixture data, which is the single most useful thing to say about this mode.
 *
 * Dismiss survives because a permanent bar is worse than an honest one, and because the design
 * captures include a dismissed state.
 */
function PreviewBanner({ store }: { store: AnchorageStore }) {
  if (store.isHost || !store.bannerVisible) return null;

  return (
    <section className="preview-banner" data-testid="preview-banner">
      <span className="preview-banner__dot" aria-hidden="true" />
      <span>
        Browser preview — no Docker engine is connected. Every container, image and
        measurement on screen is fixture data.
      </span>
      <div className="preview-banner__actions">
        <button type="button" onClick={() => store.setBannerVisible(false)}>
          Dismiss
        </button>
      </div>
    </section>
  );
}

function NavGroup({
  label,
  items,
  store,
}: {
  label: string;
  items: NavItem[];
  store: AnchorageStore;
}) {
  // While the engine is not ready App renders the workspace state screen instead of any
  // destination, so no row is the current page. The active tint stays — it still says
  // where the user will land — but announcing `page` would name a screen that is not
  // rendered.
  const routed = store.engineStatus === "ready";

  const visible = items.filter((item) =>
    isViewVisible(item.id, store.pluginReport, store.revealedCapabilities),
  );
  // A group whose every row is gated on a plugin nobody has installed would otherwise render as
  // a heading with nothing under it, which reads as a failure rather than as an absence.
  if (visible.length === 0) return null;

  return (
    <div className="sidebar__group">
      <div className="sidebar__section-label">{label}</div>
      <nav aria-label={`${label.toLocaleLowerCase()} navigation`}>
        {visible.map((item) => {
          const active = store.view === item.id;
          return (
            <button
              key={item.id}
              className={`nav-item${active ? " nav-item--active" : ""}`}
              data-testid={`nav-${item.id}`}
              type="button"
              aria-current={active && routed ? "page" : undefined}
              onClick={() => store.navigate(item.id)}
            >
              <AnchorageIcon name={item.icon} size={15} />
              <span>{item.label}</span>
              {item.id === "containers" && (
                <span className="nav-item__count">{store.runningCount}</span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function EngineCard({ store }: { store: AnchorageStore }) {
  const cpu = Math.round(store.engineCpu);
  const memory = store.engineMemory.toFixed(1);
  // Against the allocation the Resources settings actually hold, not a literal 16 GB.
  const memoryPercent = Math.max(
    2,
    Math.min(100, (store.engineMemory / store.resources.memoryGb) * 100),
  );
  const heading =
    store.engineStatus === "ready"
      ? "Engine running"
      : store.engineStatus === "loading"
        ? "Connecting to engine"
        : store.engineStatus === "permission"
          ? "Permission required"
          : "Engine unavailable";

  return (
    <section
      className={`engine-card engine-card--${store.engineStatus}`}
      aria-label="Engine status"
    >
      <div className="engine-card__heading">
        <span className="engine-card__pulse" aria-hidden="true" />
        <span>{heading}</span>
      </div>
      <div className="engine-card__metric">
        <span>CPU</span>
        <span>{store.isHost ? "Stats tab" : `${cpu}%`}</span>
      </div>
      <div className="engine-card__track">
        <span style={{ width: `${store.isHost ? 0 : cpu}%` }} />
      </div>
      <div className="engine-card__metric">
        <span>MEM</span>
        <span>{store.isHost ? "on demand" : `${memory} GB`}</span>
      </div>
      <div className="engine-card__track engine-card__track--memory">
        <span style={{ width: `${store.isHost ? 0 : memoryPercent}%` }} />
      </div>
    </section>
  );
}

/**
 * Flags whether the list continues past its own bottom edge.
 *
 * The cut lands on a row boundary, so a clipped list looks like a complete one — the only
 * affordance is a low-contrast scrollbar thumb, which two separate reviews of the design
 * captures failed to read as "there is more below". The flag drives a fade on that edge.
 */
function markOverflow(nav: HTMLElement) {
  const more = nav.scrollHeight - nav.scrollTop - nav.clientHeight > 1;
  nav.dataset.more = more ? "true" : "false";
}

function Sidebar({ store }: { store: AnchorageStore }) {
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // With 22 destinations the list is taller than the shortest supported window, so the
    // last group sits below the fold at rest. Without this, navigating to Settings — or
    // launching straight onto it — leaves the sidebar parked at the top showing no active
    // row at all, which reads as "nothing is selected" rather than "scroll down".
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>(".nav-item--active");
    if (!nav || !active) return;
    markOverflow(nav);
    const above = active.offsetTop < nav.scrollTop;
    const below =
      active.offsetTop + active.offsetHeight > nav.scrollTop + nav.clientHeight;
    if (above || below) {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [store.view]);

  return (
    <aside className="sidebar" data-testid="sidebar">
      {/* Twenty-two destinations in four groups do not fit the shortest supported window,
          so the list scrolls and the engine card stays pinned below it. Without this the
          last group is simply cut off: the window clips, and nothing indicates there is
          more. */}
      <div
        className="sidebar__nav"
        ref={navRef}
        onScroll={(event) => markOverflow(event.currentTarget)}
      >
        <NavGroup label="WORKSPACE" items={workspaceNav} store={store} />
        <NavGroup label="AI" items={aiNav} store={store} />
        <NavGroup label="SECURITY" items={securityNav} store={store} />
        <NavGroup label="PLATFORM" items={platformNav} store={store} />
      </div>
      <EngineCard store={store} />
    </aside>
  );
}

function StatusBar({ store }: { store: AnchorageStore }) {
  const engineLabel =
    store.engineStatus === "ready"
      ? store.isHost
        ? `engine ${store.systemSnapshot?.engine.serverVersion ?? "connected"}`
        : "engine v27.1.2"
      : store.engineStatus === "loading"
        ? "connecting to engine"
        : "engine unavailable";
  return (
    <footer className="statusbar">
      <span
        className={`statusbar__engine statusbar__engine--${store.engineStatus}`}
      >
        <span aria-hidden="true" />
        {engineLabel}
      </span>
      {store.isHost && store.availableContexts.length > 0 && (
        <label className="statusbar__context">
          <span className="sr-only">Docker context</span>
          <select
            data-testid="context-picker"
            value={store.dockerContext}
            onChange={(event) => store.selectDockerContext(event.currentTarget.value)}
          >
            {store.availableContexts.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name}
                {candidate.current ? " (current)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <span>
        {store.runningCount} running · {store.stoppedCount} stopped
      </span>
      <span>
        {store.isHost
          ? "live metrics on container Stats"
          : `${Math.round(store.engineCpu)}% CPU · ${store.engineMemory.toFixed(1)} GB MEM`}
      </span>
      <StatusClock />
    </footer>
  );
}

const VIEW_LABELS = new Map<ViewId, string>(
  [...workspaceNav, ...aiNav, ...securityNav, ...platformNav].map((item) => [
    item.id,
    item.label,
  ]),
);

export function Shell({
  store,
  children,
}: PropsWithChildren<{ store: AnchorageStore }>) {
  const inSettings = store.view === "settings";
  const captureSurface =
    typeof window !== "undefined" && isCaptureSurface(window.location.search);
  const [maturityOpen, setMaturityOpen] = useState(false);

  return (
    <div
      className={`anchorage-desk${
        captureSurface ? " anchorage-desk--capture" : ""
      }`}
      data-surface-mode={captureSurface ? "capture" : "viewport"}
    >
      <NativeWindowBackgroundSync bridge={store.bridge} />
      <div className="anchorage-window" data-testid="shell">
        <TitleBar
          store={store}
          captureSurface={captureSurface}
          onOpenMaturity={() => setMaturityOpen(true)}
        />
        <PreviewBanner store={store} />
        <div className="anchorage-body">
          {/* v2.5 gives Settings the sidebar slot: its own rail replaces the main nav rather
              than sitting beside it, so the screen is not two navigation columns wide. The
              titlebar control becomes a close button in that state, which is how you get back
              — see TitleBar. */}
          {store.view !== "settings" && <Sidebar store={store} />}
          <main className="anchorage-content" data-testid="screen">
            {children}
          </main>
        </div>
        <StatusBar store={store} />
        {maturityOpen && (
          <MaturityDrawer
            entries={maturityFor(store.view)}
            viewLabel={VIEW_LABELS.get(store.view) ?? store.view}
            onClose={() => setMaturityOpen(false)}
          />
        )}
        {store.commandCenterOpen && (
          <Suspense
            fallback={
              <div
                className="command-center-backdrop"
                data-testid="command-center-loading"
              >
                <div className="command-center-loading" role="status">
                  Discovering Docker Command Center…
                </div>
              </div>
            }
          >
            <CommandCenter store={store} />
          </Suspense>
        )}
      </div>
      {!captureSurface && (
        <ActivityToasts
          activities={store.activities ?? []}
          onDismiss={store.dismissActivity ?? (() => undefined)}
          onOpen={store.openActivity}
        />
      )}
    </div>
  );
}
