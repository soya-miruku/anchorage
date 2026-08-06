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
import { LogsScreen } from "./LogsScreen";
import { ModelsScreen } from "./ModelsScreen";
import { ScanScreen } from "./ScanScreen";
import { SecretsScreen } from "./SecretsScreen";
import { ToolsScreen } from "./ToolsScreen";

const SCREEN_COMPONENTS: Partial<
  Record<ViewId, (props: { store: AnchorageStore }) => ReactElement>
> = {
  logs: LogsScreen,
  models: ModelsScreen,
  agents: AgentsScreen,
  tools: ToolsScreen,
  scan: ScanScreen,
  secrets: SecretsScreen,
};

/**
 * The point of landing every destination at once.
 *
 * This list used to hold twenty-two entries, eleven of which could not be served on an
 * ordinary Linux engine and existed only to say so. The policy behind that — report a
 * capability-unavailable feature explicitly rather than invent an equivalent — is still the
 * right one, and the screens that remain still obey it. What changed is which absences are
 * worth a row: a destination that could never become real on any Linux engine is not an
 * unavailable capability, it is not a capability at all, and a nav row for it is an
 * advertisement for someone else's product. Those are gone; types.ts records each one and
 * what it needed.
 *
 * So each entry below asserts the destination is reachable and says something true when you
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
  "models",
  "agents",
  "tools",
  "scan",
  "secrets",
  "settings",
];

/**
 * Every destination that carries a posture statement, not only the ones whose whole subject
 * is a boundary claim. The regex below cannot tell a true statement from a false one, so
 * this list buys one thing: a posture cannot be dropped — or stranded on a branch nobody
 * renders — without a test going red.
 */
const POSTURE_REQUIRED: ViewId[] = [
  "logs",
  "models",
  "agents",
  "tools",
  "scan",
  "secrets",
];

afterEach(cleanup);

describe("destinations", () => {
  it("gives every destination a nav row", () => {
    render(<App />);

    for (const view of DESTINATIONS) {
      expect(screen.getByTestId(`nav-${view}`)).toBeInTheDocument();
    }
  });

  it("has no row for a destination it removed rather than explained", () => {
    // The removal is the assertion. A row that reappears — reinstated from the handoff, or
    // revived by a merge — puts a dead end back in the nav, and the whole point of cutting
    // them was that eleven dead ends read as an unfinished product rather than as candour.
    render(<App />);

    for (const view of [
      "kubernetes",
      "bosun",
      "sandboxes",
      "hardened",
      "governance",
      "cloud",
      "devenv",
      "extensions",
    ]) {
      expect(
        screen.queryByTestId(`nav-${view}`),
        `${view} is back in the nav`,
      ).toBeNull();
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

  it("keeps the four groups, each with something in it", () => {
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

  it("carries no maturity entry for a destination that no longer exists", () => {
    // Otherwise the ledger keeps describing screens nobody can reach, and the next reader
    // cannot tell a stale entry from a destination they have simply not found yet.
    // Cast through `unknown`: these strings are deliberately no longer ViewIds, which is the
    // very thing being asserted, so TypeScript is right to refuse the direct conversion.
    for (const view of [
      "kubernetes",
      "bosun",
      "sandboxes",
      "hardened",
      "governance",
      "cloud",
      "devenv",
      "extensions",
    ] as unknown as ViewId[]) {
      expect(maturityFor(view), view).toEqual([]);
    }
  });

  it.each(POSTURE_REQUIRED)(
    "%s states what the capability does not protect",
    (view) => {
      // Whether or not it is reachable here: saying so only when a plugin happens to be
      // installed would make the honesty a side effect of the installation.
      const Screen = SCREEN_COMPONENTS[view];
      if (!Screen) throw new Error(`no component registered for ${view}`);
      render(<Screen store={{ openCommandCenter: vi.fn() } as never} />);

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
