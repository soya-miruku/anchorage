import type { AnchorageStore } from "../store/useAnchorageStore";
import { usePluginRepair } from "./usePluginRepair";
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
 * The repair for one entry, as a compact row inside its fault card.
 *
 * Which repair applies, whether one is in flight, and what removal costs all come from
 * usePluginRepair — the same judgement the capability setup screen uses. What is local here is
 * the shape: ghost buttons sized for a list, and a reveal that only the desktop shell can serve.
 */
function FaultActions({
  store,
  plugin,
}: {
  store: AnchorageStore;
  plugin: DockerCliPlugin;
}) {
  const repair = usePluginRepair(store, plugin);
  if (repair.path === null) return null;

  if (repair.confirming) {
    return (
      <div className="plugin-health__confirm" role="group">
        <p>{repair.removalConsequence}</p>
        <div className="plugin-health__actions">
          <button type="button" className="ghost-button" onClick={repair.cancel}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button primary-button--danger"
            disabled={repair.busy}
            data-testid={`plugin-remove-confirm-${plugin.name}`}
            onClick={repair.confirmRemove}
          >
            {repair.busy ? "Removing…" : "Remove entry"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="plugin-health__actions">
      {repair.canEnable && (
        <button
          type="button"
          className="ghost-button"
          disabled={repair.busy}
          data-testid={`plugin-enable-${plugin.name}`}
          onClick={repair.enable}
        >
          {repair.busy ? "Working…" : "Make executable"}
        </button>
      )}
      <button
        type="button"
        className="ghost-button ghost-button--danger"
        disabled={repair.busy}
        data-testid={`plugin-remove-${plugin.name}`}
        onClick={repair.arm}
      >
        Remove entry
      </button>
      {store.bridge.desktop && (
        <button
          type="button"
          className="ghost-button"
          data-testid={`plugin-reveal-${plugin.name}`}
          onClick={() => void store.revealPath(repair.path as string)}
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
