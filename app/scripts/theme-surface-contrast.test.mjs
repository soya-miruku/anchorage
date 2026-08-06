import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Whether each theme is still the theme the handoff describes.
 *
 * This file used to be a contrast ratchet: it recorded what every surface and edge measured and
 * failed if any of them got flatter. The intent was right and the standard was wrong. It read
 * WCAG 1.4.11 as asking 3:1 of any visible boundary, so it drove `--anc-line-border` and
 * `--anc-line-strong` from the handoff's 1.28-1.50 against the panel up to 2.2-3.0 in all twelve
 * combinations. 1.4.11 does not ask that. It covers the boundary of a control where that boundary
 * is what identifies the control — not a separator between two regions, and not a card edge.
 *
 * What the ratchet actually produced was a hard grey rule everywhere the design wanted a tinted
 * hairline, in every family and both modes at once, reported as "our separation lines, border
 * colors, size and shape of badges, many small things like this so out of place". The same pass
 * replaced the handoff's `--hairline` — a color-mix of the border, so it carries the family's hue
 * — with a flat white or black wash, and lifted six steps of the recessive ink ramp onto so few
 * distinct values that github/light collapsed `--fg-2` through `--fg-7` onto one colour.
 *
 * So the check is now fidelity rather than measurement: the handoff HTML is in the repository,
 * it is parsed here, and the surfaces, lines and palette must equal it. A number cannot drift
 * from a source of truth that is read on every run. The genuinely measured properties that
 * remain are the ones the handoff does not settle — the AA floor on ink and on filled controls —
 * and they are stated as what they are, deviations from the handoff with a reason.
 */

const themeDirectory = new URL("../src/styles/themes/", import.meta.url);
const handoffPath = new URL(
  "../../docs/design_handoff_anchorage/v2.5/Anchorage v2.dc.html",
  import.meta.url,
);

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

/** The handoff's own `.anc[data-theme][data-mode]` blocks, same shape. */
function readHandoffTokens() {
  const combinations = new Map();
  const html = readFileSync(fileURLToPath(handoffPath), "utf8");
  for (const [, family, mode, body] of html.matchAll(
    /\.anc\[data-theme="([a-z0-9]+)"\]\[data-mode="(dark|light)"\]\s*\{([^}]*)\}/gu,
  )) {
    const tokens = new Map();
    for (const [, name, value] of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;}]+)/gu)) {
      tokens.set(name, value.trim());
    }
    combinations.set(`${family}/${mode}`, tokens);
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
 * `color-mix(in srgb, var(--x) N%, transparent)` is handled because `--anc-line-hairline` is
 * defined that way: it is the border at 62%, and comparing it as though it were opaque would
 * report a contrast it never actually has on screen.
 */
