import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Locks the WCAG AA guarantee on status chips.
 *
 * A chip paints its label in the same hue family as its own translucent fill. Doing that
 * with the raw status token measured 3.8-4.4:1 on several theme/mode pairs, which is under
 * AA — and the `-fg` token layer that fixes it is easy to bypass by writing
 * `color: var(--anc-success)` out of habit. The failure is also invisible to anyone
 * developing in one mode, so it is asserted rather than trusted.
 *
 * This runs under `node --test` rather than vitest because it reads the stylesheets as
 * text: Vite's CSS plugin intercepts `?raw` imports and hands back an empty string.
 */

// Every family the app can be set to. A family that ships without being measured here is a
// family whose contrast nobody has checked.
const THEMES = ["nous", "docker", "github", "mono", "magnetic", "y2k"];
const STATUSES = ["success", "danger", "warning", "violet", "accent"];

/** The strongest fill any chip paints, which is the worst case for text over it. */
const MAX_CHIP_TINT = 0.16;

function themeBlocks(theme) {
  const css = readFileSync(
    new URL(`../src/styles/themes/${theme}.css`, import.meta.url),
    "utf8",
  );
  const blocks = css.split(/^\}/mu).filter((block) => block.includes("--anc-app"));
  const dark = blocks.find((block) => block.includes('data-color-mode="dark"'));
  const light = blocks.find((block) => block.includes('data-color-mode="light"'));
  assert.ok(dark && light, `${theme}.css: expected one dark and one light block`);
  return { dark, light };
}

function hex(block, token) {
  const match = new RegExp(`--anc-${token}:\\s*(#[0-9a-fA-F]{6})`, "u").exec(block);
  assert.ok(match, `--anc-${token} is not a plain hex in this block`);
  return [1, 3, 5].map((i) => Number.parseInt(match[1].slice(i, i + 2), 16));
}

/** Resolves `--anc-<status>-fg`: an alias of its base, or a mix toward black or white. */
function foreground(block, status) {
  const declaration = new RegExp(`--anc-${status}-fg:\\s*([^;]+);`, "u").exec(block);
  assert.ok(declaration, `--anc-${status}-fg is missing`);
  const value = declaration[1].trim();
  const base = hex(block, status);

  if (value === `var(--anc-${status})`) return base;

  const mix = /color-mix\(in srgb,\s*var\(--anc-[a-z]+\)\s*(\d+)%,\s*(black|white)\)/u.exec(
    value,
  );
  assert.ok(mix, `--anc-${status}-fg is neither an alias nor a mix: ${value}`);
  const ratio = Number(mix[1]) / 100;
  const toward = mix[2] === "white" ? 255 : 0;
  return base.map((channel) => channel * ratio + toward * (1 - ratio));
}

function over(top, bottom, alpha) {
  return top.map((channel, i) => channel * alpha + bottom[i] * (1 - alpha));
}

