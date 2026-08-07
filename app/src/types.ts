/**
 * Every destination Anchorage serves.
 *
 * This list used to mirror the handoff's nav (Anchorage v2.dc.html:136-236) in full, on the
 * policy that a destination Anchorage cannot serve still deserves a row saying so — better a
 * stated limit than a silent absence. That was the right call while the alternative was
 * silence. It stopped being right once eleven of twenty-two rows led nowhere but an apology:
 * a nav that is half dead ends does not read as candour, it reads as an unfinished product,
 * and it buries the destinations that do work.
 *
 * So the rows that could never become real are gone rather than explained. Each was checked
 * against what Docker actually ships for a standalone Linux Engine, not against the handoff:
 *
 * - **Gordon** (`docker ai`) needs Docker Desktop 4.74+ and a signed-in account, and Docker
 *   publishes no standalone binary. Docker Agent covers the same ground and does ship one.
 * - **Sandboxes** (`sbx`) requires Ubuntu 24.04+, KVM and an OAuth sign-in, and is not a
 *   Docker Desktop pane either.
 * - **Cloud/Offload** is a managed cloud service behind a subscription.
 * - **Extensions** is a Docker Desktop-only framework. Ours rendered a marketplace of
 *   invented ratings and install counts, which is worse than having no screen.
 * - **Dev Environments** was removed from Docker Desktop in 4.42 and its repository archived.
 * - **Hardened images** is a Docker Hub catalogue with no API or CLI verb to enumerate it.
 * - **Governance** is administered in an admin console the engine cannot read back.
 * - **Kubernetes** needs cluster state Anchorage does not read; Desktop can offer a cluster
 *   only because it manages a VM.
 *
 * What remains is what a standalone Engine can actually be asked to do.
 */
export type ViewId =
  // Workspace
  | "dashboard"
  | "containers"
  | "compose"
  | "images"
  | "volumes"
  | "networks"
  | "builds"
  | "logs"
  // AI — each one a CLI plugin Docker publishes a Linux binary for
  | "models"
  | "agents"
  | "tools"
  // Security
  | "scan"
  | "secrets"
  // Platform
  | "settings";

export type ContainerState =
  | "created"
  | "running"
  | "paused"
  | "restarting"
  | "removing"
  | "exited"
  | "dead"
  | "stopped"
  | "pulling"
  | "unknown";
export type ContainerHealth = "healthy" | "unhealthy" | "—";
export type ImageTab = "local" | "registry";
export type BuildStatus = "success" | "failed" | "cancelled";
export type EngineStatus =
  | "loading"
  | "ready"
  | "disconnected"
  | "permission"
  | "error";
export type SettingsTab =
  | "appearance"
  | "resources"
  | "fileSharing"
  | "virtualisation"
  | "builders"
  | "engine"
  | "updates"
  | "advanced";
export type DetailTab =
  | "logs"
  | "inspect"
  | "mounts"
  | "exec"
  | "files"
  | "processes"
  | "changes"
  | "stats";

export interface LogLine {
  id: string;
  timestamp: string;
  level: "INFO" | "LOG" | "WARN" | "ERROR";
  message: string;
  /** Container name, when the line came from a merged multi-source stream. */
  source?: string;
}

export interface AnchorageContainer {
  id: string;
  name: string;
  image: string;
  ports: string;
  state: ContainerState;
  rawState: string;
  status: string;
  exitCode: number | null;
  kind: string;
  cpu: number | null;
  memory: number | null;
  memoryLimit: number | null;
  health: ContainerHealth;
  progress?: number;
  cpuHistory: number[];
  memoryHistory: number[];
  /** Docker labels. Compose projects are identified by com.docker.compose.project. */
  labels: Record<string, string>;
  /** Convenience projection of com.docker.compose.project. */
  composeProject: string | null;
}

export interface AnchorageImage {
  repository: string;
  tag: string;
  id: string;
  imageId: string;
  reference: string | null;
  identity: string;
  created: string;
  size: string;
  sizeMb: number;
  usageKnown: boolean;
  inUse: boolean;
  reclaimable: boolean;
}

export interface RegistryImage {
  name: string;
  official: boolean;
  description: string;
  stars: string;
  pulls: string;
  updated: string;
}

export interface AnchorageVolume {
  name: string;
  driver: string;
  size: string;
  usedBy: string | null;
  created: string;
  usageKnown: boolean;
  sizeBytes?: number;
  refCount?: number;
}

export interface EngineSummary {
  id?: string;
  name?: string;
  serverVersion?: string;
  apiVersion: string;
  minApiVersion?: string;
  osType?: string;
  operatingSystem?: string;
  architecture?: string;
  kernelVersion?: string;
  cpus: number;
  memoryBytes: number;
  containers: number;
  containersRunning: number;
  containersPaused: number;
  containersStopped: number;
  images: number;
  driver?: string;
  dockerRootDir?: string;
  experimental: boolean;
  liveRestoreEnabled: boolean;
  swarmState?: string;
  warnings: string[];
}

export interface VolumeProjection {
  name: string;
  driver: string;
  mountpoint?: string;
  createdAt?: string;
  scope?: string;
  labels: Record<string, string>;
  options: Record<string, string>;
  status?: Record<string, unknown>;
  usage?: { sizeBytes: number; refCount: number };
  labelsText?: string;
  sizeDisplay?: string;
}

export interface DiskUsageCategory {
  totalCount: number;
  activeCount: number;
  sizeBytes: number;
  /** Deduplicated across shared layers; never recompute by summing per-record sizes. */
  reclaimableBytes: number;
}

export interface SystemDiskUsageSummary {
  images: DiskUsageCategory;
  containers: DiskUsageCategory;
  volumes: DiskUsageCategory;
  buildCache: DiskUsageCategory;
}

export interface SystemSnapshot {
  context: string;
  source: "engine-api";
  apiVersion: string;
  engine: EngineSummary;
  diskUsage: {
    layersSizeBytes: number;
    builderSizeBytes: number;
    images: Array<{
      id: string;
      repoTags: string[];
      repoDigests: string[];
      created: number;
      sizeBytes: number;
      sharedBytes: number;
      virtualBytes: number;
      containers: number;
    }>;
    containers: Array<{
      id: string;
      image: string;
      imageId: string;
      names: string[];
      created: number;
      writableBytes: number;
      rootFsBytes: number;
      state: string;
      status: string;
    }>;
    volumes: VolumeProjection[];
    buildCache: Array<{
      id: string;
      parents: string[];
      inUse: boolean;
      shared: boolean;
      sizeBytes: number;
      usageCount: number;
      [key: string]: unknown;
    }>;
    /** Authoritative `docker system df` aggregates. */
    summary: SystemDiskUsageSummary;
  };
  observedAt: string;
  endpointHash: string;
  limitations: string[];
}

export interface ContainerMountProjection {
  type?: string;
  name?: string;
  source?: string;
  destination?: string;
  driver?: string;
  mode?: string;
  rw: boolean;
  propagation?: string;
}

export interface ContainerInspectResult {
  context: string;
  source: "engine-api" | "cli-json";
  apiVersion?: string;
  container: {
    id: string;
    name: string;
    created?: string;
    path?: string;
    args: string[];
    imageId?: string;
    driver?: string;
    platform?: string;
    restartCount: number;
    logPath?: string;
    state: {
      status?: string;
      running: boolean;
      paused: boolean;
      restarting: boolean;
      oomKilled: boolean;
      dead: boolean;
      pid: number;
      exitCode: number;
      error?: string;
      startedAt?: string;
      finishedAt?: string;
      health?: string;
    };
    image?: string;
    hostname?: string;
    user?: string;
    workingDir?: string;
    entrypoint: string[];
    command: string[];
    environment: string[];
    labels: Record<string, string>;
    mounts: ContainerMountProjection[];
    ports: Record<string, Array<{ hostIp?: string; hostPort?: string }>>;
    networks: Record<
      string,
      {
        networkId?: string;
        endpointId?: string;
        gateway?: string;
        ipAddress?: string;
        macAddress?: string;
      }
    >;
  };
  document: unknown;
  observedAt: string;
  endpointHash?: string;
}

