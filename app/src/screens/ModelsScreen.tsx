import { UnsupportedSurface } from "../components/UnsupportedSurface";
import { usePluginPresence } from "../components/usePluginPresence";
import type { AnchorageStore } from "../store/useAnchorageStore";

export function ModelsScreen({ store }: { store: AnchorageStore }) {
  // Asked rather than asserted: this screen used to report the plugin missing
  // whether or not it was installed. See components/usePluginPresence.ts.
  const presence = usePluginPresence(store, "model");
  return (
    <UnsupportedSurface
      testId="models-screen"
      title="Models"
      description="Needs the docker model plugin. Docker Model Runner serves local inference and is packaged separately from the Engine — on Linux it installs as its own package, docker-model-plugin, alongside Docker Engine."
      posture="The inference endpoint has no authentication by default. Anything that can reach the port can run inference, pull models and burn GPU."
      commandQuery=""
      plugin={{ name: "model", presence }}
      onOpenCommand={store.openCommandCenter}
    />
  );
}
