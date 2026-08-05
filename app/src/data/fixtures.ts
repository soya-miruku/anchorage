import type {
  AnchorageBuild,
  AnchorageContainer,
  AnchorageExtension,
  AnchorageImage,
  AnchorageVolume,
  BuildStep,
  DashboardActivity,
  DevEnvironment,
  DiskUsageItem,
  EngineResources,
  FeatureFlags,
  LogLine,
  RegistryImage,
} from "../types";

const cpuHistory = (base: number) =>
  Array.from({ length: 48 }, (_, index) =>
    Number(Math.max(0.4, base + ((index % 9) - 4) * 0.55).toFixed(1)),
  );

const memoryHistory = (base: number) =>
  Array.from({ length: 48 }, (_, index) =>
    Number(Math.max(0, base + ((index % 7) - 3) * 1.75).toFixed(1)),
  );

export const CONTAINER_FIXTURES: AnchorageContainer[] = [
  {
    id: "a91f2c4d",
    name: "api-gateway",
    image: "node:20-alpine",
    ports: "8080:8080, 9229:9229",
    state: "running",
    rawState: "running",
    status: "Running",
    exitCode: null,
    kind: "http",
    cpu: 19.7,
    memory: 184,
    memoryLimit: 512,
    health: "healthy",
    cpuHistory: cpuHistory(19.7),
    memoryHistory: memoryHistory(184),
    labels: { "com.docker.compose.project": "storefront", "com.docker.compose.service": "api-gateway" },
    composeProject: "storefront",
  },
  {
    id: "7d3b8e10",
    name: "postgres-main",
    image: "postgres:16",
    ports: "5432:5432",
    state: "running",
    rawState: "running",
    status: "Running",
    exitCode: null,
    kind: "pg",
    cpu: 0.4,
    memory: 421,
    memoryLimit: 2048,
    health: "healthy",
    cpuHistory: cpuHistory(0.4),
    memoryHistory: memoryHistory(421),
    labels: {},
    composeProject: null,
  },
  {
    id: "c02a5f77",
    name: "redis-cache",
    image: "redis:7-alpine",
    ports: "6379:6379",
    state: "running",
    rawState: "running",
    status: "Running",
    exitCode: null,
    kind: "redis",
    cpu: 7.1,
    memory: 40,
    memoryLimit: 256,
    health: "healthy",
    cpuHistory: cpuHistory(7.1),
    memoryHistory: memoryHistory(40),
    labels: {},
    composeProject: null,
  },
  {
    id: "e14d9b23",
    name: "worker-queue",
    image: "acme/worker:2.4",
    ports: "—",
    state: "running",
    rawState: "running",
    status: "Running",
    exitCode: null,
    kind: "worker",
    cpu: 52.8,
    memory: 745,
    memoryLimit: 1024,
    health: "unhealthy",
    cpuHistory: cpuHistory(52.8),
    memoryHistory: memoryHistory(745),
    labels: { "com.docker.compose.project": "storefront", "com.docker.compose.service": "worker-queue" },
    composeProject: "storefront",
  },
  {
    id: "5b8c1a06",
    name: "nginx-edge",
    image: "nginx:1.27",
    ports: "80:80, 443:443",
    state: "running",
    rawState: "running",
    status: "Running",
    exitCode: null,
    kind: "nginx",
    cpu: 0.4,
    memory: 24,
    memoryLimit: 128,
    health: "healthy",
    cpuHistory: cpuHistory(0.4),
    memoryHistory: memoryHistory(24),
    labels: {},
    composeProject: null,
  },
  {
    id: "f6210d98",
    name: "minio-storage",
    image: "minio/minio:RELEASE.2026-05",
    ports: "9000:9000",
    state: "stopped",
    rawState: "exited",
    status: "Exited (0)",
    exitCode: 0,
    kind: "http",
    cpu: 0,
    memory: 0,
    memoryLimit: 1024,
    health: "—",
    cpuHistory: Array(48).fill(0),
    memoryHistory: Array(48).fill(0),
    labels: {},
    composeProject: null,
  },
  {
    id: "3ac74e5b",
    name: "mailpit",
    image: "axllent/mailpit:v1.20",
    ports: "8025:8025",
    state: "stopped",
    rawState: "exited",
    status: "Exited (0)",
    exitCode: 0,
    kind: "http",
    cpu: 0,
    memory: 0,
    memoryLimit: 256,
    health: "—",
    cpuHistory: Array(48).fill(0),
    memoryHistory: Array(48).fill(0),
    labels: {},
    composeProject: null,
  },
  {
    id: "9e0f6c81",
    name: "vector-db",
    image: "qdrant/qdrant:1.9",
    ports: "6333:6333",
    state: "pulling",
    rawState: "pulling",
    status: "Pulling",
    exitCode: null,
    kind: "http",
    cpu: 0,
    memory: 0,
    memoryLimit: 1024,
    health: "—",
    progress: 12,
    cpuHistory: Array(48).fill(0),
    memoryHistory: Array(48).fill(0),
    labels: {},
    composeProject: null,
  },
];