export interface ContainerStatsResult {
  context: string;
  source: "engine-api";
  apiVersion: string;
  containerId: string;
  readAt?: string;
  cpuPercent: number;
  cpuUsageTotal: number;
  cpuUsageDelta: number;
  systemUsageDelta: number;
  onlineCpus: number;
  memoryUsageBytes: number;
  memoryWorkingSetBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
  document: unknown;
  observedAt: string;
  endpointHash: string;
}

export interface ImageProjection {
  id: string;
  parentId?: string;
  repoTags: string[];
  repoDigests: string[];
  created: number;
  sizeBytes: number;
  sharedBytes: number;
  virtualBytes: number;
  containers?: number;
  labels: Record<string, string>;
  sizeDisplay?: string;
  createdDisplay?: string;
}

export interface ImagesListResult {
  context: string;
  source: "engine-api" | "cli-json";
  apiVersion?: string;
  images: ImageProjection[];
  observedAt: string;
  endpointHash?: string;
  limitations: string[];
}

export interface ImageLayer {
  id?: string;
  created: number;
  createdBy?: string;
  sizeBytes: number;
  comment?: string;
  tags: string[];
  /** Metadata-only history entry that contributes no size. */
  emptyLayer: boolean;
}

export interface ImageDetail {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  parent?: string;
  comment?: string;
  created?: string;
  dockerVersion?: string;
  author?: string;
  architecture?: string;
  os?: string;
  sizeBytes: number;
  labels: Record<string, string>;
  env: string[];
  entrypoint: string[];
  command: string[];
  workingDir?: string;
  exposedPorts: string[];
  rootFsLayers: string[];
}

export interface ImagesInspectResult {
  context: string;
  source: "engine-api";
  image: ImageDetail;
  history: ImageLayer[];
  document: unknown;
  observedAt: string;
}

export interface RegistryImageResult {
  name: string;
  description: string;
  stars: number;
  official: boolean;
}

export interface ImagesSearchResult {
  context: string;
  term: string;
  results: RegistryImageResult[];
  observedAt: string;
}

export interface ContainersCommitResult {
  context: string;
  imageId: string;
  receipt: Record<string, unknown>;
  observedAt: string;
}

export type ImagesActionParams =
  | {
      context: string;
      action: "remove";
      id: string;
      /** Omit to remove by immutable ID — dangling images have no tag. */
      reference?: string;
      confirmed: true;
      force?: boolean;
      noPrune?: boolean;
    }
  | {
      context: string;
      action: "prune";
      confirmed: true;
      filters?: Record<string, string[]>;
    }
  | {
      context: string;
      action: "pull";
      reference: string;
      cwd?: string;
      timeoutSeconds?: number;
      outputWindowBytes?: number;
      maxOutputBytes?: number;
    }
  | {
      context: string;
      /** Publishes to the registry named by the reference; credentials stay with Docker. */
      action: "push";
      reference: string;
      confirmed: true;
      timeoutSeconds?: number;
      outputWindowBytes?: number;
    }
  | {
      context: string;
      action: "tag";
      /** Full immutable image ID — a tag can be re-pointed between render and action. */
      id: string;
      /** The new reference, `repository[:tag]`. */
      reference: string;
    }
  | {
      context: string;
      /**
       * `save` writes an image to a host tar; `load` reads one back. Both run as sessions,
       * because a saved image is routinely gigabytes and must never cross the RPC boundary.
       */
      action: "save" | "load";
      /** Required for `save`; `load` learns its images from the archive. */
      reference?: string;
      /** Explicit agreement to replace an existing file; `--output` truncates silently. */
      overwrite?: boolean;
      /** Absolute host path; the core checks its parent against the command allowlist. */
      archivePath: string;
      cwd?: string;
      timeoutSeconds?: number;
      outputWindowBytes?: number;
      maxOutputBytes?: number;
    };

export interface ImagesActionResult {
  action: "remove" | "prune" | "pull" | "save" | "load" | "tag" | "push";
  receipt: Record<string, unknown>;
  /**
   * The daemon's own accounting for a prune, which is the only correct one: summing the sizes
   * of the removed images double-counts every layer more than one of them shared.
   */
  prune?: {
    imagesDeleted: { deleted?: string; untagged?: string }[];
    spaceReclaimedBytes: number;
  };
  session?: SessionStartResult;
  /** Where a push is going, derived from the reference. */
  registry?: string;
  [key: string]: unknown;
}

/** `docker export`: the container's filesystem as a flat tar, written to a host file. */
export interface ContainersExportResult {
  action: "export";
  receipt: Record<string, unknown>;
  session?: SessionStartResult;
  [key: string]: unknown;
}

export interface VolumesListResult {
  context: string;
  source: "engine-api" | "cli-json";
  apiVersion?: string;
  volumes: VolumeProjection[];
  warnings: string[];
  observedAt: string;
  endpointHash?: string;
  limitations: string[];
}

export type VolumesActionParams =
  | {
      context: string;
      action: "create";
      name: string;
      driver?: string;
      driverOpts?: Record<string, string>;
      labels?: Record<string, string>;
    }
  | {
      context: string;
      action: "remove";
      name: string;
      confirmed: true;
      force?: boolean;
    }
  | {
      context: string;
      action: "prune";
      confirmed: true;
      filters?: Record<string, string[]>;
    };

export interface AnchorageBuild {
  id: string;
  name: string;
  status: BuildStatus;
  duration: string;
  meta: string;
  cache: string;
  context: string;
  layers: string;
  output: string;
}

export interface BuildStep {
  command: string;
  cached: boolean;
  duration: string;
}

export interface DashboardActivity {
  id: string;
  tone: "accent" | "violet" | "danger" | "muted" | "warning";
  text: string;
  time: string;
}

export interface DiskUsageItem {
  id: string;
  label: string;
  size: string;
  percent: number;
  detail: string;
  tone: "accent" | "warning" | "violet" | "blue";
}

export interface EngineResources {
  cpus: number;
  memoryGb: number;
  swapGb: number;
  diskGb: number;
}

export interface FeatureFlags {
  automaticUpdates: boolean;
  betaChannel: boolean;
  buildkit: boolean;
  binaryEmulation: boolean;
  telemetry: boolean;
}

export interface ContainerFileEntry {
  name: string;
  path: string;
  sizeBytes: number;
  mode: string;
  modifiedAt?: string;
  isDir: boolean;
  /** Present for symlinks. */
  linkTarget?: string;
}

export interface ContainerFilesResult {
  context: string;
  source: "engine-api";
  path: string;
  entries: ContainerFileEntry[];
  /** The listing hit its entry cap; the directory holds more. */
  truncated: boolean;
  observedAt: string;
  limitations: string[];
}

export interface ContainerFileReadResult {
  context: string;
  path: string;
  sizeBytes: number;
  encoding: "utf-8" | "base64";
  content: string;
  truncated: boolean;
  observedAt: string;
}

export interface ContainerFileWriteResult {
  context: string;
  path: string;
  sizeBytes: number;
  observedAt: string;
}

export interface ContainerTopResult {
  context: string;
  titles: string[];
  processes: Array<{ values: string[] }>;
  observedAt: string;
}

export interface ContainerDiffResult {
  context: string;
  changes: Array<{ path: string; kind: "modified" | "added" | "deleted" | "unknown" }>;
  observedAt: string;
}

export type ContainerAction =
  | "start"
  | "stop"
  | "restart"
  | "remove"
  | "pause"
  | "unpause"
  | "kill"
  | "rename"
  | "update";

