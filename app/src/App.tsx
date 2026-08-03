import { Shell } from "./components/Shell";
import { BuildsScreen } from "./screens/BuildsScreen";
import { ContainerDetailScreen } from "./screens/ContainerDetailScreen";
import { ContainersScreen } from "./screens/ContainersScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { DevEnvironmentsScreen } from "./screens/DevEnvironmentsScreen";
import { ExtensionsScreen } from "./screens/ExtensionsScreen";
import { ImagesScreen } from "./screens/ImagesScreen";
import { PlaceholderScreen } from "./screens/PlaceholderScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { NetworksScreen } from "./screens/NetworksScreen";
import { ComposeScreen } from "./screens/ComposeScreen";
import { VolumesScreen } from "./screens/VolumesScreen";
import { WorkspaceStateScreen } from "./screens/WorkspaceStateScreen";
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
      case "devenv":
        return <DevEnvironmentsScreen store={store} />;
      case "extensions":
        return <ExtensionsScreen store={store} />;
      case "settings":
        return <SettingsScreen store={store} />;
      default:
        return <PlaceholderScreen view={store.view} />;
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