export const IMAGE_FIXTURES: AnchorageImage[] = [
  {
    repository: "node",
    tag: "20-alpine",
    id: "sha256:4f1a92",
    imageId: "sha256:4f1a92",
    reference: "node:20-alpine",
    identity: "sha256:4f1a92\u0000node:20-alpine",
    created: "6 days ago",
    size: "142 MB",
    sizeMb: 142,
    usageKnown: true,
    inUse: true,
    reclaimable: false,
  },
  {
    repository: "postgres",
    tag: "16",
    id: "sha256:b70ce3",
    imageId: "sha256:b70ce3",
    reference: "postgres:16",
    identity: "sha256:b70ce3\u0000postgres:16",
    created: "2 weeks ago",
    size: "431 MB",
    sizeMb: 431,
    usageKnown: true,
    inUse: true,
    reclaimable: false,
  },
  {
    repository: "redis",
    tag: "7-alpine",
    id: "sha256:11d8ac",
    imageId: "sha256:11d8ac",
    reference: "redis:7-alpine",
    identity: "sha256:11d8ac\u0000redis:7-alpine",
    created: "2 weeks ago",
    size: "41 MB",
    sizeMb: 41,
    usageKnown: true,
    inUse: true,
    reclaimable: false,
  },
  {
    repository: "nginx",
    tag: "1.27",
    id: "sha256:9c5e40",
    imageId: "sha256:9c5e40",
    reference: "nginx:1.27",
    identity: "sha256:9c5e40\u0000nginx:1.27",
    created: "3 weeks ago",
    size: "187 MB",
    sizeMb: 187,
    usageKnown: true,
    inUse: true,
    reclaimable: false,
  },
  {
    repository: "acme/worker",
    tag: "2.4",
    id: "sha256:772bfe",
    imageId: "sha256:772bfe",
    reference: "acme/worker:2.4",
    identity: "sha256:772bfe\u0000acme/worker:2.4",
    created: "11 hours ago",
    size: "512 MB",
    sizeMb: 512,
    usageKnown: true,
    inUse: true,
    reclaimable: false,
  },
  {
    repository: "qdrant/qdrant",
    tag: "1.9",
    id: "sha256:20aa71",
    imageId: "sha256:20aa71",
    reference: "qdrant/qdrant:1.9",
    identity: "sha256:20aa71\u0000qdrant/qdrant:1.9",
    created: "1 month ago",
    size: "219 MB",
    sizeMb: 219,
    usageKnown: true,
    inUse: false,
    reclaimable: false,
  },
  {
    repository: "python",
    tag: "3.12-slim",
    id: "sha256:d3901f",
    imageId: "sha256:d3901f",
    reference: "python:3.12-slim",
    identity: "sha256:d3901f\u0000python:3.12-slim",
    created: "1 month ago",
    size: "128 MB",
    sizeMb: 128,
    usageKnown: true,
    inUse: false,
    reclaimable: false,
  },
  {
    repository: "<none>",
    tag: "<none>",
    id: "sha256:0f4b8c",
    imageId: "sha256:0f4b8c",
    reference: null,
    identity: "sha256:0f4b8c\u0000<none>",
    created: "2 months ago",
    size: "890 MB",
    sizeMb: 890,
    usageKnown: true,
    inUse: false,
    reclaimable: true,
  },
];

