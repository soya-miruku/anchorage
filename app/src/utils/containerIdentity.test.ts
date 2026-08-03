import { describe, expect, it } from "vitest";
import { reconcileContainerIdentity } from "../store/useAnchorageStore";
import type { AnchorageContainer } from "../types";

const container = (
  id: string,
  overrides: Partial<AnchorageContainer> = {},
): AnchorageContainer => ({
  id,
  name: `container-${id}`,
  image: "registry.test/app:latest",
  ports: "—",
  state: "running",
  rawState: "running",
  status: "Up 2 minutes",
  exitCode: null,
  kind: "http",
  cpu: 1.5,
  memory: 128,
  memoryLimit: 512,
  health: "—",
  progress: 0,
  cpuHistory: [],
  memoryHistory: [],
  labels: {},
  composeProject: null,
  ...overrides,
});

describe("container identity reconciliation", () => {
  it("returns the previous array when nothing rendered has changed", () => {
    const previous = [container("a"), container("b")];
    // A fresh poll builds brand-new objects with identical values.
    const next = [container("a"), container("b")];
    expect(reconcileContainerIdentity(previous, next)).toBe(previous);
  });

  it("keeps unchanged rows identical while replacing only the changed one", () => {
    const previous = [container("a"), container("b")];
    const next = [container("a"), container("b", { cpu: 92.5 })];

    const merged = reconcileContainerIdentity(previous, next);
    expect(merged).not.toBe(previous);
    // The untouched row keeps its identity, so a memoized row skips re-rendering.
    expect(merged[0]).toBe(previous[0]);
    expect(merged[1]).not.toBe(previous[1]);
    expect(merged[1].cpu).toBe(92.5);
  });

  it("ignores sampled history, which is stored outside the container", () => {
    const previous = [container("a", { cpuHistory: [1, 2, 3] })];
    const next = [container("a", { cpuHistory: [] })];
    expect(reconcileContainerIdentity(previous, next)).toBe(previous);
  });

  it("treats additions, removals and reordering as changes", () => {
    const a = container("a");
    const b = container("b");
    const single = [a];

    const grown = reconcileContainerIdentity(single, [container("a"), b]);
    expect(grown).not.toBe(single);
    expect(grown).toHaveLength(2);
    expect(grown[0]).toBe(a);

    expect(reconcileContainerIdentity([a, b], [container("a")])).toHaveLength(1);

    const reordered = reconcileContainerIdentity(
      [a, b],
      [container("b"), container("a")],
    );
    expect(reordered.map((item) => item.id)).toEqual(["b", "a"]);
    // Identity still survives the move, so only positions change for React.
    expect(reordered[0]).toBe(b);
    expect(reordered[1]).toBe(a);
  });

  it("returns the incoming list when there is no previous state", () => {
    const next = [container("a")];
    expect(reconcileContainerIdentity([], next)).toBe(next);
  });
});
