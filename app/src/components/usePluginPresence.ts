import type { AnchorageStore } from "../store/useAnchorageStore";
import type { SystemPlugins } from "../types";

/**
 * Whether the CLI plugin a destination is gated on is actually there.
 *
 * Five screens — Models, Agents, Tools, Sandboxes, Bosun — stated their plugin's absence as a
 * fact in static copy, so installing it changed nothing: the screen went on reporting it missing.
 * The core already walks the plugin directories and classifies what it finds; nothing on those
 * screens asked.
 *
 * The classification carries more than presence. `broken` is a faulty installation rather than an
 * unavailable capability — the reference host has nine dangling symlinks left behind by a removed
 * Docker Desktop — and "install the plugin" is precisely the wrong instruction for those. Docker
 * makes this easy to get wrong in the other direction too: `docker <name> --version` exits 0 for
 * a name that does not exist, answering with the base CLI's own version, so presence can only be
 * read from the plugin report and never from probing a command.
 */

export type PluginPresence =
  | { kind: "unknown"; detail?: string }
  | { kind: "present"; detail?: string }
  | { kind: "degraded"; detail?: string }
  | { kind: "broken"; detail?: string }
  | { kind: "absent"; detail?: string };

/** Pure so the wording is testable without a daemon. */
export function describePluginPresence(
  report: SystemPlugins | null,
  pluginName: string,
): PluginPresence {
  if (!report) return { kind: "unknown" };
  const entry = report.plugins.find((plugin) => plugin.name === pluginName);
  if (!entry) return { kind: "absent" };

  const note = entry.availabilityNote?.trim();
  switch (entry.status) {
    case "available":
      return {
        kind: "present",
        detail: entry.version ? `version ${entry.version}` : note,
      };
    case "degraded":
      return {
        kind: "degraded",
        detail: note ?? "Docker found it but would not run it.",
      };
    case "broken":
      return {
        kind: "broken",
        detail: note ?? "The installation is faulty rather than missing.",
      };
    case "unavailable":
      return { kind: "absent", detail: note };
    default:
      return { kind: "unknown", detail: note };
  }
}

/**
 * Reads the plugin report for one plugin.
 *
 * This used to fetch per screen, on the reasoning that a rarely-visited destination should not
 * show a stale answer. The report now lives in the store instead, for two reasons the per-screen
 * fetch could not serve: the sidebar decides which rows exist from it, so it must be readable
 * during any render; and a repair carried out on one surface has to be reflected on all of them
 * at once — clearing a dangling `docker-mcp` in Settings must make the Tools row disappear
 * without a reload. Staleness is handled by making the re-read explicit and cheap instead: every
 * capability surface offers it, and `store.refreshPlugins` is a directory scan and one
 * `docker info`.
 */
export function usePluginPresence(
  store: AnchorageStore,
  pluginName: string,
): PluginPresence {
  return describePluginPresence(store.pluginReport, pluginName);
}
