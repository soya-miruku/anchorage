import { describe, expect, it } from "vitest";
import { REGISTRY_FIXTURES } from "./fixtures";

/**
 * The registry marks are the only place the fixtures carry a colour, and they are rendered by
 * writing the value straight into `style={{ background }}`. A literal hex there is invisible to
 * the theme layer: it survives every family and both modes unchanged, which is how a coloured
 * tile ended up sitting on the greyscale Monochrome surface.
 *
 * The extension marks used to be checked here too. Those fixtures are gone with the Extensions
 * screen — a marketplace of invented publishers, ratings and install counts that Anchorage
 * could never have installed from.
 *
 * The companion checks — that the file text holds no hex at all, and that the tokens it names
 * exist in all four families — read files, so they live in
 * `scripts/theme-integrity.test.mjs` alongside the other cross-theme assertions.
 */
describe("fixture colours", () => {
  it("carries no colour of its own — the mark fill is a theme decision", () => {
    // Previously each fixture named its own hex, which no theme could retint. The field is
    // gone rather than tokenised: a per-item fill would need a per-item ink to stay legible,
    // and `scripts/theme-integrity.test.mjs` can only guarantee the pairs the theme defines.
    const marks = [...REGISTRY_FIXTURES];
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark).not.toHaveProperty("color");
    }
  });
});
