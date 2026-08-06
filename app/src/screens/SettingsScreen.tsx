import { describeEngineHosting } from "./engineHosting";
import { Fragment, useEffect, useState } from "react";
import { CliPluginHealth } from "../components/CliPluginHealth";
import { CapabilityStatusChip } from "../components/CapabilitySetup";
import {
  capabilityCatalogue,
  capabilityEntry,
  capabilityState,
  installCommandFor,
  installableCapability,
  type PluginCapability,
} from "../data/capabilities";
import { describeVersionSkew, type VersionSkew } from "../data/engineVersions";
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
  BuildBuilder,
  EnginePlugin,
  HostPackageManager,
  EngineResources,
  FeatureFlags,
  SettingsTab,
} from "../types";

/**
 * The panes this screen can show.
 *
 * `SettingsTab` lives in `src/types.ts`, which is outside this change's file set, so the
 * Builders pane's id is widened here rather than added there. The union collapses back to
 * `SettingsTab` the moment `"builders"` is added to it, and the two `as SettingsTab` casts
 * below — the only places the id crosses back into the store's setter — become no-ops.
 */
export type SettingsPaneId = SettingsTab | "builders";

/** The panes that are still a list of switches over `featureFlags`. */
type TogglePaneId = Exclude<
  SettingsPaneId,
  | "appearance"
  | "resources"
  | "engine"
  | "builders"
  // These two describe what this engine cannot be asked to change rather than listing
  // switches, so they are panes of their own.
  | "fileSharing"
  | "virtualisation"
>;

const settingsNavigation: Array<{ id: SettingsPaneId; label: string }> = [
  { id: "appearance", label: "Appearance" },
  { id: "resources", label: "Resources" },
  // The handoff's own order. File sharing and Virtualisation describe a Docker Desktop VM, and
  // against a native Linux engine there is nothing behind either — but the panes exist rather
  // than being omitted, because an operator who goes looking for them deserves to be told which
  // is the case on this engine instead of finding the row missing and guessing.
  { id: "fileSharing", label: "File sharing" },
  { id: "virtualisation", label: "Virtualisation" },
  { id: "builders", label: "Builders" },
  // The handoff calls this "Engine"; "Docker Engine" was ours.
  { id: "engine", label: "Engine" },
  { id: "updates", label: "Software updates" },
  { id: "advanced", label: "Advanced" },
];

const themeSwatches: Record<ThemeFamily, readonly [string, string, string]> = {
  nous: ["#0d2f86", "#12378f", "#f2dbc5"],
  docker: ["#0a1929", "#f7fafd", "#1d63ed"],
  github: ["#0d1117", "#f6f8fa", "#4493f8"],
  mono: ["#141414", "#fafafa", "#bebebe"],
  // chrome, panel, accent — taken from the v2.5 comp's own theme table.
  magnetic: ["#0d0c0c", "#fffdf8", "#ecb52f"],
};

const themeFamilies = THEME_OPTIONS.map((theme) => ({
  ...theme,
  swatches: themeSwatches[theme.id],
}));

const colorModes = COLOR_MODE_OPTIONS;

const cornerStyles = Object.freeze([
  {
    id: "rounded" as const,
    label: "Rounded",
    description: "Softened corners throughout.",
    demoRadius: "3px",
  },
  {
    id: "square" as const,
    label: "Square",
    description: "Hard corners; circles stay round.",
    demoRadius: "0px",
  },
]);

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
  TogglePaneId,
  {
    title: string;
    subtitle: string;
    rows: ToggleDefinition[];
  }
