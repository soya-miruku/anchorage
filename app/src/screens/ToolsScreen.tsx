import { UnsupportedSurface } from "../components/UnsupportedSurface";
import type { AnchorageStore } from "../store/useAnchorageStore";

export function ToolsScreen({ store }: { store: AnchorageStore }) {
  return (
    <UnsupportedSurface
      testId="tools-screen"
      title="Tools"
      description="The MCP Toolkit ships with Docker Desktop. The Gateway underneath it is open source and runs against a standalone Engine, but Anchorage does not manage one yet."
      posture="Containerising a tool server limits its dependencies and its runtime blast radius. It does not reduce the authority you granted it — a token with write access still writes, whatever it runs inside."
      commandQuery=""
      onOpenCommand={store.openCommandCenter}
    />
  );
}