function luminance([r, g, b]) {
  const channel = (value) => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Nous dark is held to the handoff instead of to AA.
 *
 * The handoff aliases every status foreground to its base in dark mode, and nous alone puts
 * a bright royal blue behind the chips, so all five land under 4.5:1. Reproducing the house
 * theme exactly was a deliberate call; letting it drift further was not. These are the
 * measured ratios of the handoff's own values — the floor is what the design costs today,
 * and anything below it is a regression this project introduced rather than inherited.
 */
const NOUS_DARK_FLOOR = {
  danger: 2.05,
  success: 2.95,
  violet: 3.04,
  accent: 3.85,
  warning: 3.87,
};

for (const theme of THEMES) {
  for (const mode of ["dark", "light"]) {
    for (const status of STATUSES) {
      const inherited = theme === "nous" && mode === "dark";
      const floor = inherited ? NOUS_DARK_FLOOR[status] : 4.5;
      const label = inherited
        ? `nous dark: a ${status} chip label holds the handoff's own contrast`
        : `${theme} ${mode}: a ${status} chip label clears WCAG AA on its own fill`;

      test(label, () => {
        const block = themeBlocks(theme)[mode];
        const fill = over(hex(block, status), hex(block, "panel"), MAX_CHIP_TINT);
        const ratio = contrast(foreground(block, status), fill);

        assert.ok(
          ratio >= floor,
          inherited
            ? `nous dark ${status}: ${ratio.toFixed(2)}:1 is below the handoff's own ${floor}:1 — this theme reproduces the design's contrast, it may not fall under it`
            : `${theme} ${mode} ${status}: ${ratio.toFixed(2)}:1 is under WCAG AA (4.5:1)`,
        );
      });
    }
  }
}

test("every status foreground moves away from its own fill, never toward it", () => {
  for (const theme of THEMES) {
    const { dark, light } = themeBlocks(theme);
    for (const status of STATUSES) {
      // Light surfaces darken the label, dark surfaces lighten it, and an alias is the
      // no-op case. A foreground that moved *toward* its fill would be a regression the
      // ratio assertions above could still pass by luck on a single theme.
      assert.ok(
        luminance(foreground(light, status)) <= luminance(hex(light, status)),
        `${theme} light ${status}: foreground is lighter than its base`,
      );
      assert.ok(
        luminance(foreground(dark, status)) >= luminance(hex(dark, status)),
        `${theme} dark ${status}: foreground is darker than its base`,
      );
    }
  }
});

test("monochrome keeps every status on a distinct lightness step", () => {
  // The point of the theme: with hue removed, two statuses that land on the same step are
  // indistinguishable — and they would be indistinguishable to everyone else too, in any
  // theme, for anyone relying on the colour alone.
  const MIN_SEPARATION = 0.02;

  for (const mode of ["dark", "light"]) {
    const block = themeBlocks("mono")[mode];
    const steps = STATUSES.map((status) => ({
      status,
      light: luminance(hex(block, status)),
    })).sort((a, b) => a.light - b.light);

    for (let i = 1; i < steps.length; i += 1) {
      const gap = steps[i].light - steps[i - 1].light;
      assert.ok(
        gap >= MIN_SEPARATION,
        `mono ${mode}: ${steps[i - 1].status} and ${steps[i].status} sit ${gap.toFixed(4)} apart in luminance, under the ${MIN_SEPARATION} floor`,
      );
    }
  }
});

/**
 * CSS hex literals only. Ordered longest-first and boundary-anchored so the log fixtures' job
 * ids (`job#8241`) are not mistaken for a four-digit `#rgba`.
 */
const CSS_HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/gu;

test("fixtures carry no raw hex, which the theme layer cannot reach", () => {
  const source = readFileSync(
    new URL("../src/data/fixtures.ts", import.meta.url),
    "utf8",
  );

  assert.equal(
    source.match(CSS_HEX),
    null,
    "fixture colours are written straight into style={{ background }}, so a literal hex survives every family and both modes unchanged",
  );
});

test("any token the fixtures name is defined by all four families in both modes", () => {
  const source = readFileSync(
    new URL("../src/data/fixtures.ts", import.meta.url),
    "utf8",
  );
  const tokens = new Set(
    Array.from(source.matchAll(/var\((--anc-[a-z-]+)\)/gu), (match) => match[1]),
  );
  // Naming none is the better outcome, not a failure: fixtures carrying no colour at all
  // cannot drift from the theme. The check is that anything they DO name resolves.

  for (const theme of THEMES) {
    const { dark, light } = themeBlocks(theme);
    for (const token of tokens) {
      for (const [mode, block] of [
        ["dark", dark],
        ["light", light],
      ]) {
        assert.ok(
          block.includes(`${token}:`),
          `${theme} ${mode} does not define ${token}, which the fixtures reference`,
        );
      }
    }
  }
});

test("no stylesheet paints status text with a raw status token", () => {
  const sheets = readFileSync(
    new URL("../src/main.jsx", import.meta.url),
    "utf8",
  )
    .split("\n")
    .flatMap((line) => /import "\.\/styles\/(.+\.css)"/u.exec(line)?.[1] ?? []);
  assert.ok(sheets.length > 0, "expected main.jsx to import the stylesheets");

  const offenders = [];
  for (const sheet of sheets) {
    const css = readFileSync(
      new URL(`../src/styles/${sheet}`, import.meta.url),
      "utf8",
    );
    css.split("\n").forEach((line, index) => {
      if (/(?<![a-z-])color:\s*var\(--anc-(success|danger|warning|violet|accent)\)/u.test(line)) {
        offenders.push(`${sheet}:${index + 1} ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `status text must use the -fg token so light and dark both clear AA:\n${offenders.join("\n")}`,
  );
});
