import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import worker from "../worker/index.js";

test("serves existing static assets without a fallback", async () => {
  const calls = [];
  const response = await worker.fetch(new Request("https://example.test/assets/app.js"), {
    ASSETS: {
      fetch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return new Response("asset", { status: 200 });
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/assets/app.js"]);
});

test("falls back to index.html for an unknown app route", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/flow/step-two?source=share", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          calls.push(url.pathname + url.search);
          return new Response(url.pathname === "/index.html" ? "app" : "missing", {
            status: url.pathname === "/index.html" ? 200 : 404,
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/index.html"]);
});

test("does not turn missing API or write requests into the app shell", async () => {
  for (const request of [
    new Request("https://example.test/api/missing", { headers: { accept: "application/json" } }),
    new Request("https://example.test/flow", { method: "POST", headers: { accept: "text/html" } }),
  ]) {
    let calls = 0;
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    });

    assert.equal(response.status, 404);
    assert.equal(calls, 1);
  }
});

/*
This asserts on build output, so it can only run after a build.

It used to call `access` on three paths in `dist/` and fail with a bare ENOENT when they were
absent, which made it pass on any machine that had built once and fail on a clean clone — the
first CI run on a fresh checkout is what found it. Skipping when there is no build to inspect
matches how the rest of this repository treats generated inputs: the checks that cite a digest
under `artifacts/` run only when the file is present and say so when it is not.

Saying so is the point. A silent skip here would mean nothing ever checks the Sites payload,
so the reason is stated, and the release path builds before it runs this.
*/
test("emits the files required by Sites packaging", async (t) => {
  const required = [
    "../dist/client/index.html",
    "../dist/server/index.js",
    "../dist/.openai/hosting.json",
  ].map((path) => new URL(path, import.meta.url));

  const built = await access(required[0]).then(
    () => true,
    () => false,
  );
  if (!built) {
    t.skip(
      "No renderer build to inspect: run `npm run build` first. This checks what a build " +
        "emits, so with nothing built there is nothing to check.",
    );
    return;
  }
  for (const path of required) {
    await access(path);
  }
});