export const REGISTRY_FIXTURES: RegistryImage[] = [
  {
    name: "postgres",
    official: true,
    description: "The PostgreSQL object-relational database system.",
    stars: "14.2k",
    pulls: "10B+",
    updated: "3 days ago",
  },
  {
    name: "valkey/valkey",
    official: false,
    description: "High-performance in-memory data store, a fork of Redis.",
    stars: "1.3k",
    pulls: "80M+",
    updated: "6 days ago",
  },
  {
    name: "grafana/grafana",
    official: false,
    description: "Dashboards and observability for time-series data.",
    stars: "3.9k",
    pulls: "2B+",
    updated: "yesterday",
  },
  {
    name: "traefik",
    official: true,
    description: "Cloud-native reverse proxy and ingress controller.",
    stars: "3.1k",
    pulls: "3B+",
    updated: "5 days ago",
  },
  {
    name: "clickhouse/clickhouse-server",
    official: false,
    description: "Column-oriented OLAP database for real-time analytics.",
    stars: "1.8k",
    pulls: "500M+",
    updated: "2 days ago",
  },
];

export const VOLUME_FIXTURES: AnchorageVolume[] = [
  {
    name: "core_pgdata",
    driver: "local",
    size: "2.41 GB",
    usedBy: "postgres-main",
    created: "3 months ago",
    usageKnown: true,
  },
  {
    name: "redis_appendonly",
    driver: "local",
    size: "128 MB",
    usedBy: "redis-cache",
    created: "3 months ago",
    usageKnown: true,
  },
  {
    name: "minio_data",
    driver: "local",
    size: "14.2 GB",
    usedBy: "minio-storage",
    created: "5 months ago",
    usageKnown: true,
  },
  {
    name: "node_modules_cache",
    driver: "local",
    size: "1.09 GB",
    usedBy: "api-gateway",
    created: "6 weeks ago",
    usageKnown: true,
  },
  {
    name: "prom_metrics",
    driver: "local",
    size: "640 MB",
    usedBy: null,
    created: "2 months ago",
    usageKnown: true,
  },
];

export const BUILD_FIXTURES: AnchorageBuild[] = [
  {
    id: "worker-2.4-8f2c1ab",
    name: "acme/worker:2.4",
    status: "success",
    duration: "1m 42s",
    meta: "main · 8f2c1ab · linux/amd64",
    cache: "87%",
    context: "12.4 MB",
    layers: "14",
    output: "512 MB",
  },
  {
    id: "api-edge-3d9e07c",
    name: "acme/api:edge",
    status: "success",
    duration: "54s",
    meta: "feat/tracing · 3d9e07c · linux/amd64",
    cache: "93%",
    context: "6.1 MB",
    layers: "11",
    output: "188 MB",
  },
  {
    id: "worker-2.3-71ba55d",
    name: "acme/worker:2.3",
    status: "failed",
    duration: "38s",
    meta: "main · 71ba55d · linux/amd64",
    cache: "42%",
    context: "12.3 MB",
    layers: "9",
    output: "—",
  },
  {
    id: "migrations-9-a04c8e2",
    name: "acme/migrations:9",
    status: "success",
    duration: "22s",
    meta: "main · a04c8e2 · linux/arm64",
    cache: "71%",
    context: "880 KB",
    layers: "7",
    output: "96 MB",
  },
  {
    id: "api-edge-55f1a9b",
    name: "acme/api:edge",
    status: "cancelled",
    duration: "12s",
    meta: "fix/pool · 55f1a9b · linux/amd64",
    cache: "—",
    context: "6.1 MB",
    layers: "4",
    output: "—",
  },
  {
    id: "docs-latest-e2b7740",
    name: "acme/docs:latest",
    status: "success",
    duration: "1m 09s",
    meta: "main · e2b7740 · linux/amd64",
    cache: "64%",
    context: "34.9 MB",
    layers: "12",
    output: "340 MB",
  },
];

export const BUILD_STEP_FIXTURES: BuildStep[] = [
  { command: "FROM node:20-alpine", cached: true, duration: "0.0s" },
  { command: "WORKDIR /srv", cached: true, duration: "0.0s" },
  { command: "COPY package*.json ./", cached: true, duration: "0.1s" },
  { command: "RUN npm ci --omit=dev", cached: true, duration: "0.0s" },
  { command: "COPY . .", cached: false, duration: "2.4s" },
  { command: "RUN npm run build", cached: false, duration: "48.1s" },
  { command: "RUN node scripts/prune.js", cached: false, duration: "3.9s" },
  { command: "EXPOSE 8080", cached: false, duration: "0.0s" },
  {
    command: 'CMD ["node","dist/server.js"]',
    cached: false,
    duration: "0.0s",
  },
  { command: "exporting layers", cached: false, duration: "7.2s" },
];

