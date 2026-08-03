import { describe, expect, it } from "vitest";
import { compareRows, type ColumnSort } from "./tableSort";

interface Row {
  name: string;
  cpu: number | null;
}

const name: ColumnSort<Row, "name"> = {
  key: "name",
  label: "Name",
  kind: "text",
  value: (row) => row.name,
};
const cpu: ColumnSort<Row, "cpu"> = {
  key: "cpu",
  label: "CPU",
  kind: "number",
  value: (row) => row.cpu,
};

const sortBy = <K extends string>(
  rows: Row[],
  column: ColumnSort<Row, K>,
  direction: "asc" | "desc",
) => [...rows].sort((a, b) => compareRows(column, direction, a, b));

describe("table sorting", () => {
  it("collates names naturally rather than lexically", () => {
    const rows = [
      { name: "worker-10", cpu: 0 },
      { name: "worker-2", cpu: 0 },
      { name: "worker-1", cpu: 0 },
    ];
    // Lexical ordering would put worker-10 before worker-2.
    expect(sortBy(rows, name, "asc").map((r) => r.name)).toEqual([
      "worker-1",
      "worker-2",
      "worker-10",
    ]);
  });

  it("is case-insensitive", () => {
    const rows = [{ name: "Zeta", cpu: 0 }, { name: "alpha", cpu: 0 }];
    expect(sortBy(rows, name, "asc").map((r) => r.name)).toEqual(["alpha", "Zeta"]);
  });

  it("sorts numbers numerically in both directions", () => {
    const rows = [{ name: "a", cpu: 9 }, { name: "b", cpu: 80 }, { name: "c", cpu: 10 }];
    expect(sortBy(rows, cpu, "asc").map((r) => r.cpu)).toEqual([9, 10, 80]);
    expect(sortBy(rows, cpu, "desc").map((r) => r.cpu)).toEqual([80, 10, 9]);
  });

  it("sinks unknown values to the bottom in BOTH directions", () => {
    // A container with no CPU reading must never rank as idle, nor as busiest.
    const rows = [
      { name: "known-low", cpu: 1 },
      { name: "unknown", cpu: null },
      { name: "known-high", cpu: 99 },
    ];
    expect(sortBy(rows, cpu, "asc").map((r) => r.name)).toEqual([
      "known-low",
      "known-high",
      "unknown",
    ]);
    expect(sortBy(rows, cpu, "desc").map((r) => r.name)).toEqual([
      "known-high",
      "known-low",
      "unknown",
    ]);
  });

  it("treats two unknowns as equal rather than reordering them", () => {
    const rows = [{ name: "a", cpu: null }, { name: "b", cpu: null }];
    expect(sortBy(rows, cpu, "asc").map((r) => r.name)).toEqual(["a", "b"]);
  });
});
