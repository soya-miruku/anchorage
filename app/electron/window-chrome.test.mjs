import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateWindowBackgroundColor } from "./contracts.mjs";
import {
  applyWindowBackgroundColor,
  toggleWindowMaximized,
} from "./window-chrome.mjs";

function fakeWindow(initiallyMaximized) {
  let maximized = initiallyMaximized;
  const calls = [];
  return {
    calls,
    isMaximized: () => maximized,
    maximize: () => {
      calls.push("maximize");
      maximized = true;
    },
    unmaximize: () => {
      calls.push("unmaximize");
      maximized = false;
    },
  };
}

test("maximize control toggles restored windows to maximized", () => {
  const window = fakeWindow(false);
  assert.equal(toggleWindowMaximized(window), true);
  assert.deepEqual(window.calls, ["maximize"]);
});

test("maximize control toggles maximized windows back to restored", () => {
  const window = fakeWindow(true);
  assert.equal(toggleWindowMaximized(window), false);
  assert.deepEqual(window.calls, ["unmaximize"]);
});

test("native background application normalizes before reaching BrowserWindow", () => {
  const applied = [];
  const window = {
    setBackgroundColor: (color) => applied.push(color),
  };

  assert.equal(applyWindowBackgroundColor(window, "#00153C"), "#00153c");
  assert.deepEqual(applied, ["#00153c"]);
  assert.throws(
    () => applyWindowBackgroundColor(window, "rgb(0 21 60)"),
    /opaque six-digit hexadecimal color/u,
  );
  assert.deepEqual(applied, ["#00153c"]);
});

test("every theme mode exposes an opaque native-safe app background", () => {
  for (const family of ["default", "docker", "github"]) {
    const css = readFileSync(
      new URL(`../src/styles/themes/${family}.css`, import.meta.url),
      "utf8",
    );
    const colors = Array.from(
      css.matchAll(/--anc-app:\s*([^;]+);/gu),
      (match) => match[1].trim(),
    );
    assert.equal(colors.length, 2, `${family} must define dark and light app colors`);
    colors.forEach((color) => {
      assert.doesNotThrow(() => validateWindowBackgroundColor(color));
    });
  }
});
