import type { CSSProperties, KeyboardEvent } from "react";
import { DAEMON_JSON_FIXTURE } from "../data/fixtures";
import type { AnchorageStore } from "../store/useAnchorageStore";
import {
  COLOR_MODE_OPTIONS,
  THEME_OPTIONS,
  isCaptureAppearanceRequest,
  type ThemeFamily,
} from "../theme/appearance";
import type {
  EngineResources,
  FeatureFlags,
  SettingsTab,
} from "../types";

const settingsNavigation: Array<{ id: SettingsTab; label: string }> = [
  { id: "appearance", label: "Appearance" },
  { id: "resources", label: "Resources" },
  { id: "engine", label: "Docker Engine" },
  { id: "kubernetes", label: "Kubernetes" },
  { id: "updates", label: "Software updates" },
  { id: "advanced", label: "Advanced" },
];

const themeSwatches: Record<ThemeFamily, readonly [string, string, string]> = {
  default: ["#16224a", "#1b2a57", "#8ba8f0"],
  docker: ["#00153c", "#d9e5fc", "#2560ff"],
  github: ["#0d1117", "#f6f8fa", "#2f81f7"],
};

const themeFamilies = THEME_OPTIONS.map((theme) => ({
  ...theme,
  swatches: themeSwatches[theme.id],
}));

const colorModes = COLOR_MODE_OPTIONS;

function handleRadioKeyDown<T extends string>(
  event: KeyboardEvent<HTMLButtonElement>,
  options: ReadonlyArray<{ id: T }>,
  currentIndex: number,
  select: (id: T) => void,
) {
  let nextIndex: number | null = null;
  switch (event.key) {
    case "ArrowRight":
    case "ArrowDown":
      nextIndex = (currentIndex + 1) % options.length;
      break;
    case "ArrowLeft":
    case "ArrowUp":
      nextIndex = (currentIndex - 1 + options.length) % options.length;
      break;
    case "Home":
      nextIndex = 0;
      break;
    case "End":
      nextIndex = options.length - 1;
      break;
    default:
      return;
  }

  event.preventDefault();
  const nextOption = options[nextIndex];
  if (!nextOption) return;
  select(nextOption.id);
  const group = event.currentTarget.closest('[role="radiogroup"]');
  group
    ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    [nextIndex]?.focus();
}

const resourceDefinitions: Array<{
  key: keyof EngineResources;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  minLabel: string;
  maxLabel: string;
}> = [
  {
    key: "cpus",
    label: "CPU limit",
    min: 1,
    max: 16,
    step: 1,
    unit: " cores",
    minLabel: "1 core",
    maxLabel: "16 cores",
  },
  {
    key: "memoryGb",
    label: "Memory limit",
    min: 2,
    max: 32,
    step: 1,
    unit: " GB",
    minLabel: "2 GB",
    maxLabel: "32 GB",
  },
  {
    key: "swapGb",
    label: "Swap",
    min: 0,
    max: 8,
    step: 1,
    unit: " GB",
    minLabel: "0 GB",
    maxLabel: "8 GB",
  },
  {
    key: "diskGb",
    label: "Virtual disk limit",
    min: 16,
    max: 512,
    step: 8,
    unit: " GB",
    minLabel: "16 GB",
    maxLabel: "512 GB",
  },
];

interface ToggleDefinition {
  key: keyof FeatureFlags;
  label: string;
  description: string;
}

const toggleDefinitions: Record<
  Exclude<SettingsTab, "appearance" | "resources" | "engine">,
  {
    title: string;
    subtitle: string;
    rows: ToggleDefinition[];
  }
> = {
  kubernetes: {
    title: "Kubernetes",
    subtitle: "A local cluster that shares the engine image store.",
    rows: [
      {
        key: "kubernetes",
        label: "Enable Kubernetes",
        description: "Run a single-node k3s cluster alongside the engine.",
      },
    ],
  },
  updates: {
    title: "Software updates",
    subtitle: "Control how Anchorage keeps itself current.",
    rows: [
      {
        key: "automaticUpdates",
        label: "Automatic updates",
        description: "Download and install new releases in the background.",
      },
      {
        key: "betaChannel",
        label: "Beta channel",
        description:
          "Receive pre-release builds before general availability.",
      },
    ],
  },
  advanced: {
    title: "Advanced",
    subtitle: "Low-level behaviour for the builder and runtime.",
    rows: [
      {
        key: "buildkit",
        label: "Use BuildKit",
        description:
          "Parallel build graph, better caching, and build secrets.",
      },
      {
        key: "binaryEmulation",
        label: "Binary emulation",
        description: "Run amd64 images on arm64 hosts transparently.",
      },
      {
        key: "telemetry",
        label: "Send usage statistics",
        description: "Anonymous feature and crash telemetry.",
      },
    ],
  },
};

