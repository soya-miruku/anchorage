import type { AnchorageContainer } from "../types";

/**
 * Aggregate container CPU as a share of the engine's real cores.
 *
 * Docker reports per-container CPU as a percentage of a single core, so the sum across containers
 * is "cores busy x 100" and only becomes a share of the host once divided by how many cores the
 * host actually has. The previous code divided by a hardcoded 8, which overstated load eightfold
 * on this 64-core machine.
 *
 * Returns null when the engine has not reported a core count. There is no honest share to compute
 * without one, and the dashboard says so rather than drawing a meter over a guess.
 */
export function aggregateEngineCpuPercent(
  containers: readonly AnchorageContainer[],
  cpuCount: number | undefined,
): number | null {
  if (!cpuCount || cpuCount <= 0) return null;
  const busy = containers.reduce(
    (total, item) => total + (item.state === "running" ? (item.cpu ?? 0) : 0),
    0,
  );
  return Math.max(0, busy / cpuCount);
}
