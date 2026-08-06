// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentsScreen } from "./AgentsScreen";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { AgentsListResult } from "../types";

afterEach(cleanup);

// Shaped from a real `agents.list` against docker-agent v1.122.0 on the reference host.
const REPORT: AgentsListResult = {
  protocolVersion: "1",
  context: "default",
  models: [{ provider: "dmr", model: "ai/qwen3:latest", default: true }],
  toolsets: [
    { type: "shell", summary: "Execute shell commands in the user's environment" },
    { type: "filesystem", summary: "Read, write, list, search, and navigate files" },
  ],
  providers: [
    { provider: "anthropic", credentials: ["ANTHROPIC_API_KEY"], configured: false },
    { provider: "openai", credentials: ["OPENAI_API_KEY"], configured: true },
  ],
  configPath: "/home/operator/.config/cagent/config.yaml",
  configStatus: "ok",
  telemetryDisabled: true,
  observedAt: "2026-08-06T12:00:00.000Z",
};

function createStore(overrides: Partial<AnchorageStore> = {}): AnchorageStore {
  return {
    isHost: true,
    agentReport: REPORT,
    agentsStatus: "ready",
    agentsError: null,
    refreshAgents: vi.fn(async () => undefined),
    // Model Runner's own inventory, which the empty-model message needs in order to say which
    // of two very different problems the operator has.
    models: [],
    refreshModels: vi.fn(async () => undefined),
    openCommandCenter: vi.fn(),
    ...overrides,
  } as unknown as AnchorageStore;
}

describe("AgentsScreen", () => {
  it("reads the machine on arrival", () => {
    const store = createStore();
    render(<AgentsScreen store={store} />);
    expect(store.refreshAgents).toHaveBeenCalled();
  });

  it("leads with the model, because an agent with none cannot run", () => {
    render(<AgentsScreen store={createStore()} />);
    const models = screen.getByTestId("agent-models");
    expect(models).toHaveTextContent("dmr");
    expect(models).toHaveTextContent("ai/qwen3:latest");
    expect(models).toHaveTextContent("default");
  });

  it("says a missing model is a missing provider, not a broken install", () => {
    render(
      <AgentsScreen store={createStore({ agentReport: { ...REPORT, models: [] } })} />,
    );
    const empty = screen.getByTestId("agents-no-models");
    // The two routes to a model, both actionable. "No models" on its own would read as a fault.
    expect(empty).toHaveTextContent(/Model Runner has nothing pulled/u);
    expect(empty).toHaveTextContent(/API key/u);
  });

  it("distinguishes nothing pulled from pulled but unreachable", () => {
    /*
     * Reported as "i cannot see anything in the agents page, despite me pulling a model". The
     * old copy described both possibilities in one sentence — pull a model, or set an API key —
     * which is exactly no help to someone who has already pulled one. The two states need
     * opposite actions, so the screen has to know which it is looking at, and it can: the
     * Models screen reads the same machine.
     */
    render(
      <AgentsScreen
        store={createStore({
          agentReport: { ...REPORT, models: [] },
          models: [
            {
              id: "sha256:abc",
              tags: ["ai/qwen3:latest"],
              reference: "ai/qwen3:latest",
            },
          ],
        })}
      />,
    );
    const empty = screen.getByTestId("agents-no-models");
    expect(empty).toHaveTextContent(/Model Runner has 1 model pulled/u);
    expect(empty).toHaveTextContent(/ai\/qwen3:latest/u);
    expect(empty).toHaveTextContent(/not a missing model/u);
    // Telling someone who has a model to go and pull one is the failure this replaces.
    expect(empty).not.toHaveTextContent(/nothing pulled/u);
  });

  it("scopes the credential claim to the process rather than the machine", () => {
    // The defect this prevents is a confident lie: Docker Agent reads credentials from the
    // environment, so a key exported in a shell profile is invisible to an app launched from a
    // desktop entry. Reporting that as "not set" would send someone to fix a working key.
    render(<AgentsScreen store={createStore()} />);
    const providers = screen.getByTestId("agent-providers");
    expect(providers).toHaveTextContent("openai");
    // Only the configured one is listed; twenty unconfigured rows would bury it.
    expect(providers).not.toHaveTextContent("anthropic");
    expect(screen.getByText(/was launched with/u)).toBeInTheDocument();
  });

  it("presents toolsets as capabilities rather than features", () => {
    render(<AgentsScreen store={createStore()} />);
    const toolsets = screen.getByTestId("agent-toolsets");
    expect(toolsets).toHaveTextContent("shell");
    expect(toolsets).toHaveTextContent("filesystem");
    expect(screen.getByText(/runs commands as you/u)).toBeInTheDocument();
  });

  it("states that it disabled telemetry, and how far that reaches", () => {
    // Anchorage turned something off on the operator's behalf. That is worth saying, and so is
    // the limit: their own terminal still reports.
    render(<AgentsScreen store={createStore()} />);
    const footer = screen.getByTestId("agents-footer");
    expect(footer).toHaveTextContent("TELEMETRY_ENABLED=false");
    expect(footer).toHaveTextContent(/yourself is unaffected/u);
  });

  it("does not claim telemetry is off when the core did not say so", () => {
    render(
      <AgentsScreen
        store={createStore({
          agentReport: { ...REPORT, telemetryDisabled: false },
        })}
      />,
    );
    expect(screen.getByTestId("agents-footer")).not.toHaveTextContent(
      "TELEMETRY_ENABLED",
    );
  });

  it("falls back to the install surface when the plugin is absent", () => {
    render(
      <AgentsScreen
        store={createStore({
          agentsStatus: "unavailable",
          agentReport: null,
          pluginReport: null,
        })}
      />,
    );
    expect(screen.getByTestId("agents-screen")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-models")).toBeNull();
  });

  it("states what an agent's instructions do not bound", () => {
    render(<AgentsScreen store={createStore()} />);
    expect(screen.getByTestId("agents-screen-posture")).toHaveTextContent(
      /not a boundary/u,
    );
  });
});
