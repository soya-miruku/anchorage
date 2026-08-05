import { CapabilitySetup } from "../components/CapabilitySetup";
import { capabilityForView } from "../data/capabilities";
import type { AnchorageStore } from "../store/useAnchorageStore";

/**
 * This destination is a Docker CLI plugin and nothing else, so the screen behind it is about
 * getting that plugin working: what state it is in, the repair when the fault is repairable
 * here, and the install command when it is not. What it needs and how it arrives live in
 * data/capabilities.ts, next to every other gated capability.
 */
export function AgentsScreen({ store }: { store: AnchorageStore }) {
  // Models names a Linux package; this one deliberately does not. Docker documents Docker
  // Agent as a bundled open-source plugin but no standalone Engine package, so the catalogue
  // gives the plugin-directory mechanics instead of inventing a package name.
  const capability = capabilityForView("agents");
  if (!capability) throw new Error("agents is missing from the capability catalogue");
  return (
    <CapabilitySetup
      store={store}
      capability={capability}
      testId="agents-screen"
      posture="An agent's instructions describe intent, not a boundary. What it can actually reach is the tools and credentials granted to it and the sandbox it runs in — a system prompt telling it to be careful is not one of those."
    />
  );
}