/** Docker's own `docker rm` options. Both are implemented end-to-end below the renderer. */
/** A structured `docker run` — validated fields, never arbitrary argv. */
export interface ContainerCreateOptions {
  image: string;
  name?: string;
  command?: string[];
  env?: string[];
  ports?: Record<string, string>;
  binds?: string[];
  labels?: Record<string, string>;
  restartPolicy?: "no" | "always" | "unless-stopped" | "on-failure";
  network?: string;
  autoRemove?: boolean;
  start?: boolean;
}

export interface ContainerCreateResult {
  context: string;
  id: string;
  warnings: string[];
  started: boolean;
}

export interface ContainerRemoveOptions {
  /** `docker rm --force`: remove a running container by killing it first. */
  force?: boolean;
  /** `docker rm --volumes`: also remove anonymous volumes attached to the container. */
  volumes?: boolean;
}

export interface ContainerOperations {
  list(context?: string): Promise<AnchorageContainer[]>;
  start(id: string, context?: string): Promise<AnchorageContainer | void>;
  stop(id: string, context?: string): Promise<AnchorageContainer | void>;
  restart(id: string, context?: string): Promise<AnchorageContainer | void>;
  pause(id: string, context?: string): Promise<AnchorageContainer | void>;
  rename(id: string, name: string, context?: string): Promise<void>;
  update(
    id: string,
    limits: {
      cpuShares?: number;
      memoryBytes?: number;
      restartPolicy?: "no" | "always" | "unless-stopped" | "on-failure";
    },
    context?: string,
  ): Promise<void>;
  unpause(id: string, context?: string): Promise<AnchorageContainer | void>;
  /**
   * Republishes ports by replacing the container.
   *
   * Docker fixes bindings at creation and `docker update` cannot change them, so this is not an
   * edit: the container is recreated from its own definition with new bindings, and the result
   * says what that could not carry over. The core refuses unless the container is stopped or
   * paused.
   */
  rebindPorts(
    id: string,
    ports: Record<string, string>,
    context?: string,
  ): Promise<ContainerRebindPortsResult>;
  kill(
    id: string,
    context?: string,
    signal?: string,
  ): Promise<AnchorageContainer | void>;
  remove(
    id: string,
    context?: string,
    options?: ContainerRemoveOptions,
  ): Promise<void>;
  create(
    options: ContainerCreateOptions,
    context?: string,
  ): Promise<ContainerCreateResult>;
  logs(id: string, context?: string): Promise<LogLine[]>;
  inspect(id: string, context?: string): Promise<ContainerInspectResult>;
  stats(id: string, context?: string): Promise<ContainerStatsResult>;
  files(id: string, path: string, context?: string): Promise<ContainerFilesResult>;
  fileRead(
    id: string,
    path: string,
    context?: string,
  ): Promise<ContainerFileReadResult>;
  fileWrite(
    id: string,
    path: string,
    name: string,
    content: string,
    context?: string,
  ): Promise<ContainerFileWriteResult>;
  commit(
    id: string,
    options: { repository: string; tag?: string; comment?: string; pause?: boolean },
    context?: string,
  ): Promise<ContainersCommitResult>;
  /** Starts a session that writes the container's filesystem to `archivePath`. */
  export(
    id: string,
    archivePath: string,
    options?: { overwrite?: boolean },
    context?: string,
  ): Promise<ContainersExportResult>;
  top(id: string, context?: string): Promise<ContainerTopResult>;
  diff(id: string, context?: string): Promise<ContainerDiffResult>;
  /** Samples several containers at once so the list can show live CPU and memory. */
  statsBatch(
    ids: string[],
    context?: string,
  ): Promise<Array<{ id: string; stats?: ContainerStatsResult }>>;
  subscribe?(
    listener: (containers: AnchorageContainer[]) => void,
  ): void | (() => void);
}

/** Mirrors Docker's own `docker image ls` switches. */
export interface ImageListOptions {
  /** `docker image ls --all`: include intermediate layers. */
  all?: boolean;
  /** Include untagged (dangling) images. Docker's own default is to show them. */
  includeDangling?: boolean;
}

/** `docker system prune`, reported per resource rather than as one opaque total. */
export interface SystemPruneStage {
  resource: "containers" | "networks" | "images" | "build-cache" | "volumes";
  deleted: string[];
  spaceReclaimedBytes: number;
  error?: string;
}

export interface SystemActionResult {
  context: string;
  action: "prune";
  source: "engine-api";
  stages: SystemPruneStage[];
  spaceReclaimedBytes: number;
  receipt: Record<string, unknown>;
  observedAt: string;
}

export interface SystemPruneOptions {
  /** `--all`: also remove unused images that still carry tags. */
  all?: boolean;
  /** `--volumes`: also remove unused volumes. Volume data is unrecoverable. */
  volumes?: boolean;
}

export interface ImagesOperations {
  list(context: string, options?: ImageListOptions): Promise<ImagesListResult>;
  inspect(id: string, context?: string): Promise<ImagesInspectResult>;
  search(term: string, context?: string): Promise<ImagesSearchResult>;
  action(params: ImagesActionParams): Promise<ImagesActionResult>;
  /** Never called automatically: the first analysis of an image indexes it. */
  scout(reference: string, context?: string): Promise<ImagesScoutResult>;
}

export interface NetworkSummary {
  id: string;
  name: string;
  driver: string;
  scope?: string;
  created?: string;
  internal: boolean;
  attachable: boolean;
  ingress: boolean;
  enableIpv6: boolean;
  ipamDriver?: string;
  subnets: string[];
  gateways: string[];
  labels: Record<string, string>;
  options: Record<string, string>;
  /** bridge, host and none cannot be removed; Docker rejects the attempt. */
  predefined: boolean;
  /** -1 when the transport cannot report attachments. */
  containerCount: number;
}

export interface NetworksListResult {
  context: string;
  source: "engine-api" | "cli-json";
  apiVersion?: string;
  networks: NetworkSummary[];
  observedAt: string;
  endpointHash?: string;
  limitations: string[];
}

export type NetworksActionParams =
  | {
      context: string;
      action: "create";
      name: string;
      driver?: string;
      subnet?: string;
      gateway?: string;
      internal?: boolean;
      attachable?: boolean;
      enableIpv6?: boolean;
      labels?: Record<string, string>;
      options?: Record<string, string>;
    }
  | { context: string; action: "remove"; id: string; confirmed: true }
  | {
      context: string;
      action: "prune";
      confirmed: true;
      filters?: Record<string, string[]>;
    }
  | {
      context: string;
      action: "connect" | "disconnect";
      id: string;
      containerId: string;
      force?: boolean;
    };

export interface NetworksActionResult {
  action: "create" | "remove" | "prune" | "connect" | "disconnect";
  receipt: Record<string, unknown>;
  network?: NetworkSummary;
  prune?: { networksDeleted: string[] };
}

export interface NetworksOperations {
  list(context: string): Promise<NetworksListResult>;
  action(params: NetworksActionParams): Promise<NetworksActionResult>;
}

/**
 * Whether the Swarm secret store answered, and why not when it did not.
 *
 * Docker refuses every Swarm endpoint on a node that is not a manager, which is the ordinary
 * state of a desktop engine. A manager holding no secrets and an engine with no secret store
 * are different facts, and the screen has to be able to say which one it is looking at.
 */
export interface SwarmSurface {
  manager: boolean;
  /** Docker's Swarm.LocalNodeState, or "unknown" when the transport could not report it. */
  nodeState: string;
  /** The engine's or the CLI's own words for the refusal. */
  reason?: string;
}

/**
 * A reference to a secret, never a secret.
 *
 * Docker discards the plaintext once a secret exists: no API call and no CLI command reads
 * it back, and only the containers it is granted to ever see it. There is no field here that
 * could hold one and no verb that could fetch one.
 */
