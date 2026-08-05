import { useState } from "react";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { DockerCliPlugin } from "../types";

/**
 * What the Docker CLI found in its plugin directories, and what it refused to load.
 *
 * `docker info` lists the plugins that loaded and says nothing about the rest, so a plugin
 * that is present but unusable is invisible from the CLI: `docker mcp` prints the root help
 * exactly as it would for a typo. The most common cause on Linux is an uninstalled Docker
 * Desktop leaving symlinks behind that point at files the package manager removed.
 *
 * Anchorage can see this because it reads the directories itself rather than only asking the
 * CLI, which is the same reason it can report anything else the CLI is quiet about.
 *
 * It can now also do something about it. Every fault the core reports names its own remedy —
 * "Deleting the link is safe; the plugin is already gone", "`chmod +x` makes it available" — and
 * this pane used to print that advice and leave the operator to go and carry it out. Those two
 * remedies are the buttons below. Neither installs anything; see data/capabilities.ts for why
 * that is a property of the architecture rather than a gap.
 */

const BROKEN: DockerCliPlugin["status"][] = ["broken", "degraded"];

function isBroken(plugin: DockerCliPlugin) {
  return BROKEN.includes(plugin.status);
}

/**
 * The repair for one entry.
 *
 * Which one applies is decided from the fault the core named, not offered as a menu: a link with
 * no target cannot be made executable, and a file that merely lacks its execute bit should not be
 * deleted. Removal is confirmed in place rather than in a dialog — it deletes one file whose
 * target is already gone, and a modal for that would be heavier than the act.
 */