function resolve(value, tokens, backdrop, depth = 0) {
  if (depth > 6 || typeof value !== "string") return null;
  const trimmed = value.trim();

  const variable = /^var\((--anc-[a-z0-9-]+)\)$/u.exec(trimmed);
  if (variable) {
    return resolve(tokens.get(variable[1]), tokens, backdrop, depth + 1);
  }

  const mixed =
    /^color-mix\(\s*in srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/u.exec(trimmed);
  if (mixed) {
    const base = resolve(mixed[1], tokens, backdrop, depth + 1);
    if (!base || !backdrop) return base;
    return composite(base, Number(mixed[2]) / 100, backdrop);
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
 * Handoff token -> app token, for everything copied across unchanged.
 *
 * `--bd-soft` is absent on purpose: the app has no consumer for a fourth solid edge, and the
 * register it would occupy is filled by `--anc-line-hairline`, which is the handoff's own
 * `--hairline` instead. `--fg-4` through `--fg-7` are absent because they are the lifted tail;
 * the ink ramp test below covers them.
 */
const HANDOFF_EQUIVALENTS = {
  shadow: "frame-shadow",
  desk: "desk",
  glow: "desk-glow",
  app: "app",
  panel: "panel",
  well: "input",
  muted: "surface-elevated",
  header: "table-head",
  bd: "line-border",
  "bd-strong": "line-strong",
  fg: "text-primary",
  "fg-strong": "text-strong",
  "fg-body": "text-body",
  "fg-mono": "text-mono",
  "fg-2": "text-secondary",
  "fg-3": "text-muted",
  accent: "accent",
  "accent-hi": "accent-hover",
  primary: "action-primary",
  "primary-fg": "on-action",
  "primary-hi": "action-primary-hover",
  green: "success",
  amber: "warning",
  red: "danger",
  violet: "violet",
  blue: "blue",
  close: "control-close",
};

const normalise = (value) => value.toLowerCase().replace(/\s+/gu, "");

test("every theme and mode the app ships is one the handoff defines", () => {
  const combinations = readThemeTokens();
  // A parse that silently loses tokens would let everything below pass on nothing at all, which
  // is exactly what happened when a comment was read as a declaration. Every family defines the
  // same set, so an outlier count means the parse broke rather than the theme changed.
  const counts = [...combinations.values()].map((tokens) => tokens.size);
  assert.equal(
    new Set(counts).size,
    1,
    `theme token counts disagree (${counts.join(", ")}) — a block probably failed to parse`,
  );

  const handoff = readHandoffTokens();
  assert.ok(handoff.size > 0, "the handoff HTML did not parse");
  const unknown = [...combinations.keys()].filter((key) => !handoff.has(key));
  assert.deepEqual(
    unknown,
    [],
    "a family or mode exists in the app that the handoff does not define",
  );
});

test("surfaces, lines and palette are the handoff's, value for value", () => {
  /*
   * The whole point of this file. A theme family owns colour and nothing else, and the handoff
   * is where that colour is decided; anything here that disagrees with it is drift, whether it
   * arrived by hand or by a well-meant contrast pass.
   *
   * Deviating is allowed — it just has to be done here, by name, with the reason.
   *
   * Monochrome is the one family that has to. With hue removed, lightness is the only channel
   * left to tell one status from another, and the handoff's own greys do not use it: success
   * #cfcfcf and accent #d0d0d0 sit 0.007 apart in luminance, which is one value, and warning
   * and violet land under AA on their own chip fills in both modes. `theme-integrity.test.mjs`
   * holds mono to a 0.02 luminance floor between adjacent statuses, and that test is the point
   * of the family — six statuses nobody can tell apart is not a monochrome theme, it is a
   * broken one. Every other mono token, including all six surfaces and both line registers,
   * is the handoff's.
   */
  const ALLOWED_DEVIATIONS = new Set([
    "mono/dark --anc-accent",
    "mono/dark --anc-success",
    "mono/dark --anc-warning",
    "mono/dark --anc-danger",
    "mono/dark --anc-violet",
    "mono/dark --anc-blue",
    "mono/light --anc-accent",
    "mono/light --anc-success",
    "mono/light --anc-warning",
    "mono/light --anc-violet",
    "mono/light --anc-blue",
  ]);

  const handoff = readHandoffTokens();
  const drift = [];
  for (const [combination, tokens] of readThemeTokens()) {
    const source = handoff.get(combination);
    if (!source) continue;
    for (const [handoffName, appName] of Object.entries(HANDOFF_EQUIVALENTS)) {
      const want = source.get(handoffName);
      const got = tokens.get(`--anc-${appName}`);
      if (want === undefined) continue;
      if (ALLOWED_DEVIATIONS.has(`${combination} --anc-${appName}`)) continue;
      if (got === undefined) {
        drift.push(`${combination}: --anc-${appName} is not defined`);
      } else if (normalise(got) !== normalise(want)) {
        drift.push(`${combination}: --anc-${appName} is ${got}, handoff says ${want}`);
      }
    }
  }
  assert.deepEqual(drift, [], "a theme has drifted from the handoff");
});

test("the hairline is the border softened, not a wash laid over it", () => {
  /*
   * The handoff defines `--hairline` as `color-mix(in srgb, var(--bd) 62%, transparent)`. Written
   * that way it inherits the family's hue and follows the border whenever the border moves. It
   * had been replaced by `rgba(255,255,255,0.045)` and `rgba(23,23,26,0.055)` — a neutral wash,
   * the same in every family, and 0.06 lighter than the border it was standing in for.
   *
   * Asserted structurally rather than by measurement, because the number is a consequence: what
   * matters is that one token derives from the other, so they cannot come apart again.
   */
  for (const [combination, tokens] of readThemeTokens()) {
    const hairline = tokens.get("--anc-line-hairline");
    assert.ok(hairline, `${combination} does not define --anc-line-hairline`);
    assert.equal(
      normalise(hairline),
      normalise("color-mix(in srgb, var(--anc-line-border) 62%, transparent)"),
      `${combination}: the hairline no longer derives from the border`,
    );
  }
});

test("every mode keeps its edges in the order their names imply", () => {
  /*
   * `--anc-line-strong` once measured *weaker* than `--anc-line-control` in four of six light
   * families, so a rule reaching for the strongest edge quietly got a fainter one. Both now
   * resolve to the handoff's `--bd-strong` — the register it draws inputs, toggle rings and
   * dashed wells with — so this holds by equality rather than by margin, which is why it is
   * `>=`. They stay two names because they carry different intent; if one ever needs to move,
   * this is what stops it moving the wrong way.
   */
  for (const [combination, tokens] of readThemeTokens()) {
    const panel = resolve(tokens.get("--anc-panel"), tokens);
    const edge = (token) => contrast(resolve(tokens.get(token), tokens, panel), panel);
    const hairline = edge("--anc-line-hairline");
    const border = edge("--anc-line-border");
    const control = edge("--anc-line-control");
    const strong = edge("--anc-line-strong");
    assert.ok(
      strong >= control && control >= border && border >= hairline,
      `${combination}: edges are out of order — hairline ${hairline.toFixed(2)}, border ${border.toFixed(2)}, control ${control.toFixed(2)}, strong ${strong.toFixed(2)}`,
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

test("every filled control can be read in every theme and mode", () => {
  /*
   * The primary button's label measured 1.05 against its own fill in y2k light — white on lime,
   * invisible — and the danger button sat at 3.62-4.03 in four more, because each theme inked it
   * with its own warm paper colour and that costs the half point that clears AA on a mid-red.
   *
   * The button ink is also why `--anc-on-action` exists. `--anc-on-accent` was doing two jobs:
   * ink on the primary action fill, and fill for the knob, tick and dot that sit on an accent
   * surface. In magnetic dark those want opposite colours — dark ink reads 9.99 on the accent
   * surfaces and 3.74 on the deep-red button — so no single value could serve both.
   *
   * 4.5 rather than 3.0 throughout: every one of these is a text label, and none of it is large.
   */
  const PAIRS = [
    ["--anc-on-action", "--anc-action-primary"],
    ["--anc-on-danger", "--anc-danger"],
  ];
  const failures = [];
  for (const [combination, tokens] of readThemeTokens()) {
    for (const [inkToken, fillToken] of PAIRS) {
      const ink = resolve(tokens.get(inkToken), tokens);
      const fill = resolve(tokens.get(fillToken), tokens);
      assert.ok(ink && fill, `${combination} does not define ${inkToken} and ${fillToken}`);
      const measured = contrast(ink, fill);
      if (measured < 4.5) {
        failures.push(`${combination}: ${inkToken} on ${fillToken} is ${measured.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("the de-emphasis ramp stays readable, and stays a ramp", () => {
  /*
   * The one place the app knowingly leaves the handoff. `--fg-5` and `--fg-6` measure 2.71-3.95
   * on panel across the dark families, and `--anc-text-dimmer` and `--anc-text-faint` carry 130
   * call sites of 10-11px label between them — small text, so AA is 4.5 and not 3.0.
   *
   * Each is lifted by the smallest step toward `--fg-2` that reaches the floor. Toward `--fg-2`
   * rather than toward `--fg`, because nous dark splits the ramp by temperature on purpose —
   * warm cream for emphasis, cool blue for anything receding — and pulling a receding step
   * toward the cream desaturates it out of the family it belongs to.
   *
   * Both properties are asserted, and the second matters as much as the first: pinning every
   * failing step to exactly 4.5 clears the floor and collapses the ramp, which is how
   * github/light ended up with `--fg-2` through `--fg-7` all on #656d76.
   */
  for (const [combination, tokens] of readThemeTokens()) {
    const panel = resolve(tokens.get("--anc-panel"), tokens);
    const step = (name) => contrast(resolve(tokens.get(`--anc-text-${name}`), tokens), panel);
    const names = ["secondary", "muted", "dim", "dimmer", "faint", "quiet"];
    const measured = names.map(step);

    names.forEach((name, index) => {
      assert.ok(
        measured[index] >= 4.5,
        `${combination}: --anc-text-${name} is ${measured[index].toFixed(2)}, under AA`,
      );
    });
    for (let index = 1; index < names.length; index += 1) {
      assert.ok(
        measured[index] <= measured[index - 1] + 0.01,
        `${combination}: the ramp is out of order at ${names[index]} — ${names.map((name, i) => `${name} ${measured[i].toFixed(2)}`).join(", ")}`,
      );
    }
    // `quiet` takes `faint` and `dim` is the midpoint of its neighbours, so four distinct values
    // is the most this can have. Fewer means a lift flattened something.
    assert.ok(
      new Set(measured.map((value) => value.toFixed(2))).size >= 4,
      `${combination}: the ramp has collapsed — ${measured.map((value) => value.toFixed(2)).join(", ")}`,
    );
  }
});

test("the volume name cell clips, whatever element it is", () => {
  /*
   * `.volume-row` truncated `> span`. The name cell was then changed from a span to a button so
   * it could open the file browser, and a 64-character volume name immediately rendered on top
   * of the DRIVER column — reported as the table looking "duplicated and glitchy".
   *
   * Scoped to this one rule on purpose. Sweeping every row that truncates a span produced four
   * more findings, none of which renders a button in that position, and a check that cries wolf
   * four times out of five teaches people to add rules they do not need.
   *
   * Worth stating plainly: nothing else in this gate can see a layout regression. jsdom does no
   * layout, and the volume browser is not one of the captured design states. A CSS rule that
   * silently stops matching an element is invisible to every other test here.
   */
  const css = stripComments(
    readFileSync(new URL("../src/styles/resources.css", import.meta.url), "utf8"),
  );
  const rule = /([^{}]*\.volume-row *> *span[^{}]*)\{([^{}]*)\}/u.exec(css);
  assert.ok(rule, "expected .volume-row to truncate its cells");
  assert.match(rule[2], /text-overflow:\s*ellipsis/u);
  assert.match(
    rule[1],
    /\.volume-row *> *button/u,
    "the name cell is a button; a rule naming only > span leaves it unable to clip",
  );
});