/*
 * Deterministic, and coherent with the figures rendered beside them. The previous series
 * ran 22-44 next to a printed "CPU 10%", so the chart contradicted its own legend — a reader
 * cannot tell a decorative series from a wrong one.
 */
export const DASHBOARD_CPU_HISTORY = [
  9, 11, 12, 13, 13, 13, 11, 10, 9, 8, 8, 8, 8, 8, 7, 7,
  6, 6, 6, 7, 8, 10, 12, 13, 14, 13, 12, 11, 9, 8, 7, 6,
  6, 7, 7, 8, 8, 7, 7, 8, 8, 10, 11, 12, 13, 14, 13, 10,
];

/** Percent of the fixture's 16 GB allocation; the legend prints 1.4 GB, which is ~9%. */
export const DASHBOARD_MEMORY_HISTORY = [
  9, 9, 10, 10, 10, 10, 10, 10, 10, 9, 9, 9, 9, 9, 9, 9,
  9, 8, 8, 8, 7, 7, 7, 7, 7, 8, 8, 9, 9, 10, 10, 10,
  10, 10, 10, 9, 9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 7, 9,
];

export const DASHBOARD_ACTIVITY: DashboardActivity[] = [
  {
    id: "nginx-started",
    tone: "accent",
    text: "nginx-edge started",
    time: "2 min ago",
  },
  {
    id: "qdrant-pulling",
    tone: "violet",
    text: "Pulling qdrant/qdrant:1.9 from registry",
    time: "4 min ago",
  },
  {
    id: "worker-health",
    tone: "danger",
    text: "worker-queue health check failed (3×)",
    time: "11 min ago",
  },
  {
    id: "worker-build",
    tone: "accent",
    text: "Build acme/worker:2.4 succeeded in 1m 42s",
    time: "38 min ago",
  },
  {
    id: "minio-exited",
    tone: "muted",
    text: "minio-storage exited with code 0",
    time: "1 hour ago",
  },
  {
    id: "cache-reclaimed",
    tone: "warning",
    text: "Reclaimed 2.1 GB of build cache",
    time: "3 hours ago",
  },
  {
    id: "compose-up",
    tone: "accent",
    text: "Compose project acme up (5 services)",
    time: "5 hours ago",
  },
];

export const DISK_USAGE_FIXTURES: DiskUsageItem[] = [
  {
    id: "images",
    label: "Images",
    size: "2.55 GB",
    percent: 62,
    detail: "8 images · 1 dangling",
    tone: "accent",
  },
  {
    id: "containers",
    label: "Containers",
    size: "412 MB",
    percent: 18,
    detail: "8 writable layers",
    tone: "warning",
  },
  {
    id: "volumes",
    label: "Volumes",
    size: "18.5 GB",
    percent: 88,
    detail: "5 volumes · 1 unused",
    tone: "violet",
  },
  {
    id: "build-cache",
    label: "Build cache",
    size: "6.9 GB",
    percent: 44,
    detail: "142 cache records",
    tone: "blue",
  },
];

export const DEV_ENVIRONMENT_FIXTURES: DevEnvironment[] = [
  {
    id: "acme-platform",
    name: "acme-platform",
    repository: "github.com/acme/platform",
    state: "running",
    tags: ["node 20", "pnpm", "postgres"],
  },
  {
    id: "ml-pipeline",
    name: "ml-pipeline",
    repository: "github.com/acme/ml-pipeline",
    state: "stopped",
    tags: ["python 3.12", "cuda 12.4"],
  },
  {
    id: "docs-site",
    name: "docs-site",
    repository: "github.com/acme/docs",
    state: "running",
    tags: ["bun 1.1", "astro"],
  },
];

