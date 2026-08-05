/**
 * Whether this engine runs containers on the host's own kernel or inside a virtual machine.
 *
 * Three of v2.5's Settings panes are written for Docker Desktop: File sharing chooses how host
 * directories reach containers (VirtioFS and friends), and Virtualisation opens by stating that
 * the Linux kernel "comes from a virtual machine". Against a native Linux engine neither is true
 * — containers share the host kernel and bind mounts come straight off the host filesystem — so
 * both panes would be offering controls that reach nothing.
 *
 * Docker reports `OperatingSystem` as "Docker Desktop" when the daemon is Desktop's VM, and as
 * the distribution name otherwise. That is a report rather than a probe, so it is quoted back to
 * the operator instead of being turned into a claim of our own.
 */

export type EngineHosting =
  | { kind: "unknown"; reported?: string }
  | { kind: "native-linux"; reported: string }
  | { kind: "desktop"; reported: string };

export function describeEngineHosting(
  engine: { operatingSystem?: string; osType?: string } | undefined,
): EngineHosting {
  const reported = engine?.operatingSystem?.trim();
  const osType = engine?.osType?.trim().toLowerCase();
  if (!reported) return { kind: "unknown" };

  if (/docker desktop/iu.test(reported)) return { kind: "desktop", reported };
  // A daemon that is not Linux cannot be running Linux containers on its own kernel.
  if (osType && osType !== "linux") return { kind: "desktop", reported };
  if (osType === "linux") return { kind: "native-linux", reported };
  return { kind: "unknown", reported };
}
