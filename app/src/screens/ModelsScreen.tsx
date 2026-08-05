import { CapabilitySetup } from "../components/CapabilitySetup";
import { capabilityForView } from "../data/capabilities";
import type { AnchorageStore } from "../store/useAnchorageStore";

/**
 * This destination is a Docker CLI plugin and nothing else, so the screen behind it is about
 * getting that plugin working: what state it is in, the repair when the fault is repairable
 * here, and the install command when it is not. What it needs and how it arrives live in
 * data/capabilities.ts, next to every other gated capability.
 */
export function ModelsScreen({ store }: { store: AnchorageStore }) {
  const capability = capabilityForView("models");
  if (!capability) throw new Error("models is missing from the capability catalogue");
  return (
    <CapabilitySetup
      store={store}
      capability={capability}
      testId="models-screen"
      posture="The inference endpoint has no authentication by default. Anything that can reach the port can run inference, pull models and burn GPU."
    />
  );
}
