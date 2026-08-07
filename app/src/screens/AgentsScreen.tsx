import { useEffect } from "react";

import { CapabilitySetup } from "../components/CapabilitySetup";
import { ModelChat } from "../components/ModelChat";
import { UnsupportedSurface } from "../components/UnsupportedSurface";
import { capabilityForView } from "../data/capabilities";
import type { AnchorageStore } from "../store/useAnchorageStore";

/**
 * Docker Agent, and a model you can actually talk to.
 *
 * Two different things, deliberately, because they answer different questions.
 *
 * The chat is a model Model Runner already has, answering about the engine in front of you,
 * with a read-only tool catalogue it can use to look before it answers. That is the thing this
 * screen previously could not do and the reason it read as empty: an operator who had just
 * pulled a model arrived expecting to use it and found a readiness report.
 *
 * Everything below the chat is still that readiness report, and it is not redundant. It is
 * about `docker agent run` — a separate, interactive terminal application driven by a YAML
 * file, which is not reimplemented here and would be a poor thing to reimplement, since it
 * changes weekly and there is no list of "your agents" to show. What a GUI is genuinely better
 * at there is the setup question: can this machine run one at all, what would it think with,
 * what could it be granted, which credentials are visible.
 */

const POSTURE =
  "An agent's instructions describe intent, not a boundary. What it can actually reach is the tools and credentials granted to it and the sandbox it runs in — a system prompt telling it to be careful is not one of those. Every toolset below is a capability an agent configuration can hand over, and `shell` is the whole machine.";

