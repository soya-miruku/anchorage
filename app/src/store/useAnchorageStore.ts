import {
  BUILD_FIXTURES,
  DEFAULT_ENGINE_RESOURCES,
  DEFAULT_FEATURE_FLAGS,
  DEV_ENVIRONMENT_FIXTURES,
  EXTENSION_FIXTURES,
  IMAGE_FIXTURES,
  REGISTRY_FIXTURES,
  VOLUME_FIXTURES,
} from "../data/fixtures";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createAnchorageBridge } from "../services/anchorageBridge";
import {
  canOfferRemove,
  canRestartContainer,
  primaryContainerAction,
  requiresForceRemove,
} from "../utils/containerPresentation";
import {
  DEFAULT_APPEARANCE,
  applyAppearancePreference,
  isCaptureAppearanceRequest,
  persistAppearancePreference,
  readAppearancePreference,
  type ColorMode,
  type ThemeFamily,
} from "../theme/appearance";
import type {
  AnchorageContainer,
  ContainerCreateOptions,
  ContainerRemoveOptions,
  AnchorageImage,
  AnchorageVolume,
  ContainerInspectResult,
  ContainerDiffResult,
  ContainerFileReadResult,
  ContainerFilesResult,
  ContainerStatsResult,
  ContainerTopResult,
  DetailTab,
  EngineResources,
  EngineStatus,
  FeatureFlags,
  ImageTab,
  LogLine,
  SessionEvent,
  SessionStartResult,
  ComposeProject,
  ComposeService,
  ComposeActionInput,
  ImagesScoutResult,
  VolumeFilesResult,
  VolumeFileReadResult,
  ComposeActionParams,
  SettingsTab,
  NetworkSummary,
  NetworksActionParams,
  SystemActionResult,
  SystemPruneOptions,
  SystemSnapshot,
  ViewId,
  ImageProjection,
  ImagesInspectResult,
  VolumeProjection,
} from "../types";

const formatClock = () =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
};

const formatCreated = (seconds: number, fallback?: string) => {
  if (fallback) return fallback;
  if (!Number.isFinite(seconds) || seconds <= 0) return "Unknown";
  const elapsed = Math.max(0, Date.now() - seconds * 1000);
  const days = Math.floor(elapsed / 86_400_000);
  if (days > 0) return `${days} day${days === 1 ? "" : "s"} ago`;
  const hours = Math.floor(elapsed / 3_600_000);
  return `${Math.max(1, hours)} hour${hours === 1 ? "" : "s"} ago`;
};

const splitImageReference = (reference?: string) => {
  if (!reference || reference === "<none>:<none>") {
    return { repository: "<none>", tag: "<none>" };
  }
  const slash = reference.lastIndexOf("/");
  const colon = reference.lastIndexOf(":");
  if (colon > slash) {
    return {
      repository: reference.slice(0, colon),
      tag: reference.slice(colon + 1),
    };
  }
  return { repository: reference, tag: "latest" };
};

const projectImages = (image: ImageProjection): AnchorageImage[] => {
  const references = [
    ...new Set(
      image.repoTags.filter(
        (reference) => reference && reference !== "<none>:<none>",
      ),
    ),
  ];
  const visibleReferences: Array<string | null> =
    references.length > 0 ? references : [null];
  const usageKnown =
    typeof image.containers === "number" &&
    Number.isFinite(image.containers) &&
    image.containers >= 0;
  const inUse = usageKnown && (image.containers ?? 0) > 0;
  return visibleReferences.map((reference) => {
    const { repository, tag } = splitImageReference(reference ?? undefined);
    return {
      repository,
      tag,
      id: image.id,
      imageId: image.id,
      reference,
      identity: `${image.id}\u0000${reference ?? "<none>"}`,
      created: formatCreated(image.created, image.createdDisplay),
      size: image.sizeDisplay ?? formatBytes(image.sizeBytes),
      sizeMb: image.sizeBytes / 1_000_000,
      usageKnown,
      inUse,
      reclaimable: usageKnown && !inUse,
    };
  });
};

const projectVolume = (volume: VolumeProjection): AnchorageVolume => {
  const sizeBytes =
    typeof volume.usage?.sizeBytes === "number" &&
    Number.isFinite(volume.usage.sizeBytes) &&
    volume.usage.sizeBytes >= 0
      ? volume.usage.sizeBytes
      : undefined;
  const refCount =
    typeof volume.usage?.refCount === "number" &&
    Number.isFinite(volume.usage.refCount) &&
    volume.usage.refCount >= 0
      ? volume.usage.refCount
      : undefined;
  const usageKnown = refCount !== undefined;
  return {
    name: volume.name,
    driver: volume.driver,
    size:
      volume.sizeDisplay ??
      (sizeBytes === undefined ? "Unavailable" : formatBytes(sizeBytes)),
    usedBy:
      usageKnown && refCount > 0
        ? `${refCount} container${refCount === 1 ? "" : "s"}`
        : null,
    created: volume.createdAt
      ? new Date(volume.createdAt).toLocaleDateString("en-GB")
      : "Unknown",
    usageKnown,
    sizeBytes,
    refCount,
  };
};

/**
 * Preserve object identity for containers whose rendered fields are unchanged.
 *
 * Every poll builds brand-new container objects, so without this every row's props change
 * identity twice a second and no amount of React.memo downstream can prevent a full re-render
 * of the table. Reusing the previous object where nothing changed makes referential equality
 * meaningful again, which also stabilizes the useMemo deps built on top of it.
 */
const CONTAINER_RENDER_FIELDS = [
  "id",
  "name",
  "image",
  "ports",
  "state",
  "rawState",
  "status",
  "exitCode",
  "kind",
  "cpu",
  "memory",
  "memoryLimit",
  "health",
  "progress",
] as const;

export const reconcileContainerIdentity = (
  previous: AnchorageContainer[],
  next: AnchorageContainer[],
): AnchorageContainer[] => {
  if (previous.length === 0) return next;
  const byId = new Map(previous.map((container) => [container.id, container]));
  let changed = previous.length !== next.length;
  const merged = next.map((candidate, index) => {
    const existing = byId.get(candidate.id);
    if (
      existing &&
      CONTAINER_RENDER_FIELDS.every((field) => existing[field] === candidate[field])
    ) {
      if (previous[index] !== existing) changed = true;
      return existing;
    }
    changed = true;
    return candidate;
  });
  return changed ? merged : previous;
};

/**
 * Same identity preservation for images and volumes, whose lists are re-polled every 10s
 * while their views are visible. Keyed by the fields each row renders.
 */
const reconcileByKey = <T,>(
  previous: T[],
  next: T[],
  keyOf: (item: T) => string,
  fields: ReadonlyArray<keyof T>,
): T[] => {
  if (previous.length === 0) return next;
  const byKey = new Map(previous.map((item) => [keyOf(item), item]));
  let changed = previous.length !== next.length;
  const merged = next.map((candidate, index) => {
    const existing = byKey.get(keyOf(candidate));
    if (existing && fields.every((field) => existing[field] === candidate[field])) {
      if (previous[index] !== existing) changed = true;
      return existing;
    }
    changed = true;
    return candidate;
  });
  return changed ? merged : previous;
};

const IMAGE_RENDER_FIELDS = [
  "repository",
  "tag",
  "id",
  "imageId",
  "reference",
  "created",
  "size",
  "sizeMb",
  "usageKnown",
  "inUse",
  "reclaimable",
] as const;

const VOLUME_RENDER_FIELDS = [
  "name",
  "driver",
  "size",
  "usedBy",
  "created",
  "usageKnown",
  "sizeBytes",
  "refCount",
] as const;

const decodeSessionData = (event: Extract<SessionEvent, { event: "session.output" }>) => {
  if (event.payload.encoding === "utf-8") return event.payload.data;
  try {
    const binary = window.atob(event.payload.data);
    return new TextDecoder().decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return "";
  }
};

/**
 * Consecutive container-poll failures tolerated before the engine is reported as unavailable.
 * A momentary daemon stall must not blow the whole application away to an error screen.
 */
const POLL_FAILURE_TOLERANCE = 3;

/**
 * Upper bound on containers sampled per list-stats poll. Each sample costs a full daemon
 * collection cycle, so this is sized against the core's fan-out width to keep one batch
 * inside one interval.
 */
const LIST_STATS_BATCH_LIMIT = 32;
/** Slower than the 2s container poll: metrics are supplementary, not authoritative. */
const LIST_STATS_INTERVAL_MS = 8_000;

const classifyEngineFailure = (
  reason: unknown,
): { status: Exclude<EngineStatus, "loading" | "ready">; message: string } => {
  const message =
    reason instanceof Error ? reason.message : "The engine request failed.";
  if (/permission|eacces|access denied|not authorized/iu.test(message)) {
    return { status: "permission", message };
  }
  if (
    /econnrefused|disconnected|daemon.+not running|socket.+unavailable|engine unavailable|cannot connect/iu.test(
      message,
    )
  ) {
    return { status: "disconnected", message };
  }
  return { status: "error", message };
};

const reconciliationFailureMessage = (
  action: string,
  reason: unknown,
): string => {
  const detail =
    reason instanceof Error ? reason.message : "live refresh failed";
  return `${action} succeeded, but the live view could not be reconciled (${detail}). The displayed data may be stale; do not repeat the action solely to refresh it.`;
};

