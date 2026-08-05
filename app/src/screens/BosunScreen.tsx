import { CapabilitySetup } from "../components/CapabilitySetup";
import { capabilityForView } from "../data/capabilities";
import type { AnchorageStore } from "../store/useAnchorageStore";

/**
 * This destination is a Docker CLI plugin and nothing else, so the screen behind it is about
 * getting that plugin working: what state it is in, the repair when the fault is repairable
 * here, and the install command when it is not. What it needs and how it arrives live in
 * data/capabilities.ts, next to every other gated capability.
 */
export function BosunScreen({ store }: { store: AnchorageStore }) {
  // "Bosun" is Anchorage's name for this destination; Docker's is Gordon. A user who
  // searches Docker's docs for "Bosun" finds nothing, so the catalogue entry binds the two
  // once — the maturity rows and the posture below both describe Gordon's behaviour.
  const capability = capabilityForView("bosun");
  if (!capability) throw new Error("bosun is missing from the capability catalogue");
  return (
    <CapabilitySetup
      store={store}
      capability={capability}
      testId="bosun-screen"
      posture="Bosun asks before each action by default, and that approval can be widened to a whole session or bypassed entirely. Its warnings about destructive operations stay advisory rather than becoming a boundary, and the working directory is context, not a boundary — enabled tools can read past it."
    />
  );
}
