/**
 * Anchorage Core protocol v1.
 *
 * This file is the renderer/main-process source of truth. The core rejects
 * unknown request and parameter fields; do not silently translate zero values.
 */

export type RequestId = string | number;
export type DockerTargetMode = "pinned" | "literal";

export interface RPCError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type RPCResponse<T> =
  | { id: RequestId; result: T; error?: never }
  | { id: RequestId; result?: never; error: RPCError };

export interface RPCEvent<T = unknown> {
  event: string;
  payload: T;
}

export interface HealthRequest {
  id: RequestId;
  method: "health";
  params?: Record<string, never>;
}

export interface SystemCapabilitiesRequest {
  id: RequestId;
  method: "system.capabilities";
  params?: { context?: string };
}

export interface SystemSnapshotRequest {
  id: RequestId;
  method: "system.snapshot";
  params: {
    context: string;
    /**
     * Request `/system/df`. Opt-in because it is a full daemon-side disk walk; only the
     * dashboard displays it.
     */
    includeDiskUsage?: boolean;
  };
}

/**
 * `docker system prune`. The Engine exposes no single endpoint for this, so the core issues
 * one prune per resource in Docker's own order and reports each stage separately.
 */
export interface SystemActionRequest {
  id: RequestId;
  method: "system.action";
  params: {
    context: string;
    action: "prune";
    /** `--all`: also remove unused images that still carry tags. */
    all?: boolean;
    /** `--volumes`: also remove unused volumes. Volume data is unrecoverable. */
    volumes?: boolean;
    confirmed: true;
  };
}

