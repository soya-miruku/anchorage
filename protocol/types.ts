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

/**
 * The contexts a launch needs, without the discovery a launch does not.
 *
 * `system.capabilities` answers the same question, but only after walking every advertised
 * command and probing every plugin — seconds of subprocesses that the first paint had to wait
 * for. This carries the context list alone so the window can come alive independently of how
 * large the installed command surface is.
 */
export interface SystemContextsRequest {
  id: RequestId;
  method: "system.contexts";
  params?: { context?: string };
}

/**
 * Which CLI plugins are installed, and which of them the CLI actually loaded.
 *
 * Separate from `system.capabilities` because it is a stat of a few directories rather than a
 * recursive help walk, so a settings pane can ask it without paying for discovery.
 */
export interface SystemPluginsRequest {
  id: RequestId;
  method: "system.plugins";
  params?: { context?: string };
}

/**
 * Repairs one faulty entry in a plugin directory.
 *
 * `Plugin.status` above distinguishes a capability that is absent from an installation that is
 * faulty, and says the remedy for each. This is that remedy — and only that. Neither action
 * installs a plugin: the core has no HTTP client, Electron blocks every download, and nothing
 * in the protocol can execute a binary other than the fingerprinted Docker CLI. An absent
 * capability is guidance the surface gives the operator, never work this verb performs.
 *
 * `path` accompanies `name` because one plugin name can appear in several directories, and the
 * entry being repaired is a file rather than a name. The core does not trust either value on its
 * own: it re-walks the directories, re-derives the classification, and refuses anything it does
 * not itself report as broken or unloaded.
 */
export interface SystemPluginActionRequest {
  id: RequestId;
  method: "system.pluginAction";
  params: {
    context?: string;
    /** Plugin command name, without the `docker-` file prefix. */
    name: string;
    path: string;
    /** `remove` unlinks the entry; `enable` adds the execute bit the CLI requires. */
    action: "remove" | "enable";
    /** Required for `remove`, which deletes a file on the operator's machine. */
    confirmed?: true;
  };
}

