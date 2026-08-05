import { UnsupportedSurface } from "../components/UnsupportedSurface";
import type { AnchorageStore } from "../store/useAnchorageStore";

/**
 * The description covers two products, so the posture has to say which one it is talking
 * about. The persistent team-shared cache is Build Cloud's (docker-features.md:1984);
 * Offload's cache is session-bound, along with the remote images and volumes destroyed when
 * the session ends (:1911). Attributing the shared cache to both overstates the exposure of
 * one and understates the ephemerality of the other.
 */
export function CloudScreen({ store }: { store: AnchorageStore }) {
  return (
    <UnsupportedSurface
      testId="cloud-screen"
      title="Cloud"
      description="Needs Docker Offload for a remote session, or a configured Build Cloud builder. Anchorage does not create either."
      posture="A Build Cloud builder shares one persistent cache with the whole team; an Offload session's cache belongs to that session. Secret and SSH mounts stay out of it. Build arguments, environment variables and anything else you bake into a layer do not — they can be read back out of the cache, the layers or the image history."
      commandQuery="buildx"
      onOpenCommand={store.openCommandCenter}
    />
  );
}
