import { useEffect } from "react";
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

/**
 * The OCI architectures a host executes without a binfmt handler.
 *
 * `docker info` gives the kernel's name (`x86_64`), image and build platforms use the Go name
 * (`amd64`); the two never match on a string compare. The companion entries are the second
 * architecture a CPU runs directly: an x86-64 core executes 32-bit x86, and an AArch64 core
 * that implements AArch32 executes 32-bit ARM — buildx only lists the latter when the CPU
 * actually does, so trusting it here does not overstate the machine.
 */
const NATIVE_ARCHITECTURES: Record<string, string[]> = {
  x86_64: ["amd64", "386"],
  amd64: ["amd64", "386"],
  i686: ["386"],
  i386: ["386"],
  aarch64: ["arm64", "arm"],
  arm64: ["arm64", "arm"],
  armv7l: ["arm"],
  armv6l: ["arm"],
  ppc64le: ["ppc64le"],
  s390x: ["s390x"],
  riscv64: ["riscv64"],
};

function nativeArchitecturesFor(reported?: string): Set<string> {
  if (!reported) return new Set();
  return new Set(NATIVE_ARCHITECTURES[reported] ?? [reported]);
}

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

/**
 * Engine resource allocation.
 *
 * On a live Linux engine these sliders had no effect: "Apply & restart" set local state and
 * reported "engine restart queued" when nothing was queued and nothing reached Docker. A
 * control that reports success without acting is worse than an absent one, because the
 * operator believes the limit is in force.
 *
 * The sliders are not wired up instead of being removed-and-reimplemented, because there is
 * nothing to wire them to. CPU and memory allocation is a Docker Desktop concept: Desktop
 * runs the daemon inside a VM whose size it controls. A native Linux daemon runs on the host
 * directly and uses whatever the host has — there is no allocation to change, and per-container
 * limits belong on the container, which the Resources dialog in container detail already sets.
 */
function ResourcesSettings({ store }: { store: AnchorageStore }) {
  if (store.isHost) {
    const engine = store.systemSnapshot?.engine;
    return (
      <div className="settings-pane settings-pane--resources">
        <h2>Resources</h2>
        <p>
          This engine runs natively on the host, so it has no separate CPU or
          memory allocation to adjust — it uses what the host has.
        </p>
        <dl className="engine-facts" data-testid="resource-facts">
          <dt>Host CPUs</dt>
          <dd>{engine ? engine.cpus : "—"}</dd>
          <dt>Host memory</dt>
          <dd>
            {engine ? `${(engine.memoryBytes / 1024 ** 3).toFixed(1)} GB` : "—"}
          </dd>
          <dt>Docker root</dt>
          <dd className="resource-mono">{engine?.dockerRootDir ?? "—"}</dd>
        </dl>
        <p className="resource-dim" data-testid="resources-native-note">
          Allocation sliders exist in Docker Desktop because it sizes a virtual
          machine around the daemon. To bound a single workload here, set CPU and
          memory on the container itself — the Resources action in container
          detail does that, and Docker enforces it.
        </p>
      </div>
    );
  }
  return <FixtureResourcesSettings store={store} />;
}

