import { CaretDownIcon, CaretUpDownIcon, CaretUpIcon } from "@phosphor-icons/react";

/**
 * A clickable column header.
 *
 * Rendered as a real button so it is keyboard reachable, and carries `aria-sort` on the
 * header cell so assistive technology reports the current ordering rather than leaving the
 * user to infer it from an icon.
 */
export function SortableHeader({
  label,
  ariaSort,
  onClick,
  align = "start",
}: {
  label: string;
  ariaSort: "ascending" | "descending" | "none";
  onClick: () => void;
  align?: "start" | "end";
}) {
  const Icon =
    ariaSort === "ascending"
      ? CaretUpIcon
      : ariaSort === "descending"
        ? CaretDownIcon
        : CaretUpDownIcon;

  return (
    <span aria-sort={ariaSort} className={`sortable-header sortable-header--${align}`}>
      <button
        type="button"
        onClick={onClick}
        data-testid={`sort-${label.toLowerCase().replace(/\s+/gu, "-")}`}
        aria-label={
          ariaSort === "none"
            ? `Sort by ${label.toLowerCase()}`
            : `Sorted by ${label.toLowerCase()}, ${ariaSort}. Activate to change.`
        }
      >
        {label}
        <Icon
          aria-hidden="true"
          size={11}
          weight={ariaSort === "none" ? "regular" : "bold"}
        />
      </button>
    </span>
  );
}
