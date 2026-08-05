import { useEffect, useState } from "react";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { DockerCliPlugin, SystemPlugins } from "../types";

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
 */

const BROKEN: DockerCliPlugin["status"][] = ["broken", "degraded"];

function isBroken(plugin: DockerCliPlugin) {
  return BROKEN.includes(plugin.status);
}

export function CliPluginHealth({ store }: { store: AnchorageStore }) {
  const [report, setReport] = useState<SystemPlugins | null>(null);
  const [error, setError] = useState<string | null>(null);
  const context = store.dockerContext;

  useEffect(() => {
    let active = true;
    setReport(null);
    setError(null);
    void store.bridge.system
      .plugins(context)
      .then((value) => {
        if (active) setReport(value);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Plugin inspection failed");
      });
    return () => {
      active = false;
    };
  }, [store.bridge, context]);

  if (error) {
    return (
      <section className="plugin-health" data-testid="plugin-health">
        <h3>CLI plugins</h3>
        <p className="plugin-health__note" role="status">
          Could not read the plugin directories: {error}
        </p>
      </section>
    );
  }

  if (!report) {
    return (
      <section className="plugin-health" data-testid="plugin-health">
        <h3>CLI plugins</h3>
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
      <h3>CLI plugins</h3>
      <p className="plugin-health__note">
        {loaded.length} loaded by the Docker CLI
        {faults.length > 0
          ? `, ${faults.length} present but not loaded`
          : ". Nothing in the plugin directories is being ignored."}
      </p>

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
