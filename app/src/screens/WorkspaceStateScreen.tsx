import {
  LockKeyIcon,
  PlugsIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { EngineStatus } from "../types";

const stateContent: Record<
  Exclude<EngineStatus, "ready">,
  { title: string; description: string; icon: typeof SpinnerGapIcon }
> = {
  loading: {
    title: "Connecting to engine",
    description: "Loading the current Docker context and local resources.",
    icon: SpinnerGapIcon,
  },
  disconnected: {
    title: "Engine disconnected",
    description:
      "Start Docker or reconnect to the configured context, then try again.",
    icon: PlugsIcon,
  },
  permission: {
    title: "Permission required",
    description:
      "Anchorage cannot access the Docker socket. Update your engine permissions, then retry.",
    icon: LockKeyIcon,
  },
  error: {
    title: "Could not load the engine",
    description:
      "Anchorage received an unexpected response while loading this context.",
    icon: WarningCircleIcon,
  },
};

export function WorkspaceStateScreen({ store }: { store: AnchorageStore }) {
  if (store.engineStatus === "ready") return null;
  const content = stateContent[store.engineStatus];
  const IconComponent = content.icon;

  return (
    <section
      className={`workspace-state workspace-state--${store.engineStatus} screen`}
      data-testid={`engine-state-${store.engineStatus}`}
    >
      <span className="workspace-state__icon">
        <IconComponent
          aria-hidden="true"
          size={25}
          weight={store.engineStatus === "loading" ? "regular" : "light"}
        />
      </span>
      <h1>{content.title}</h1>
      <p>{content.description}</p>
      {store.engineStatusMessage && store.engineStatus !== "loading" && (
        <code>{store.engineStatusMessage}</code>
      )}
      {store.engineStatus !== "loading" && (
        <button
          className="primary-button"
          type="button"
          onClick={() => void store.retryEngine()}
        >
          Retry connection
        </button>
      )}
    </section>
  );
}