export interface SecretSummary {
  id: string;
  name: string;
  /** An external secret driver, when one holds the value instead of Swarm's own store. */
  driver?: string;
  /** RFC3339, from the Engine transport only. */
  createdAt?: string;
  updatedAt?: string;
  /** Swarm's object index, which every update increments. */
  version?: number;
  labels: Record<string, string>;
  /** The CLI transport formats times relative to now and joins labels into one string. */
  createdDisplay?: string;
  updatedDisplay?: string;
  labelsText?: string;
}

export interface SecretsListResult {
  context: string;
  source: "engine-api" | "cli-json";
  apiVersion?: string;
  swarm: SwarmSurface;
  secrets: SecretSummary[];
  observedAt: string;
  endpointHash?: string;
  limitations: string[];
}

/** Read-only on purpose: no inspect, because there is no value; no writes, by scope. */
/**
 * `create` takes the raw bytes and base64-encodes them at the bridge. The value goes to the
 * Engine API in a JSON body and is never placed in argv, never logged, and never returned —
 * Docker gives metadata back only, so a secret is write-once from here.
 */
export interface SecretsActionRequest {
  context?: string;
  action: "create" | "remove";
  name?: string;
  value?: string;
  id?: string;
  confirmed?: true;
}

export interface SecretsActionResult {
  protocolVersion: "1";
  context: string;
  action: "create" | "remove";
  id?: string;
  name?: string;
  receipt: Record<string, unknown>;
  observedAt: string;
}

export interface SecretsOperations {
  list(context?: string): Promise<SecretsListResult>;
  create(name: string, value: string, context?: string): Promise<SecretsActionResult>;
  remove(id: string, context?: string): Promise<SecretsActionResult>;
}

export interface VolumesOperations {
  list(context: string): Promise<VolumesListResult>;
  action(params: VolumesActionParams): Promise<Record<string, unknown>>;
  /** Lists a directory inside the volume. Paths are relative to the volume root. */
  files(name: string, path: string, context?: string): Promise<VolumeFilesResult>;
  fileRead(
    name: string,
    path: string,
    context?: string,
  ): Promise<VolumeFileReadResult>;
  /** Uploads one file into the volume. `confirmedInUse` acknowledges a live container. */
  fileWrite(
    name: string,
    request: {
      path: string;
      fileName: string;
      content: string;
      confirmedInUse?: boolean;
    },
    context?: string,
  ): Promise<VolumeFileWriteResult>;
  /** Streams the whole volume to a host tar rooted at its own contents. */
  backup(
    name: string,
    archivePath: string,
    options?: { overwrite?: boolean },
    context?: string,
  ): Promise<VolumeBackupResult>;
  /** Extracts a backup tar back into the volume, overwriting what is there. */
  restore(
    name: string,
    archivePath: string,
    options?: { confirmedInUse?: boolean },
    context?: string,
  ): Promise<VolumeRestoreResult>;
  /** Copies the volume into a new one; the target must not already exist. */
  clone(
    name: string,
    target: string,
    context?: string,
  ): Promise<VolumeCloneResult>;
  /** Discards the volume's contents. Destructive, and the volume is recreated to do it. */
  empty(name: string, context?: string): Promise<VolumeEmptyResult>;
}

export interface CliRunParams {
  context: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  interactive?: boolean;
  streaming?: boolean;
}

export interface ReconciliationEvent {
  event: "reconciliation.requested" | "reconciliation.required";
  payload: {
    operationId: string;
    context: string;
    domain: "container" | "image" | "volume";
    resourceId?: string;
    action: string;
    reason: "mutation_completed" | "mutation_outcome_unknown";
  };
}

export interface CoreStatusEvent {
  event: "core.status";
  payload: {
    state: string;
    [key: string]: unknown;
  };
}

export type HostLifecycleEvent = ReconciliationEvent | CoreStatusEvent;
export type WindowAction = "minimize" | "maximize" | "close";

export type Availability =
  | "available"
  | "unavailable"
  | "degraded"
  | "unknown";

export interface DockerContext {
  name: string;
  description?: string;
  dockerEndpoint?: string;
  current: boolean;
  error?: string;
}

