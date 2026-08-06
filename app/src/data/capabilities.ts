import type {
  DockerCliPlugin,
  HostPackageManager,
  InstallableCapability,
  SystemPlugins,
  ViewId,
} from "../types";

/*
Which destinations are gated on a Docker CLI plugin, and what to do when one is missing.

Three screens — Models, Agents, Tools — are nothing but a plugin. Each stated its absence in
fixed copy, offered a link to the Command Center, and left the operator with a dead row: no way
to see whether the plugin was missing or broken, no way to clear a faulty one, and no way to tell
Anchorage to look again after installing it. On the reference host several plugin entries are
dangling symlinks from a removed Docker Desktop, so the honest answer was not "install this" at
all.

There were five. Bosun (`docker ai`) and Sandboxes (`sbx`) are gone, because no install advice
could have been true: Docker publishes no standalone binary for Gordon at any price, and
Sandboxes wants Ubuntu 24.04+, KVM and an OAuth sign-in. A capability whose install instructions
cannot be followed is not a capability, it is an advertisement. The three that remain each have
a Linux binary Docker actually publishes.

Two decisions are recorded here.

**An absent plugin hides the row; a faulty one keeps it.** The old policy was that every
destination has a row, because "an absent row says nothing at all". That was right while nothing
else said anything either. It is not right now: `capabilityCatalogue` below gives Settings a
place to list every gated capability, installed or not, so an absent row no longer means silence
— it means the destination lives in Settings until the capability exists. A *broken* plugin is
the opposite case and stays visible: something was installed here and went wrong, and that row
is the way into the repair.

**Some of this Anchorage now installs itself, and the line is drawn by privilege.** This block
used to read "nothing here installs anything", on the grounds that the core had no HTTP client
and Electron blocks every download. Half of that reasoning was sound and half was a habit. A
*distribution package* needs root, and the core must never have it, so for Compose and Buildx the
command remains the only honest answer. A *plugin binary* is one executable in a directory the
operator already owns, which needs no privilege at all — the only blocker was that nothing could
fetch it. The core can now, for the short allowlist in `installableCapability` below and nothing
else. Everything else here is unchanged: the command where Docker publishes a package, the
directory mechanics where it does not, and a re-check that notices the moment a plugin lands.
*/

/**
 * How a capability arrives on this machine, as far as Docker documents it.
 *
 * There was a third kind, `desktop`, for capabilities obtainable only by installing Docker
 * Desktop. Nothing carries it now: a capability that cannot be installed against the engine in
 * front of the operator was removed rather than described, so the kind has no members left.
 */
export type CapabilityInstallKind = "package" | "plugin-binary";

/**
 * How a package reaches this machine, keyed by the manager the host actually has.
 *
 * This replaced a flat pair of apt and dnf lines, which were shown to every operator regardless
 * of their distribution — so an Arch host was told to run `sudo apt-get install`, a command that
 * cannot work there. The host's manager is detected by the core and the matching entry is the
 * only one rendered.
 *
 * `aur` is separate from `pacman` because the two are not interchangeable: a package in the AUR
 * cannot be installed by pacman alone, and the PKGBUILD is third-party even when the source it
 * builds is Docker's own. That distinction belongs in front of the operator, not buried.
 */
export interface CapabilityInstallCommands {
  "apt-get"?: string;
  dnf?: string;
  zypper?: string;
  apk?: string;
  pacman?: string;
  aur?: string;
}

export interface CapabilityInstall {
  kind: CapabilityInstallKind;
  /** The distribution package, where Docker publishes one. */
  package?: string;
  /** Commands for the operator to run, by package manager. Anchorage never runs them. */
  commands?: CapabilityInstallCommands;
  /** What the commands do not say on their own. */
  note: string;
  /** Set when the only route is a third-party build recipe rather than a published package. */
  thirdParty?: boolean;
}

