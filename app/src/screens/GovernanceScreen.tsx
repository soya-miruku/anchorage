import { UnsupportedSurface } from "../components/UnsupportedSurface";
import type { AnchorageStore } from "../store/useAnchorageStore";

/**
 * Two products land on one destination and only one of them is a Docker Business
 * entitlement. SAML/SCIM and Settings Management are administered in the Business admin
 * console; the sandbox and MCP policy layers are a separate enterprise offering the source
 * records as limited availability and partly invite-only (docker-features.md:68, :1871).
 * Saying "it is in Docker Business admin settings" full stop sends a Business subscriber
 * looking for something that is not there.
 */
export function GovernanceScreen({ store }: { store: AnchorageStore }) {
  return (
    <UnsupportedSurface
      testId="governance-screen"
      title="Governance"
      description="Organisation policy is administered in Docker Business admin settings, outside the engine, and has no CLI surface to read it back. The sandbox and MCP policy layers are a separate enterprise product with limited availability rather than an automatic Business entitlement."
      posture="In some current configurations organisation policy replaces local policy rather than merging with it, so local restrictions an administrator expects to stay additive do not. Telling a model not to touch production is advice; a denied destination at the proxy is a boundary."
      commandQuery=""
      onOpenCommand={store.openCommandCenter}
    />
  );
}
