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

const workspaceNav: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "containers", label: "Containers", icon: "containers" },
  { id: "images", label: "Images", icon: "images" },
  { id: "volumes", label: "Volumes", icon: "volumes" },
  { id: "networks", label: "Networks", icon: "networks" },
  { id: "compose", label: "Compose", icon: "compose" },
  { id: "builds", label: "Builds", icon: "builds" },
];

const developNav: NavItem[] = [
  {
    id: "devenv",
    label: "Dev Environments",
    icon: "dev-environments",
  },
  { id: "extensions", label: "Extensions", icon: "extensions" },
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

function TitleBar({ store }: { store: AnchorageStore }) {
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
        <img
          className="titlebar__logo"
          src="./assets/anchorage-logo.png"
          alt=""
          width="19"
          height="19"
        />
        <span className="titlebar__wordmark">Anchorage</span>
        <span className="titlebar__version">4.31.2</span>
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
        <button
          className="titlebar__settings"
          type="button"
          aria-label="Open settings"
          onClick={() => store.navigate("settings")}
        >
          <AnchorageIcon name="settings" size={14} />
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

function UpdateBanner({ store }: { store: AnchorageStore }) {
  if (store.isHost || !store.bannerVisible) return null;

  return (
    <section className="update-banner" data-testid="update-banner">
      <span className="update-banner__dot" aria-hidden="true" />
      <span>
        Anchorage 4.32.0 is available — includes faster BuildKit cache and
        Compose watch improvements.
      </span>
      <div className="update-banner__actions">
        <button type="button">Update now</button>
        <button
          type="button"
          onClick={() => store.setBannerVisible(false)}
        >
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
  return (
    <div className="sidebar__group">
      <div className="sidebar__section-label">{label}</div>
      <nav aria-label={`${label.toLocaleLowerCase()} navigation`}>
        {items.map((item) => {
          const active = store.view === item.id;
          return (
            <button
              key={item.id}
              className={`nav-item${active ? " nav-item--active" : ""}`}
              data-testid={`nav-${item.id}`}
              type="button"
              aria-current={active ? "page" : undefined}
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
  const memoryPercent = Math.max(
    2,
    Math.min(100, (store.engineMemory / 16) * 100),
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

function Sidebar({ store }: { store: AnchorageStore }) {
  return (
    <aside className="sidebar" data-testid="sidebar">
      <NavGroup label="WORKSPACE" items={workspaceNav} store={store} />
      <NavGroup label="DEVELOP" items={developNav} store={store} />
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

export function Shell({
  store,
  children,
}: PropsWithChildren<{ store: AnchorageStore }>) {
  const captureSurface =
    typeof window !== "undefined" && isCaptureSurface(window.location.search);

  return (
    <div
      className={`anchorage-desk${
        captureSurface ? " anchorage-desk--capture" : ""
      }`}
      data-surface-mode={captureSurface ? "capture" : "viewport"}
    >
      <NativeWindowBackgroundSync bridge={store.bridge} />
      <div className="anchorage-window" data-testid="shell">
        <TitleBar store={store} />
        <UpdateBanner store={store} />
        <div className="anchorage-body">
          <Sidebar store={store} />
          <main className="anchorage-content" data-testid="screen">
            {children}
          </main>
        </div>
        <StatusBar store={store} />
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
    </div>
  );
}
