import assert from "node:assert/strict";
import test from "node:test";

import { RedactedLogTail, redactSensitiveText } from "./redaction.mjs";

test("redacts common credential forms from core stderr", () => {
  const input =
    "authorization=Bearer abc.def.ghi password=hunter2 https://user:pass@example.test token=secret";
  const result = redactSensitiveText(input);

  assert.doesNotMatch(result, /hunter2|user:pass|token=secret|abc\.def\.ghi/u);
  assert.match(result, /\[REDACTED\]/u);
});

test("keeps a bounded redacted log tail", () => {
  const tail = new RedactedLogTail({ maximumLines: 2, maximumCharacters: 1_000 });
  tail.push("first");
  tail.push("second password=secret");
  tail.push("third");

  assert.deepEqual(tail.snapshot(), ["second password=[REDACTED]", "third"]);
});