export interface SystemPluginActionResult {
  protocolVersion: "1";
  name: string;
  path: string;
  action: "remove" | "enable";
  outcome: "removed" | "enabled";
  /**
   * The re-read installation. Carried rather than left to the caller because `enable` can make
   * a plugin load, which changes entries the action never touched.
   */
  plugins: SystemPluginsResult;
  observedAt: string;
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
/**
 * Republishing a container's ports, which replaces it.
 *
 * Docker fixes bindings at creation and `docker update` does not cover them, so there is no such
 * thing as rebinding a container. The core creates a new one from the original's own `Config` and
 * `HostConfig` with only the port fields replaced — hand-picking fields to copy would silently
 * drop whatever the list forgot. Three consequences are reported rather than glossed: the ID
 * changes, the writable layer is discarded, and the log history goes with it. Hence `confirmed`.
 *
 * `id` is bounded rather than pinned to the immutable 64-character form, which is what the core
 * accepts here. Every other container verb requires the full ID, on the grounds that a shorter
 * reference can resolve to a different container between render and act; this one is the
 * exception and is recorded as such rather than quietly described as strict.
 */
export interface ContainersRebindPortsRequest {
  id: RequestId;
  method: "containers.rebindPorts";
  params: {
    context: string;
    id: string;
    /** Host port to container port, e.g. `{"8080": "80/tcp"}`. Empty publishes nothing. */
    ports: Record<string, string>;
    confirmed: true;
  };
}

export interface ContainersRebindPortsResult {
  context: string;
  /** The container that was replaced. It no longer exists. */
  previousId: string;
  id: string;
  name: string;
  warnings: string[];
  /** What recreating could not carry over, in the operator's terms. */
  discarded: string[];
  receipt: Record<string, unknown>;
  observedAt: string;
  endpointHash?: string;
}

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
  | SystemContextsRequest
  | SystemPluginsRequest
  | SystemPluginActionRequest
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
  | ContainersRebindPortsRequest
  | ContainersExportRequest
  | ComposeListRequest
  | ComposePsRequest
  | ComposeConfigRequest
  | ComposeActionRequest
  | VolumeFilesRequest
  | VolumeFileReadRequest
  | ImagesScoutRequest
  | VolumeFileWriteRequest
  | VolumeBackupRequest
  | VolumeRestoreRequest
  | VolumeCloneRequest
  | VolumeEmptyRequest
  | BuildsListRequest
  | BuildsInspectRequest
  | BuildsBuilderActionRequest
  | ImagesListRequest
  | ImagesActionRequest
  | ImagesInspectRequest
  | ImagesSearchRequest
  | ContainersCommitRequest
  | VolumesListRequest
  | VolumesActionRequest
  | NetworksListRequest
  | NetworksActionRequest
  | SecretsListRequest
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

/**
 * `broken` is not one of `Availability`'s states on purpose.
 *
 * Availability answers "can this capability be used". A broken plugin is a different claim:
 * the installation itself is faulty — a link with no target, or a file with no execute bit —
 * and the remedy is to repair the machine rather than to install a capability. `docker info`
 * omits these entirely, so nothing else in the product could report them.
 */
export type PluginStatus = Availability | "broken";

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

export interface Plugin {
  name: string;
  version?: string;
  vendor?: string;
  description?: string;
  path?: string;
  schemaVersion?: string;
  status: PluginStatus;
  fault?: PluginFault;
  discoverySource: "docker-info" | "docker-help" | "cli-plugins-dir" | string;
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

export interface SystemPluginsResult {
  protocolVersion: "1";
  binary?: BinaryFingerprint;
  binaryError?: RPCError;
  /** Both the plugins the CLI loaded and the entries it skipped; `status` separates them. */
  plugins: Plugin[];
  /** The directories searched, in the CLI's own order. */
  searchPath: string[];
  warnings: string[];
  observedAt: string;
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
 * `compose config` renders the fully resolved model. Compose finds a running project by label
 * but cannot render a configuration it was never given, so the files are required here exactly
 * as they are for `up`. The core projects a typed subset: what the resolved file does not
 * carry is absent rather than guessed, and `limitations` says which of those there were.
 */
export interface ComposeConfigRequest {
  id: RequestId;
  method: "compose.config";
  params: { context: string; project: string; configFiles: string[] };
}

export interface ComposeDependsOn {
  service: string;
  /** `service_started`, `service_healthy` or `service_completed_successfully`. */
  condition: string;
  /** Restart this service when the dependency is restarted. */
  restart?: boolean;
  /** False means Compose starts this service even when the dependency is absent. */
  required: boolean;
}

export interface ComposeWatchRule {
  path: string;
  /** `sync`, `rebuild`, `restart`, `sync+restart` or `sync+exec`. */
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
  /**
   * True only where a declared user resolves to root. An unstated user is never reported as
   * root: what it resolves to lives in the image, which the resolved file does not carry.
   */
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

/** Something the project declares but does not itself run. */
export interface ComposeDeclaredDependency {
  kind: "model" | "provider" | "secret" | "volume";
  name: string;
  /** What Compose resolves it to: a volume or secret's Docker name, a provider's type. */
  resource?: string;
  external?: boolean;
  /** The services that declare it, so the edge can be drawn. */
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

/**
 * A volume outlives its containers, so there has to be a way to get its data out and back.
 * Docker offers no endpoint for it: the contents are streamed through the same never-started
 * helper the browser uses, and the helper's mount point is stripped so the archive is an
 * ordinary tar rooted at the volume's own contents.
 */
export interface VolumeBackupRequest {
  id: RequestId;
  method: "volumes.backup";
  params: {
    context: string;
    name: string;
    archivePath: string;
    overwrite?: boolean;
  };
}

export interface VolumeBackupResult {
  context: string;
  volume: string;
  archivePath: string;
  entries: number;
  sizeBytes: number;
  observedAt: string;
}

export interface VolumeRestoreRequest {
  id: RequestId;
  method: "volumes.restore";
  params: {
    context: string;
    name: string;
    archivePath: string;
    /** Restoring writes over whatever the volume already holds. */
    confirmed: true;
    /** Separately acknowledges doing so while a container is using it. */
    confirmedInUse?: boolean;
  };
}

export interface VolumeRestoreResult {
  context: string;
  volume: string;
  archivePath: string;
  observedAt: string;
}

/**
 * Docker has no clone or empty verb. A clone is a backup and a restore that never touch the
 * disk — the source is read through the never-started helper and rewritten straight into a
 * second one on the target. Emptying cannot work that way at all: the archive endpoint writes
 * files but cannot delete them, so the volume is removed and recreated from its own
 * declaration, which the result reports.
 */
export interface VolumeCloneRequest {
  id: RequestId;
  method: "volumes.clone";
  params: {
    context: string;
    name: string;
    /** Must not already exist; a clone never writes into a volume that is already there. */
    target: string;
  };
}

export interface VolumeCloneResult {
  context: string;
  volume: string;
  target: string;
  entries: number;
  sizeBytes: number;
  observedAt: string;
  limitations: string[];
}

export interface VolumeEmptyRequest {
  id: RequestId;
  method: "volumes.empty";
  params: {
    context: string;
    name: string;
    /** Emptying discards every byte the volume holds and nothing restores it. */
    confirmed: true;
  };
}

export interface VolumeEmptyResult {
  context: string;
  volume: string;
  /** The volume as it exists afterwards, since it is a new one under the same declaration. */
  recreated?: VolumeProjection;
  observedAt: string;
  limitations: string[];
}

/**
 * Buildx is an optional CLI plugin with no Engine API. Note that `history ls` reports a
 * reference as `builder/node/id` while `history inspect` accepts only the bare id, so the
 * core carries both and resolves between them.
 */
export interface BuildsListRequest {
  id: RequestId;
  method: "builds.list";
  params: { context: string };
}

export interface BuildsInspectRequest {
  id: RequestId;
  method: "builds.inspect";
  params: { context: string; ref: string };
}

/**
 * Acting on one builder, using buildx's own verbs.
 *
 * `BuildBuilder.error` carries buildx's note about a builder it could not reach, and reporting
 * it without offering anything to do about it left the operator to run buildx by hand. These are
 * the two verbs that case needs: start the node, or delete the entry.
 *
 * `use` is absent by decision rather than omission. Choosing the active builder rewrites the
 * CLI's own configuration, which every tool on the machine reads — not this application's to
 * change on the operator's behalf.
 */
export interface BuildsBuilderActionRequest {
  id: RequestId;
  method: "builds.builderAction";
  params: {
    context: string;
    name: string;
    /** `bootstrap` is `buildx inspect --bootstrap`; `remove` is `buildx rm`. */
    action: "remove" | "bootstrap";
    /** Required for `remove`: the builder's cache does not survive it. */
    confirmed?: true;
  };
}

export interface BuildsBuilderActionResult {
  protocolVersion: "1";
  context: string;
  name: string;
  action: "remove" | "bootstrap";
  outcome: "removed" | "bootstrapped";
  /** What buildx printed. A failure is only explicable in its own terms. */
  output?: string;
  /** The re-read inventory: removing the current builder promotes another one. */
  builders: BuildBuilder[];
  observedAt: string;
}

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
 * Swarm secrets are the only secret store the Docker Engine API exposes, and it exposes
 * references to them, never values: `GET /secrets` returns an id, a name and metadata, and
 * the daemon discards the plaintext once the secret exists. No API call and no CLI command
 * reads a value back — only the containers a secret is granted to ever see it. There is
 * therefore no inspect verb here and no field that could carry one.
 *
 * Distinct from Docker Pass, the separate `se://` resolver: this says nothing about whether
 * an `se://` reference resolves on the host.
 */
export interface SecretsListRequest {
  id: RequestId;
  method: "secrets.list";
  params: { context: string };
}

/**
 * Whether the Swarm secret store was reachable, and why not when it was not.
 *
 * Docker answers 503 on every Swarm endpoint of a node that is not a manager, which is the
 * ordinary state of a desktop engine — so it arrives as a state on a successful result
 * rather than as an error. An empty store on a manager and no store at all are different
 * facts and must not collapse into one empty list.
 */
export interface SwarmSurface {
  /** True only when this engine served the secret list itself. */
  manager: boolean;
  /** Docker's Swarm.LocalNodeState, or "unknown" when the transport could not report it. */
  nodeState: string;
  /** The engine's or the CLI's own words for the refusal. */
  reason?: string;
}

export interface SecretSummary {
  id: string;
  name: string;
  /** An external secret driver, when one holds the value instead of Swarm's own store. */
  driver?: string;
  /** RFC3339 on the Engine transport only. */
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
