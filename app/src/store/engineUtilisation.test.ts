import { describe, expect, it } from "vitest";
import { aggregateEngineCpuPercent } from "./engineUtilisation";
import type { AnchorageContainer } from "../types";

/**
 * The dashboard was inventing two numbers and drawing them as measurements.
 *
 * The CPU meter read `(engine.cpus / 64) * 100`, which is a capacity divided by a constant
 * somebody picked. On a 64-core host that is exactly 100%, so the card reported every logical CPU
 * as consumed while measuring nothing at all. The aggregate series behind it divided the summed
 * container CPU by a hardcoded 8, so on the same host it overstated load by 8x.
 *
 * Docker reports per-container CPU as a percentage of one core, so 100 means one core saturated
 * and 6400 would mean all 64. Turning that into a share of the host requires the host's real core
 * count, and when the engine has not reported one there is no honest answer — which is null here,
 * not a guess.
 */
const container = (overrides: Partial<AnchorageContainer> = {}): AnchorageContainer =>
  ({
    id: "c1",
    name: "api",
    image: "node:20",
    ports: "",
    state: "running",
    rawState: "running",
    status: "Up",
    exitCode: 0,
    kind: "http",
    health: "healthy",
    ...overrides,
  }) as AnchorageContainer;

describe("aggregateEngineCpuPercent", () => {
  it("expresses container CPU as a share of the host's real cores", () => {
    // Two containers each saturating one core, on a 64-core host, is 2/64 = 3.125%.
    const containers = [
      container({ id: "a", cpu: 100 }),
      container({ id: "b", cpu: 100 }),
    ];
    expect(aggregateEngineCpuPercent(containers, 64)).toBeCloseTo(3.125, 3);
  });

  it("does not overstate load by assuming a core count", () => {
    // The old code divided by 8 regardless of the host. On 64 cores that reported 25% where
    // the truth is 3.125%.
    const containers = [
      container({ id: "a", cpu: 100 }),
      container({ id: "b", cpu: 100 }),
    ];
    expect(aggregateEngineCpuPercent(containers, 64)).not.toBeCloseTo(25, 1);
  });

  it("ignores containers that are not running", () => {
    const containers = [
      container({ id: "a", cpu: 100 }),
      container({ id: "b", cpu: 100, state: "stopped" }),
    ];
    expect(aggregateEngineCpuPercent(containers, 64)).toBeCloseTo(1.5625, 4);
  });

  it("reports nothing rather than guessing when the engine gave no core count", () => {
    const containers = [container({ id: "a", cpu: 100 })];
    expect(aggregateEngineCpuPercent(containers, undefined)).toBeNull();
    expect(aggregateEngineCpuPercent(containers, 0)).toBeNull();
  });

  it("can exceed no bound it was not given, but never reports a negative share", () => {
    const containers = [container({ id: "a", cpu: 0 })];
    expect(aggregateEngineCpuPercent(containers, 64)).toBe(0);
  });
});