function FaultActions({
  store,
  plugin,
}: {
  store: AnchorageStore;
  plugin: DockerCliPlugin;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!plugin.path) return null;
  const path = plugin.path;
  const busy = store.pluginRepairPending === path;
  const missingExecuteBit = plugin.fault === "not-executable";

  if (confirming) {
    return (
      <div className="plugin-health__confirm" role="group">
        {/* What is actually being lost, which differs by fault. A dangling link points at
            nothing, so deleting it costs nothing; a file that is merely not executable is a
            real plugin, and removing it instead of fixing its permissions would lose it. */}
        <p>
          {plugin.fault === "dangling-link"
            ? "Delete this entry? The plugin it points at is already gone, so nothing stops working."
            : plugin.fault === "not-executable"
              ? "Delete this plugin? The file itself is here and would work once it is executable — removing it discards it instead."
              : "Delete this entry? The Docker CLI is not loading it, and nothing else on this machine reads it."}
        </p>
        <div className="plugin-health__actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary-button primary-button--danger"
            disabled={busy}
            data-testid={`plugin-remove-confirm-${plugin.name}`}
            onClick={() => {
              setConfirming(false);
              void store.repairPlugin({
                name: plugin.name,
                path,
                action: "remove",
                confirmed: true,
              });
            }}
          >
            {busy ? "Removing…" : "Remove entry"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="plugin-health__actions">
      {missingExecuteBit && (
        <button
          type="button"
          className="ghost-button"
          disabled={busy}
          data-testid={`plugin-enable-${plugin.name}`}
          onClick={() => {
            void store.repairPlugin({ name: plugin.name, path, action: "enable" });
          }}
        >
          {busy ? "Working…" : "Make executable"}
        </button>
      )}
      <button
        type="button"
        className="ghost-button ghost-button--danger"
        disabled={busy}
        data-testid={`plugin-remove-${plugin.name}`}
        onClick={() => setConfirming(true)}
      >
        Remove entry
      </button>
      {store.bridge.desktop && (
        <button
          type="button"
          className="ghost-button"
          data-testid={`plugin-reveal-${plugin.name}`}
          onClick={() => void store.revealPath(path)}
        >
          Show in folder
        </button>
      )}
    </div>
  );
}

function RecheckButton({ store }: { store: AnchorageStore }) {
  return (
    <button
      type="button"
      className="ghost-button"
      disabled={store.pluginReportStatus === "loading"}
      data-testid="plugin-health-recheck"
      onClick={() => void store.refreshPlugins()}
    >
      {store.pluginReportStatus === "loading" ? "Checking…" : "Re-check"}
    </button>
  );
}

export function CliPluginHealth({ store }: { store: AnchorageStore }) {
  // Read from the store rather than fetched here. The sidebar gates rows on this same report, so
  // a repair carried out in this pane has to reach it — removing a dangling `docker-mcp` makes
  // the Tools row disappear on the same render.
  const report = store.pluginReport;

  if (store.pluginReportError && !report) {
    return (
      <section className="plugin-health" data-testid="plugin-health">
        <div className="plugin-health__heading">
          <h3>CLI plugins</h3>
          <RecheckButton store={store} />
        </div>
        <p className="plugin-health__note" role="status">
          Could not read the plugin directories: {store.pluginReportError}
        </p>
      </section>
    );
  }

  if (!report) {
    return (
      <section className="plugin-health" data-testid="plugin-health">
        <div className="plugin-health__heading">
          <h3>CLI plugins</h3>
          {store.pluginReportStatus !== "loading" && <RecheckButton store={store} />}
        </div>
        <p className="plugin-health__note" role="status">
          Reading the plugin directories…
        </p>
      </section>
    );
  }

  const loaded = report.plugins.filter((plugin) => !isBroken(plugin));
  const faults = report.plugins.filter(isBroken);

  return (
    <section className="plugin-health" data-testid="plugin-health">
      <div className="plugin-health__heading">
        <h3>CLI plugins</h3>
        <RecheckButton store={store} />
      </div>
      <p className="plugin-health__note">
        {loaded.length} loaded by the Docker CLI
        {faults.length > 0
          ? `, ${faults.length} present but not loaded`
          : ". Nothing in the plugin directories is being ignored."}
      </p>

      {/* A repair that failed reports here rather than replacing the report: the entries are
          still worth reading, and the operator needs to know which act did not happen. */}
      {store.pluginReportError && (
        <p className="capability-error" role="status">
          {store.pluginReportError}
        </p>
      )}

      {faults.length > 0 && (
        <ul className="plugin-health__list" data-testid="plugin-health-faults">
          {faults.map((plugin) => (
            <li key={plugin.path ?? plugin.name} className="plugin-health__fault">
              <div className="plugin-health__head">
                <code>docker {plugin.name}</code>
                <span
                  className={`plugin-health__tag plugin-health__tag--${plugin.status}`}
                >
                  {plugin.status === "broken" ? "Broken" : "Not loaded"}
                </span>
              </div>
              {plugin.path && (
                <p className="plugin-health__path">{plugin.path}</p>
              )}
              {plugin.availabilityNote && (
                <p className="plugin-health__reason">{plugin.availabilityNote}</p>
              )}
              <FaultActions store={store} plugin={plugin} />
            </li>
          ))}
        </ul>
      )}

      {loaded.length > 0 && (
        <ul className="plugin-health__loaded" data-testid="plugin-health-loaded">
          {loaded.map((plugin) => (
            <li key={plugin.path ?? plugin.name}>
              <code>docker {plugin.name}</code>
              {plugin.version && <span>{plugin.version}</span>}
            </li>
          ))}
        </ul>
      )}

      <details className="plugin-health__search">
        <summary>Search path</summary>
        <ol>
          {report.searchPath.map((dir) => (
            <li key={dir}>
              <code>{dir}</code>
            </li>
          ))}
        </ol>
        <p className="plugin-health__note">
          Searched in this order. A plugin in an earlier directory shadows the same
          name in a later one, which the CLI does deliberately and Anchorage does not
          report as a fault.
        </p>
      </details>

      {report.warnings.map((warning) => (
        <p key={warning} className="plugin-health__note" role="status">
          {warning}
        </p>
      ))}
    </section>
  );
}
