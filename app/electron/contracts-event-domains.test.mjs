import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { RECEIPT_DOMAINS, validateCoreEventEnvelope } from "./contracts.mjs";

/*
 * The Electron event boundary and the core's receipts have to name the same domains.
 *
 * `validateOperationReceipt` allowed `image` and `volume`. The core stamps eight domains, and
 * main.mjs handles a rejected envelope by writing a console.error and dropping it — so a
 * network mutation, a system prune, a model pull, a secret create, a compose lifecycle verb
 * and container create/commit/rebind-ports completed with the renderer, and the audit trail,
 * never told. The failure mode is silence in a process nobody is watching, which is why this
 * reads the Go source rather than a list somebody remembered to update.
 */
const coreDir = fileURLToPath(new URL("../../core/internal/core/", import.meta.url));

/** Every domain literal the core puts on a DomainOperationReceipt. */
function domainsInCoreSource() {
  const found = new Set();
  for (const entry of readdirSync(coreDir)) {
    if (!entry.endsWith(".go") || entry.endsWith("_test.go")) continue;
    const source = readFileSync(join(coreDir, entry), "utf8");
    // newDomainReceipt(operationID, contextName, "<domain>", ...)
    for (const match of source.matchAll(
      /newDomainReceipt\([^,]+,[^,]+,\s*"([a-z-]+)"/g,
    )) {
      found.add(match[1]);
    }
    // Struct literals that set the field directly.
    for (const match of source.matchAll(/\bDomain:\s*"([a-z-]+)"/g)) {
      found.add(match[1]);
    }
  }
  return found;
}

const receipt = (domain) => ({
  receipt: {
    operationId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    context: "default",
    domain,
    resourceId: "resource",
    action: "prune",
    source: "engine-api",
    outcome: "succeeded",
    startedAt: "2026-08-07T10:00:00.000Z",
    completedAt: "2026-08-07T10:00:01.000Z",
    durationMs: 1_000,
  },
});

test("every domain the core stamps on a receipt survives the event boundary", () => {
  const emitted = domainsInCoreSource();
  assert.ok(
    emitted.size >= 8,
    `expected to find the core's receipt domains, found ${[...emitted].join(", ") || "none"}`,
  );
  for (const domain of emitted) {
    assert.doesNotThrow(
      () => validateCoreEventEnvelope("operation.completed", receipt(domain)),
      `the core emits domain "${domain}" and this boundary drops it`,
    );
  }
});

test("the declared vocabulary matches the core exactly, with nothing invented", () => {
  assert.deepEqual([...RECEIPT_DOMAINS].sort(), [...domainsInCoreSource()].sort());
});

test("a domain the core never emits is still refused", () => {
  assert.throws(
    () => validateCoreEventEnvelope("operation.completed", receipt("filesystem")),
    /domain must be one of/,
  );
});
