import { CapabilitySetup } from "../components/CapabilitySetup";
import { capabilityForView } from "../data/capabilities";
import type { AnchorageStore } from "../store/useAnchorageStore";

/**
 * This destination is a Docker CLI plugin and nothing else, so the screen behind it is about
 * getting that plugin working: what state it is in, the repair when the fault is repairable
 * here, and the install command when it is not. What it needs and how it arrives live in
 * data/capabilities.ts, next to every other gated capability.
 */
export function SandboxesScreen({ store }: { store: AnchorageStore }) {
  const capability = capabilityForView("sandboxes");
  if (!capability) throw new Error("sandboxes is missing from the capability catalogue");
  return (
    <CapabilitySetup
      store={store}
      capability={capability}
      testId="sandboxes-screen"
      posture="A sandbox protects the host kernel and the host daemon: an agent can be root inside its own microVM without reaching either. It does not protect what you hand in — a writable workspace comes back rewritten and deserves reading like an untrusted pull request, a read-only mount still discloses .env and other ignored files, and a shared skills store carries a compromise from one sandbox into the next."
    />
  );
}
