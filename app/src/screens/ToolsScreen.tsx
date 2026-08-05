import { UnsupportedSurface } from "../components/UnsupportedSurface";
import { usePluginPresence } from "../components/usePluginPresence";
import type { AnchorageStore } from "../store/useAnchorageStore";

export function ToolsScreen({ store }: { store: AnchorageStore }) {
  // Asked rather than asserted: this screen used to report the plugin missing
  // whether or not it was installed. See components/usePluginPresence.ts.
  const presence = usePluginPresence(store, "mcp");
  return (
    <UnsupportedSurface
      testId="tools-screen"
      title="Tools"
      description="The MCP Toolkit ships with Docker Desktop. The Gateway underneath it is open source and runs against a standalone Engine, but Anchorage does not manage one yet."
      posture="Containerising a tool server limits its dependencies and its runtime blast radius. It does not reduce the authority you granted it — a token with write access still writes, whatever it runs inside."
      commandQuery=""
      plugin={{ name: "mcp", presence }}
      onOpenCommand={store.openCommandCenter}
    />
  );
}
