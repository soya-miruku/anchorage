/**
 * The colour painted behind the window before the renderer has drawn anything.
 *
 * Electron needs a background before the first frame exists, and getting it wrong is visible:
 * the window flashes one colour and then becomes another. It used to be a literal Nous blue,
 * which was right while Nous was the default and became a blue flash in front of a near-black
 * UI the moment v2.5 made Y2K the default.
 *
 * So it is derived from whichever family is the default rather than written down twice. The main
 * process cannot read the stylesheets — it has no DOM and the CSS is bundled — so the values are
 * mirrored here, and `theme-desk.test.mjs` asserts every one of them still equals that family's
 * own `--anc-desk` and that DEFAULT_FAMILY still matches DEFAULT_APPEARANCE. A mirror nobody
 * checks is just a second place to be wrong.
 *
 * This is only the pre-reveal colour. Once the renderer is up it reports its real background and
 * the window is updated, so a stored preference is honoured a frame later regardless.
 */

/** Each family's `--anc-desk` in dark mode — the surface the app frame floats on. */
export const DESK_COLORS = Object.freeze({
  nous: "#061c56",
  docker: "#061220",
  github: "#010409",
  mono: "#0a0a0a",
  magnetic: "#0b0a09",
  y2k: "#06060a",
});

/** Must equal `DEFAULT_APPEARANCE.family` in src/theme/appearance.ts. */
export const DEFAULT_FAMILY = "y2k";

export function defaultDeskColor() {
  const color = DESK_COLORS[DEFAULT_FAMILY];
  if (!color) {
    throw new Error(`No desk colour recorded for the default family ${DEFAULT_FAMILY}`);
  }
  return color;
}
