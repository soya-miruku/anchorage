import { UnsupportedSurface } from "../components/UnsupportedSurface";
import type { AnchorageStore } from "../store/useAnchorageStore";

export function SandboxesScreen({ store }: { store: AnchorageStore }) {
  return (
    <UnsupportedSurface
      testId="sandboxes-screen"
      title="Sandboxes"
      description="Needs the docker sbx plugin. Sandboxes run one microVM per agent; on Linux they no longer require Docker Desktop, and the local CLI is free including commercial use."
      posture="A sandbox protects the host kernel and the host daemon: an agent can be root inside its own microVM without reaching either. It does not protect what you hand in — a writable workspace comes back rewritten and deserves reading like an untrusted pull request, a read-only mount still discloses .env and other ignored files, and a shared skills store carries a compromise from one sandbox into the next."
      commandQuery=""
      onOpenCommand={store.openCommandCenter}
    />
  );
}
