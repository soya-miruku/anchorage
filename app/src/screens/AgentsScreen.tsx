import { UnsupportedSurface } from "../components/UnsupportedSurface";
import { usePluginPresence } from "../components/usePluginPresence";
import type { AnchorageStore } from "../store/useAnchorageStore";

export function AgentsScreen({ store }: { store: AnchorageStore }) {
  // Models and Sandboxes name a Linux install path here; this screen deliberately does
  // not. Docker documents Docker Agent as a bundled open-source plugin but no standalone
  // Engine install for it, and naming one would be a claim this build cannot back.
  // Asked rather than asserted: this screen used to report the plugin missing whether
  // or not it was installed. See components/usePluginPresence.ts.
  const presence = usePluginPresence(store, "agent");
  return (
    <UnsupportedSurface
      testId="agents-screen"
      title="Agents"
      description="Needs the docker agent plugin. Docker Agent is an open-source agent framework that ships as a plugin, separate from the Engine package."
      posture="An agent's instructions describe intent, not a boundary. What it can actually reach is the tools and credentials granted to it and the sandbox it runs in — a system prompt telling it to be careful is not one of those."
      commandQuery=""
      plugin={{ name: "agent", presence }}
      onOpenCommand={store.openCommandCenter}
    />
  );
}
