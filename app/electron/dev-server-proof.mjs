import { randomBytes } from "node:crypto";

export const DESKTOP_HEALTH_PATH = "/__anchorage_desktop_health";
export const DEFAULT_DESKTOP_PORT = 5_173;

export function accessibilitySmokeEnabled(value, { isPackaged = false } = {}) {
  if (value === undefined) {
    return false;
  }
  if (value !== "1") {
    throw new TypeError(
      "ANCHORAGE_ACCESSIBILITY_SMOKE must equal exactly 1",
    );
  }
  // The exact opt-in is intentionally valid for both development and packaged
  // launches so semantic desktop QA can inspect the artifact users receive.
  void isPackaged;
  return true;
}

export function parseDevPort(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_DESKTOP_PORT;
  }
  if (typeof value !== "string" || !/^[0-9]{1,5}$/u.test(value)) {
    throw new TypeError("ANCHORAGE_DEV_PORT must be a decimal loopback port");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new RangeError("ANCHORAGE_DEV_PORT must be between 1024 and 65535");
  }
  return port;
}

export function validateLoopbackRendererUrl(rawUrl, expectedPort) {
  const port = parseDevPort(String(expectedPort));
  const parsed = new URL(rawUrl);
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.port !== String(port) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError(
      `renderer URL must be http://127.0.0.1:${port}/ or localhost equivalent`,
    );
  }
  return parsed;
}

export function createDevServerProof() {
  return {
    token: randomBytes(32).toString("hex"),
    path: DESKTOP_HEALTH_PATH,
  };
}

export async function verifyDevServerOwnership(
  rendererUrl,
  proof,
  {
    fetchImplementation = globalThis.fetch,
    timeoutMs = 750,
  } = {},
) {
  if (
    !proof ||
    !/^[a-f0-9]{64}$/u.test(proof.token) ||
    proof.path !== DESKTOP_HEALTH_PATH ||
    typeof fetchImplementation !== "function"
  ) {
    return false;
  }

  let base;
  try {
    const parsed = new URL(rendererUrl);
    if (!parsed.port) {
      return false;
    }
    base = validateLoopbackRendererUrl(parsed.href, parseDevPort(parsed.port));
  } catch {
    return false;
  }

  try {
    const response = await fetchImplementation(new URL(proof.path, base), {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (
      !response.ok ||
      response.headers.get("x-anchorage-dev-server") !== proof.token
    ) {
      return false;
    }
    return (await response.text()) === proof.token;
  } catch {
    return false;
  }
}
