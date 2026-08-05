import { UnsupportedSurface } from "../components/UnsupportedSurface";
import type { AnchorageStore } from "../store/useAnchorageStore";

export function HardenedScreen({ store }: { store: AnchorageStore }) {
  return (
    <UnsupportedSurface
      testId="hardened-screen"
      title="Hardened images"
      description="Docker Hardened Images are a curated Docker Hub catalogue — community images are free under Apache-2.0, with FIPS and STIG variants on paid tiers. You pull one like any other image, and once pulled it is an ordinary image on the Images screen. The catalogue itself has no Engine API or CLI verb that enumerates it, so Anchorage cannot browse it."
      posture="A hardened base reduces what you inherit from it — a smaller package set and a low vulnerability count, not a zero one. It does nothing about the dependencies your own build adds on top, which is the half of the image you control."
      commandQuery=""
      onOpenCommand={store.openCommandCenter}
    />
  );
}
