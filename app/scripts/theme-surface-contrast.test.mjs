import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Whether a surface has an edge you can see, in every theme and both modes.
 *
 * `theme-integrity.test.mjs` covers ink: status foregrounds move away from their fill, the
 * fixtures name no raw hex, and no stylesheet paints status text with a fill token. All of that
 * is about text, and text was not what went wrong.
 *
 * The report was "it looks very ugly especially in light mode". Measuring the ink ramp said that
 * could not be it — light mode is *better* than dark on every text token (nous/light muted 7.26
 * against nous/dark 5.16), and every below-AA failure in the set was a dark mode one. What was
 * actually weak was structure. A card is drawn as `--anc-panel` inside `--anc-app` with a
 * `--anc-line-border` edge, and in light mode those three were nearly the same colour:
 * nous/light measured panel:app 1.044 and border:panel 1.163, against a 3:1 minimum for a
 * non-text boundary. Light read worse than dark for two compounding reasons — it had less
 * separation to start with (1.044 against dark's 1.114) and equal ratios are harder to see at
 * high luminance, so a near-white card on a near-white page with a near-white border had no edge
 * at all. The tell was y2k/light, the one light theme with a real border, and the one nobody
 * complained about.
 *
 * The light-mode line tokens have since been raised, and given a hierarchy they did not have:
 * `strong` used to measure *weaker* than `control` in four of six families, which is backwards
 * for a token by that name. Light now runs border 2.2, control 2.6, strong 3.0. `hairline` was
 * deliberately left alone — it is a decorative seam, invisible everywhere, and the last test
 * here pins that so nobody mistakes it for a divider.
 *
 * Dark mode was not changed and is now the weaker side: border 1.12–1.28, strong 1.28–1.71.
 * That is a live decision rather than an oversight, which is exactly why this file is a ratchet
 * and not an assertion of a good number. It records what each combination measures today and
 * fails if any of them gets flatter, so the remaining decision stays open while the flatness
 * cannot quietly deepen.
 */

const themeDirectory = new URL("../src/styles/themes/", import.meta.url);

/**
 * Comments are stripped before anything is parsed.
 *
 * Not defensive programming — this was a real miss. A comment written to explain why one token
 * differs from its neighbours contained the phrase `--anc-action-primary:` mid-sentence, and a
 * naive `--anc-x: value;` scan read it as a declaration and swallowed the rest of the block up
 * to the next semicolon. Twelve tokens vanished from that theme and every assertion here still
 * passed, because what was lost happened not to be what was asserted.
 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}

function themeSources() {
  return readdirSync(fileURLToPath(themeDirectory))
    .filter((name) => name.endsWith(".css") && name !== "index.css")
    .map((name) => stripComments(readFileSync(new URL(name, themeDirectory), "utf8")));
}

/** Every `[data-theme][data-color-mode]` block, as a token map keyed by family and mode. */
function readThemeTokens() {
  const combinations = new Map();
  for (const css of themeSources()) {
    const blocks = css.matchAll(
      /:root\[data-theme="([a-z0-9]+)"\]\[data-color-mode="(light|dark)"\]\s*\{([\s\S]*?)\n\}/gu,
    );
    for (const [, family, mode, body] of blocks) {
      const tokens = new Map();
      for (const [, name, value] of body.matchAll(
        /(--anc-[a-z0-9-]+)\s*:\s*([^;]+);/gu,
      )) {
        tokens.set(name, value.trim());
      }
      combinations.set(`${family}/${mode}`, tokens);
    }
  }
  return combinations;
}

function composite(colour, alpha, backdrop) {
  return colour.map((channel, index) =>
    Math.round(channel * alpha + backdrop[index] * (1 - alpha)),
  );
}

/**
 * Resolves a token to RGB, following `var()` and compositing any alpha over the backdrop.
 *
 * The compositing matters: `--anc-line-hairline` is an rgba white or black, and comparing it as
 * though it were opaque would report a contrast it never actually has on screen.
 */
function resolve(value, tokens, backdrop, depth = 0) {
  if (depth > 6 || typeof value !== "string") return null;
  const trimmed = value.trim();

  const variable = /^var\((--anc-[a-z0-9-]+)\)$/u.exec(trimmed);
  if (variable) {
    return resolve(tokens.get(variable[1]), tokens, backdrop, depth + 1);
  }

  const hex = /^#([0-9a-f]{6})$/iu.exec(trimmed);
  if (hex) {
    return [0, 2, 4].map((offset) =>
      Number.parseInt(hex[1].slice(offset, offset + 2), 16),
    );
  }

  const functional =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?)\s*)?\)$/u.exec(
      trimmed,
    );
  if (functional) {
    const channels = [1, 2, 3].map((index) => Number(functional[index]));
    const rawAlpha = functional[4];
    if (rawAlpha === undefined) return channels;
    const alpha = rawAlpha.endsWith("%")
      ? Number(rawAlpha.slice(0, -1)) / 100
      : Number(rawAlpha);
    return backdrop ? composite(channels, alpha, backdrop) : channels;
  }
  return null;
}

