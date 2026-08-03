import assert from "node:assert/strict";
import test from "node:test";

import {
  accessibilitySmokeEnabled,
  createDevServerProof,
  DEFAULT_DESKTOP_PORT,
  DESKTOP_HEALTH_PATH,
  parseDevPort,
  validateLoopbackRendererUrl,
  verifyDevServerOwnership,
} from "./dev-server-proof.mjs";

function responseFor(token, { body = token, status = 200 } = {}) {
  return new Response(body, {
    status,
    headers: { "x-anchorage-dev-server": token },
  });
}

test("accepts only the per-run proof served by the spawned Vite instance", async () => {
  const proof = createDevServerProof();
  let requestedUrl = null;
  const valid = await verifyDevServerOwnership("http://127.0.0.1:5173/", proof, {
    fetchImplementation: async (url) => {
      requestedUrl = url.href;
      return responseFor(proof.token);
    },
  });

  assert.equal(valid, true);
  assert.equal(requestedUrl, `http://127.0.0.1:5173${DESKTOP_HEALTH_PATH}`);
});

test("fails closed when an unrelated server already owns the port", async () => {
  const proof = createDevServerProof();
  const unrelatedToken = "0".repeat(64);

  assert.equal(
    await verifyDevServerOwnership("http://127.0.0.1:5173/", proof, {
      fetchImplementation: async () => responseFor(unrelatedToken),
    }),
    false,
  );
  assert.equal(
    await verifyDevServerOwnership("http://127.0.0.1:5173/", proof, {
      fetchImplementation: async () => responseFor(proof.token, { body: "wrong-app" }),
    }),
    false,
  );
});

test("never probes a non-loopback renderer origin", async () => {
  const proof = createDevServerProof();
  let called = false;
  const valid = await verifyDevServerOwnership("http://example.test:5173/", proof, {
    fetchImplementation: async () => {
      called = true;
      return responseFor(proof.token);
    },
  });

  assert.equal(valid, false);
  assert.equal(called, false);
});

test("validates selectable development ports and exact loopback URLs", () => {
  assert.equal(parseDevPort(undefined), DEFAULT_DESKTOP_PORT);
  assert.equal(parseDevPort("45173"), 45_173);
  assert.equal(
    validateLoopbackRendererUrl("http://localhost:45173/", 45_173).href,
    "http://localhost:45173/",
  );

  for (const invalid of ["0", "80", "65536", "5e3", "-1", "5173/path"]) {
    assert.throws(() => parseDevPort(invalid), /ANCHORAGE_DEV_PORT/u);
  }
  assert.throws(
    () => validateLoopbackRendererUrl("http://127.0.0.1:5174/", 5_173),
    /renderer URL/u,
  );
  assert.throws(
    () => validateLoopbackRendererUrl("http://example.test:5173/", 5_173),
    /renderer URL/u,
  );
});

test("enables semantic accessibility smoke for exact development or packaged opt-in", () => {
  assert.equal(accessibilitySmokeEnabled(undefined), false);
  assert.equal(accessibilitySmokeEnabled("1"), true);
  assert.throws(() => accessibilitySmokeEnabled("true"), /must equal exactly 1/u);
  assert.equal(
    accessibilitySmokeEnabled("1", { isPackaged: true }),
    true,
  );
});
