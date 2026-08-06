import type { DockerVersions } from "../types";

/*
What the two halves of `docker version` say about each other.

Docker is two programs. `docker-ce-cli` and `docker-ce` are separate packages, upgraded
separately, and on Linux they drift routinely: a package manager updates the CLI while the daemon
keeps running the binary it started with, or an operator points a current CLI at an older remote
engine over a context. Nothing in the app noticed. Settings reported `serverVersion` alone, which
is the half that cannot tell you the two disagree.

The failure this prevents is specific. The CLI negotiates down to whatever API the daemon offers,
so a newer client mostly works — until a flag that needs a newer API is silently unavailable, or
the daemon's API is below the client's own floor and every call fails at once. Both are legible
here and in no other read the app makes: the Engine API's `/version` describes the daemon, so the
client's version is invisible over the socket.

This is deliberately not a "you should upgrade" prompt. It reports what the two sides are and
what their relationship means. Anchorage cannot upgrade Docker — the core executes only the
fingerprinted `docker` binary and could not invoke a package manager if it wanted to — so the
remedy is the operator's, exactly as it is for a missing CLI plugin.
*/

export type VersionSkewKind =
  /** No read yet, or a read that failed. Says nothing about the machine. */
  | "unknown"
  /** Both sides report the same version. */
  | "aligned"
  /** Different versions that still negotiate a usable API. Ordinary and mostly harmless. */
  | "skewed"
  /** The daemon's API is below the client's floor. Calls fail; this is a real break. */
  | "incompatible";

export interface VersionSkew {
  kind: VersionSkewKind;
  clientVersion?: string;
  serverVersion?: string;
  /** The API both sides actually agree on, when both reported one. */
  negotiatedApiVersion?: string;
  /** What the relationship means, in the operator's terms. Empty when aligned or unknown. */
  detail?: string;
}

/**
 * Compares Docker API versions, which are `major.minor` decimals rather than semver.
 *
 * Returns <0, 0 or >0. A malformed side sorts as equal rather than throwing: this decides
 * wording, and a parse failure must not turn into a claim that the daemon is incompatible.
 */
export function compareApiVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [major, minor] = value.split(".");
    return [Number.parseInt(major ?? "", 10), Number.parseInt(minor ?? "", 10)];
  };
  const [leftMajor, leftMinor] = parse(left);
  const [rightMajor, rightMinor] = parse(right);
  if (
    !Number.isFinite(leftMajor) ||
    !Number.isFinite(rightMajor) ||
    !Number.isFinite(leftMinor) ||
    !Number.isFinite(rightMinor)
  ) {
    return 0;
  }
  if (leftMajor !== rightMajor) return leftMajor - rightMajor;
  return leftMinor - rightMinor;
}

export function describeVersionSkew(
  versions: DockerVersions | undefined,
): VersionSkew {
  const client = versions?.client ?? {};
  const server = versions?.server ?? {};

  // Both halves are needed to say anything about their relationship. One alone is just a fact,
  // and the pane prints it either way.
  if (!client.version || !server.version) {
    return {
      kind: "unknown",
      clientVersion: client.version,
      serverVersion: server.version,
    };
  }

  const negotiated =
    client.apiVersion && server.apiVersion
      ? compareApiVersions(client.apiVersion, server.apiVersion) <= 0
        ? client.apiVersion
        : server.apiVersion
      : undefined;

  const base = {
    clientVersion: client.version,
    serverVersion: server.version,
    negotiatedApiVersion: negotiated,
  };

  // The hard case, checked before the cosmetic one: the daemon cannot serve an API this client
  // is willing to speak, so calls fail outright rather than losing individual flags.
  if (
    client.minApiVersion &&
    server.apiVersion &&
    compareApiVersions(server.apiVersion, client.minApiVersion) < 0
  ) {
    return {
      ...base,
      kind: "incompatible",
      detail: `This daemon speaks API ${server.apiVersion}, below the ${client.minApiVersion} floor this CLI requires. Commands fail against it until one side moves.`,
    };
  }

  if (client.version === server.version) {
    return { ...base, kind: "aligned" };
  }

  return {
    ...base,
    kind: "skewed",
    detail: negotiated
      ? `The CLI negotiates down to API ${negotiated}, so anything needing a newer API is unavailable rather than reported as missing.`
      : "The two report different versions, and neither stated an API version to negotiate on.",
  };
}
