export const THEME_FAMILIES = ["default", "docker", "github"] as const;
export type ThemeFamily = (typeof THEME_FAMILIES)[number];

export const COLOR_MODES = ["dark", "light"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export interface AppearancePreference {
  family: ThemeFamily;
  mode: ColorMode;
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
    id: "default",
    label: "Default",
    description: "Anchorage's original indigo palette.",
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

export const DEFAULT_APPEARANCE: Readonly<AppearancePreference> = Object.freeze({
  family: "default",
  mode: "dark",
});

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
  const keys = Object.keys(record).sort();
  return (
    keys.length === 2 &&
    keys[0] === "family" &&
    keys[1] === "mode" &&
    isThemeFamily(record.family) &&
    isColorMode(record.mode)
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

export function resolveAppearancePreference(
  serialized: string | null | undefined,
  search = "",
): AppearancePreference {
  if (isCaptureAppearanceRequest(search) || typeof serialized !== "string") {
    return { ...DEFAULT_APPEARANCE };
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isAppearancePreference(parsed)
      ? { family: parsed.family, mode: parsed.mode }
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
    root.style.colorScheme = resolved.mode;
  }
  return { family: resolved.family, mode: resolved.mode };
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
