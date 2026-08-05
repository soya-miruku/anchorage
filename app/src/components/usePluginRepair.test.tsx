// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePluginRepair } from "./usePluginRepair";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { DockerCliPlugin } from "../types";

/**
 * The judgement two surfaces used to make separately.
 *
 * Both the Settings plugin list and each capability's setup screen decided independently which
 * repair applied and what removal would cost, and for one revision the second got it wrong: it
 * told the operator that "the plugin it points at is already gone" about a file that merely
 * lacked its execute bit — the one fault where removing rather than repairing loses something
 * real. Nothing asserted the sentence, so nothing caught it. This does.
 */

const plugin = (overrides: Partial<DockerCliPlugin> = {}): DockerCliPlugin => ({
  name: "mcp",
  status: "broken",
  fault: "dangling-link",
  discoverySource: "cli-plugins-dir",
  path: "/home/tester/.docker/cli-plugins/docker-mcp",
  ...overrides,
});

function createStore(overrides: Partial<AnchorageStore> = {}): AnchorageStore {
  return {
    pluginRepairPending: null,
    repairPlugin: vi.fn(async () => true),
    ...overrides,
  } as unknown as AnchorageStore;
}

afterEach(cleanup);

describe("usePluginRepair consequences", () => {
  it("tells the truth about what removing each fault costs", () => {
    const store = createStore();

    // A link with no target: deleting it takes nothing with it, which is what makes the removal
    // safe to offer at all.
    const dangling = renderHook(() =>
      usePluginRepair(store, plugin({ fault: "dangling-link" })),
    );
    expect(dangling.result.current.removalConsequence).toContain("already gone");
    expect(dangling.result.current.removalConsequence).not.toContain("discards it");

    // A real plugin that only lacks its execute bit. Claiming "already gone" here would be
    // false, and would talk an operator into deleting a working file instead of repairing it.
    const notExecutable = renderHook(() =>
      usePluginRepair(store, plugin({ fault: "not-executable" })),
    );
    expect(notExecutable.result.current.removalConsequence).toContain("discards it");
    expect(notExecutable.result.current.removalConsequence).not.toContain("already gone");

    // A version mismatch: the file is real and no local repair applies, so the sentence claims
    // neither of the above.
    const handshake = renderHook(() =>
      usePluginRepair(store, plugin({ fault: "handshake", status: "degraded" })),
    );
    expect(handshake.result.current.removalConsequence).not.toContain("already gone");
    expect(handshake.result.current.removalConsequence).not.toContain("discards it");
  });

  it("offers the execute bit for exactly one fault", () => {
    const store = createStore();
    for (const fault of ["dangling-link", "unreadable", "handshake"] as const) {
      const { result } = renderHook(() => usePluginRepair(store, plugin({ fault })));
      expect(result.current.canEnable, fault).toBe(false);
    }
    const { result } = renderHook(() =>
      usePluginRepair(store, plugin({ fault: "not-executable" })),
    );
    expect(result.current.canEnable).toBe(true);
  });
});

describe("usePluginRepair actions", () => {
  it("arms a removal rather than performing it, and carries the confirmation the core requires", () => {
    const store = createStore();
    const { result } = renderHook(() => usePluginRepair(store, plugin()));

    expect(result.current.confirming).toBe(false);
    act(() => result.current.arm());
    expect(result.current.confirming).toBe(true);
    expect(store.repairPlugin).not.toHaveBeenCalled();

    act(() => result.current.confirmRemove());
    expect(store.repairPlugin).toHaveBeenCalledWith({
      name: "mcp",
      path: "/home/tester/.docker/cli-plugins/docker-mcp",
      action: "remove",
      confirmed: true,
    });
    // Closed on the way out: leaving it open while the removal runs invites a second click on a
    // path that is already gone.
    expect(result.current.confirming).toBe(false);
  });

  it("enables without a confirmation, because the core refuses one for that action", () => {
    const store = createStore();
    const { result } = renderHook(() =>
      usePluginRepair(store, plugin({ fault: "not-executable" })),
    );

    act(() => result.current.enable());
    expect(store.repairPlugin).toHaveBeenCalledWith({
      name: "mcp",
      path: "/home/tester/.docker/cli-plugins/docker-mcp",
      action: "enable",
    });
  });

  it("reports busy only for the entry whose repair is running", () => {
    // The pending path, not a boolean: two faults in the same list must not both grey out
    // because one of them is being removed.
    const store = createStore({
      pluginRepairPending: "/home/tester/.docker/cli-plugins/docker-mcp",
    });
    const mine = renderHook(() => usePluginRepair(store, plugin()));
    expect(mine.result.current.busy).toBe(true);

    const other = renderHook(() =>
      usePluginRepair(
        store,
        plugin({ name: "ai", path: "/home/tester/.docker/cli-plugins/docker-ai" }),
      ),
    );
    expect(other.result.current.busy).toBe(false);
  });

  it("stays inert for an entry with no path, rather than acting on an empty one", () => {
    const store = createStore();
    const { result } = renderHook(() =>
      usePluginRepair(store, plugin({ path: undefined })),
    );

    expect(result.current.path).toBeNull();
    expect(result.current.busy).toBe(false);
    act(() => result.current.confirmRemove());
    act(() => result.current.enable());
    expect(store.repairPlugin).not.toHaveBeenCalled();
  });
});
