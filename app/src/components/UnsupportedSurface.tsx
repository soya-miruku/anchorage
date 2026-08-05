import type { PluginPresence } from "./usePluginPresence";
import { PlugsIcon } from "@phosphor-icons/react";

export function UnsupportedSurface({
  testId,
  title,
  description,
  posture,
  commandQuery,
  onOpenCommand,
  plugin,
}: {
  testId: string;
  title: string;
  description: string;
  /**
   * What this capability would and would not protect, stated whether or not it is reachable
   * here. A sandbox protects the host from the agent, not the agent from itself; scanning
   * finds known vulnerabilities, not unknown ones. Saying so only when the feature happens
   * to be installed would make the honesty a side effect of the installation.
   */
  posture?: string;
  /**
   * A `docker` subcommand to open the palette on, or "" when this surface has no command of
   * its own. The button says which of the two it is, because an empty query opens the whole
   * inventory: that is a browse, and labelling it as a route promises a destination the
   * screen does not have.
   */
  commandQuery: string;
  onOpenCommand: (query: string) => void;
  /**
   * What the plugin this destination is gated on is actually doing, when it is gated on one.
   *
   * Without it the surface asserts absence it never checked: these screens went on reporting a
   * plugin missing after it had been installed. A faulty installation is reported as faulty
   * rather than missing, because "install the plugin" is the wrong instruction for a dangling
   * symlink — which is what nine of them are on the reference host.
   */
  plugin?: { name: string; presence: PluginPresence };
}) {
  const presence = plugin?.presence;
  return (
    <section className="screen unsupported-surface" data-testid={testId}>
      <header className="screen-header">
        <div>
          <h1>{title}</h1>
          <p>Live Docker capability unavailable</p>
        </div>
      </header>
      {/*
        Deliberately not a live region. Each destination is its own component, so this block
        is mounted together with its text rather than changed in place; the `role="status"`
        that used to sit here could only ever announce the headline, every paragraph and the
        button as one atomic string. The <h2> is what a screen reader navigates by instead.
      */}
      <div className="unsupported-surface__content">
        <span className="unsupported-surface__icon">
          <PlugsIcon aria-hidden="true" size={24} weight="light" />
        </span>
        <h2>
          {presence?.kind === "present"
            ? `${title} is not built yet`
            : `${title} is unavailable in this build`}
        </h2>
        {plugin && presence && presence.kind !== "unknown" && (
          <p
            className={
              presence.kind === "broken"
                ? "capability-error"
                : "unsupported-surface__plugin"
            }
            data-testid={`${testId}-plugin-state`}
          >
            {presence.kind === "present" && (
              <>
                <strong>docker {plugin.name} is installed here</strong>
                {presence.detail ? ` (${presence.detail}).` : "."} What is missing is the
                screen, not the capability.
              </>
            )}
            {presence.kind === "degraded" && (
              <>
                <strong>docker {plugin.name} is installed but Docker will not run it.</strong>{" "}
                {presence.detail}
              </>
            )}
            {presence.kind === "broken" && (
              <>
                <strong>docker {plugin.name} is installed and broken.</strong>{" "}
                {presence.detail} Installing it again will not help; the existing entry has to
                go first.
              </>
            )}
            {presence.kind === "absent" && (
              <>
                Checked on this host: <strong>docker {plugin.name} is not installed.</strong>
              </>
            )}
          </p>
        )}
        <p>{description}</p>
        {/*
          Scoped to Anchorage rather than to the host: some of these gaps are a Docker feature
          this installation does not expose, others are a view Anchorage has not built, and in
          browser preview there is no host being reported on at all. All three are true of
          what this build can reach.
        */}
        <p>
          This reports what this Anchorage build can reach, not that the
          capability does not exist.
        </p>
        <p>No fixture or simulated data is shown in packaged host mode.</p>
        {posture && (
          <p
            className="unsupported-surface__posture"
            data-testid={`${testId}-posture`}
          >
            {posture}
          </p>
        )}
        <button
          className="primary-button unsupported-surface__action"
          type="button"
          onClick={() => onOpenCommand(commandQuery)}
        >
          {commandQuery ? "Open Command Center" : "Browse installed commands"}
        </button>
      </div>
    </section>
  );
}
