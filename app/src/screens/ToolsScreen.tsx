import { CapabilitySetup } from "../components/CapabilitySetup";
import { capabilityForView } from "../data/capabilities";
import type { AnchorageStore } from "../store/useAnchorageStore";

/**
 * This destination is a Docker CLI plugin and nothing else, so the screen behind it is about
 * getting that plugin working: what state it is in, the repair when the fault is repairable
 * here, and the install command when it is not. What it needs and how it arrives live in
 * data/capabilities.ts, next to every other gated capability.
 */
export function ToolsScreen({ store }: { store: AnchorageStore }) {
  const capability = capabilityForView("tools");
  if (!capability) throw new Error("tools is missing from the capability catalogue");
  return (
    <CapabilitySetup
      store={store}
      capability={capability}
      testId="tools-screen"
      posture="Containerising a tool server limits its dependencies and its runtime blast radius. It does not reduce the authority you granted it — a token with write access still writes, whatever it runs inside."
    />
  );
}