export interface PluginCapability {
  view: ViewId;
  label: string;
  /** The `docker <plugin>` this destination cannot work without. */
  plugin: string;
  summary: string;
  install: CapabilityInstall;
  /**
   * Whether an absent plugin removes the sidebar row.
   *
   * False for the workspace surfaces. Compose, Builds and Scan are gated on a plugin too, but
   * they are core Docker workflows with substantial screens behind them, and a Compose row that
   * vanished because the plugin was missing would read as the application having lost a feature.
   * They are listed here so Settings can report and repair them; their rows stay put.
   */
  gatesSidebar: boolean;
}

/**
 * The plugin directory mechanics, which hold for every CLI plugin regardless of how it ships.
 *
 * Worth stating on every capability: it is the one instruction that is always actionable, and
 * it is what makes the re-check meaningful — the operator can put the binary in place from
 * anywhere and Anchorage will see it without a restart.
 */
export const PLUGIN_DIRECTORY_MECHANICS =
  "A CLI plugin is one executable named docker-<name> in a directory the Docker CLI searches. Once it is in place and executable, Re-check finds it — Anchorage does not need restarting.";

export const capabilityCatalogue: readonly PluginCapability[] = Object.freeze([
  {
    view: "models",
    label: "Models",
    plugin: "model",
    summary:
      "Docker Model Runner, which serves local inference through the Engine.",
    gatesSidebar: true,
    install: {
      kind: "package",
      package: "docker-model-plugin",
      commands: {
        "apt-get": "sudo apt-get install docker-model-plugin",
        dnf: "sudo dnf install docker-model-plugin",
        aur: "paru -S docker-model-plugin",
      },
      thirdParty: true,
      note: "Packaged separately from the Engine, from the same Docker repository as the Engine itself. On Arch it is not in the official repositories; the AUR recipe builds Docker's own source (github.com/docker/model-runner) with a pinned checksum and installs to a directory the CLI already searches.",
    },
  },
  {
    view: "agents",
    label: "Agents",
    plugin: "agent",
    summary:
      "Docker Agent, an open-source agent framework that ships as a CLI plugin rather than with the Engine.",
    gatesSidebar: true,
    install: {
      kind: "plugin-binary",
      note: "Docker publishes a Linux plugin binary for each release of docker/docker-agent (formerly cagent), though no distribution packages it. Running an agent additionally needs a model to talk to — either a local one through Model Runner, or an API key for a hosted provider.",
    },
  },
  {
    view: "tools",
    label: "Tools",
    plugin: "mcp",
    summary:
      "The MCP Toolkit, which manages Model Context Protocol servers through the MCP Gateway.",
    gatesSidebar: true,
    install: {
      kind: "plugin-binary",
      // Previously recorded as Desktop-only, which was wrong and was checked rather than
      // reasoned about: docker/mcp-gateway publishes a linux-amd64 plugin binary per release,
      // and it answers `catalog ls` against a standalone Engine with no Desktop present.
      // Docker's own docs still list Desktop as a prerequisite; the binary does not enforce it.
      note: "Docker publishes a Linux plugin binary for each MCP Gateway release, though no distribution packages it. It runs against a standalone Engine — the Desktop prerequisite in Docker's documentation is not enforced by the binary.",
    },
  },
  // Below here the row stays whatever the plugin's state: these are Docker workflows with real
  // screens, and their own surfaces already explain an absent plugin in their own terms.
  {
    view: "compose",
    label: "Compose",
    plugin: "compose",
    summary: "Multi-container projects defined by a Compose file.",
    gatesSidebar: false,
    install: {
      kind: "package",
      package: "docker-compose-plugin",
      commands: {
        "apt-get": "sudo apt-get install docker-compose-plugin",
        dnf: "sudo dnf install docker-compose-plugin",
        pacman: "sudo pacman -S docker-compose",
      },
      note: "Part of Docker's standard Engine installation, from the same repository as the Engine itself.",
    },
  },
  {
    view: "builds",
    label: "Builds",
    plugin: "buildx",
    summary: "BuildKit build history and the builders that run it.",
    gatesSidebar: false,
    install: {
      kind: "package",
      package: "docker-buildx-plugin",
      commands: {
        "apt-get": "sudo apt-get install docker-buildx-plugin",
        dnf: "sudo dnf install docker-buildx-plugin",
        pacman: "sudo pacman -S docker-buildx",
      },
      note: "Part of Docker's standard Engine installation, from the same repository as the Engine itself.",
    },
  },
  {
    view: "scan",
    label: "Scan",
    plugin: "scout",
    summary: "Docker Scout, which reports known vulnerabilities in an image.",
    gatesSidebar: false,
    install: {
      kind: "plugin-binary",
      note: "Docker publishes Scout as a standalone plugin binary as well as with Docker Desktop.",
    },
  },
]);

