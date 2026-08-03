import type { CommandNode, SessionOutputPayload } from "../types";

const SECRET_NAME =
  /(?:password|passwd|passphrase|token|secret|api[-_]?key|auth|credential|private[-_]?key)/iu;

export function isSecretName(value: string): boolean {
  return SECRET_NAME.test(value);
}

export function flattenAvailableCommandLeaves(
  root: CommandNode,
): CommandNode[] {
  const leaves: CommandNode[] = [];
  const visit = (node: CommandNode) => {
    const availableChildren = node.subcommands.filter(
      (child) => child.status === "available",
    );
    if (
      node.path.length > 0 &&
      node.status === "available" &&
      availableChildren.length === 0
    ) {
      leaves.push(node);
      return;
    }
    availableChildren.forEach(visit);
  };
  visit(root);
  return leaves.sort((left, right) =>
    left.path.join(" ").localeCompare(right.path.join(" ")),
  );
}

export function searchCommandLeaves(
  commands: CommandNode[],
  query: string,
): CommandNode[] {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) return commands;
  return commands.filter((command) => {
    const haystack = [
      command.path.join(" "),
      command.name,
      command.description ?? "",
      command.kind,
    ]
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function secretArgumentIndices(argv: string[]): Set<number> {
  const secretIndices = new Set<number>();
  argv.forEach((argument, index) => {
    const nestedAssignment = argument.match(
      /^(?:--env=|--build-arg=|-e=?)(.+)$/iu,
    )?.[1];
    if (nestedAssignment) {
      const nestedName = nestedAssignment.split("=", 1)[0] ?? "";
      if (nestedAssignment.includes("=") && SECRET_NAME.test(nestedName)) {
        secretIndices.add(index);
      }
    }
    const separator = argument.indexOf("=");
    const name = separator >= 0 ? argument.slice(0, separator) : argument;
    if (!SECRET_NAME.test(name)) return;
    if (separator >= 0) {
      secretIndices.add(index);
    } else if (index + 1 < argv.length) {
      secretIndices.add(index + 1);
    }
  });
  if (argv[0]?.toLocaleLowerCase() === "login") {
    argv.forEach((argument, index) => {
      if (argument === "-p" && index + 1 < argv.length) {
        secretIndices.add(index + 1);
      } else if (argument.startsWith("-p=")) {
        secretIndices.add(index);
      }
    });
  }
  return secretIndices;
}

export function containsSecretArguments(argv: string[]): boolean {
  return secretArgumentIndices(argv).size > 0;
}

export function isDestructiveArgv(argv: string[]): boolean {
  const normalized = argv.map((argument) => argument.toLocaleLowerCase());
  const dockerGlobalValueOptions = new Set([
    "--config",
    "-c",
    "--context",
    "-h",
    "--host",
    "-l",
    "--log-level",
    "--tlscacert",
    "--tlscert",
    "--tlskey",
  ]);
  const composeGlobalValueOptions = new Set([
    "--ansi",
    "--env-file",
    "-f",
    "--file",
    "--parallel",
    "--profile",
    "--progress",
    "--project-directory",
    "-p",
    "--project-name",
  ]);
  const skipOptions = (
    start: number,
    valueOptions: ReadonlySet<string>,
  ): number => {
    let index = start;
    while (index < normalized.length) {
      const option = normalized[index];
      if (option === "--") return index + 1;
      if (!option.startsWith("-") || option === "-") return index;
      const name = option.split("=", 1)[0];
      const hasInlineValue = option.includes("=");
      index += 1;
      if (
        valueOptions.has(name) &&
        !hasInlineValue &&
        index < normalized.length
      ) {
        index += 1;
      }
    }
    return index;
  };

  let commandIndex = normalized[0] === "docker" ? 1 : 0;
  commandIndex = skipOptions(commandIndex, dockerGlobalValueOptions);
  const root = normalized[commandIndex] ?? "";
  let subcommandIndex = commandIndex + 1;
  if (root === "compose") {
    subcommandIndex = skipOptions(
      subcommandIndex,
      composeGlobalValueOptions,
    );
  }
  const subcommand = normalized[subcommandIndex] ?? "";
  if (["rm", "rmi", "prune"].includes(root)) return true;
  if (
    [
      "container",
      "config",
      "context",
      "image",
      "network",
      "node",
      "plugin",
      "secret",
      "service",
      "stack",
      "system",
      "volume",
      "builder",
      "buildx",
    ].includes(root) &&
    ["rm", "remove", "prune"].includes(subcommand)
  ) {
    return true;
  }
  if (
    root === "compose" &&
    ["down", "rm", "remove"].includes(subcommand)
  ) {
    return true;
  }
  return root === "swarm" && subcommand === "leave";
}

export function decodeSessionOutput(payload: SessionOutputPayload): string {
  if (payload.encoding === "utf-8") return payload.data;
  try {
    const binary = window.atob(payload.data);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return "\n[Anchorage could not decode base64 session output]\n";
  }
}