function relativeLuminance([red, green, blue]) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  );
}

function contrast(left, right) {
  const [lighter, darker] = [
    relativeLuminance(left),
    relativeLuminance(right),
  ].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The measured floor for each combination, to two decimal places, rounded down.
 *
 * Light-mode values are the raised ones and are close to their targets. Dark-mode values are
 * what dark has always measured, and every one of them is below the 3:1 a visible boundary
 * needs. Neither set is a target; both are a floor.
 */
const SURFACE_FLOORS = {
  "docker/dark": { panel: 1.09, border: 1.21, control: 2.04, strong: 1.41 },
  "docker/light": { panel: 1.04, border: 2.2, control: 2.6, strong: 3.01 },
  "github/dark": { panel: 1.09, border: 1.13, control: 1.41, strong: 1.41 },
  "github/light": { panel: 1.06, border: 2.22, control: 2.61, strong: 3.01 },
  "magnetic/dark": { panel: 1.06, border: 1.28, control: 1.71, strong: 1.71 },
  "magnetic/light": { panel: 1.08, border: 2.22, control: 2.62, strong: 3.01 },
  "mono/dark": { panel: 1.08, border: 1.12, control: 1.77, strong: 1.34 },
  "mono/light": { panel: 1.04, border: 2.2, control: 2.63, strong: 3.01 },
  "nous/dark": { panel: 1.11, border: 1.23, control: 1.58, strong: 1.28 },
  "nous/light": { panel: 1.04, border: 2.22, control: 2.6, strong: 3.0 },
  "y2k/dark": { panel: 1.07, border: 1.28, control: 2.07, strong: 2.07 },
  "y2k/light": { panel: 1.07, border: 17.45, control: 17.45, strong: 17.45 },
};

test("every theme and mode is measured, so a new family cannot skip the ratchet", () => {
  const combinations = readThemeTokens();
  // A parse that silently loses tokens would let the ratchet pass on nothing at all, which is
  // exactly what happened when a comment was read as a declaration. Every family defines the
  // same set, so an outlier count means the parse broke rather than the theme changed.
  const counts = [...combinations.values()].map((tokens) => tokens.size);
  assert.equal(
    new Set(counts).size,
    1,
    `theme token counts disagree (${counts.join(", ")}) — a block probably failed to parse`,
  );
  const measured = [...combinations.keys()].sort();
  assert.deepEqual(
    measured,
    Object.keys(SURFACE_FLOORS).sort(),
    "a theme family or mode was added or removed without recording its surface floors",
  );
});

test("no surface gets flatter than it already is", () => {
  const EDGES = [
    ["--anc-line-border", "border"],
    ["--anc-line-control", "control"],
    ["--anc-line-strong", "strong"],
  ];
  const regressions = [];
  for (const [combination, tokens] of readThemeTokens()) {
    const app = resolve(tokens.get("--anc-app"), tokens);
    const panel = resolve(tokens.get("--anc-panel"), tokens);
    assert.ok(app && panel, `${combination} does not define --anc-app and --anc-panel`);

    const floors = SURFACE_FLOORS[combination];
    const panelRatio = contrast(panel, app);
    if (panelRatio < floors.panel) {
      regressions.push(
        `${combination}: panel against app fell to ${panelRatio.toFixed(3)}, floor ${floors.panel}`,
      );
    }
    for (const [token, name] of EDGES) {
      const edge = resolve(tokens.get(token), tokens, panel);
      assert.ok(edge, `${combination} does not define ${token}`);
      const measured = contrast(edge, panel);
      if (measured < floors[name]) {
        regressions.push(
          `${combination}: ${name} against panel fell to ${measured.toFixed(3)}, floor ${floors[name]}`,
        );
      }
    }
  }
  assert.deepEqual(
    regressions,
    [],
    "a surface lost separation it used to have; raising these is welcome, lowering them is not",
  );
});

test("light mode keeps its edges in the order their names imply", () => {
  /*
   * `--anc-line-strong` measured weaker than `--anc-line-control` in four of six families
   * before this was fixed, so a rule reaching for the strongest edge got a fainter one. The
   * names are the contract; this keeps them honest. Dark mode is deliberately not asserted —
   * it still has the inversion, and pinning it here would either fail the build or bless it.
   */
  for (const [combination, tokens] of readThemeTokens()) {
    if (!combination.endsWith("/light")) continue;
    const panel = resolve(tokens.get("--anc-panel"), tokens);
    const edge = (token) => contrast(resolve(tokens.get(token), tokens, panel), panel);
    const border = edge("--anc-line-border");
    const strong = edge("--anc-line-strong");
    assert.ok(
      strong >= border,
      `${combination}: --anc-line-strong (${strong.toFixed(2)}) is weaker than --anc-line-border (${border.toFixed(2)})`,
    );
  }
});

test("the hairline is recorded as decorative, because it is invisible in every theme", () => {
  /*
   * `--anc-line-hairline` measures 1.11–1.15 against the panel in all twelve combinations. It
   * is not a divider anyone can see, and a layout that depends on it to separate two regions is
   * relying on nothing. This does not fail the build — plenty of places use it as a decorative
   * seam and that is fine — but it is asserted so the number is on the record rather than
   * rediscovered by the next person who wonders why a section boundary vanished.
   */
  for (const [combination, tokens] of readThemeTokens()) {
    const panel = resolve(tokens.get("--anc-panel"), tokens);
    const hairline = resolve(tokens.get("--anc-line-hairline"), tokens, panel);
    assert.ok(hairline, `${combination} does not define --anc-line-hairline`);
    assert.ok(
      contrast(hairline, panel) < 1.6,
      `${combination} hairline is now visible enough to be load-bearing — if that was deliberate, move it out of this test`,
    );
  }
});

test("no stylesheet names a custom property nothing defines", () => {
  /*
   * An undefined `var()` does not fall back — it makes the whole declaration invalid at
   * computed-value time, so the property silently becomes its initial or inherited value.
   * `background: var(--anc-surface)` renders transparent; `color: var(--anc-text-soft)` renders
   * at the parent's colour, un-de-emphasised; `border-bottom: 1px solid var(--anc-line)` draws
   * no border at all. Nothing errors and nothing looks obviously broken, which is how thirteen
   * of these survived in four stylesheets.
   *
   * Two of them were on the capability install command box, which was therefore drawn with an
   * invisible hairline edge and no background whatsoever — a box that was not there.
   *
   * A fallback is still allowed: `var(--x, var(--y))` is a deliberate chain, not a mistake.
   */
  const styleDirectory = new URL("../src/styles/", import.meta.url);
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(fileURLToPath(directory), { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".css")) files.push([entry.name, readFileSync(child, "utf8")]);
    }
  };
  walk(styleDirectory);
  assert.ok(files.length > 0, "expected to find stylesheets");

  const defined = new Set();
  for (const [, css] of files) {
    for (const [, name] of css.matchAll(/(--anc-[a-z0-9-]+)\s*:/gu)) defined.add(name);
  }

  const undefinedRefs = [];
  for (const [name, css] of files) {
    css.split("\n").forEach((line, index) => {
      for (const [, token, delimiter] of line.matchAll(
        /var\(\s*(--anc-[a-z0-9-]+)\s*([,)])/gu,
      )) {
        if (delimiter === ",") continue; // an explicit fallback is a decision, not a typo
        if (!defined.has(token)) {
          undefinedRefs.push(`${name}:${index + 1} references ${token}, which nothing defines`);
        }
      }
    });
  }
  assert.deepEqual(undefinedRefs, []);
});
