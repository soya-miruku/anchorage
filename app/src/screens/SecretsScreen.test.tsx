// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretsScreen } from "./SecretsScreen";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { SecretSummary, SwarmSurface } from "../types";

afterEach(cleanup);

const secret = (overrides: Partial<SecretSummary> = {}): SecretSummary => ({
  id: "aaaaaaaaaaaasecret1",
  name: "registry-token",
  createdAt: "2026-01-01T09:30:00Z",
  updatedAt: "2026-01-02T11:45:00Z",
  version: 11,
  labels: { app: "storefront" },
  ...overrides,
});

const manager: SwarmSurface = { manager: true, nodeState: "active" };

function renderHost(overrides: Partial<AnchorageStore>) {
  const store = {
    isHost: true,
    secrets: [],
    secretsSwarm: manager,
    secretsStatus: "ready",
    secretsError: null,
    secretsLimitations: [],
    refreshSecrets: async () => undefined,
    openCommandCenter: vi.fn(),
    ...overrides,
  } as unknown as AnchorageStore;
  return render(<SecretsScreen store={store} />);
}

describe("SecretsScreen", () => {
  it("lists a secret's reference and metadata", () => {
    renderHost({ secrets: [secret()] });

    const row = screen.getByTestId("secret-aaaaaaaaaaaasecret1");
    expect(row).toHaveTextContent("registry-token");
    expect(row).toHaveTextContent("aaaaaaaaaaaasecret1");
    // Rendered in UTC rather than the reader's locale, so a timestamp means the same thing
    // in a screenshot as it does on the machine that produced it.
    expect(row).toHaveTextContent("2026-01-01 09:30 UTC");
    expect(row).toHaveTextContent("app=storefront");
  });

  // The whole point of the screen. Docker discards the plaintext at creation, so there must
  // be no control that offers to show one and no claim that implies one exists to show.
  it("states that Docker returns no values, and offers no way to ask for one", () => {
    renderHost({ secrets: [secret()] });

    expect(screen.getByTestId("secrets-value-notice")).toHaveTextContent(
      /never returns a secret's value/iu,
    );
    for (const label of [/reveal/iu, /show value/iu, /copy value/iu, /decrypt/iu]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    // No write verbs either: creating or removing a secret is out of scope.
    expect(screen.queryByRole("button", { name: /create secret/iu })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove/iu })).toBeNull();
  });

  // The conflation this screen exists to prevent: a live `docker secret` surface says
  // nothing about whether se:// resolves.
  it("keeps Swarm secrets and Docker Pass apart even when the store is live", () => {
    renderHost({ secrets: [secret()] });

    const note = screen.getByTestId("secrets-pass-notice");
    expect(note).toHaveTextContent(/Docker Pass/u);
    expect(note).toHaveTextContent(/se:\/\//u);
    expect(note).toHaveTextContent(/separate|different/iu);
  });

  it("reads an empty manager differently from an engine with no store", () => {
    renderHost({ secrets: [] });
    expect(screen.getByTestId("secrets-empty")).toHaveTextContent(
      /Swarm holds no secrets/iu,
    );
    expect(screen.queryByTestId("secrets-no-swarm")).toBeNull();
    cleanup();

    renderHost({
      secrets: [],
      secretsSwarm: {
        manager: false,
        nodeState: "inactive",
        reason: "This node is not a swarm manager.",
      },
    });
    const absent = screen.getByTestId("secrets-no-swarm");
    expect(absent).toHaveTextContent(/not a Swarm manager/iu);
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
    // Reported in the daemon's own words rather than paraphrased.
    expect(screen.getByTestId("secrets-swarm-reason")).toHaveTextContent(
      "This node is not a swarm manager.",
    );
  });

  // A worker and an unswarmed engine refuse identically but are fixed in opposite ways, so
  // the screen must not give them the same instruction.
  it("tells a worker node apart from an engine that never joined a swarm", () => {
    renderHost({
      secretsSwarm: { manager: false, nodeState: "inactive" },
    });
    expect(screen.getByTestId("secrets-no-swarm")).toHaveTextContent(
      /has not joined a swarm/iu,
    );
    cleanup();

    renderHost({
      secretsSwarm: { manager: false, nodeState: "active" },
    });
    const worker = screen.getByTestId("secrets-no-swarm");
    expect(worker).toHaveTextContent(/is not a manager/iu);
    expect(worker).not.toHaveTextContent(/has not joined a swarm/iu);
  });

  // A failed refresh is not an absent capability. Both end with no rows, and saying so the
  // same way would send an operator to fix the wrong thing.
  it("reads a failed refresh differently from an absent surface", () => {
    renderHost({
      secretsSwarm: null,
      secretsStatus: "error",
      secretsError: "core exited",
    });

    expect(screen.getByTestId("secrets-error-state")).toBeInTheDocument();
    expect(screen.queryByTestId("secrets-no-swarm")).toBeNull();
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
  });

  it("labels the swarm state in words, not only in colour", () => {
    renderHost({ secrets: [secret()] });
    expect(screen.getByTestId("secrets-swarm-chip")).toHaveTextContent(
      "Swarm manager",
    );
    cleanup();

    renderHost({ secretsSwarm: { manager: false, nodeState: "inactive" } });
    expect(screen.getByTestId("secrets-swarm-chip")).toHaveTextContent(
      "Not a Swarm manager",
    );
  });

  // The CLI transport reports times relative to now and labels as one string. Passing those
  // off as exact values would invent a precision Docker never supplied.
  it("shows the CLI transport's display values as it received them", () => {
    renderHost({
      secrets: [
        secret({
          createdAt: undefined,
          updatedAt: undefined,
          version: undefined,
          labels: {},
          createdDisplay: "2 hours ago",
          updatedDisplay: "2 hours ago",
          labelsText: "app=storefront",
        }),
      ],
    });

    const row = screen.getByTestId("secret-aaaaaaaaaaaasecret1");
    expect(row).toHaveTextContent("2 hours ago");
    expect(row).toHaveTextContent("app=storefront");
    expect(row).not.toHaveTextContent("UTC");
  });

  it("carries the posture whether or not the store is reachable", () => {
    renderHost({ secrets: [secret()] });
    expect(screen.getByTestId("secrets-screen-posture")).toHaveTextContent(
      /read its own environment/iu,
    );
    cleanup();

    renderHost({ secretsSwarm: { manager: false, nodeState: "inactive" } });
    expect(screen.getByTestId("secrets-screen-posture")).toHaveTextContent(
      /read its own environment/iu,
    );
  });

  // Fixture mode must never look like a live inventory: the preview has no daemon, so an
  // invented row here would be a false claim about the reader's host.
  it("shows no simulated secrets in the browser preview", () => {
    render(
      <SecretsScreen
        store={{ isHost: false, openCommandCenter: vi.fn() } as never}
      />,
    );

    expect(screen.queryByTestId("secrets-table-body")).toBeNull();
    expect(screen.getByTestId("secrets-screen")).toHaveTextContent(
      /never connects to a daemon/iu,
    );
    expect(screen.getByTestId("secrets-screen-posture")).toBeInTheDocument();
  });
});