export interface CommandEvidence {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface CommandNode {
  /** Docker arguments only; the executable is deliberately excluded. */
  path: string[];
  name: string;
  description?: string;
  kind: "root" | "builtin" | "plugin" | "plugin-command";
  status: Availability;
  reason: string;
  transports: string[];
  pluginRoot?: string;
  usage?: string;
  evidence: CommandEvidence;
  subcommands: CommandNode[];
  capabilities?: Record<string, boolean>;
  metadata?: Record<string, string>;
}

export interface CommandInventory {
  root: CommandNode;
  nodeCount: number;
  complete: boolean;
  limitReached: boolean;
  maxDepth: number;
  discoveredAt: string;
  warnings: string[];
}

export interface SystemCapabilities {
  protocolVersion: "1";
  selectedContext?: string;
  currentContext?: string;
  contexts: DockerContext[];
  commandInventory: CommandInventory;
  warnings: string[];
  observedAt: string;
}

/**
 * What a launch needs to know before it can read anything.
 *
 * Carries no command inventory and no plugin capabilities, because the verb behind it does not
 * look for them. Anything that needs those asks `capabilities` and waits for the walk.
 */
/** One side of `docker version`. Absent fields mean the read did not answer, never zero. */
export interface DockerVersionSide {
  version?: string;
  apiVersion?: string;
  minApiVersion?: string;
  goVersion?: string;
  gitCommit?: string;
  os?: string;
  arch?: string;
}

export interface DockerVersions {
  client: DockerVersionSide;
  server: DockerVersionSide;
}

export interface SystemContexts {
  protocolVersion: "1";
  selectedContext?: string;
  currentContext?: string;
  contexts: DockerContext[];
  /**
   * Both sides of `docker version`. The Engine API cannot supply the client half — `/version`
   * describes the daemon — so this is the only place a client/server skew is visible.
   */
  versions: DockerVersions;
  warnings: string[];
  observedAt: string;
}

/**
 * The CLI plugin installation, as the Docker CLI sees it.
 *
 * `plugins` holds both what the CLI loaded and what it skipped. The skipped entries are the
 * reason this exists: `docker info` omits them, so a link with no target is invisible from
 * the CLI — the command simply prints root help as though it were misspelled.
 */
/** How this machine installs software, detected locally by the core. */
export interface HostPackageManager {
  name: "pacman" | "apt-get" | "dnf" | "zypper" | "apk";
  /** An AUR helper, where one is installed. pacman alone cannot install an AUR package. */
  helper?: string;
}

export interface SystemPlugins {
  protocolVersion: "1";
  plugins: DockerCliPlugin[];
  /** Directories searched, in the CLI's own order. */
  searchPath: string[];
  /** Absent when the host runs a manager the core does not recognise. */
  packageManager?: HostPackageManager;
  warnings: string[];
  observedAt: string;
}

/** `broken` means the installation is faulty, not that a capability is unavailable. */
export type DockerCliPluginStatus =
  | "available"
  | "unavailable"
  | "degraded"
  | "unknown"
  | "broken";

/**
 * Why the CLI skipped an entry, as a value rather than as prose.
 *
 * `availabilityNote` says the same thing in the operator's words and is free to be reworded.
 * This decides which repair a surface may offer, and that decision must not be made by matching
 * on English: `dangling-link` can only be removed, `not-executable` is the one fault a `chmod`
 * fixes, and `handshake` is a version mismatch that needs a reinstall rather than anything local.
 */
export type PluginFault =
  | "dangling-link"
  | "unreadable"
  | "not-executable"
  | "handshake";

export interface DockerCliPlugin {
  name: string;
  version?: string;
  vendor?: string;
  description?: string;
  path?: string;
  status: DockerCliPluginStatus;
  fault?: PluginFault;
  discoverySource: string;
  availabilityNote?: string;
}

/**
 * Repairing a faulty plugin entry.
 *
 * There is no install action here, and its absence is structural rather than unfinished work:
 * the core has no HTTP client, Electron blocks every download, and nothing in the protocol can
 * execute a binary other than the fingerprinted Docker CLI. Installing a capability is therefore
 * something the operator does, which the surface makes as easy as it can — the exact command,
 * the directory, and a re-check — while these two verbs clear up what a previous install left
 * behind.
 */
export interface PluginRepair {
  context?: string;
  /** Plugin command name, without the `docker-` file prefix. */
  name: string;
  path: string;
  /** `remove` unlinks the entry; `enable` adds the execute bit the CLI requires. */
  action: "remove" | "enable";
  /** Required for remove, which deletes a file on this machine. */
  confirmed?: true;
}

export interface PluginRepairResult {
  name: string;
  path: string;
  action: "remove" | "enable";
  outcome: "removed" | "enabled";
  /** The re-read installation: enabling one plugin can change what the CLI loads elsewhere. */
  plugins: SystemPlugins;
  observedAt: string;
}

export type SessionMode = "pipes" | "pty";
export type SessionTargetMode = "pinned" | "literal";
export type SessionSignal =
  | "interrupt"
  | "terminate"
  | "kill"
  | "hangup"
  | "quit";

export interface SessionStartParams {
  context: string;
  targetMode?: SessionTargetMode;
  /** Docker arguments only. Each array item is one literal argument. */
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  mode: SessionMode;
  rows?: number;
  cols?: number;
  timeoutSeconds?: number;
  outputWindowBytes?: number;
  maxOutputBytes?: number;
}

export interface SessionStartResult {
  sessionId: string;
  mode: SessionMode;
  targetMode?: SessionTargetMode;
  pid: number;
  context: string;
  executable: string;
  argv: string[];
  cwd: string;
  rows?: number;
  cols?: number;
  outputWindowBytes: number;
  maxOutputBytes: number;
  startedAt: string;
}

export interface SessionInputParams {
  sessionId: string;
  data?: string;
  encoding?: "utf-8" | "base64";
  eof?: boolean;
}

export interface SessionResizeParams {
  sessionId: string;
  rows: number;
  cols: number;
}

export interface SessionCancelParams {
  sessionId: string;
  gracePeriodMs?: number;
}

export interface SessionAckParams {
  sessionId: string;
  throughSequence: number;
}

export interface SessionStartedPayload extends SessionStartResult {
  state: "running";
}

export interface SessionOutputPayload {
  sessionId: string;
  sequence: number;
  stream: "stdout" | "stderr" | "pty";
  data: string;
  encoding: "utf-8" | "base64";
  bytes: number;
}

export interface SessionOutputTruncatedPayload {
  sessionId: string;
  maxOutputBytes: number;
  droppedBytes: number;
}

export interface SessionExitedPayload {
  sessionId: string;
  state: "exited";
  exitCode: number;
  signal?: string;
  timedOut: boolean;
  canceled: boolean;
  startedAt: string;
  exitedAt: string;
  durationMs: number;
  output: {
    stdoutBytes: number;
    stderrBytes: number;
    ptyBytes: number;
    emittedBytes: number;
    droppedBytes: number;
    truncated: boolean;
    lastSequence: number;
  };
}

export interface SessionErrorPayload {
  sessionId: string;
  code: string;
  message: string;
  stream?: "stdout" | "stderr" | "pty";
}

export type SessionEvent =
  | { event: "session.started"; payload: SessionStartedPayload }
  | { event: "session.output"; payload: SessionOutputPayload }
  | {
      event: "session.output.truncated";
      payload: SessionOutputTruncatedPayload;
    }
  | { event: "session.exited"; payload: SessionExitedPayload }
  | { event: "session.error"; payload: SessionErrorPayload };

export interface SessionOperations {
  start(params: SessionStartParams): Promise<SessionStartResult>;
  input(params: SessionInputParams): Promise<unknown>;
  resize(params: SessionResizeParams): Promise<unknown>;
  signal(params: {
    sessionId: string;
    signal: SessionSignal;
  }): Promise<unknown>;
  cancel(params: SessionCancelParams): Promise<unknown>;
  ack(params: SessionAckParams): Promise<unknown>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}

export interface AnchorageBridge {
  readonly mode: "host" | "fixture";
  readonly containers: ContainerOperations;
  readonly system: {
    capabilities(context?: string): Promise<SystemCapabilities>;
    contexts(context?: string): Promise<SystemContexts>;
    plugins(context?: string): Promise<SystemPlugins>;
    /**
     * Repairs one faulty plugin entry. Installs nothing — see PluginRepair for why that is a
     * property of the architecture rather than a gap.
     */
    pluginAction(request: PluginRepair): Promise<PluginRepairResult>;
    snapshot(context: string, includeDiskUsage?: boolean): Promise<SystemSnapshot>;
    prune(
      context: string,
      options?: SystemPruneOptions,
    ): Promise<SystemActionResult>;
  };
  /**
   * Desktop integration. Reveal only: the main process never calls `shell.openPath`, so a path
   * that came from a Docker daemon can be shown but never launched.
   */
  readonly desktop?: {
    revealPath(path: string): Promise<{ revealed: string }>;
  };
  readonly images: ImagesOperations;
  readonly compose: ComposeOperations;
  readonly enginePlugins: EnginePluginOperations;
  readonly builds: BuildsOperations;
  readonly models: ModelsOperations;
  readonly agents: AgentsOperations;
  readonly mcp: MCPOperations;
  readonly capabilities: CapabilityOperations;
  readonly volumes: VolumesOperations;
  readonly networks: NetworksOperations;
  readonly secrets: SecretsOperations;
  readonly cli: {
    run(params: CliRunParams): Promise<unknown>;
  };
  readonly sessions: SessionOperations;
  readonly events: {
    subscribe(listener: (event: HostLifecycleEvent) => void): () => void;
  };
  windowAction(action: WindowAction): Promise<boolean | void>;
  windowIsMaximized(): Promise<boolean>;
  subscribeWindowMaximized(listener: (maximized: boolean) => void): () => void;
  setWindowBackgroundColor(color: string): Promise<void>;
}

export interface HostContainersApi {
  list: (request: {
    context: string;
    all: boolean;
  }) => Promise<unknown>;
  action: (request: {
    context: string;
    id: string;
    action: ContainerAction;
    options?: {
      timeoutSeconds?: number;
      force?: boolean;
      volumes?: boolean;
      confirmed?: boolean;
      signal?: string;
      name?: string;
      cpuShares?: number;
      memoryBytes?: number;
      restartPolicy?: string;
    };
  }) => Promise<unknown>;
  create?: (
    request: { context: string } & ContainerCreateOptions,
  ) => Promise<unknown>;
  commit?: (request: {
    context: string;
    id: string;
    repository: string;
    tag?: string;
    comment?: string;
    pause?: boolean;
  }) => Promise<unknown>;
  export?: (request: {
    context: string;
    id: string;
    archivePath: string;
    overwrite?: boolean;
    cwd?: string;
    timeoutSeconds?: number;
    outputWindowBytes?: number;
  }) => Promise<unknown>;
  inspect?: (request: { context: string; id: string }) => Promise<unknown>;
  stats?: (request: { context: string; id: string }) => Promise<unknown>;
  statsBatch?: (request: {
    context: string;
    ids: string[];
  }) => Promise<unknown>;
  files?: (request: {
    context: string;
    id: string;
    path?: string;
  }) => Promise<unknown>;
  fileRead?: (request: {
    context: string;
    id: string;
    path: string;
  }) => Promise<unknown>;
  fileWrite?: (request: {
    context: string;
    id: string;
    path: string;
    name: string;
    content: string;
  }) => Promise<unknown>;
  top?: (request: { context: string; id: string }) => Promise<unknown>;
  diff?: (request: { context: string; id: string }) => Promise<unknown>;
}

export interface HostAnchorageApi {
  containers?: HostContainersApi;
  invoke?: (method: string, payload?: unknown) => Promise<unknown>;
  system?: {
    capabilities: (request?: { context?: string }) => Promise<unknown>;
    contexts?: (request?: { context?: string }) => Promise<unknown>;
    plugins?: (request?: { context?: string }) => Promise<unknown>;
    pluginAction?: (request: PluginRepair) => Promise<unknown>;
    snapshot?: (request: {
      context: string;
      includeDiskUsage?: boolean;
    }) => Promise<unknown>;
    action?: (request: {
      context: string;
      action: "prune";
      all?: boolean;
      volumes?: boolean;
      confirmed: true;
    }) => Promise<unknown>;
  };
  plugins?: {
    list: (request: { context: string }) => Promise<unknown>;
  };
  builds?: {
    list: (request: { context: string }) => Promise<unknown>;
    inspect: (request: { context: string; ref: string }) => Promise<unknown>;
    builderAction?: (request: BuilderAction) => Promise<unknown>;
  };
  capabilities?: {
    install: (request: {
      capability: string;
      confirmed: true;
    }) => Promise<unknown>;
  };
  agents?: {
    list: (request: { context: string }) => Promise<unknown>;
  };
  mcp?: {
    list: (request: { context: string }) => Promise<unknown>;
    catalog: (request: {
      context: string;
      reference: string;
    }) => Promise<unknown>;
  };
  models?: {
    list: (request: { context: string }) => Promise<unknown>;
    chat?: (request: ModelsChatRequest) => Promise<unknown>;
    search: (request: Record<string, unknown>) => Promise<unknown>;
    action?: (request: ModelActionRequest) => Promise<unknown>;
  };
  compose?: {
    list: (request: { context: string; all?: boolean }) => Promise<unknown>;
    ps: (request: { context: string; project: string }) => Promise<unknown>;
    config?: (request: {
      context: string;
      project: string;
      configFiles: string[];
    }) => Promise<unknown>;
    action: (request: ComposeActionParams) => Promise<unknown>;
  };
  images?: {
    list: (request: { context: string; all?: boolean }) => Promise<unknown>;
    action: (request: ImagesActionParams) => Promise<unknown>;
    inspect?: (request: { context: string; id: string }) => Promise<unknown>;
    search?: (request: {
      context: string;
      term: string;
      limit?: number;
    }) => Promise<unknown>;
    scout?: (request: {
      context: string;
      reference: string;
    }) => Promise<unknown>;
  };
  networks?: {
    list: (request: { context: string }) => Promise<unknown>;
    action: (request: NetworksActionParams) => Promise<unknown>;
  };
  secrets?: {
    list: (request: { context: string }) => Promise<unknown>;
    action?: (request: SecretsActionRequest) => Promise<unknown>;
  };
  volumes?: {
    list: (request: { context: string }) => Promise<unknown>;
    action: (request: VolumesActionParams) => Promise<unknown>;
    files?: (request: {
      context: string;
      name: string;
      path?: string;
    }) => Promise<unknown>;
    fileRead?: (request: {
      context: string;
      name: string;
      path: string;
    }) => Promise<unknown>;
    fileWrite?: (request: {
      context: string;
      name: string;
      path: string;
      fileName: string;
      content: string;
      confirmedInUse?: boolean;
    }) => Promise<unknown>;
    backup?: (request: {
      context: string;
      name: string;
      archivePath: string;
      overwrite?: boolean;
    }) => Promise<unknown>;
    restore?: (request: {
      context: string;
      name: string;
      archivePath: string;
      confirmed: true;
      confirmedInUse?: boolean;
    }) => Promise<unknown>;
    clone?: (request: {
      context: string;
      name: string;
      target: string;
    }) => Promise<unknown>;
    empty?: (request: {
      context: string;
      name: string;
      confirmed: true;
    }) => Promise<unknown>;
  };
  cli?: {
    run: (request: {
      context: string;
      argv: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeoutSeconds?: number;
      interactive?: boolean;
      streaming?: boolean;
    }) => Promise<unknown>;
  };
  session?: {
    start: (request: SessionStartParams) => Promise<unknown>;
    input: (request: SessionInputParams) => Promise<unknown>;
    resize: (request: SessionResizeParams) => Promise<unknown>;
    signal: (request: {
      sessionId: string;
      signal: SessionSignal;
    }) => Promise<unknown>;
    cancel: (request: SessionCancelParams) => Promise<unknown>;
    ack: (request: SessionAckParams) => Promise<unknown>;
  };
  subscribe?: (
    event: string,
    listener: (payload: unknown) => void,
  ) => void | (() => void);
  window?: {
    minimize?: () => Promise<unknown> | unknown;
    maximize?: () => Promise<unknown> | unknown;
    close?: () => Promise<unknown> | unknown;
    isMaximized?: () => Promise<unknown> | unknown;
    setBackgroundColor?: (color: string) => Promise<unknown> | unknown;
  };
}

declare global {
  interface Window {
    anchorage?: HostAnchorageApi;
  }
}

/**
 * Compose is a CLI plugin with no Engine API, so every compose call is CLI-routed. The plugin
 * frames `ls` as an array and `ps` as one object per line; the core normalizes both.
 */
export interface ComposeStateCount {
  state: string;
  /** -1 when the core could not parse a count from Compose's wording. */
  count: number;
}

export interface ComposeProject {
  name: string;
  status: string;
  states: ComposeStateCount[];
  /** Required to run `up`; the other verbs find the project by label. */
  configFiles: string[];
  runningCount: number;
  totalCount: number;
}

export interface ComposeListResult {
  context: string;
  source: "cli-json";
  projects: ComposeProject[];
  observedAt: string;
  limitations: string[];
}

export interface ComposeService {
  name: string;
  service: string;
  containerId: string;
  image: string;
  state: string;
  status: string;
  health?: string;
  exitCode: number;
  ports?: string;
}

export interface ComposePsResult {
  context: string;
  project: string;
  source: "cli-json";
  services: ComposeService[];
  observedAt: string;
  limitations: string[];
}

export type ComposeAction = "up" | "down" | "start" | "stop" | "restart";

export type ComposeActionParams =
  | {
      context: string;
      project: string;
      action: "up";
      configFiles: string[];
      removeOrphans?: boolean;
      timeoutSeconds?: number;
      outputWindowBytes?: number;
    }
  | {
      context: string;
      project: string;
      action: "down";
      confirmed: true;
      /** Destroying named volumes is not reversible, so it takes its own agreement. */
      removeVolumes?: boolean;
      confirmedRemoveVolumes?: boolean;
      removeOrphans?: boolean;
      timeoutSeconds?: number;
      outputWindowBytes?: number;
    }
  | {
      context: string;
      project: string;
      action: "start" | "stop" | "restart";
      timeoutSeconds?: number;
      outputWindowBytes?: number;
    };

export interface ComposeActionResult {
  action: ComposeAction;
  project: string;
  receipt: Record<string, unknown>;
  session?: SessionStartResult;
  [key: string]: unknown;
}

/**
 * A compose action without the context, which the store supplies.
 *
 * Written distributively: a plain `Omit<ComposeActionParams, "context">` collapses the union
 * into one object type and loses the per-action rules — `up` requiring files, `down`
 * requiring confirmation — that the whole type exists to express.
 */
export type ComposeActionInput = ComposeActionParams extends infer Variant
  ? Variant extends { context: string }
    ? Omit<Variant, "context">
    : never
  : never;

/**
 * The resolved compose file, projected. Compose merges `include` before it renders, so an
 * included service appears inline and the include entries themselves are not reported; the
 * result's `limitations` names that and anything else the rendering does not carry.
 */
export interface ComposeDependsOn {
  service: string;
  /** `service_started`, `service_healthy` or `service_completed_successfully`. */
  condition: string;
  restart?: boolean;
  /** False means Compose starts the service even when the dependency is absent. */
  required: boolean;
}

export interface ComposeWatchRule {
  path: string;
  action: string;
  target?: string;
  ignore?: string[];
  include?: string[];
  /** The argv an `exec` rule runs after syncing. */
  command?: string[];
}

export interface ComposeLifecycleHook {
  phase: "post_start" | "pre_stop";
  command: string[];
  /** The hook's own user, or the service's where the hook names none. */
  user?: string;
  /** True only where a declared user resolves to root; an unstated one is never assumed. */
  runsAsRoot: boolean;
  privileged?: boolean;
  workingDir?: string;
}

export interface ComposeConfigService {
  name: string;
  image?: string;
  /** A service with a profile does not start unless that profile is selected. */
  profiles?: string[];
  /** The wave Compose starts it in: 0 when it waits for nothing. */
  startOrder: number;
  dependsOn: ComposeDependsOn[];
  watch: ComposeWatchRule[];
  hooks: ComposeLifecycleHook[];
}

export interface ComposeDeclaredDependency {
  kind: "model" | "provider" | "secret" | "volume";
  name: string;
  /** What Compose resolves it to: a volume or secret's Docker name, a provider's type. */
  resource?: string;
  external?: boolean;
  services: string[];
}

export interface ComposeConfigResult {
  context: string;
  project: string;
  source: "cli-json";
  configFiles: string[];
  /** Ordered by start order, then by name. */
  services: ComposeConfigService[];
  dependencies: ComposeDeclaredDependency[];
  observedAt: string;
  limitations: string[];
}

export interface ComposeOperations {
  list(context: string, all?: boolean): Promise<ComposeListResult>;
  ps(project: string, context?: string): Promise<ComposePsResult>;
  /** Resolves the project's own files; Compose cannot render a project by label alone. */
  config(
    project: string,
    configFiles: string[],
    context?: string,
  ): Promise<ComposeConfigResult>;
  action(params: ComposeActionParams): Promise<ComposeActionResult>;
}

/**
 * Volume browsing mounts the volume read-only into a helper container that is created and
 * never started, then reads it through the same archive endpoint the container file browser
 * uses. Entry paths are relative to the volume root, never the helper's mount point.
 */
export interface VolumeFilesResult {
  context: string;
  volume: string;
  source: "engine-api";
  path: string;
  entries: ContainerFileEntry[];
  truncated: boolean;
  observedAt: string;
  limitations: string[];
}

export interface VolumeFileReadResult {
  context: string;
  volume: string;
  path: string;
  sizeBytes: number;
  encoding: "utf-8" | "base64";
  content: string;
  truncated: boolean;
  observedAt: string;
}

/**
 * Docker Scout is an optional CLI plugin with no Engine API. The core projects its SARIF so
 * the renderer never parses SARIF itself.
 */
export interface ScoutFinding {
  id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNSPECIFIED";
  score?: number;
  package?: string;
  installedVersion?: string;
  affectedVersion?: string;
  /** Scout reports the literal string "not fixed" when no upgrade resolves the CVE. */
  fixedVersion?: string;
  url?: string;
}

export interface ImagesScoutResult {
  context: string;
  reference: string;
  source: "cli-sarif";
  scanner?: string;
  summary: Record<string, number>;
  total: number;
  findings: ScoutFinding[];
  observedAt: string;
  limitations: string[];
}

export interface VolumeFileWriteResult {
  context: string;
  volume: string;
  path: string;
  sizeBytes: number;
  observedAt: string;
}

export interface VolumeBackupResult {
  context: string;
  volume: string;
  archivePath: string;
  entries: number;
  sizeBytes: number;
  observedAt: string;
}

export interface VolumeRestoreResult {
  context: string;
  volume: string;
  archivePath: string;
  observedAt: string;
}

/**
 * Docker has no clone or empty verb. A clone streams the source's contents through the same
 * never-started helper the browser uses into a helper on the new volume. Emptying cannot work
 * that way — the archive endpoint writes files but cannot delete them — so the volume is
 * removed and recreated from its own declaration, which is what `recreated` reports.
 */
export interface VolumeCloneResult {
  context: string;
  volume: string;
  target: string;
  entries: number;
  sizeBytes: number;
  observedAt: string;
  limitations: string[];
}

export interface VolumeEmptyResult {
  context: string;
  volume: string;
  recreated?: VolumeProjection;
  observedAt: string;
  limitations: string[];
}

/**
 * Buildx is an optional CLI plugin with no Engine API. `history ls` reports a reference as
 * `builder/node/id` while `history inspect` accepts only the bare id, so a record carries
 * both and the core resolves between them.
 */
export interface BuildBuilderNode {
  name: string;
  status: string;
  version?: string;
  platforms: string[];
}

export interface BuildBuilder {
  name: string;
  driver: string;
  current: boolean;
  /** Buildx's own note about a builder it could not reach. */
  error?: string;
  nodes: BuildBuilderNode[];
}

export interface BuildRecord {
  id: string;
  ref: string;
  name: string;
  status: "success" | "failed" | "cancelled" | "running" | "unknown";
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
  totalSteps: number;
  completedSteps: number;
  cachedSteps: number;
}

export interface BuildsListResult {
  context: string;
  source: "cli-json";
  builders: BuildBuilder[];
  records: BuildRecord[];
  observedAt: string;
  limitations: string[];
}

export interface BuildsInspectResult {
  context: string;
  id: string;
  name: string;
  buildContext?: string;
  dockerfile?: string;
  vcsRepository?: string;
  vcsRevision?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  status: BuildRecord["status"];
  totalSteps: number;
  cachedSteps: number;
  completedSteps: number;
  materials: string[];
  observedAt: string;
}

/**
 * A plugin the daemon runs, as opposed to one the CLI shells out to.
 *
 * `DockerCliPlugin` above is the other subsystem entirely — an executable in a plugin directory.
 * These are containers providing volume, network, log, IPAM, metrics and authz drivers, and the
 * privileges each holds were granted once at `docker plugin install` and shown nowhere since.
 */
export interface EnginePluginPrivileges {
  network?: string;
  capabilities: string[];
  allowAllDevices: boolean;
  /** Host mounts as `source:destination`. */
  mounts: string[];
  devices: string[];
}

export interface EnginePlugin {
  id: string;
  name: string;
  enabled: boolean;
  reference?: string;
  description?: string;
  documentation?: string;
  /** e.g. `docker.volumedriver/1.0`. */
  interfaces: string[];
  privileges: EnginePluginPrivileges;
}

export interface EnginePluginsList {
  context: string;
  apiVersion?: string;
  plugins: EnginePlugin[];
  observedAt: string;
}

export interface EnginePluginOperations {
  list(context: string): Promise<EnginePluginsList>;
}

/* ── Docker Model Runner ─────────────────────────────────────────────────────────────────── */

/**
 * One model on this machine, from `docker model ls --json`.
 *
 * The size, parameter count and quantization arrive as display strings — "256.35 MiB",
 * "361.82 M", "IQ2_XXS/Q4_K_M" — and are shown as Docker printed them. Re-deriving numbers
 * from them would put a figure on screen that disagrees with `docker model ls` for no benefit,
 * since nothing computes with them.
 */
export interface DockerModel {
  /** The manifest digest, `sha256:…`. */
  id: string;
  /** Every reference pointing at this model; empty once it has been untagged. */
  tags: string[];
  /** What `docker model run` and `docker model rm` accept: first tag, else the digest. */
  reference: string;
  created?: string;
  format?: string;
  quantization?: string;
  parameters?: string;
  architecture?: string;
  size?: string;
  contextSize?: number;
}

/**
 * One row of `docker model status`. A backend that is not installed is shown rather than
 * hidden: "mlx — Not Installed — only supported on Apple Silicon" tells a Linux operator
 * something true, where an absent row would read as a missing feature.
 */
export interface ModelBackend {
  name: string;
  status: string;
  detail?: string;
}

export interface ModelRunnerStatus {
  /** Taken from the runner's own sentence, never inferred from a backend row. */
  running: boolean;
  reported?: string;
  backends: ModelBackend[];
}

export interface ModelDiskUsage {
  label: string;
  size: string;
}

/** A function the model asked for. `arguments` is a JSON document as a string, as on the wire. */
export interface ChatToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on a tool result, naming the call it answers. */
  tool_call_id?: string;
  name?: string;
  tool_calls?: ChatToolCall[];
}