/**
 * Whether Anchorage can fetch this plugin itself, and under which key.
 *
 * Mirrors the core's compiled-in table, and is deliberately a short allowlist rather than a
 * property on the catalogue entry: the set of things the app will download must be legible in
 * one place, and adding a row to the catalogue must not silently make it installable.
 *
 * Compose and Buildx are absent on purpose. Both are distribution packages that need root, so
 * for those the command remains the only honest answer.
 */
const SELF_INSTALLABLE: Record<string, InstallableCapability> = {
  agent: "agent",
  mcp: "mcp",
};

export function installableCapability(
  plugin: string,
): InstallableCapability | null {
  return SELF_INSTALLABLE[plugin] ?? null;
}

export function capabilityForView(view: ViewId): PluginCapability | undefined {
  return capabilityCatalogue.find((capability) => capability.view === view);
}

export function capabilityForPlugin(
  plugin: string,
): PluginCapability | undefined {
  return capabilityCatalogue.find(
    (capability) => capability.plugin === plugin,
  );
}

/**
 * What the plugin report says about one capability.
 *
 * `unknown` is not `absent`. A report that could not be read — no host bridge, a failed call,
 * the browser preview — must not hide a row, because the operator may well have the plugin. The
 * gate below only ever acts on a definite "there is no such entry".
 */
export type CapabilityState =
  | "unknown"
  | "installed"
  | "broken"
  | "not-loaded"
  | "absent";

export function capabilityState(
  report: SystemPlugins | null,
  plugin: string,
): CapabilityState {
  if (!report) return "unknown";
  const entry = report.plugins.find((candidate) => candidate.name === plugin);
  if (!entry) return "absent";
  switch (entry.status) {
    case "available":
      return "installed";
    case "broken":
      return "broken";
    case "degraded":
      return "not-loaded";
    case "unavailable":
      return "absent";
    default:
      return "unknown";
  }
}

export function capabilityEntry(
  report: SystemPlugins | null,
  plugin: string,
): DockerCliPlugin | undefined {
  return report?.plugins.find((candidate) => candidate.name === plugin);
}

/**
 * Whether a destination's row belongs in the sidebar.
 *
 * Only a capability that gates its row, whose plugin the report definitely does not list, and
 * which the operator has not asked to keep, is hidden. Everything else — including a faulty
 * install, which is the case worth walking into — stays.
 */
export function isViewVisible(
  view: ViewId,
  report: SystemPlugins | null,
  revealed: readonly ViewId[],
): boolean {
  const capability = capabilityForView(view);
  if (!capability || !capability.gatesSidebar) return true;
  // The report is consulted before the preference, so a row is only ever measured against what
  // the operator asked for once there is a definite reason to hide it. Anything short of "the
  // CLI does not list this plugin" — including an unread report — keeps the row.
  if (capabilityState(report, capability.plugin) !== "absent") return true;
  return revealed.includes(view);
}

/* ── Which hidden destinations the operator asked to see ──────────────────────────────────── */

export const CAPABILITY_STORAGE_KEY = "anchorage.capabilities.v1";

export interface CapabilityPreference {
  /** Destinations kept in the sidebar even though their plugin is not installed. */
  revealed: ViewId[];
}

