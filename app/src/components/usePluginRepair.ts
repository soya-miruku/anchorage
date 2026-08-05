import { useState } from "react";

import type { AnchorageStore } from "../store/useAnchorageStore";
import type { DockerCliPlugin } from "../types";

/**
 * The repair for one faulty plugin entry, without the chrome around it.
 *
 * Two surfaces offer these repairs — the Settings plugin list and each capability's own setup
 * screen — and they looked alike enough that both grew the same four decisions independently:
 * which repair applies, whether one is in flight, what removal actually costs, and how to ask.
 * That duplication was not cosmetic. The consequence sentence was wrong in one of them for a
 * whole revision: it told the operator "the plugin it points at is already gone" about a file
 * that was merely missing its execute bit, which is the one fault where removal loses something
 * real. One copy of that judgement is the point of this hook.
 *
 * What stays with each surface is presentation: the Settings list is a compact row of ghost
 * buttons inside a fault card, the setup screen is a prominent panel with a primary action. Those
 * are different on purpose, and folding them into one component behind a `variant` flag would
 * trade a real duplication for a worse one.
 */

export interface PluginRepairController {
  /**
   * The entry's path, narrowed to a string. `null` when there is nothing to repair, so a caller
   * can return early — after calling the hook, never instead of calling it.
   */
  path: string | null;
  /** Whether the removal confirmation is showing. */
  confirming: boolean;
  /** Whether this entry's repair is in flight. */
  busy: boolean;
  /**
   * Whether `enable` applies at all. Only a file that exists and lacks its execute bit can be
   * repaired that way; a link with no target has nothing to make executable.
   */
  canEnable: boolean;
  /**
   * What removing this entry costs, in the operator's terms. Differs by fault, which is why it
   * lives here rather than being written out at each call site.
   */
  removalConsequence: string;
  arm: () => void;
  cancel: () => void;
  confirmRemove: () => void;
  enable: () => void;
}

/**
 * Decided from the fault the core named rather than from its wording. `availabilityNote` is for
 * the operator and is free to be reworded; this is a branch, and matching a branch against English
 * prose breaks silently the day the prose improves.
 */
function describeRemoval(fault: DockerCliPlugin["fault"]): string {
  switch (fault) {
    case "dangling-link":
      return "Delete this entry? The plugin it points at is already gone, so nothing stops working.";
    case "not-executable":
      return "Delete this plugin? The file itself is here and would work once it is executable — removing it discards it instead.";
    default:
      return "Delete this entry? The Docker CLI is not loading it, and nothing else on this machine reads it.";
  }
}

export function usePluginRepair(
  store: AnchorageStore,
  plugin: DockerCliPlugin | undefined,
): PluginRepairController {
  // Unconditional, because a hook must be. Callers narrow on `path` afterwards.
  const [confirming, setConfirming] = useState(false);
  const path = plugin?.path ?? null;
  const name = plugin?.name ?? "";

  return {
    path,
    confirming,
    busy: path !== null && store.pluginRepairPending === path,
    canEnable: plugin?.fault === "not-executable",
    removalConsequence: describeRemoval(plugin?.fault),
    arm: () => setConfirming(true),
    cancel: () => setConfirming(false),
    confirmRemove: () => {
      if (path === null) return;
      // Closed before the call, not after it: leaving the confirmation open while the removal
      // runs invites a second click on a path that is already gone.
      setConfirming(false);
      void store.repairPlugin({ name, path, action: "remove", confirmed: true });
    },
    enable: () => {
      if (path === null) return;
      // No confirmation: this adds a permission bit to a file that is already present, and the
      // core refuses the flag for this action so agreeing to it cannot mean agreeing to a delete.
      void store.repairPlugin({ name, path, action: "enable" });
    },
  };
}
