import { UnsupportedSurface } from "../components/UnsupportedSurface";
import { usePluginPresence } from "../components/usePluginPresence";
import type { AnchorageStore } from "../store/useAnchorageStore";

export function BosunScreen({ store }: { store: AnchorageStore }) {
  // "Bosun" is Anchorage's name for this destination; Docker's is Gordon. A user who
  // searches Docker's docs for "Bosun" finds nothing, so the description binds the two
  // once — the maturity rows and the posture below both describe Gordon's behaviour.
  // Asked rather than asserted: this screen used to report the plugin missing whether
  // or not it was installed. See components/usePluginPresence.ts.
  const presence = usePluginPresence(store, "ai");
  return (
    <UnsupportedSurface
      testId="bosun-screen"
      title="Bosun"
      description="Needs the docker ai plugin — Docker calls this assistant Gordon — which ships with Docker Desktop rather than with a standalone Engine installation."
      posture="Bosun asks before each action by default, and that approval can be widened to a whole session or bypassed entirely. Its warnings about destructive operations stay advisory rather than becoming a boundary, and the working directory is context, not a boundary — enabled tools can read past it."
      commandQuery=""
      plugin={{ name: "ai", presence }}
      onOpenCommand={store.openCommandCenter}
    />
  );
}