export const EXTENSION_FIXTURES: AnchorageExtension[] = [
  {
    name: "Disk Usage",
    publisher: "Anchorage Labs",
    description:
      "Break down image, volume and build-cache footprint layer by layer.",
    rating: "4.8",
    installs: "2.1M",
  },
  {
    name: "Logs Explorer",
    publisher: "Anchorage Labs",
    description:
      "Query and correlate logs across every running container at once.",
    rating: "4.6",
    installs: "1.4M",
  },
  {
    name: "Trivy Scanner",
    publisher: "Aqua Security",
    description:
      "Scan images for CVEs, misconfigurations and leaked secrets.",
    rating: "4.9",
    installs: "3.8M",
  },
  {
    name: "Compose Watch",
    publisher: "Community",
    description: "Hot-reload services when files in the build context change.",
    rating: "4.3",
    installs: "640k",
  },
  {
    name: "Registry Mirror",
    publisher: "Harbor",
    description: "Pull-through cache for private and upstream registries.",
    rating: "4.1",
    installs: "310k",
  },
  {
    name: "k3s Sandbox",
    publisher: "Rancher",
    description:
      "Single-node Kubernetes wired to the local engine socket.",
    rating: "4.7",
    installs: "980k",
  },
];

export const DEFAULT_ENGINE_RESOURCES: EngineResources = {
  cpus: 8,
  memoryGb: 16,
  swapGb: 2,
  diskGb: 96,
};

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  kubernetes: false,
  automaticUpdates: true,
  betaChannel: false,
  buildkit: true,
  binaryEmulation: true,
  telemetry: false,
};

export const DAEMON_JSON_FIXTURE = `{
  "builder": {
    "gc": { "defaultKeepStorage": "20GB", "enabled": true }
  },
  "experimental": false,
  "features": { "containerd-snapshotter": true },
  "registry-mirrors": ["https://mirror.internal.acme.dev"],
  "insecure-registries": ["registry.local:5000"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "default-address-pools": [
    { "base": "172.28.0.0/16", "size": 24 }
  ]
}`;

const HTTP_LOGS: Array<[LogLine["level"], string]> = [
  ["INFO", "GET /v1/health 200 1.4ms"],
  ["WARN", "upstream inventory-svc slow (812ms)"],
  ["INFO", "GET /v1/orders?page=2 200 21ms"],
  ["INFO", "POST /v1/sessions 201 38ms"],
  ["ERROR", "POST /v1/webhooks 502 upstream refused"],
  ["INFO", "GET /v1/users/me 200 6ms"],
];

const KIND_LOGS: Record<string, Array<[LogLine["level"], string]>> = {
  http: HTTP_LOGS,
  pg: [
    ["LOG", "checkpoint starting: time"],
    ["LOG", "checkpoint complete: wrote 214 buffers"],
    ["LOG", 'automatic vacuum of table "public.orders"'],
    ["LOG", "connection authorized: user=app database=core"],
    ["WARN", "temporary file: size 4194304"],
  ],
  redis: [
    ["INFO", "10 changes in 300 seconds. Saving..."],
    ["INFO", "Background saving started by pid 41"],
    ["INFO", "DB saved on disk"],
    ["INFO", "Background saving terminated with success"],
  ],
  worker: [
    ["INFO", "job#8241 media.transcode started"],
    ["INFO", "job#8241 completed in 4.1s"],
    ["WARN", "retry 2/5 for job#8239 (timeout)"],
    ["ERROR", "job#8239 failed: deadline exceeded"],
    ["INFO", "queue depth 12"],
  ],
  nginx: [
    ["INFO", '10.0.0.7 "GET / HTTP/1.1" 200 5124'],
    ["INFO", '10.0.0.9 "GET /assets/app.js" 200 214880'],
    ["WARN", "client closed connection while reading"],
    ["INFO", "reopening logs after signal"],
  ],
};

const pad = (value: number) => String(value).padStart(2, "0");

export function createFixtureLogs(container: AnchorageContainer): LogLine[] {
  if (container.state !== "running") return [];

  const source = KIND_LOGS[container.kind] ?? HTTP_LOGS;
  return Array.from({ length: 36 }, (_, index) => {
    const seconds = 32 + index * 1.1;
    const minuteOffset = Math.floor(seconds / 60);
    const second = seconds % 60;
    const [level, message] = source[index % source.length];
    return {
      id: `${container.id}-${index}`,
      timestamp: `19:${pad(25 + minuteOffset)}:${second
        .toFixed(3)
        .padStart(6, "0")}`,
      level,
      message,
    };
  });
}

export function cloneContainers(
  containers: AnchorageContainer[] = CONTAINER_FIXTURES,
): AnchorageContainer[] {
  return containers.map((container) => ({
    ...container,
    cpuHistory: [...container.cpuHistory],
    memoryHistory: [...container.memoryHistory],
  }));
}
