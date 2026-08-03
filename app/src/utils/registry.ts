/**
 * Where a reference would be pushed.
 *
 * Mirrors Docker's own rule, and the core's `registryHostForReference`: the first path
 * segment is a registry only when it looks like a host — it contains a dot or a port, or is
 * localhost. Everything else belongs to Docker Hub. A confirmation that names the wrong
 * destination is worse than none, because publishing to an unintended registry is a
 * disclosure rather than a failed command.
 */
export function registryHostForReference(reference: string): string {
  let value = reference;
  const at = value.indexOf("@");
  if (at >= 0) value = value.slice(0, at);
  const segments = value.split("/");
  if (segments.length > 1) {
    const candidate = segments[0];
    if (
      candidate.includes(".") ||
      candidate.includes(":") ||
      candidate === "localhost"
    ) {
      return candidate;
    }
  }
  return "docker.io";
}

/** Docker's own wording when a registry has not been authenticated. */
export function looksUnauthenticated(output: string): boolean {
  return /denied|unauthorized|authentication required|requested access to the resource is denied/iu.test(
    output,
  );
}
