import { describe, expect, it } from "vitest";
import type { CommandNode } from "../types";
import {
  flattenAvailableCommandLeaves,
  isDestructiveArgv,
  secretArgumentIndices,
} from "./commandCenterModel";

const node = (
  path: string[],
  subcommands: CommandNode[] = [],
  status: CommandNode["status"] = "available",
): CommandNode => ({
  path,
  name: path.at(-1) ?? "docker",
  kind: path.length === 0 ? "root" : "builtin",
  status,
  reason: "test",
  transports: ["cli"],
  evidence: {
    argv: [],
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 0,
  },
  subcommands,
});

describe("Command Center model", () => {
  it("recursively returns every available command leaf and no branch", () => {
    const root = node([], [
      node(["version"]),
      node(["compose"], [
        node(["compose", "up"]),
        node(["compose", "watch"]),
        node(["compose", "alpha"], [node(["compose", "alpha", "dry-run"])]),
      ]),
      node(["unavailable"], [], "unavailable"),
    ]);

    expect(
      flattenAvailableCommandLeaves(root).map((command) =>
        command.path.join(" "),
      ),
    ).toEqual([
      "compose alpha dry-run",
      "compose up",
      "compose watch",
      "version",
    ]);
  });

  it.each([
    ["rm", "deadbeef"],
    ["image", "rm", "deadbeef"],
    ["container", "prune"],
    ["system", "prune"],
    ["volume", "rm", "cache"],
    ["network", "rm", "frontend"],
    ["context", "rm", "staging"],
    ["plugin", "rm", "example"],
    ["builder", "prune"],
    ["buildx", "prune"],
    ["service", "rm", "api"],
    ["node", "rm", "worker"],
    ["secret", "rm", "credential"],
    ["config", "rm", "settings"],
    ["stack", "rm", "production"],
    ["compose", "down"],
    ["compose", "rm"],
    ["swarm", "leave"],
    ["--context", "staging", "image", "rm", "deadbeef"],
    ["--host=tcp://127.0.0.1:2375", "system", "prune"],
    ["compose", "-f", "compose.test.yml", "--profile", "dev", "down"],
    ["compose", "--project-name=demo", "rm"],
  ])("requires confirmation for destructive argv %j", (...argv) => {
    expect(isDestructiveArgv(argv)).toBe(true);
  });

  it.each([
    ["container", "stop", "api"],
    ["container", "restart", "api"],
    ["service", "update", "api"],
    ["compose", "up"],
    ["run", "--rm", "alpine"],
  ])("keeps reversible or create/update argv one-click %j", (...argv) => {
    expect(isDestructiveArgv(argv)).toBe(false);
  });

  it("handles login short-password syntax without treating run port flags as secrets", () => {
    expect(secretArgumentIndices(["login", "-u", "soya", "-p", "hunter2"]))
      .toEqual(new Set([4]));
    expect(secretArgumentIndices(["login", "-p=hunter2"]))
      .toEqual(new Set([1]));
    expect(secretArgumentIndices(["run", "-p", "8080:80", "nginx"]))
      .toEqual(new Set());
  });

  it("detects secret values nested in Docker env and build-arg flags", () => {
    expect(secretArgumentIndices(["run", "--env=PASSWORD=hunter2", "app"]))
      .toEqual(new Set([1]));
    expect(
      secretArgumentIndices([
        "build",
        "--build-arg=API_TOKEN=token-value",
        ".",
      ]),
    ).toEqual(new Set([1]));
    expect(secretArgumentIndices(["run", "-ePASSWORD=hunter2", "app"]))
      .toEqual(new Set([1]));
    expect(secretArgumentIndices(["run", "--env=PORT=8080", "app"]))
      .toEqual(new Set());
  });
});
