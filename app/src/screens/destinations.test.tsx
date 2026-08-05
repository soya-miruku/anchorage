// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { maturityFor } from "../data/maturity";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { ViewId } from "../types";
import { AgentsScreen } from "./AgentsScreen";
import { BosunScreen } from "./BosunScreen";
import { CloudScreen } from "./CloudScreen";
import { ExtensionsScreen } from "./ExtensionsScreen";
import { GovernanceScreen } from "./GovernanceScreen";
import { HardenedScreen } from "./HardenedScreen";
import { KubernetesScreen } from "./KubernetesScreen";
import { LogsScreen } from "./LogsScreen";
import { ModelsScreen } from "./ModelsScreen";
import { SandboxesScreen } from "./SandboxesScreen";
import { ScanScreen } from "./ScanScreen";
import { SecretsScreen } from "./SecretsScreen";
import { ToolsScreen } from "./ToolsScreen";

const SCREEN_COMPONENTS: Partial<
  Record<ViewId, (props: { store: AnchorageStore }) => ReactElement>
> = {
  logs: LogsScreen,
  kubernetes: KubernetesScreen,
  bosun: BosunScreen,
  models: ModelsScreen,
  agents: AgentsScreen,
  tools: ToolsScreen,
  sandboxes: SandboxesScreen,
  scan: ScanScreen,
  hardened: HardenedScreen,
  secrets: SecretsScreen,
  governance: GovernanceScreen,
  cloud: CloudScreen,
  extensions: ExtensionsScreen,
};

/**
 * The point of landing every handoff destination at once.
 *
 * Eleven of these cannot be served on an ordinary Linux engine, and before this they were
 * simply absent from the product — which reads as "Anchorage has not heard of Kubernetes"
 * rather than "this build cannot reach it". The build's stated policy is to report a
 * capability-unavailable feature explicitly rather than invent an equivalent, and a missing
 * nav row reports nothing at all.
 *
 * So each of these asserts the destination is reachable and says something true when you
 * get there, rather than asserting any particular screen design.
 */

const DESTINATIONS: ViewId[] = [
  "dashboard",
  "containers",
  "compose",
  "images",
  "volumes",
  "networks",
  "builds",
  "logs",
  "kubernetes",
  "bosun",
  "models",
  "agents",
  "tools",
  "sandboxes",
  "scan",
  "hardened",
  "secrets",
  "governance",
  "cloud",
  "devenv",
  "extensions",
  "settings",
];

/**
 * Every destination that carries a posture statement, not only the ones whose whole subject
 * is a boundary claim. The regex below cannot tell a true statement from a false one, so
 * this list buys one thing: a posture cannot be dropped — or stranded on a branch nobody
 * renders — without a test going red. Extensions lost its §24.9 disclosure exactly that way.
 */
const POSTURE_REQUIRED: ViewId[] = [
  "logs",
  "kubernetes",
  "bosun",
  "models",
  "agents",
  "tools",
  "sandboxes",
  "scan",
  "hardened",
  "secrets",
  "governance",
  "cloud",
  "extensions",
];

/**
 * Extra store fields a destination needs before it reaches its posture at all. Extensions
 * renders the marketplace unless it is in host mode, and the marketplace has no posture.
 */
const POSTURE_STORE: Partial<Record<ViewId, Partial<AnchorageStore>>> = {
  extensions: { isHost: true },
};

afterEach(cleanup);

describe("handoff destinations", () => {
  it("gives every destination a nav row", () => {
    render(<App />);

    for (const view of DESTINATIONS) {
      expect(screen.getByTestId(`nav-${view}`)).toBeInTheDocument();
    }
  });

  it("renders something on every destination", async () => {
    // That each destination *has* a route is now a compile-time guarantee: App.tsx's default
    // arm assigns `store.view` to `never`, so adding a ViewId without a case stops the build.
    // That replaced a placeholder screen which rendered a plausible heading and let an
    // unrouted destination ship looking finished. What types cannot check is whether the
    // screen behind a route renders anything at all, which is what this walks.
    render(<App />);
    await screen.findByTestId("nav-containers");

    for (const view of DESTINATIONS) {
      fireEvent.click(screen.getByTestId(`nav-${view}`));
      expect(
        screen.getByTestId("screen").textContent ?? "",
        `${view} routed to an empty screen`,
      ).not.toBe("");
    }
  });

  it("groups them the way the handoff does", () => {
    render(<App />);

    const groups = Array.from(
      document.querySelectorAll(".sidebar__section-label"),
    ).map((node) => node.textContent);

    expect(groups).toEqual(["WORKSPACE", "AI", "SECURITY", "PLATFORM"]);
  });

  it("tracks maturity for every destination, so no screen reads as unlabelled", () => {
    const untracked = DESTINATIONS.filter(
      (view) => maturityFor(view).length === 0,
    );

    expect(untracked).toEqual([]);
  });

  it.each(POSTURE_REQUIRED)(
    "%s states what the capability does not protect",
    (view) => {
      // Whether or not it is reachable here: saying so only when a plugin happens to be
      // installed would make the honesty a side effect of the installation.
      const Screen = SCREEN_COMPONENTS[view];
      if (!Screen) throw new Error(`no component registered for ${view}`);
      render(
        <Screen
          store={
            { openCommandCenter: vi.fn(), ...POSTURE_STORE[view] } as never
          }
        />,
      );

      const posture = screen.getByTestId(`${view}-screen-posture`);
      expect(posture).toBeInTheDocument();
      // The posture rule is "say what a thing does not protect", so the statement has to
      // contain a negative claim. Copy that only lists what a feature does is marketing.
      expect(posture.textContent ?? "").toMatch(
        /\bnot\b|\bno\b|\bnothing\b|\bnever\b|cannot/u,
      );
    },
  );
});