> = {
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
  const selectedCorner =
    cornerStyles.find((corner) => corner.id === store.cornerStyle) ??
    cornerStyles[0];
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

      <fieldset className="appearance-fieldset appearance-fieldset--mode">
        <legend>Corners</legend>
        {/* Independent of the palette: a family suggests a default — Magnetic is the one drawn
            square — and this overrides it. Once chosen, switching family stops moving it, so a
            new palette never silently undoes a shape decision. */}
        <p className="appearance-hint">
          Themes suggest a default; this overrides it.
        </p>
        <div
          className="appearance-mode-control"
          role="radiogroup"
          aria-label="Corner style"
        >
          {cornerStyles.map((corner, index) => (
            <button
              className={
                store.cornerStyle === corner.id
                  ? "appearance-mode-control__selected"
                  : ""
              }
              type="button"
              role="radio"
              aria-checked={store.cornerStyle === corner.id}
              tabIndex={store.cornerStyle === corner.id ? 0 : -1}
              data-testid={`corner-style-${corner.id}`}
              key={corner.id}
              onClick={() => store.setCornerStyle(corner.id)}
              onKeyDown={(event) =>
                handleRadioKeyDown(
                  event,
                  cornerStyles,
                  index,
                  store.setCornerStyle,
                )
              }
            >
              <span
                className="appearance-corner-demo"
                style={{ borderRadius: corner.demoRadius }}
                aria-hidden="true"
              />
              <strong>{corner.label}</strong>
              <span>{corner.description}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <p className="appearance-current" role="status" aria-live="polite">
        Using {selectedTheme.label} · {selectedMode.label} ·{" "}
        {selectedCorner.label} corners · {persistenceStatus}
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

/**
 * A settings row with a switch, in one of three states: on, off, or locked.
 *
 * Locked is for a value Docker exposes and Anchorage cannot set. It uses the native `disabled`
 * attribute rather than a class that only looks inert, because a control an operator can focus
 * and press is a control they will expect to act; `aria-disabled` announces that and still lets
 * the press through. The reason travels with the switch and is wired to it by `aria-describedby`
 * — a dead control with no explanation reads as a bug, which is worse than not offering one.
 */
function SettingsToggleRow({
  label,
  description,
  checked,
  onToggle,
}: {
  label: string;
  description: string;
  checked: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="settings-toggle-row">
      <div>
        <h3>{label}</h3>
        <p>{description}</p>
      </div>
      <button
        className={`settings-switch${
          checked ? " settings-switch--checked" : ""
        }`}
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        onClick={onToggle}
      >
        <span />
      </button>
    </div>
  );
}


/**
 * How host directories reach containers.
 *
 * v2.5 offers a choice here — VirtioFS and its alternatives — which exists because Docker Desktop
 * runs containers inside a virtual machine and something has to carry the host filesystem across
 * that boundary. A native Linux engine has no boundary: a bind mount is the host's own directory,
 * mounted by the kernel the containers are already using. There is no sharing implementation to
 * pick, so this pane says which case the engine is in rather than offering a control that reaches
 * nothing.
 */
function FileSharingSettings({ store }: { store: AnchorageStore }) {
  const hosting = describeEngineHosting(store.systemSnapshot?.engine);
  return (
    <div className="settings-pane" data-testid="settings-file-sharing">
      <h2>File sharing</h2>
      <p className="settings-pane__lede">
        How host directories reach containers. On a machine where Docker runs containers inside a
        virtual machine this is usually the largest single influence on how fast local development
        feels.
      </p>
      {hosting.kind === "native-linux" && (
        <div className="compose-notice" data-testid="file-sharing-native">
          <strong>Nothing to configure on this engine</strong>
          <p>
            Docker reports this daemon as <code>{hosting.reported}</code> — a native Linux engine.
            Containers use this host&rsquo;s own kernel, so a bind mount is the host directory
            itself rather than a copy carried across a VM boundary. There is no sharing
            implementation to choose between, and no cache to tune.
          </p>
          <p className="resource-dim">
            What still applies: a bind mount gives the container the host&rsquo;s permissions on
            that path. Anchorage does not narrow them.
          </p>
        </div>
      )}
      {hosting.kind === "desktop" && (
        <div className="compose-notice" data-testid="file-sharing-desktop">
          <strong>Docker Desktop owns this setting</strong>
          <p>
            Docker reports this daemon as <code>{hosting.reported}</code>, which does run
            containers in a virtual machine — so there is a sharing implementation here. Docker
            exposes no CLI or API for reading or changing it, so Anchorage cannot project it.
            Docker Desktop&rsquo;s own settings are where it lives.
          </p>
        </div>
      )}
      {hosting.kind === "unknown" && (
        <p className="resource-dim" role="status">
          Reading the engine…
        </p>
      )}
    </div>
  );
}

/**
 * Which monitor runs the Linux kernel the containers use.
 *
 * The handoff's copy opens by asserting the kernel "comes from a virtual machine on this host",
 * which is true of Docker Desktop and false of a native engine. Asserting it unconditionally
 * would be telling the operator something about their machine that we had not checked.
 */
function VirtualisationSettings({ store }: { store: AnchorageStore }) {
  const hosting = describeEngineHosting(store.systemSnapshot?.engine);
  return (
    <div className="settings-pane" data-testid="settings-virtualisation">
      <h2>Virtualisation</h2>
      <p className="settings-pane__lede">
        Linux containers need a Linux kernel. Where that kernel comes from changes both
        performance and compatibility.
      </p>
      {hosting.kind === "native-linux" && (
        <div className="compose-notice" data-testid="virtualisation-native">
          <strong>No virtual machine is involved</strong>
          <p>
            Docker reports this daemon as <code>{hosting.reported}</code>. Containers run directly
            on this host&rsquo;s kernel, so there is no hypervisor to select and no VM resources to
            divide. The Resources pane covers the limits that do apply here.
          </p>
          <p className="resource-dim">
            Worth stating plainly: sharing the host kernel is what makes a container a process
            boundary rather than a security boundary between tenants.
          </p>
        </div>
      )}
      {hosting.kind === "desktop" && (
        <div className="compose-notice" data-testid="virtualisation-desktop">
          <strong>Docker Desktop owns this setting</strong>
          <p>
            Docker reports this daemon as <code>{hosting.reported}</code>, so a virtual machine is
            supplying the kernel. Which monitor runs it is chosen in Docker Desktop; no CLI or API
            reports or changes it, so Anchorage does not project it.
          </p>
        </div>
      )}
      {hosting.kind === "unknown" && (
        <p className="resource-dim" role="status">
          Reading the engine…
        </p>
      )}
    </div>
  );
}


/**
 * Which optional capabilities this installation has, and which it does not.
 *
 * Five destinations are nothing but a Docker CLI plugin, and with no plugin installed their
 * sidebar rows are left out — so this is where they live instead. Without it, hiding a row would
 * simply lose the destination; with it, every gated capability is named whether or not it is
 * installed, and the operator decides which absent ones they still want in reach.
 *
 * The visibility control is a button rather than a switch on purpose. A `role="switch"` in any
 * settings pane fails the host-candidate gate, which exists because this application once shipped
 * fixture switches that could not reach the engine. That reasoning does not apply to a renderer
 * preference — but the gate is mechanical, and the Appearance pane already expresses real
 * preferences as pressed buttons, so this follows it rather than carving out an exception.
 */
/**
 * What the CLI and the daemon say about each other.
 *
 * Silent when they agree, because a sentence on every healthy machine is noise. The two cases
 * worth interrupting for are different in kind and are not given the same tone: a version
 * difference costs newer flags, while a daemon below the client's API floor fails every call.
 *
 * There is no "update" button, and there cannot be. Docker Engine is a distribution package and
 * upgrading it needs root; the core executes only the fingerprinted `docker` binary and could
 * not invoke a package manager if asked. So this states the position and leaves the remedy with
 * the operator, exactly as a missing CLI plugin does.
 */
function EngineVersionSkew({ skew }: { skew: VersionSkew }) {
  if (skew.kind === "aligned" || skew.kind === "unknown") return null;
  return (
    <p
      className={
        skew.kind === "incompatible" ? "capability-error" : "engine-version-skew"
      }
      role="status"
      data-testid={`engine-version-${skew.kind}`}
    >
      <strong>
        {skew.kind === "incompatible"
          ? "This CLI cannot drive this daemon."
          : "The CLI and the daemon are different versions."}
      </strong>{" "}
      {skew.detail}
    </p>
  );
}

/**
 * The daemon's own plugins.
 *
 * Docker has two plugin systems and this application only ever reported one. The CLI plugins
 * above are executables the client shells out to; these are containers the daemon runs to
 * provide volume, network, log, IPAM, metrics and authorization drivers. `docker plugin ls`
 * lists them and nothing in Anchorage did.
 *
 * The privileges are why this is not just another table. Installing one grants it host mounts,
 * devices, Linux capabilities and a network mode — consent given once at
 * `docker plugin install` and never surfaced again, so a driver holding CAP_SYS_ADMIN, host
 * networking and a bind of `/` looks identical to one holding nothing. That is exactly the kind
 * of thing this application exists to show.
 */
/**
 * The install command for this machine, with one click to copy it.
 *
 * Not a button that installs. That would need root, and the core cannot execute anything but the
 * fingerprinted Docker binary — a package manager is out of reach by construction, which is the
 * same reason the pane says Anchorage does not install these. What it can do is stop making the
 * operator work out what their own distribution calls the package.
 */
function CapabilityInstallCommand({
  capability,
  manager,
}: {
  capability: PluginCapability;
  manager?: HostPackageManager;
}) {
  const [copied, setCopied] = useState(false);
  const install = installCommandFor(capability, manager);
  if (!install) return null;
  return (
    <div
      className="capabilities-row__install"
      data-testid={`capability-install-${capability.plugin}`}
    >
      <code className="resource-mono">{install.command}</code>
      <button
        type="button"
        className="ghost-button"
        onClick={() => {
          void navigator.clipboard
            .writeText(install.command)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      {install.thirdParty && (
        <span className="resource-dim">
          Third-party build recipe — worth reading before running.
        </span>
      )}
    </div>
  );
}

function EnginePluginsSettings({ store }: { store: AnchorageStore }) {
  const refresh = store.refreshEnginePlugins;
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Undefined and null both mean "not read"; normalising here keeps every branch below to one
  // question rather than two.
  const plugins = store.enginePlugins ?? null;
  return (
    <section className="engine-plugins" data-testid="engine-plugins">
      <div className="plugin-health__heading">
        <h3>Managed plugins</h3>
        <button
          type="button"
          className="ghost-button"
          data-testid="engine-plugins-refresh"
          onClick={() => void refresh()}
        >
          Re-read
        </button>
      </div>
      <p className="plugin-health__note">
        Volume, network, log and authorization drivers the daemon runs as containers. A different
        system from the CLI plugins above, installed with <code>docker plugin install</code>.
      </p>

      {store.enginePluginsError && (
        <p className="capability-error" role="status">
          {store.enginePluginsError}
        </p>
      )}

      {plugins === null && !store.enginePluginsError && (
        <p className="plugin-health__note" role="status">
          Reading the daemon&rsquo;s plugins…
        </p>
      )}

      {plugins !== null && plugins.length === 0 && (
        <p className="plugin-health__note" data-testid="engine-plugins-empty">
          This daemon runs no managed plugins. Docker&rsquo;s own drivers are built in; these are
          the ones an operator installs on top.
        </p>
      )}

      {plugins !== null && plugins.length > 0 && (
        <ul className="engine-plugins__list">
          {plugins.map((plugin) => (
            <li
              className="engine-plugins__row"
              key={plugin.id || plugin.name}
              data-testid={`engine-plugin-${plugin.name}`}
            >
              <div className="plugin-health__head">
                <code>{plugin.name}</code>
                <span
                  className={`plugin-health__tag plugin-health__tag--${
                    plugin.enabled ? "enabled" : "disabled"
                  }`}
                >
                  {plugin.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              {plugin.description && (
                <p className="plugin-health__reason">{plugin.description}</p>
              )}
              {plugin.interfaces.length > 0 && (
                <p className="engine-plugins__interfaces resource-mono resource-dim">
                  {plugin.interfaces.join(" · ")}
                </p>
              )}
              <EnginePluginPrivilegeList privileges={plugin.privileges} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What this plugin may reach.
 *
 * Silent when it holds nothing, because a row of empty fields reads as though the question was
 * not asked. Each entry is a grant the daemon is honouring right now.
 */
function EnginePluginPrivilegeList({
  privileges,
}: {
  privileges: EnginePlugin["privileges"];
}) {
  const grants: Array<[string, string]> = [];
  if (privileges.network) grants.push(["Network", privileges.network]);
  if (privileges.capabilities.length > 0) {
    grants.push(["Capabilities", privileges.capabilities.join(", ")]);
  }
  if (privileges.allowAllDevices) {
    grants.push(["Devices", "every device on the host"]);
  } else if (privileges.devices.length > 0) {
    grants.push(["Devices", privileges.devices.join(", ")]);
  }
  if (privileges.mounts.length > 0) {
    grants.push(["Host mounts", privileges.mounts.join(", ")]);
  }
  if (grants.length === 0) return null;

  return (
    <dl className="engine-plugins__privileges" data-testid="engine-plugin-privileges">
      {grants.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd className="resource-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Install, for the plugins Anchorage can install itself.
 *
 * This pane reported `docker agent` as "Not installed" beside a shell command to copy, and that
 * was the whole offer — reported as "even though it says agents not installed in the engine
 * section i cannot install it". The install had existed since the capability work: the core
 * carries a compiled table of plugins it will fetch, and the Agents and Tools setup screens both
 * have the button. Settings, which is where anyone looking for "what is missing" actually goes,
 * was never given it.
 *
 * Deliberately compact against the setup screen's version. That screen is the whole point of
 * itself and can spend three paragraphs on what a verified digest does and does not prove; this
 * is one row in a list of five. The caveat that matters most — a digest is not a publisher
 * signature — stays, because it is the part that would otherwise be assumed.
 */
function CapabilityDirectInstall({
  store,
  capability,
}: {
  store: AnchorageStore;
  capability: PluginCapability;
}) {
  const installable = installableCapability(capability.plugin);
  if (!installable) return null;
  const busy = store.capabilityInstalling === installable;
  const installed =
    store.capabilityInstalled?.plugin === capability.plugin
      ? store.capabilityInstalled
      : null;
  return (
    <div className="capabilities-row__direct">
      <button
        type="button"
        className="primary-button"
        disabled={busy}
        data-testid={`capability-install-now-${capability.plugin}`}
        onClick={() => void store.installCapability(installable)}
      >
        {busy ? "Installing…" : "Install"}
      </button>
      <span className="resource-dim">
        Downloads the binary Docker publishes for this release, checks it against the SHA-256
        that release states, and writes it to your own plugin directory — no root. The digest
        proves the bytes match what GitHub served; it is not a publisher signature.
      </span>
      {store.capabilityInstallError && !busy && (
        <p className="capability-install__failed" role="alert">
          {store.capabilityInstallError}
        </p>
      )}
      {installed && (
        <p className="capabilities-row__installed" data-testid={`capability-installed-${capability.plugin}`}>
          Installed {installed.release} to{" "}
          <code className="resource-mono">{installed.path}</code>
        </p>
      )}
    </div>
  );
}

function CapabilitiesSettings({ store }: { store: AnchorageStore }) {
  return (
    <section className="capabilities-settings" data-testid="settings-capabilities">
      <div className="plugin-health__heading">
        <h3>Capabilities</h3>
      </div>
      <p className="plugin-health__note">
        Optional Docker plugins, and what depends on them. Anchorage installs the ones Docker
        publishes a Linux binary for, straight into your own plugin directory. The rest are
        distribution packages, which need root the core does not have, so those show the command
        for this machine&rsquo;s package manager instead.
      </p>
      <ul className="capabilities-list">
        {capabilityCatalogue.map((capability) => {
          const state = capabilityState(store.pluginReport, capability.plugin);
          const entry = capabilityEntry(store.pluginReport, capability.plugin);
          const revealed = store.revealedCapabilities.includes(capability.view);
          // Only a row that would actually be hidden gets the control. Offering it for Compose,
          // whose row never disappears, would be a switch with nothing on the other end.
          const hideable = capability.gatesSidebar && state === "absent";
          return (
            <li
              className="capabilities-row"
              key={capability.plugin}
              data-testid={`capability-row-${capability.plugin}`}
            >
              <div className="capabilities-row__identity">
                <span className="capabilities-row__name">{capability.label}</span>
                <code className="resource-mono">docker {capability.plugin}</code>
              </div>
              <p className="capabilities-row__summary">{capability.summary}</p>
              <div className="capabilities-row__state">
                <CapabilityStatusChip state={state} />
                {entry?.version && (
                  <span className="resource-mono resource-dim">{entry.version}</span>
                )}
                {!capability.gatesSidebar && state === "absent" && (
                  <span className="resource-dim">
                    Its screen stays in the sidebar and explains the absence itself.
                  </span>
                )}
              </div>
              {/* The button first where there is one, because it is the answer. The command
                  stays underneath it rather than being replaced: a distribution package is a
                  different thing from a binary dropped in a user directory — it gets updates —
                  and an operator who would rather have that should not have to go and find out
                  what their own distribution calls it. */}
              {state === "absent" && (
                <>
                  <CapabilityDirectInstall store={store} capability={capability} />
                  <CapabilityInstallCommand
                    capability={capability}
                    manager={store.pluginReport?.packageManager}
                  />
                </>
              )}
              {hideable && (
                <div className="capabilities-row__actions">
                  <button
                    type="button"
                    className="ghost-button"
                    aria-pressed={revealed}
                    data-testid={`capability-reveal-toggle-${capability.plugin}`}
                    onClick={() =>
                      store.setCapabilityRevealed(capability.view, !revealed)
                    }
                  >
                    {revealed ? "Shown in sidebar" : "Show in sidebar"}
                  </button>
                  <span className="resource-dim">
                    {revealed
                      ? "Its row is in the sidebar, where it explains how to install the plugin."
                      : "Not installed, so its row is hidden. Show it to reach the setup screen."}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
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
  const skew = describeVersionSkew(store.dockerVersions ?? undefined);
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
        {/* The half the Engine API cannot answer. Reported beside the server's so the two can
            be compared at a glance, which is the whole reason it is read. */}
        <dt>Client version</dt>
        <dd data-testid="engine-client-version">
          {skew.clientVersion ?? "Not reported"}
        </dd>
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
        {/* Read from the daemon and not writable here, so they are reported as facts. A
            disabled switch would claim to be a control that this build never had. */}
        <dt>Live restore</dt>
        <dd data-testid="engine-live-restore">
          {engine.liveRestoreEnabled ? "Enabled" : "Disabled"}
          <span className="engine-facts__source">daemon.json · live-restore</span>
        </dd>
        <dt>Experimental</dt>
        <dd data-testid="engine-experimental">
          {engine.experimental ? "Enabled" : "Disabled"}
          <span className="engine-facts__source">daemon.json · experimental</span>
        </dd>
      </dl>
      <EngineVersionSkew skew={skew} />
      <CapabilitiesSettings store={store} />
      <CliPluginHealth store={store} />
      <EnginePluginsSettings store={store} />
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

/** Every platform the builder's nodes can produce, deduplicated across them. */
function builderPlatforms(builder: BuildBuilder): string[] {
  return [...new Set(builder.nodes.flatMap((node) => node.platforms))].sort();
}

/**
 * The status line for a builder, and the tone that paints it.
 *
 * Buildx reports status per node rather than per builder, and reports none at all for one it
 * could not reach — those arrive with `Err` set, an empty driver, and a single nameless node.
 * The error is the status in that case: a blank cell beside a builder name reads as healthy.
 *
 * Only `running` is green. Everything else buildx reports (`inactive`, `starting`, `stopped`)
 * is a builder that exists but is not currently serving builds, which is neither a fault nor
 * a success, so it is left in the neutral text colour the handoff uses for `stopped`. The
 * label is always the word buildx used, because the greyscale theme has no hue to lean on.
 */
function builderStatus(builder: BuildBuilder): {
  label: string;
  tone: "success" | "danger" | "neutral";
} {
  if (builder.error) return { label: "error", tone: "danger" };
  const statuses = [
    ...new Set(builder.nodes.map((node) => node.status).filter(Boolean)),
  ];
  if (statuses.length === 0) return { label: "unknown", tone: "neutral" };
  const label = statuses.join(", ");
  if (statuses.includes("error")) return { label, tone: "danger" };
  if (statuses.every((status) => status === "running")) {
    return { label, tone: "success" };
  }
  return { label, tone: "neutral" };
}

/**
 * Builders.
 *
 * The builder inventory is already read for the Builds screen; this promotes it to the pane
 * the handoff specifies. The handoff's rows are clickable and set the active builder — that
 * is `docker buildx use`, a write to the CLI's own configuration that outlives this app, and
 * this build has no verb for it. So the active builder is reported and not offered: a row
 * that looks selectable and changes nothing is the Resources sliders again.
 */
function BuildersSettings({ store }: { store: AnchorageStore }) {
  if (!store.isHost) return <FixtureBuildersSettings />;
  return <HostBuildersSettings store={store} />;
}

/**
 * Fixture mode has no builders, and inventing them would name BuildKit instances that do not
 * exist — the operator would then go looking for a cache that was never anywhere.
 */
function FixtureBuildersSettings() {
  return (
    <div
      className="settings-pane settings-pane--unavailable"
      data-testid="builders-fixture-note"
    >
      <h2>Builders</h2>
      <p>
        Builders are read from <code>docker buildx ls</code> on the connected
        engine. This session runs on fixture data and is not connected to one, so
        there is no builder inventory to show.
      </p>
      <p className="resource-dim">
        Connect Anchorage to a Docker engine to see which BuildKit instance runs
        your builds.
      </p>
    </div>
  );
}

/**
 * The two things that can be done to one builder.
 *
 * This pane used to report an unreachable builder, print buildx's own error beside it, and then
 * tell the operator to go and run `docker buildx rm` themselves. Both verbs here are that same
 * buildx command; neither invents anything Docker does not already do.
 *
 * Starting is only offered where it could help — a builder buildx already reports as running has
 * nothing to bootstrap. The confirmation for removal is a second click rather than a dialog: it
 * is one row, and a modal would be heavier than the act. Its question lives in a spill row
 * beneath, because the actions column is a fixed gutter that truncates, and the thing being
 * agreed to — that the build cache goes too — is the part that must not be cut off.
 */
/**
 * How this builder can be deleted, if it can be.
 *
 * Buildx lists a builder for every Docker context alongside the ones it owns, and refuses to
 * delete the former:
 *
 *     failed to remove desktop-linux: context builder cannot be removed,
 *     run `docker context rm desktop-linux` to remove this context
 *
 * On a machine where Docker Desktop was uninstalled and podman is not running, that is every
 * removable-looking row on the pane: `desktop-linux` and `podman` sat there reporting a dead
 * socket, with a Remove button that could not succeed however many times it was pressed. The
 * name matching a context is the whole test, because that is exactly the condition buildx
 * objects to.
 *
 * `default` is excluded even though it is also a context: buildx will not remove the default
 * builder, and Docker will not remove the default context. Neither will the current context,
 * which is the connection Anchorage is using.
 */
function builderRemoval(
  builder: BuildBuilder,
  contexts: ReadonlyArray<{ name: string; current: boolean }> | undefined,
): {
  action: "remove" | "remove-context";
  label: string;
  consequence: string;
} | null {
  // No context list means the classification cannot be made, and the safe answer is the verb
  // that was always offered: buildx will refuse a context builder and say so, which is worse
  // than choosing correctly and better than a render that throws and takes the pane with it.
  const context = contexts?.find((entry) => entry.name === builder.name);
  if (!context) {
    return {
      action: "remove",
      label: "Remove",
      consequence:
        "Removes this builder and its build cache. Nothing restores the cache.",
    };
  }
  if (builder.name === "default" || context.current) {
    return null;
  }
  return {
    action: "remove-context",
    label: "Remove context",
    consequence:
      "This builder is a Docker context, so buildx cannot remove it — Docker removes the context instead. That deletes the connection entry only: no container, image or volume is touched, and recreating the context brings it back.",
  };
}

function BuilderActions({
  store,
  builder,
  confirming,
  onConfirm,
}: {
  store: AnchorageStore;
  builder: BuildBuilder;
  confirming: boolean;
  onConfirm: (name: string | null) => void;
}) {
  const busy = store.builderActionPending === builder.name;
  const running = builder.nodes.some((node) => node.status === "running");
  const removal = builderRemoval(builder, store.availableContexts);

  if (confirming && removal) {
    return (
      <div className="builders-row__actions">
        <button
          type="button"
          className="ghost-button"
          onClick={() => onConfirm(null)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary-button primary-button--danger"
          disabled={busy}
          data-testid={`builder-remove-confirm-${builder.name}`}
          onClick={() => {
            onConfirm(null);
            void store.runBuilderAction({
              name: builder.name,
              action: removal.action,
              confirmed: true,
            });
          }}
        >
          {busy ? "Removing…" : removal.label}
        </button>
      </div>
    );
  }

  return (
    <div className="builders-row__actions">
      {!running && (
        <button
          type="button"
          className="ghost-button"
          disabled={busy}
          data-testid={`builder-bootstrap-${builder.name}`}
          title="Runs docker buildx inspect --bootstrap, which starts this builder's node"
          onClick={() => {
            void store.runBuilderAction({ name: builder.name, action: "bootstrap" });
          }}
        >
          {busy ? "Starting…" : "Try to start"}
        </button>
      )}
      {/* No button where nothing would work. The default builder and the context Anchorage is
          connected through are both refused by Docker itself; a control that exists only to
          report that is worse than the row saying so once, below. */}
      {removal ? (
        <button
          type="button"
          className="ghost-button ghost-button--danger"
          disabled={busy}
          data-testid={`builder-remove-${builder.name}`}
          onClick={() => onConfirm(builder.name)}
        >
          {removal.label}
        </button>
      ) : (
        <span className="resource-dim" data-testid={`builder-permanent-${builder.name}`}>
          {builder.name === "default"
            ? "The default builder cannot be removed."
            : "This is the context Anchorage is connected through."}
        </span>
      )}
    </div>
  );
}

function HostBuildersSettings({ store }: { store: AnchorageStore }) {
  // One at a time: the question appears in a row of its own, and two open at once would read
  // as one question about both builders.
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const refreshBuilds = store.refreshBuilds;
  useEffect(() => {
    void refreshBuilds();
  }, [refreshBuilds]);

  const builders = store.buildBuilders;
  const unreachable = builders.filter((builder) => Boolean(builder.error));

  if (store.buildsStatus === "unavailable") {
    return (
      <div
        className="settings-pane settings-pane--unavailable"
        data-testid="builders-unavailable"
      >
        <h2>Builders</h2>
        <p>
          Builders come from BuildKit through <code>docker buildx</code>, and the
          plugin is not installed. Builds fall back to the legacy builder, which
          has no builder to choose and no shared cache to place.
        </p>
      </div>
    );
  }

  return (
    <div className="settings-pane settings-pane--builders">
      <h2>Builders</h2>
      <p>
        Which BuildKit instance runs your builds. The active builder decides where
        the cache lives and which platforms you can target natively.
      </p>

      {builders.length === 0 ? (
        <p className="resource-dim" role="status" data-testid="builders-empty">
          {store.buildsStatus === "ready"
            ? "Buildx reported no builders."
            : store.buildsStatus === "error"
              ? "Buildx could not be read on this engine."
              : "Reading builders…"}
        </p>
      ) : (
        <table className="builders-table" data-testid="builders-table">
          <thead>
            <tr>
              <th scope="col">Builder</th>
              <th scope="col">Driver</th>
              <th scope="col">Platforms</th>
              <th scope="col">Status</th>
              <th scope="col" className="builders-table__active">
                Active
              </th>
              <th scope="col" className="builders-table__actions">
                <span className="builders-table__actions-label">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {builders.map((builder) => {
              const status = builderStatus(builder);
              const platforms = builderPlatforms(builder);
              return (
                <Fragment key={builder.name}>
                  <tr
                    className={`builders-row${
                      builder.current ? " builders-row--current" : ""
                    }`}
                    data-testid={`builder-${builder.name}`}
                  >
                    <th scope="row" className="builders-row__name">
                      {builder.name}
                    </th>
                    {/* A builder buildx could not reach reports no driver and no
                        platforms, so those cells are empty rather than unknown. */}
                    <td className="builders-row__mono">
                      {builder.driver || "—"}
                    </td>
                    <td className="builders-row__mono">
                      {platforms.length > 0 ? platforms.join(", ") : "—"}
                    </td>
                    <td
                      className={`builders-row__status builders-row__status--${status.tone}`}
                    >
                      {status.label}
                    </td>
                    <td className="builders-table__active">
                      {builder.current && (
                        <span className="builders-chip">Active</span>
                      )}
                    </td>
                    <td className="builders-table__actions">
                      <BuilderActions
                        store={store}
                        builder={builder}
                        confirming={confirmingRemove === builder.name}
                        onConfirm={setConfirmingRemove}
                      />
                    </td>
                  </tr>
                  {confirmingRemove === builder.name && (
                    <tr className="builders-row builders-row--reason">
                      <td colSpan={6} data-testid={`builder-remove-question-${builder.name}`}>
                        Remove <strong>{builder.name}</strong>?{" "}
                        {/* The consequence comes from the same function that chose the verb, so
                            the question can never describe a build cache for a removal that
                            deletes a connection entry instead. */}
                        {builderRemoval(builder, store.availableContexts)?.consequence}
                        {builder.current
                          ? " It is the active builder, so buildx will fall back to another one."
                          : ""}
                      </td>
                    </tr>
                  )}
                  {/* Buildx's own note, in the row it belongs to. The Builds screen
                      carries it in a `title`, which is invisible until hovered — here
                      it is the reason the operator came to this pane. */}
                  {builder.error && (
                    <tr className="builders-row builders-row--reason">
                      <td colSpan={6} data-testid={`builder-error-${builder.name}`}>
                        {builder.error}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      {unreachable.length > 0 && (
        <p className="builders-note" data-testid="builders-unreachable-note">
          {unreachable.length === 1
            ? "One builder is configured but unreachable"
            : `${unreachable.length} builders are configured but unreachable`}
          . A build that names one fails rather than falling back to the active
          builder, so they are listed with buildx's reason instead of hidden.
          <strong> Try to start</strong> runs{" "}
          <code>docker buildx inspect --bootstrap</code>, which is enough when the
          builder&rsquo;s container was simply stopped. Leftover entries from an
          uninstalled Docker Desktop cannot be started at all and want removing.
        </p>
      )}

      <p className="builders-note" data-testid="builders-read-only">
        Anchorage does not switch builders. Choosing one is{" "}
        <code>docker buildx use &lt;name&gt;</code>, which rewrites the CLI's own
        configuration for every tool on this machine — so the active builder is
        reported here rather than offered as a choice. Starting and removing a
        builder change only that builder, which is why those two are offered.
      </p>

      {/* Buildx's own refusal — "cannot remove the default builder" is the common one — rather
          than a restatement of it. Above buildsError because it is about the act just attempted. */}
      {store.builderActionError && (
        <p className="capability-error" role="status" data-testid="builder-action-error">
          {store.builderActionError}
        </p>
      )}
      {store.buildsError && (
        <p className="resource-dim" role="status">
          {store.buildsError}
        </p>
      )}
    </div>
  );
}

function ToggleSettings({
  store,
  tab,
}: {
  store: AnchorageStore;
  tab: TogglePaneId;
}) {
  const definition = toggleDefinitions[tab];
  return (
    <div className="settings-pane settings-pane--toggles">
      <h2>{definition.title}</h2>
      <p>{definition.subtitle}</p>
      <div className="settings-toggle-list">
        {definition.rows.map((row) => (
          <SettingsToggleRow
            label={row.label}
            description={row.description}
            checked={store.featureFlags[row.key]}
            onToggle={() => store.toggleFeatureFlag(row.key)}
            key={row.key}
          />
        ))}
      </div>
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
  // Widened rather than annotated: the store still types this as `SettingsTab`, and a plain
  // annotation leaves control-flow analysis narrowing back to the initializer's type, which
  // makes the `"builders"` comparison below look impossible.
  const activeTab = store.settingsTab as SettingsPaneId;
  let content;
  if (activeTab === "appearance") {
    content = <AppearanceSettings store={store} />;
  } else if (store.isHost && activeTab === "updates") {
    content = <HostUpdatesSettings />;
  } else if (store.isHost && activeTab === "advanced") {
    content = <HostAdvancedSettings store={store} />;
  } else if (activeTab === "resources") {
    content = <ResourcesSettings store={store} />;
  } else if (activeTab === "builders") {
    content = <BuildersSettings store={store} />;
  } else if (activeTab === "engine") {
    content = <EngineSettings store={store} />;
  } else if (activeTab === "fileSharing") {
    content = <FileSharingSettings store={store} />;
  } else if (activeTab === "virtualisation") {
    content = <VirtualisationSettings store={store} />;
  } else {
    content = <ToggleSettings store={store} tab={activeTab} />;
  }

  return (
    <section className="settings-screen screen" data-testid="settings-screen">
      <aside className="settings-navigation" data-testid="settings-navigation">
        <h1>Settings</h1>
        <nav aria-label="Settings sections">
          {navigationItems.map((item) => (
            <button
              className={
                activeTab === item.id ? "settings-navigation__active" : ""
              }
              type="button"
              aria-current={activeTab === item.id ? "page" : undefined}
              key={item.id}
              onClick={() => store.setSettingsTab(item.id as SettingsTab)}
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