export interface CapabilityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CapabilityRuntimeOptions {
  storage?: CapabilityStorage | null;
  search?: string;
}

export const DEFAULT_CAPABILITY_PREFERENCE: CapabilityPreference =
  Object.freeze({
    revealed: [],
  }) as CapabilityPreference;

const GATED_VIEWS: ReadonlySet<string> = new Set(
  capabilityCatalogue
    .filter((capability) => capability.gatesSidebar)
    .map((capability) => capability.view),
);

/**
 * Pure so the migration and the discard rules are testable without a browser.
 *
 * A stored view that is no longer gated is dropped rather than carried: it would be a permanent
 * no-op, and keeping it would let a stale preference outlive the reason it was made.
 */
export function resolveCapabilityPreference(
  serialized: string | null,
): CapabilityPreference {
  if (!serialized) return { revealed: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return { revealed: [] };
  }
  if (typeof parsed !== "object" || parsed === null) return { revealed: [] };
  const raw = (parsed as { revealed?: unknown }).revealed;
  if (!Array.isArray(raw)) return { revealed: [] };
  const revealed = raw.filter(
    (entry): entry is ViewId => typeof entry === "string" && GATED_VIEWS.has(entry),
  );
  return { revealed: [...new Set(revealed)] };
}

function browserStorage(): CapabilityStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

/**
 * `?capture` reads and writes nothing, for the same reason the appearance preference ignores it:
 * a design-parity fixture has to render the same sidebar on every machine, and one developer's
 * revealed rows would otherwise change the frame.
 */
function isCaptureRequest(search: string): boolean {
  return new URLSearchParams(search).has("capture");
}

export function readCapabilityPreference(
  options: CapabilityRuntimeOptions = {},
): CapabilityPreference {
  const search = options.search ?? browserSearch();
  if (isCaptureRequest(search)) return { revealed: [] };
  const storage =
    options.storage === undefined ? browserStorage() : options.storage;
  if (!storage) return { revealed: [] };
  try {
    return resolveCapabilityPreference(storage.getItem(CAPABILITY_STORAGE_KEY));
  } catch {
    return { revealed: [] };
  }
}

/** Returns whether the write landed, rather than throwing, exactly as appearance does. */
export function persistCapabilityPreference(
  preference: CapabilityPreference,
  options: CapabilityRuntimeOptions = {},
): boolean {
  const search = options.search ?? browserSearch();
  if (isCaptureRequest(search)) return false;
  const storage =
    options.storage === undefined ? browserStorage() : options.storage;
  if (!storage) return false;
  try {
    storage.setItem(CAPABILITY_STORAGE_KEY, JSON.stringify(preference));
    return true;
  } catch {
    return false;
  }
}

/**
 * The one install command that applies to this machine.
 *
 * Returns null rather than a fallback. Printing an apt line on an Arch host is worse than
 * printing nothing: it looks authoritative, fails, and sends the operator looking for the fault
 * in their own setup. Where the host is unknown or the capability has no packaged route, the
 * surface says so and falls back to the plugin-directory mechanics, which are true everywhere.
 */
export function installCommandFor(
  capability: PluginCapability,
  manager: HostPackageManager | null | undefined,
): { command: string; thirdParty: boolean } | null {
  const commands = capability.install.commands;
  if (!commands || !manager) return null;
  // An AUR recipe needs a helper; pacman alone cannot install one, so it is only offered when a
  // helper is actually present and is rendered with the helper the host has.
  if (manager.name === "pacman") {
    if (commands.pacman) {
      return { command: commands.pacman, thirdParty: false };
    }
    if (commands.aur && manager.helper) {
      return {
        command: commands.aur.replace(/^(paru|yay)\b/u, manager.helper),
        thirdParty: true,
      };
    }
    return null;
  }
  const command = commands[manager.name];
  return command
    ? { command, thirdParty: capability.install.thirdParty === true }
    : null;
}
