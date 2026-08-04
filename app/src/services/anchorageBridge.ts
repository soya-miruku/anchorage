import {
  cloneContainers,
  CONTAINER_FIXTURES,
  createFixtureLogs,
} from "../data/fixtures";
import { createFixtureCapabilities } from "../data/commandFixtures";
import type {
  AnchorageBridge,
  AnchorageContainer,
  CommandEvidence,
  CommandInventory,
  CommandNode,
  ContainerInspectResult,
  ContainerHealth,
  ContainerAction,
  ContainerCreateResult,
  ContainerDiffResult,
  ContainerFileReadResult,
  ContainerFileWriteResult,
  ContainerFilesResult,
  ContainerTopResult,
  ContainersCommitResult,
  ContainersExportResult,
  ComposeActionParams,
  ComposeActionResult,
  ComposeListResult,
  ComposePsResult,
  ContainerRemoveOptions,
  ContainerStatsResult,
  ContainerState,
  CliRunParams,
  DockerContext,
  HostAnchorageApi,
  HostContainersApi,
  HostLifecycleEvent,
  ImageListOptions,
  ImagesActionParams,
  ImagesActionResult,
  ImagesInspectResult,
  ImagesListResult,
  ImagesSearchResult,
  ImagesScoutResult,
  NetworksActionParams,
  NetworksActionResult,
  NetworksListResult,
  LogLine,
  SessionAckParams,
  SessionCancelParams,
  SessionEvent,
  SessionInputParams,
  SessionMode,
  SessionResizeParams,
  SessionSignal,
  SessionStartParams,
  SessionStartResult,
  SystemActionResult,
  SystemCapabilities,
  SystemPruneOptions,
  SystemDiskUsageSummary,
  SystemSnapshot,
  VolumesActionParams,
  VolumesListResult,
  VolumeFilesResult,
  VolumeFileReadResult,
  VolumeFileWriteResult,
  VolumeBackupResult,
  VolumeRestoreResult,
  WindowAction,
} from "../types";

const wait = (duration: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, duration));
const OPAQUE_HEX_COLOR = /^#[0-9A-Fa-f]{6}$/u;

function normalizeWindowBackgroundColor(color: string): string {
  if (typeof color !== "string" || !OPAQUE_HEX_COLOR.test(color)) {
    throw new TypeError(
      "window background color must be an opaque six-digit hexadecimal color",
    );
  }
  return color.toLocaleLowerCase("en-US");
}

const fixtureUnsupported = async (capability: string): Promise<never> => {
  throw new Error(`${capability} is not used by the deterministic design fixture`);
};

const DOCKER_CONTAINER_STATES = new Set<ContainerState>([
  "created",
  "running",
  "paused",
  "restarting",
  "removing",
  "exited",
  "dead",
  "stopped",
  "pulling",
]);

function normalizeState(value: unknown, statusValue: unknown): ContainerState {
  const state = String(value ?? "").trim().toLocaleLowerCase();
  if (DOCKER_CONTAINER_STATES.has(state as ContainerState)) {
    return state as ContainerState;
  }
  if (state === "creating") return "created";
  const status = String(statusValue ?? "").trim().toLocaleLowerCase();
  if (status.startsWith("up ")) return "running";
  if (status.startsWith("exited")) return "exited";
  if (status.startsWith("created")) return "created";
  if (status.startsWith("paused")) return "paused";
  if (status.startsWith("restarting")) return "restarting";
  if (status.startsWith("removing")) return "removing";
  if (status.startsWith("dead")) return "dead";
  return "unknown";
}

function optionalNumber(...values: unknown[]): number | null {
  const raw = values.find(
    (value) => value !== undefined && value !== null && value !== "",
  );
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeHealth(value: unknown): ContainerHealth {
  if (value === "healthy" || value === "unhealthy") return value;
  return "—";
}

function normalizeContainer(value: unknown): AnchorageContainer {
  const raw = (value ?? {}) as Record<string, unknown>;
  const rawStateValue = raw.state ?? raw.State;
  const rawStatusValue = raw.status ?? raw.Status;
  const state = normalizeState(rawStateValue, rawStatusValue);
  const rawState = String(rawStateValue ?? state);
  const status = String(rawStatusValue ?? "");
  const rawNames = Array.isArray(raw.Names) ? raw.Names : [];
  const rawName = raw.name ?? raw.Name ?? rawNames[0] ?? "unnamed";
  const memory = optionalNumber(raw.memory, raw.mem, raw.Memory);
  const memoryLimit = optionalNumber(
    raw.memoryLimit,
    raw.memLimit,
    raw.MemoryLimit,
  );
  const cpu = optionalNumber(raw.cpu, raw.CPU, raw.cpuPercent);
  const explicitExitCode = optionalNumber(raw.exitCode, raw.ExitCode);
  const statusExitCode = status.match(/\bExited\s*\((-?\d+)\)/iu);
  const exitCode =
    explicitExitCode ??
    (statusExitCode ? Number.parseInt(statusExitCode[1], 10) : null);
  const rawLabels = raw.labels ?? raw.Labels;
  const labels: Record<string, string> =
    rawLabels && typeof rawLabels === "object" && !Array.isArray(rawLabels)
      ? Object.fromEntries(
          Object.entries(rawLabels as Record<string, unknown>).map(([key, value]) => [
            key,
            String(value),
          ]),
        )
      : {};
  const rawPorts = raw.ports ?? raw.Ports ?? "—";
  const ports = Array.isArray(rawPorts)
    ? rawPorts
        .map((port) => {
          const item = port as Record<string, unknown>;
          const publicPort = item.publicPort ?? item.PublicPort;
          const privatePort = item.privatePort ?? item.PrivatePort;
          const ip = item.hostIp ?? item.ip ?? item.IP;
          const protocol = item.type ?? item.Type;
          const suffix = protocol ? `/${protocol}` : "";
          return publicPort && privatePort
            ? `${ip ? `${ip}:` : ""}${publicPort}->${privatePort}${suffix}`
            : privatePort
              ? `${privatePort}${suffix}`
              : "";
        })
        .filter(Boolean)
        .join(", ") || "—"
    : String(rawPorts || "—");

  return {
    // Keep the complete daemon identity for every mutation. Presentation
    // components derive the short display id without weakening action targets.
    id: String(raw.id ?? raw.Id ?? "").replace(/^sha256:/, ""),
    name: String(rawName).replace(/^\//, ""),
    image: String(raw.image ?? raw.Image ?? "unknown"),
    ports,
    state,
    rawState,
    status,
    exitCode,
    kind: String(raw.kind ?? "http"),
    cpu,
    memory,
    memoryLimit,
    health: normalizeHealth(raw.health ?? raw.Health),
    progress: Number(raw.progress ?? 0),
    cpuHistory: Array.isArray(raw.cpuHistory)
      ? raw.cpuHistory.map(Number).slice(-48)
      : [],
    memoryHistory: Array.isArray(raw.memoryHistory)
      ? raw.memoryHistory.map(Number).slice(-48)
      : [],
    // Labels used to be discarded here, which made compose grouping impossible.
    labels,
    composeProject: labels["com.docker.compose.project"] ?? null,
  };
}

function normalizeContainerList(value: unknown): AnchorageContainer[] {
  const result =
    Array.isArray(value) || value == null
      ? value
      : (value as Record<string, unknown>).containers;
  if (!Array.isArray(result)) return [];
  return result.map(normalizeContainer);
}

function normalizeCliLogs(value: unknown): LogLine[] {
  const result = (value ?? {}) as Record<string, unknown>;
  const readCaptured = (stream: unknown) => {
    if (typeof stream === "string") return stream;
    if (stream && typeof stream === "object") {
      return String((stream as Record<string, unknown>).data ?? "");
    }
    return "";
  };
  const sources = [
    { data: readCaptured(result.stdout), fallback: "INFO" as const },
    { data: readCaptured(result.stderr), fallback: "LOG" as const },
  ];

  const parsed = sources.flatMap(({ data, fallback }, sourceIndex) =>
    data
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, lineIndex) => {
        const timestampMatch = line.match(
          /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?(.*)$/u,
        );
        const isoTimestamp = timestampMatch?.[1] ?? "";
        const message = timestampMatch?.[2] ?? line;
        const explicitLevel = message.match(/\b(INFO|LOG|WARN|ERROR)\b/iu)?.[1];
        const level: LogLine["level"] =
          explicitLevel === "ERROR" ||
          explicitLevel === "WARN" ||
          explicitLevel === "LOG"
            ? explicitLevel
            : explicitLevel === "INFO"
              ? "INFO"
              : fallback;
        return {
          id: `cli-log-${sourceIndex}-${lineIndex}`,
          isoTimestamp,
          timestamp: isoTimestamp ? isoTimestamp.slice(11, 23) : "",
          level,
          message,
        };
      }),
  );

  return parsed
    .sort((left, right) =>
      left.isoTimestamp && right.isoTimestamp
        ? left.isoTimestamp.localeCompare(right.isoTimestamp)
        : 0,
    )
    .slice(-200)
    .map(({ isoTimestamp: _isoTimestamp, ...line }) => line);
}

