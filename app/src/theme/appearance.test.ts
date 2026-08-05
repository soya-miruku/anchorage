// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import {
  APPEARANCE_STORAGE_KEY,
  COLOR_MODES,
  DEFAULT_APPEARANCE,
  THEME_FAMILIES,
  applyAppearancePreference,
  initializeAppearance,
  isAppearancePreference,
  isCaptureAppearanceRequest,
  isDesignCaptureRequest,
  applyDesignCaptureMode,
  persistAppearancePreference,
  readAppearancePreference,
  resolveAppearancePreference,
  type AppearancePreference,
  type AppearanceStorage,
  THEME_OPTIONS,
  isThemeFamily,
  themeCornerDefault,
  withFamily,
} from "./appearance";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  const storage: AppearanceStorage = {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key, next) => {
      value = next;
    }),
  };
  return { storage, read: () => value };
}

describe("appearance preferences", () => {
  it("accepts every supported family and colour-mode pair", () => {
    for (const family of THEME_FAMILIES) {
      for (const mode of COLOR_MODES) {
        const preference = {
          family,
          mode,
          corners: themeCornerDefault(family),
          cornersChosen: false,
        };
        expect(isAppearancePreference(preference)).toBe(true);
        expect(
          resolveAppearancePreference(JSON.stringify(preference)),
        ).toEqual(preference);
      }
    }
  });

  it.each([
    null,
    "",
    "not-json",
    "[]",
    "{}",
    '{"family":"default"}',
    '{"mode":"dark"}',
    '{"family":"unknown","mode":"dark"}',
    '{"family":"default","mode":"system"}',
    '{"family":"default","mode":"dark","extra":true}',
  ])("fails malformed storage closed to Nous Dark: %s", (serialized) => {
    expect(resolveAppearancePreference(serialized)).toEqual(
      DEFAULT_APPEARANCE,
    );
  });

  it("carries a stored `default` forward as `nous` rather than discarding it", () => {
    // The house family was renamed, not removed. Treating the old name as unknown would
    // quietly reset a choice the user made, and quietly is the problem — falling back to
    // Nous Dark from a stored Nous Light looks like the setting simply does not stick.
    expect(
      resolveAppearancePreference('{"family":"default","mode":"light"}'),
    ).toEqual({
      family: "nous",
      mode: "light",
      corners: "rounded",
      cornersChosen: false,
    });
  });

  it("still rejects a renamed family carrying an invalid mode", () => {
    expect(
      resolveAppearancePreference('{"family":"default","mode":"sepia"}'),
    ).toEqual(DEFAULT_APPEARANCE);
  });

  it("fails storage read errors closed to Default Dark", () => {
    const storage: AppearanceStorage = {
      getItem: vi.fn(() => {
        throw new Error("storage unavailable");
      }),
      setItem: vi.fn(),
    };
    expect(readAppearancePreference({ storage })).toEqual(DEFAULT_APPEARANCE);
  });

  it("treats any capture query value as deterministic Default Dark", () => {
    for (const search of [
      "?capture",
      "?capture=",
      "?capture=dashboard",
      "?other=1&capture=github-light",
    ]) {
      expect(isCaptureAppearanceRequest(search)).toBe(true);
      expect(
        resolveAppearancePreference(
          '{"family":"github","mode":"light"}',
          search,
        ),
      ).toEqual(DEFAULT_APPEARANCE);
    }
    expect(isCaptureAppearanceRequest("?captureMode=1")).toBe(false);
  });

  it("keeps the design-capture flag separate from the appearance-capture flag", () => {
    // These must not alias. `capture` forces Default Dark and changes which Settings
    // navigation rows render; `designCapture` only suppresses values that vary between runs.
    // Conflating them would silently change what the design gate is comparing.
    expect(isDesignCaptureRequest("?capture=dashboard")).toBe(false);
    expect(isCaptureAppearanceRequest("?designCapture=1")).toBe(false);
    for (const search of [
      "?designCapture",
      "?designCapture=1",
      "?capture=dashboard&designCapture=1",
    ]) {
      expect(isDesignCaptureRequest(search)).toBe(true);
    }
  });

  it("marks the document for animation freezing only under design capture", () => {
    const root = document.createElement("html");
    expect(applyDesignCaptureMode("?capture=dashboard", root)).toBe(false);
    expect(root.hasAttribute("data-design-capture")).toBe(false);

    expect(applyDesignCaptureMode("?capture=dashboard&designCapture=1", root)).toBe(
      true,
    );
    expect(root.getAttribute("data-design-capture")).toBe("true");
  });

  it("does not read or overwrite persistent preferences during capture", () => {
    const { storage } = memoryStorage(
      '{"family":"github","mode":"light"}',
    );
    expect(
      readAppearancePreference({ storage, search: "?capture=settings" }),
    ).toEqual(DEFAULT_APPEARANCE);
    expect(storage.getItem).not.toHaveBeenCalled();

    expect(
      persistAppearancePreference(
        { family: "docker", mode: "dark", corners: "rounded", cornersChosen: false },
        { storage, search: "?capture=settings" },
      ),
    ).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("persists the exact validated preference and contains write errors", () => {
    const { storage, read } = memoryStorage();
    const preference: AppearancePreference = {
      family: "docker",
      mode: "light",
      corners: "rounded",
      cornersChosen: false,
    };
    expect(persistAppearancePreference(preference, { storage })).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify(preference),
    );
    expect(read()).toBe(JSON.stringify(preference));

    const unavailable: AppearanceStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new Error("quota exceeded");
      }),
    };
    expect(
      persistAppearancePreference(preference, { storage: unavailable }),
    ).toBe(false);
  });

  it("applies the family, colour mode, and native colour-scheme together", () => {
    const root = document.documentElement;
    expect(
      applyAppearancePreference(
        { family: "github", mode: "light", corners: "rounded", cornersChosen: false },
        root,
      ),
    ).toEqual({ family: "github", mode: "light", corners: "rounded", cornersChosen: false });
    expect(root).toHaveAttribute("data-theme", "github");
    expect(root).toHaveAttribute("data-color-mode", "light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("initializes from valid storage but still applies capture Default Dark", () => {
    const { storage } = memoryStorage(
      '{"family":"docker","mode":"light"}',
    );
    expect(
      initializeAppearance({
        storage,
        search: "",
        root: document.documentElement,
      }),
    ).toEqual({ family: "docker", mode: "light", corners: "rounded", cornersChosen: false });

    expect(
      initializeAppearance({
        storage,
        search: "?capture=canonical",
        root: document.documentElement,
      }),
    ).toEqual(DEFAULT_APPEARANCE);
    expect(document.documentElement).toHaveAttribute(
      "data-theme",
      "nous",
    );
    expect(document.documentElement).toHaveAttribute(
      "data-color-mode",
      "dark",
    );
  });
});

