// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnchorageIcon,
  anchorageIconNames,
  type AnchorageIconName,
} from "./AnchorageIcon";

afterEach(cleanup);

const canonicalMappings: Array<
  [AnchorageIconName, string, string, string, string]
> = [
  ["dashboard", "LayoutGrid", "lucide", "data-icon-stroke-width", "2.1"],
  ["containers", "Rows3", "lucide", "data-icon-stroke-width", "2.1"],
  ["images", "Copy", "lucide", "data-icon-stroke-width", "2.1"],
  ["volumes", "Cylinder", "lucide", "data-icon-stroke-width", "2.1"],
  ["builds", "Diamond", "lucide", "data-icon-stroke-width", "2.1"],
  ["settings", "RadioButton", "phosphor", "data-icon-weight", "bold"],
  ["search", "Search", "lucide", "data-icon-stroke-width", "2.4"],
  ["pause", "Pause", "phosphor", "data-icon-weight", "fill"],
  ["play", "Play", "phosphor", "data-icon-weight", "fill"],
  ["restart", "RotateCw", "lucide", "data-icon-stroke-width", "2.25"],
  ["delete", "Trash", "lucide", "data-icon-stroke-width", "2.1"],
  ["back", "ChevronLeft", "lucide", "data-icon-stroke-width", "2.4"],
  ["more", "DotsThree", "phosphor", "data-icon-weight", "bold"],
  ["empty", "Square", "phosphor", "data-icon-weight", "fill"],
];

/**
 * Names that must stay gone.
 *
 * Each belonged to a destination Anchorage removed rather than explained. An icon is the
 * cheapest thing to leave behind — nothing breaks, it simply sits in the bundle importing a
 * library glyph nobody renders — so the set is asserted directly rather than left to review.
 */
const REMOVED_ICONS = [
  "bosun",
  "cloud",
  "dev-environments",
  "extensions",
  "governance",
  "hardened",
  "kubernetes",
  "rating",
  "sandboxes",
];

describe("AnchorageIcon", () => {
  it.each(canonicalMappings)(
    "maps %s to the measured %s %s glyph",
    (name, libraryName, family, styleAttribute, styleValue) => {
      render(
        <AnchorageIcon
          name={name}
          size={15}
          data-testid={`icon-${name}`}
        />,
      );

      const icon = screen.getByTestId(`icon-${name}`);
      expect(icon).toHaveAttribute("data-anchorage-icon", name);
      expect(icon).toHaveAttribute(
        "data-icon-library-name",
        libraryName,
      );
      expect(icon).toHaveAttribute("data-icon-family", family);
      expect(icon).toHaveAttribute(styleAttribute, styleValue);
      expect(icon).toHaveAttribute("width", "15");
      expect(icon).toHaveAttribute("height", "15");
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon).toHaveAttribute("focusable", "false");
    },
  );

  it("defines no glyph for a destination that was removed", () => {
    // The rotation case that used to sit here went with them: Extensions was the only glyph
    // whose library orientation disagreed with the handoff, so `rotation` had exactly one
    // user and is gone from the definition type rather than kept for a hypothetical second.
    const survivors = REMOVED_ICONS.filter((name) =>
      (anchorageIconNames as string[]).includes(name),
    );

    expect(survivors).toEqual([]);
  });
});
