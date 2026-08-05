// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LevelChip, MATURITY_LEVELS, maturityLabel } from "./LevelChip";

afterEach(cleanup);

describe("LevelChip", () => {
  it("carries the handoff's five maturity levels and no others", () => {
    expect(MATURITY_LEVELS).toEqual([
      "ga",
      "early-access",
      "beta",
      "experimental",
      "deprecated",
    ]);
  });

  it("renders the handoff's label for each level", () => {
    expect(MATURITY_LEVELS.map(maturityLabel)).toEqual([
      "GA",
      "Early Access",
      "Beta",
      "Experimental",
      "Deprecated",
    ]);
  });

  it("keys its colour pair off a level modifier rather than an inline style", () => {
    render(<LevelChip level="experimental" />);

    const chip = screen.getByText("Experimental");
    expect(chip).toHaveClass("level-chip", "level-chip--experimental");
    expect(chip.getAttribute("style")).toBeNull();
  });

  it("states the level in full to assistive technology, since the chip is uppercased visually", () => {
    render(<LevelChip level="early-access" />);

    expect(screen.getByText("Early Access")).toHaveAccessibleName(
      "Maturity: Early Access",
    );
  });

  it("accepts a caller-supplied description of what the level applies to", () => {
    render(<LevelChip level="beta" describes="Docker Debug" />);

    expect(screen.getByText("Beta")).toHaveAccessibleName(
      "Docker Debug maturity: Beta",
    );
  });
});
