import { describe, expect, it } from "vitest";
import { reconcileContainerIdentity } from "./useAnchorageStore";
import type { AnchorageContainer } from "../types";

/**
 * The list and the sampler own different columns of the same row.
 *
 * `containers.list` is authoritative for name, image, state and health; the core's `Container`
 * type carries no CPU or memory field at all. Those come from `containers.stats.batch`, which the
 * store writes straight into the same objects, and which only runs every 8 s because each sample
 * costs the daemon a full collection cycle.
 *
 * Reconciliation compared `cpu`, `memory` and `memoryLimit` against a list payload that never has
 * them, decided the row had changed, and replaced the sampled row with the bare one. Every
 * containers refresh therefore blanked the CPU and MEMORY columns — and Docker healthcheck events
 * make refreshes far more frequent than the 8 s sampler, so for most of the time those columns
 * showed nothing at all.
 */
const container = (overrides: Partial<AnchorageContainer> = {}): AnchorageContainer =>
  ({
    id: "abc123",
    name: "api",
    image: "node:20",
    ports: "8080:8080",
    state: "running",
    rawState: "running",
    status: "Up 2 hours",
    exitCode: 0,
    kind: "http",
    health: "healthy",
    ...overrides,
  }) as AnchorageContainer;

describe("reconcileContainerIdentity", () => {
  it("keeps sampled CPU and memory when a list refresh omits them", () => {
    const sampled = container({ cpu: 19.7, memory: 184, memoryLimit: 512 });
    const fromList = container();

    const [merged] = reconcileContainerIdentity([sampled], [fromList]);

    expect(merged.cpu).toBe(19.7);
    expect(merged.memory).toBe(184);
    expect(merged.memoryLimit).toBe(512);
  });

  it("still takes the list's answer for what the list owns", () => {
    // Carrying stats forward must not turn into carrying anything else forward: the list is the
    // only thing that knows a container's state changed.
    const sampled = container({ cpu: 19.7, memory: 184, status: "Up 2 hours" });
    const fromList = container({ status: "Up 3 hours", health: "unhealthy" });

    const [merged] = reconcileContainerIdentity([sampled], [fromList]);

    expect(merged.status).toBe("Up 3 hours");
    expect(merged.health).toBe("unhealthy");
    expect(merged.cpu).toBe(19.7);
  });

  it("drops stats once the container is no longer running", () => {
    // A stopped container consumes nothing. Carrying its last sample forward would leave the
    // table asserting that an exited container is still burning 19.7% of a CPU.
    const sampled = container({ cpu: 19.7, memory: 184, memoryLimit: 512 });
    const stopped = container({ state: "stopped", rawState: "exited", status: "Exited (0)" });

    const [merged] = reconcileContainerIdentity([sampled], [stopped]);

    expect(merged.state).toBe("stopped");
    expect(merged.cpu).toBeUndefined();
    expect(merged.memory).toBeUndefined();
  });

  it("prefers a fresh sample over the carried-forward one", () => {
    const sampled = container({ cpu: 19.7, memory: 184 });
    const newer = container({ cpu: 56.5, memory: 201 });

    const [merged] = reconcileContainerIdentity([sampled], [newer]);

    expect(merged.cpu).toBe(56.5);
    expect(merged.memory).toBe(201);
  });

  it("preserves referential identity when nothing changed, including the stats", () => {
    // The whole point of this function: a stable reference is what stops the table re-rendering
    // twice a second. Carrying stats forward must produce the same object, not an equal one.
    const sampled = container({ cpu: 19.7, memory: 184, memoryLimit: 512 });
    const previous = [sampled];

    const merged = reconcileContainerIdentity(previous, [container()]);

    expect(merged).toBe(previous);
  });
});
