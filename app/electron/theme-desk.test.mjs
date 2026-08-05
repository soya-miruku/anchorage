import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEFAULT_FAMILY, DESK_COLORS, defaultDeskColor } from "./theme-desk.mjs";

/**
 * A mirrored constant nobody checks is a second place to be wrong.
 *
 * The main process paints a background before the renderer exists, so it needs the default
 * family's desk colour without being able to read the stylesheets. These assert the mirror still
 * matches its source — the failure being guarded is the window flashing one colour and settling
 * on another, which is exactly what happened when the default moved from Nous to Y2K and the
 * literal stayed blue.
 */
const readTheme = (family) =>
  readFileSync(new URL(`../src/styles/themes/${family}.css`, import.meta.url), "utf8");

/** The dark block's `--anc-desk`; dark is what an unrevealed window is painted with. */
function deskColor(family) {
  const css = readTheme(family);
  const dark = css
    .split(/^\}/mu)
    .find((block) => block.includes('data-color-mode="dark"') && block.includes("--anc-desk:"));
  assert.ok(dark, `${family}.css has no dark block defining --anc-desk`);
  const match = /--anc-desk:\s*(#[0-9a-fA-F]{3,8})/u.exec(dark);
  assert.ok(match, `${family}.css does not define --anc-desk as a hex`);
  return match[1].toLowerCase();
}

test("every recorded desk colour matches the theme it names", () => {
  for (const [family, recorded] of Object.entries(DESK_COLORS)) {
    assert.equal(
      recorded.toLowerCase(),
      deskColor(family),
      `${family}: the main process would paint ${recorded} behind a window the theme draws on ${deskColor(family)}`,
    );
  }
});

test("a desk colour is recorded for every family the app can start in", () => {
  const appearance = readFileSync(
    new URL("../src/theme/appearance.ts", import.meta.url),
    "utf8",
  );
  const declared = /export const THEME_FAMILIES = \[([^\]]*)\]/u.exec(appearance);
  assert.ok(declared, "THEME_FAMILIES not found");
  const families = Array.from(declared[1].matchAll(/"([a-z0-9]+)"/gu), (m) => m[1]);
  assert.ok(families.length >= 6, `expected every family, parsed ${families.join(", ")}`);
  for (const family of families) {
    assert.ok(
      DESK_COLORS[family],
      `${family} can be selected but has no desk colour, so its first frame would be another theme's`,
    );
  }
});

test("the default family tracks the one the renderer actually ships", () => {
  const appearance = readFileSync(
    new URL("../src/theme/appearance.ts", import.meta.url),
    "utf8",
  );
  const block = appearance.slice(appearance.indexOf("DEFAULT_APPEARANCE"));
  const family = /family:\s*"([a-z0-9]+)"/u.exec(block);
  assert.ok(family, "DEFAULT_APPEARANCE.family not found");
  assert.equal(
    DEFAULT_FAMILY,
    family[1],
    "the main process would paint the wrong family's background on a fresh install",
  );
  assert.equal(defaultDeskColor(), deskColor(family[1]));
});
