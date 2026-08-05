import { describe, expect, it } from "vitest";

import {
  CAPABILITY_STORAGE_KEY,
  capabilityCatalogue,
  capabilityForPlugin,
  capabilityState,
  isViewVisible,
  persistCapabilityPreference,
  readCapabilityPreference,
  resolveCapabilityPreference,
} from "./capabilities";
import type { DockerCliPlugin, SystemPlugins, ViewId } from "../types";

const report = (plugins: DockerCliPlugin[]): SystemPlugins => ({
  protocolVersion: "1",
  plugins,
  searchPath: ["/home/tester/.docker/cli-plugins"],
  warnings: [],
  observedAt: "2026-08-05T00:00:00.000Z",
});

const entry = (
  name: string,
  status: DockerCliPlugin["status"],
): DockerCliPlugin => ({
  name,
  status,
  discoverySource: status === "available" ? "docker-info" : "cli-plugins-dir",
  path: `/home/tester/.docker/cli-plugins/docker-${name}`,
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("capability state", () => {
  it("separates a faulty installation from an absent capability", () => {
    // The distinction the whole feature rests on: "broken" means something was installed here
    // and went wrong, and "install this plugin" is the one instruction that will not help.
    const installation = report([
      entry("compose", "available"),
      entry("mcp", "broken"),
      entry("scout", "degraded"),
    ]);

    expect(capabilityState(installation, "compose")).toBe("installed");
    expect(capabilityState(installation, "mcp")).toBe("broken");
    expect(capabilityState(installation, "scout")).toBe("not-loaded");
    expect(capabilityState(installation, "model")).toBe("absent");
  });

  it("reports an unread installation as unknown rather than as nothing installed", () => {
    // A failed read, or one that has not happened, is not evidence about the machine. Every
    // consumer branches on this, and treating it as "absent" would hide rows on a bad guess.
    expect(capabilityState(null, "model")).toBe("unknown");
  });
});

describe("sidebar visibility", () => {
  const gated = capabilityCatalogue.filter((capability) => capability.gatesSidebar);

  it("hides a gated row only when the CLI definitely does not list its plugin", () => {
    for (const capability of gated) {
      expect(
        isViewVisible(capability.view, report([]), []),
        `${capability.view} should be hidden when ${capability.plugin} is absent`,
      ).toBe(false);
    }
  });

  it("keeps a gated row whose plugin is installed but faulty", () => {
    // The case worth walking into: that row is the way to the repair, so removing it would take
    // away the only route to fixing what is wrong.
    for (const capability of gated) {
      for (const status of ["broken", "degraded"] as const) {
        expect(
          isViewVisible(
            capability.view,
            report([entry(capability.plugin, status)]),
            [],
          ),
          `${capability.view} should stay visible when ${capability.plugin} is ${status}`,
        ).toBe(true);
      }
    }
  });

  it("keeps every row when the installation has not been read", () => {
    // Browser preview, a failed call, or before the first read completes. Hiding here would be
    // a claim about a machine nobody has looked at.
    for (const capability of gated) {
      expect(isViewVisible(capability.view, null, [])).toBe(true);
    }
  });

  it("keeps an absent row the operator asked to see", () => {
    expect(isViewVisible("models", report([]), [])).toBe(false);
    expect(isViewVisible("models", report([]), ["models"])).toBe(true);
  });

  it("never hides a destination that is not gated on a plugin", () => {
    // Compose, Builds and Scan are plugin-backed but keep their rows: they are core Docker
    // workflows with real screens, and a Compose row that vanished would read as the
    // application having lost a feature rather than as a missing plugin.
    for (const capability of capabilityCatalogue.filter((item) => !item.gatesSidebar)) {
      expect(isViewVisible(capability.view, report([]), [])).toBe(true);
    }
    // And nothing outside the catalogue is gated at all.
    for (const view of ["containers", "images", "settings", "kubernetes"] as ViewId[]) {
      expect(isViewVisible(view, report([]), [])).toBe(true);
    }
  });
});

describe("the catalogue itself", () => {
  it("gives every gated capability something the operator can act on", () => {
    // A capability with no install guidance would be a row that reports a problem and offers
    // nothing, which is what this feature replaced.
    for (const capability of capabilityCatalogue) {
      expect(capability.install.note.length, capability.plugin).toBeGreaterThan(20);
      if (capability.install.kind === "package") {
        expect(capability.install.package, capability.plugin).toBeTruthy();
        expect(capability.install.commands?.length, capability.plugin).toBeGreaterThan(0);
        // The package name has to appear in the command, or the two disagree about what to
        // install and the copy button hands over something that does not match the prose.
        for (const command of capability.install.commands ?? []) {
          expect(command).toContain(capability.install.package as string);
        }
      }
    }
  });

  it("claims no install command for a capability Docker only ships with Desktop", () => {
    // Naming a package that does not exist is worse than saying there is none: it sends the
    // operator to a command that fails and reads as Anchorage's fault.
    for (const capability of capabilityCatalogue) {
      if (capability.install.kind !== "package") {
        expect(capability.install.commands, capability.plugin).toBeUndefined();
      }
    }
  });

  it("maps each plugin to exactly one destination", () => {
    const plugins = capabilityCatalogue.map((capability) => capability.plugin);
    expect(new Set(plugins).size).toBe(plugins.length);
    expect(capabilityForPlugin("mcp")?.view).toBe("tools");
    expect(capabilityForPlugin("nonesuch")).toBeUndefined();
  });
});

describe("which hidden destinations the operator asked for", () => {
  it("survives a round trip", () => {
    const storage = memoryStorage();
    expect(persistCapabilityPreference({ revealed: ["models"] }, { storage, search: "" })).toBe(
      true,
    );
    expect(readCapabilityPreference({ storage, search: "" })).toEqual({
      revealed: ["models"],
    });
  });

  it("discards anything that is not a gated destination", () => {
    // A view that stopped being gated would be a permanent no-op, and a stale preference must
    // not outlive the reason it was made.
    expect(
      resolveCapabilityPreference(
        JSON.stringify({ revealed: ["models", "containers", "compose", 7, null] }),
      ),
    ).toEqual({ revealed: ["models"] });
  });

  it("treats unreadable storage as no preference rather than failing", () => {
    for (const stored of ["", "not json", "[]", '{"revealed":"models"}', "null"]) {
      expect(resolveCapabilityPreference(stored)).toEqual({ revealed: [] });
    }
    expect(resolveCapabilityPreference(null)).toEqual({ revealed: [] });
  });

  it("reads and writes nothing under a capture query", () => {
    // A design-parity fixture has to render the same sidebar on every machine, so one
    // developer's revealed rows must not change the frame. Same rule as the appearance
    // preference, for the same reason.
    const storage = memoryStorage();
    storage.setItem(CAPABILITY_STORAGE_KEY, JSON.stringify({ revealed: ["models"] }));

    expect(readCapabilityPreference({ storage, search: "?capture=host" })).toEqual({
      revealed: [],
    });
    expect(
      persistCapabilityPreference({ revealed: ["tools"] }, { storage, search: "?capture=host" }),
    ).toBe(false);
    // The stored value is untouched, not overwritten with the capture default.
    expect(readCapabilityPreference({ storage, search: "" })).toEqual({
      revealed: ["models"],
    });
  });

  it("reports a refused write rather than throwing", () => {
    const hostile = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(
      persistCapabilityPreference({ revealed: ["models"] }, { storage: hostile, search: "" }),
    ).toBe(false);
  });
});