/**
 * v2.5 adds a third appearance axis and two families.
 *
 * Corners is independent of the palette: a theme *suggests* a default (Magnetic and Y2K are drawn
 * square, the others rounded) and the operator can override it. Once they have chosen explicitly,
 * switching theme must stop moving it — otherwise picking a new palette silently undoes a
 * decision they made.
 *
 * The stored preference was two keys and is now three, so an existing one has to migrate rather
 * than fall back: dropping it would reset the appearance of everyone who had already chosen.
 */
describe("corner style", () => {
  it("suggests square for the families drawn that way, rounded for the rest", () => {
    expect(themeCornerDefault("magnetic")).toBe("square");
    expect(themeCornerDefault("y2k")).toBe("square");
    expect(themeCornerDefault("nous")).toBe("rounded");
    expect(themeCornerDefault("docker")).toBe("rounded");
    expect(themeCornerDefault("github")).toBe("rounded");
    expect(themeCornerDefault("mono")).toBe("rounded");
  });

  it("keeps a stored two-key preference instead of discarding it", () => {
    const stored = JSON.stringify({ family: "docker", mode: "light", corners: "rounded", cornersChosen: false });
    const resolved = resolveAppearancePreference(stored);
    expect(resolved.family).toBe("docker");
    expect(resolved.mode).toBe("light");
    // No explicit choice was recorded, so the theme's own suggestion applies.
    expect(resolved.corners).toBe("rounded");
    expect(resolved.cornersChosen).toBe(false);
  });

  it("restores an explicit corner choice", () => {
    const stored = JSON.stringify({
      family: "nous",
      mode: "dark",
      corners: "square",
      cornersChosen: true,
    });
    const resolved = resolveAppearancePreference(stored);
    expect(resolved.corners).toBe("square");
    expect(resolved.cornersChosen).toBe(true);
  });

  it("moves corners with the theme only while the operator has not chosen", () => {
    const following = withFamily(
      { family: "nous", mode: "dark", corners: "rounded", cornersChosen: false },
      "y2k",
    );
    expect(following.corners).toBe("square");

    const chosen = withFamily(
      { family: "nous", mode: "dark", corners: "rounded", cornersChosen: true },
      "y2k",
    );
    expect(chosen.corners).toBe("rounded");
  });

  it("stamps the axis on the root so CSS can square everything", () => {
    const root = document.createElement("div");
    applyAppearancePreference(
      { family: "y2k", mode: "dark", corners: "square", cornersChosen: true },
      root,
    );
    expect(root.getAttribute("data-theme")).toBe("y2k");
    expect(root.getAttribute("data-corners")).toBe("square");
  });

  it("rejects a corner value it does not recognise rather than stamping it", () => {
    const stored = JSON.stringify({ family: "nous", mode: "dark", corners: "bevelled" });
    expect(resolveAppearancePreference(stored).corners).toBe("rounded");
  });
});

describe("the families v2.5 adds", () => {
  it("accepts magnetic and y2k as stored preferences", () => {
    expect(isThemeFamily("magnetic")).toBe(true);
    expect(isThemeFamily("y2k")).toBe(true);
  });

  it("offers every family it accepts, so nothing is selectable-but-unlisted", () => {
    expect(THEME_OPTIONS.map((option) => option.id).sort()).toEqual(
      [...THEME_FAMILIES].sort(),
    );
  });
});
