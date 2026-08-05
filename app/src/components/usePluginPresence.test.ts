import { describe, expect, it } from "vitest";
import { describePluginPresence } from "./usePluginPresence";
import type { SystemPlugins } from "../types";

/**
 * Five destinations told the operator a plugin was missing without ever looking.
 *
 * Models, Agents, Tools, Sandboxes and Bosun are gated on a CLI plugin, and each stated its
 * absence as a fact in static copy — so installing `docker model` changed nothing on the Models
 * screen, which went on reporting it missing. The core already classifies what it finds
 * (core/internal/core/plugins.go) and Settings already renders that; these screens simply never
 * asked.
 *
 * The classification matters more than presence. `broken` is an installation fault, not an
 * unavailable capability, and telling someone to install a plugin they have already installed —
 * as a dangling symlink from a removed Docker Desktop, which is the case on the reference host —
 * sends them to do the one thing that will not help.
 */
const report = (plugins: SystemPlugins["plugins"]): SystemPlugins => ({
  protocolVersion: "1",
  plugins,
  searchPath: ["/usr/libexec/docker/cli-plugins"],
  warnings: [],
  observedAt: "2026-08-05T00:00:00.000Z",
});

describe("describePluginPresence", () => {
  it("says nothing has been checked before the report arrives", () => {
    const state = describePluginPresence(null, "model");
    expect(state.kind).toBe("unknown");
  });

  it("reports a plugin that is present and working", () => {
    const state = describePluginPresence(
      report([{ name: "model", status: "available", discoverySource: "docker info", version: "1.2.0" }]),
      "model",
    );
    expect(state.kind).toBe("present");
    expect(state.detail).toContain("1.2.0");
  });

  it("distinguishes a faulty installation from an absent one", () => {
    // The reference host carries nine dangling symlinks left by a removed Docker Desktop.
    // "Install the plugin" is the wrong instruction for every one of them.
    const state = describePluginPresence(
      report([
        {
          name: "model",
          status: "broken",
          discoverySource: "cli-plugins directory",
          availabilityNote: "dangling symlink",
        },
      ]),
      "model",
    );
    expect(state.kind).toBe("broken");
    expect(state.detail).toContain("dangling symlink");
  });

  it("treats a degraded plugin as present but qualified", () => {
    const state = describePluginPresence(
      report([
        {
          name: "model",
          status: "degraded",
          discoverySource: "cli-plugins directory",
          availabilityNote: "the CLI refused it",
        },
      ]),
      "model",
    );
    expect(state.kind).toBe("degraded");
    expect(state.detail).toContain("refused");
  });

  it("reports absence only when the report genuinely lacks the plugin", () => {
    const state = describePluginPresence(
      report([{ name: "compose", status: "available", discoverySource: "docker info" }]),
      "model",
    );
    expect(state.kind).toBe("absent");
  });

  it("does not mistake a differently-named plugin for the one asked about", () => {
    const state = describePluginPresence(
      report([{ name: "model-runner", status: "available", discoverySource: "docker info" }]),
      "model",
    );
    expect(state.kind).toBe("absent");
  });
});
