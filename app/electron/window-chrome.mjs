import { validateWindowBackgroundColor } from "./contracts.mjs";

export function applyWindowBackgroundColor(window, value) {
  const color = validateWindowBackgroundColor(value);
  window.setBackgroundColor(color);
  return color;
}

export function toggleWindowMaximized(window) {
  if (window.isMaximized()) {
    window.unmaximize();
  } else {
    window.maximize();
  }
  return window.isMaximized();
}
