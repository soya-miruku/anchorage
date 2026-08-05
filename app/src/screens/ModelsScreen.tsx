import { UnsupportedSurface } from "../components/UnsupportedSurface";
import type { AnchorageStore } from "../store/useAnchorageStore";

export function ModelsScreen({ store }: { store: AnchorageStore }) {
  return (
    <UnsupportedSurface
      testId="models-screen"
      title="Models"
      description="Needs the docker model plugin. Docker Model Runner serves local inference and is packaged separately from the Engine — on Linux it installs as its own package, docker-model-plugin, alongside Docker Engine."
      posture="The inference endpoint has no authentication by default. Anything that can reach the port can run inference, pull models and burn GPU."
      commandQuery=""
      onOpenCommand={store.openCommandCenter}
    />
  );
}
