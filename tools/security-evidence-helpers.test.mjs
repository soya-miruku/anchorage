import assert from "node:assert/strict";
import test from "node:test";

import {
  runBoundedProcess,
  validateNpmAuditResult,
} from "./security-evidence-helpers.mjs";

test("requires complete npm audit metadata before accepting zero vulnerabilities", () => {
  assert.throws(
    () =>
      validateNpmAuditResult({
        code: 0,
        stdout: JSON.stringify({ auditReportVersion: 2 }),
        stderr: "",
      }),
    /metadata\.vulnerabilities/u,
  );

  const audit = validateNpmAuditResult({
    code: 0,
    stdout: JSON.stringify({
      auditReportVersion: 2,
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
          total: 0,
        },
        dependencies: {
          prod: 1,
          dev: 10,
          optional: 2,
          peer: 1,
          peerOptional: 0,
          total: 10,
        },
      },
    }),
    stderr: "",
  });
  assert.equal(audit.auditReportVersion, 2);
  assert.equal(audit.metadata.vulnerabilities.total, 0);
});

test("rejects vulnerable, failed, and malformed npm audit results", () => {
  const vulnerable = {
    auditReportVersion: 2,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 1,
        high: 0,
        critical: 0,
        total: 1,
      },
      dependencies: {
        prod: 1,
        dev: 10,
        optional: 2,
        peer: 1,
        peerOptional: 0,
        total: 10,
      },
    },
  };
  assert.throws(
    () =>
      validateNpmAuditResult({
        code: 1,
        stdout: JSON.stringify(vulnerable),
        stderr: "one vulnerability",
      }),
    /1 vulnerabilities/u,
  );
  assert.throws(
    () =>
      validateNpmAuditResult({
        code: 0,
        stdout: "{",
        stderr: "invalid",
      }),
    /did not return JSON/u,
  );
});

test("terminates a security subprocess that exceeds its deadline", async () => {
  await assert.rejects(
    runBoundedProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      {
        cwd: process.cwd(),
        timeoutMs: 50,
      },
    ),
    /timed out after 50 ms/u,
  );
});
