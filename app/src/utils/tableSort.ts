import { useCallback, useMemo, useState } from "react";

export type SortDirection = "asc" | "desc";

export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

/**
 * How a column's value is compared.
 *
 * `text` uses locale-aware collation with numeric awareness, so `worker-2` sorts before
 * `worker-10` rather than after it. `number` sorts numerically and always sinks unknown
 * values (null) to the bottom regardless of direction, because "unknown" is not "zero" —
 * a container with no CPU reading must not rank as idle.
 */
export type SortKind = "text" | "number";

export interface ColumnSort<T, K extends string> {
  key: K;
  label: string;
  kind: SortKind;
  value: (row: T) => string | number | null;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function compareRows<T, K extends string>(
  column: ColumnSort<T, K>,
  direction: SortDirection,
  left: T,
  right: T,
): number {
  const a = column.value(left);
  const b = column.value(right);

  // Unknown values sink, in both directions.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const sign = direction === "asc" ? 1 : -1;
  if (column.kind === "number") {
    return (Number(a) - Number(b)) * sign;
  }
  return collator.compare(String(a), String(b)) * sign;
}

/**
 * Sorting for a table view.
 *
 * Returns the sorted rows plus the props a header cell needs. Sorting is presentation-only:
 * it never changes which rows are shown, so it composes with filtering rather than fighting
 * it. Passing no sort leaves the incoming order untouched, which preserves the daemon's own
 * ordering as the default.
 */
export function useTableSort<T, K extends string>(
  rows: T[],
  columns: ReadonlyArray<ColumnSort<T, K>>,
  initial: SortState<K> | null = null,
) {
  const [sort, setSort] = useState<SortState<K> | null>(initial);

  const toggle = useCallback((key: K) => {
    setSort((current) => {
      if (!current || current.key !== key) return { key, direction: "asc" };
      // Third click clears the sort and restores the daemon's ordering.
      if (current.direction === "asc") return { key, direction: "desc" };
      return null;
    });
  }, []);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((candidate) => candidate.key === sort.key);
    if (!column) return rows;
    // Copy before sorting: the incoming array is shared state.
    return [...rows].sort((left, right) =>
      compareRows(column, sort.direction, left, right),
    );
  }, [rows, columns, sort]);

  const headerProps = useCallback(
    (key: K) => {
      const active = sort?.key === key;
      return {
        "aria-sort": (active
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : "none") as "ascending" | "descending" | "none",
        "data-sorted": active ? sort.direction : undefined,
        onClick: () => toggle(key),
      };
    },
    [sort, toggle],
  );

  return { sorted, sort, toggle, headerProps };
}
