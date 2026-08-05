export const THEME_FAMILIES = [
  "nous",
  "docker",
  "github",
  "mono",
  "magnetic",
  "y2k",
] as const;
export type ThemeFamily = (typeof THEME_FAMILIES)[number];

/**
 * How corners are drawn, independent of the palette.
 *
 * v2.5 separates shape from colour: a family suggests a default — Magnetic and Y2K are drawn
 * square — and the operator may override it for any family.
 */
export const CORNER_STYLES = ["rounded", "square"] as const;
export type CornerStyle = (typeof CORNER_STYLES)[number];

export const COLOR_MODES = ["dark", "light"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export interface AppearancePreference {
  family: ThemeFamily;
  mode: ColorMode;
  corners: CornerStyle;
  /**
   * Whether the operator picked the corner style themselves.
   *
   * While false, changing family moves corners to that family's suggestion. Once true it stops,
   * because a palette change silently undoing a shape decision is the surprise this exists to
   * prevent.
   */
  cornersChosen: boolean;
}

export interface AppearanceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AppearanceRuntimeOptions {
  storage?: AppearanceStorage | null;
  search?: string;
  root?: HTMLElement | null;
}

export const THEME_OPTIONS = Object.freeze([
  {
    id: "nous",
    label: "Nous",
    description: "Royal blue surfaces under a warm psyche-cream foreground.",
  },
  {
    id: "docker",
    label: "Docker",
    description: "Docker Ocean Blue with deep-blue surfaces.",
  },
  {
    id: "github",
    label: "GitHub",
    description: "GitHub Primer canvas and semantic colours.",
  },
  {
    id: "mono",
    label: "Monochrome",
    description: "Greyscale throughout; status separates by lightness, not hue.",
  },
  {
    id: "magnetic",
    label: "Magnetic",
    description: "Warm charcoal with an amber accent and crimson primary. Square by default.",
  },
  {
    id: "y2k",
    label: "Y2K",
    description: "Hard offset shadows, acid green, ink borders. Square by default.",
  },
] satisfies ReadonlyArray<{
  id: ThemeFamily;
  label: string;
  description: string;
}>);

export const COLOR_MODE_OPTIONS = Object.freeze([
  {
    id: "dark",
    label: "Dark",
    description: "Low-luminance surfaces for dim environments.",
  },
  {
    id: "light",
    label: "Light",
    description: "High-luminance surfaces for bright environments.",
  },
] satisfies ReadonlyArray<{
  id: ColorMode;
  label: string;
  description: string;
}>);

/**
 * What a fresh install looks like.
 *
 * Y2K per the v2.5 handoff, which draws it square. This is only the default: a stored preference
 * always wins, so nobody who has already chosen a theme is moved off it. The comp goes further —
 * `pickTheme()` writes a `pack` marker and overwrites the stored theme once — and that part is
 * deliberately not reproduced, because overwriting a choice the operator made is not a default.
 *
 * `corners` follows `themeCornerDefault(family)` and must stay consistent with it; a test in
 * theme/appearance.test.ts asserts that rather than trusting the two to be edited together.
 */
export const DEFAULT_APPEARANCE: Readonly<AppearancePreference> = Object.freeze({
  family: "y2k",
  mode: "dark",
  corners: "square",
  cornersChosen: false,
});

/**
 * The corner style a family is drawn with when nobody has said otherwise.
 *
 * Deliberately not read from the stylesheets: a family's suggestion is a design statement, and
 * inferring it from a radius value would make it an accident of whichever rule was measured.
 */
export function themeCornerDefault(family: ThemeFamily): CornerStyle {
  return family === "magnetic" || family === "y2k" ? "square" : "rounded";
}

/**
 * Switches family, carrying the corner style with it only while it is still a suggestion.
 */
export function withFamily(
  preference: AppearancePreference,
  family: ThemeFamily,
): AppearancePreference {
  return {
    ...preference,
    family,
    corners: preference.cornersChosen
      ? preference.corners
      : themeCornerDefault(family),
  };
}

export function isCornerStyle(value: unknown): value is CornerStyle {
  return (
    typeof value === "string" &&
    (CORNER_STYLES as readonly string[]).includes(value)
  );
}

export const APPEARANCE_STORAGE_KEY = "anchorage.appearance.v1";

export function isThemeFamily(value: unknown): value is ThemeFamily {
  return (
    typeof value === "string" &&
    (THEME_FAMILIES as readonly string[]).includes(value)
  );
}

export function isColorMode(value: unknown): value is ColorMode {
  return (
    typeof value === "string" &&
    (COLOR_MODES as readonly string[]).includes(value)
  );
}

export function isAppearancePreference(
  value: unknown,
): value is AppearancePreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  // Compared as a set rather than by sorted position: "corners" sorts before "cornersChosen",
  // which an index-based check gets wrong in a way that silently rejects every valid record.
  const expected = ["family", "mode", "corners", "cornersChosen"];
  const keys = Object.keys(record);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key)) &&
    isThemeFamily(record.family) &&
    isColorMode(record.mode) &&
    isCornerStyle(record.corners) &&
    typeof record.cornersChosen === "boolean"
  );
}