export function useAnchorageStore() {
  const bridgeRef = useRef(createAnchorageBridge());
  const bridge = bridgeRef.current;
  const isHost = bridge.mode === "host";
  const captureAppearance = isCaptureAppearanceRequest(
    typeof window === "undefined" ? "" : window.location.search,
  );
  const engineRequestRef = useRef(0);
  const dockerContextRef = useRef("default");
  const [view, setView] = useState<ViewId>("containers");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // File and process fetches are async; a ref lets them discard results for a container the
  // user has already navigated away from.
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const [detailTab, setDetailTab] = useState<DetailTab>("logs");
  const [search, setSearchValue] = useState("");
  const [commandCenterOpen, setCommandCenterOpen] = useState(false);
  const [commandCenterInitialQuery, setCommandCenterInitialQuery] =
    useState("");
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [composeFilter, setComposeFilter] = useState<string | null>(null);
  const [bannerVisible, setBannerVisible] = useState(true);
  const [containers, setContainers] = useState<AnchorageContainer[]>([]);
  // The list-stats poll reads the current containers through a ref so it does not resubscribe
  // (and restart its interval) on every 2s list refresh.
  const containersRef = useRef<AnchorageContainer[]>([]);
  containersRef.current = containers;
  const [logsByContainer, setLogsByContainer] = useState<
    Record<string, LogLine[]>
  >({});
  const [logFilter, setLogFilter] = useState("");
  const [followLogs, setFollowLogs] = useState(true);
  /** Monotonic counter for streamed log line ids. */
  const followLineSequenceRef = useRef(0);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("loading");
  const [engineStatusMessage, setEngineStatusMessage] = useState<string | null>(
    null,
  );
  const [dockerContext, setDockerContext] = useState("default");
  const [availableContexts, setAvailableContexts] = useState<
    Array<{ name: string; current: boolean; description?: string }>
  >([]);
  /** Set when the user explicitly picks a context, so rediscovery stops overriding it. */
  const pinnedContextRef = useRef<string | null>(null);
  const [systemSnapshot, setSystemSnapshot] =
    useState<SystemSnapshot | null>(null);
  const [hostDomainState, setHostDomainState] = useState<
    Record<
      "snapshot" | "images" | "volumes",
      { status: "idle" | "loading" | "ready" | "error"; error?: string }
    >
  >({
    snapshot: { status: "idle" },
    images: { status: "idle" },
    volumes: { status: "idle" },
  });
  const [inspectByContainer, setInspectByContainer] = useState<
    Record<string, ContainerInspectResult>
  >({});
  const [statsByContainer, setStatsByContainer] = useState<
    Record<string, ContainerStatsResult>
  >({});
  /**
   * Sampled CPU/memory history, keyed by container id.
   *
   * This must live outside the `containers` array. The 2s container poll replaces every
   * container object wholesale with a freshly normalized one whose history arrays are empty,
   * so history stored on the container was erased faster than the stats sampler could
   * accumulate it and the charts never filled.
   */
  const [statsHistoryByContainer, setStatsHistoryByContainer] = useState<
    Record<string, { cpu: number[]; memory: number[] }>
  >({});
  const [detailErrors, setDetailErrors] = useState<
    Record<string, Partial<Record<DetailTab, string>>>
  >({});
  const [imageTab, setImageTab] = useState<ImageTab>("local");
  /**
   * `docker image ls` switches. The bridge used to hardcode these, which inverted Docker's
   * default and rendered every untagged layer with no way to narrow the list.
   */
  const [imageFilters, setImageFiltersState] = useState({
    all: false,
    includeDangling: false,
  });
  const [imageQuery, setImageQuery] = useState("");
  const [networks, setNetworks] = useState<NetworkSummary[]>([]);
  const [networkMutationPending, setNetworkMutationPending] = useState(false);
  // refreshImages is memoized on [bridge, isHost] and is called from polls and event
  // handlers, so it reads the current filters through a ref rather than closing over them.
  const imageFiltersRef = useRef(imageFilters);
  imageFiltersRef.current = imageFilters;
  const [registryQuery, setRegistryQuery] = useState("");
  const [images, setImages] = useState<AnchorageImage[]>(() =>
    isHost ? [] : IMAGE_FIXTURES.map((image) => ({ ...image })),
  );
  const [pulledRegistryImages, setPulledRegistryImages] = useState<Set<string>>(
    new Set(),
  );
  /**
   * The one in-flight session-backed transfer: pull, save, load or export.
   *
   * Only one is tracked at a time because they share a single progress surface and starting
   * a second cancels the first — the same rule Docker Desktop applies to its pull panel.
   */
  const [imageTransfer, setImageTransfer] = useState<{
    /** "Pull" | "Save" | "Load" | "Export" — what the progress panel is reporting on. */
    title: string;
    reference: string;
    status: "starting" | "running" | "exited" | "error";
    output: string;
    error?: string;
  } | null>(null);
  const [imageMutationPending, setImageMutationPending] = useState(false);
  // Distinct from `composeProjects` below, which is only the set of project *names* found
  // on container labels and drives the Containers filter. This is the plugin's own project
  // list, which also covers projects whose containers are all stopped.
  const [composeProjectList, setComposeProjectList] = useState<ComposeProject[]>([]);
  const [composeStatus, setComposeStatus] = useState<
    "idle" | "loading" | "ready" | "unavailable" | "error"
  >("idle");
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeServices, setComposeServices] = useState<
    Record<string, ComposeService[]>
  >({});
  const [expandedComposeProject, setExpandedComposeProject] = useState<
    string | null
  >(null);
  const [volumes, setVolumes] = useState<AnchorageVolume[]>(() =>
    isHost ? [] : VOLUME_FIXTURES.map((volume) => ({ ...volume })),
  );
  const [volumeMutationPending, setVolumeMutationPending] = useState(false);
  // Keyed by image reference so re-opening a panel shows the previous result instantly;
  // Scout caches its own index, but a round trip is still seconds.
  const [scoutByReference, setScoutByReference] = useState<
    Record<string, ImagesScoutResult>
  >({});
  const [scoutPending, setScoutPending] = useState<string | null>(null);
  const [scoutError, setScoutError] = useState<string | null>(null);
  const [browsedVolume, setBrowsedVolume] = useState<string | null>(null);
  const [volumePath, setVolumePath] = useState("/");
  const [volumeListing, setVolumeListing] = useState<VolumeFilesResult | null>(null);
  const [volumePreview, setVolumePreview] = useState<VolumeFileReadResult | null>(
    null,
  );
  const [volumeBrowseError, setVolumeBrowseError] = useState<string | null>(null);
  const [selectedBuildId, setSelectedBuildId] = useState(
    BUILD_FIXTURES[0]?.id ?? "",
  );
  const [devEnvironments, setDevEnvironments] = useState(() =>
    isHost
      ? []
      : DEV_ENVIRONMENT_FIXTURES.map((environment) => ({
          ...environment,
          tags: [...environment.tags],
        })),
  );
  const [openedEnvironmentId, setOpenedEnvironmentId] = useState<string | null>(
    null,
  );
  const [installedExtensions, setInstalledExtensions] = useState<Set<string>>(
    () => (isHost ? new Set() : new Set(["Disk Usage", "Logs Explorer"])),
  );
  const transferCleanupRef = useRef<(() => void) | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() =>
    isHost && !captureAppearance ? "appearance" : "resources",
  );
  const [resources, setResources] = useState<EngineResources>(() => ({
    ...DEFAULT_ENGINE_RESOURCES,
  }));
  const [appliedResources, setAppliedResources] = useState<EngineResources>(
    () => ({ ...DEFAULT_ENGINE_RESOURCES }),
  );
  const [resourceNotice, setResourceNotice] = useState<string | null>(null);
  const [featureFlags, setFeatureFlags] = useState<FeatureFlags>(() => ({
    ...DEFAULT_FEATURE_FLAGS,
  }));
  const [appearance, setAppearance] = useState(readAppearancePreference);
  const [
    appearancePersistenceSucceeded,
    setAppearancePersistenceSucceeded,
  ] = useState<boolean | null>(null);
  const snapshotRefreshRef = useRef<Promise<SystemSnapshot | null> | null>(
    null,
  );
  const snapshotRefreshContextRef = useRef<string | null>(null);
  const imageRefreshRef = useRef<Promise<AnchorageImage[]> | null>(null);
  const imageRefreshContextRef = useRef<string | null>(null);
  const volumeRefreshRef = useRef<Promise<AnchorageVolume[]> | null>(null);
  const volumeRefreshContextRef = useRef<string | null>(null);
  const containerRefreshRef = useRef<Promise<AnchorageContainer[]> | null>(
    null,
  );
  const statsInFlightRef = useRef(false);
  const statsSequenceRef = useRef(0);
  const statsAppliedSequenceRef = useRef(0);

  const refreshSnapshot = useCallback(
    (
      context = dockerContextRef.current,
      includeDiskUsage = false,
    ): Promise<SystemSnapshot | null> => {
      if (!isHost) return Promise.resolve(null);
      if (snapshotRefreshRef.current) {
        if (snapshotRefreshContextRef.current === context) {
          return snapshotRefreshRef.current;
        }
        return snapshotRefreshRef.current
          .catch(() => null)
          .then(() => refreshSnapshot(context));
      }
      let request!: Promise<SystemSnapshot | null>;
      request = (async () => {
        setHostDomainState((current) => ({
          ...current,
          snapshot: { status: "loading" },
        }));
        try {
          const next = await bridge.system.snapshot(context, includeDiskUsage);
          if (context !== dockerContextRef.current) return null;
          setSystemSnapshot(next);
          setHostDomainState((current) => ({
            ...current,
            snapshot: { status: "ready" },
          }));
          return next;
        } catch (reason) {
          if (context === dockerContextRef.current) {
            setHostDomainState((current) => ({
              ...current,
              snapshot: {
                status: "error",
                error:
                  reason instanceof Error
                    ? reason.message
                    : "System snapshot failed",
              },
            }));
          }
          throw reason;
        } finally {
          if (snapshotRefreshRef.current === request) {
            snapshotRefreshRef.current = null;
            snapshotRefreshContextRef.current = null;
          }
        }
      })();
      snapshotRefreshRef.current = request;
      snapshotRefreshContextRef.current = context;
      return request;
    },
    [bridge, isHost],
  );

  const refreshImages = useCallback(
    (context = dockerContextRef.current): Promise<AnchorageImage[]> => {
      if (!isHost) return Promise.resolve([]);
      if (imageRefreshRef.current) {
        if (imageRefreshContextRef.current === context) {
          return imageRefreshRef.current;
        }
        return imageRefreshRef.current
          .catch(() => [])
          .then(() => refreshImages(context));
      }
      let request!: Promise<AnchorageImage[]>;
      request = (async () => {
        setHostDomainState((current) => ({
          ...current,
          images: { status: "loading" },
        }));
        try {
          const result = await bridge.images.list(context, imageFiltersRef.current);
          const next = result.images.flatMap(projectImages);
          if (context !== dockerContextRef.current) return [];
          setImages((current) =>
            reconcileByKey(current, next, (image) => image.identity, IMAGE_RENDER_FIELDS),
          );
          setHostDomainState((current) => ({
            ...current,
            images: { status: "ready" },
          }));
          return next;
        } catch (reason) {
          if (context === dockerContextRef.current) {
            setHostDomainState((current) => ({
              ...current,
              images: {
                status: "error",
                error:
                  reason instanceof Error
                    ? reason.message
                    : "Image list failed",
              },
            }));
          }
          throw reason;
        } finally {
          if (imageRefreshRef.current === request) {
            imageRefreshRef.current = null;
            imageRefreshContextRef.current = null;
          }
        }
      })();
      imageRefreshRef.current = request;
      imageRefreshContextRef.current = context;
      return request;
    },
    [bridge, isHost],
  );

  const refreshNetworks = useCallback(async (): Promise<NetworkSummary[]> => {
    if (!isHost) return [];
    const context = dockerContextRef.current;
    try {
      const result = await bridge.networks.list(context);
      if (context !== dockerContextRef.current) return [];
      setNetworks(result.networks);
      return result.networks;
    } catch (reason) {
      if (context === dockerContextRef.current) {
        setError(
          reason instanceof Error ? reason.message : "Network list failed",
        );
      }
      return [];
    }
  }, [bridge, isHost]);

  const refreshVolumes = useCallback(
    (context = dockerContextRef.current): Promise<AnchorageVolume[]> => {
      if (!isHost) return Promise.resolve([]);
      if (volumeRefreshRef.current) {
        if (volumeRefreshContextRef.current === context) {
          return volumeRefreshRef.current;
        }
        return volumeRefreshRef.current
          .catch(() => [])
          .then(() => refreshVolumes(context));
      }
      let request!: Promise<AnchorageVolume[]>;
      request = (async () => {
        setHostDomainState((current) => ({
          ...current,
          volumes: { status: "loading" },
        }));
        try {
          const result = await bridge.volumes.list(context);
          const next = result.volumes.map(projectVolume);
          if (context !== dockerContextRef.current) return [];
          setVolumes((current) =>
            reconcileByKey(current, next, (volume) => volume.name, VOLUME_RENDER_FIELDS),
          );
          setHostDomainState((current) => ({
            ...current,
            volumes: { status: "ready" },
          }));
          return next;
        } catch (reason) {
          if (context === dockerContextRef.current) {
            setHostDomainState((current) => ({
              ...current,
              volumes: {
                status: "error",
                error:
                  reason instanceof Error
                    ? reason.message
                    : "Volume list failed",
              },
            }));
          }
          throw reason;
        } finally {
          if (volumeRefreshRef.current === request) {
            volumeRefreshRef.current = null;
            volumeRefreshContextRef.current = null;
          }
        }
      })();
      volumeRefreshRef.current = request;
      volumeRefreshContextRef.current = context;
      return request;
    },
    [bridge, isHost],
  );

  const refreshContainers = useCallback(() => {
    if (containerRefreshRef.current) return containerRefreshRef.current;
    const context = dockerContextRef.current;
    const request = (async () => {
      try {
        const next = await bridge.containers.list(context);
        if (context !== dockerContextRef.current) return [];
        setContainers((current) => reconcileContainerIdentity(current, next));
        setEngineStatus("ready");
        setEngineStatusMessage(null);
        setError(null);
        return next;
      } finally {
        containerRefreshRef.current = null;
      }
    })();
    containerRefreshRef.current = request;
    return request;
  }, [bridge]);

  const retryEngine = useCallback(async () => {
    const request = ++engineRequestRef.current;
    setEngineStatus("loading");
    setEngineStatusMessage(null);
    try {
      let context = dockerContextRef.current;
      const capabilities = await bridge.system.capabilities();
      setAvailableContexts(
        capabilities.contexts.map((candidate) => ({
          name: candidate.name,
          current: Boolean(candidate.current),
          description: candidate.description,
        })),
      );
      // An explicit user choice wins over rediscovery; otherwise a reconnect would silently
      // pull the UI back to the daemon's own current context.
      const pinned = pinnedContextRef.current;
      context =
        (pinned &&
          capabilities.contexts.some((candidate) => candidate.name === pinned) &&
          pinned) ||
        capabilities.selectedContext ||
        capabilities.currentContext ||
        capabilities.contexts.find((candidate) => candidate.current)?.name ||
        capabilities.contexts[0]?.name ||
        context;
      dockerContextRef.current = context;
      setDockerContext(context);
      const next = await bridge.containers.list(context);
      if (request !== engineRequestRef.current) return;
      setContainers((current) => reconcileContainerIdentity(current, next));
      setEngineStatus("ready");
      setError(null);
      if (isHost) {
        void Promise.allSettled([
          refreshSnapshot(context),
          refreshImages(context),
          refreshVolumes(context),
        ]);
      }
    } catch (reason) {
      if (request !== engineRequestRef.current) return;
      const failure = classifyEngineFailure(reason);
      setEngineStatus(failure.status);
      setEngineStatusMessage(failure.message);
    }
  }, [bridge, isHost, refreshImages, refreshSnapshot, refreshVolumes]);

  useEffect(() => {
    void retryEngine();
    const unsubscribe =
      bridge.mode === "fixture"
        ? bridge.containers.subscribe?.((next) => {
            setContainers((current) => reconcileContainerIdentity(current, next));
            setEngineStatus("ready");
            setEngineStatusMessage(null);
          })
        : bridge.events.subscribe((event) => {
            if (event.event === "core.status") {
              if (event.payload.state === "ready") {
                void retryEngine();
              } else if (
                ["crashed", "unavailable", "incompatible"].includes(
                  event.payload.state,
                )
              ) {
                setEngineStatus("disconnected");
                setEngineStatusMessage(
                  `Docker core is ${event.payload.state}. Reconnecting…`,
                );
              }
              return;
            }
            if (event.payload.context !== dockerContextRef.current) return;
            switch (event.payload.domain) {
              case "container": {
                // Invalidate only the container the event names. Resetting the whole map blanked
                // the Inspect and Bind-mounts tabs of the container the user was looking at, and
                // nothing refetched it, so those tabs stayed empty until re-selection.
                const mutated = event.payload.resourceId;
                if (mutated) {
                  setInspectByContainer((current) => {
                    if (!(mutated in current)) return current;
                    const next = { ...current };
                    delete next[mutated];
                    return next;
                  });
                  setStatsByContainer((current) => {
                    if (!(mutated in current)) return current;
                    const next = { ...current };
                    delete next[mutated];
                    return next;
                  });
                } else {
                  setInspectByContainer({});
                  setStatsByContainer({});
                }
                void refreshContainers().catch(() => undefined);
                void refreshSnapshot().catch(() => undefined);
                break;
              }
              case "image":
                void refreshImages().catch(() => undefined);
                void refreshSnapshot().catch(() => undefined);
                break;
              case "volume":
                void refreshVolumes().catch(() => undefined);
                void refreshSnapshot().catch(() => undefined);
                break;
            }
          });
    return () => {
      engineRequestRef.current += 1;
      unsubscribe?.();
      transferCleanupRef.current?.();
      transferCleanupRef.current = null;
    };
  }, [
    bridge,
    refreshContainers,
    refreshImages,
    refreshSnapshot,
    refreshVolumes,
    retryEngine,
  ]);

  useEffect(() => {
    if (!isHost || engineStatus !== "ready") return;
    let disposed = false;
    // A single slow or erroring poll used to tear the interval down and replace the whole UI
    // with a full-screen error. Tolerate a short run of consecutive failures first, and keep
    // the interval alive either way so recovery is automatic rather than requiring a click.
    let consecutiveFailures = 0;
    const poll = () => {
      if (disposed || document.visibilityState === "hidden") return;
      void refreshContainers()
        .then(() => {
          consecutiveFailures = 0;
        })
        .catch((reason) => {
          if (disposed) return;
          consecutiveFailures += 1;
          if (consecutiveFailures < POLL_FAILURE_TOLERANCE) return;
          const failure = classifyEngineFailure(reason);
          setEngineStatus(failure.status);
          setEngineStatusMessage(failure.message);
        });
    };
    const timer = window.setInterval(poll, 2_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [engineStatus, isHost, refreshContainers]);

  useEffect(() => {
    if (!isHost || engineStatus !== "ready") return;
    const refreshVisibleDomain = () => {
      if (document.visibilityState === "hidden") return;
      if (view === "images") {
        void refreshImages().catch(() => undefined);
      } else if (view === "volumes") {
        void refreshVolumes().catch(() => undefined);
      } else if (view === "networks") {
        void refreshNetworks().catch(() => undefined);
      } else if (view === "dashboard") {
        // The dashboard is the only surface that displays disk usage, so it is the only one
        // that pays for the daemon's disk walk.
        void refreshSnapshot(dockerContextRef.current, true).catch(() => undefined);
      }
    };
    refreshVisibleDomain();
    if (
      view !== "images" &&
      view !== "volumes" &&
      view !== "networks" &&
      view !== "dashboard"
    ) {
      return;
    }
    const timer = window.setInterval(refreshVisibleDomain, 10_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshVisibleDomain();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    engineStatus,
    isHost,
    refreshImages,
    refreshNetworks,
    refreshSnapshot,
    refreshVolumes,
    view,
  ]);

  // The status-bar clock now owns its own interval inside <StatusClock/>. Keeping it here
  // meant a 1 Hz tick re-rendered the entire application tree for one <time> element.

  const navigate = useCallback((nextView: ViewId) => {
    setView(nextView);
    setSelectedId(null);
  }, []);

  const setSearch = useCallback((value: string) => {
    setSearchValue(value);
    // Do not force-navigate. Typing used to throw the user from Images or Volumes to
    // Containers mid-keystroke, losing their place; the query now filters whichever
    // resource view they are actually on.
    setSelectedId(null);
  }, []);

  const openCommandCenter = useCallback((initialQuery = "") => {
    setCommandCenterInitialQuery(initialQuery);
    setCommandCenterOpen(true);
  }, []);

  const closeCommandCenter = useCallback(() => {
    setCommandCenterOpen(false);
    setCommandCenterInitialQuery("");
  }, []);

  const selectContainer = useCallback(
    async (id: string) => {
      setView("containers");
      setSelectedId(id);
      setDetailTab("logs");
      setLogFilter("");
      const [logsResult, inspectResult] = await Promise.allSettled([
          logsByContainer[id]
            ? Promise.resolve(logsByContainer[id])
            : bridge.containers.logs(id, dockerContextRef.current),
          isHost && !inspectByContainer[id]
            ? bridge.containers.inspect(id, dockerContextRef.current)
            : Promise.resolve(inspectByContainer[id]),
        ]);
      if (logsResult.status === "fulfilled") {
        setLogsByContainer((current) => {
          const seen = new Set<string>();
          const merged = [
            ...logsResult.value,
            ...(current[id] ?? []),
          ].filter((line) => {
            if (seen.has(line.id)) return false;
            seen.add(line.id);
            return true;
          });
          return {
            ...current,
            [id]: merged.slice(-500),
          };
        });
        setDetailErrors((current) => ({
          ...current,
          [id]: { ...current[id], logs: undefined },
        }));
      } else {
        setDetailErrors((current) => ({
          ...current,
          [id]: {
            ...current[id],
            logs:
              logsResult.reason instanceof Error
                ? logsResult.reason.message
                : "Container logs are unavailable",
          },
        }));
      }
      if (inspectResult.status === "fulfilled" && inspectResult.value) {
        setInspectByContainer((current) => ({
          ...current,
          [id]: inspectResult.value,
        }));
        setDetailErrors((current) => ({
          ...current,
          [id]: { ...current[id], inspect: undefined, mounts: undefined },
        }));
      } else if (inspectResult.status === "rejected") {
        const message =
          inspectResult.reason instanceof Error
            ? inspectResult.reason.message
            : "Container inspection is unavailable";
        setDetailErrors((current) => ({
          ...current,
          [id]: { ...current[id], inspect: message, mounts: message },
        }));
      }
    },
    [bridge, inspectByContainer, isHost, logsByContainer],
  );

  const runMutation = useCallback(
    async (
      id: string,
      action: string,
      operation: () => Promise<AnchorageContainer | void>,
    ) => {
      setPendingIds((current) => new Set(current).add(id));
      let updated: AnchorageContainer | void;
      try {
        updated = await operation();
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : `${action} failed`,
        );
        setPendingIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        return;
      }
      try {
        if (isHost) {
          await refreshContainers();
          void refreshSnapshot().catch(() => undefined);
        } else if (updated) {
          setContainers((current) =>
            current.map((container) =>
              container.id === id ? updated : container,
            ),
          );
        } else {
          await refreshContainers();
        }
        setError(null);
      } catch (reason) {
        setError(reconciliationFailureMessage(action, reason));
      } finally {
        setPendingIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [isHost, refreshContainers, refreshSnapshot],
  );

  const toggleContainer = useCallback(
    async (container: AnchorageContainer) => {
      const action = primaryContainerAction(container);
      if (!action) return;
      const operation =
        action === "stop"
          ? () => bridge.containers.stop(container.id, dockerContextRef.current)
          : action === "unpause"
            ? () =>
                bridge.containers.unpause(container.id, dockerContextRef.current)
            : () =>
                bridge.containers.start(container.id, dockerContextRef.current);
      await runMutation(
        container.id,
        action === "stop"
          ? "Container stop"
          : action === "unpause"
            ? "Container unpause"
            : "Container start",
        operation,
      );
      if (!isHost && action === "start") {
        const nextLogs = await bridge.containers.logs(
          container.id,
          dockerContextRef.current,
        );
        setLogsByContainer((current) => ({
          ...current,
          [container.id]: [
            ...nextLogs,
            {
              id: `${container.id}-started`,
              timestamp: formatClock(),
              level: "INFO",
              message: "Container started",
            },
          ],
        }));
      }
    },
    [bridge, isHost, runMutation],
  );

  const restartContainer = useCallback(
    (container: AnchorageContainer) => {
      if (!canRestartContainer(container)) return Promise.resolve();
      return runMutation(container.id, "Container restart", () =>
          bridge.containers.restart(container.id, dockerContextRef.current),
        );
    },
    [bridge, runMutation],
  );

  /**
   * Bulk selection for the containers table. Docker Desktop ships checkbox multi-select with
   * a bulk Start/Stop/Delete bar; Anchorage had no way to act on more than one row at a time.
   */
  const [selectedContainerIds, setSelectedContainerIds] = useState<Set<string>>(
    new Set(),
  );

  const toggleContainerSelection = useCallback((id: string) => {
    setSelectedContainerIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setContainerSelection = useCallback((ids: string[]) => {
    setSelectedContainerIds(new Set(ids));
  }, []);

  const clearContainerSelection = useCallback(() => {
    setSelectedContainerIds(new Set());
  }, []);

  const [containerCreatePending, setContainerCreatePending] = useState(false);

  /**
   * Create (and optionally start) a container. Structured rather than argv-based, so the
   * form is validated by the same layered contract as every other mutation.
   */
  const createContainer = useCallback(
    async (options: ContainerCreateOptions) => {
      if (!isHost) return null;
      setContainerCreatePending(true);
      try {
        let created;
        try {
          created = await bridge.containers.create(
            options,
            dockerContextRef.current,
          );
        } catch (reason) {
          setError(
            reason instanceof Error ? reason.message : "Container creation failed",
          );
          return null;
        }
        try {
          await refreshContainers();
        } catch (reason) {
          setError(reconciliationFailureMessage("Container creation", reason));
          return created;
        }
        setError(null);
        return created;
      } finally {
        setContainerCreatePending(false);
      }
    },
    [bridge, isHost, refreshContainers],
  );

  const pauseContainer = useCallback(
    (container: AnchorageContainer) => {
      if (container.state !== "running") return Promise.resolve();
      return runMutation(container.id, "Container pause", () =>
        bridge.containers.pause(container.id, dockerContextRef.current),
      );
    },
    [bridge, runMutation],
  );

  const unpauseContainer = useCallback(
    (container: AnchorageContainer) => {
      if (container.state !== "paused") return Promise.resolve();
      return runMutation(container.id, "Container unpause", () =>
        bridge.containers.unpause(container.id, dockerContextRef.current),
      );
    },
    [bridge, runMutation],
  );

  const renameContainer = useCallback(
    (container: AnchorageContainer, name: string) => {
      const trimmed = name.trim();
      if (!trimmed || trimmed === container.name) return Promise.resolve();
      return runMutation(container.id, "Container rename", () =>
        bridge.containers.rename(container.id, trimmed, dockerContextRef.current),
      );
    },
    [bridge, runMutation],
  );

  const updateContainer = useCallback(
    (
      container: AnchorageContainer,
      limits: {
        cpuShares?: number;
        memoryBytes?: number;
        restartPolicy?: "no" | "always" | "unless-stopped" | "on-failure";
      },
    ) =>
      runMutation(container.id, "Container update", () =>
        bridge.containers.update(container.id, limits, dockerContextRef.current),
      ),
    [bridge, runMutation],
  );

  const commitContainer = useCallback(
    async (
      container: AnchorageContainer,
      options: { repository: string; tag?: string; comment?: string; pause?: boolean },
    ) => {
      if (!isHost) return null;
      try {
        const result = await bridge.containers.commit(
          container.id,
          options,
          dockerContextRef.current,
        );
        await refreshImages().catch(() => undefined);
        setError(null);
        return result;
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : "Container commit failed",
        );
        return null;
      }
    },
    [bridge, isHost, refreshImages],
  );

  const killContainer = useCallback(
    (container: AnchorageContainer, signal?: string) => {
      if (!["running", "paused", "restarting"].includes(container.state)) {
        return Promise.resolve();
      }
      return runMutation(container.id, "Container kill", () =>
        bridge.containers.kill(container.id, dockerContextRef.current, signal),
      );
    },
    [bridge, runMutation],
  );

  const deleteContainer = useCallback(
    async (
      container: AnchorageContainer,
      options: ContainerRemoveOptions = {},
    ) => {
      if (!canOfferRemove(container)) return;
      // Docker cannot remove a running/paused/restarting container without --force, so require
      // the caller to have obtained explicit consent for it rather than silently escalating.
      if (requiresForceRemove(container) && !options.force) return;
      setPendingIds((current) => new Set(current).add(container.id));
      try {
        try {
          await bridge.containers.remove(
            container.id,
            dockerContextRef.current,
            options,
          );
        } catch (reason) {
          setError(
            reason instanceof Error ? reason.message : "Container delete failed",
          );
          return;
        }
        setContainers((current) =>
          current.filter((item) => item.id !== container.id),
        );
        setLogsByContainer((current) => {
          const next = { ...current };
          delete next[container.id];
          return next;
        });
        setInspectByContainer((current) => {
          const next = { ...current };
          delete next[container.id];
          return next;
        });
        setStatsByContainer((current) => {
          const next = { ...current };
          delete next[container.id];
          return next;
        });
        if (selectedId === container.id) setSelectedId(null);
        let reconciled: AnchorageContainer[];
        try {
          reconciled = await bridge.containers.list(
            dockerContextRef.current,
          );
        } catch (reason) {
          setError(
            reconciliationFailureMessage("Container delete", reason),
          );
          return;
        }
        setContainers((current) => reconcileContainerIdentity(current, reconciled));
        if (isHost) void refreshSnapshot().catch(() => undefined);
        if (
          selectedId === container.id &&
          !reconciled.some((item) => item.id === container.id)
        ) {
          setSelectedId(null);
        }
        setError(null);
      } finally {
        setPendingIds((current) => {
          const next = new Set(current);
          next.delete(container.id);
          return next;
        });
      }
    },
    [bridge, isHost, refreshSnapshot, selectedId],
  );

  /**
   * Apply an action to every selected container that can accept it, then clear the selection.
   * Failures are surfaced per container rather than aborting the batch, because a partial
   * batch has already mutated the daemon.
   */
  const runBulkContainerAction = useCallback(
    async (action: "start" | "stop" | "delete", options: ContainerRemoveOptions = {}) => {
      const targets = containers.filter((container) =>
        selectedContainerIds.has(container.id),
      );
      if (targets.length === 0) return;
      const failures: string[] = [];
      for (const container of targets) {
        try {
          if (action === "delete") {
            const force = requiresForceRemove(container);
            if (!canOfferRemove(container)) continue;
            await deleteContainer(container, {
              ...options,
              ...(force ? { force: true } : {}),
            });
          } else if (action === "start") {
            if (container.state === "running") continue;
            await bridge.containers.start(container.id, dockerContextRef.current);
          } else {
            if (container.state !== "running") continue;
            await bridge.containers.stop(container.id, dockerContextRef.current);
          }
        } catch (reason) {
          failures.push(
            `${container.name}: ${reason instanceof Error ? reason.message : "failed"}`,
          );
        }
      }
      clearContainerSelection();
      await refreshContainers().catch(() => undefined);
      if (failures.length > 0) {
        setError(`${failures.length} of ${targets.length} failed — ${failures.join("; ")}`);
      }
    },
    [
      bridge,
      clearContainerSelection,
      containers,
      deleteContainer,
      refreshContainers,
      selectedContainerIds,
    ],
  );

  /** Distinct compose projects present in the current container list. */
  /**
   * Switch the Docker context. Every per-context cache is cleared first: leaving the previous
   * daemon's containers, images, volumes and networks on screen while the new one loads is
   * exactly the wrong-target hazard a context switcher is supposed to remove.
   */
  const selectDockerContext = useCallback(
    (name: string) => {
      if (!isHost || name === dockerContextRef.current) return;
      pinnedContextRef.current = name;
      dockerContextRef.current = name;
      setDockerContext(name);
      setContainers([]);
      setImages([]);
      setVolumes([]);
      setNetworks([]);
      setSystemSnapshot(null);
      setInspectByContainer({});
      setStatsByContainer({});
      setStatsHistoryByContainer({});
      setSelectedId(null);
      setSelectedContainerIds(new Set());
      setComposeFilter(null);
      setError(null);
      void retryEngine();
    },
    [isHost, retryEngine],
  );

  const composeProjects = useMemo(
    () =>
      [
        ...new Set(
          containers
            .map((container) => container.composeProject)
            .filter((project): project is string => Boolean(project)),
        ),
      ].sort(),
    [containers],
  );

  const selectedContainer = useMemo(
    () => containers.find((container) => container.id === selectedId) ?? null,
    [containers, selectedId],
  );

  /**
   * Sampled history for a container, preferring live samples. Fixture containers ship their
   * own preset history on the container object, so fall back to that when nothing has been
   * sampled yet — otherwise browser-mode design QA would render empty charts.
   */
  const statsHistoryFor = useCallback(
    (container: AnchorageContainer): { cpu: number[]; memory: number[] } => {
      const sampled = statsHistoryByContainer[container.id];
      if (sampled && (sampled.cpu.length > 0 || sampled.memory.length > 0)) {
        return sampled;
      }
      return { cpu: container.cpuHistory, memory: container.memoryHistory };
    },
    [statsHistoryByContainer],
  );

  useEffect(() => {
    if (
      !isHost ||
      !selectedContainer ||
      detailTab !== "stats"
    ) {
      return;
    }
    const containerId = selectedContainer.id;
    let disposed = false;
    let timer: number | undefined;
    const scheduleNext = () => {
      if (disposed || timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void readStats();
      }, 2_000);
    };
    async function readStats() {
      if (
        disposed ||
        document.visibilityState === "hidden"
      ) {
        return;
      }
      if (statsInFlightRef.current) {
        scheduleNext();
        return;
      }
      statsInFlightRef.current = true;
      const sequence = ++statsSequenceRef.current;
      try {
        const next = await bridge.containers.stats(
          containerId,
          dockerContextRef.current,
        );
        if (
          disposed ||
          sequence < statsAppliedSequenceRef.current
        ) {
          return;
        }
        statsAppliedSequenceRef.current = sequence;
        setStatsByContainer((current) => ({
          ...current,
          [containerId]: next,
        }));
        setStatsHistoryByContainer((current) => {
          const previous = current[containerId] ?? { cpu: [], memory: [] };
          return {
            ...current,
            [containerId]: {
              cpu: [...previous.cpu, next.cpuPercent].slice(-48),
              memory: [...previous.memory, next.memoryPercent].slice(-48),
            },
          };
        });
        setContainers((current) =>
          current.map((container) =>
            container.id === containerId
              ? {
                  ...container,
                  cpu: next.cpuPercent,
                  memory: next.memoryWorkingSetBytes / 1024 / 1024,
                  memoryLimit: next.memoryLimitBytes / 1024 / 1024,
                }
              : container,
          ),
        );
        setDetailErrors((current) => ({
          ...current,
          [containerId]: {
            ...current[containerId],
            stats: undefined,
          },
        }));
      } catch (reason) {
        if (
          disposed ||
          sequence < statsAppliedSequenceRef.current
        ) {
          return;
        }
        statsAppliedSequenceRef.current = sequence;
        setDetailErrors((current) => ({
          ...current,
          [containerId]: {
            ...current[containerId],
            stats:
              reason instanceof Error
                ? reason.message
                : "Live container statistics are unavailable",
            },
        }));
      } finally {
        statsInFlightRef.current = false;
        scheduleNext();
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void readStats();
    };
    void readStats();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [bridge, detailTab, isHost, selectedContainer?.id]);

  useEffect(() => {
    if (
      !isHost ||
      !selectedContainer ||
      selectedContainer.state !== "running" ||
      detailTab !== "logs" ||
      !followLogs
    ) {
      return;
    }
    let disposed = false;
    let owner: string | null = null;
    let partialLine = "";
    let pending: SessionEvent[] = [];
    const appendText = (text: string) => {
      const lines = `${partialLine}${text}`.split(/\r?\n/u);
      partialLine = lines.pop() ?? "";
      if (lines.length === 0) return;
      const additions = lines.map((line): LogLine => {
        // Date.now() + chunk-local index collided whenever two chunks landed in the same
        // millisecond, producing duplicate React keys and dropped lines.
        followLineSequenceRef.current += 1;
        return {
        id: `${selectedContainer.id}-follow-${followLineSequenceRef.current}`,
        timestamp: formatClock(),
        level: /\berror\b/iu.test(line)
          ? "ERROR"
          : /\bwarn(?:ing)?\b/iu.test(line)
            ? "WARN"
            : "LOG",
        message: line,
        };
      });
      setLogsByContainer((current) => ({
        ...current,
        [selectedContainer.id]: [
          ...(current[selectedContainer.id] ?? []),
          ...additions,
        ].slice(-500),
      }));
    };
    const accept = (event: SessionEvent) => {
      if (event.event === "session.output") {
        appendText(decodeSessionData(event));
        void bridge.sessions
          .ack({
            sessionId: event.payload.sessionId,
            throughSequence: event.payload.sequence,
          })
          .catch((reason) => {
            setDetailErrors((current) => ({
              ...current,
              [selectedContainer.id]: {
                ...current[selectedContainer.id],
                logs:
                  reason instanceof Error
                    ? reason.message
                    : "Log output ACK failed",
              },
            }));
          });
      } else if (event.event === "session.error") {
        setDetailErrors((current) => ({
          ...current,
          [selectedContainer.id]: {
            ...current[selectedContainer.id],
            logs: `${event.payload.code}: ${event.payload.message}`,
          },
        }));
      }
    };
    const unsubscribe = bridge.sessions.subscribe((event) => {
      if (!owner) {
        pending = [...pending.slice(-99), event];
        return;
      }
      if (event.payload.sessionId === owner) accept(event);
    });
    void bridge.sessions
      .start({
        context: dockerContextRef.current,
        argv: [
          "logs",
          "--timestamps",
          "--tail",
          "0",
          "--follow",
          selectedContainer.id,
        ],
        mode: "pipes",
        outputWindowBytes: 64 * 1024,
        maxOutputBytes: 16 * 1024 * 1024,
      })
      .then((result) => {
        if (disposed) {
          void Promise.resolve(
            bridge.sessions.cancel({
              sessionId: result.sessionId,
              gracePeriodMs: 500,
            }),
          )
            .catch(() => undefined);
          return;
        }
        owner = result.sessionId;
        setDetailErrors((current) => ({
          ...current,
          [selectedContainer.id]: {
            ...current[selectedContainer.id],
            logs: undefined,
          },
        }));
        const buffered = pending;
        pending = [];
        buffered
          .filter((event) => event.payload.sessionId === owner)
          .forEach(accept);
      })
      .catch((reason) => {
        if (disposed) return;
        pending = [];
        setDetailErrors((current) => ({
          ...current,
          [selectedContainer.id]: {
            ...current[selectedContainer.id],
            logs:
              reason instanceof Error
                ? reason.message
                : "Live log following is unavailable",
          },
        }));
      });
    return () => {
      disposed = true;
      pending = [];
      unsubscribe();
      if (owner) {
        void Promise.resolve(
          bridge.sessions.cancel({
            sessionId: owner,
            gracePeriodMs: 500,
          }),
        )
          .catch(() => undefined);
      }
    };
  }, [
    bridge,
    detailTab,
    // engineStatus is a dependency so a core crash/restart re-establishes the stream.
    // Without it the pane froze silently while the rest of the UI reported healthy.
    engineStatus,
    followLogs,
    isHost,
    selectedContainer?.id,
    selectedContainer?.state,
  ]);

  /**
   * Subscribe to `docker events` and reconcile on demand.
   *
   * Freshness previously depended entirely on re-listing every container every 2s and every
   * image/volume every 10s, regardless of whether anything had changed. The event stream lets
   * the polls act as a slow safety net instead of the primary mechanism, and makes changes
   * made outside Anchorage show up immediately rather than up to 10s later.
   */
  useEffect(() => {
    if (!isHost || engineStatus !== "ready") return;
    let disposed = false;
    let owner: string | null = null;
    let partial = "";
    // Coalesce bursts: `compose up` emits dozens of events in a few milliseconds.
    let pendingDomains = new Set<string>();
    let flushTimer: number | undefined;

    const flush = () => {
      flushTimer = undefined;
      const domains = pendingDomains;
      pendingDomains = new Set();
      if (domains.has("container")) void refreshContainers().catch(() => undefined);
      if (domains.has("image")) void refreshImages().catch(() => undefined);
      if (domains.has("volume")) void refreshVolumes().catch(() => undefined);
      if (domains.has("network")) void refreshNetworks().catch(() => undefined);
    };

    const note = (domain: string) => {
      pendingDomains.add(domain);
      if (flushTimer !== undefined) return;
      flushTimer = window.setTimeout(flush, 250);
    };

    const consume = (text: string) => {
      const lines = `${partial}${text}`.split(/\r?\n/u);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as { Type?: string };
          if (typeof event.Type === "string") note(event.Type);
        } catch {
          // A malformed line is not worth tearing the stream down for.
        }
      }
    };

    const unsubscribe = bridge.sessions.subscribe((event) => {
      if (!owner || event.payload.sessionId !== owner) return;
      if (event.event === "session.output") {
        consume(decodeSessionData(event));
        void Promise.resolve(
          bridge.sessions.ack({
            sessionId: event.payload.sessionId,
            throughSequence: event.payload.sequence,
          }),
        ).catch(() => undefined);
      }
    });

    void bridge.sessions
      .start({
        context: dockerContextRef.current,
        argv: ["events", "--format", "{{json .}}"],
        mode: "pipes",
        outputWindowBytes: 64 * 1024,
      })
      .then((result) => {
        if (disposed) {
          void Promise.resolve(
            bridge.sessions.cancel({ sessionId: result.sessionId, gracePeriodMs: 500 }),
          ).catch(() => undefined);
          return;
        }
        owner = result.sessionId;
      })
      .catch(() => {
        // Events are an optimization. If the stream cannot start, polling still covers it.
      });

    return () => {
      disposed = true;
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      unsubscribe();
      if (owner) {
        void Promise.resolve(
          bridge.sessions.cancel({ sessionId: owner, gracePeriodMs: 500 }),
        ).catch(() => undefined);
      }
    };
  }, [
    bridge,
    engineStatus,
    isHost,
    refreshContainers,
    refreshImages,
    refreshNetworks,
    refreshVolumes,
  ]);

  /**
   * Populate the list's CPU and MEMORY columns.
   *
   * Those columns rendered a permanent em-dash in host mode because stats were only ever
   * fetched for the single selected container. This samples the running containers actually
   * on screen, bounded so a large daemon cannot turn a poll into hundreds of requests, and
   * skipped entirely while the tab is hidden.
   */
  useEffect(() => {
    if (!isHost || engineStatus !== "ready" || view !== "containers") return;
    let disposed = false;
    let inFlight = false;

    const sample = async () => {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      const ids = containersRef.current
        .filter((container) => container.state === "running")
        .slice(0, LIST_STATS_BATCH_LIMIT)
        .map((container) => container.id);
      if (ids.length === 0) return;
      inFlight = true;
      try {
        const samples = await bridge.containers.statsBatch(
          ids,
          dockerContextRef.current,
        );
        if (disposed || samples.length === 0) return;
        const byId = new Map(samples.map((entry) => [entry.id, entry.stats]));
        setContainers((current) =>
          current.map((container) => {
            const stats = byId.get(container.id);
            if (!stats) return container;
            return {
              ...container,
              cpu: stats.cpuPercent,
              memory: stats.memoryWorkingSetBytes / 1024 / 1024,
              memoryLimit: stats.memoryLimitBytes / 1024 / 1024,
            };
          }),
        );
      } catch {
        // Metrics are supplementary; a failed sample must not disturb the list itself.
      } finally {
        inFlight = false;
      }
    };

    void sample();
    const timer = window.setInterval(() => void sample(), LIST_STATS_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void sample();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [bridge, engineStatus, isHost, view]);

  const [filePath, setFilePath] = useState("/");
  // Upload targets whichever directory is on screen when the picker resolves.
  const filePathRef = useRef("/");
  filePathRef.current = filePath;
  const [fileListing, setFileListing] = useState<ContainerFilesResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<ContainerFileReadResult | null>(null);
  const [processes, setProcesses] = useState<ContainerTopResult | null>(null);
  const [changes, setChanges] = useState<ContainerDiffResult | null>(null);

  /** Browse a directory inside the selected container. */
  const browseFiles = useCallback(
    async (target: string) => {
      const id = selectedIdRef.current;
      if (!isHost || !id) return;
      setFilePath(target);
      setFileError(null);
      setFilePreview(null);
      try {
        const listing = await bridge.containers.files(
          id,
          target,
          dockerContextRef.current,
        );
        if (selectedIdRef.current !== id) return;
        setFileListing(listing);
      } catch (reason) {
        setFileListing(null);
        setFileError(
          reason instanceof Error ? reason.message : "Directory listing failed",
        );
      }
    },
    [bridge, isHost],
  );

  const previewFile = useCallback(
    async (target: string) => {
      const id = selectedIdRef.current;
      if (!isHost || !id) return;
      setFileError(null);
      try {
        const file = await bridge.containers.fileRead(
          id,
          target,
          dockerContextRef.current,
        );
        if (selectedIdRef.current !== id) return;
        setFilePreview(file);
      } catch (reason) {
        setFileError(reason instanceof Error ? reason.message : "File read failed");
      }
    },
    [bridge, isHost],
  );

  const closeFilePreview = useCallback(() => setFilePreview(null), []);

  /** Download a container file to the user's machine. */
  const downloadFile = useCallback(
    async (target: string) => {
      const id = selectedIdRef.current;
      if (!isHost || !id) return;
      try {
        const file = await bridge.containers.fileRead(
          id,
          target,
          dockerContextRef.current,
        );
        const bytes =
          file.encoding === "base64"
            ? Uint8Array.from(window.atob(file.content), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(file.content);
        const url = URL.createObjectURL(new Blob([bytes]));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = target.split("/").pop() || "download";
        anchor.click();
        URL.revokeObjectURL(url);
      } catch (reason) {
        setFileError(
          reason instanceof Error ? reason.message : "File download failed",
        );
      }
    },
    [bridge, isHost],
  );

  /** Upload a file into the directory currently being browsed. */
  const uploadFile = useCallback(
    async (file: File) => {
      const id = selectedIdRef.current;
      if (!isHost || !id) return;
      setFileError(null);
      try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of buffer) binary += String.fromCharCode(byte);
        await bridge.containers.fileWrite(
          id,
          filePathRef.current,
          file.name,
          window.btoa(binary),
          dockerContextRef.current,
        );
        await browseFiles(filePathRef.current);
      } catch (reason) {
        setFileError(
          reason instanceof Error ? reason.message : "File upload failed",
        );
      }
    },
    [bridge, browseFiles, isHost],
  );

  // Load the detail tab's data when it opens. Files, processes and filesystem changes are
  // all read-only, so they refresh on selection rather than on a poll.
  useEffect(() => {
    if (!isHost || !selectedContainer) return;
    if (detailTab === "files") {
      setFilePath("/");
      void browseFiles("/");
      return;
    }
    if (detailTab === "processes") {
      setProcesses(null);
      void bridge.containers
        .top(selectedContainer.id, dockerContextRef.current)
        .then((result) => {
          if (selectedIdRef.current === selectedContainer.id) setProcesses(result);
        })
        .catch(() => undefined);
      return;
    }
    if (detailTab === "changes") {
      setChanges(null);
      void bridge.containers
        .diff(selectedContainer.id, dockerContextRef.current)
        .then((result) => {
          if (selectedIdRef.current === selectedContainer.id) setChanges(result);
        })
        .catch(() => undefined);
    }
  }, [bridge, browseFiles, detailTab, isHost, selectedContainer?.id, selectedContainer]);

  const filteredContainers = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return containers.filter((container) => {
      if (onlyRunning && container.state !== "running") return false;
      if (composeFilter && container.composeProject !== composeFilter) return false;
      if (!query) return true;
      return [
        container.name,
        container.id,
        container.image,
        container.ports,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query);
    });
  }, [composeFilter, containers, onlyRunning, search]);

  const runningCount = useMemo(
    () => containers.filter((container) => container.state === "running").length,
    [containers],
  );
  const stoppedCount = useMemo(
    () =>
      containers.filter((container) =>
        ["created", "exited", "dead", "stopped"].includes(container.state),
      ).length,
    [containers],
  );
  const engineCpu = useMemo(
    () =>
      containers.reduce(
        (total, container) =>
          total + (container.state === "running" ? (container.cpu ?? 0) : 0),
        0,
      ) / 8,
    [containers],
  );
  const engineMemory = useMemo(
    () =>
      containers.reduce(
        (total, container) =>
          total + (container.state === "running" ? (container.memory ?? 0) : 0),
        0,
      ) / 1024,
    [containers],
  );

  const visibleLogs = useMemo(() => {
    if (!selectedContainer) return [];
    const query = logFilter.trim().toLocaleLowerCase();
    return (logsByContainer[selectedContainer.id] ?? [])
      .filter(
        (line) =>
          !query ||
          `${line.level} ${line.message}`
            .toLocaleLowerCase()
            .includes(query),
      )
      .slice(-200);
  }, [logFilter, logsByContainer, selectedContainer]);

  const clearLogs = useCallback(() => {
    if (!selectedId) return;
    // Drop the entry rather than storing []. The fetch guard treats any present value as
    // "already loaded", so an empty array made Clear permanent: navigating away and back
    // still showed nothing, for the lifetime of the app.
    setLogsByContainer((current) => {
      if (!(selectedId in current)) return current;
      const next = { ...current };
      delete next[selectedId];
      return next;
    });
  }, [selectedId]);

  const registryResults = useMemo(() => {
    if (isHost) return [];
    const query = registryQuery.trim().toLocaleLowerCase();
    if (!query) return REGISTRY_FIXTURES;
    return REGISTRY_FIXTURES.filter((image) =>
      [image.name, image.description]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [isHost, registryQuery]);

  const imageSummary = useMemo(() => {
    const uniqueImages = [
      ...new Map(images.map((image) => [image.imageId, image])).values(),
    ];
    const totalMb = uniqueImages.reduce(
      (total, image) => total + image.sizeMb,
      0,
    );
    const reclaimableMb = uniqueImages.reduce(
      (total, image) => total + (image.reclaimable ? image.sizeMb : 0),
      0,
    );
    const total =
      totalMb >= 1000
        ? `${(totalMb / 1000).toFixed(2)} GB`
        : `${totalMb} MB`;
    const reclaimable =
      reclaimableMb >= 1000
        ? `${(reclaimableMb / 1000).toFixed(2)} GB`
        : `${reclaimableMb} MB`;
    if (isHost) {
      const unused = uniqueImages.filter((image) => image.reclaimable).length;
      const unknown = uniqueImages.filter((image) => !image.usageKnown).length;
      return `${uniqueImages.length} images · ${total} listed size · ${unused} unused${
        unknown > 0 ? ` · ${unknown} usage unknown` : ""
      }`;
    }
    return `${uniqueImages.length} images · ${total} total · ${reclaimable} reclaimable`;
  }, [images, isHost]);

  /**
   * `scope: "dangling"` is `docker image prune` — untagged layers only.
   * `scope: "all"` is `docker image prune --all` — every image no container is using.
   *
   * The button used to be hardcoded to dangling while its own header advertised the far
   * larger unused total, and it was a silent no-op whenever nothing was dangling.
   */
  const cleanUpImages = useCallback(
    async (scope: "dangling" | "all" = "dangling") => {
    if (!isHost) {
      setImages((current) => current.filter((image) => !image.reclaimable));
      return;
    }
    const hasTarget =
      scope === "all"
        ? images.some((image) => image.usageKnown && image.reclaimable)
        : images.some(
            (image) =>
              image.reference === null && image.usageKnown && image.reclaimable,
          );
    if (!hasTarget) return;
    setImageMutationPending(true);
    try {
      try {
        await bridge.images.action({
          context: dockerContextRef.current,
          action: "prune",
          confirmed: true,
          // `dangling=true` is `docker image prune` (untagged layers only).
          // `dangling=false` is `docker image prune --all` (every image no container uses).
          filters: { dangling: [scope === "all" ? "false" : "true"] },
        });
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : "Image cleanup failed",
        );
        return;
      }
      try {
        await refreshImages();
      } catch (reason) {
        setError(reconciliationFailureMessage("Image cleanup", reason));
        return;
      }
      void refreshSnapshot().catch(() => undefined);
      setError(null);
    } finally {
      setImageMutationPending(false);
    }
    },
    [bridge, images, isHost, refreshImages, refreshSnapshot],
  );


  const runNetworkMutation = useCallback(
    async (label: string, params: NetworksActionParams) => {
      if (!isHost) return false;
      setNetworkMutationPending(true);
      try {
        try {
          await bridge.networks.action(params);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : `${label} failed`);
          return false;
        }
        try {
          await refreshNetworks();
        } catch (reason) {
          setError(reconciliationFailureMessage(label, reason));
          return true;
        }
        setError(null);
        return true;
      } finally {
        setNetworkMutationPending(false);
      }
    },
    [bridge, isHost, refreshNetworks],
  );

  const createNetwork = useCallback(
    (options: {
      name: string;
      driver?: string;
      subnet?: string;
      gateway?: string;
      internal?: boolean;
      attachable?: boolean;
    }) =>
      runNetworkMutation("Network creation", {
        context: dockerContextRef.current,
        action: "create",
        name: options.name,
        ...(options.driver ? { driver: options.driver } : {}),
        ...(options.subnet ? { subnet: options.subnet } : {}),
        ...(options.gateway ? { gateway: options.gateway } : {}),
        ...(options.internal ? { internal: true } : {}),
        ...(options.attachable ? { attachable: true } : {}),
      }),
    [runNetworkMutation],
  );

  const removeNetwork = useCallback(
    (network: NetworkSummary) => {
      // Docker rejects removing its predefined networks, so never offer it.
      if (network.predefined) return Promise.resolve(false);
      return runNetworkMutation("Network removal", {
        context: dockerContextRef.current,
        action: "remove",
        id: network.id,
        confirmed: true,
      });
    },
    [runNetworkMutation],
  );

  const pruneNetworks = useCallback(
    () =>
      runNetworkMutation("Network cleanup", {
        context: dockerContextRef.current,
        action: "prune",
        confirmed: true,
      }),
    [runNetworkMutation],
  );

  const [systemPruneResult, setSystemPruneResult] =
    useState<SystemActionResult | null>(null);
  const [systemPrunePending, setSystemPrunePending] = useState(false);

  /**
   * `docker system prune`. The most-used Docker maintenance command, previously reachable
   * only by hand-typing argv into the Command Center.
   */
  const pruneSystem = useCallback(
    async (options: SystemPruneOptions = {}) => {
      if (!isHost) return;
      setSystemPrunePending(true);
      try {
        let result: SystemActionResult;
        try {
          result = await bridge.system.prune(dockerContextRef.current, options);
        } catch (reason) {
          setError(
            reason instanceof Error ? reason.message : "System prune failed",
          );
          return;
        }
        setSystemPruneResult(result);
        // A prune touches every domain, so reconcile all of them rather than guessing.
        const outcomes = await Promise.allSettled([
          refreshContainers(),
          refreshImages(),
          refreshVolumes(),
          refreshSnapshot(dockerContextRef.current, true),
        ]);
        const failed = outcomes.find((outcome) => outcome.status === "rejected");
        if (failed && failed.status === "rejected") {
          setError(reconciliationFailureMessage("System prune", failed.reason));
          return;
        }
        setError(null);
      } finally {
        setSystemPrunePending(false);
      }
    },
    [
      bridge,
      isHost,
      refreshContainers,
      refreshImages,
      refreshSnapshot,
      refreshVolumes,
    ],
  );

  const [selectedImage, setSelectedImage] = useState<AnchorageImage | null>(null);
  const [imageDetail, setImageDetail] = useState<ImagesInspectResult | null>(null);
  const [imageDetailError, setImageDetailError] = useState<string | null>(null);

  /** Open the image detail panel and load its configuration and layer history. */
  const openImageDetail = useCallback(
    async (image: AnchorageImage) => {
      setSelectedImage(image);
      setImageDetail(null);
      setImageDetailError(null);
      if (!isHost) return;
      try {
        const detail = await bridge.images.inspect(
          image.imageId,
          dockerContextRef.current,
        );
        // The user may have closed or switched images while this was in flight.
        setSelectedImage((current) =>
          current && current.imageId === image.imageId ? current : current,
        );
        setImageDetail(detail);
      } catch (reason) {
        setImageDetailError(
          reason instanceof Error ? reason.message : "Image inspect failed",
        );
      }
    },
    [bridge, isHost],
  );

  const closeImageDetail = useCallback(() => {
    setSelectedImage(null);
    setImageDetail(null);
    setImageDetailError(null);
  }, []);

  const [registrySearching, setRegistrySearching] = useState(false);
  const [registryHits, setRegistryHits] = useState<
    Array<{ name: string; description: string; stars: number; official: boolean }>
  >([]);

  /** Real Docker Hub search. The Registry tab was fixture-only until now. */
  const searchRegistry = useCallback(
    async (term: string) => {
      if (!isHost) return;
      const trimmed = term.trim();
      if (!trimmed) {
        setRegistryHits([]);
        return;
      }
      setRegistrySearching(true);
      try {
        const result = await bridge.images.search(trimmed, dockerContextRef.current);
        setRegistryHits(result.results);
        setError(null);
      } catch (reason) {
        setRegistryHits([]);
        setError(
          reason instanceof Error ? reason.message : "Registry search failed",
        );
      } finally {
        setRegistrySearching(false);
      }
    },
    [bridge, isHost],
  );

  const setImageFilters = useCallback(
    (next: Partial<{ all: boolean; includeDangling: boolean }>) => {
      setImageFiltersState((current) => {
        const merged = { ...current, ...next };
        imageFiltersRef.current = merged;
        return merged;
      });
      void refreshImages().catch(() => undefined);
    },
    [refreshImages],
  );

  /** Images narrowed by the in-screen query. Matches repository, tag and short id. */
  const filteredImages = useMemo(() => {
    // The in-screen filter and the global search box both narrow this list.
    const needles = [imageQuery, search]
      .map((value) => value.trim().toLocaleLowerCase())
      .filter(Boolean);
    if (needles.length === 0) return images;
    return images.filter((image) => {
      const haystack = [image.repository, image.tag, image.imageId]
        .join(" ")
        .toLocaleLowerCase();
      return needles.every((needle) => haystack.includes(needle));
    });
  }, [images, imageQuery, search]);

  const filteredVolumes = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return volumes;
    return volumes.filter((volume) =>
      [volume.name, volume.driver, volume.usedBy ?? ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [volumes, search]);

  /**
   * `docker tag`: give an image an additional reference.
   *
   * Addressed by immutable ID rather than by the image's current tag. A tag can be moved to
   * a different image between this row being rendered and the operator acting on it, so
   * using one as the source would risk labelling whatever it points at now.
   */
  const tagImage = useCallback(
    async (image: AnchorageImage, reference: string) => {
      if (!isHost) return;
      setImageMutationPending(true);
      try {
        await bridge.images.action({
          context: dockerContextRef.current,
          action: "tag",
          id: image.imageId,
          reference,
        });
        await Promise.allSettled([refreshImages(), refreshSnapshot()]);
        setError(null);
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : "Image tag failed",
        );
      } finally {
        setImageMutationPending(false);
      }
    },
    [bridge, isHost, refreshImages, refreshSnapshot],
  );

  const removeImage = useCallback(
    async (image: AnchorageImage, options: { force?: boolean } = {}) => {
      if (!image.usageKnown) return;
      // An in-use image can only be removed with --force, which the caller must have obtained
      // explicit consent for. A dangling image has no reference and is removed by ID.
      if (image.inUse && !options.force) return;
      if (!isHost) {
        setImages((current) =>
          current.filter((candidate) => candidate.identity !== image.identity),
        );
        return;
      }
      setImageMutationPending(true);
      try {
        try {
          await bridge.images.action({
            context: dockerContextRef.current,
            action: "remove",
            id: image.imageId,
            ...(image.reference ? { reference: image.reference } : {}),
            confirmed: true,
            ...(options.force ? { force: true } : {}),
          });
        } catch (reason) {
          setError(
            reason instanceof Error ? reason.message : "Image removal failed",
          );
          return;
        }
        setImages((current) =>
          current.filter((candidate) => candidate.identity !== image.identity),
        );
        try {
          await refreshImages();
        } catch (reason) {
          setError(reconciliationFailureMessage("Image removal", reason));
          return;
        }
        void refreshSnapshot().catch(() => undefined);
        setError(null);
      } finally {
        setImageMutationPending(false);
      }
    },
    [bridge, isHost, refreshImages, refreshSnapshot],
  );

  /**
   * Follows a session-backed transfer to completion.
   *
   * Pull, image save/load and container export all stream their progress over the session.*
   * channel rather than returning a payload: an image archive is routinely gigabytes, so the
   * bytes go to a host file (or the daemon) while only progress crosses the RPC. They shared
   * nothing but a copy of this logic before, which meant only pull ever got the parts that
   * are easy to get wrong — buffering events that arrive before the session id is known,
   * acknowledging output so the core's window does not stall, and cancelling the session if
   * the caller starts another transfer first.
   */
  const runTransferSession = useCallback(
    async (options: {
      title: string;
      reference: string;
      failureMessage: string;
      start: () => Promise<{ session?: SessionStartResult }>;
      onSettled?: () => void;
    }) => {
      transferCleanupRef.current?.();
      let disposed = false;
      let owner: string | null = null;
      let pending: SessionEvent[] = [];
      const finish = () => {
        void Promise.allSettled([refreshImages(), refreshSnapshot()]);
        options.onSettled?.();
      };
      const accept = (event: SessionEvent) => {
        if (event.event === "session.output") {
          const text = decodeSessionData(event);
          setImageTransfer((current) =>
            current
              ? {
                  ...current,
                  status: "running",
                  output: `${current.output}${text}`.slice(-64 * 1024),
                }
              : current,
          );
          void bridge.sessions
            .ack({
              sessionId: event.payload.sessionId,
              throughSequence: event.payload.sequence,
            })
            .catch((reason) => {
              setImageTransfer((current) =>
                current
                  ? {
                      ...current,
                      status: "error",
                      error:
                        reason instanceof Error
                          ? reason.message
                          : "Transfer output ACK failed",
                    }
                  : current,
              );
            });
        } else if (event.event === "session.error") {
          setImageTransfer((current) =>
            current
              ? {
                  ...current,
                  status: "error",
                  error: `${event.payload.code}: ${event.payload.message}`,
                }
              : current,
          );
        } else if (event.event === "session.exited") {
          setImageTransfer((current) =>
            current
              ? {
                  ...current,
                  status:
                    event.payload.exitCode === 0 && !event.payload.timedOut
                      ? "exited"
                      : "error",
                  error:
                    event.payload.exitCode === 0
                      ? current.error
                      : `${options.title} exited with code ${event.payload.exitCode}`,
                }
              : current,
          );
          finish();
        }
      };
      const unsubscribe = bridge.sessions.subscribe((event) => {
        if (!owner) {
          pending = [...pending.slice(-99), event];
          return;
        }
        if (event.payload.sessionId === owner) accept(event);
      });
      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        pending = [];
        unsubscribe();
        if (owner) {
          void Promise.resolve(
            bridge.sessions.cancel({
              sessionId: owner,
              gracePeriodMs: 750,
            }),
          )
            .catch(() => undefined);
        }
      };
      transferCleanupRef.current = cleanup;
      setImageTransfer({
        title: options.title,
        reference: options.reference,
        status: "starting",
        output: "",
      });
      try {
        const result = await options.start();
        if (disposed) {
          if (result.session) {
            void Promise.resolve(
              bridge.sessions.cancel({
                sessionId: result.session.sessionId,
                gracePeriodMs: 750,
              }),
            )
              .catch(() => undefined);
          }
          return;
        }
        if (!result.session) {
          setImageTransfer((current) =>
            current ? { ...current, status: "exited" } : current,
          );
          finish();
          return;
        }
        owner = result.session.sessionId;
        setImageTransfer((current) =>
          current ? { ...current, status: "running" } : current,
        );
        const buffered = pending;
        pending = [];
        buffered
          .filter((event) => event.payload.sessionId === owner)
          .forEach(accept);
      } catch (reason) {
        cleanup();
        setImageTransfer((current) =>
          current
            ? {
                ...current,
                status: "error",
                error:
                  reason instanceof Error ? reason.message : options.failureMessage,
              }
            : current,
        );
      }
    },
    [bridge, refreshImages, refreshSnapshot],
  );

  /**
   * Loads the Compose plugin's own project list.
   *
   * Distinct from deriving projects off container labels: the plugin also reports projects
   * whose containers have all exited, and it supplies the configuration file paths that `up`
   * cannot run without. A missing plugin is a reportable state rather than an error, because
   * Compose is optional and the operator's fix is to install it.
   */
  const refreshCompose = useCallback(async () => {
    if (!isHost) return;
    setComposeStatus((current) => (current === "ready" ? "ready" : "loading"));
    try {
      const result = await bridge.compose.list(dockerContextRef.current, true);
      setComposeProjectList(result.projects);
      setComposeStatus("ready");
      setComposeError(null);
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Compose projects unavailable";
      setComposeProjectList([]);
      setComposeStatus(
        /compose_unavailable|not installed/iu.test(message) ? "unavailable" : "error",
      );
      setComposeError(message);
    }
  }, [bridge, isHost]);

  /** Expands one project and loads its services; collapsing does not refetch. */
  const toggleComposeProject = useCallback(
    async (project: string) => {
      // Read the current value rather than deriving it inside a state updater: React runs
      // updaters during render, not at the call site, so the branch below would have seen a
      // stale value and never fetched the services.
      const opening = expandedComposeProject !== project;
      setExpandedComposeProject(opening ? project : null);
      if (!opening || !isHost) return;
      try {
        const result = await bridge.compose.ps(project, dockerContextRef.current);
        setComposeServices((current) => ({
          ...current,
          [project]: result.services,
        }));
      } catch (reason) {
        setComposeError(
          reason instanceof Error ? reason.message : "Compose services unavailable",
        );
      }
    },
    [bridge, expandedComposeProject, isHost],
  );

  /**
   * Runs a Compose lifecycle verb.
   *
   * These stream for the same reason pull does — `up` pulls images and waits on health checks
   * — so they reuse the transfer runner rather than a second copy of session following. The
   * container list is refreshed on completion because a compose verb changes many containers
   * at once and the label-derived groupings would otherwise lag.
   */
  const runComposeAction = useCallback(
    async (params: ComposeActionInput) => {
      if (!isHost) return;
      const label =
        params.action.charAt(0).toUpperCase() + params.action.slice(1);
      await runTransferSession({
        title: `Compose ${label}`,
        reference: params.project,
        failureMessage: `Compose ${params.action} failed`,
        start: () =>
          bridge.compose.action({
            context: dockerContextRef.current,
            ...params,
          } as ComposeActionParams),
        onSettled: () => {
          void refreshCompose();
          void refreshContainers();
        },
      });
    },
    [bridge, isHost, refreshCompose, refreshContainers, runTransferSession],
  );

  /**
   * Opens a volume's contents.
   *
   * Each call creates and removes a helper container with the volume mounted read-only, so
   * this is deliberately driven by navigation rather than polled — a poll would churn
   * containers for a surface that changes only when the operator moves.
   */
  const browseVolume = useCallback(
    async (name: string, targetPath = "/") => {
      if (!isHost) return;
      setBrowsedVolume(name);
      setVolumePath(targetPath);
      setVolumePreview(null);
      setVolumeListing(null);
      setVolumeBrowseError(null);
      try {
        const result = await bridge.volumes.files(
          name,
          targetPath,
          dockerContextRef.current,
        );
        setVolumeListing(result);
      } catch (reason) {
        setVolumeBrowseError(
          reason instanceof Error ? reason.message : "Volume browse failed",
        );
      }
    },
    [bridge, isHost],
  );

  const previewVolumeFile = useCallback(
    async (targetPath: string) => {
      if (!isHost || !browsedVolume) return;
      setVolumeBrowseError(null);
      try {
        const result = await bridge.volumes.fileRead(
          browsedVolume,
          targetPath,
          dockerContextRef.current,
        );
        setVolumePreview(result);
      } catch (reason) {
        setVolumeBrowseError(
          reason instanceof Error ? reason.message : "Volume file read failed",
        );
      }
    },
    [bridge, browsedVolume, isHost],
  );

  const closeVolumeBrowser = useCallback(() => {
    setBrowsedVolume(null);
    setVolumeListing(null);
    setVolumePreview(null);
    setVolumeBrowseError(null);
    setVolumePath("/");
  }, []);

  const closeVolumePreview = useCallback(() => setVolumePreview(null), []);

  /**
   * Analyses an image for known vulnerabilities.
   *
   * Explicitly requested, never automatic: Scout indexes an image the first time it sees it,
   * which took over two minutes for a 1 GB image here — opening a detail panel must not do
   * that. Subsequent analyses of the same image return from Scout's cache in seconds.
   */
  const analyzeImage = useCallback(
    async (reference: string) => {
      if (!isHost || !reference) return;
      setScoutPending(reference);
      setScoutError(null);
      try {
        const result = await bridge.images.scout(
          reference,
          dockerContextRef.current,
        );
        setScoutByReference((current) => ({ ...current, [reference]: result }));
      } catch (reason) {
        setScoutError(
          reason instanceof Error ? reason.message : "Image analysis failed",
        );
      } finally {
        setScoutPending((current) => (current === reference ? null : current));
      }
    },
    [bridge, isHost],
  );

  const pullRegistryImage = useCallback(
    async (name: string) => {
      if (!isHost) {
        setPulledRegistryImages((current) => new Set(current).add(name));
        return;
      }
      await runTransferSession({
        title: "Pull",
        reference: name,
        failureMessage: "Image pull failed",
        start: () =>
          bridge.images.action({
            context: dockerContextRef.current,
            action: "pull",
            reference: name,
            outputWindowBytes: 64 * 1024,
            maxOutputBytes: 64 * 1024 * 1024,
          }),
      });
    },
    [bridge, isHost, runTransferSession],
  );

  /**
   * `docker image save`: writes an image to a host tar, layers and metadata intact.
   *
   * The path is not sent as a suggestion — the core resolves its parent directory against the
   * command working-directory allowlist and refuses anything outside it, so an out-of-scope
   * destination fails here rather than writing a file somewhere unexpected.
   */
  const saveImageArchive = useCallback(
    async (reference: string, archivePath: string) => {
      if (!isHost) return;
      await runTransferSession({
        title: "Save",
        reference: `${reference} → ${archivePath}`,
        failureMessage: "Image save failed",
        start: () =>
          bridge.images.action({
            context: dockerContextRef.current,
            action: "save",
            reference,
            archivePath,
            outputWindowBytes: 64 * 1024,
          }),
      });
    },
    [bridge, isHost, runTransferSession],
  );

  /** `docker image load`: reads images back out of a tar produced by save. */
  const loadImageArchive = useCallback(
    async (archivePath: string) => {
      if (!isHost) return;
      await runTransferSession({
        title: "Load",
        reference: archivePath,
        failureMessage: "Image load failed",
        start: () =>
          bridge.images.action({
            context: dockerContextRef.current,
            action: "load",
            archivePath,
            outputWindowBytes: 64 * 1024,
          }),
      });
    },
    [bridge, isHost, runTransferSession],
  );

  /**
   * `docker export`: a container's filesystem as a flat tar.
   *
   * Distinct from image save — export flattens away the layers and drops the image config,
   * so the result cannot be run directly. Docker Desktop offers both; conflating them would
   * silently produce an archive that does not do what the operator expected.
   */
  const exportContainerArchive = useCallback(
    async (container: AnchorageContainer, archivePath: string) => {
      if (!isHost) return;
      await runTransferSession({
        title: "Export",
        reference: `${container.name} → ${archivePath}`,
        failureMessage: "Container export failed",
        start: () =>
          bridge.containers.export(
            container.id,
            archivePath,
            dockerContextRef.current,
          ),
      });
    },
    [bridge, isHost, runTransferSession],
  );

  const createVolume = useCallback(
    async (
      name: string,
      options: { driver?: string; labels?: Record<string, string> } = {},
    ) => {
      const normalized = name.trim().replace(/\s+/g, "_");
      if (!normalized) return false;
      if (!isHost) {
        setVolumes((current) => {
          if (current.some((volume) => volume.name === normalized)) {
            return current;
          }
          return [
            ...current,
            {
              name: normalized,
              driver: "local",
              size: "0 B",
              usedBy: null,
              created: "Just now",
              usageKnown: true,
            },
          ];
        });
        return true;
      }
      setVolumeMutationPending(true);
      try {
        try {
          await bridge.volumes.action({
            context: dockerContextRef.current,
            action: "create",
            name: normalized,
            ...(options.driver && options.driver !== "local"
              ? { driver: options.driver }
              : {}),
            ...(options.labels && Object.keys(options.labels).length > 0
              ? { labels: options.labels }
              : {}),
          });
        } catch (reason) {
          setError(
            reason instanceof Error ? reason.message : "Volume creation failed",
          );
          return false;
        }
        try {
          await refreshVolumes();
        } catch (reason) {
          setVolumes((current) =>
            current.some((volume) => volume.name === normalized)
              ? current
              : [
                  ...current,
                  {
                    name: normalized,
                    driver: "unknown",
                    size: "Unavailable",
                    usedBy: null,
                    created: "Just now",
                    usageKnown: false,
                  },
                ],
          );
          setError(reconciliationFailureMessage("Volume creation", reason));
          return true;
        }
        void refreshSnapshot().catch(() => undefined);
        setError(null);
        return true;
      } finally {
        setVolumeMutationPending(false);
      }
    },
    [bridge, isHost, refreshSnapshot, refreshVolumes],
  );

  const removeVolume = useCallback(
    async (volume: AnchorageVolume) => {
      if (!volume.usageKnown || volume.refCount !== 0) return;
      if (!isHost) {
        setVolumes((current) =>
          current.filter((candidate) => candidate.name !== volume.name),
        );
        return;
      }
      if (!window.confirm(`Remove volume ${volume.name}? This cannot be undone.`)) {
        return;
      }
      setVolumeMutationPending(true);
      try {
        try {
          await bridge.volumes.action({
            context: dockerContextRef.current,
            action: "remove",
            name: volume.name,
            confirmed: true,
          });
        } catch (reason) {
          setError(
            reason instanceof Error ? reason.message : "Volume removal failed",
          );
          return;
        }
        setVolumes((current) =>
          current.filter((candidate) => candidate.name !== volume.name),
        );
        try {
          await refreshVolumes();
        } catch (reason) {
          setError(reconciliationFailureMessage("Volume removal", reason));
          return;
        }
        void refreshSnapshot().catch(() => undefined);
        setError(null);
      } finally {
        setVolumeMutationPending(false);
      }
    },
    [bridge, isHost, refreshSnapshot, refreshVolumes],
  );

  const pruneVolumes = useCallback(async (includeNamed = false) => {
    if (
      volumes.length === 0 ||
      volumes.some((volume) => !volume.usageKnown) ||
      !volumes.some((volume) => volume.refCount === 0)
    ) {
      return;
    }
    if (!isHost) {
      setVolumes((current) => current.filter((volume) => volume.usedBy));
      return;
    }
    setVolumeMutationPending(true);
    try {
      try {
        await bridge.volumes.action({
          context: dockerContextRef.current,
          action: "prune",
          confirmed: true,
          // Docker's default prune removes only anonymous volumes. `all` additionally removes
          // named volumes the user deliberately created, so it must be an explicit opt-in from
          // the dialog rather than a hardcoded default behind a button labelled "Clean up".
          ...(includeNamed ? { filters: { all: ["true"] } } : {}),
        });
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : "Volume cleanup failed",
        );
        return;
      }
      try {
        await refreshVolumes();
      } catch (reason) {
        setError(reconciliationFailureMessage("Volume cleanup", reason));
        return;
      }
      void refreshSnapshot().catch(() => undefined);
      setError(null);
    } finally {
      setVolumeMutationPending(false);
    }
  }, [bridge, isHost, refreshSnapshot, refreshVolumes, volumes]);

  const volumeSummary = useMemo(() => {
    if (!isHost) {
      const unused = volumes.filter((volume) => !volume.usedBy).length;
      return `${volumes.length} volumes · 18.5 GB · ${unused} unused`;
    }
    const totalBytes = volumes.reduce(
      (total, volume) => total + (volume.sizeBytes ?? 0),
      0,
    );
    const unused = volumes.filter(
      (volume) => volume.usageKnown && volume.refCount === 0,
    ).length;
    const unknown = volumes.filter((volume) => !volume.usageKnown).length;
    return `${volumes.length} volumes · ${formatBytes(totalBytes)} · ${unused} unused${
      unknown > 0 ? ` · ${unknown} usage unknown` : ""
    }`;
  }, [isHost, volumes]);

  const selectedBuild = useMemo(
    () =>
      (isHost ? [] : BUILD_FIXTURES).find(
        (build) => build.id === selectedBuildId,
      ) ?? (isHost ? undefined : BUILD_FIXTURES[0]),
    [isHost, selectedBuildId],
  );

  const createDevEnvironment = useCallback(
    (name: string, repository: string) => {
      if (isHost) return false;
      const cleanName = name.trim();
      const cleanRepository = repository.trim().replace(/^https?:\/\//u, "");
      if (!cleanName || !cleanRepository) return false;
      const baseId =
        cleanName
          .toLocaleLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-|-$/gu, "") || "environment";
      setDevEnvironments((current) => {
        let id = baseId;
        let suffix = 2;
        while (current.some((environment) => environment.id === id)) {
          id = `${baseId}-${suffix}`;
          suffix += 1;
        }
        return [
          ...current,
          {
            id,
            name: cleanName,
            repository: cleanRepository,
            state: "stopped",
            tags: ["devcontainer", "docker"],
          },
        ];
      });
      return true;
    },
    [isHost],
  );

  const toggleDevEnvironment = useCallback((id: string) => {
    if (isHost) return;
    setDevEnvironments((current) =>
      current.map((environment) =>
        environment.id === id
          ? {
              ...environment,
              state:
                environment.state === "running"
                  ? ("stopped" as const)
                  : ("running" as const),
            }
          : environment,
      ),
    );
  }, [isHost]);

  const deleteDevEnvironment = useCallback((id: string) => {
    if (isHost) return;
    setDevEnvironments((current) =>
      current.filter((environment) => environment.id !== id),
    );
    setOpenedEnvironmentId((current) => (current === id ? null : current));
  }, [isHost]);

  const toggleExtension = useCallback((name: string) => {
    if (isHost) return;
    setInstalledExtensions((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, [isHost]);

  const extensionSummary = isHost
    ? "Unavailable in this build"
    : `${installedExtensions.size} installed · ${EXTENSION_FIXTURES.length} available in the marketplace`;

  const updateResource = useCallback(
    (key: keyof EngineResources, value: number) => {
      setResources((current) => ({ ...current, [key]: value }));
      setResourceNotice(null);
    },
    [],
  );

  const resetResources = useCallback(() => {
    setResources({ ...DEFAULT_ENGINE_RESOURCES });
    setResourceNotice(null);
  }, []);

  const applyResources = useCallback(() => {
    setAppliedResources({ ...resources });
    setResourceNotice("Resources applied · engine restart queued");
  }, [resources]);

  const toggleFeatureFlag = useCallback((key: keyof FeatureFlags) => {
    setFeatureFlags((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const setThemeFamily = useCallback(
    (family: ThemeFamily) => {
      if (captureAppearance) return;
      setAppearancePersistenceSucceeded(null);
      setAppearance((current) => ({ ...current, family }));
    },
    [captureAppearance],
  );

  const setColorMode = useCallback(
    (mode: ColorMode) => {
      if (captureAppearance) return;
      setAppearancePersistenceSucceeded(null);
      setAppearance((current) => ({ ...current, mode }));
    },
    [captureAppearance],
  );

  useEffect(() => {
    const effectiveAppearance = captureAppearance
      ? DEFAULT_APPEARANCE
      : appearance;
    applyAppearancePreference(effectiveAppearance);
    if (captureAppearance) {
      setAppearancePersistenceSucceeded(null);
      return;
    }
    setAppearancePersistenceSucceeded(
      persistAppearancePreference(effectiveAppearance),
    );
  }, [appearance, captureAppearance]);

  const effectiveAppearance = captureAppearance
    ? DEFAULT_APPEARANCE
    : appearance;

  return {
    bridge,
    isHost,
    view,
    selectedContainer,
    detailTab,
    search,
    commandCenterOpen,
    commandCenterInitialQuery,
    onlyRunning,
    bannerVisible,
    containers,
    filteredContainers,
    visibleLogs,
    logFilter,
    followLogs,
    pendingIds,
    runningCount,
    stoppedCount,
    engineCpu,
    engineMemory,
    error,
    engineStatus,
    engineStatusMessage,
    dockerContext,
    systemSnapshot,
    hostDomainState,
    selectedInspect:
      selectedId === null ? null : inspectByContainer[selectedId] ?? null,
    selectedStats:
      selectedId === null ? null : statsByContainer[selectedId] ?? null,
    statsHistoryFor,
    filePath,
    fileListing,
    fileError,
    filePreview,
    browseFiles,
    previewFile,
    closeFilePreview,
    downloadFile,
    uploadFile,
    processes,
    changes,
    selectedDetailErrors:
      selectedId === null ? {} : detailErrors[selectedId] ?? {},
    imageTab,
    registryQuery,
    images,
    registryResults,
    imageSummary,
    pulledRegistryImages,
    imageTransfer,
    imageMutationPending,
    volumes,
    volumeSummary,
    volumeMutationPending,
    builds: isHost ? [] : BUILD_FIXTURES,
    selectedBuild,
    devEnvironments,
    openedEnvironmentId,
    extensions: isHost ? [] : EXTENSION_FIXTURES,
    installedExtensions,
    extensionSummary,
    settingsTab,
    resources,
    appliedResources,
    resourceNotice,
    featureFlags,
    themeFamily: effectiveAppearance.family,
    colorMode: effectiveAppearance.mode,
    appearancePersistenceSucceeded,
    navigate,
    setSearch,
    openCommandCenter,
    closeCommandCenter,
    setOnlyRunning,
    setBannerVisible,
    selectContainer,
    setSelectedId,
    setDetailTab,
    setLogFilter,
    setFollowLogs,
    clearLogs,
    toggleContainer,
    restartContainer,
    selectedContainerIds,
    toggleContainerSelection,
    setContainerSelection,
    clearContainerSelection,
    runBulkContainerAction,
    createContainer,
    containerCreatePending,
    availableContexts,
    selectDockerContext,
    composeProjects,
    composeFilter,
    setComposeFilter,
    pauseContainer,
    unpauseContainer,
    killContainer,
    commitContainer,
    renameContainer,
    updateContainer,
    deleteContainer,
    setImageTab,
    pruneSystem,
    systemPruneResult,
    systemPrunePending,
    dismissSystemPruneResult: () => setSystemPruneResult(null),
    networks,
    networkMutationPending,
    refreshNetworks,
    createNetwork,
    removeNetwork,
    pruneNetworks,
    selectedImage,
    imageDetail,
    imageDetailError,
    openImageDetail,
    closeImageDetail,
    registryHits,
    registrySearching,
    searchRegistry,
    imageFilters,
    setImageFilters,
    imageQuery,
    setImageQuery,
    filteredImages,
    filteredVolumes,
    setRegistryQuery,
    cleanUpImages,
    removeImage,
    tagImage,
    scoutByReference,
    scoutPending,
    scoutError,
    analyzeImage,
    browsedVolume,
    volumePath,
    volumeListing,
    volumePreview,
    volumeBrowseError,
    browseVolume,
    previewVolumeFile,
    closeVolumeBrowser,
    closeVolumePreview,
    composeProjectList,
    composeStatus,
    composeError,
    composeServices,
    expandedComposeProject,
    refreshCompose,
    toggleComposeProject,
    runComposeAction,
    pullRegistryImage,
    saveImageArchive,
    loadImageArchive,
    exportContainerArchive,
    createVolume,
    removeVolume,
    pruneVolumes,
    setSelectedBuildId,
    retryEngine,
    createDevEnvironment,
    toggleDevEnvironment,
    deleteDevEnvironment,
    setOpenedEnvironmentId,
    toggleExtension,
    setSettingsTab,
    updateResource,
    resetResources,
    applyResources,
    toggleFeatureFlag,
    setThemeFamily,
    setColorMode,
  };
}

export type AnchorageStore = ReturnType<typeof useAnchorageStore>;