export function AgentsScreen({ store }: { store: AnchorageStore }) {
  const capability = capabilityForView("agents");
  if (!capability) {
    throw new Error("agents is missing from the capability catalogue");
  }

  const {
    isHost,
    agentReport,
    agentsStatus,
    agentsError,
    refreshAgents,
    refreshModels,
  } = store;

  useEffect(() => {
    if (!isHost) return;
    void refreshAgents();
    // Model Runner is read too, and only so that "no model provider is reachable" can tell the
    // two cases apart. They need completely different actions: pull something, or point the
    // agent at what is already pulled. Reported as "i cannot see anything in the agents page,
    // despite me pulling a model" — a sentence the old copy could not have answered either way.
    void refreshModels();
  }, [isHost, refreshAgents, refreshModels]);

  if (!isHost) {
    return (
      <UnsupportedSurface
        testId="agents-screen"
        title="Agents"
        description="Docker Agent reads configuration from a live machine. The browser preview uses deterministic fixtures and never runs the CLI."
        posture={POSTURE}
        commandQuery="agent"
        onOpenCommand={store.openCommandCenter}
      />
    );
  }

  // Nothing to report until the plugin exists, so the screen becomes the install surface —
  // which, for this capability, can now do the install rather than only describe it.
  if (agentsStatus === "unavailable") {
    return (
      <CapabilitySetup
        store={store}
        capability={capability}
        testId="agents-screen"
        posture={POSTURE}
      />
    );
  }

  const configured = agentReport?.providers.filter((entry) => entry.configured) ?? [];
  const models = agentReport?.models ?? [];

  return (
    <section className="agents-screen screen" data-testid="agents-screen">
      <header className="agents-header">
        <div>
          <h1>Agents</h1>
          <p>
            Docker Agent runs agents defined in a YAML file. Anchorage reports what
            this machine can run them with; <code>docker agent run</code> is an
            interactive terminal application and stays in the terminal.
          </p>
        </div>
        <button
          type="button"
          className="ghost-button"
          onClick={() => void refreshAgents()}
          disabled={agentsStatus === "loading"}
        >
          {agentsStatus === "loading" ? "Reading…" : "Re-check"}
        </button>
      </header>

      <p className="agents-posture" data-testid="agents-screen-posture">
        {POSTURE}
      </p>

      {agentsError && (
        <div className="compose-notice" role="alert" data-testid="agents-error">
          {agentsError}
        </div>
      )}

      {/*
        Chat first, because it is the only thing on this screen that does something.
        Everything below it answers "could this machine run an agent" — a real question, and
        the one this screen was built for, but not one you can act on here. This is a model
        that is already pulled, answering about the engine in front of you.
      */}
      <section className="agents-block">
        <h2>Ask a local model about this engine</h2>
        <p className="agents-block__lede">
          A model pulled by Model Runner, answering here rather than in a terminal. Give
          it the read-only engine tools and it can look before it answers — the whole
          transcript, including what each tool returned, is on screen.
        </p>
        <ModelChat store={store} />
      </section>

      {/*
        Models first, because it is the question that decides whether anything else matters:
        an agent with no model to think with cannot run, whatever tools it has.
      */}
      <section className="agents-block">
        <h2>What it can think with</h2>
        {models.length === 0 ? (
          <p className="models-empty" data-testid="agents-no-models">
            No model provider is reachable.{" "}
            {/*
              Two different problems wearing one sentence. With nothing pulled, the answer is to
              pull something; with models pulled that the agent cannot see, pulling more will not
              help and the fault is in the agent's own provider configuration. The Models screen
              already knows which it is, so say it rather than describing both possibilities and
              leaving the operator to work out which one they are in.
            */}
            {store.models.length > 0 ? (
              <>
                Model Runner has {store.models.length} model
                {store.models.length === 1 ? "" : "s"} pulled —{" "}
                <code className="resource-mono">{store.models[0]?.reference}</code>
                {store.models.length > 1 ? " and others" : ""} — so this is not a missing
                model. Docker Agent reads its providers from its own configuration; run{" "}
                <code>docker agent doctor</code> to see which ones it is looking for.
              </>
            ) : (
              <>
                Model Runner has nothing pulled either, so there is genuinely nothing to think
                with yet. Pull a model on the Models screen, or set a hosted provider&rsquo;s
                API key in the environment Anchorage was started from.
              </>
            )}
          </p>
        ) : (
          <ul className="agent-models" data-testid="agent-models">
            {models.map((entry) => (
              <li key={`${entry.provider}/${entry.model}`}>
                <span className="agent-models__provider">{entry.provider}</span>
                <span className="agent-models__model">{entry.model}</span>
                {entry.default && (
                  <span className="agent-models__default">default</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        Credentials are read from environment variables, so this is a statement about the
        process rather than about the machine — and saying "not set" would be wrong for anyone
        who exported a key in a shell profile and launched Anchorage from a desktop entry.
      */}
      <section className="agents-block">
        <h2>Credentials visible here</h2>
        <p className="agents-block__note">
          Docker Agent reads these from environment variables, so this reflects the
          environment <strong>Anchorage</strong> was launched with — not your shell
          profile. A key exported in <code>.bashrc</code> is invisible to an app
          started from a desktop entry.
        </p>
        {configured.length === 0 ? (
          <p className="models-empty" data-testid="agents-no-credentials">
            No provider credential is visible from here.{" "}
            {agentReport?.providers.length ?? 0} providers are supported.
          </p>
        ) : (
          <ul className="agent-providers" data-testid="agent-providers">
            {configured.map((entry) => (
              <li key={entry.provider}>
                <span className="agent-providers__name">{entry.provider}</span>
                <code>{entry.credentials.join(", ")}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      {agentReport && agentReport.toolsets.length > 0 && (
        <section className="agents-block">
          <h2>What an agent can be granted</h2>
          <p className="agents-block__note">
            These are the tool types a configuration can enable. They are
            capabilities, not suggestions — an agent granted <code>shell</code> runs
            commands as you.
          </p>
          <ul className="agent-toolsets" data-testid="agent-toolsets">
            {agentReport.toolsets.map((toolset) => (
              <li key={toolset.type}>
                <span className="agent-toolsets__type">{toolset.type}</span>
                <span className="agent-toolsets__summary">{toolset.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {agentReport && (
        <footer className="agents-footer" data-testid="agents-footer">
          {agentReport.configPath && (
            <p>
              Configuration{" "}
              <code className="resource-mono">{agentReport.configPath}</code>
              {agentReport.configStatus ? ` · ${agentReport.configStatus}` : ""}
            </p>
          )}
          {/*
            Stated because it is a thing Anchorage did on the operator's behalf, and because it
            is bounded: it applies to these reads, not to the operator's own terminal.
          */}
          {agentReport.telemetryDisabled && (
            <p className="agents-footer__telemetry">
              Docker Agent reports anonymous usage data by default. Anchorage sets{" "}
              <code>TELEMETRY_ENABLED=false</code> for the reads on this screen;
              running <code>docker agent</code> yourself is unaffected.
            </p>
          )}
        </footer>
      )}
    </section>
  );
}
