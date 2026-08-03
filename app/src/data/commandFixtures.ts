import type {
  CommandEvidence,
  CommandNode,
  DockerContext,
  SystemCapabilities,
} from "../types";

const discoveredAt = "2026-08-02T12:00:00.000Z";

const evidence = (path: string[]): CommandEvidence => ({
  argv: ["docker", ...path, "--help"],
  exitCode: 0,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
  durationMs: 1,
});

const leaf = (
  path: string[],
  description: string,
  kind: CommandNode["kind"] = "builtin",
): CommandNode => ({
  path,
  name: path.at(-1) ?? "docker",
  description,
  kind,
  status: "available",
  reason: "Discovered from the deterministic browser fixture.",
  transports: ["cli"],
  evidence: evidence(path),
  subcommands: [],
});

const branch = (
  path: string[],
  description: string,
  subcommands: CommandNode[],
  kind: CommandNode["kind"] = "builtin",
): CommandNode => ({
  path,
  name: path.at(-1) ?? "docker",
  description,
  kind,
  status: "available",
  reason: "Discovered from the deterministic browser fixture.",
  transports: ["cli"],
  evidence: evidence(path),
  subcommands,
});

const commandRoot = branch(
  [],
  "Docker command line interface",
  [
    leaf(["version"], "Show the Docker version"),
    leaf(["info"], "Display system-wide information"),
    leaf(["ps"], "List containers"),
    leaf(["run"], "Run a command in a new container"),
    leaf(["exec"], "Execute a command in a running container"),
    leaf(["logs"], "Fetch the logs of a container"),
    leaf(["inspect"], "Return low-level information on Docker objects"),
    branch(["container"], "Manage containers", [
      leaf(["container", "ls"], "List containers"),
      leaf(["container", "inspect"], "Display detailed container information"),
      leaf(["container", "start"], "Start one or more stopped containers"),
      leaf(["container", "stop"], "Stop one or more running containers"),
      leaf(["container", "restart"], "Restart one or more containers"),
      leaf(["container", "rm"], "Remove one or more containers"),
      leaf(["container", "prune"], "Remove all stopped containers"),
    ]),
    branch(["image"], "Manage images", [
      leaf(["image", "ls"], "List images"),
      leaf(["image", "pull"], "Download an image from a registry"),
      leaf(["image", "inspect"], "Display detailed image information"),
      leaf(["image", "rm"], "Remove one or more images"),
      leaf(["image", "prune"], "Remove unused images"),
    ]),
    branch(["volume"], "Manage volumes", [
      leaf(["volume", "ls"], "List volumes"),
      leaf(["volume", "create"], "Create a volume"),
      leaf(["volume", "inspect"], "Display detailed volume information"),
      leaf(["volume", "rm"], "Remove one or more volumes"),
      leaf(["volume", "prune"], "Remove unused local volumes"),
    ]),
    branch(["network"], "Manage networks", [
      leaf(["network", "ls"], "List networks"),
      leaf(["network", "create"], "Create a network"),
      leaf(["network", "inspect"], "Display detailed network information"),
      leaf(["network", "rm"], "Remove one or more networks"),
      leaf(["network", "prune"], "Remove unused networks"),
    ]),
    branch(
      ["compose"],
      "Define and run multi-container applications",
      [
        leaf(["compose", "up"], "Create and start services", "plugin-command"),
        leaf(["compose", "down"], "Stop and remove services", "plugin-command"),
        leaf(["compose", "ps"], "List services", "plugin-command"),
        leaf(["compose", "logs"], "View output from containers", "plugin-command"),
        leaf(["compose", "watch"], "Watch build context and update services", "plugin-command"),
      ],
      "plugin",
    ),
    branch(
      ["buildx"],
      "Docker Buildx",
      [
        leaf(["buildx", "build"], "Start a build", "plugin-command"),
        leaf(["buildx", "ls"], "List builder instances", "plugin-command"),
        leaf(["buildx", "inspect"], "Inspect the current builder instance", "plugin-command"),
        leaf(["buildx", "prune"], "Remove build cache", "plugin-command"),
      ],
      "plugin",
    ),
  ],
  "root",
);

const countNodes = (node: CommandNode): number =>
  1 + node.subcommands.reduce((total, child) => total + countNodes(child), 0);

export const FIXTURE_DOCKER_CONTEXTS: DockerContext[] = [
  {
    name: "default",
    description: "Local Docker Engine",
    dockerEndpoint: "unix:///var/run/docker.sock",
    current: true,
  },
  {
    name: "staging",
    description: "Staging builder",
    dockerEndpoint: "ssh://docker@staging.internal",
    current: false,
  },
  {
    name: "production-readonly",
    description: "Production operations context",
    dockerEndpoint: "ssh://docker@production.internal",
    current: false,
  },
];

export function createFixtureCapabilities(
  requestedContext?: string,
): SystemCapabilities {
  const selectedContext =
    FIXTURE_DOCKER_CONTEXTS.find((context) => context.name === requestedContext)
      ?.name ?? "default";

  return structuredClone({
    protocolVersion: "1",
    selectedContext,
    currentContext: "default",
    contexts: FIXTURE_DOCKER_CONTEXTS,
    commandInventory: {
      root: commandRoot,
      nodeCount: countNodes(commandRoot),
      complete: true,
      limitReached: false,
      maxDepth: 2,
      discoveredAt,
      warnings: [],
    },
    warnings: [],
    observedAt: discoveredAt,
  });
}
