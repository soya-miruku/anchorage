import type {
  CLIRunRequest,
  CLIRunResult,
  DockerTargetMode,
  ImagesListRequest,
  OperationStartedPayload,
  ReconciliationPayload,
  SessionStartRequest,
  SessionStartedPayload,
} from "./types.js";

const common = {
  operationId: "01234567-89ab-cdef-0123-456789abcdef",
  context: "default",
  resourceId: "resource-id",
  reason: "mutation_completed",
} as const;

const containerPayloads: ReconciliationPayload[] = [
  { ...common, domain: "container", action: "start" },
  { ...common, domain: "container", action: "stop" },
  { ...common, domain: "container", action: "restart" },
  { ...common, domain: "container", action: "remove" },
];

const imagePayloads: ReconciliationPayload[] = [
  { ...common, domain: "image", action: "remove" },
  { ...common, domain: "image", action: "prune" },
  { ...common, domain: "image", action: "pull" },
];

const volumePayloads: ReconciliationPayload[] = [
  { ...common, domain: "volume", action: "create" },
  { ...common, domain: "volume", action: "remove" },
  { ...common, domain: "volume", action: "prune" },
];

// @ts-expect-error Image actions are not valid for the container domain.
const invalidContainerPayload: ReconciliationPayload = {
  ...common,
  domain: "container",
  action: "pull",
};

// @ts-expect-error Volume actions are not valid for the image domain.
const invalidImagePayload: ReconciliationPayload = {
  ...common,
  domain: "image",
  action: "create",
};

// @ts-expect-error Image actions are not valid for the volume domain.
const invalidVolumePayload: ReconciliationPayload = {
  ...common,
  domain: "volume",
  action: "pull",
};

const pinnedRequest: CLIRunRequest = {
  id: "cli-pinned",
  method: "cli.run",
  params: {
    context: "default",
    argv: ["ps"],
  },
};

const imagesWithDangling: ImagesListRequest = {
  id: "images-with-dangling",
  method: "images.list",
  params: {
    context: "default",
    all: false,
    includeDangling: true,
  },
};

const literalSessionRequest: SessionStartRequest = {
  id: "session-literal",
  method: "session.start",
  params: {
    context: "discovery-profile",
    targetMode: "literal",
    argv: ["--context", "remote", "events"],
    env: { DOCKER_CONTEXT: "remote" },
    mode: "pipes",
  },
};

const cliResult: CLIRunResult = {
  operationId: "01234567-89ab-cdef-0123-456789abcdef",
  context: "discovery-profile",
  targetMode: "literal",
  executable: "/usr/bin/docker",
  argv: ["--context", "remote", "ps"],
  cwd: "/srv/project",
  exitCode: 0,
  timedOut: false,
  startedAt: "2026-08-02T20:00:00Z",
  completedAt: "2026-08-02T20:00:01Z",
  durationMs: 1_000,
  stdout: { data: "", encoding: "utf-8", bytes: 0, truncated: false },
  stderr: { data: "", encoding: "utf-8", bytes: 0, truncated: false },
};

const cliStarted: OperationStartedPayload = {
  operationId: cliResult.operationId,
  method: "cli.run",
  context: cliResult.context,
  targetMode: cliResult.targetMode,
  argv: cliResult.argv,
  cwd: cliResult.cwd,
  startedAt: cliResult.startedAt,
};

const sessionStarted: SessionStartedPayload = {
  sessionId: "01234567-89ab-cdef-0123-456789abcdef",
  mode: "pipes",
  pid: 42,
  context: "discovery-profile",
  targetMode: "literal",
  executable: "/usr/bin/docker",
  argv: ["--context", "remote", "events"],
  cwd: "/srv/project",
  outputWindowBytes: 262_144,
  maxOutputBytes: 0,
  startedAt: "2026-08-02T20:00:00Z",
  state: "running",
};

// @ts-expect-error Only normalized pinned and literal modes are valid.
const invalidTargetMode: DockerTargetMode = "unsafe";

const { targetMode: _resultTargetMode, ...resultWithoutTargetMode } = cliResult;
// @ts-expect-error CLI results must identify whether context was injected.
const missingResultTargetMode: CLIRunResult = resultWithoutTargetMode;

const { targetMode: _startedTargetMode, ...startedWithoutTargetMode } = cliStarted;
// @ts-expect-error CLI lifecycle events must identify the normalized target mode.
const missingStartedTargetMode: OperationStartedPayload = startedWithoutTargetMode;

void [
  containerPayloads,
  imagePayloads,
  volumePayloads,
  invalidContainerPayload,
  invalidImagePayload,
  invalidVolumePayload,
  pinnedRequest,
  imagesWithDangling,
  literalSessionRequest,
  cliResult,
  cliStarted,
  sessionStarted,
  invalidTargetMode,
  missingResultTargetMode,
  missingStartedTargetMode,
];
