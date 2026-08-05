import { UnsupportedSurface } from "../components/UnsupportedSurface";
import type { AnchorageStore } from "../store/useAnchorageStore";

/**
 * The kernel claim is context-dependent, so it is phrased against the active context rather
 * than the host: a Desktop context runs its own KVM/QEMU Linux VM (docker-features.md:423)
 * and its containers share that guest kernel, not this machine's (:1715, :2190).
 *
 * The seed is "compose bridge" because those are the only leaves in the discovered tree that
 * reach a cluster by name — `compose bridge convert` and the two transformations verbs —
 * and Compose bridge deployment is already the kubernetes entry in maturity.ts.
 */
export function KubernetesScreen({ store }: { store: AnchorageStore }) {
  return (
    <UnsupportedSurface
      testId="kubernetes-screen"
      title="Kubernetes"
      description="Anchorage does not read cluster state, so this stays unavailable even where a cluster is already running — the blocker is Anchorage, not your setup. Provisioning one is Docker Desktop's Kubernetes, kind or kubeadm, none of which Anchorage drives. Compose can translate a project into Kubernetes manifests, which is what the command palette opens on."
      posture="A Desktop or kubeadm cluster shares this engine's image store, so an image built here is already there. A kind cluster does not — its nodes are containers with their own store, and an image has to be loaded in first. Either way it is a development cluster: its workloads share one kernel with every other container on the engine you are pointed at, whether that is this host's kernel or a Desktop VM's."
      commandQuery="compose bridge"
      onOpenCommand={store.openCommandCenter}
    />
  );
}