/** `parameters` is a JSON Schema, relayed verbatim: re-encoding one changes it by accident. */
export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelsChatRequest {
  context: string;
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  temperature?: number;
}

export interface ModelsChatResult {
  protocolVersion: string;
  context: string;
  model: string;
  message: ChatMessage;
  /** `stop` when the model finished, `tool_calls` when it is waiting on the caller. */
  finishReason?: string;
  usage: ChatUsage;
  observedAt: string;
}

export interface ModelsListResult {
  protocolVersion: "1";
  context: string;
  models: DockerModel[];
  /**
   * Both are best-effort: they come from column-aligned text with no JSON option, so a table
   * Docker reformats leaves these empty rather than taking the model list down with it.
   */
  runner: ModelRunnerStatus;
  disk: ModelDiskUsage[];
  observedAt: string;
}

export interface ModelSearchResult {
  /** What to show. A Hugging Face hit is returned under its own repository name. */
  name: string;
  /**
   * What to pull. Not always `name`: `docker model pull` resolves an unqualified name against
   * Docker Hub, so a Hugging Face hit needs the `hf.co/` prefix or it fails as "does not exist".
   * The core derives it, because which registry a hit came from is something the search knows
   * and a screen assembling registry references is one that will eventually assemble a wrong one.
   */
  reference: string;
  description?: string;
  downloads?: number;
  stars?: number;
  source?: string;
  official?: boolean;
  updatedAt?: string;
  backend?: string;
  /** A real byte count, unlike the display strings on DockerModel. */
  sizeBytes?: number;
}

