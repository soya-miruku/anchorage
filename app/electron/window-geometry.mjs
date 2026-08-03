export const ANCHORAGE_APP_WIDTH = 1_600;
export const ANCHORAGE_APP_HEIGHT = 1_000;
export const ANCHORAGE_MIN_WIDTH = 1_080;
export const ANCHORAGE_MIN_HEIGHT = 700;
export const ANCHORAGE_DESK_PADDING = 28;
export const ANCHORAGE_CONTENT_WIDTH =
  ANCHORAGE_APP_WIDTH + ANCHORAGE_DESK_PADDING * 2;
export const ANCHORAGE_CONTENT_HEIGHT =
  ANCHORAGE_APP_HEIGHT + ANCHORAGE_DESK_PADDING * 2;
export const ANCHORAGE_DESKTOP_SMOKE_RESIZE_TARGETS = Object.freeze([
  Object.freeze({
    width: ANCHORAGE_MIN_WIDTH,
    height: ANCHORAGE_MIN_HEIGHT,
  }),
  Object.freeze({
    width: 1_800,
    height: 1_100,
  }),
]);
export const ANCHORAGE_DESKTOP_SMOKE_GEOMETRY_SETTLE_MS = 250;
export const ANCHORAGE_DESKTOP_SMOKE_RESIZE_RETRY_MS = 250;

function isExactSize(value, width, height) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] === width &&
    value[1] === height
  );
}

function isExactViewportRect(value, width, height) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.x === 0 &&
    value.y === 0 &&
    value.width === width &&
    value.height === height
  );
}

export function desktopViewportGeometryMismatches(
  { nativeContentSize, resizable, renderer } = {},
  { width, height },
) {
  const mismatches = [];

  if (resizable !== true) {
    mismatches.push(`window resizable was ${JSON.stringify(resizable)}`);
  }
  if (!isExactSize(nativeContentSize, width, height)) {
    mismatches.push(
      `native content size was ${JSON.stringify(nativeContentSize)}`,
    );
  }
  if (renderer === null || typeof renderer !== "object") {
    mismatches.push(`renderer geometry was ${JSON.stringify(renderer)}`);
    return mismatches;
  }
  if (!isExactSize(renderer.viewport, width, height)) {
    mismatches.push(`renderer viewport was ${JSON.stringify(renderer.viewport)}`);
  }
  if (renderer.surfaceMode !== "viewport") {
    mismatches.push(
      `renderer surface mode was ${JSON.stringify(renderer.surfaceMode)}`,
    );
  }

  for (const [name, rect] of [
    [".anchorage-desk", renderer.desk],
    ['[data-testid="shell"]', renderer.shell],
  ]) {
    if (!isExactViewportRect(rect, width, height)) {
      mismatches.push(`${name} rect was ${JSON.stringify(rect)}`);
    }
  }

  for (const [name, dimensions] of [
    ["documentElement", renderer.documentElement],
    ["body", renderer.body],
    ["scrollingElement", renderer.scrollingElement],
  ]) {
    if (dimensions === null || typeof dimensions !== "object") {
      mismatches.push(`${name} dimensions were ${JSON.stringify(dimensions)}`);
      continue;
    }
    if (!isExactSize(dimensions.client, width, height)) {
      mismatches.push(
        `${name} client size was ${JSON.stringify(dimensions.client)}`,
      );
    }
    if (!isExactSize(dimensions.scroll, width, height)) {
      mismatches.push(
        `${name} scroll size was ${JSON.stringify(dimensions.scroll)}`,
      );
    }
  }

  return mismatches;
}

export function observeDesktopViewportConvergence({
  matchingSince,
  mismatches,
  now,
  settleMs = ANCHORAGE_DESKTOP_SMOKE_GEOMETRY_SETTLE_MS,
}) {
  if (!Array.isArray(mismatches)) {
    throw new TypeError("mismatches must be an array");
  }
  if (!Number.isFinite(now)) {
    throw new TypeError("now must be a finite timestamp");
  }
  if (!Number.isFinite(settleMs) || settleMs < 0) {
    throw new TypeError("settleMs must be a non-negative duration");
  }
  if (mismatches.length > 0) {
    return {
      matchingSince: null,
      settled: false,
    };
  }

  const stableSince = Number.isFinite(matchingSince)
    ? matchingSince
    : now;
  return {
    matchingSince: stableSince,
    settled: now - stableSince >= settleMs,
  };
}

export function shouldRequestDesktopViewportResize({
  enabled,
  nextRequestAt,
  now,
}) {
  if (typeof enabled !== "boolean") {
    throw new TypeError("enabled must be a boolean");
  }
  if (!Number.isFinite(nextRequestAt) || !Number.isFinite(now)) {
    throw new TypeError("resize request timestamps must be finite");
  }
  return enabled && now >= nextRequestAt;
}

export function createAnchorageWindowGeometry() {
  return {
    width: ANCHORAGE_APP_WIDTH,
    height: ANCHORAGE_APP_HEIGHT,
    minWidth: ANCHORAGE_MIN_WIDTH,
    minHeight: ANCHORAGE_MIN_HEIGHT,
    useContentSize: true,
    resizable: true,
  };
}

export function createAnchorageWindowFrameOptions(platform = process.platform) {
  return {
    frame: false,
  };
}

export function desktopSmokeEnabled({
  isPackaged,
  developmentValue,
  packagedValue,
}) {
  for (const [name, value] of [
    ["ANCHORAGE_DESKTOP_SMOKE", developmentValue],
    ["ANCHORAGE_PACKAGED_SMOKE", packagedValue],
  ]) {
    if (value !== undefined && value !== "1") {
      throw new TypeError(`${name} must equal exactly 1 when set`);
    }
  }
  if (developmentValue === "1" && packagedValue === "1") {
    throw new TypeError("Development and packaged smoke modes are mutually exclusive");
  }
  if (developmentValue === "1" && isPackaged) {
    throw new TypeError("ANCHORAGE_DESKTOP_SMOKE is development-only");
  }
  if (packagedValue === "1" && !isPackaged) {
    throw new TypeError("ANCHORAGE_PACKAGED_SMOKE requires a packaged application");
  }
  return developmentValue === "1" || packagedValue === "1";
}
