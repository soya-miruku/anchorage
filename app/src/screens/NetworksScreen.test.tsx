// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NetworksScreen } from "./NetworksScreen";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { NetworkSummary } from "../types";

const network = (name: string): NetworkSummary => ({
  id: name.padEnd(12, "0"),
  name,
  driver: "bridge",
  scope: "local",
  internal: false,
  attachable: false,
  ingress: false,
  enableIpv6: false,
  subnets: [],
  gateways: [],
  labels: {},
  options: {},
  predefined: true,
  containerCount: 0,
});

const createStore = (
  overrides: {
    networks?: NetworkSummary[];
    networksState?: AnchorageStore["hostDomainState"]["networks"];
  } = {},
) =>
  ({
    isHost: true,
    networks: overrides.networks ?? [],
    networkMutationPending: false,
    hostDomainState: {
      snapshot: { status: "ready" },
      images: { status: "ready" },
      volumes: { status: "ready" },
      networks: overrides.networksState ?? { status: "ready" },
    },
    createNetwork: vi.fn(),
    removeNetwork: vi.fn(),
    pruneNetworks: vi.fn(),
    openCommandCenter: vi.fn(),
  }) as unknown as AnchorageStore;

afterEach(cleanup);

describe("NetworksScreen", () => {
  it("reports a failed network list as a failure, not as an unmatched filter", () => {
    render(
      <NetworksScreen
        store={createStore({
          networksState: { status: "error", error: "engine unreachable" },
        })}
      />,
    );

    expect(screen.getByTestId("networks-error-state")).toBeInTheDocument();
    expect(screen.queryByTestId("networks-empty-state")).not.toBeInTheDocument();
    expect(
      screen.getByText("Live networks unavailable: engine unreachable"),
    ).toBeInTheDocument();
  });

  it("keeps the filter empty state when the list loaded and simply has no match", () => {
    render(<NetworksScreen store={createStore()} />);

    expect(screen.getByTestId("networks-empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("networks-error-state")).not.toBeInTheDocument();
  });

  it("still lists the networks it has when a later refresh fails", () => {
    render(
      <NetworksScreen
        store={createStore({
          networks: [network("bridge")],
          networksState: { status: "error", error: "engine unreachable" },
        })}
      />,
    );

    expect(screen.getByTestId("network-bridge000000")).toBeInTheDocument();
    expect(screen.queryByTestId("networks-error-state")).not.toBeInTheDocument();
    expect(
      screen.getByText("Live networks unavailable: engine unreachable"),
    ).toBeInTheDocument();
  });
});
