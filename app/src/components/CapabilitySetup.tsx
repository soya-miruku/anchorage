import { useState } from "react";

import { AnchorageIcon } from "./AnchorageIcon";
import {
  PLUGIN_DIRECTORY_MECHANICS,
  capabilityEntry,
  capabilityState,
  type CapabilityState,
  type PluginCapability,
} from "../data/capabilities";
import type { AnchorageStore } from "../store/useAnchorageStore";
import { usePluginRepair } from "./usePluginRepair";

/**
 * What to do about a capability this machine does not have.
 *
 * The five plugin-backed destinations used to state their plugin's absence in fixed copy and
 * offer one button, which opened the Command Center. Nothing on the screen could tell whether
 * the plugin was missing or broken, clear a faulty entry, or look again after an install — so
 * on a host with two dangling symlinks left by a removed Docker Desktop, the advice ("install
 * this") was the one thing that would not have helped.
 *
 * This replaces that with the three things an operator can actually act on:
 *
 *   - what state the plugin is in, read from the installation rather than asserted;
 *   - the repair, when the fault is one that can be repaired here — a link with no target
 *     removed, a missing execute bit set;
 *   - the install, as guidance. Anchorage cannot perform it: the core has no HTTP client,
 *     Electron blocks every download, and no request can execute anything but the fingerprinted
 *     Docker CLI. So it gives the exact command where Docker publishes one, the directory
 *     mechanics where it does not, and a re-check that notices the moment the plugin lands.
 */

const STATE_LABEL: Record<CapabilityState, string> = {
  unknown: "Not checked",
  installed: "Installed",
  broken: "Broken",
  "not-loaded": "Not loaded",
  absent: "Not installed",
};

/** Neutral for unknown, success for installed, danger for a fault, warning for the rest. */
const STATE_TONE: Record<CapabilityState, string> = {
  unknown: "neutral",
  installed: "success",
  broken: "danger",
  "not-loaded": "warning",
  absent: "neutral",
};