const SESSION_EVENTS = [
  "session.started",
  "session.output",
  "session.output.truncated",
  "session.exited",
  "session.error",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function normalizeEvidence(value: unknown): CommandEvidence {
  const raw = asRecord(value);
  return {
    argv: stringArray(raw.argv),
    exitCode: Number(raw.exitCode ?? 0),
    stdout: String(raw.stdout ?? ""),
    stderr: String(raw.stderr ?? ""),
    stdoutTruncated: Boolean(raw.stdoutTruncated),
    stderrTruncated: Boolean(raw.stderrTruncated),
    timedOut: Boolean(raw.timedOut),
    durationMs: Number(raw.durationMs ?? 0),
  };
}

function normalizeCommandNode(value: unknown): CommandNode {
  const raw = asRecord(value);
  const kind =
    raw.kind === "root" ||
    raw.kind === "builtin" ||
    raw.kind === "plugin" ||
    raw.kind === "plugin-command"
      ? raw.kind
      : "builtin";
  const status =
    raw.status === "available" ||
    raw.status === "unavailable" ||
    raw.status === "degraded" ||
    raw.status === "unknown"
      ? raw.status
      : "unknown";

  return {
    path: stringArray(raw.path),
    name: String(raw.name ?? ""),
    description:
      typeof raw.description === "string" ? raw.description : undefined,
    kind,
    status,
    reason: String(raw.reason ?? ""),
    transports: stringArray(raw.transports),
    pluginRoot:
      typeof raw.pluginRoot === "string" ? raw.pluginRoot : undefined,
    usage: typeof raw.usage === "string" ? raw.usage : undefined,
    evidence: normalizeEvidence(raw.evidence),
    subcommands: Array.isArray(raw.subcommands)
      ? raw.subcommands.map(normalizeCommandNode)
      : [],
    capabilities:
      raw.capabilities && typeof raw.capabilities === "object"
        ? (raw.capabilities as Record<string, boolean>)
        : undefined,
    metadata:
      raw.metadata && typeof raw.metadata === "object"
        ? (raw.metadata as Record<string, string>)
        : undefined,
  };
}

function normalizeContext(value: unknown): DockerContext {
  const raw = asRecord(value);
  return {
    name: String(raw.name ?? ""),
    description:
      typeof raw.description === "string" ? raw.description : undefined,
    dockerEndpoint:
      typeof raw.dockerEndpoint === "string" ? raw.dockerEndpoint : undefined,
    current: Boolean(raw.current),
    error: typeof raw.error === "string" ? raw.error : undefined,
  };
}

function normalizeInventory(value: unknown): CommandInventory {
  const raw = asRecord(value);
  return {
    root: normalizeCommandNode(raw.root),
    nodeCount: Number(raw.nodeCount ?? 0),
    complete: Boolean(raw.complete),
    limitReached: Boolean(raw.limitReached),
    maxDepth: Number(raw.maxDepth ?? 0),
    discoveredAt: String(raw.discoveredAt ?? ""),
    warnings: stringArray(raw.warnings),
  };
}

function normalizeCapabilities(value: unknown): SystemCapabilities {
  const raw = asRecord(value);
  const protocolVersion = String(raw.protocolVersion ?? "");
  if (protocolVersion !== "1") {
    throw new Error(
      `Unsupported Anchorage protocol version: ${protocolVersion || "missing"}`,
    );
  }
  const commandInventory = normalizeInventory(raw.commandInventory);
  if (!commandInventory.root.name && commandInventory.root.path.length === 0) {
    throw new Error("Docker command inventory is unavailable");
  }

  return {
    protocolVersion: "1",
    selectedContext:
      typeof raw.selectedContext === "string"
        ? raw.selectedContext
        : undefined,
    currentContext:
      typeof raw.currentContext === "string" ? raw.currentContext : undefined,
    contexts: Array.isArray(raw.contexts)
      ? raw.contexts.map(normalizeContext).filter((context) => context.name)
      : [],
    commandInventory,
    warnings: stringArray(raw.warnings),
    observedAt: String(raw.observedAt ?? ""),
  };
}

function normalizeSessionStart(value: unknown): SessionStartResult {
  const raw = asRecord(value);
  const sessionId = String(raw.sessionId ?? "");
  if (!sessionId) throw new Error("Session start returned no session id");
  const mode: SessionMode = raw.mode === "pty" ? "pty" : "pipes";
  return {
    sessionId,
    mode,
    pid: Number(raw.pid ?? 0),
    context: String(raw.context ?? ""),
    executable: String(raw.executable ?? "docker"),
    argv: stringArray(raw.argv),
    cwd: String(raw.cwd ?? ""),
    rows: typeof raw.rows === "number" ? raw.rows : undefined,
    cols: typeof raw.cols === "number" ? raw.cols : undefined,
    outputWindowBytes: Number(raw.outputWindowBytes ?? 0),
    maxOutputBytes: Number(raw.maxOutputBytes ?? 0),
    startedAt: String(raw.startedAt ?? new Date().toISOString()),
  };
}

function requireObjectResult(
  value: unknown,
  capability: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${capability} returned an invalid result`);
  }
  return value as Record<string, unknown>;
}

function normalizeSnapshot(value: unknown): SystemSnapshot {
  const raw = requireObjectResult(value, "system.snapshot");
  if (
    typeof raw.context !== "string" ||
    !raw.engine ||
    typeof raw.engine !== "object" ||
    !raw.diskUsage ||
    typeof raw.diskUsage !== "object"
  ) {
    throw new Error("system.snapshot returned an incomplete result");
  }
  const snapshot = structuredClone(raw) as unknown as SystemSnapshot;
  if (!snapshot.diskUsage.summary) {
    snapshot.diskUsage.summary = deriveDiskUsageSummary(snapshot.diskUsage);
  }
  return snapshot;
}

/**
 * Backfill for a core that predates the aggregate summary. Image totals come from the
 * deduplicated layer size, never from summing per-image sizes, because each image's size
 * repeats every shared parent layer.
 */
function deriveDiskUsageSummary(
  diskUsage: SystemSnapshot["diskUsage"],
): SystemDiskUsageSummary {
  const images = diskUsage.images ?? [];
  let imagesUsed = 0;
  let imagesActive = 0;
  for (const image of images) {
    if (image.containers === 0) continue;
    imagesActive += 1;
    if (image.sizeBytes < 0 || image.sharedBytes < 0) continue;
    imagesUsed += image.sizeBytes - image.sharedBytes;
  }
  const containers = diskUsage.containers ?? [];
  const volumes = diskUsage.volumes ?? [];
  const buildCache = (diskUsage.buildCache ?? []).filter((item) => !item.shared);
  const clamp = (value: number) => (value < 0 ? 0 : value);
  const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);

  return {
    images: {
      totalCount: images.length,
      activeCount: imagesActive,
      sizeBytes: diskUsage.layersSizeBytes,
      reclaimableBytes: clamp(diskUsage.layersSizeBytes - imagesUsed),
    },
    containers: {
      totalCount: containers.length,
      activeCount: containers.filter((c) => c.state === "running").length,
      sizeBytes: sum(containers.map((c) => c.writableBytes)),
      reclaimableBytes: sum(
        containers.filter((c) => c.state !== "running").map((c) => c.writableBytes),
      ),
    },
    volumes: {
      totalCount: volumes.length,
      activeCount: volumes.filter((v) => (v.usage?.refCount ?? 0) > 0).length,
      sizeBytes: sum(volumes.map((v) => Math.max(0, v.usage?.sizeBytes ?? 0))),
      reclaimableBytes: sum(
        volumes
          .filter((v) => (v.usage?.refCount ?? 0) === 0)
          .map((v) => Math.max(0, v.usage?.sizeBytes ?? 0)),
      ),
    },
    buildCache: {
      totalCount: (diskUsage.buildCache ?? []).length,
      activeCount: buildCache.filter((item) => item.inUse).length,
      sizeBytes: sum(buildCache.map((item) => item.sizeBytes)),
      reclaimableBytes: sum(
        buildCache.filter((item) => !item.inUse).map((item) => item.sizeBytes),
      ),
    },
  };
}

function normalizeSystemAction(value: unknown): SystemActionResult {
  const raw = requireObjectResult(value, "system.action");
  if (!Array.isArray(raw.stages)) {
    throw new Error("system.action returned an incomplete result");
  }
  return structuredClone(raw) as unknown as SystemActionResult;
}

function normalizeInspect(value: unknown): ContainerInspectResult {
  const raw = requireObjectResult(value, "containers.inspect");
  const container = asRecord(raw.container);
  if (
    typeof raw.context !== "string" ||
    typeof container.id !== "string" ||
    !Array.isArray(container.mounts)
  ) {
    throw new Error("containers.inspect returned an incomplete result");
  }
  return structuredClone(raw) as unknown as ContainerInspectResult;
}

function normalizeStats(value: unknown): ContainerStatsResult {
  const raw = requireObjectResult(value, "containers.stats");
  if (
    typeof raw.context !== "string" ||
    typeof raw.containerId !== "string" ||
    typeof raw.cpuPercent !== "number" ||
    typeof raw.memoryUsageBytes !== "number"
  ) {
    throw new Error("containers.stats returned an incomplete result");
  }
  return structuredClone(raw) as unknown as ContainerStatsResult;
}

function normalizeImagesList(value: unknown): ImagesListResult {
  const raw = requireObjectResult(value, "images.list");
  if (typeof raw.context !== "string" || !Array.isArray(raw.images)) {
    throw new Error("images.list returned an incomplete result");
  }
  return structuredClone(raw) as unknown as ImagesListResult;
}

function normalizeImagesAction(value: unknown): ImagesActionResult {
  const raw = requireObjectResult(value, "images.action");
  if (typeof raw.action !== "string" || !raw.receipt) {
    throw new Error("images.action returned an incomplete result");
  }
  return structuredClone(raw) as unknown as ImagesActionResult;
}

function normalizeVolumesList(value: unknown): VolumesListResult {
  const raw = requireObjectResult(value, "volumes.list");
  if (typeof raw.context !== "string" || !Array.isArray(raw.volumes)) {
    throw new Error("volumes.list returned an incomplete result");
  }
  return structuredClone(raw) as unknown as VolumesListResult;
}

interface FixtureSession {
  result: SessionStartResult;
  request: SessionStartParams;
  sequence: number;
  stdoutBytes: number;
  stderrBytes: number;
  ptyBytes: number;
  timers: number[];
  exited: boolean;
}

class FixtureBridge implements AnchorageBridge {
  readonly mode = "fixture" as const;
  private state = cloneContainers(CONTAINER_FIXTURES);
  private readonly listeners = new Set<
    (containers: AnchorageContainer[]) => void
  >();
  private readonly sessionListeners = new Set<
    (event: SessionEvent) => void
  >();
  private readonly activeSessions = new Map<string, FixtureSession>();
  private nextSessionId = 1;

  private emitSession(event: SessionEvent) {
    this.sessionListeners.forEach((listener) => listener(event));
  }

  private emitFixtureOutput(session: FixtureSession, data: string) {
    if (session.exited) return;
    session.sequence += 1;
    const bytes = new TextEncoder().encode(data).byteLength;
    const stream =
      session.request.mode === "pty" ? ("pty" as const) : ("stdout" as const);
    if (stream === "pty") session.ptyBytes += bytes;
    else session.stdoutBytes += bytes;
    this.emitSession({
      event: "session.output",
      payload: {
        sessionId: session.result.sessionId,
        sequence: session.sequence,
        stream,
        data,
        encoding: "utf-8",
        bytes,
      },
    });
  }

  private finishFixtureSession(
    session: FixtureSession,
    options: { exitCode: number; canceled: boolean; signal?: string },
  ) {
    if (session.exited) return;
    session.exited = true;
    session.timers.forEach((timer) => window.clearTimeout(timer));
    const exitedAt = new Date().toISOString();
    const emittedBytes =
      session.stdoutBytes + session.stderrBytes + session.ptyBytes;
    this.emitSession({
      event: "session.exited",
      payload: {
        sessionId: session.result.sessionId,
        state: "exited",
        exitCode: options.exitCode,
        signal: options.signal,
        timedOut: false,
        canceled: options.canceled,
        startedAt: session.result.startedAt,
        exitedAt,
        durationMs: Math.max(
          0,
          Date.parse(exitedAt) - Date.parse(session.result.startedAt),
        ),
        output: {
          stdoutBytes: session.stdoutBytes,
          stderrBytes: session.stderrBytes,
          ptyBytes: session.ptyBytes,
          emittedBytes,
          droppedBytes: 0,
          truncated: false,
          lastSequence: session.sequence,
        },
      },
    });
    this.activeSessions.delete(session.result.sessionId);
  }

  private notify() {
    const snapshot = cloneContainers(this.state);
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private update(
    id: string,
    updater: (container: AnchorageContainer) => AnchorageContainer,
  ) {
    let result: AnchorageContainer | undefined;
    this.state = this.state.map((container) => {
      if (container.id !== id) return container;
      result = updater(container);
      return result;
    });
    this.notify();
    return result ? cloneContainers([result])[0] : undefined;
  }

  readonly containers = {
    list: async () => cloneContainers(this.state),
    start: async (id: string) =>
      this.update(id, (container) => ({
        ...container,
        state: "running" as const,
        rawState: "running",
        status: "Running",
        exitCode: null,
        health: container.health === "—" ? ("healthy" as const) : container.health,
        cpu: 11.6,
        memory: Math.round((container.memoryLimit ?? 0) * 0.19),
      })),
    stop: async (id: string) =>
      this.update(id, (container) => ({
        ...container,
        state: "stopped" as const,
        rawState: "exited",
        status: "Exited (0)",
        exitCode: 0,
        cpu: 0,
        memory: 0,
      })),
    restart: async (id: string) => {
      this.update(id, (container) => ({
        ...container,
        state: "stopped" as const,
        rawState: "exited",
        status: "Exited (0)",
        exitCode: 0,
        cpu: 0,
        memory: 0,
      }));
      await wait(600);
      return this.update(id, (container) => ({
        ...container,
        state: "running" as const,
        rawState: "running",
        status: "Running",
        exitCode: null,
        cpu: 12.4,
        memory: Math.round((container.memoryLimit ?? 0) * 0.21),
      }));
    },
    remove: async (id: string) => {
      this.state = this.state.filter((container) => container.id !== id);
      this.notify();
    },
    create: async () => fixtureUnsupported("containers.create"),
    commit: async () => fixtureUnsupported("containers.commit"),
    export: async () => fixtureUnsupported("containers.export"),
    rename: async (id: string, name: string) => {
      this.update(id, (container) => ({ ...container, name }));
    },
    update: async () => undefined,
    pause: async (id: string) =>
      this.update(id, (container) => ({
        ...container,
        state: "paused" as const,
        rawState: "paused",
        status: "Paused",
      })),
    unpause: async (id: string) =>
      this.update(id, (container) => ({
        ...container,
        state: "running" as const,
        rawState: "running",
        status: "Running",
      })),
    kill: async (id: string) =>
      this.update(id, (container) => ({
        ...container,
        state: "exited" as const,
        rawState: "exited",
        status: "Exited (137)",
        exitCode: 137,
        cpu: 0,
        memory: 0,
      })),
    logs: async (id: string) => {
      const container = this.state.find((item) => item.id === id);
      return container ? createFixtureLogs(container) : [];
    },
    inspect: async () => fixtureUnsupported("containers.inspect"),
    stats: async () => fixtureUnsupported("containers.stats"),
    statsBatch: async () => [],
    files: async () => fixtureUnsupported("containers.files"),
    fileRead: async () => fixtureUnsupported("containers.fileRead"),
    fileWrite: async () => fixtureUnsupported("containers.fileWrite"),
    top: async () => fixtureUnsupported("containers.top"),
    diff: async () => fixtureUnsupported("containers.diff"),
    subscribe: (listener: (containers: AnchorageContainer[]) => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };

  readonly system = {
    capabilities: async (context?: string) =>
      createFixtureCapabilities(context),
    snapshot: async () => fixtureUnsupported("system.snapshot"),
    prune: async () => fixtureUnsupported("system.action"),
  };

  readonly images = {
    list: async () => fixtureUnsupported("images.list"),
    inspect: async () => fixtureUnsupported("images.inspect"),
    search: async () => fixtureUnsupported("images.search"),
    action: async () => fixtureUnsupported("images.action"),
    scout: async () => fixtureUnsupported("images.scout"),
  };

  readonly compose = {
    list: async () => fixtureUnsupported("compose.list"),
    ps: async () => fixtureUnsupported("compose.ps"),
    action: async () => fixtureUnsupported("compose.action"),
  };

  readonly networks = {
    list: async () => fixtureUnsupported("networks.list"),
    action: async () => fixtureUnsupported("networks.action"),
  };

  readonly volumes = {
    list: async () => fixtureUnsupported("volumes.list"),
    action: async () => fixtureUnsupported("volumes.action"),
    files: async () => fixtureUnsupported("volumes.files"),
    fileRead: async () => fixtureUnsupported("volumes.fileRead"),
    fileWrite: async () => fixtureUnsupported("volumes.fileWrite"),
    backup: async () => fixtureUnsupported("volumes.backup"),
    restore: async () => fixtureUnsupported("volumes.restore"),
  };

  readonly cli = {
    run: async () => fixtureUnsupported("cli.run"),
  };

  readonly sessions = {
    start: async (request: SessionStartParams): Promise<SessionStartResult> => {
      const sessionId = `fixture-session-${this.nextSessionId}`;
      this.nextSessionId += 1;
      const startedAt = new Date().toISOString();
      const result: SessionStartResult = {
        sessionId,
        mode: request.mode,
        targetMode: request.targetMode ?? "pinned",
        pid: 4200 + this.nextSessionId,
        context: request.context,
        executable: "/usr/bin/docker",
        argv:
          request.targetMode === "literal"
            ? request.argv
            : ["--context", request.context, ...request.argv],
        cwd: request.cwd ?? "/workspace",
        rows: request.mode === "pty" ? request.rows ?? 30 : undefined,
        cols: request.mode === "pty" ? request.cols ?? 120 : undefined,
        outputWindowBytes: request.outputWindowBytes ?? 262_144,
        maxOutputBytes: request.maxOutputBytes ?? 0,
        startedAt,
      };
      const session: FixtureSession = {
        result,
        request: structuredClone(request),
        sequence: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
        ptyBytes: 0,
        timers: [],
        exited: false,
      };
      this.activeSessions.set(sessionId, session);
      session.timers.push(
        window.setTimeout(() => {
          this.emitSession({
            event: "session.started",
            payload: { ...result, state: "running" },
          });
        }, 0),
        window.setTimeout(() => {
          this.emitFixtureOutput(
            session,
            request.mode === "pty"
              ? "Anchorage fixture terminal ready\r\n"
              : "Anchorage fixture command completed\n",
          );
        }, 20),
      );
      if (request.mode === "pipes") {
        session.timers.push(
          window.setTimeout(
            () =>
              this.finishFixtureSession(session, {
                exitCode: 0,
                canceled: false,
              }),
            80,
          ),
        );
      }
      return structuredClone(result);
    },
    input: async (request: SessionInputParams) => {
      const session = this.activeSessions.get(request.sessionId);
      if (!session || session.exited) {
        throw new Error(`Session ${request.sessionId} is not running`);
      }
      const rawData = request.data ?? "";
      const acceptedBytes =
        request.encoding === "base64"
          ? Math.max(0, Math.floor((rawData.length * 3) / 4))
          : new TextEncoder().encode(rawData).byteLength;
      if (rawData) {
        if (request.encoding === "base64") {
          this.emitSession({
            event: "session.output",
            payload: {
              sessionId: request.sessionId,
              sequence: ++session.sequence,
              stream: session.request.mode === "pty" ? "pty" : "stdout",
              data: rawData,
              encoding: "base64",
              bytes: acceptedBytes,
            },
          });
          if (session.request.mode === "pty") session.ptyBytes += acceptedBytes;
          else session.stdoutBytes += acceptedBytes;
        } else {
          this.emitFixtureOutput(session, rawData);
        }
      }
      return {
        sessionId: request.sessionId,
        acceptedBytes,
        eof: Boolean(request.eof),
      };
    },
    resize: async (request: SessionResizeParams) => {
      const session = this.activeSessions.get(request.sessionId);
      if (!session || session.exited) {
        throw new Error(`Session ${request.sessionId} is not running`);
      }
      if (session.request.mode !== "pty") {
        throw new Error("Only PTY sessions can be resized");
      }
      session.result.rows = request.rows;
      session.result.cols = request.cols;
      return { ...request };
    },
    signal: async (request: {
      sessionId: string;
      signal: SessionSignal;
    }) => {
      const session = this.activeSessions.get(request.sessionId);
      if (!session || session.exited) {
        return { ...request, accepted: false };
      }
      this.finishFixtureSession(session, {
        exitCode: 130,
        canceled: false,
        signal: request.signal,
      });
      return { ...request, accepted: true };
    },
    cancel: async (request: SessionCancelParams) => {
      const session = this.activeSessions.get(request.sessionId);
      if (!session || session.exited) {
        return {
          sessionId: request.sessionId,
          accepted: false,
          state: "exited" as const,
        };
      }
      this.finishFixtureSession(session, {
        exitCode: 143,
        canceled: true,
        signal: "SIGTERM",
      });
      return {
        sessionId: request.sessionId,
        accepted: true,
        state: "exited" as const,
      };
    },
    ack: async (request: SessionAckParams) => ({
      ...request,
      outstandingBytes: 0,
    }),
    subscribe: (listener: (event: SessionEvent) => void) => {
      this.sessionListeners.add(listener);
      return () => {
        this.sessionListeners.delete(listener);
      };
    },
  };

  readonly events = {
    subscribe: () => () => undefined,
  };

  async windowAction(_action: WindowAction) {
    // Browser previews intentionally keep desktop chrome controls inert.
  }

  async windowIsMaximized() {
    return false;
  }

  subscribeWindowMaximized() {
    return () => undefined;
  }

  async setWindowBackgroundColor(color: string) {
    normalizeWindowBackgroundColor(color);
    // Browser previews intentionally have no native window clear color.
  }
}

function createHostBridge(host: HostAnchorageApi): AnchorageBridge {
  const api: HostContainersApi | undefined = host.containers;
  let lastContainerContext = "default";
  const list = (context = "default") => {
    lastContainerContext = context;
    const listRequest = { context, all: true } as const;
    if (api) return api.list(listRequest);
    if (host.invoke) return host.invoke("containers.list", listRequest);
    return Promise.reject(new Error("Container list capability is unavailable"));
  };
  const action = (
    id: string,
    operation: ContainerAction,
    context = "default",
    removeOptions: ContainerRemoveOptions = {},
    signal?: string,
  ) => {
    const request = {
      context,
      id,
      action: operation,
      ...(operation === "remove"
        ? {
            options: {
              confirmed: true as const,
              ...(removeOptions.force ? { force: true } : {}),
              ...(removeOptions.volumes ? { volumes: true } : {}),
            },
          }
        : operation === "kill" && signal
          ? { options: { signal } }
          : {}),
    } as const;
    if (api) return api.action(request);
    if (host.invoke) return host.invoke("containers.action", request);
    return Promise.reject(new Error("Container action capability is unavailable"));
  };
  const cliRun = (payload: CliRunParams) => {
    if (host.cli) return host.cli.run(payload);
    if (host.invoke) return host.invoke("cli.run", payload);
    return Promise.reject(new Error("Docker CLI capability is unavailable"));
  };

  const runContainerAction = async (
    operation: "start" | "stop" | "restart" | "pause" | "unpause",
    id: string,
    context?: string,
  ) => {
    await action(id, operation, context);
    // The host returns an operation receipt, not a container projection.
    // Returning void intentionally makes the store refresh containers.list().
    return undefined;
  };
  const systemCapabilities = async (context?: string) => {
    const request = context ? { context } : undefined;
    const result = host.system
      ? await host.system.capabilities(request)
      : host.invoke
        ? await host.invoke("system.capabilities", request)
        : await Promise.reject(
            new Error("Docker capability discovery is unavailable"),
          );
    return normalizeCapabilities(result);
  };
  const systemSnapshot = async (context: string, includeDiskUsage = false) => {
    // /system/df is a full daemon-side disk walk; only the dashboard shows it, so every other
    // caller (engine-ready, post-mutation reconciliation) deliberately skips it.
    const request = includeDiskUsage
      ? { context, includeDiskUsage: true }
      : { context };
    const result = host.system?.snapshot
      ? await host.system.snapshot(request)
      : host.invoke
        ? await host.invoke("system.snapshot", request)
        : await Promise.reject(
            new Error("Docker system snapshot capability is unavailable"),
          );
    return normalizeSnapshot(result);
  };
  const listNetworks = async (context: string): Promise<NetworksListResult> => {
    const request = { context };
    const result = host.networks
      ? await host.networks.list(request)
      : host.invoke
        ? await host.invoke("networks.list", request)
        : await Promise.reject(
            new Error("Docker network capability is unavailable"),
          );
    const raw = requireObjectResult(result, "networks.list");
    if (!Array.isArray(raw.networks)) {
      throw new Error("networks.list returned an incomplete result");
    }
    return structuredClone(raw) as unknown as NetworksListResult;
  };

  const mutateNetworks = async (
    params: NetworksActionParams,
  ): Promise<NetworksActionResult> => {
    const result = host.networks
      ? await host.networks.action(params)
      : host.invoke
        ? await host.invoke("networks.action", params)
        : await Promise.reject(
            new Error("Docker network capability is unavailable"),
          );
    return structuredClone(
      requireObjectResult(result, "networks.action"),
    ) as unknown as NetworksActionResult;
  };

  const systemPrune = async (
    context: string,
    options: SystemPruneOptions = {},
  ): Promise<SystemActionResult> => {
    const request = {
      context,
      action: "prune" as const,
      ...(options.all ? { all: true } : {}),
      ...(options.volumes ? { volumes: true } : {}),
      confirmed: true as const,
    };
    const result = host.system?.action
      ? await host.system.action(request)
      : host.invoke
        ? await host.invoke("system.action", request)
        : await Promise.reject(
            new Error("Docker system prune capability is unavailable"),
          );
    return normalizeSystemAction(result);
  };
  const inspectContainer = async (id: string, context = "default") => {
    const request = { context, id };
    const result = api?.inspect
      ? await api.inspect(request)
      : host.invoke
        ? await host.invoke("containers.inspect", request)
        : await Promise.reject(
            new Error("Container inspect capability is unavailable"),
          );
    return normalizeInspect(result);
  };
  const readContainerStats = async (id: string, context = "default") => {
    const request = { context, id };
    const result = api?.stats
      ? await api.stats(request)
      : host.invoke
        ? await host.invoke("containers.stats", request)
        : await Promise.reject(
            new Error("Container stats capability is unavailable"),
          );
    return normalizeStats(result);
  };
  const readContainerStatsBatch = async (ids: string[], context = "default") => {
    if (ids.length === 0) return [];
    const request = { context, ids };
    const result = api?.statsBatch
      ? await api.statsBatch(request)
      : host.invoke
        ? await host.invoke("containers.statsBatch", request)
        : await Promise.reject(
            new Error("Batch container stats capability is unavailable"),
          );
    const raw = requireObjectResult(result, "containers.statsBatch");
    if (!Array.isArray(raw.samples)) {
      throw new Error("containers.statsBatch returned an incomplete result");
    }
    // Per-container failures are expected during a poll (a container can exit mid-sample);
    // drop those rows rather than failing the batch.
    return (raw.samples as Array<Record<string, unknown>>)
      .filter((sample) => sample.stats)
      .map((sample) => ({
        id: String(sample.id),
        stats: sample.stats as ContainerStatsResult,
      }));
  };
  const inspectImage = async (id: string, context = "default") => {
    const request = { context, id };
    const result = host.images?.inspect
      ? await host.images.inspect(request)
      : host.invoke
        ? await host.invoke("images.inspect", request)
        : await Promise.reject(
            new Error("Image inspect capability is unavailable"),
          );
    const raw = requireObjectResult(result, "images.inspect");
    if (!raw.image || !Array.isArray(raw.history)) {
      throw new Error("images.inspect returned an incomplete result");
    }
    return structuredClone(raw) as unknown as ImagesInspectResult;
  };
  const containerReadOnly = async <T, R extends Record<string, unknown>>(
    method: string,
    apiFn: ((request: R) => Promise<unknown>) | undefined,
    request: R,
    validate: (raw: Record<string, unknown>) => boolean,
  ): Promise<T> => {
    const result = apiFn
      ? await apiFn(request)
      : host.invoke
        ? await host.invoke(method, request)
        : await Promise.reject(new Error(`${method} capability is unavailable`));
    const raw = requireObjectResult(result, method);
    if (!validate(raw)) {
      throw new Error(`${method} returned an incomplete result`);
    }
    return structuredClone(raw) as unknown as T;
  };
  const listImages = async (context: string, options: ImageListOptions = {}) => {
    // These were hardcoded. `includeDangling: true` inverted Docker's own default and made
    // the screen render every untagged layer with no way to narrow the list.
    const request = {
      context,
      all: options.all ?? false,
      includeDangling: options.includeDangling ?? false,
    };
    const result = host.images
      ? await host.images.list(request)
      : host.invoke
        ? await host.invoke("images.list", request)
        : await Promise.reject(new Error("Image list capability is unavailable"));
    return normalizeImagesList(result);
  };
  const mutateImages = async (request: ImagesActionParams) => {
    const result = host.images
      ? await host.images.action(request)
      : host.invoke
        ? await host.invoke("images.action", request)
        : await Promise.reject(
            new Error("Image action capability is unavailable"),
          );
    return normalizeImagesAction(result);
  };
  const volumeFiles = async (name: string, targetPath: string, context: string) => {
    const request = { context, name, path: targetPath };
    const result = host.volumes?.files
      ? await host.volumes.files(request)
      : host.invoke
        ? await host.invoke("volumes.files", request)
        : await Promise.reject(
            new Error("Volume browsing is unavailable"),
          );
    const raw = requireObjectResult(result, "volumes.files");
    if (!Array.isArray(raw.entries)) {
      throw new Error("volumes.files returned an incomplete result");
    }
    return structuredClone(raw) as unknown as VolumeFilesResult;
  };
  const volumeFileRead = async (name: string, targetPath: string, context: string) => {
    const request = { context, name, path: targetPath };
    const result = host.volumes?.fileRead
      ? await host.volumes.fileRead(request)
      : host.invoke
        ? await host.invoke("volumes.fileRead", request)
        : await Promise.reject(
            new Error("Volume browsing is unavailable"),
          );
    const raw = requireObjectResult(result, "volumes.fileRead");
    if (typeof raw.content !== "string") {
      throw new Error("volumes.fileRead returned an incomplete result");
    }
    return structuredClone(raw) as unknown as VolumeFileReadResult;
  };
  const volumeFileWrite = async (
    name: string,
    request: {
      path: string;
      fileName: string;
      content: string;
      confirmedInUse?: boolean;
    },
    context: string,
  ) => {
    const payload = { context, name, ...request };
    const result = host.volumes?.fileWrite
      ? await host.volumes.fileWrite(payload)
      : host.invoke
        ? await host.invoke("volumes.fileWrite", payload)
        : await Promise.reject(new Error("Volume upload is unavailable"));
    const raw = requireObjectResult(result, "volumes.fileWrite");
    if (typeof raw.path !== "string") {
      throw new Error("volumes.fileWrite returned an incomplete result");
    }
    return structuredClone(raw) as unknown as VolumeFileWriteResult;
  };
  const volumeBackup = async (
    name: string,
    archivePath: string,
    options: { overwrite?: boolean },
    context: string,
  ) => {
    const payload = {
      context,
      name,
      archivePath,
      ...(options.overwrite ? { overwrite: true } : {}),
    };
    const result = host.volumes?.backup
      ? await host.volumes.backup(payload)
      : host.invoke
        ? await host.invoke("volumes.backup", payload)
        : await Promise.reject(new Error("Volume backup is unavailable"));
    const raw = requireObjectResult(result, "volumes.backup");
    if (typeof raw.archivePath !== "string") {
      throw new Error("volumes.backup returned an incomplete result");
    }
    return structuredClone(raw) as unknown as VolumeBackupResult;
  };
  const volumeRestore = async (
    name: string,
    archivePath: string,
    options: { confirmedInUse?: boolean },
    context: string,
  ) => {
    const payload = {
      context,
      name,
      archivePath,
      confirmed: true as const,
      ...(options.confirmedInUse ? { confirmedInUse: true } : {}),
    };
    const result = host.volumes?.restore
      ? await host.volumes.restore(payload)
      : host.invoke
        ? await host.invoke("volumes.restore", payload)
        : await Promise.reject(new Error("Volume restore is unavailable"));
    const raw = requireObjectResult(result, "volumes.restore");
    if (typeof raw.volume !== "string") {
      throw new Error("volumes.restore returned an incomplete result");
    }
    return structuredClone(raw) as unknown as VolumeRestoreResult;
  };
  const composeList = async (context: string, all = true) => {
    const request = { context, all };
    const result = host.compose
      ? await host.compose.list(request)
      : host.invoke
        ? await host.invoke("compose.list", request)
        : await Promise.reject(
            new Error("Compose capability is unavailable"),
          );
    const raw = requireObjectResult(result, "compose.list");
    if (!Array.isArray(raw.projects)) {
      throw new Error("compose.list returned an incomplete result");
    }
    return structuredClone(raw) as unknown as ComposeListResult;
  };
  const composePs = async (project: string, context: string) => {
    const request = { context, project };
    const result = host.compose
      ? await host.compose.ps(request)
      : host.invoke
        ? await host.invoke("compose.ps", request)
        : await Promise.reject(
            new Error("Compose capability is unavailable"),
          );
    const raw = requireObjectResult(result, "compose.ps");
    if (!Array.isArray(raw.services)) {
      throw new Error("compose.ps returned an incomplete result");
    }
    return structuredClone(raw) as unknown as ComposePsResult;
  };
  const composeAction = async (params: ComposeActionParams) => {
    const result = host.compose
      ? await host.compose.action(params)
      : host.invoke
        ? await host.invoke("compose.action", params)
        : await Promise.reject(
            new Error("Compose capability is unavailable"),
          );
    const raw = requireObjectResult(result, "compose.action");
    // The response is the session handle; Compose's own progress arrives on session.*.
    if (typeof raw.action !== "string" || !raw.receipt) {
      throw new Error("compose.action returned an incomplete result");
    }
    return structuredClone(raw) as unknown as ComposeActionResult;
  };
  const scoutImage = async (reference: string, context: string) => {
    const request = { context, reference };
    const result = host.images?.scout
      ? await host.images.scout(request)
      : host.invoke
        ? await host.invoke("images.scout", request)
        : await Promise.reject(
            new Error("Image analysis is unavailable"),
          );
    const raw = requireObjectResult(result, "images.scout");
    if (!Array.isArray(raw.findings) || typeof raw.total !== "number") {
      throw new Error("images.scout returned an incomplete result");
    }
    return structuredClone(raw) as unknown as ImagesScoutResult;
  };
  const listVolumes = async (context: string) => {
    const request = { context };
    const result = host.volumes
      ? await host.volumes.list(request)
      : host.invoke
        ? await host.invoke("volumes.list", request)
        : await Promise.reject(
            new Error("Volume list capability is unavailable"),
          );
    return normalizeVolumesList(result);
  };
  const mutateVolumes = async (request: VolumesActionParams) => {
    const result = host.volumes
      ? await host.volumes.action(request)
      : host.invoke
        ? await host.invoke("volumes.action", request)
        : await Promise.reject(
            new Error("Volume action capability is unavailable"),
          );
    return structuredClone(
      requireObjectResult(result, "volumes.action"),
    );
  };
  const invokeSession = (
    method:
      | "start"
      | "input"
      | "resize"
      | "signal"
      | "cancel"
      | "ack",
    request: unknown,
  ) => {
    if (host.session) {
      switch (method) {
        case "start":
          return host.session.start(request as SessionStartParams);
        case "input":
          return host.session.input(request as SessionInputParams);
        case "resize":
          return host.session.resize(request as SessionResizeParams);
        case "signal":
          return host.session.signal(
            request as { sessionId: string; signal: SessionSignal },
          );
        case "cancel":
          return host.session.cancel(request as SessionCancelParams);
        case "ack":
          return host.session.ack(request as SessionAckParams);
      }
    }
    if (host.invoke) return host.invoke(`session.${method}`, request);
    return Promise.reject(
      new Error(`Docker session ${method} capability is unavailable`),
    );
  };

  return {
    mode: "host",
    containers: {
      list: async (context) => {
        const result = await list(context);
        return normalizeContainerList(result);
      },
      start: (id, context) => runContainerAction("start", id, context),
      stop: (id, context) => runContainerAction("stop", id, context),
      restart: (id, context) =>
        runContainerAction("restart", id, context),
      pause: (id, context) => runContainerAction("pause", id, context),
      rename: async (id, name, context = "default") => {
        const request = { context, id, action: "rename" as const, options: { name } };
        if (api) await api.action(request);
        else if (host.invoke) await host.invoke("containers.action", request);
        else throw new Error("Container rename capability is unavailable");
      },
      update: async (id, limits, context = "default") => {
        const request = {
          context,
          id,
          action: "update" as const,
          options: { ...limits },
        };
        if (api) await api.action(request);
        else if (host.invoke) await host.invoke("containers.action", request);
        else throw new Error("Container update capability is unavailable");
      },
      unpause: (id, context) => runContainerAction("unpause", id, context),
      kill: async (id, context, signal) => {
        await action(id, "kill", context, {}, signal);
      },
      remove: async (id, context, options) => {
        await action(id, "remove", context, options);
      },
      create: async (options, context = "default") => {
        const request = { context, ...options };
        const result = api?.create
          ? await api.create(request)
          : host.invoke
            ? await host.invoke("containers.create", request)
            : await Promise.reject(
                new Error("Container creation capability is unavailable"),
              );
        const raw = requireObjectResult(result, "containers.create");
        if (typeof raw.id !== "string") {
          throw new Error("containers.create returned an incomplete result");
        }
        return structuredClone(raw) as unknown as ContainerCreateResult;
      },
      logs: async (id, context = "default") => {
        const result = await cliRun({
          context,
          argv: ["logs", "--timestamps", "--tail", "200", id],
          timeoutSeconds: 30,
        });
        return normalizeCliLogs(result);
      },
      inspect: inspectContainer,
      stats: readContainerStats,
      statsBatch: readContainerStatsBatch,
      files: (id, targetPath, context = "default") =>
        containerReadOnly<ContainerFilesResult, { context: string; id: string; path?: string }>(
          "containers.files",
          api?.files,
          { context, id, path: targetPath },
          (raw) => Array.isArray(raw.entries),
        ),
      fileRead: (id, targetPath, context = "default") =>
        containerReadOnly<ContainerFileReadResult, { context: string; id: string; path: string }>(
          "containers.fileRead",
          api?.fileRead,
          { context, id, path: targetPath },
          (raw) => typeof raw.content === "string",
        ),
      fileWrite: (id, targetPath, name, content, context = "default") =>
        containerReadOnly<
          ContainerFileWriteResult,
          { context: string; id: string; path: string; name: string; content: string }
        >(
          "containers.fileWrite",
          api?.fileWrite,
          { context, id, path: targetPath, name, content },
          (raw) => typeof raw.path === "string",
        ),
      commit: async (id, options, context = "default") => {
        const request = { context, id, ...options };
        const result = api?.commit
          ? await api.commit(request)
          : host.invoke
            ? await host.invoke("containers.commit", request)
            : await Promise.reject(
                new Error("Container commit capability is unavailable"),
              );
        const raw = requireObjectResult(result, "containers.commit");
        if (typeof raw.imageId !== "string") {
          throw new Error("containers.commit returned an incomplete result");
        }
        return structuredClone(raw) as unknown as ContainersCommitResult;
      },
      export: async (id, archivePath, options = {}, context = "default") => {
        const request = {
          context,
          id,
          archivePath,
          ...(options.overwrite ? { overwrite: true } : {}),
        };
        const result = api?.export
          ? await api.export(request)
          : host.invoke
            ? await host.invoke("containers.export", request)
            : await Promise.reject(
                new Error("Container export capability is unavailable"),
              );
        const raw = requireObjectResult(result, "containers.export");
        // The response is the session handle, not the archive: progress and cancellation
        // arrive on the session.* channel while Docker writes the file.
        if (raw.action !== "export" || !raw.receipt) {
          throw new Error("containers.export returned an incomplete result");
        }
        return structuredClone(raw) as unknown as ContainersExportResult;
      },
      top: (id, context = "default") =>
        containerReadOnly<ContainerTopResult, { context: string; id: string }>(
          "containers.top",
          api?.top,
          { context, id },
          (raw) => Array.isArray(raw.processes),
        ),
      diff: (id, context = "default") =>
        containerReadOnly<ContainerDiffResult, { context: string; id: string }>(
          "containers.diff",
          api?.diff,
          { context, id },
          (raw) => Array.isArray(raw.changes),
        ),
      subscribe: host.subscribe
        ? (listener) =>
            host.subscribe?.("containers.changed", () => {
              void list(lastContainerContext)
                .then((result) => listener(normalizeContainerList(result)));
            })
        : undefined,
    },
    system: {
      capabilities: systemCapabilities,
      snapshot: systemSnapshot,
      prune: systemPrune,
    },
    compose: {
      list: (context = "default", all = true) => composeList(context, all),
      ps: (project: string, context = "default") => composePs(project, context),
      action: composeAction,
    },
    images: {
      list: listImages,
      inspect: inspectImage,
      scout: (reference: string, context = "default") =>
        scoutImage(reference, context),
      search: async (term, context = "default") => {
        const request = { context, term };
        const result = host.images?.search
          ? await host.images.search(request)
          : host.invoke
            ? await host.invoke("images.search", request)
            : await Promise.reject(
                new Error("Registry search capability is unavailable"),
              );
        const raw = requireObjectResult(result, "images.search");
        if (!Array.isArray(raw.results)) {
          throw new Error("images.search returned an incomplete result");
        }
        return structuredClone(raw) as unknown as ImagesSearchResult;
      },
      action: mutateImages,
    },
    networks: {
      list: listNetworks,
      action: mutateNetworks,
    },
    volumes: {
      list: listVolumes,
      files: (name: string, targetPath: string, context = "default") =>
        volumeFiles(name, targetPath, context),
      fileRead: (name: string, targetPath: string, context = "default") =>
        volumeFileRead(name, targetPath, context),
      fileWrite: (
        name: string,
        request: {
          path: string;
          fileName: string;
          content: string;
          confirmedInUse?: boolean;
        },
        context = "default",
      ) => volumeFileWrite(name, request, context),
      backup: (
        name: string,
        archivePath: string,
        options: { overwrite?: boolean } = {},
        context = "default",
      ) => volumeBackup(name, archivePath, options, context),
      restore: (
        name: string,
        archivePath: string,
        options: { confirmedInUse?: boolean } = {},
        context = "default",
      ) => volumeRestore(name, archivePath, options, context),
      action: mutateVolumes,
    },
    cli: {
      run: cliRun,
    },
    sessions: {
      start: async (request) =>
        normalizeSessionStart(await invokeSession("start", request)),
      input: (request) => invokeSession("input", request),
      resize: (request) => invokeSession("resize", request),
      signal: (request) => invokeSession("signal", request),
      cancel: (request) => invokeSession("cancel", request),
      ack: (request) => invokeSession("ack", request),
      subscribe: (listener) => {
        if (!host.subscribe) return () => undefined;
        const unsubscribers = SESSION_EVENTS.map((event) =>
          host.subscribe?.(event, (payload) => {
            listener({ event, payload } as SessionEvent);
          }),
        );
        return () => {
          unsubscribers.forEach((unsubscribe) => unsubscribe?.());
        };
      },
    },
    events: {
      subscribe: (listener) => {
        if (!host.subscribe) return () => undefined;
        const eventNames = [
          "core.status",
          "reconciliation.requested",
          "reconciliation.required",
        ] as const;
        const unsubscribers = eventNames.map((event) =>
          host.subscribe?.(event, (payload) => {
            listener({ event, payload } as HostLifecycleEvent);
          }),
        );
        return () => {
          unsubscribers.forEach((unsubscribe) => unsubscribe?.());
        };
      },
    },
    windowAction: async (action) => {
      const direct = host.window?.[action];
      if (!direct) return;
      const result = await direct();
      return action === "maximize" && typeof result === "boolean"
        ? result
        : undefined;
    },
    windowIsMaximized: async () => {
      const readState = host.window?.isMaximized;
      if (!readState) return false;
      return (await readState()) === true;
    },
    subscribeWindowMaximized: (listener) => {
      if (!host.subscribe) return () => undefined;
      const unsubscribe = host.subscribe("window.maximized", (payload) => {
        if (typeof payload === "boolean") {
          listener(payload);
        }
      });
      return typeof unsubscribe === "function"
        ? unsubscribe
        : () => undefined;
    },
    setWindowBackgroundColor: async (color) => {
      const normalized = normalizeWindowBackgroundColor(color);
      const setBackgroundColor = host.window?.setBackgroundColor;
      if (setBackgroundColor) {
        await setBackgroundColor(normalized);
      }
    },
  };
}

export function createAnchorageBridge(): AnchorageBridge {
  if (typeof window !== "undefined" && window.anchorage) {
    return createHostBridge(window.anchorage);
  }
  return new FixtureBridge();
}