function AppearanceSettings({ store }: { store: AnchorageStore }) {
  const selectedTheme =
    themeFamilies.find((theme) => theme.id === store.themeFamily) ??
    themeFamilies[0];
  const selectedMode =
    colorModes.find((mode) => mode.id === store.colorMode) ?? colorModes[1];
  const persistenceDescription =
    store.appearancePersistenceSucceeded === true
      ? "Changes are saved on this device."
      : store.appearancePersistenceSucceeded === false
        ? "Changes apply for this session only because this device cannot save them."
        : "Changes apply immediately while save availability is checked.";
  const persistenceStatus =
    store.appearancePersistenceSucceeded === true
      ? "Saved on this device"
      : store.appearancePersistenceSucceeded === false
        ? "Session only"
        : "Checking save availability";

  return (
    <div className="settings-pane settings-pane--appearance">
      <h2>Appearance</h2>
      <p>
        Choose a visual family and brightness mode. {persistenceDescription}
      </p>

      <fieldset className="appearance-fieldset">
        <legend>Theme</legend>
        <div
          className="appearance-theme-grid"
          role="radiogroup"
          aria-label="Theme"
        >
          {themeFamilies.map((theme, index) => (
            <button
              className={`appearance-theme-card${
                store.themeFamily === theme.id
                  ? " appearance-theme-card--selected"
                  : ""
              }`}
              type="button"
              role="radio"
              aria-checked={store.themeFamily === theme.id}
              tabIndex={store.themeFamily === theme.id ? 0 : -1}
              data-testid={`theme-family-${theme.id}`}
              key={theme.id}
              onClick={() => store.setThemeFamily(theme.id)}
              onKeyDown={(event) =>
                handleRadioKeyDown(
                  event,
                  themeFamilies,
                  index,
                  store.setThemeFamily,
                )
              }
            >
              <span
                className="appearance-theme-card__swatches"
                aria-hidden="true"
              >
                {theme.swatches.map((swatch) => (
                  <span style={{ backgroundColor: swatch }} key={swatch} />
                ))}
              </span>
              <span className="appearance-theme-card__copy">
                <strong>{theme.label}</strong>
                <span>{theme.description}</span>
              </span>
              <span
                className="appearance-theme-card__check"
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="appearance-fieldset appearance-fieldset--mode">
        <legend>Mode</legend>
        <div
          className="appearance-mode-control"
          role="radiogroup"
          aria-label="Color mode"
        >
          {colorModes.map((mode, index) => (
            <button
              className={
                store.colorMode === mode.id
                  ? "appearance-mode-control__selected"
                  : ""
              }
              type="button"
              role="radio"
              aria-checked={store.colorMode === mode.id}
              tabIndex={store.colorMode === mode.id ? 0 : -1}
              data-testid={`color-mode-${mode.id}`}
              key={mode.id}
              onClick={() => store.setColorMode(mode.id)}
              onKeyDown={(event) =>
                handleRadioKeyDown(
                  event,
                  colorModes,
                  index,
                  store.setColorMode,
                )
              }
            >
              <strong>{mode.label}</strong>
              <span>{mode.description}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <p className="appearance-current" role="status" aria-live="polite">
        Using {selectedTheme.label} · {selectedMode.label} ·{" "}
        {persistenceStatus}
      </p>
    </div>
  );
}

function ResourcesSettings({ store }: { store: AnchorageStore }) {
  return (
    <div className="settings-pane settings-pane--resources">
      <h2>Resources</h2>
      <p>
        Limits applied to the Linux VM backing the engine. Changes require a
        restart.
      </p>
      {resourceDefinitions.map((definition) => {
        const value = store.resources[definition.key];
        const percent =
          ((value - definition.min) / (definition.max - definition.min)) *
          100;
        return (
          <label className="resource-slider" key={definition.key}>
            <span className="resource-slider__heading">
              <strong>{definition.label}</strong>
              <output>{value + definition.unit}</output>
            </span>
            <input
              type="range"
              aria-label={definition.label}
              min={definition.min}
              max={definition.max}
              step={definition.step}
              value={value}
              style={
                { "--resource-progress": `${percent}%` } as CSSProperties
              }
              onChange={(event) =>
                store.updateResource(
                  definition.key,
                  Number(event.currentTarget.value),
                )
              }
            />
            <span className="resource-slider__limits">
              <span>{definition.minLabel}</span>
              <span>{definition.maxLabel}</span>
            </span>
          </label>
        );
      })}
      <div className="settings-resource-actions">
        <button
          className="primary-button"
          type="button"
          onClick={store.applyResources}
        >
          Apply &amp; restart
        </button>
        <button
          className="ghost-button"
          type="button"
          onClick={store.resetResources}
        >
          Reset to defaults
        </button>
      </div>
      {store.resourceNotice && (
        <div className="settings-resource-notice" role="status">
          {store.resourceNotice}
        </div>
      )}
    </div>
  );
}

function EngineSettings() {
  return (
    <div className="settings-pane settings-pane--engine">
      <h2>Engine</h2>
      <p>Raw daemon configuration (daemon.json).</p>
      <pre data-testid="daemon-json">{DAEMON_JSON_FIXTURE}</pre>
    </div>
  );
}

function ToggleSettings({
  store,
  tab,
}: {
  store: AnchorageStore;
  tab: Exclude<SettingsTab, "appearance" | "resources" | "engine">;
}) {
  const definition = toggleDefinitions[tab];
  return (
    <div className="settings-pane settings-pane--toggles">
      <h2>{definition.title}</h2>
      <p>{definition.subtitle}</p>
      <div className="settings-toggle-list">
        {definition.rows.map((row) => {
          const checked = store.featureFlags[row.key];
          return (
            <div className="settings-toggle-row" key={row.key}>
              <div>
                <h3>{row.label}</h3>
                <p>{row.description}</p>
              </div>
              <button
                className={`settings-switch${
                  checked ? " settings-switch--checked" : ""
                }`}
                type="button"
                role="switch"
                aria-label={row.label}
                aria-checked={checked}
                onClick={() => store.toggleFeatureFlag(row.key)}
              >
                <span />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HostSettingsUnavailable({
  store,
  tab,
}: {
  store: AnchorageStore;
  tab: Exclude<SettingsTab, "appearance">;
}) {
  const label =
    settingsNavigation.find((item) => item.id === tab)?.label ?? "Settings";
  return (
    <div className="settings-pane settings-pane--unavailable" role="status">
      <h2>{label} is unavailable in this build</h2>
      <p>
        Engine settings are read-only through the current host protocol.
        Appearance remains available because it is stored locally by Anchorage.
      </p>
      <button
        className="primary-button"
        type="button"
        onClick={() => store.openCommandCenter("system")}
      >
        Open Command Center
      </button>
    </div>
  );
}

export function SettingsScreen({ store }: { store: AnchorageStore }) {
  const navigationItems = isCaptureAppearanceRequest(
    typeof window === "undefined" ? "" : window.location.search,
  )
    ? settingsNavigation.filter((item) => item.id !== "appearance")
    : settingsNavigation;
  let content;
  if (store.settingsTab === "appearance") {
    content = <AppearanceSettings store={store} />;
  } else if (store.isHost) {
    content = (
      <HostSettingsUnavailable store={store} tab={store.settingsTab} />
    );
  } else if (store.settingsTab === "resources") {
    content = <ResourcesSettings store={store} />;
  } else if (store.settingsTab === "engine") {
    content = <EngineSettings />;
  } else {
    content = <ToggleSettings store={store} tab={store.settingsTab} />;
  }

  return (
    <section className="settings-screen screen" data-testid="settings-screen">
      <aside className="settings-navigation">
        <h1>Settings</h1>
        <nav aria-label="Settings sections">
          {navigationItems.map((item) => (
            <button
              className={
                store.settingsTab === item.id
                  ? "settings-navigation__active"
                  : ""
              }
              type="button"
              aria-current={
                store.settingsTab === item.id ? "page" : undefined
              }
              key={item.id}
              onClick={() => store.setSettingsTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <div className="settings-content">{content}</div>
    </section>
  );
}