export function CapabilityStatusChip({ state }: { state: CapabilityState }) {
  return (
    <span
      className={`capability-chip capability-chip--${STATE_TONE[state]}`}
      data-testid={`capability-state-${state}`}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="capability-command">
      <code>{command}</code>
      <button
        type="button"
        className="ghost-button capability-command__copy"
        onClick={() => {
          void navigator.clipboard
            .writeText(command)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * The repairs available for a fault, if any.
 *
 * Which repair applies, whether one is in flight, and what removal costs come from
 * usePluginRepair, shared with the Settings plugin list. What is local here is the prominence:
 * this is the whole point of the screen rather than one row in a list, so the fault leads with
 * its own panel, the path and the core's diagnosis are shown in full, and making a plugin
 * executable is the primary action rather than a ghost button.
 */
function PluginRepairActions({
  store,
  capability,
}: {
  store: AnchorageStore;
  capability: PluginCapability;
}) {
  const entry = capabilityEntry(store.pluginReport, capability.plugin);
  const repair = usePluginRepair(store, entry);
  if (repair.path === null) return null;
  const state = capabilityState(store.pluginReport, capability.plugin);
  if (state !== "broken" && state !== "not-loaded") return null;

  return (
    <div className="capability-repair" data-testid={`capability-repair-${capability.plugin}`}>
      <p className="capability-repair__path resource-mono">{repair.path}</p>
      {entry?.availabilityNote && (
        <p className="capability-repair__reason">{entry.availabilityNote}</p>
      )}
      {repair.confirming ? (
        <div className="capability-repair__confirm" role="group">
          <p>{repair.removalConsequence}</p>
          <div className="capability-repair__actions">
            <button type="button" className="ghost-button" onClick={repair.cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-button primary-button--danger"
              disabled={repair.busy}
              data-testid={`capability-remove-confirm-${capability.plugin}`}
              onClick={repair.confirmRemove}
            >
              {repair.busy ? "Removing…" : "Remove entry"}
            </button>
          </div>
        </div>
      ) : (
        <div className="capability-repair__actions">
          {repair.canEnable && (
            <button
              type="button"
              className="primary-button"
              disabled={repair.busy}
              data-testid={`capability-enable-${capability.plugin}`}
              onClick={repair.enable}
            >
              {repair.busy ? "Working…" : "Make executable"}
            </button>
          )}
          <button
            type="button"
            className="ghost-button ghost-button--danger"
            disabled={repair.busy}
            data-testid={`capability-remove-${capability.plugin}`}
            onClick={repair.arm}
          >
            Remove this entry
          </button>
        </div>
      )}
    </div>
  );
}

export function CapabilityInstallGuidance({
  store,
  capability,
}: {
  store: AnchorageStore;
  capability: PluginCapability;
}) {
  // The directory the CLI reads first, which is where a manually installed plugin belongs. Taken
  // from the report rather than assembled here: it honours DOCKER_CONFIG, which this cannot see.
  const pluginDirectory = store.pluginReport?.searchPath[0];
  return (
    <div className="capability-install">
      <h4>Installing it</h4>
      <p>{capability.install.note}</p>
      {capability.install.commands?.map((command) => (
        <CopyableCommand key={command} command={command} />
      ))}
      <p className="capability-install__mechanics">{PLUGIN_DIRECTORY_MECHANICS}</p>
      {pluginDirectory && (
        <p className="capability-install__directory">
          <code className="resource-mono">{pluginDirectory}</code>
          {/* Reveal, never open: the main process refuses shell.openPath. */}
          {store.bridge.desktop && (
            <button
              type="button"
              className="ghost-button"
              data-testid={`capability-reveal-${capability.plugin}`}
              onClick={() => void store.revealPath(pluginDirectory)}
            >
              Show in folder
            </button>
          )}
        </p>
      )}
    </div>
  );
}

export function CapabilitySetup({
  store,
  capability,
  testId,
  posture,
}: {
  store: AnchorageStore;
  capability: PluginCapability;
  testId: string;
  /** What the capability does not protect. Stated whether or not it is reachable here. */
  posture: string;
}) {
  const state = capabilityState(store.pluginReport, capability.plugin);

  return (
    <section className="screen capability-setup" data-testid={testId}>
      <header className="capability-setup__header">
        <div>
          <h1>{capability.label}</h1>
          <p className="capability-setup__summary">{capability.summary}</p>
        </div>
        <CapabilityStatusChip state={state} />
      </header>

      <p className="capability-setup__requires">
        Needs <code className="resource-mono">docker {capability.plugin}</code>
        {state === "installed" && (
          <>
            {" "}
            — which is installed here. What is missing is this screen, not the capability, so
            nothing below will make it work; <code>docker {capability.plugin}</code> is
            available through the Command Center meanwhile.
          </>
        )}
      </p>

      {/* Before every state-dependent branch below, deliberately: a posture that appeared only
          when a plugin happened to be installed would make the honesty a side effect of the
          installation. See screens/destinations.test.tsx. */}
      <p className="capability-setup__posture" data-testid={`${testId}-posture`}>
        {posture}
      </p>

      {state === "unknown" && (
        <p className="capability-setup__unknown" role="status">
          {store.isHost
            ? "The plugin directories have not been read yet, so nothing here is a claim about what is installed."
            : "Plugin state is read from the Docker CLI on the host, and the browser preview has none to ask."}
        </p>
      )}

      <PluginRepairActions store={store} capability={capability} />

      {(state === "absent" || state === "broken" || state === "not-loaded") && (
        <CapabilityInstallGuidance store={store} capability={capability} />
      )}

      <div className="capability-setup__actions">
        {store.isHost && (
          <button
            type="button"
            className="ghost-button"
            disabled={store.pluginReportStatus === "loading"}
            data-testid={`capability-recheck-${capability.plugin}`}
            onClick={() => void store.refreshPlugins()}
          >
            {store.pluginReportStatus === "loading" ? "Checking…" : "Re-check now"}
          </button>
        )}
        <button
          type="button"
          className="ghost-button"
          onClick={() => store.openCommandCenter(capability.plugin)}
        >
          <AnchorageIcon name="search" size={13} />
          <span>Open Command Center</span>
        </button>
        {/* Only for a row the operator revealed themselves: offering to hide a row that is
            visible on its own merits would strand the destination. The state test comes first
            so an unread report never reaches the preference. */}
        {state === "absent" &&
          store.revealedCapabilities.includes(capability.view) && (
            <button
              type="button"
              className="ghost-button"
              data-testid={`capability-hide-${capability.plugin}`}
              onClick={() => store.setCapabilityRevealed(capability.view, false)}
            >
              Hide from sidebar
            </button>
          )}
      </div>

      {store.pluginReportError && (
        <p className="capability-error" role="status">
          {store.pluginReportError}
        </p>
      )}
    </section>
  );
}