export interface ModelsSearchResult {
  protocolVersion: "1";
  context: string;
  query?: string;
  results: ModelSearchResult[];
  observedAt: string;
}

export type ModelAction = "pull" | "remove" | "unload";

export interface ModelActionRequest {
  context?: string;
  action: ModelAction;
  /** Required for pull and remove; omitting it on unload evicts every loaded model. */
  reference?: string;
  /**
   * Pull only, and pull streams. The core holds this many bytes of unacknowledged output
   * before it stops writing, so a caller that does not follow and acknowledge the session
   * stalls the download once the window fills.
   */
  outputWindowBytes?: number;
}

export interface ModelActionResult {
  action: ModelAction;
  receipt: Record<string, unknown>;
  /** Present for pull alone, which streams; followed through session events. */
  session?: SessionStartResult;
}

/** What Anchorage can fetch and install itself. An enum, never a URL — see the core's table. */
export type InstallableCapability = "agent" | "mcp";

export interface CapabilityInstallResult {
  protocolVersion: "1";
  capability: string;
  plugin: string;
  path: string;
  repository: string;
  release: string;
  asset: string;
  sha256: string;
  /**
   * The digest the release published, which the download was verified against. Differs from
   * `sha256` for an archive, because the published digest covers the tarball rather than the
   * binary inside it.
   */
  assetSha256: string;
  sizeBytes: number;
  installedAt: string;
}

