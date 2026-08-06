import {
  appendActivity,
  summariseDockerEvent,
  updateActivity,
  type Activity,
} from "./activity";
import { aggregateEngineCpuPercent } from "./engineUtilisation";
import {
  BUILD_FIXTURES,
  DEFAULT_ENGINE_RESOURCES,
  DEFAULT_FEATURE_FLAGS,
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
  withFamily,
  type CornerStyle,
} from "../theme/appearance";
import {
  persistCapabilityPreference,
  readCapabilityPreference,
} from "../data/capabilities";
import type {
  ComposeConfigResult,
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
  BuildRecord,
  BuildBuilder,
  AgentsListResult,
  CapabilityInstallResult,
  MCPCatalogResult,
  MCPListResult,
  DockerModel,
  InstallableCapability,
  ModelActionRequest,
  ModelDiskUsage,
  ModelRunnerStatus,
  ModelSearchResult,
  BuildsInspectResult,
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
  SecretSummary,
  SwarmSurface,
  SystemActionResult,
  SystemPruneOptions,
  SystemSnapshot,
  ViewId,
  SystemPlugins,
  DockerVersions,
  EnginePlugin,
  PluginRepair,
  BuilderAction,
  ImageProjection,
  ImagesInspectResult,
  VolumeProjection,
} from "../types";
import { readFileAsBase64 } from "../utils/fileEncoding";

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

/**
 * Columns the list cannot answer for.
 *
 * The core's `Container` has no CPU or memory field — those come from `containers.stats.batch`,
 * which the sampler writes into these same objects every 8 s because each sample costs the daemon
 * a full collection cycle. A list refresh carrying `undefined` for them is silence, not a reading
 * of zero, so it is carried forward rather than applied.
 */
const CONTAINER_SAMPLED_FIELDS = ["cpu", "memory", "memoryLimit"] as const;

/**
 * Merges a fresh list over the current rows, keeping the sampler's columns.
 *
 * Without this, every containers refresh blanked CPU and MEMORY: reconciliation compared the
 * sampled fields against a payload that never carries them, concluded the row had changed, and
 * replaced it with the bare one. Docker healthcheck events refresh the list far more often than
 * the 8 s sampler refills it, so the columns were empty most of the time.
 */
