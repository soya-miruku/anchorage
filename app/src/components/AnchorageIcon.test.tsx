// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnchorageIcon,
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
  ["dev-environments", "AppWindow", "phosphor", "data-icon-weight", "bold"],
  ["extensions", "Blocks", "lucide", "data-icon-stroke-width", "2.1"],
  ["settings", "RadioButton", "phosphor", "data-icon-weight", "bold"],
  ["search", "Search", "lucide", "data-icon-stroke-width", "2.4"],
  ["pause", "Pause", "phosphor", "data-icon-weight", "fill"],
  ["play", "Play", "phosphor", "data-icon-weight", "fill"],
  ["restart", "RotateCw", "lucide", "data-icon-stroke-width", "2.25"],
  ["delete", "Trash", "lucide", "data-icon-stroke-width", "2.1"],
  ["back", "ChevronLeft", "lucide", "data-icon-stroke-width", "2.4"],
  ["more", "DotsThree", "phosphor", "data-icon-weight", "bold"],
  ["rating", "Star", "phosphor", "data-icon-weight", "fill"],
  ["empty", "Square", "phosphor", "data-icon-weight", "fill"],
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

  it("rotates the library Blocks glyph into the handoff tile occupancy", () => {
    render(
      <AnchorageIcon
        name="extensions"
        size={15}
        data-testid="icon-extensions-rotation"
      />,
    );

    expect(screen.getByTestId("icon-extensions-rotation")).toHaveStyle({
      transform: "rotate(90deg)",
    });
  });
});
