import { spawn } from "node:child_process";

const VULNERABILITY_KEYS = [
  "info",
  "low",
  "moderate",
  "high",
  "critical",
  "total",
];
const DEPENDENCY_KEYS = [
  "prod",
  "dev",
  "optional",
  "peer",
  "peerOptional",
  "total",
];

function requiredCounts(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`npm audit did not provide ${name}`);
  }
  const counts = {};
  for (const key of keys) {
    const count = value[key];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`npm audit ${name}.${key} must be a non-negative integer`);
    }
    counts[key] = count;
  }
  return counts;
}

export function validateNpmAuditResult({ code, stdout, stderr }) {
  let audit;
  try {
    audit = JSON.parse(stdout);
  } catch {
    throw new Error(`npm audit did not return JSON: ${stderr}`);
  }
  if (!Number.isSafeInteger(audit.auditReportVersion) || audit.auditReportVersion < 1) {
    throw new Error("npm audit did not provide auditReportVersion");
  }

  const vulnerabilities = requiredCounts(
    audit.metadata?.vulnerabilities,
    VULNERABILITY_KEYS,
    "metadata.vulnerabilities",
  );
  const dependencies = requiredCounts(
    audit.metadata?.dependencies,
    DEPENDENCY_KEYS,
    "metadata.dependencies",
  );
  const severityTotal =
    vulnerabilities.info +
    vulnerabilities.low +
    vulnerabilities.moderate +
    vulnerabilities.high +
    vulnerabilities.critical;
  if (severityTotal !== vulnerabilities.total) {
    throw new Error("npm audit vulnerability totals are inconsistent");
  }
  if (code !== 0 || vulnerabilities.total !== 0) {
    throw new Error(
      `Dependency audit failed with ${vulnerabilities.total} vulnerabilities: ${stderr}`,
    );
  }

  return {
    ...audit,
    metadata: {
      ...audit.metadata,
      vulnerabilities,
      dependencies,
    },
  };
}

export function runBoundedProcess(
  executable,
  args,
  {
    cwd,
    env = process.env,
    timeoutMs,
  },
) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let escalationTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalationTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      escalationTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(escalationTimer);
      rejectRun(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(escalationTimer);
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (timedOut) {
        rejectRun(
          new Error(
            `${executable} timed out after ${timeoutMs} ms ` +
              `(code ${String(code)}, signal ${String(signal)})`,
          ),
        );
        return;
      }
      resolveRun(result);
    });
  });
}
