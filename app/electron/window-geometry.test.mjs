import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ANCHORAGE_APP_HEIGHT,
  ANCHORAGE_APP_WIDTH,
  ANCHORAGE_CONTENT_HEIGHT,
  ANCHORAGE_CONTENT_WIDTH,
  ANCHORAGE_DESK_PADDING,
  ANCHORAGE_DESKTOP_SMOKE_RESIZE_TARGETS,
  ANCHORAGE_MIN_HEIGHT,
  ANCHORAGE_MIN_WIDTH,
  createAnchorageWindowFrameOptions,
  createAnchorageWindowGeometry,
  desktopViewportGeometryMismatches,
  desktopSmokeEnabled,
  observeDesktopViewportConvergence,
  shouldRequestDesktopViewportResize,
} from "./window-geometry.mjs";

test("native window opens at the application size and remains resizable to the supported minimum", () => {
  assert.deepEqual(createAnchorageWindowGeometry(), {
    width: 1_600,
    height: 1_000,
    minWidth: 1_080,
    minHeight: 700,
    useContentSize: true,
    resizable: true,
  });
  assert.ok(ANCHORAGE_MIN_WIDTH < ANCHORAGE_APP_WIDTH);
  assert.ok(ANCHORAGE_MIN_HEIGHT < ANCHORAGE_APP_HEIGHT);
});

test("Linux removes GTK title-bar chrome while retaining native resize boundaries", () => {
  assert.deepEqual(createAnchorageWindowFrameOptions("linux"), {
    frame: false,
  });
  assert.deepEqual(createAnchorageWindowFrameOptions("darwin"), {
    frame: false,
  });
  assert.deepEqual(createAnchorageWindowFrameOptions("win32"), {
    frame: false,
  });
});

test("runtime window controls have 24px hit targets while capture keeps 13px dots", () => {
  const shellCss = readFileSync(
    new URL("../src/styles/shell.css", import.meta.url),
    "utf8",
  );
  assert.match(
    shellCss,
    /\.window-control\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/su,
  );
  assert.match(
    shellCss,
    /\.window-control::before\s*\{[^}]*width:\s*13px;[^}]*height:\s*13px;/su,
  );
  assert.match(
    shellCss,
    /\.anchorage-desk--capture \.window-control\s*\{[^}]*width:\s*13px;[^}]*height:\s*13px;/su,
  );
});

test("canonical viewport preserves the exact handoff desk around the 1600x1000 app", () => {
  assert.equal(
    ANCHORAGE_CONTENT_WIDTH - ANCHORAGE_DESK_PADDING * 2,
    ANCHORAGE_APP_WIDTH,
  );
  assert.equal(
    ANCHORAGE_CONTENT_HEIGHT - ANCHORAGE_DESK_PADDING * 2,
    ANCHORAGE_APP_HEIGHT,
  );
  assert.deepEqual(
    [ANCHORAGE_CONTENT_WIDTH, ANCHORAGE_CONTENT_HEIGHT],
    [1_656, 1_056],
  );
});

test("desktop smoke covers the supported minimum and a larger viewport", () => {
  assert.deepEqual(ANCHORAGE_DESKTOP_SMOKE_RESIZE_TARGETS, [
    { width: 1_080, height: 700 },
    { width: 1_800, height: 1_100 },
  ]);
});

test("desktop viewport geometry requires native, renderer, shell, and document convergence", () => {
  const width = 1_080;
  const height = 700;
  const dimensions = () => ({
    client: [width, height],
    scroll: [width, height],
  });
  const state = {
    nativeContentSize: [width, height],
    resizable: true,
    renderer: {
      viewport: [width, height],
      surfaceMode: "viewport",
      desk: { x: 0, y: 0, width, height },
      shell: { x: 0, y: 0, width, height },
      documentElement: dimensions(),
      body: dimensions(),
      scrollingElement: dimensions(),
    },
  };

  assert.deepEqual(
    desktopViewportGeometryMismatches(state, { width, height }),
    [],
  );

  const brokenState = structuredClone(state);
  brokenState.resizable = false;
  brokenState.renderer.viewport = [width + 1, height];
  brokenState.renderer.desk.width = width + 1;
  brokenState.renderer.shell.x = 28;
  brokenState.renderer.documentElement.scroll = [width + 56, height + 56];

  assert.deepEqual(
    desktopViewportGeometryMismatches(brokenState, { width, height }),
    [
      "window resizable was false",
      `renderer viewport was [${width + 1},${height}]`,
      `.anchorage-desk rect was {"x":0,"y":0,"width":${width + 1},"height":${height}}`,
      `[data-testid="shell"] rect was {"x":28,"y":0,"width":${width},"height":${height}}`,
      `documentElement scroll size was [${width + 56},${height + 56}]`,
    ],
  );
});

test("desktop smoke requires a stable geometry interval before issuing the next resize", () => {
  const firstMatch = observeDesktopViewportConvergence({
    matchingSince: null,
    mismatches: [],
    now: 1_000,
    settleMs: 250,
  });
  assert.deepEqual(firstMatch, {
    matchingSince: 1_000,
    settled: false,
  });

  assert.deepEqual(
    observeDesktopViewportConvergence({
      matchingSince: firstMatch.matchingSince,
      mismatches: [],
      now: 1_249,
      settleMs: 250,
    }),
    {
      matchingSince: 1_000,
      settled: false,
    },
  );
  assert.deepEqual(
    observeDesktopViewportConvergence({
      matchingSince: firstMatch.matchingSince,
      mismatches: [],
      now: 1_250,
      settleMs: 250,
    }),
    {
      matchingSince: 1_000,
      settled: true,
    },
  );
  assert.deepEqual(
    observeDesktopViewportConvergence({
      matchingSince: firstMatch.matchingSince,
      mismatches: ["native size changed"],
      now: 1_250,
      settleMs: 250,
    }),
    {
      matchingSince: null,
      settled: false,
    },
  );
});

test("desktop smoke retries a dropped Linux content-size request on schedule", () => {
  assert.equal(
    shouldRequestDesktopViewportResize({
      enabled: true,
      nextRequestAt: 0,
      now: 1_000,
    }),
    true,
  );
  assert.equal(
    shouldRequestDesktopViewportResize({
      enabled: true,
      nextRequestAt: 1_250,
      now: 1_249,
    }),
    false,
  );
  assert.equal(
    shouldRequestDesktopViewportResize({
      enabled: true,
      nextRequestAt: 1_250,
      now: 1_250,
    }),
    true,
  );
  assert.equal(
    shouldRequestDesktopViewportResize({
      enabled: false,
      nextRequestAt: 0,
      now: 1_000,
    }),
    false,
  );
});

test("smoke modes are exact and environment-specific", () => {
  assert.equal(
    desktopSmokeEnabled({
      isPackaged: false,
      developmentValue: "1",
      packagedValue: undefined,
    }),
    true,
  );
  assert.equal(
    desktopSmokeEnabled({
      isPackaged: true,
      developmentValue: undefined,
      packagedValue: "1",
    }),
    true,
  );
  assert.throws(
    () =>
      desktopSmokeEnabled({
        isPackaged: false,
        developmentValue: "true",
        packagedValue: undefined,
      }),
    /exactly 1/u,
  );
  assert.throws(
    () =>
      desktopSmokeEnabled({
        isPackaged: true,
        developmentValue: "1",
        packagedValue: undefined,
      }),
    /development-only/u,
  );
});