function FixtureResourcesSettings({ store }: { store: AnchorageStore }) {
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

function EngineSettings({ store }: { store: AnchorageStore }) {
  // The fixture pane rendered a hardcoded daemon.json. Against a live engine that is
  // fabricated configuration presented as the operator's own — the same thing the host
  // candidate gate forbids for the file browser and build history. What the daemon actually
  // reports is available and authoritative, so that is shown instead.
  const snapshot = store.systemSnapshot;
  if (!store.isHost) {
    return (
      <div className="settings-pane settings-pane--engine">
        <h2>Engine</h2>
        <p>Raw daemon configuration (daemon.json).</p>
        <pre data-testid="daemon-json">{DAEMON_JSON_FIXTURE}</pre>
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div className="settings-pane settings-pane--engine">
        <h2>Engine</h2>
        <p className="resource-dim" role="status">
          Reading engine configuration…
        </p>
      </div>
    );
  }
  const engine = snapshot.engine;
  return (
    <div className="settings-pane settings-pane--engine">
      <h2>Engine</h2>
      <p>
        Reported by the daemon on <strong>{snapshot.context}</strong>. Anchorage
        does not edit <code>daemon.json</code>; changing these is a daemon
        configuration and restart, not an application setting.
      </p>
      <dl className="engine-facts" data-testid="engine-facts">
        <dt>Server version</dt>
        <dd>{engine.serverVersion ?? "Unknown"}</dd>
        <dt>API version</dt>
        <dd>{snapshot.apiVersion}</dd>
        <dt>Storage driver</dt>
        <dd>{engine.driver ?? "Unknown"}</dd>
        <dt>Docker root</dt>
        <dd className="resource-mono">{engine.dockerRootDir ?? "Unknown"}</dd>
        <dt>Platform</dt>
        <dd>
          {engine.operatingSystem ?? engine.osType ?? "Unknown"} ·{" "}
          {engine.architecture ?? "unknown"}
        </dd>
        <dt>Host resources</dt>
        <dd>
          {engine.cpus} CPUs ·{" "}
          {(engine.memoryBytes / 1024 ** 3).toFixed(1)} GB
        </dd>
        <dt>Live restore</dt>
        <dd>{engine.liveRestoreEnabled ? "Enabled" : "Disabled"}</dd>
        <dt>Experimental</dt>
        <dd>{engine.experimental ? "Enabled" : "Disabled"}</dd>
      </dl>
      {engine.warnings.length > 0 && (
        <div className="engine-warnings" data-testid="engine-warnings">
          <h3>Daemon warnings</h3>
          <ul>
            {engine.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
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

/**
 * Kubernetes.
 *
 * Docker Desktop can start a single-node cluster because it already runs a VM and can put one
 * inside it. A native Linux engine has no VM, and Anchorage does not install software on the
 * host, so there is nothing here for a toggle to switch. The previous switch changed a local
 * boolean and nothing else.
 */
function HostKubernetesSettings() {
  return (
    <div className="settings-pane settings-pane--unavailable" data-testid="kubernetes-native-note">
      <h2>Kubernetes</h2>
      <p>
        Anchorage does not bundle a Kubernetes distribution. Docker Desktop can
        offer one because it manages a virtual machine; this engine runs directly
        on the host, so a cluster is a separate installation rather than a
        setting.
      </p>
      <p className="resource-dim">
        <code>k3s</code>, <code>kind</code> and <code>minikube</code> all run
        against this machine. Containers a local cluster starts appear on the
        Containers screen like any other, so Anchorage stays useful alongside
        one.
      </p>
    </div>
  );
}

/**
 * Software updates.
 *
 * The toggles here promised background installation and a beta channel. Anchorage ships no
 * updater at all, so both were inert. What an operator actually needs is how to move to a new
 * build safely, which is the signature check — so that is what this describes.
 */
function HostUpdatesSettings() {
  return (
    <div className="settings-pane settings-pane--unavailable" data-testid="updates-native-note">
      <h2>Software updates</h2>
      <p>
        Anchorage does not update itself. Nothing here contacts a server, checks
        for a release, or installs anything in the background.
      </p>
      <p>
        Releases are published as a single AppImage with a detached OpenPGP
        signature over <code>SHA256SUMS</code>. To move to a new build, verify it
        before replacing the copy you run:
      </p>
      <pre className="settings-verify-snippet">
        {"gpg --verify SHA256SUMS.asc SHA256SUMS\nsha256sum -c SHA256SUMS"}
      </pre>
      <p className="resource-dim">
        Both commands are stock tools. A signature that does not verify means the
        download is not the release that was published, whatever the file is
        named.
      </p>
    </div>
  );
}

/**
 * Advanced.
 *
 * Every switch on this pane was local state: turning BuildKit "off" left BuildKit on, and
 * turning emulation "on" installed nothing. All three are properties of the host rather than
 * application preferences, so they are reported rather than offered.
 */
function HostAdvancedSettings({ store }: { store: AnchorageStore }) {
  const refreshBuilds = store.refreshBuilds;
  useEffect(() => {
    void refreshBuilds();
  }, [refreshBuilds]);

  const current =
    store.buildBuilders.find((builder) => builder.current) ??
    store.buildBuilders[0];
  const platforms = [
    ...new Set(current?.nodes.flatMap((node) => node.platforms) ?? []),
  ].sort();
  // `docker info` reports the kernel's name for the architecture (x86_64) while buildx names
  // platforms the OCI way (linux/amd64), so comparing them directly marks the host's own
  // architecture as emulated. They are translated before being compared.
  const nativeArchitectures = nativeArchitecturesFor(
    store.systemSnapshot?.engine.architecture,
  );
  const foreign = platforms.filter((platform) => {
    const architecture = platform.split("/")[1];
    return architecture !== undefined && !nativeArchitectures.has(architecture);
  });
  const buildxMissing = store.buildsStatus === "unavailable";

  return (
    <div className="settings-pane settings-pane--advanced">
      <h2>Advanced</h2>
      <p>
        These are properties of the engine and the host, not Anchorage
        preferences, so they are reported here rather than switched.
      </p>
      <dl className="engine-facts" data-testid="advanced-facts">
        <dt>BuildKit</dt>
        <dd>
          {buildxMissing
            ? "buildx plugin not installed — builds fall back to the legacy builder"
            : current
              ? `Active · builder ${current.name} (${current.driver})`
              : "No builder reported by buildx"}
        </dd>
        <dt>Build platforms</dt>
        <dd className="resource-mono">
          {platforms.length > 0 ? platforms.join(", ") : "—"}
        </dd>
        <dt>Foreign architectures</dt>
        <dd data-testid="advanced-emulation">
          {platforms.length === 0
            ? "Unknown until buildx reports a builder"
            : foreign.length > 0
              ? `Emulated: ${foreign.join(", ")}`
              : "None registered. Install qemu-user-static, or run tonistiigi/binfmt --install all, to build for other architectures."}
        </dd>
        <dt>Usage statistics</dt>
        <dd data-testid="advanced-telemetry">
          None. Anchorage has no telemetry, no analytics and no crash reporting;
          it talks to the Docker socket you selected and nothing else.
        </dd>
      </dl>
      {store.buildsError && (
        <p className="resource-dim" role="status">
          {store.buildsError}
        </p>
      )}
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
  } else if (store.isHost && store.settingsTab === "kubernetes") {
    content = <HostKubernetesSettings />;
  } else if (store.isHost && store.settingsTab === "updates") {
    content = <HostUpdatesSettings />;
  } else if (store.isHost && store.settingsTab === "advanced") {
    content = <HostAdvancedSettings store={store} />;
  } else if (store.settingsTab === "resources") {
    content = <ResourcesSettings store={store} />;
  } else if (store.settingsTab === "engine") {
    content = <EngineSettings store={store} />;
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
