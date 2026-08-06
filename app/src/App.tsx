import { Shell } from "./components/Shell";
import { BuildsScreen } from "./screens/BuildsScreen";
import { ContainerDetailScreen } from "./screens/ContainerDetailScreen";
import { ContainersScreen } from "./screens/ContainersScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { ImagesScreen } from "./screens/ImagesScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { NetworksScreen } from "./screens/NetworksScreen";
import { ComposeScreen } from "./screens/ComposeScreen";
import { VolumesScreen } from "./screens/VolumesScreen";
import { WorkspaceStateScreen } from "./screens/WorkspaceStateScreen";
import { LogsScreen } from "./screens/LogsScreen";
import { ModelsScreen } from "./screens/ModelsScreen";
import { AgentsScreen } from "./screens/AgentsScreen";
import { ToolsScreen } from "./screens/ToolsScreen";
import { ScanScreen } from "./screens/ScanScreen";
import { SecretsScreen } from "./screens/SecretsScreen";
import { useAnchorageStore } from "./store/useAnchorageStore";

export function App() {
  const store = useAnchorageStore();

  const screen = (() => {
    if (store.engineStatus !== "ready") {
      return <WorkspaceStateScreen store={store} />;
    }
    switch (store.view) {
      case "dashboard":
        return <DashboardScreen store={store} />;
      case "containers":
        return store.selectedContainer ? (
          <ContainerDetailScreen store={store} />
        ) : (
          <ContainersScreen store={store} />
        );
      case "images":
        return <ImagesScreen store={store} />;
      case "volumes":
        return <VolumesScreen store={store} />;
      case "networks":
        return <NetworksScreen store={store} />;
      case "compose":
        return <ComposeScreen store={store} />;
      case "builds":
        return <BuildsScreen store={store} />;
      case "settings":
        return <SettingsScreen store={store} />;
      case "logs":
        return <LogsScreen store={store} />;
      case "models":
        return <ModelsScreen store={store} />;
      case "agents":
        return <AgentsScreen store={store} />;
      case "tools":
        return <ToolsScreen store={store} />;
      case "scan":
        return <ScanScreen store={store} />;
      case "secrets":
        return <SecretsScreen store={store} />;
      default: {
        // Every ViewId has a case above, so this is unreachable and TypeScript proves it:
        // `never` stops compiling the moment a destination is added without a route. That
        // is a stronger guarantee than the placeholder screen it replaces, which rendered a
        // plausible heading and let an unrouted destination ship looking finished.
        const unrouted: never = store.view;
        throw new Error(`unrouted view: ${String(unrouted)}`);
      }
    }
  })();

  return (
    <Shell store={store}>
      {screen}
      {store.error && (
        <div className="engine-error" role="alert">
          {store.error}
        </div>
      )}
    </Shell>
  );
}