export interface CapabilityOperations {
  install(capability: InstallableCapability): Promise<CapabilityInstallResult>;
}

export interface AgentModel {
  provider: string;
  model: string;
  default?: boolean;
}

export interface AgentToolset {
  type: string;
  summary?: string;
  docs?: string;
}

/**
 * `configured` reports what is visible to the Anchorage process, not what exists on the
 * machine. Docker Agent reads credentials from environment variables, so a key exported in a
 * shell profile is invisible to an app launched from a desktop entry — the screen says that
 * rather than reporting the key as absent.
 */
export interface AgentProvider {
  provider: string;
  credentials: string[];
  configured: boolean;
}

export interface AgentsListResult {
  protocolVersion: "1";
  context: string;
  models: AgentModel[];
  toolsets: AgentToolset[];
  providers: AgentProvider[];
  configPath?: string;
  configStatus?: string;
  telemetryDisabled: boolean;
  observedAt: string;
}

export interface MCPCatalog {
  reference: string;
  digest?: string;
  title?: string;
}

export interface MCPProfile {
  id: string;
  title?: string;
}

export interface MCPTool {
  name: string;
  description?: string;
}

/** One catalogue entry: a container that would grant an agent a set of tools. */
export interface MCPServer {
  name: string;
  title?: string;
  description?: string;
  image?: string;
  category?: string;
  tags: string[];
  license?: string;
  owner?: string;
  githubStars?: number;
  /** What this server could do once enabled — the disclosure the screen exists to make. */
  tools: MCPTool[];
  toolCount: number;
  toolsTruncated?: boolean;
  /** Environment variables the server demands before it will run. */
  secrets: string[];
}

export interface MCPListResult {
  protocolVersion: "1";
  context: string;
  catalogs: MCPCatalog[];
  profiles: MCPProfile[];
  observedAt: string;
}

export interface MCPCatalogResult {
  protocolVersion: "1";
  context: string;
  reference: string;
  source?: string;
  title?: string;
  digest?: string;
  servers: MCPServer[];
  serverCount: number;
  truncated?: boolean;
  observedAt: string;
}

export interface MCPOperations {
  list(context?: string): Promise<MCPListResult>;
  catalog(reference: string, context?: string): Promise<MCPCatalogResult>;
}

export interface AgentsOperations {
  list(context?: string): Promise<AgentsListResult>;
}

export interface ModelsOperations {
  list(context?: string): Promise<ModelsListResult>;
  /**
   * One turn. The caller owns the conversation and the tool loop: the core forwards the
   * request and returns the answer, and never calls a tool itself.
   */
  chat(request: ModelsChatRequest): Promise<ModelsChatResult>;
  search(
    query?: string,
    source?: "docker-hub" | "huggingface" | "all",
    context?: string,
  ): Promise<ModelsSearchResult>;
  action(request: ModelActionRequest): Promise<ModelActionResult>;
}

export interface BuildsOperations {
  list(context?: string): Promise<BuildsListResult>;
  inspect(ref: string, context?: string): Promise<BuildsInspectResult>;
  builderAction(request: BuilderAction): Promise<BuilderActionResult>;
}

/**
 * One of buildx's own builder verbs.
 *
 * `bootstrap` starts the builder's node, which is the repair for the unreachable builder the
 * table used to report and do nothing about. `remove` deletes the entry and its cache, which is
 * the only remedy when the driver behind it is gone for good.
 *
 * Switching the active builder is deliberately not here: `docker buildx use` rewrites the CLI
 * configuration every tool on the machine reads, which the builders pane says out loud.
 */
export interface BuilderAction {
  context: string;
  name: string;
  /**
   * `remove` is `buildx rm`. `remove-context` is `docker context rm`, which is the only verb
   * that clears a builder buildx synthesised from a Docker context — `buildx rm` refuses those.
   */
  action: "remove" | "bootstrap" | "remove-context";
  /** Required for either removal: neither the cache nor the context definition survives it. */
  confirmed?: true;
}

export interface BuilderActionResult {
  context: string;
  name: string;
  action: "remove" | "bootstrap" | "remove-context";
  outcome: "removed" | "bootstrapped" | "context-removed";
  /** What buildx printed. A failure is only explicable in its own terms. */
  output?: string;
  /** The builders that remain: removing the current one promotes another. */
  builders: BuildBuilder[];
  observedAt: string;
}


export interface ContainerRebindPortsResult {
  context: string;
  /** The container that was replaced. It no longer exists. */
  previousId: string;
  id: string;
  name: string;
  warnings: string[];
  /** What recreating could not carry over, in the operator's terms. */
  discarded: string[];
  observedAt: string;
}
