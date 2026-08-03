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
        const preference = { family, mode };
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
  ])("fails malformed storage closed to Default Dark: %s", (serialized) => {
    expect(resolveAppearancePreference(serialized)).toEqual(
      DEFAULT_APPEARANCE,
    );
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
        { family: "docker", mode: "dark" },
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
        { family: "github", mode: "light" },
        root,
      ),
    ).toEqual({ family: "github", mode: "light" });
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
    ).toEqual({ family: "docker", mode: "light" });

    expect(
      initializeAppearance({
        storage,
        search: "?capture=canonical",
        root: document.documentElement,
      }),
    ).toEqual(DEFAULT_APPEARANCE);
    expect(document.documentElement).toHaveAttribute(
      "data-theme",
      "default",
    );
    expect(document.documentElement).toHaveAttribute(
      "data-color-mode",
      "dark",
    );
  });
});