export function isCaptureAppearanceRequest(search = ""): boolean {
  try {
    return new URLSearchParams(search).has("capture");
  } catch {
    return false;
  }
}

/**
 * The design-parity harness asks for a reproducible frame.
 *
 * Deliberately a different key from `capture`: that one selects the default appearance and
 * changes which Settings navigation rows render, which would alter what the design gate is
 * comparing. This one only suppresses values that change on their own between runs.
 */
export function isDesignCaptureRequest(search = ""): boolean {
  try {
    return new URLSearchParams(search).has("designCapture");
  } catch {
    return false;
  }
}

/**
 * Families that were renamed rather than removed.
 *
 * `default` became `nous` when the house palette was brought onto the handoff's own colours.
 * It is the same slot under a different name, so a stored `default` is a preference the user
 * still holds — dropping it to the fallback would silently discard a choice they made.
 */
const RENAMED_FAMILIES: Record<string, ThemeFamily> = { default: "nous" };

function migrateFamily(value: unknown): unknown {
  return typeof value === "string" && value in RENAMED_FAMILIES
    ? RENAMED_FAMILIES[value]
    : value;
}

/**
 * Brings a stored preference up to the current shape.
 *
 * The record was `{family, mode}` before v2.5 added corners. Anyone who had already chosen a
 * theme has one of those stored, and failing the strict check would drop them to the default —
 * resetting an appearance they picked. Corners are filled from the family's own suggestion, and
 * marked as not-yet-chosen so the first explicit choice still takes effect.
 */
function migratePreference(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  record.family = migrateFamily(record.family);
  if (!isThemeFamily(record.family)) return record;
  if (!isCornerStyle(record.corners)) {
    record.corners = themeCornerDefault(record.family);
    // A corner value that was stored but is not recognised is not a choice we can honour, so it
    // does not count as one either.
    record.cornersChosen = false;
  }
  if (typeof record.cornersChosen !== "boolean") record.cornersChosen = false;
  return record;
}

export function resolveAppearancePreference(
  serialized: string | null | undefined,
  search = "",
): AppearancePreference {
  if (isCaptureAppearanceRequest(search) || typeof serialized !== "string") {
    return { ...DEFAULT_APPEARANCE };
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    const migrated = migratePreference(parsed);
    return isAppearancePreference(migrated)
      ? {
          family: migrated.family,
          mode: migrated.mode,
          corners: migrated.corners,
          cornersChosen: migrated.cornersChosen,
        }
      : { ...DEFAULT_APPEARANCE };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

function browserStorage(): AppearanceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

function documentRoot(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

export function readAppearancePreference(
  options: Pick<AppearanceRuntimeOptions, "storage" | "search"> = {},
): AppearancePreference {
  const search = options.search ?? browserSearch();
  if (isCaptureAppearanceRequest(search)) {
    return { ...DEFAULT_APPEARANCE };
  }
  const storage =
    options.storage === undefined ? browserStorage() : options.storage;
  if (!storage) return { ...DEFAULT_APPEARANCE };
  try {
    return resolveAppearancePreference(
      storage.getItem(APPEARANCE_STORAGE_KEY),
      search,
    );
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function persistAppearancePreference(
  preference: AppearancePreference,
  options: Pick<AppearanceRuntimeOptions, "storage" | "search"> = {},
): boolean {
  const search = options.search ?? browserSearch();
  if (
    isCaptureAppearanceRequest(search) ||
    !isAppearancePreference(preference)
  ) {
    return false;
  }
  const storage =
    options.storage === undefined ? browserStorage() : options.storage;
  if (!storage) return false;
  try {
    storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(preference));
    return true;
  } catch {
    return false;
  }
}

export function applyAppearancePreference(
  preference: AppearancePreference,
  root: HTMLElement | null = documentRoot(),
): AppearancePreference {
  const resolved = isAppearancePreference(preference)
    ? preference
    : DEFAULT_APPEARANCE;
  if (root) {
    root.setAttribute("data-theme", resolved.family);
    root.setAttribute("data-color-mode", resolved.mode);
    root.setAttribute("data-corners", resolved.corners);
    root.style.colorScheme = resolved.mode;
  }
  return {
    family: resolved.family,
    mode: resolved.mode,
    corners: resolved.corners,
    cornersChosen: resolved.cornersChosen,
  };
}

/**
 * Marks the document so CSS can hold every animation at its first frame.
 *
 * Looping indicators — the engine pulse, the state spinner — were sampled at whatever phase
 * they happened to be in when the screenshot was taken, so a handful of subpixels changed
 * between otherwise identical capture runs. That is invisible to a reviewer but fatal to a
 * hash. Freezing is preferable to masking: the indicator's size, position and colour stay
 * under comparison, and only its phase — which carries no design meaning — is pinned.
 */
export function applyDesignCaptureMode(
  search = "",
  root: HTMLElement | null = documentRoot(),
): boolean {
  const active = isDesignCaptureRequest(search);
  if (root && active) {
    root.setAttribute("data-design-capture", "true");
  }
  return active;
}

export function initializeAppearance(
  options: AppearanceRuntimeOptions = {},
): AppearancePreference {
  const preference = readAppearancePreference(options);
  return applyAppearancePreference(
    preference,
    options.root === undefined ? documentRoot() : options.root,
  );
}