export const reconcileContainerIdentity = (
  previous: AnchorageContainer[],
  next: AnchorageContainer[],
): AnchorageContainer[] => {
  if (previous.length === 0) return next;
  const byId = new Map(previous.map((container) => [container.id, container]));
  let changed = previous.length !== next.length;
  const merged = next.map((candidate, index) => {
    const existing = byId.get(candidate.id);
    // A container that is no longer running consumes nothing, and the list is the only thing
    // that knows it stopped. Carrying the last sample forward there would leave the table
    // asserting that an exited container is still burning CPU.
    const carried =
      existing && candidate.state === "running"
        ? CONTAINER_SAMPLED_FIELDS.reduce<AnchorageContainer>(
            (row, field) =>
              row[field] === undefined && existing[field] !== undefined
                ? { ...row, [field]: existing[field] }
                : row,
            candidate,
          )
        : candidate;
    if (
      existing &&
      CONTAINER_RENDER_FIELDS.every((field) => existing[field] === carried[field])
    ) {
      if (previous[index] !== existing) changed = true;
      return existing;
    }
    changed = true;
    return carried;
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
/** One subprocess per source, so this is a real resource bound rather than a UI preference. */
const MERGED_LOG_SOURCE_LIMIT = 6;
const MERGED_LOG_LINE_LIMIT = 2_000;
const MERGED_LOG_TAIL = 50;
/** Matches the chart's own bar count, so the series is exactly what is drawn. */
const ENGINE_HISTORY_POINTS = 48;

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
  // Both halves of `docker version`, read on the same call that resolves the contexts. Held
  // rather than re-fetched: it changes only when the daemon or the CLI is replaced, and the one
  // surface that reports it should not pay a subprocess to open.
  const [dockerVersions, setDockerVersions] = useState<DockerVersions | null>(null);
  // The daemon's own plugins, which are a different subsystem from the CLI plugins above.
  // Fetched on demand rather than at launch: nothing outside the Engine settings pane reads
  // them, and an empty daemon is the common case.
  const [enginePlugins, setEnginePlugins] = useState<EnginePlugin[] | null>(null);
  const [enginePluginsError, setEnginePluginsError] = useState<string | null>(null);
  const [availableContexts, setAvailableContexts] = useState<
    Array<{ name: string; current: boolean; description?: string }>
  >([]);
  /** Set when the user explicitly picks a context, so rediscovery stops overriding it. */
  const pinnedContextRef = useRef<string | null>(null);
  const [systemSnapshot, setSystemSnapshot] =
    useState<SystemSnapshot | null>(null);
  const [hostDomainState, setHostDomainState] = useState<
    Record<
      "snapshot" | "images" | "volumes" | "networks",
      { status: "idle" | "loading" | "ready" | "error"; error?: string }
    >
  >({
    snapshot: { status: "idle" },
    images: { status: "idle" },
    volumes: { status: "idle" },
    networks: { status: "idle" },
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
  /**
   * Records one tab's failure reason against one container.
   *
   * The nested spread is easy to write in a way that drops a sibling tab's error, so the
   * read-only tabs share this rather than each keeping their own copy of it. Passing `null`
   * clears the entry, which is what a retry needs before it starts.
   */
  const noteDetailError = useCallback(
    (containerId: string, tab: DetailTab, message: string | null) => {
      setDetailErrors((current) => ({
        ...current,
        [containerId]: { ...current[containerId], [tab]: message ?? undefined },
      }));
    },
    [],
  );
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
    /**
     * Which screen owns this session. Image transfers, Compose actions and model pulls share
     * one slot, so without this a `compose down` rendered its panel on Images and an image pull
     * rendered one on Compose. Each screen shows only its own.
     */
    kind: "image" | "compose" | "model";
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
  const [capabilityInstalling, setCapabilityInstalling] = useState<string | null>(
    null,
  );
  const [capabilityInstallError, setCapabilityInstallError] = useState<
    string | null
  >(null);
  const [capabilityInstalled, setCapabilityInstalled] =
    useState<CapabilityInstallResult | null>(null);
  const [mcpReport, setMcpReport] = useState<MCPListResult | null>(null);
  const [mcpCatalogDetail, setMcpCatalogDetail] =
    useState<MCPCatalogResult | null>(null);
  const [mcpStatus, setMcpStatus] = useState<
    "idle" | "loading" | "ready" | "unavailable" | "error"
  >("idle");
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpCatalogLoading, setMcpCatalogLoading] = useState<string | null>(null);
  const [agentReport, setAgentReport] = useState<AgentsListResult | null>(null);
  const [agentsStatus, setAgentsStatus] = useState<
    "idle" | "loading" | "ready" | "unavailable" | "error"
  >("idle");
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [secretBusy, setSecretBusy] = useState<string | null>(null);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [models, setModels] = useState<DockerModel[]>([]);
  const [modelRunner, setModelRunner] = useState<ModelRunnerStatus>({
    running: false,
    backends: [],
  });
  const [modelDisk, setModelDisk] = useState<ModelDiskUsage[]>([]);
  const [modelsStatus, setModelsStatus] = useState<
    "idle" | "loading" | "ready" | "unavailable" | "error"
  >("idle");
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsBusy, setModelsBusy] = useState<string | null>(null);
  const [modelSearchResults, setModelSearchResults] = useState<
    ModelSearchResult[] | null
  >(null);
  const [modelSearchStatus, setModelSearchStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [modelSearchError, setModelSearchError] = useState<string | null>(null);
  const [buildRecords, setBuildRecords] = useState<BuildRecord[]>([]);
  const [buildBuilders, setBuildBuilders] = useState<BuildBuilder[]>([]);
  const [buildsStatus, setBuildsStatus] = useState<
    "idle" | "loading" | "ready" | "unavailable" | "error"
  >("idle");
  const [buildsError, setBuildsError] = useState<string | null>(null);
  const [buildDetail, setBuildDetail] = useState<BuildsInspectResult | null>(null);
  /**
   * Why one build record could not be read, kept apart from `buildsError`.
   *
   * `buildsError` carries two unlike things already — a failed list, and buildx's own
   * limitations, which are caveats rather than failures. Routing a failed
   * `buildx history inspect` there as well meant a benign limitation and a broken record were
   * indistinguishable, and the detail failure overwrote the list caveat on its way past.
   */
  const [buildDetailError, setBuildDetailError] = useState<string | null>(null);
  const [selectedBuildRef, setSelectedBuildRef] = useState<string | null>(null);
  /** Which record the detail pane is showing, so a slow inspect cannot land under another. */
  const selectedBuildRefRef = useRef<string | null>(null);
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  // Kept beside the status rather than folded into it: an engine that is not a Swarm manager
  // is neither an error nor a ready empty list, and the screen has to say which it is.
  const [secretsSwarm, setSecretsSwarm] = useState<SwarmSurface | null>(null);
  const [secretsStatus, setSecretsStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const [secretsLimitations, setSecretsLimitations] = useState<string[]>([]);
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
  /*
   * The CLI plugin installation, held in the store rather than fetched per screen.
   *
   * It used to be a per-screen fetch, on the reasoning that a rarely-visited destination should
   * not read a stale answer. Two things changed that. The sidebar now decides which rows exist
   * from this report, so it has to be somewhere every render can see it. And a repair performed
   * on one surface has to be reflected on all of them at once — removing a dangling `docker-mcp`
   * from Settings must make the Tools row disappear without a reload.
   *
   * `null` means "not answered", never "nothing installed". Every consumer treats the two
   * differently, because hiding a row on a failed read would be a lie about the machine.
   */
  const [pluginReport, setPluginReport] = useState<SystemPlugins | null>(null);
  const [pluginReportStatus, setPluginReportStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [pluginReportError, setPluginReportError] = useState<string | null>(null);
  const [pluginRepairPending, setPluginRepairPending] = useState<string | null>(null);
  const [builderActionPending, setBuilderActionPending] = useState<string | null>(
    null,
  );
  const [builderActionError, setBuilderActionError] = useState<string | null>(null);
  // Destinations the operator chose to keep in the sidebar despite an absent plugin, so they can
  // reach the setup screen that explains how to install it. Read once: it is a preference, and
  // re-reading storage on every render would not make it more correct.
  const [revealedCapabilities, setRevealedCapabilities] = useState<ViewId[]>(
    () => readCapabilityPreference().revealed,
  );
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
  // Set when the core refused an upload because a running container holds the volume. Held
  // as state rather than an error so the operator can decide, then retry deliberately.
  const [volumeInUseUpload, setVolumeInUseUpload] = useState<{
    file: File;
    message: string;
  } | null>(null);
  const [volumeTransfer, setVolumeTransfer] = useState<{
    kind: "backup" | "restore" | "clone" | "empty";
    volume: string;
    status: "running" | "done";
    detail?: string;
  } | null>(null);
  const [volumeInUseRestore, setVolumeInUseRestore] = useState<{
    archivePath: string;
    volume: string;
    message: string;
  } | null>(null);
  const [selectedBuildId, setSelectedBuildId] = useState(
    BUILD_FIXTURES[0]?.id ?? "",
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
    setHostDomainState((current) => ({
      ...current,
      networks: { status: "loading" },
    }));
    try {
      const result = await bridge.networks.list(context);
      if (context !== dockerContextRef.current) return [];
      setNetworks(result.networks);
      setHostDomainState((current) => ({
        ...current,
        networks: { status: "ready" },
      }));
      return result.networks;
    } catch (reason) {
      if (context === dockerContextRef.current) {
        setHostDomainState((current) => ({
          ...current,
          networks: {
            status: "error",
            error:
              reason instanceof Error ? reason.message : "Network list failed",
          },
        }));
      }
      throw reason;
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

  /**
   * Re-read the plugin installation.
   *
   * This is the "Re-check now" every capability screen offers, and the reason it is worth
   * offering: a plugin installed in a terminal while Anchorage is open was previously invisible
   * until the screen was navigated away from and back. It is a directory scan and one
   * `docker info`, so it is cheap enough to be a button.
   */
  const refreshPlugins = useCallback(async () => {
    if (!isHost) {
      // No CLI to ask. Left as `idle` with a null report so every consumer reads "unknown"
      // rather than "absent" — the browser preview knows nothing about this machine.
      return;
    }
    setPluginReportStatus("loading");
    try {
      const report = await bridge.system.plugins(dockerContextRef.current);
      setPluginReport(report);
      setPluginReportStatus("ready");
      setPluginReportError(null);
    } catch (reason) {
      // The report is cleared rather than kept: a stale answer would keep gating the sidebar on
      // facts nobody can vouch for. Cleared means unknown, which hides nothing.
      setPluginReport(null);
      setPluginReportStatus("error");
      setPluginReportError(
        reason instanceof Error ? reason.message : "Plugin inspection failed",
      );
    }
  }, [bridge, isHost]);

  const retryEngine = useCallback(async () => {
    const request = ++engineRequestRef.current;
    setEngineStatus("loading");
    setEngineStatusMessage(null);
    try {
      let context = dockerContextRef.current;
      // Deliberately system.contexts rather than system.capabilities. Both report the context
      // list; only capabilities also walks every advertised Docker command and probes every
      // plugin, which measured ~3.1s on the reference machine and held the first paint for all
      // of it. Nothing on this path reads a capability or an inventory.
      const capabilities = await bridge.system.contexts();
      setDockerVersions(capabilities.versions ?? null);
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
          // On the launch path because the sidebar's own contents depend on it: a row gated on
          // an absent plugin must not appear and then vanish once something got round to asking.
          // It is a directory scan and one `docker info`, not the capability walk.
          refreshPlugins(),
        ]);
      }
    } catch (reason) {
      if (request !== engineRequestRef.current) return;
      const failure = classifyEngineFailure(reason);
      setEngineStatus(failure.status);
      setEngineStatusMessage(failure.message);
    }
  }, [bridge, isHost, refreshImages, refreshPlugins, refreshSnapshot, refreshVolumes]);

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

  /**
   * Where the operator was before they opened Settings.
   *
   * v2.5 makes the titlebar gear a toggle, so leaving Settings has to go back rather than
   * forward. Remembered here rather than derived from history, which would also step back
   * through selections the operator had already dismissed.
   */
  const [settingsReturnView, setSettingsReturnView] = useState<ViewId | null>(null);

  const navigate = useCallback((nextView: ViewId) => {
    setView((current) => {
      if (nextView === "settings" && current !== "settings") {
        setSettingsReturnView(current);
      }
      return nextView;
    });
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
          // The stream was previously read only to decide which list to re-fetch, and the event
          // itself thrown away — so a container dying produced a silent table refresh and no
          // statement that anything had happened.
          const summary = summariseDockerEvent(event);
          if (summary) recordActivity(summary);
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
   * Populate the list's CPU and MEMORY columns, and the engine aggregates behind them.
   *
   * Those columns rendered a permanent em-dash in host mode because stats were only ever
   * fetched for the single selected container. This samples the running containers, bounded
   * so a large daemon cannot turn a poll into hundreds of requests, and skipped while the tab
   * is hidden.
   *
   * It deliberately does NOT stop when you leave the Containers view. `engineCpu` and
   * `engineMemory` are derived from the same per-container samples, and they are rendered by
   * the sidebar engine card and the status bar — chrome that is on screen everywhere. Gating
   * this on the list froze both the moment you navigated to any other destination, which read
   * as an idle engine rather than as a stopped sampler.
   */
  useEffect(() => {
    if (!isHost || engineStatus !== "ready") return;
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
  }, [bridge, engineStatus, isHost]);

  /**
   * The unified log stream.
   *
   * One `docker logs --follow` session per selected container, merged in arrival order. It is
   * arrival order rather than timestamp order on purpose: the daemon's timestamps come from
   * each container's own clock and reordering by them would silently move lines relative to
   * what actually happened.
   *
   * Bounded deliberately. Every source is a subprocess, and this host runs 54 containers; a
   * "follow everything" button would open 54 of them. The cap is disclosed rather than
   * silently applied — a truncated source list that looks complete is worse than a small one
   * that says so.
   */
  const [logSources, setLogSources] = useState<string[]>([]);
  const [mergedLogLines, setMergedLogLines] = useState<LogLine[]>([]);
  const [logStreamErrors, setLogStreamErrors] = useState<Record<string, string>>({});
  const [mergedLogFilter, setMergedLogFilter] = useState("");
  const mergedSequenceRef = useRef(0);

  const toggleLogSource = useCallback((id: string) => {
    setLogSources((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : current.length >= MERGED_LOG_SOURCE_LIMIT
          ? current
          : [...current, id],
    );
  }, []);

  const clearMergedLogs = useCallback(() => {
    // Discards the buffer, not the sources: the streams stay open. "Clear" that also stopped
    // following would be two actions wearing one label.
    setMergedLogLines([]);
  }, []);

  useEffect(() => {
    if (!isHost || engineStatus !== "ready" || logSources.length === 0) return;
    const active = containersRef.current.filter((container) =>
      logSources.includes(container.id),
    );
    if (active.length === 0) return;

    let disposed = false;
    const owners = new Map<string, string>();
    const partials = new Map<string, string>();
    const unsubscribers: Array<() => void> = [];

    const appendFrom = (containerId: string, name: string, text: string) => {
      const carried = partials.get(containerId) ?? "";
      const lines = `${carried}${text}`.split(/\r?\n/u);
      partials.set(containerId, lines.pop() ?? "");
      if (lines.length === 0) return;
      const additions = lines
        .filter((line) => line.trim().length > 0)
        .map((line): LogLine => {
          mergedSequenceRef.current += 1;
          // The daemon prefixes an RFC3339 stamp because --timestamps is set; it is split off
          // so the column is the container's own clock rather than the time we received it.
          const match = /^(\S+)\s([\s\S]*)$/u.exec(line);
          const stamped = match && match[1].includes("T");
          return {
            id: `${containerId}-merged-${mergedSequenceRef.current}`,
            timestamp: stamped ? match[1].slice(11, 19) : formatClock(),
            level: /\berror\b/iu.test(line)
              ? "ERROR"
              : /\bwarn(ing)?\b/iu.test(line)
                ? "WARN"
                : "INFO",
            message: stamped ? match[2] : line,
            source: name,
          };
        });
      if (additions.length === 0) return;
      setMergedLogLines((current) =>
        [...current, ...additions].slice(-MERGED_LOG_LINE_LIMIT),
      );
    };

    for (const container of active) {
      const unsubscribe = bridge.sessions.subscribe((event) => {
        const owner = owners.get(container.id);
        if (!owner || event.payload.sessionId !== owner) return;
        if (event.event === "session.output") {
          appendFrom(container.id, container.name, decodeSessionData(event));
          // Acknowledged so the core's backpressure window advances; an unacked stream
          // stalls once the window fills, which looks exactly like a quiet container.
          void bridge.sessions
            .ack({
              sessionId: event.payload.sessionId,
              throughSequence: event.payload.sequence,
            })
            .catch(() => undefined);
        } else if (event.event === "session.error") {
          setLogStreamErrors((current) => ({
            ...current,
            [container.name]: "The daemon stopped this log stream.",
          }));
        }
      });
      unsubscribers.push(unsubscribe);

      void bridge.sessions
        .start({
          context: dockerContextRef.current,
          argv: [
            "logs",
            "--timestamps",
            "--tail",
            String(MERGED_LOG_TAIL),
            "--follow",
            container.id,
          ],
          mode: "pipes",
          outputWindowBytes: 64 * 1024,
          maxOutputBytes: 16 * 1024 * 1024,
        })
        .then((result) => {
          if (disposed) {
            void Promise.resolve(
              bridge.sessions.cancel({ sessionId: result.sessionId, gracePeriodMs: 250 }),
            ).catch(() => undefined);
            return;
          }
          owners.set(container.id, result.sessionId);
        })
        .catch((reason: unknown) => {
          if (disposed) return;
          // A logging driver the daemon cannot read back fails here rather than returning
          // nothing, and it fails per source — one unreadable container must not look like a
          // dead stream for the others.
          setLogStreamErrors((current) => ({
            ...current,
            [container.name]:
              reason instanceof Error ? reason.message : "Log stream failed",
          }));
        });
    }

    return () => {
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      for (const sessionId of owners.values()) {
        void Promise.resolve(
          bridge.sessions.cancel({ sessionId, gracePeriodMs: 250 }),
        ).catch(() => undefined);
      }
    };
  }, [bridge, engineStatus, isHost, logSources]);

  const filteredLogLines = useMemo(() => {
    const needle = mergedLogFilter.trim().toLocaleLowerCase();
    if (!needle) return mergedLogLines;
    return mergedLogLines.filter((line) =>
      `${line.source ?? ""} ${line.message}`.toLocaleLowerCase().includes(needle),
    );
  }, [mergedLogFilter, mergedLogLines]);

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
        await bridge.containers.fileWrite(
          id,
          filePathRef.current,
          file.name,
          await readFileAsBase64(file),
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
  //
  // Keyed on the container's id, not the container. `CONTAINER_RENDER_FIELDS` treats `status`,
  // `cpu` and `memory` as identity, and Docker's status is a relative string — "Up 3 minutes" —
  // so the object changes on nearly every 2s poll. Depending on it re-ran this effect against an
  // unchanged container, which reset the panel to its loading message and re-issued the request
  // continuously, and after the error state was added would have cleared and re-derived that too.
  const selectedContainerId = selectedContainer?.id ?? null;
  useEffect(() => {
    if (!isHost || !selectedContainerId) return;
    if (detailTab === "files") {
      setFilePath("/");
      void browseFiles("/");
      return;
    }
    if (detailTab === "processes") {
      setProcesses(null);
      noteDetailError(selectedContainerId, "processes", null);
      void bridge.containers
        .top(selectedContainerId, dockerContextRef.current)
        .then((result) => {
          if (selectedIdRef.current === selectedContainerId) setProcesses(result);
        })
        .catch((reason) => {
          // `docker top` fails routinely rather than exceptionally: the Engine answers 409 for
          // a container that is not running, and the tab is reachable in that state. Swallowing
          // it left the loading message on screen with no terminal state, so a refusal read as
          // a hang.
          if (selectedIdRef.current !== selectedContainerId) return;
          noteDetailError(
            selectedContainerId,
            "processes",
            reason instanceof Error ? reason.message : "Could not read the process list.",
          );
        });
      return;
    }
    if (detailTab === "changes") {
      setChanges(null);
      noteDetailError(selectedContainerId, "changes", null);
      void bridge.containers
        .diff(selectedContainerId, dockerContextRef.current)
        .then((result) => {
          if (selectedIdRef.current === selectedContainerId) setChanges(result);
        })
        .catch((reason) => {
          if (selectedIdRef.current !== selectedContainerId) return;
          noteDetailError(
            selectedContainerId,
            "changes",
            reason instanceof Error
              ? reason.message
              : "Could not read the filesystem changes.",
          );
        });
    }
  }, [bridge, browseFiles, detailTab, isHost, noteDetailError, selectedContainerId]);

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
  /**
   * Rolling history behind the dashboard's CPU and memory charts.
   *
   * The Engine exposes per-container `/stats` and keeps no aggregate history, so there is
   * nothing to backfill from — the series can only be accumulated from the samples as they
   * arrive. Host mode showed a static fact list instead of the charts precisely because this
   * did not exist; it does now that the sampler runs on every destination rather than only
   * on the containers list.
   *
   * Seeded empty rather than zero-filled: a chart of invented zeroes would read as an idle
   * engine for the first minute after launch.
   */
  /**
   * Everything that is happening or just happened — jobs Anchorage started and events Docker
   * reported. See store/activity.ts for why those share one model.
   */
  const [activities, setActivities] = useState<Activity[]>([]);
  const recordActivity = useCallback((entry: Activity) => {
    setActivities((current) => appendActivity(current, entry));
  }, []);
  const patchActivity = useCallback((id: string, patch: Partial<Activity>) => {
    setActivities((current) => updateActivity(current, id, patch));
  }, []);
  const markActivitiesRead = useCallback(() => {
    setActivities((current) =>
      current.every((item) => item.read)
        ? current
        : current.map((item) => (item.read ? item : { ...item, read: true })),
    );
  }, []);
  const dismissActivity = useCallback((id: string) => {
    setActivities((current) => current.filter((item) => item.id !== id));
  }, []);
  const unreadActivityCount = useMemo(
    () => activities.filter((item) => !item.read).length,
    [activities],
  );

  const [engineHistory, setEngineHistory] = useState<{
    cpu: number[];
    memory: number[];
  }>({ cpu: [], memory: [] });

  // Divided by the engine's real core count, not a constant. This was `/ 8`, which overstated
  // load eightfold on a 64-core host; see store/engineUtilisation.ts.
  const engineCpu = useMemo(
    () =>
      aggregateEngineCpuPercent(
        containers,
        systemSnapshot?.engine?.cpus,
      ) ?? 0,
    [containers, systemSnapshot],
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

  useEffect(() => {
    if (!isHost || engineStatus !== "ready") return;
    setEngineHistory((current) => ({
      cpu: [...current.cpu, engineCpu].slice(-ENGINE_HISTORY_POINTS),
      memory: [...current.memory, engineMemory].slice(-ENGINE_HISTORY_POINTS),
    }));
  }, [engineCpu, engineMemory, engineStatus, isHost]);


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
      if (!isHost) {
        // The browser preview reclaims across the same three domains a real system prune
        // does, against fixture state. It previously did nothing, which is why the button
        // beside it had to be relabelled to the narrower verb it actually performed.
        setImages((current) => current.filter((image) => !image.reclaimable));
        setContainers((current) =>
          current.filter(
            (container) =>
              !["exited", "dead", "stopped", "created"].includes(container.state),
          ),
        );
        setVolumes((current) => current.filter((volume) => volume.usedBy));
        return;
      }
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
  /**
   * Which image the detail panel is actually showing.
   *
   * Written by the opener and the closer rather than during render, because the guard has to be
   * exact against the value this function just set and not against whatever React has most
   * recently committed.
   */
  const openImageIdRef = useRef<string | null>(null);

  /** Open the image detail panel and load its configuration and layer history. */
  const openImageDetail = useCallback(
    async (image: AnchorageImage) => {
      setSelectedImage(image);
      setImageDetail(null);
      setImageDetailError(null);
      openImageIdRef.current = image.imageId;
      if (!isHost) return;
      try {
        const detail = await bridge.images.inspect(
          image.imageId,
          dockerContextRef.current,
        );
        // The user may have closed or switched images while this was in flight. Landing a stale
        // inspect would put one image's layers, size and platform under another image's name,
        // and the panel gives no sign it is mixed.
        if (openImageIdRef.current !== image.imageId) return;
        setImageDetail(detail);
      } catch (reason) {
        if (openImageIdRef.current !== image.imageId) return;
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
    openImageIdRef.current = null;
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
   * Reads Model Runner: what is pulled, whether the runner is up, and what it costs on disk.
   *
   * One call backs the whole screen because the three answers only mean something together.
   * An empty model list reads as "nothing pulled yet" when the runner is running and as
   * "nothing is going to work" when it is not, and showing either without the other would
   * leave the operator to guess which they are looking at.
   *
   * An absent plugin is a described state rather than an error, exactly as buildx is: the fix
   * is to install it, which Settings → Engine → Capabilities has the command for.
   */
  const refreshModels = useCallback(async () => {
    if (!isHost) return;
    setModelsStatus((current) => (current === "ready" ? "ready" : "loading"));
    try {
      const result = await bridge.models.list(dockerContextRef.current);
      setModels(result.models);
      setModelRunner(result.runner);
      setModelDisk(result.disk);
      setModelsStatus("ready");
      setModelsError(null);
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Model Runner unavailable";
      setModels([]);
      setModelRunner({ running: false, backends: [] });
      setModelDisk([]);
      setModelsStatus(
        /models_unavailable|not installed/iu.test(message) ? "unavailable" : "error",
      );
      setModelsError(message);
    }
  }, [bridge, isHost]);

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
      kind: "image" | "compose" | "model";
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
        // A model pull changes no image and no disk-usage figure the snapshot reports, so it
        // re-reads the model list instead. Refreshing everything regardless would be two
        // pointless engine round trips on every pull.
        void Promise.allSettled(
          options.kind === "model"
            ? [refreshModels()]
            : [refreshImages(), refreshSnapshot()],
        );
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
          patchActivity(activityId, {
            state: "failed",
            detail: `${event.payload.code}: ${event.payload.message}`,
            endedAt: new Date().toISOString(),
          });
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
          const ok = event.payload.exitCode === 0 && !event.payload.timedOut;
          patchActivity(activityId, {
            state: ok ? "succeeded" : "failed",
            detail: ok
              ? undefined
              : event.payload.timedOut
                ? `${options.title} timed out`
                : `Exited with code ${event.payload.exitCode}`,
            endedAt: new Date().toISOString(),
          });
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
        kind: options.kind,
        title: options.title,
        reference: options.reference,
        status: "starting",
        output: "",
      });
      // The same session, recorded where it can be seen from any screen. The inline panel stays
      // for the screen that started the work; this is what makes a failure visible to an operator
      // who has already navigated away.
      const activityId = `job:${options.kind}:${options.reference}:${Date.now()}`;
      recordActivity({
        id: activityId,
        kind: "job",
        state: "running",
        title: options.title,
        subject: options.reference,
        startedAt: new Date().toISOString(),
        read: false,
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
    [bridge, refreshImages, refreshModels, refreshSnapshot],
  );

  /**
   * Loads the Compose plugin's own project list.
   *
   * Distinct from deriving projects off container labels: the plugin also reports projects
   * whose containers have all exited, and it supplies the configuration file paths that `up`
   * cannot run without. A missing plugin is a reportable state rather than an error, because
   * Compose is optional and the operator's fix is to install it.
   */
  /**
   * Fetches a CLI plugin and puts it where the Docker CLI will find it.
   *
   * Anchorage could not do this before, and the reason it can now is narrower than it looks: a
   * plugin is one executable in a directory the operator already owns, so no privilege is
   * needed. A distribution package still needs root and is still only ever a command to copy.
   *
   * The plugin installation is re-read afterwards rather than assumed, because the install
   * succeeding and the CLI loading the result are different facts — a binary for the wrong
   * architecture lands perfectly well and then fails to run.
   */
  const installCapability = useCallback(
    async (capability: InstallableCapability) => {
      if (!isHost) return false;
      setCapabilityInstalling(capability);
      setCapabilityInstallError(null);
      try {
        const result = await bridge.capabilities.install(capability);
        setCapabilityInstalled(result);
        await refreshPlugins();
        return true;
      } catch (reason) {
        setCapabilityInstallError(
          reason instanceof Error ? reason.message : "The install failed",
        );
        return false;
      } finally {
        setCapabilityInstalling((current) =>
          current === capability ? null : current,
        );
      }
    },
    [bridge, isHost, refreshPlugins],
  );

  const dismissCapabilityInstall = useCallback(() => {
    setCapabilityInstalled(null);
    setCapabilityInstallError(null);
  }, []);

  /**
   * Reads the MCP Toolkit's catalogues and profiles.
   *
   * Neither list has a JSON form, so both are parsed from the plugin's own pipe-separated
   * tables in the core. What the screen shows is deliberately the catalogue *inventory* only —
   * the servers inside one are a separate, larger read, taken when the operator opens it.
   */
  const refreshMcp = useCallback(async () => {
    if (!isHost) return;
    setMcpStatus((current) => (current === "ready" ? "ready" : "loading"));
    try {
      const result = await bridge.mcp.list(dockerContextRef.current);
      setMcpReport(result);
      setMcpStatus("ready");
      setMcpError(null);
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "The MCP Toolkit is unavailable";
      setMcpReport(null);
      setMcpStatus(
        /mcp_unavailable|not installed/iu.test(message) ? "unavailable" : "error",
      );
      setMcpError(message);
    }
  }, [bridge, isHost]);

  /**
   * Opens one catalogue.
   *
   * Separate from the list because it is a different order of magnitude — a catalogue here
   * carries 52 servers with per-server tool lists — and because reading it can pull an OCI
   * artifact. Nobody should pay that on arrival at the screen.
   */
  const openMcpCatalog = useCallback(
    async (reference: string) => {
      if (!isHost) return;
      setMcpCatalogLoading(reference);
      setMcpError(null);
      try {
        const result = await bridge.mcp.catalog(
          reference,
          dockerContextRef.current,
        );
        setMcpCatalogDetail(result);
      } catch (reason) {
        setMcpError(
          reason instanceof Error ? reason.message : "That catalog could not be read",
        );
      } finally {
        setMcpCatalogLoading((current) =>
          current === reference ? null : current,
        );
      }
    },
    [bridge, isHost],
  );

  const closeMcpCatalog = useCallback(() => setMcpCatalogDetail(null), []);

  /**
   * Reads what Docker Agent can do on this machine.
   *
   * Not what agents exist — there is no such list, because an agent is a YAML file the operator
   * points `docker agent run` at. What a GUI can usefully answer is whether the machine is set
   * up at all: which models are reachable, which tool types an agent could be granted, and
   * which provider credentials are visible.
   */
  const refreshAgents = useCallback(async () => {
    if (!isHost) return;
    setAgentsStatus((current) => (current === "ready" ? "ready" : "loading"));
    try {
      const result = await bridge.agents.list(dockerContextRef.current);
      setAgentReport(result);
      setAgentsStatus("ready");
      setAgentsError(null);
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Docker Agent unavailable";
      setAgentReport(null);
      setAgentsStatus(
        /agents_unavailable|not installed/iu.test(message) ? "unavailable" : "error",
      );
      setAgentsError(message);
    }
  }, [bridge, isHost]);


  /**
   * Searches Docker Hub, and Hugging Face when asked.
   *
   * Kept apart from the list because it leaves the machine. Opening the Models screen must not
   * reach a registry; asking for a search is the consent, which is why this has its own status
   * and its own error rather than sharing the list's.
   */
  const searchModels = useCallback(
    async (query: string, source?: "docker-hub" | "huggingface" | "all") => {
      if (!isHost) return;
      setModelSearchStatus("loading");
      setModelSearchError(null);
      try {
        const result = await bridge.models.search(
          query,
          source,
          dockerContextRef.current,
        );
        setModelSearchResults(result.results);
        setModelSearchStatus("ready");
      } catch (reason) {
        const message =
          reason instanceof Error ? reason.message : "Model search failed";
        setModelSearchResults(null);
        setModelSearchStatus("error");
        setModelSearchError(message);
      }
    },
    [bridge, isHost],
  );

  const clearModelSearch = useCallback(() => {
    setModelSearchResults(null);
    setModelSearchStatus("idle");
    setModelSearchError(null);
  }, []);

  /**
   * Pull, remove, or unload one model.
   *
   * `busy` is keyed by reference rather than a single boolean, so pulling one model does not
   * grey out the row beside it. A pull returns as soon as its session starts and the weights
   * keep arriving afterwards, so the list is re-read on completion rather than optimistically
   * patched — the only way to know a multi-gigabyte download finished is to look.
   */
  const modelAction = useCallback(
    async (request: ModelActionRequest) => {
      if (!isHost) return false;
      const key = request.reference ?? request.action;

      /*
        A pull is a session, and it has to be followed like one.

        This used to await `models.action` and immediately re-read the list. The call returns as
        soon as the download *starts*, so the list was re-read before a byte had landed, the
        busy flag cleared within the same second, and the screen reported that nothing had
        happened — while the pull ran on unattended and turned up minutes later on some
        unrelated Re-check. That is the defect that was reported as "unable to pull models".

        Nothing acknowledged the session's output either. The core stops writing once its window
        fills without an ack, and measured against a real pull that is latent rather than fatal:
        `docker model pull` emitted 718 bytes for a 256 MiB model, nowhere near the window. It
        is fixed here because it is free to fix and the margin is not a guarantee — a model with
        many layers prints proportionally more.

        `runTransferSession` already does all of this correctly for image and Compose work, and
        its own comment records that those two paths had duplicated the logic until only one of
        them got the tricky parts right. Reaching for it here rather than copying it a third
        time is the whole point of it existing.
      */
      if (request.action === "pull" && request.reference) {
        setModelsError(null);
        await runTransferSession({
          kind: "model",
          title: "Pull",
          reference: request.reference,
          failureMessage: "Model pull failed",
          start: () =>
            bridge.models.action({
              ...request,
              context: dockerContextRef.current,
              outputWindowBytes: 64 * 1024,
            }),
        });
        return true;
      }

      setModelsBusy(key);
      setModelsError(null);
      try {
        await bridge.models.action({
          ...request,
          context: dockerContextRef.current,
        });
        await refreshModels();
        return true;
      } catch (reason) {
        setModelsError(
          reason instanceof Error ? reason.message : "The model action failed",
        );
        return false;
      } finally {
        setModelsBusy((current) => (current === key ? null : current));
      }
    },
    [bridge, isHost, refreshModels, runTransferSession],
  );

  /**
   * Loads buildx's build history and builder inventory.
   *
   * Buildx is optional, so an absent plugin is a described state rather than an error. A
   * builder the plugin cannot reach is reported with its own message instead of dropped:
   * "no builders" and "three builders, two unreachable" are very different situations.
   */
  const refreshBuilds = useCallback(async () => {
    if (!isHost) return;
    setBuildsStatus((current) => (current === "ready" ? "ready" : "loading"));
    try {
      const result = await bridge.builds.list(dockerContextRef.current);
      setBuildRecords(result.records);
      setBuildBuilders(result.builders);
      setBuildsStatus("ready");
      setBuildsError(result.limitations[0] ?? null);
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Build history unavailable";
      setBuildRecords([]);
      setBuildBuilders([]);
      setBuildsStatus(
        /buildx_unavailable|not installed/iu.test(message) ? "unavailable" : "error",
      );
      setBuildsError(message);
    }
  }, [bridge, isHost]);

  /**
   * Start or delete one builder.
   *
   * The builders table reported an unreachable builder and offered nothing to do about it, which
   * left buildx's own error message on screen beside a note telling the operator to go and run
   * buildx themselves. `bootstrap` starts the node; `remove` clears an entry whose driver is gone.
   *
   * The result carries the builders that remain, so removing the current one — which promotes
   * another — redraws correctly without a second read.
   */
  const runBuilderAction = useCallback(
    async (request: Omit<BuilderAction, "context">) => {
      if (!isHost) return false;
      setBuilderActionPending(request.name);
      setBuilderActionError(null);
      try {
        const result = await bridge.builds.builderAction({
          ...request,
          context: dockerContextRef.current,
        });
        setBuildBuilders(result.builders);
        setBuildsStatus("ready");
        recordActivity({
          id: `builder:${result.action}:${result.name}:${Date.now()}`,
          kind: "event",
          state: "succeeded",
          title: result.outcome === "removed" ? "Builder removed" : "Builder started",
          subject: result.name,
          // Buildx explains what it did better than a restatement would.
          detail: result.output?.split("\n").slice(0, 4).join("\n") || undefined,
          startedAt: new Date().toISOString(),
          read: false,
        });
        return true;
      } catch (reason) {
        setBuilderActionError(
          reason instanceof Error ? reason.message : "The builder action failed",
        );
        return false;
      } finally {
        setBuilderActionPending(null);
      }
    },
    [bridge, isHost, recordActivity],
  );

  /** Loads one record's detail. The list gives builder/node/id; the core reduces it. */
  const selectBuildRecord = useCallback(
    async (record: BuildRecord) => {
      setSelectedBuildRef(record.ref);
      selectedBuildRefRef.current = record.ref;
      setBuildDetail(null);
      // Cleared on entry so a previous record's failure cannot be read as this one's.
      setBuildDetailError(null);
      if (!isHost) return;
      try {
        const detail = await bridge.builds.inspect(
          record.ref,
          dockerContextRef.current,
        );
        if (selectedBuildRefRef.current !== record.ref) return;
        setBuildDetail(detail);
      } catch (reason) {
        if (selectedBuildRefRef.current !== record.ref) return;
        setBuildDetailError(
          reason instanceof Error ? reason.message : "Build detail unavailable",
        );
      }
    },
    [bridge, isHost],
  );

  /**
   * Loads Swarm secret references.
   *
   * A non-manager engine is the common case on Linux and comes back as a successful result
   * carrying `swarm.manager: false`, not as a rejection — so the error branch here is only
   * for a request that genuinely failed. Collapsing the two would make "this engine has no
   * secret store" look like "the secret list broke", and both would look like "no secrets".
   */
  const refreshSecrets = useCallback(async () => {
    if (!isHost) return;
    const context = dockerContextRef.current;
    setSecretsStatus((current) => (current === "ready" ? "ready" : "loading"));
    try {
      const result = await bridge.secrets.list(context);
      if (context !== dockerContextRef.current) return;
      setSecrets(result.secrets);
      setSecretsSwarm(result.swarm);
      setSecretsLimitations(result.limitations);
      setSecretsStatus("ready");
      setSecretsError(null);
    } catch (reason) {
      if (context !== dockerContextRef.current) return;
      setSecrets([]);
      setSecretsSwarm(null);
      setSecretsLimitations([]);
      setSecretsStatus("error");
      setSecretsError(
        reason instanceof Error ? reason.message : "Secret list failed",
      );
    }
  }, [bridge, isHost]);


  /**
   * Repair one faulty plugin entry.
   *
   * The core hands back the re-read installation, so the surfaces update from the action's own
   * result rather than a follow-up read that could disagree with it.
   */
  const repairPlugin = useCallback(
    async (request: PluginRepair) => {
      if (!isHost) return false;
      setPluginRepairPending(request.path);
      setPluginReportError(null);
      try {
        const result = await bridge.system.pluginAction({
          ...request,
          context: request.context ?? dockerContextRef.current,
        });
        setPluginReport(result.plugins);
        setPluginReportStatus("ready");
        // Recorded because it changed the machine outside Docker: a file was unlinked or its
        // permissions altered, and the operator should be able to find that afterwards.
        recordActivity({
          id: `plugin:${result.action}:${result.path}:${Date.now()}`,
          kind: "event",
          state: "succeeded",
          title:
            result.outcome === "removed" ? "Plugin entry removed" : "Plugin made executable",
          subject: `docker ${result.name}`,
          detail: result.path,
          startedAt: new Date().toISOString(),
          read: false,
        });
        return true;
      } catch (reason) {
        setPluginReportError(
          reason instanceof Error ? reason.message : "The plugin could not be repaired",
        );
        return false;
      } finally {
        setPluginRepairPending(null);
      }
    },
    [bridge, isHost, recordActivity],
  );

  /**
   * Create or remove a Swarm secret.
   *
   * The value never enters this store. It goes straight from the input the operator typed into
   * `bridge.secrets.create`, which base64-encodes it at the boundary — so there is no React
   * state, no request object and no error payload anywhere in the renderer holding it in the
   * clear. That is the whole reason this does not take a request object like the other actions.
   *
   * A removal cannot be undone by retyping what is on screen, because the value was never
   * readable. The confirmation is enforced in the core as well as here.
   */
  const secretAction = useCallback(
    async (
      request:
        | { action: "create"; name: string; value: string }
        | { action: "remove"; id: string },
    ) => {
      if (!isHost) return false;
      const key = request.action === "create" ? request.name : request.id;
      setSecretBusy(key);
      setSecretError(null);
      try {
        if (request.action === "create") {
          await bridge.secrets.create(
            request.name,
            request.value,
            dockerContextRef.current,
          );
        } else {
          await bridge.secrets.remove(request.id, dockerContextRef.current);
        }
        await refreshSecrets();
        return true;
      } catch (reason) {
        setSecretError(
          reason instanceof Error ? reason.message : "The secret action failed",
        );
        return false;
      } finally {
        setSecretBusy((current) => (current === key ? null : current));
      }
    },
    [bridge, isHost, refreshSecrets],
  );

  const setCapabilityRevealed = useCallback(
    (view: ViewId, revealed: boolean) => {
      setRevealedCapabilities((current) => {
        const next = revealed
          ? [...new Set([...current, view])]
          : current.filter((entry) => entry !== view);
        persistCapabilityPreference({ revealed: next });
        return next;
      });
    },
    [],
  );

  const refreshEnginePlugins = useCallback(async () => {
    if (!isHost) return;
    try {
      const result = await bridge.enginePlugins.list(dockerContextRef.current);
      setEnginePlugins(result.plugins);
      setEnginePluginsError(null);
    } catch (reason) {
      // Cleared rather than kept: a stale list would misreport what the daemon is running,
      // and this pane's whole value is saying what holds which privileges right now.
      setEnginePlugins(null);
      setEnginePluginsError(
        reason instanceof Error ? reason.message : "Managed plugins could not be read",
      );
    }
  }, [bridge, isHost]);

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
  /**
   * The resolved configuration for a project, which is where start order, watch rules,
   * lifecycle hooks and declared dependencies live. `compose ps` reports running state and
   * carries none of it, so the detail panels need this separate read.
   *
   * Fetched per project rather than for all of them: `compose config` renders and resolves
   * the whole file, which is a real cost on a large project, and only the expanded one is
   * on screen.
   */
  const [composeConfigs, setComposeConfigs] = useState<
    Record<string, ComposeConfigResult>
  >({});
  const [composeConfigPending, setComposeConfigPending] = useState<string | null>(
    null,
  );
  const [composeConfigError, setComposeConfigError] = useState<string | null>(null);

  const loadComposeConfig = useCallback(
    async (project: string, configFiles: string[]) => {
      if (!isHost || !project) return;
      // `config` renders files by path; a project discovered by label alone has none, and
      // asking anyway would resolve whatever happens to sit in the working directory.
      if (configFiles.length === 0) {
        setComposeConfigError(
          `${project} was discovered by label and reports no compose file, so its configuration cannot be resolved.`,
        );
        return;
      }
      setComposeConfigPending(project);
      setComposeConfigError(null);
      try {
        const result = await bridge.compose.config(
          project,
          configFiles,
          dockerContextRef.current,
        );
        setComposeConfigs((current) => ({ ...current, [project]: result }));
      } catch (reason) {
        setComposeConfigError(
          reason instanceof Error ? reason.message : "Compose config failed",
        );
      } finally {
        setComposeConfigPending((current) =>
          current === project ? null : current,
        );
      }
    },
    [bridge, isHost],
  );

  const runComposeAction = useCallback(
    async (params: ComposeActionInput) => {
      if (!isHost) return;
      const label =
        params.action.charAt(0).toUpperCase() + params.action.slice(1);
      await runTransferSession({
        kind: "compose",
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

  /**
   * Uploads a file into the volume currently being browsed.
   *
   * The core refuses when a running container holds the volume unless that is explicitly
   * acknowledged, because Docker will happily mount the same volume twice and an upload can
   * land under a live database mid-write. The refusal is surfaced as a question rather than
   * an error, and only a deliberate retry carries the acknowledgement.
   */
  const uploadVolumeFile = useCallback(
    async (file: File, confirmedInUse = false) => {
      if (!isHost || !browsedVolume) return;
      setVolumeBrowseError(null);
      setVolumeInUseUpload(null);
      try {
        const content = await readFileAsBase64(file);
        await bridge.volumes.fileWrite(
          browsedVolume,
          {
            path: volumePath,
            fileName: file.name,
            content,
            ...(confirmedInUse ? { confirmedInUse: true } : {}),
          },
          dockerContextRef.current,
        );
        await browseVolume(browsedVolume, volumePath);
      } catch (reason) {
        const message =
          reason instanceof Error ? reason.message : "Volume upload failed";
        // A live-container refusal is a decision to put to the operator, not a failure.
        if (/volume_in_use|attached to a running container/iu.test(message)) {
          setVolumeInUseUpload({ file, message });
          return;
        }
        setVolumeBrowseError(message);
      }
    },
    [bridge, browseVolume, browsedVolume, isHost, volumePath],
  );

  const dismissVolumeInUseUpload = useCallback(
    () => setVolumeInUseUpload(null),
    [],
  );

  /**
   * Backs a volume up to a host tar, or restores one from it.
   *
   * A volume's whole point is that its data outlives the container, so this is the operation
   * that makes the rest of the volume surface worth having. Both report through the shared
   * transfer panel because a large volume takes real time, and a restore carries the same
   * in-use question as an upload: Docker will let it happen under a running container.
   */
  const backupVolume = useCallback(
    async (name: string, archivePath: string, overwrite = false) => {
      if (!isHost) return;
      setVolumeBrowseError(null);
      setVolumeTransfer({ kind: "backup", volume: name, status: "running" });
      try {
        const result = await bridge.volumes.backup(
          name,
          archivePath,
          { overwrite },
          dockerContextRef.current,
        );
        setVolumeTransfer({
          kind: "backup",
          volume: name,
          status: "done",
          detail: `${result.entries} entries · ${result.archivePath}`,
        });
      } catch (reason) {
        setVolumeTransfer(null);
        setVolumeBrowseError(
          reason instanceof Error ? reason.message : "Volume backup failed",
        );
      }
    },
    [bridge, isHost],
  );

  const dismissVolumeError = useCallback(() => setVolumeBrowseError(null), []);

  const cloneVolume = useCallback(
    async (name: string, target: string) => {
      if (!isHost) return;
      setVolumeBrowseError(null);
      setVolumeTransfer({ kind: "clone", volume: name, status: "running" });
      try {
        const result = await bridge.volumes.clone(
          name,
          target,
          dockerContextRef.current,
        );
        setVolumeTransfer({
          kind: "clone",
          volume: name,
          status: "done",
          // The core only reports the driver-option limitation when the source actually has
          // options, so it cannot be stated before the copy runs. Dropping it here would
          // lose the one case where the copy is least interchangeable with its source.
          detail: [`${result.entries} entries copied to ${result.target}`, ...result.limitations].join(" "),
        });
        await refreshVolumes();
      } catch (reason) {
        setVolumeTransfer(null);
        setVolumeBrowseError(
          reason instanceof Error ? reason.message : "Volume clone failed",
        );
      }
    },
    [bridge, isHost, refreshVolumes],
  );

  const emptyVolume = useCallback(
    async (name: string) => {
      if (!isHost) return;
      setVolumeBrowseError(null);
      setVolumeTransfer({ kind: "empty", volume: name, status: "running" });
      try {
        const emptied = await bridge.volumes.empty(name, dockerContextRef.current);
        setVolumeTransfer({
          kind: "empty",
          volume: name,
          status: "done",
          detail: [
            "Volume emptied; the volume itself was recreated.",
            ...emptied.limitations,
          ].join(" "),
        });
        await refreshVolumes();
      } catch (reason) {
        setVolumeTransfer(null);
        setVolumeBrowseError(
          reason instanceof Error ? reason.message : "Emptying the volume failed",
        );
      }
    },
    [bridge, isHost, refreshVolumes],
  );

  const restoreVolume = useCallback(
    async (name: string, archivePath: string, confirmedInUse = false) => {
      if (!isHost) return;
      setVolumeBrowseError(null);
      setVolumeTransfer({ kind: "restore", volume: name, status: "running" });
      try {
        await bridge.volumes.restore(
          name,
          archivePath,
          { confirmedInUse },
          dockerContextRef.current,
        );
        setVolumeTransfer({ kind: "restore", volume: name, status: "done" });
        if (browsedVolume === name) await browseVolume(name, "/");
        await refreshVolumes();
      } catch (reason) {
        setVolumeTransfer(null);
        const message =
          reason instanceof Error ? reason.message : "Volume restore failed";
        if (/volume_in_use|attached to a running container/iu.test(message)) {
          setVolumeInUseRestore({ archivePath, volume: name, message });
          return;
        }
        setVolumeBrowseError(message);
      }
    },
    [bridge, browseVolume, browsedVolume, isHost, refreshVolumes],
  );

  const dismissVolumeTransfer = useCallback(() => {
    setVolumeTransfer(null);
    setVolumeInUseRestore(null);
  }, []);

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
  /**
   * Scout analysis, recorded in the activity log because it is the longest-running thing here.
   *
   * The core admits one scan at a time through a semaphore, and Scout indexes an image the first
   * time it sees one — minutes of CPU and IO. Until this was logged, the only sign of that was a
   * disabled button on the screen that started it, so navigating away lost the job entirely.
   */
  /**
   * Shows a path in the operator's file manager.
   *
   * Failures land in the activity log rather than a screen-local error: the common ones are a
   * compose file on a remote context that does not exist on this machine, and a project whose
   * directory has since been moved — neither of which the screen that asked can explain.
   */
  const revealPath = useCallback(
    async (path: string) => {
      if (!isHost || !path) return;
      try {
        await bridge.desktop?.revealPath(path);
      } catch (reason) {
        recordActivity({
          id: `job:reveal:${path}:${Date.now()}`,
          kind: "job",
          state: "failed",
          title: "Could not show location",
          subject: path,
          detail: reason instanceof Error ? reason.message : "The desktop refused the path",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          read: false,
        });
      }
    },
    [bridge, isHost, recordActivity],
  );

  /**
   * Republishes a container's ports by replacing it.
   *
   * The result is recorded in the activity log rather than returned to a screen, because the
   * container the caller was looking at stops existing: its id changes, so the detail view it
   * came from is pointing at something that is gone. The new one is selected instead.
   */
  const rebindPorts = useCallback(
    async (id: string, ports: Record<string, string>) => {
      if (!isHost || !id) return;
      const activityId = `job:rebind:${id}:${Date.now()}`;
      recordActivity({
        id: activityId,
        kind: "job",
        state: "running",
        title: "Republish ports",
        subject: id.slice(0, 12),
        detail: "Docker fixes bindings at creation, so the container is being replaced.",
        startedAt: new Date().toISOString(),
        read: false,
      });
      try {
        const result = await bridge.containers.rebindPorts(
          id,
          ports,
          dockerContextRef.current,
        );
        patchActivity(activityId, {
          state: "succeeded",
          subject: result.name,
          detail: [`Replaced ${result.previousId.slice(0, 12)} with ${result.id.slice(0, 12)}`]
            .concat(result.warnings ?? [])
            .join(" · "),
          endedAt: new Date().toISOString(),
        });
        await refreshContainers();
        // The old id no longer resolves, so follow the replacement rather than leaving the
        // detail view pointed at a container that has been removed.
        await selectContainer(result.id);
      } catch (reason) {
        patchActivity(activityId, {
          state: "failed",
          detail:
            reason instanceof Error
              ? reason.message
              : "Republishing ports failed; the container was left as it was",
          endedAt: new Date().toISOString(),
        });
      }
    },
    [bridge, isHost, patchActivity, recordActivity, refreshContainers, selectContainer],
  );

  const analyzeImage = useCallback(
    async (reference: string) => {
      if (!isHost || !reference) return;
      setScoutPending(reference);
      setScoutError(null);
      const activityId = `job:scan:${reference}:${Date.now()}`;
      recordActivity({
        id: activityId,
        kind: "job",
        state: "running",
        title: "Security scan",
        subject: reference,
        detail: "Docker Scout indexes an image the first time it sees one, which can take minutes.",
        startedAt: new Date().toISOString(),
        read: false,
      });
      try {
        const result = await bridge.images.scout(
          reference,
          dockerContextRef.current,
        );
        setScoutByReference((current) => ({ ...current, [reference]: result }));
        // Scout reports severities in upper case (see ScanScreen's SEVERITIES). Reading them
        // in lower case silently yields 0 and would claim a clean image for every scan.
        const critical = result?.summary?.CRITICAL ?? 0;
        const high = result?.summary?.HIGH ?? 0;
        patchActivity(activityId, {
          state: "succeeded",
          detail:
            critical + high > 0
              ? `${critical} critical, ${high} high`
              : "No critical or high findings",
          endedAt: new Date().toISOString(),
        });
      } catch (reason) {
        const message =
          reason instanceof Error ? reason.message : "Image analysis failed";
        setScoutError(message);
        patchActivity(activityId, {
          state: "failed",
          detail: message,
          endedAt: new Date().toISOString(),
        });
      } finally {
        setScoutPending((current) => (current === reference ? null : current));
      }
    },
    [bridge, isHost, patchActivity, recordActivity],
  );

  /**
   * `docker push`: publishes an image to the registry its reference names.
   *
   * Anchorage never sees a credential. The Docker CLI resolves them from the operator's own
   * configuration and helpers, so nothing secret enters the renderer, crosses the IPC
   * boundary, or is stored here. When a registry is not authenticated, Docker says so in its
   * own output and the panel points at `docker login` rather than offering a password field.
   */
  const pushImage = useCallback(
    async (reference: string, registry: string) => {
      if (!isHost || !reference) return;
      await runTransferSession({
        kind: "image",
        title: "Push",
        reference: `${reference} → ${registry}`,
        failureMessage: "Image push failed",
        start: () =>
          bridge.images.action({
            context: dockerContextRef.current,
            action: "push",
            reference,
            confirmed: true,
            outputWindowBytes: 64 * 1024,
          }),
      });
    },
    [bridge, isHost, runTransferSession],
  );

  const pullRegistryImage = useCallback(
    async (name: string) => {
      if (!isHost) {
        setPulledRegistryImages((current) => new Set(current).add(name));
        return;
      }
      await runTransferSession({
        kind: "image",
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
    async (reference: string, archivePath: string, overwrite = false) => {
      if (!isHost) return;
      await runTransferSession({
        kind: "image",
        title: "Save",
        reference: `${reference} → ${archivePath}`,
        failureMessage: "Image save failed",
        start: () =>
          bridge.images.action({
            context: dockerContextRef.current,
            action: "save",
            reference,
            archivePath,
            ...(overwrite ? { overwrite: true } : {}),
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
        kind: "image",
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
    async (container: AnchorageContainer, archivePath: string, overwrite = false) => {
      if (!isHost) return;
      await runTransferSession({
        kind: "image",
        title: "Export",
        reference: `${container.name} → ${archivePath}`,
        failureMessage: "Container export failed",
        start: () =>
          bridge.containers.export(
            container.id,
            archivePath,
            { overwrite },
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

  /**
   * Fixture-only. Reachable only when there is no host bridge — the design mock and the
   * parity captures.
   *
   * Against a real engine this reported "engine restart queued" while queueing nothing: a
   * native Linux daemon has no CPU or memory allocation to change, so there was no request to
   * send. The Settings screen now routes a host to a pane that says so, and these remain to
   * keep the mock's behaviour intact rather than to be wired up later.
   */
  const applyResources = useCallback(() => {
    setAppliedResources({ ...resources });
    setResourceNotice("Resources applied · engine restart queued");
  }, [resources]);

  /**
   * Fixture-only, for the same reason: no flag here corresponds to something the host can
   * switch. Kubernetes and in-app updates do not exist on this build, and BuildKit and
   * emulation are properties of the host that the Advanced pane reports instead.
   */
  const toggleFeatureFlag = useCallback((key: keyof FeatureFlags) => {
    setFeatureFlags((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const setThemeFamily = useCallback(
    (family: ThemeFamily) => {
      if (captureAppearance) return;
      setAppearancePersistenceSucceeded(null);
      // `withFamily` carries the corner style to the new family's suggestion only while the
      // operator has not chosen one themselves; see theme/appearance.ts.
      setAppearance((current) => withFamily(current, family));
    },
    [captureAppearance],
  );

  const setCornerStyle = useCallback(
    (corners: CornerStyle) => {
      if (captureAppearance) return;
      setAppearancePersistenceSucceeded(null);
      // Recording the choice is what stops a later theme change from moving it back.
      setAppearance((current) => ({ ...current, corners, cornersChosen: true }));
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
    activities,
    rebindPorts,
    revealPath,
    unreadActivityCount,
    markActivitiesRead,
    dismissActivity,
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
    secretBusy,
    secretError,
    mcpReport,
    mcpCatalogDetail,
    mcpStatus,
    mcpError,
    mcpCatalogLoading,
    agentReport,
    agentsStatus,
    agentsError,
    capabilityInstalling,
    capabilityInstallError,
    capabilityInstalled,
    models,
    modelRunner,
    modelDisk,
    modelsStatus,
    modelsError,
    modelsBusy,
    modelSearchResults,
    modelSearchStatus,
    modelSearchError,
    builds: isHost ? [] : BUILD_FIXTURES,
    selectedBuild,
    settingsTab,
    resources,
    appliedResources,
    resourceNotice,
    featureFlags,
    themeFamily: effectiveAppearance.family,
    colorMode: effectiveAppearance.mode,
    cornerStyle: effectiveAppearance.corners,
    settingsReturnView,
    setCornerStyle,
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
    logSources,
    mergedLogLines,
    filteredLogLines,
    logStreamErrors,
    mergedLogFilter,
    setMergedLogFilter,
    toggleLogSource,
    clearMergedLogs,
    mergedLogSourceLimit: MERGED_LOG_SOURCE_LIMIT,
    engineHistory,
    composeProjects,
    composeConfigs,
    composeConfigPending,
    composeConfigError,
    loadComposeConfig,
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
    uploadVolumeFile,
    backupVolume,
    cloneVolume,
    emptyVolume,
    dismissVolumeError,
    restoreVolume,
    volumeTransfer,
    volumeInUseRestore,
    dismissVolumeTransfer,
    volumeInUseUpload,
    dismissVolumeInUseUpload,
    previewVolumeFile,
    closeVolumeBrowser,
    closeVolumePreview,
    buildRecords,
    buildBuilders,
    buildsStatus,
    buildsError,
    buildDetail,
    buildDetailError,
    selectedBuildRef,
    refreshBuilds,
    selectBuildRecord,
    runBuilderAction,
    builderActionPending,
    builderActionError,
    // The plugin installation, which the sidebar reads to decide which rows exist and every
    // capability screen reads to decide what it can offer.
    dockerVersions,
    enginePlugins,
    enginePluginsError,
    refreshEnginePlugins,
    pluginReport,
    pluginReportStatus,
    pluginReportError,
    pluginRepairPending,
    refreshPlugins,
    repairPlugin,
    revealedCapabilities,
    setCapabilityRevealed,
    secrets,
    secretsSwarm,
    secretsStatus,
    secretsError,
    secretsLimitations,
    refreshSecrets,
    composeProjectList,
    composeStatus,
    composeError,
    composeServices,
    expandedComposeProject,
    refreshCompose,
    toggleComposeProject,
    runComposeAction,
    pullRegistryImage,
    pushImage,
    saveImageArchive,
    loadImageArchive,
    exportContainerArchive,
    createVolume,
    removeVolume,
    pruneVolumes,
    setSelectedBuildId,
    retryEngine,
    refreshAgents,
    secretAction,
    refreshMcp,
    openMcpCatalog,
    closeMcpCatalog,
    installCapability,
    dismissCapabilityInstall,
    refreshModels,
    searchModels,
    clearModelSearch,
    modelAction,
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
