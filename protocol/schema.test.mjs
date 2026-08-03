import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaUrl = new URL("./v1.schema.json", import.meta.url);
const schema = JSON.parse(await readFile(schemaUrl, "utf8"));

test("session identifiers are canonical lowercase UUIDs at the protocol boundary", () => {
  const sessionId = "01234567-89ab-cdef-0123-456789abcdef";
  const pattern = new RegExp(schema.$defs.sessionId.pattern, "u");

  assert.match(sessionId, pattern);
  assert.doesNotMatch(sessionId.toUpperCase(), pattern);
  assert.doesNotMatch("session-1", pattern);
  assert.doesNotMatch(`${sessionId}0`, pattern);
});