export interface SystemPruneStage {
  resource: "containers" | "networks" | "images" | "build-cache" | "volumes";
  deleted: string[];
  spaceReclaimedBytes: number;
  /** Set when this stage failed; earlier stages have already mutated the daemon. */
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

export interface ContainersListRequest {
  id: RequestId;
  method: "containers.list";
  params: { context: string; all?: boolean };
}

export interface ContainerInspectRequest {
  id: RequestId;
  method: "containers.inspect";
  params: {
    context: string;
    /** Full, immutable 64-character hexadecimal ID; prefixes are rejected. */
    id: string;
  };
}

export interface ContainerStatsRequest {
  id: RequestId;
  method: "containers.stats";
  params: {
    context: string;
    /** Full, immutable 64-character hexadecimal ID; prefixes are rejected. */
    id: string;
  };
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

export type ContainersActionParams =
  | {
      context: string;
      id: string;
      action: "start";
    }
  | {
      context: string;
      id: string;
      action: "stop" | "restart";
      options?: { timeoutSeconds?: number };
    }
  | {
      context: string;
      id: string;
      /** `pause`/`unpause` take no options. */
      action: "pause" | "unpause";
    }
  | {
      context: string;
      id: string;
      action: "kill";
      /** Uppercase signal name or number; omit for Docker's default SIGKILL. */
      options?: { signal?: string };
    }
  | {
      context: string;
      id: string;
      action: "rename";
      options: { name: string };
    }
  | {
      context: string;
      id: string;
      action: "update";
      options: {
        cpuShares?: number;
        memoryBytes?: number;
        restartPolicy?: "no" | "always" | "unless-stopped" | "on-failure";
      };
    }
  | {
      context: string;
      id: string;
      action: "remove";
      options: {
        confirmed: true;
        force?: boolean;
        volumes?: boolean;
      };
    };

/** Samples several containers in one request so the list can show live CPU and memory. */
export interface ContainersStatsBatchRequest {
  id: RequestId;
  method: "containers.statsBatch";
  params: {
    context: string;
    /** Full immutable 64-hex IDs, at most 64, no duplicates. */
    ids: string[];
  };
}

export interface ContainerStatsSample {
  id: string;
  /** Exactly one of stats or error is present. */
  stats?: ContainerStatsResult;
  error?: { code: string; message: string };
}

export interface ContainersStatsBatchResult {
  context: string;
  source: "engine-api";
  samples: ContainerStatsSample[];
  observedAt: string;
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

export interface ContainerFilesRequest {
  id: RequestId;
  method: "containers.files";
  params: { context: string; id: string; path?: string };
}

export interface ContainerFileReadRequest {
  id: RequestId;
  method: "containers.fileRead";
  params: { context: string; id: string; path: string };
}

export interface ContainerFileWriteRequest {
  id: RequestId;
  method: "containers.fileWrite";
  params: {
    context: string;
    id: string;
    /** Directory inside the container to extract into. */
    path: string;
    /** A single path segment; separators and traversal are rejected. */
    name: string;
    /** Base64-encoded contents. */
    content: string;
    mode?: number;
  };
}

export interface ContainerFileWriteResult {
  context: string;
  path: string;
  sizeBytes: number;
  observedAt: string;
}

export interface ContainerTopRequest {
  id: RequestId;
  method: "containers.top";
  params: { context: string; id: string };
}

export interface ContainerDiffRequest {
  id: RequestId;
  method: "containers.diff";
  params: { context: string; id: string };
}

export interface ContainersActionRequest {
  id: RequestId;
  method: "containers.action";
  /** Every variant requires a full immutable 64-character hexadecimal ID. */
  params: ContainersActionParams;
}

/** A structured `docker run`: validated fields, never arbitrary argv. */
export interface ContainersCreateRequest {
  id: RequestId;
  method: "containers.create";
  params: {
    context: string;
    image: string;
    name?: string;
    command?: string[];
    /** KEY=VALUE entries, matching Docker. */
    env?: string[];
    /** Host port -> container port, e.g. { "8080": "80/tcp" }. */
    ports?: Record<string, string>;
    /** Docker mount specs, e.g. "/host:/container:ro". */
    binds?: string[];
    labels?: Record<string, string>;
    restartPolicy?: "no" | "always" | "unless-stopped" | "on-failure";
    network?: string;
    autoRemove?: boolean;
    start?: boolean;
  };
}

export interface ContainersCreateResult {
  context: string;
  id: string;
  warnings: string[];
  started: boolean;
  receipt: Record<string, unknown>;
}

export interface ImagesListRequest {
  id: RequestId;
  method: "images.list";
  params: {
    context: string;
    all?: boolean;
    /** Include dangling images without changing Docker's `all` semantics. */
    includeDangling?: boolean;
  };
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

export interface ImagesInspectRequest {
  id: RequestId;
  method: "images.inspect";
  params: {
    context: string;
    /** Full immutable sha256:<64 hex> image ID. */
    id: string;
  };
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

export interface ImagesSearchRequest {
  id: RequestId;
  method: "images.search";
  params: { context: string; term: string; limit?: number };
}

export interface ContainersCommitRequest {
  id: RequestId;
  method: "containers.commit";
  params: {
    context: string;
    id: string;
    repository: string;
    tag?: string;
    comment?: string;
    author?: string;
    pause?: boolean;
    changes?: string[];
  };
}

export type ImageAction =
  | "remove"
  | "prune"
  | "pull"
  | "save"
  | "load"
  | "tag"
  | "push";

export type ImagesActionParams =
  | {
      context: string;
      action: "remove";
      /** Full immutable sha256:<64 hex> image ID. */
      id: string;
      /**
       * Exact user-selected tag/digest, verified to still resolve to `id` before deletion.
       * Omit to remove the image by immutable ID: a dangling image has no tag, and an ID
       * cannot be re-pointed, so no re-resolution is required.
       */
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
      /** Passed to Docker as one literal argv element. */
      reference: string;
      cwd?: string;
      timeoutSeconds?: number;
      outputWindowBytes?: number;
      maxOutputBytes?: number;
    }
  | {
      context: string;
      /**
       * Publishes to the registry named by the reference. Credentials are never handled by
       * Anchorage: the Docker CLI resolves them from the operator's own configuration.
       */
      action: "push";
      reference: string;
      /** Publishing cannot be undone, so it is confirmed like any destructive verb. */
      confirmed: true;
      timeoutSeconds?: number;
      outputWindowBytes?: number;
      maxOutputBytes?: number;
    }
  | {
      context: string;
      action: "tag";
      /**
       * Full immutable image ID. A tag can be moved between the list being rendered and the
       * operator acting on it, so the source is never named by tag.
       */
      id: string;
      /** The new reference, `repository[:tag]`. */
      reference: string;
    }
  | {
      context: string;
      /**
       * `save` writes an image to a host tar; `load` reads one back. Both run as sessions
       * using Docker's own -o/-i file handling, because a saved image is routinely gigabytes
       * and must never transit the JSON transport.
       */
      action: "save" | "load";
      /** Required for `save` (what to write); `load` learns the images from the archive. */
      reference?: string;
      /**
       * Explicit agreement to replace a file that already exists. Docker's `--output`
       * truncates, so without this a save that names an existing file destroys it silently.
       */
      overwrite?: boolean;
      /**
       * Absolute host path. The core canonicalizes its *parent* against the same allowlist
       * that governs command working directories, so an archive can never be written
       * somewhere the command surface itself could not reach.
       */
      archivePath: string;
      cwd?: string;
      timeoutSeconds?: number;
      outputWindowBytes?: number;
      maxOutputBytes?: number;
    };

export interface ImagesActionRequest {
  id: RequestId;
  method: "images.action";
  params: ImagesActionParams;
}

/**
 * `docker export`: a container's filesystem as a flat tar, written straight to a host file.
 * Distinct from image save, which preserves layers and metadata.
 */
export interface ContainersExportRequest {
  id: RequestId;
  method: "containers.export";
  params: {
    context: string;
    id: string;
    archivePath: string;
    overwrite?: boolean;
    cwd?: string;
    timeoutSeconds?: number;
    outputWindowBytes?: number;
  };
}

export interface VolumesListRequest {
  id: RequestId;
  method: "volumes.list";
  params: { context: string };
}

export type VolumeAction = "create" | "remove" | "prune";

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

export interface VolumesActionRequest {
  id: RequestId;
  method: "volumes.action";
  params: VolumesActionParams;
}

/** One row of `docker network ls`. */
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
  /** -1 when the transport cannot report attachments (the list endpoint never does). */
  containerCount: number;
}

export interface NetworksListRequest {
  id: RequestId;
  method: "networks.list";
  params: { context: string };
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

export type NetworkAction =
  | "create"
  | "remove"
  | "prune"
  | "connect"
  | "disconnect";

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
  | {
      context: string;
      action: "remove";
      /** 12-64 character hexadecimal network ID. */
      id: string;
      confirmed: true;
    }
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
      /** Full immutable 64-character container ID. */
      containerId: string;
      force?: boolean;
    };

export interface NetworksActionRequest {
  id: RequestId;
  method: "networks.action";
  params: NetworksActionParams;
}

export interface NetworksActionResult {
  action: NetworkAction;
  receipt: Record<string, unknown>;
  network?: NetworkSummary;
  prune?: { networksDeleted: string[] };
}

export interface CLIRunRequest {
  id: RequestId;
  method: "cli.run";
  params: {
    context: string;
    /**
     * `pinned` injects context and rejects Docker target overrides.
     * `literal` preserves target/config/TLS argv and environment selection.
     */
    targetMode?: DockerTargetMode;
    /** Docker arguments only. Never include the docker executable. */
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutSeconds?: number;
    /** Reserved in v1; true returns unsupported_mode. */
    interactive?: boolean;
    /** Reserved in v1; true returns unsupported_mode. */
    streaming?: boolean;
  };
}

export interface SessionStartRequest {
  id: RequestId;
  method: "session.start";
  params: {
    context: string;
    /**
     * `pinned` injects context and rejects Docker target overrides.
     * `literal` preserves target/config/TLS argv and environment selection.
     */
    targetMode?: DockerTargetMode;
    /** Docker arguments only. The exact resolved executable is fixed by core. */
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    mode: "pipes" | "pty";
    rows?: number;
    cols?: number;
    timeoutSeconds?: number;
    /** Raw, unacknowledged output bytes permitted in flight. */
    outputWindowBytes?: number;
    /** Zero/omitted means unlimited lifetime output; ACK backpressure still applies. */
    maxOutputBytes?: number;
  };
}

export interface SessionInputRequest {
  id: RequestId;
  method: "session.input";
  params: {
    sessionId: string;
    data?: string;
    encoding?: "utf-8" | "base64";
    /** Closes pipe stdin, or sends the terminal EOT byte to a PTY. */
    eof?: boolean;
  };
}

export interface SessionResizeRequest {
  id: RequestId;
  method: "session.resize";
  params: { sessionId: string; rows: number; cols: number };
}

export type SessionSignal = "interrupt" | "terminate" | "kill" | "hangup" | "quit";

export interface SessionSignalRequest {
  id: RequestId;
  method: "session.signal";
  params: { sessionId: string; signal: SessionSignal };
}

export interface SessionCancelRequest {
  id: RequestId;
  method: "session.cancel";
  params: { sessionId: string; gracePeriodMs?: number };
}

export interface SessionAckRequest {
  id: RequestId;
  method: "session.ack";
  params: {
    sessionId: string;
    /** Release every pending output event up to and including this sequence. */
    throughSequence: number;
  };
}

export type RPCRequest =
  | HealthRequest
  | SystemCapabilitiesRequest
  | SystemSnapshotRequest
  | SystemActionRequest
  | ContainersListRequest
  | ContainerInspectRequest
  | ContainerStatsRequest
  | ContainersStatsBatchRequest
  | ContainerFilesRequest
  | ContainerFileReadRequest
  | ContainerFileWriteRequest
  | ContainerTopRequest
  | ContainerDiffRequest
  | ContainersActionRequest
  | ContainersCreateRequest
  | ContainersExportRequest
  | ComposeListRequest
  | ComposePsRequest
  | ComposeActionRequest
  | VolumeFilesRequest
  | VolumeFileReadRequest
  | ImagesScoutRequest
  | VolumeFileWriteRequest
  | ImagesListRequest
  | ImagesActionRequest
  | ImagesInspectRequest
  | ImagesSearchRequest
  | ContainersCommitRequest
  | VolumesListRequest
  | VolumesActionRequest
  | NetworksListRequest
  | NetworksActionRequest
  | CLIRunRequest
  | SessionStartRequest
  | SessionInputRequest
  | SessionResizeRequest
  | SessionSignalRequest
  | SessionCancelRequest
  | SessionAckRequest;

export interface HealthResult {
  status: "ok";
  version: string;
  protocolVersion: "1";
  pid: number;
  startedAt: string;
  dockerReady: boolean;
}

export interface BinaryFingerprint {
  requestedPath: string;
  path: string;
  realPath: string;
  sha256: string;
  size: number;
  modifiedAt: string;
  mode: string;
}

export interface DockerVersionSide {
  version?: string;
  apiVersion?: string;
  minApiVersion?: string;
  goVersion?: string;
  gitCommit?: string;
  os?: string;
  arch?: string;
}

export interface DockerContext {
  name: string;
  description?: string;
  dockerEndpoint?: string;
  current: boolean;
  error?: string;
}

export interface CommandEvidence {
  /** Exact executable followed by exact argument vector. */
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export type Availability = "available" | "unavailable" | "degraded" | "unknown";

export interface CommandNode {
  /** Path excludes the root docker executable, e.g. ["container", "ls"]. */
  path: string[];
  name: string;
  description?: string;
  kind: "root" | "builtin" | "plugin" | "plugin-command";
  status: Availability;
  reason: string;
  transports: Array<"cli" | "engine-api-unix" | string>;
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

export interface Plugin {
  name: string;
  version?: string;
  vendor?: string;
  description?: string;
  path?: string;
  schemaVersion?: string;
  status: Availability;
  discoverySource: "docker-info" | "docker-help" | string;
  availabilityNote?: string;
}

export interface CapabilityStatus {
  name: string;
  status: Availability;
  version?: string;
  reason?: string;
  transports: string[];
  evidence?: CommandEvidence;
  metadata?: Record<string, string>;
}

export interface SystemCapabilitiesResult {
  protocolVersion: "1";
  binary?: BinaryFingerprint;
  binaryError?: RPCError;
  selectedContext?: string;
  currentContext?: string;
  contexts: DockerContext[];
  versions: {
    client: DockerVersionSide;
    server: DockerVersionSide;
  };
  apiMin?: string;
  apiMax?: string;
  serverExperimental: boolean;
  plugins: Plugin[];
  capabilities: Record<"compose" | "scout" | "buildx" | "checkpoint" | string, CapabilityStatus>;
  commandInventory: CommandInventory;
  evidence: {
    contextShow: CommandEvidence;
    contextList: CommandEvidence;
    version: CommandEvidence;
    info: CommandEvidence;
  };
  warnings: string[];
  observedAt: string;
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

export interface ImageDiskUsage {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  created: number;
  sizeBytes: number;
  sharedBytes: number;
  virtualBytes: number;
  containers: number;
}

export interface ContainerDiskUsage {
  id: string;
  image: string;
  imageId: string;
  names: string[];
  created: number;
  writableBytes: number;
  rootFsBytes: number;
  state: string;
  status: string;
}

export interface VolumeUsageData {
  sizeBytes: number;
  refCount: number;
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
  usage?: VolumeUsageData;
  /** Present only on the remote CLI-JSON fallback. */
  labelsText?: string;
  /** Present only on the remote CLI-JSON fallback. */
  sizeDisplay?: string;
}

export interface BuildCacheUsage {
  id: string;
  parent?: string;
  parents: string[];
  type?: string;
  description?: string;
  inUse: boolean;
  shared: boolean;
  sizeBytes: number;
  createdAt?: string;
  lastUsedAt?: string;
  usageCount: number;
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

export interface SystemSnapshotResult {
  context: string;
  source: "engine-api";
  apiVersion: string;
  engine: EngineSummary;
  diskUsage: {
    layersSizeBytes: number;
    builderSizeBytes: number;
    images: ImageDiskUsage[];
    containers: ContainerDiskUsage[];
    volumes: VolumeProjection[];
    buildCache: BuildCacheUsage[];
    /** Authoritative `docker system df` aggregates. */
    summary: SystemDiskUsageSummary;
  };
  observedAt: string;
  endpointHash: string;
  limitations: string[];
}

export interface PortProjection {
  ip?: string;
  privatePort: number;
  publicPort?: number;
  type: string;
}

export interface ContainerProjection {
  id: string;
  name: string;
  image: string;
  imageId?: string;
  state: string;
  status: string;
  health: "none" | "healthy" | "unhealthy" | "starting" | string;
  ports: PortProjection[];
  labels?: Record<string, string>;
  created?: number;
}

export interface ContainersListResult {
  context: string;
  source: "engine-api" | "cli";
  apiVersion?: string;
  containers: ContainerProjection[];
  observedAt: string;
  endpointHash?: string;
}

export interface ContainerStateProjection {
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

export interface PortBinding {
  hostIp?: string;
  hostPort?: string;
}

export interface NetworkProjection {
  networkId?: string;
  endpointId?: string;
  gateway?: string;
  ipAddress?: string;
  macAddress?: string;
}

export interface ContainerInspectProjection {
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
  state: ContainerStateProjection;
  image?: string;
  hostname?: string;
  user?: string;
  workingDir?: string;
  entrypoint: string[];
  command: string[];
  environment: string[];
  labels: Record<string, string>;
  mounts: ContainerMountProjection[];
  ports: Record<string, PortBinding[]>;
  networks: Record<string, NetworkProjection>;
}

export interface ContainerInspectResult {
  context: string;
  source: "engine-api" | "cli-json";
  apiVersion?: string;
  container: ContainerInspectProjection;
  /** Exact Engine/CLI JSON document for the Inspect tab. */
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
  /** Exact one-shot Engine stats document. */
  document: unknown;
  observedAt: string;
  endpointHash: string;
}

export interface OperationReceipt {
  operationId: string;
  context: string;
  containerId: string;
  action: ContainerAction;
  source: "engine-api" | "cli";
  outcome: "pending" | "succeeded" | "failed" | "unknown";
  httpStatus?: number;
  exitCode?: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  endpointHash?: string;
  stdout?: string;
  stderr?: string;
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
  containers: number;
  labels: Record<string, string>;
  /** Present only on the remote CLI-JSON fallback. */
  sizeDisplay?: string;
  /** Present only on the remote CLI-JSON fallback. */
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

export interface DomainOperationReceipt {
  operationId: string;
  context: string;
  domain: "image" | "volume";
  resourceId?: string;
  action: ImageAction | VolumeAction;
  source: "engine-api" | "cli" | "cli-session";
  outcome: "pending" | "running" | "succeeded" | "failed" | "unknown";
  httpStatus?: number;
  exitCode?: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  endpointHash?: string;
  stdout?: string;
  stderr?: string;
}

export interface ImageDeleteRecord {
  deleted?: string;
  untagged?: string;
}

export interface ImagesActionResult {
  action: ImageAction;
  receipt: DomainOperationReceipt;
  deleted?: ImageDeleteRecord[];
  prune?: {
    imagesDeleted: ImageDeleteRecord[];
    spaceReclaimedBytes: number;
  };
  /**
   * Present for pull, save and load; output and cancellation use the existing session.*
   * contract, so a multi-gigabyte archive never transits this response.
   */
  session?: SessionStartResult;
  /** Where a push is going, derived from the reference. */
  registry?: string;
}

/** `containers.export` reuses the images.action receipt shape with its own action name. */
export interface ContainersExportResult {
  action: "export";
  receipt: DomainOperationReceipt;
  session?: SessionStartResult;
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

export interface VolumesActionResult {
  action: VolumeAction;
  receipt: DomainOperationReceipt;
  volume?: VolumeProjection;
  prune?: {
    volumesDeleted: string[];
    spaceReclaimedBytes: number;
  };
}

export interface CapturedOutput {
  data: string;
  encoding: "utf-8" | "base64";
  /** Total bytes produced before bounded capture, not data.length. */
  bytes: number;
  truncated: boolean;
}

export interface CLIRunResult {
  operationId: string;
  context: string;
  targetMode: DockerTargetMode;
  executable: string;
  /** Executed argv. Pinned mode includes the injected --context pair. */
  argv: string[];
  cwd: string;
  exitCode: number;
  timedOut: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
}

export interface SessionStartResult {
  sessionId: string;
  mode: "pipes" | "pty";
  pid: number;
  context: string;
  targetMode: DockerTargetMode;
  executable: string;
  /** Executed argv. Pinned mode includes the injected --context pair. */
  argv: string[];
  cwd: string;
  rows?: number;
  cols?: number;
  outputWindowBytes: number;
  maxOutputBytes: number;
  startedAt: string;
}

export interface SessionInputResult {
  sessionId: string;
  acceptedBytes: number;
  eof: boolean;
}

export interface SessionResizeResult {
  sessionId: string;
  rows: number;
  cols: number;
}

export interface SessionSignalResult {
  sessionId: string;
  signal: SessionSignal;
  accepted: boolean;
}

export interface SessionCancelResult {
  sessionId: string;
  accepted: boolean;
  state: "canceling" | "exited";
}

export interface SessionAckResult {
  sessionId: string;
  throughSequence: number;
  outstandingBytes: number;
}

export interface SessionStartedPayload extends SessionStartResult {
  state: "running";
}

export interface SessionOutputPayload {
  sessionId: string;
  /** Strictly increasing across stdout/stderr/pty for this session. */
  sequence: number;
  stream: "stdout" | "stderr" | "pty";
  data: string;
  encoding: "utf-8" | "base64";
  /** Raw bytes represented by data; use this for ACK-window accounting. */
  bytes: number;
}

export interface SessionOutputTruncatedPayload {
  sessionId: string;
  /** Zero means truncation resulted from cancellation/shutdown, not a lifetime cap. */
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

interface OperationStartedBase {
  operationId: string;
  context: string;
  startedAt: string;
}

export type OperationStartedPayload =
  | (OperationStartedBase & {
      method: "containers.action";
      containerId: string;
      action: ContainerAction;
    })
  | (OperationStartedBase & {
      method: "images.action";
      domain: "image";
      resourceId?: string;
      action: ImageAction;
      source: string;
    })
  | (OperationStartedBase & {
      method: "volumes.action";
      domain: "volume";
      resourceId?: string;
      action: VolumeAction;
      source: string;
    })
  | (OperationStartedBase & {
      method: "cli.run";
      targetMode: DockerTargetMode;
      argv: string[];
      cwd: string;
    });

export type OperationCompletedPayload =
  | {
      receipt: OperationReceipt | DomainOperationReceipt;
      result?: never;
      error?: RPCError;
    }
  | {
      result: CLIRunResult;
      receipt?: never;
      error?: RPCError;
    };

interface ReconciliationPayloadBase {
  operationId: string;
  context: string;
  resourceId?: string;
  reason: "mutation_completed" | "mutation_outcome_unknown";
}

export type ReconciliationPayload =
  | (ReconciliationPayloadBase & {
      domain: "container";
      action: ContainerAction;
    })
  | (ReconciliationPayloadBase & {
      domain: "image";
      action: ImageAction;
    })
  | (ReconciliationPayloadBase & {
      domain: "volume";
      action: VolumeAction;
    });

export type SessionEvent =
  | { event: "session.started"; payload: SessionStartedPayload }
  | { event: "session.output"; payload: SessionOutputPayload }
  | { event: "session.output.truncated"; payload: SessionOutputTruncatedPayload }
  | { event: "session.exited"; payload: SessionExitedPayload }
  | { event: "session.error"; payload: SessionErrorPayload };

export type CoreEvent =
  | SessionEvent
  | { event: "operation.started"; payload: OperationStartedPayload }
  | { event: "operation.completed"; payload: OperationCompletedPayload }
  | { event: "reconciliation.requested"; payload: ReconciliationPayload }
  | { event: "reconciliation.required"; payload: ReconciliationPayload };

/**
 * Compose has no Engine API surface at all — it is a CLI plugin — so every compose method is
 * CLI-routed. The plugin also frames its JSON two different ways: `compose ls` returns a
 * single array while `compose ps` returns one object per line. The core normalizes both.
 */
export interface ComposeStateCount {
  state: string;
  /** -1 when Compose worded the term in a way the core could not parse a count from. */
  count: number;
}

export interface ComposeProject {
  name: string;
  /** Compose's own summary, e.g. "exited(3), running(19)". */
  status: string;
  /** `status` parsed into terms, so the renderer never re-parses a display string. */
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

export interface ComposeListRequest {
  id: RequestId;
  method: "compose.list";
  params: { context: string; all?: boolean };
}

export interface ComposePsRequest {
  id: RequestId;
  method: "compose.ps";
  params: { context: string; project: string };
}

export type ComposeAction = "up" | "down" | "start" | "stop" | "restart";

export type ComposeActionParams =
  | {
      context: string;
      project: string;
      action: "up";
      /** Compose cannot recreate containers without the file that defines them. */
      configFiles: string[];
      removeOrphans?: boolean;
      timeoutSeconds?: number;
      outputWindowBytes?: number;
    }
  | {
      context: string;
      project: string;
      /** Removes containers and networks; `removeVolumes` additionally discards data. */
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

export interface ComposeActionRequest {
  id: RequestId;
  method: "compose.action";
  params: ComposeActionParams;
}

/** Every compose verb streams: `up` pulls images and waits on health checks. */
export interface ComposeActionResult {
  action: ComposeAction;
  project: string;
  receipt: DomainOperationReceipt;
  session?: SessionStartResult;
}

/**
 * Volume browsing mounts the volume read-only into a helper container that is created and
 * never started, then reads it through the same archive endpoint the container file browser
 * uses. Docker exposes no way to read a volume directly.
 */
export interface VolumeFilesRequest {
  id: RequestId;
  method: "volumes.files";
  params: { context: string; name: string; path?: string };
}

export interface VolumeFileReadRequest {
  id: RequestId;
  method: "volumes.fileRead";
  params: { context: string; name: string; path: string };
}

export interface VolumeFilesResult {
  context: string;
  volume: string;
  source: "engine-api";
  /** Relative to the volume root, never the helper's mount point. */
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
 * Docker Scout is an optional CLI plugin with no Engine API. The core projects its SARIF
 * report so the renderer never parses SARIF, and never runs it automatically: the first
 * analysis of an image indexes it, which is slow in proportion to image size.
 */
export interface ImagesScoutRequest {
  id: RequestId;
  method: "images.scout";
  params: { context: string; reference: string };
}

export interface ScoutFinding {
  id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNSPECIFIED";
  score?: number;
  package?: string;
  /** What the image carries today. */
  installedVersion?: string;
  affectedVersion?: string;
  /** The upgrade that resolves it — the only actionable field in a vulnerability report. */
  fixedVersion?: string;
  url?: string;
}

export interface ImagesScoutResult {
  context: string;
  reference: string;
  source: "cli-sarif";
  scanner?: string;
  /** Every severity is present even at zero, so callers never handle a missing key. */
  summary: Record<string, number>;
  /** Never capped, even when `findings` is. */
  total: number;
  findings: ScoutFinding[];
  observedAt: string;
  limitations: string[];
}

/**
 * Uploading into a volume mounts the helper writable — the only path that does. Writing into
 * a volume a running container holds can corrupt data it is using, so that case must be
 * acknowledged explicitly; the count comes from the daemon, not the caller.
 */
export interface VolumeFileWriteRequest {
  id: RequestId;
  method: "volumes.fileWrite";
  params: {
    context: string;
    name: string;
    path: string;
    /** A single path segment; separators and traversal are rejected. */
    fileName: string;
    /** Base64-encoded contents. */
    content: string;
    mode?: number;
    confirmedInUse?: boolean;
  };
}

export interface VolumeFileWriteResult {
  context: string;
  volume: string;
  path: string;
  sizeBytes: number;
  observedAt: string;
}
