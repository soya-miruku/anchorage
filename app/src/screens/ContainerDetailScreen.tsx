import { RebindPortsDialog } from "../components/RebindPortsDialog";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { AnchorageIcon } from "../components/AnchorageIcon";
import { ArchivePathDialog } from "../components/ArchivePathDialog";
import {
  TerminalSurface,
  type OutputChunk,
  type OutputSurface,
} from "../components/CommandCenter";
import { ContainerFilesPanel } from "../components/ContainerFilesPanel";
import { DeleteContainerDialog } from "../components/DeleteContainerDialog";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type {
  AnchorageContainer,
  DetailTab,
  SessionEvent,
} from "../types";
import {
  canOfferRemove,
  canRestartContainer,
  formatMemory,
  primaryContainerAction,
  removeUnavailableReason,
  requiresForceRemove,
  statusDetail,
  statusKind,
  statusLabel,
} from "../utils/containerPresentation";

const tabs: Array<{ id: DetailTab; label: string }> = [
  { id: "logs", label: "Logs" },
  { id: "inspect", label: "Inspect" },
  { id: "mounts", label: "Bind mounts" },
  { id: "exec", label: "Exec" },
  { id: "files", label: "Files" },
  { id: "processes", label: "Processes" },
  { id: "changes", label: "Changes" },
  { id: "stats", label: "Stats" },
];

const mounts = [
  {
    type: "volume",
    source: "core_pgdata",
    destination: "/var/lib/data",
    mode: "rw",
    writable: "true",
  },
  {
    type: "bind",
    source: "/home/dev/acme/platform/src",
    destination: "/srv/src",
    mode: "rw",
    writable: "true",
  },
  {
    type: "bind",
    source: "/etc/acme/certs",
    destination: "/run/certs",
    mode: "ro",
    writable: "false",
  },
];

const files = [
  ["bin", "drwxr-xr-x", "4.0K", "2026-04-11 09:22", true],
  ["etc", "drwxr-xr-x", "4.0K", "2026-07-28 14:03", true],
  ["srv", "drwxr-xr-x", "4.0K", "2026-08-01 06:40", true],
  ["srv/dist", "drwxr-xr-x", "4.0K", "2026-08-01 06:41", true],
  ["srv/dist/server.js", "-rw-r--r--", "218K", "2026-08-01 06:41", false],
  ["srv/package.json", "-rw-r--r--", "2.1K", "2026-08-01 06:38", false],
  ["srv/node_modules", "drwxr-xr-x", "4.0K", "2026-08-01 06:39", true],
  ["tmp", "drwxrwxrwt", "4.0K", "2026-08-02 11:15", true],
  ["var/log/app.log", "-rw-r--r--", "1.4M", "2026-08-02 11:18", false],
] as const;

const decodeSessionOutput = (
  event: Extract<SessionEvent, { event: "session.output" }>,
) => {
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

function DetailCapabilityState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="detail-capability-state" role="status">
      <strong>{title}</strong>
      <p>{message}</p>
      {action && (
        <button
          className="primary-button detail-capability-state__action"
          type="button"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function DetailHeader({
  store,
  container,
}: {
  store: AnchorageStore;
  container: AnchorageContainer;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(container.name);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitRepo, setCommitRepo] = useState("");
  const [commitTag, setCommitTag] = useState("latest");
  const [exportOpen, setExportOpen] = useState(false);
  // Export shares the single transfer session with image save/load and pull.
  const exportRunning =
    store.imageTransfer?.status === "starting" ||
    store.imageTransfer?.status === "running";
  const [memoryMb, setMemoryMb] = useState("");
  /**
   * `""` means "leave the policy alone"; `"no"` is Docker's own policy of that name.
   *
   * These were the same value, so the one option an operator picks to stop a container
   * restarting was indistinguishable from not having touched the field, and was dropped before
   * the patch was built. The core has always treated them as distinct — `allowedRestartPolicies`
   * in core/internal/core/domain.go accepts both.
   */
  const [restartPolicy, setRestartPolicy] = useState<
    "" | "no" | "always" | "unless-stopped" | "on-failure"
  >("");
  /**
   * What the Resources dialog would actually send.
   *
   * Derived once so the Apply button and the submit handler cannot disagree. An untouched form
   * produces an empty patch, and `docker update` with no flags is a usage error — so Apply is
   * disabled rather than left enabled to fail.
   */
  const limitsMegabytes = Number(memoryMb.trim());
  const limitsPatch = {
    ...(Number.isFinite(limitsMegabytes) && limitsMegabytes > 0
      ? { memoryBytes: Math.round(limitsMegabytes) * 1024 * 1024 }
      : {}),
    ...(restartPolicy !== "" ? { restartPolicy } : {}),
  };
  const limitsEmpty = Object.keys(limitsPatch).length === 0;

  const removeBlocked = removeUnavailableReason(container);
  const kind = statusKind(container);
  const primaryAction = primaryContainerAction(container);
  const isRunning = primaryAction === "stop";
  const isPending = store.pendingIds.has(container.id);
  // "Serving" rather than "running": a paused container is running by Docker's own reckoning,
  // but its processes are frozen and it answers nothing, so replacing it interrupts no traffic.
  const isServing = isRunning && container.rawState !== "paused";
  const [rebindOpen, setRebindOpen] = useState(false);

  return (
    <>
    {rebindOpen && (
      <RebindPortsDialog
        container={container}
        pending={isPending}
        onCancel={() => setRebindOpen(false)}
        onConfirm={(ports) => {
          setRebindOpen(false);
          void store.rebindPorts(container.id, ports);
        }}
      />
    )}
    <header className="detail-header">
      <button
        className="detail-header__back"
        type="button"
        onClick={() => store.setSelectedId(null)}
      >
        <AnchorageIcon name="back" size={11} />
        All containers
      </button>
      <div className="detail-header__identity">
        <span
          className={`status-dot status-dot--${kind} status-dot--large`}
          aria-hidden="true"
        />
        {renaming && store.isHost ? (
          <form
            className="detail-rename"
            onSubmit={(event) => {
              event.preventDefault();
              setRenaming(false);
              void store.renameContainer(container, draftName);
            }}
          >
            <input
              data-testid="container-rename-input"
              value={draftName}
              onChange={(event) => setDraftName(event.currentTarget.value)}
              aria-label="Container name"
              autoFocus
              onBlur={() => setRenaming(false)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setRenaming(false);
              }}
            />
          </form>
        ) : (
          <h1
            data-testid="container-title"
            onDoubleClick={() => {
              if (!store.isHost) return;
              setDraftName(container.name);
              setRenaming(true);
            }}
            title={store.isHost ? "Double-click to rename" : undefined}
          >
            {container.name}
          </h1>
        )}
        <span className="detail-header__image">{container.image}</span>
        <span
          className={`status-pill status-pill--${kind}`}
          title={statusDetail(container) ?? undefined}
        >
          {statusLabel(container)}
        </span>
        <div className="detail-header__actions">
          {/* Only offered when the container is not serving. Docker fixes bindings at creation,
              so this replaces the container — doing that to something still answering requests
              would drop traffic without warning. Paused counts as not serving: its processes are
              frozen. The core refuses a running container regardless of what this shows. */}
          {store.isHost && !isServing && (
            <button
              className="detail-action"
              type="button"
              data-testid="detail-rebind-ports"
              disabled={isPending}
              title="Republish this container's ports by replacing it"
              onClick={() => setRebindOpen(true)}
            >
              Ports
            </button>
          )}
          <button
            className={`detail-action detail-action--toggle${
              isRunning ? " detail-action--stop" : ""
            }`}
            type="button"
            disabled={isPending || primaryAction === null}
            onClick={() => void store.toggleContainer(container)}
          >
            {/*
              `unpause` was missing here while the handler and the disabled binding both
              understood it, so a paused container showed an enabled button reading
              "Unavailable" that unpaused the container when pressed. "Unavailable" is now
              reachable only when there is genuinely no action, which is also the only case the
              disabled binding covers.
            */}
            {isRunning
              ? "Stop"
              : primaryAction === "start"
                ? "Start"
                : primaryAction === "unpause"
                  ? "Resume"
                  : "Unavailable"}
          </button>
          <button
            className="detail-action"
            type="button"
            disabled={isPending || !canRestartContainer(container)}
            onClick={() => void store.restartContainer(container)}
          >
            Restart
          </button>
          {store.isHost && (
            <button
              className="detail-action"
              type="button"
              data-testid="container-commit-open"
              onClick={() => {
                setCommitRepo("");
                setCommitTag("latest");
                setCommitOpen(true);
              }}
            >
              Commit
            </button>
          )}
          {store.isHost && (
            <button
              className="detail-action"
              type="button"
              data-testid="container-export-open"
              disabled={exportRunning}
              title="Write this container's filesystem to a tar archive"
              onClick={() => setExportOpen(true)}
            >
              Export
            </button>
          )}
          {store.isHost && (
            <button
              className="detail-action"
              type="button"
              data-testid="container-limits-open"
              onClick={() => {
                setMemoryMb("");
                setRestartPolicy("");
                setLimitsOpen(true);
              }}
            >
              Resources
            </button>
          )}
          <button
            className="detail-action detail-action--delete"
            type="button"
            title={
              removeBlocked ??
              (requiresForceRemove(container) ? "Force delete" : "Delete")
            }
            disabled={isPending || !canOfferRemove(container)}
            onClick={() => setDeleteOpen(true)}
          >
            {requiresForceRemove(container) ? "Force delete" : "Delete"}
          </button>
        </div>
      </div>
      {exportOpen && (
        <ArchivePathDialog
          testId="container-export-dialog"
          title="Export filesystem"
          description="Writes this container's filesystem to a flat tar. Unlike Commit, layers and image configuration are not preserved, so the archive cannot be run directly."
          placeholder="/home/you/exports/api-filesystem.tar"
          confirmLabel="Export"
          allowOverwrite
          busy={exportRunning}
          onCancel={() => setExportOpen(false)}
          onConfirm={(archivePath, overwrite) => {
            setExportOpen(false);
            void store.exportContainerArchive(container, archivePath, overwrite);
          }}
        />
      )}
      {commitOpen && (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="create-environment-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="container-commit-title"
            data-testid="container-commit-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              const repository = commitRepo.trim();
              if (!repository) return;
              setCommitOpen(false);
              void store.commitContainer(container, {
                repository,
                ...(commitTag.trim() ? { tag: commitTag.trim() } : {}),
                // Pausing gives a consistent filesystem, which is what Docker defaults to.
                pause: true,
              });
            }}
          >
            <div className="create-environment-dialog__heading">
              <div>
                <h2 id="container-commit-title">Commit to an image</h2>
                <p>
                  Creates a new image from this container&rsquo;s current filesystem.
                  The container is paused briefly for consistency.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close commit"
                onClick={() => setCommitOpen(false)}
              >
                <AnchorageIcon name="delete" size={13} />
              </button>
            </div>
            <label>
              <span>Repository</span>
              <input
                data-testid="container-commit-repository"
                value={commitRepo}
                onChange={(event) => setCommitRepo(event.currentTarget.value)}
                placeholder="team/api"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </label>
            <label>
              <span>Tag</span>
              <input
                data-testid="container-commit-tag"
                value={commitTag}
                onChange={(event) => setCommitTag(event.currentTarget.value)}
                placeholder="latest"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="create-environment-dialog__actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setCommitOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={!commitRepo.trim()}
              >
                Commit
              </button>
            </div>
          </form>
        </div>
      )}

      {limitsOpen && (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="create-environment-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="container-limits-title"
            data-testid="container-limits-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              if (limitsEmpty) return;
              setLimitsOpen(false);
              void store.updateContainer(container, limitsPatch);
            }}
          >
            <div className="create-environment-dialog__heading">
              <div>
                <h2 id="container-limits-title">Resources</h2>
                <p>
                  Applies live with <code>docker update</code>. Empty fields are left
                  unchanged.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close resources"
                onClick={() => setLimitsOpen(false)}
              >
                <AnchorageIcon name="delete" size={13} />
              </button>
            </div>
            <label>
              <span>Memory limit (MB)</span>
              <input
                data-testid="container-limits-memory"
                value={memoryMb}
                onChange={(event) => setMemoryMb(event.currentTarget.value)}
                placeholder="e.g. 512 — minimum 6"
                inputMode="numeric"
                autoComplete="off"
              />
            </label>
            <label>
              <span>Restart policy</span>
              <select
                data-testid="container-limits-restart"
                value={restartPolicy}
                onChange={(event) =>
                  setRestartPolicy(
                    event.currentTarget.value as typeof restartPolicy,
                  )
                }
              >
                <option value="">Unchanged</option>
                <option value="no">No — do not restart</option>
                <option value="on-failure">On failure</option>
                <option value="unless-stopped">Unless stopped</option>
                <option value="always">Always</option>
              </select>
            </label>
            <div className="create-environment-dialog__actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setLimitsOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                data-testid="container-limits-apply"
                disabled={limitsEmpty}
              >
                Apply
              </button>
            </div>
          </form>
        </div>
      )}

      {deleteOpen && (
        <DeleteContainerDialog
          container={container}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={(options) => {
            setDeleteOpen(false);
            void store.deleteContainer(container, options);
          }}
        />
      )}
      <nav className="detail-tabs" aria-label="Container details">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={
              store.detailTab === tab.id ? "detail-tab detail-tab--active" : "detail-tab"
            }
            type="button"
            aria-current={store.detailTab === tab.id ? "page" : undefined}
            onClick={() => store.setDetailTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </header>
    </>
  );
}

function LogsPanel({ store }: { store: AnchorageStore }) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!store.followLogs || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [store.followLogs, store.visibleLogs]);

  return (
    <div className="logs-panel">
      <div className="logs-toolbar">
        <label className="logs-filter">
          <span className="sr-only">Filter logs</span>
          <AnchorageIcon name="search" size={12} />
          <input
            value={store.logFilter}
            onChange={(event) => store.setLogFilter(event.currentTarget.value)}
            placeholder="Filter logs"
            spellCheck={false}
          />
        </label>
        <button
          className={`logs-toolbar__button${
            store.followLogs ? " logs-toolbar__button--active" : ""
          }`}
          type="button"
          aria-pressed={store.followLogs}
          onClick={() => store.setFollowLogs(!store.followLogs)}
        >
          <span aria-hidden="true" />
          Follow
        </button>
        <button
          className="logs-toolbar__button logs-toolbar__button--clear"
          type="button"
          onClick={store.clearLogs}
        >
          Clear
        </button>
      </div>
      <div className="log-output" ref={logRef} data-testid="container-logs">
        {store.selectedDetailErrors.logs && (
          <div className="detail-inline-error" role="status">
            Logs unavailable: {store.selectedDetailErrors.logs}
          </div>
        )}
        {store.visibleLogs.length > 0 ? (
          store.visibleLogs.map((line) => (
            <div className="log-line" key={line.id}>
              <time>{line.timestamp}</time>
              <span className={`log-level log-level--${line.level.toLowerCase()}`}>
                {line.level}
              </span>
              <span>{line.message}</span>
            </div>
          ))
        ) : (
          <span className="log-output__empty">— no log output —</span>
        )}
      </div>
    </div>
  );
}

function InspectPanel({
  store,
  container,
}: {
  store: AnchorageStore;
  container: AnchorageContainer;
}) {
  if (store.isHost) {
    if (store.selectedDetailErrors.inspect) {
      return (
        <DetailCapabilityState
          title="Inspect unavailable"
          message={store.selectedDetailErrors.inspect}
        />
      );
    }
    if (!store.selectedInspect) {
      return (
        <DetailCapabilityState
          title="Loading inspect data"
          message="Waiting for the selected Docker context."
        />
      );
    }
    return (
      <div className="detail-scroll-panel">
        <pre className="inspect-output">
          {JSON.stringify(store.selectedInspect.document, null, 2)}
        </pre>
      </div>
    );
  }
  const payload = JSON.stringify(
        {
          Id: `${container.id}e3f19a2b74c05d8813`,
          Name: `/${container.name}`,
          Created: "2026-07-28T09:14:22.104Z",
          State: {
            Status: container.state,
            Running: container.state === "running",
            Pid: container.state === "running" ? 41290 : 0,
            ExitCode: 0,
            Health: {
              Status: container.health,
              FailingStreak: container.health === "unhealthy" ? 3 : 0,
            },
          },
          Config: {
            Image: container.image,
            Hostname: container.id,
            Env: ["NODE_ENV=production", "PORT=8080"],
            Cmd: ["node", "dist/server.js"],
            WorkingDir: "/srv",
          },
          HostConfig: {
            NetworkMode: "acme_default",
            RestartPolicy: { Name: "unless-stopped" },
            Memory: (container.memoryLimit ?? 0) * 1048576,
            NanoCpus: 2000000000,
          },
          NetworkSettings: {
            IPAddress: "172.28.0.4",
            Ports: container.ports,
          },
        },
        null,
        2,
      );

  return (
    <div className="detail-scroll-panel">
      <pre className="inspect-output">{payload}</pre>
    </div>
  );
}

function MountsPanel({ store }: { store: AnchorageStore }) {
  const rows = store.isHost
    ? (store.selectedInspect?.container.mounts ?? []).map((mount) => ({
        type: mount.type ?? "unknown",
        source: mount.source ?? mount.name ?? "Unavailable",
        destination: mount.destination ?? "Unavailable",
        mode: mount.mode ?? (mount.rw ? "rw" : "ro"),
        writable: String(mount.rw),
      }))
    : mounts;
  if (store.isHost && store.selectedDetailErrors.mounts) {
    return (
      <DetailCapabilityState
        title="Mounts unavailable"
        message={store.selectedDetailErrors.mounts}
      />
    );
  }
  if (store.isHost && !store.selectedInspect) {
    return (
      <DetailCapabilityState
        title="Loading mounts"
        message="Waiting for the container inspect projection."
      />
    );
  }
  return (
    <div className="detail-scroll-panel">
      <div className="mount-table">
        <div className="mount-table__head">
          <span>TYPE</span>
          <span>SOURCE</span>
          <span>DESTINATION</span>
          <span>MODE</span>
          <span>RW</span>
        </div>
        {rows.map((mount) => (
          <div className="mount-table__row" key={`${mount.type}-${mount.source}`}>
            <span className={`mount-type mount-type--${mount.type}`}>
              {mount.type}
            </span>
            <span title={mount.source}>{mount.source}</span>
            <span>{mount.destination}</span>
            <span>{mount.mode}</span>
            <span>{mount.writable}</span>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="mount-table__empty">No mounts configured.</div>
        )}
      </div>
    </div>
  );
}

interface TerminalLine {
  id: number;
  text: string;
  tone: "command" | "output" | "muted";
}

function commandOutput(command: string, container: AnchorageContainer) {
  const value = command.trim();
  if (!value) return [];
  if (value === "ls" || value === "ls -la")
    return ["bin   dev   etc   lib   proc  srv   tmp   usr   var"];
  if (value === "pwd") return ["/srv"];
  if (value === "whoami") return [container.kind === "pg" ? "postgres" : "root"];
  if (value === "ps" || value === "ps aux")
    return [
      "PID   USER     TIME  COMMAND",
      "    1 root      0:12  node dist/server.js",
      "   28 root      0:00  /bin/sh",
      "   34 root      0:00  ps",
    ];
  if (value === "env")
    return [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/bin",
      "NODE_ENV=production",
      `HOSTNAME=${container.name}`,
      "PORT=8080",
    ];
  if (value === "df -h")
    return [
      "Filesystem      Size  Used Avail Use% Mounted on",
      "overlay          59G   21G   35G  38% /",
      "tmpfs            64M     0   64M   0% /dev",
    ];
  if (value.startsWith("cat /etc/os-release"))
    return [
      'NAME="Alpine Linux"',
      "ID=alpine",
      "VERSION_ID=3.20.2",
      'PRETTY_NAME="Alpine Linux v3.20"',
    ];
  if (value.startsWith("echo ")) return [value.slice(5)];
  if (value === "uname -a")
    return [
      `Linux ${container.name} 6.10.4-anchorage #1 SMP x86_64 Linux`,
    ];
  if (value === "exit") return ["exit — session detached"];
  return [`sh: ${value.split(" ")[0]}: not found`];
}

function ExecPanel({ container }: { container: AnchorageContainer }) {
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<TerminalLine[]>([
    {
      id: 0,
      text: "Attached to /bin/sh — Ctrl-D to detach",
      tone: "muted",
    },
  ]);
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [lines]);

  const run = () => {
    const command = input;
    setInput("");
    if (command.trim() === "clear") {
      setLines([]);
      return;
    }
    const output = commandOutput(command, container);
    const next: TerminalLine[] = [
      {
        id: nextId.current++,
        text: `$ ${command}`,
        tone: "command",
      },
      ...output.map(
        (text): TerminalLine => ({
          id: nextId.current++,
          text,
          tone: "output",
        }),
      ),
    ];
    setLines((current) => [...current, ...next].slice(-300));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") run();
  };

  return (
    <div className="exec-panel">
      <p>
        $ anchor exec -it {container.name} /bin/sh — try: ls, ps, env, whoami,
        cat /etc/os-release, df -h
      </p>
      <div
        className="terminal-output"
        ref={terminalRef}
        role="application"
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((line) => (
          <div className={`terminal-line terminal-line--${line.tone}`} key={line.id}>
            {line.text}
          </div>
        ))}
        <label className="terminal-prompt">
          <span>/srv #</span>
          <span className="sr-only">Container shell command</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
      </div>
    </div>
  );
}

function HostExecPanel({
  store,
  container,
}: {
  store: AnchorageStore;
  container: AnchorageContainer;
}) {
  // Docker Desktop lets you pick the shell and the user; a hardcoded /bin/sh simply fails on
  // images that do not ship one, with no way for the user to recover.
  const [shell, setShell] = useState("/bin/sh");
  const [user, setUser] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [chunks, setChunks] = useState<OutputChunk[]>([]);
  const [status, setStatus] = useState<
    "starting" | "running" | "exited" | "unavailable"
  >("starting");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ rows: 30, cols: 120 });
  const ownerRef = useRef<string | null>(null);
  const sinkRef = useRef<OutputSurface | null>(null);

  useEffect(() => {
    if (container.state !== "running") {
      setStatus("unavailable");
      setSessionError("Exec requires a running container.");
      return;
    }
    let disposed = false;
    let pending: SessionEvent[] = [];
    setChunks([]);
    const accept = (event: SessionEvent) => {
      if (event.event === "session.output") {
        // Feed the terminal emulator directly so ANSI escapes, carriage returns and
        // bracketed paste render as a terminal rather than as literal text.
        const chunk = {
          payload: event.payload,
          text: decodeSessionOutput(event),
        };
        // Always retain the chunk: TerminalSurface renders it only when xterm could not be
        // loaded, so there is no double display when the emulator is live.
        setChunks((current) => [...current.slice(-199), chunk]);
        sinkRef.current?.write(chunk);
      } else if (event.event === "session.output.truncated") {
        setSessionError(
          `${event.payload.droppedBytes.toLocaleString()} terminal bytes were dropped.`,
        );
      } else if (event.event === "session.error") {
        setSessionError(`${event.payload.code}: ${event.payload.message}`);
      } else if (event.event === "session.exited") {
        setStatus("exited");
      }
    };
    const unsubscribe = store.bridge.sessions.subscribe((event) => {
      const owner = ownerRef.current;
      if (!owner) {
        pending = [...pending.slice(-99), event];
        return;
      }
      if (event.payload.sessionId === owner) accept(event);
    });
    setStatus("starting");
    setSessionError(null);
    const argv = ["exec", "-it"];
    if (user.trim()) argv.push("--user", user.trim());
    argv.push(container.id, shell);
    void store.bridge.sessions
      .start({
        context: store.dockerContext,
        argv,
        mode: "pty",
        rows: dimensions.rows,
        cols: dimensions.cols,
        outputWindowBytes: 64 * 1024,
        maxOutputBytes: 16 * 1024 * 1024,
      })
      .then((result) => {
        if (disposed) {
          void Promise.resolve(
            store.bridge.sessions.cancel({
              sessionId: result.sessionId,
              gracePeriodMs: 500,
            }),
          ).catch(() => undefined);
          return;
        }
        ownerRef.current = result.sessionId;
        setStatus("running");
        const buffered = pending;
        pending = [];
        buffered
          .filter((event) => event.payload.sessionId === result.sessionId)
          .forEach(accept);
      })
      .catch((reason) => {
        if (disposed) return;
        pending = [];
        setStatus("unavailable");
        setSessionError(
          reason instanceof Error
            ? reason.message
            : "Interactive exec is unavailable",
        );
      });
    return () => {
      disposed = true;
      pending = [];
      unsubscribe();
      const owner = ownerRef.current;
      ownerRef.current = null;
      if (owner) {
        void Promise.resolve(
          store.bridge.sessions.cancel({ sessionId: owner, gracePeriodMs: 500 }),
        ).catch(() => undefined);
      }
    };
    // `attempt` re-runs the effect when the user retries with a different shell.
  }, [
    attempt,
    container.id,
    container.state,
    store.bridge,
    store.dockerContext,
  ]);

  const sendInput = (data: string) => {
    const owner = ownerRef.current;
    if (!owner || status !== "running") return;
    void store.bridge.sessions
      .input({ sessionId: owner, data, encoding: "utf-8" })
      .catch((reason) => {
        setSessionError(
          reason instanceof Error ? reason.message : "Terminal input failed",
        );
      });
  };

  const resize = (rows: number, cols: number) => {
    setDimensions({ rows, cols });
    const owner = ownerRef.current;
    if (!owner || status !== "running") return;
    void store.bridge.sessions
      .resize({ sessionId: owner, rows, cols })
      .catch(() => undefined);
  };

  return (
    <div className="exec-panel" data-testid="host-exec-panel">
      <div className="exec-toolbar">
        <label>
          <span className="sr-only">Shell</span>
          <select
            data-testid="exec-shell"
            value={shell}
            onChange={(event) => setShell(event.currentTarget.value)}
          >
            <option value="/bin/sh">/bin/sh</option>
            <option value="/bin/bash">/bin/bash</option>
            <option value="/bin/ash">/bin/ash</option>
            <option value="/bin/zsh">/bin/zsh</option>
          </select>
        </label>
        <label>
          <span className="sr-only">User</span>
          <input
            data-testid="exec-user"
            value={user}
            onChange={(event) => setUser(event.currentTarget.value)}
            placeholder="user (optional)"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className="ghost-button"
          data-testid="exec-restart"
          onClick={() => setAttempt((value) => value + 1)}
        >
          {status === "exited" || status === "unavailable" ? "Start" : "Restart"}
        </button>
        <span className="resource-dim">{status}</span>
      </div>
      {sessionError && (
        <div className="detail-inline-error" role="status">
          Exec: {sessionError}
        </div>
      )}
      <TerminalSurface
        chunks={chunks}
        active={status === "running"}
        mode="pty"
        rows={dimensions.rows}
        cols={dimensions.cols}
        onAccepted={(payload) => {
          void Promise.resolve(
            store.bridge.sessions.ack({
              sessionId: payload.sessionId,
              throughSequence: payload.sequence,
            }),
          ).catch(() => undefined);
        }}
        onInput={sendInput}
        onDimensions={resize}
        registerSink={(sink) => {
          sinkRef.current = sink;
        }}
      />
    </div>
  );
}

function FilesPanel({ container }: { container: AnchorageContainer }) {
  return (
    <div className="detail-scroll-panel">
      <p className="files-path">/ · {container.name}</p>
      <div className="files-table">
        {files.map(([name, permissions, size, modified, directory]) => (
          <div className="files-row" key={name}>
            <span
              className={`file-swatch${directory ? " file-swatch--directory" : ""}`}
              aria-hidden="true"
            />
            <span className={directory ? "file-name--directory" : ""}>{name}</span>
            <span>{permissions}</span>
            <span>{size}</span>
            <span>{modified}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Chart({
  title,
  values,
  max,
  tone,
}: {
  title: string;
  values: number[];
  max: number;
  tone: "cpu" | "memory";
}) {
  return (
    <section className="stats-chart">
      <h2>{title}</h2>
      <div className={`stats-chart__bars stats-chart__bars--${tone}`}>
        {values.slice(-48).map((value, index) => (
          <span
            key={`${title}-${index}`}
            style={{
              height: `${Math.max(2, Math.min(100, (value / max) * 100))}%`,
            }}
          />
        ))}
      </div>
    </section>
  );
}

function StatsPanel({
  store,
  container,
}: {
  store: AnchorageStore;
  container: AnchorageContainer;
}) {
  const history = store.statsHistoryFor(container);
  const cpu = container.cpu ?? 0;
  const memory = container.memory ?? 0;
  const memoryLimit = container.memoryLimit ?? 1;
  const metrics = [
    {
      label: "CPU",
      value: container.state === "running" ? `${cpu.toFixed(1)}%` : "0%",
      sub: "limit 2.0 cores",
      tone: "accent",
    },
    {
      label: "Memory",
      value: formatMemory(memory),
      sub: `of ${formatMemory(memoryLimit)}`,
      tone: "warning",
    },
    {
      label: "Network I/O",
      value: `${(cpu * 3.1).toFixed(0)} KB/s`,
      sub: "↓ rx  ↑ tx",
      tone: "violet",
    },
    {
      label: "Block I/O",
      value: `${(memory / 12).toFixed(1)} MB/s`,
      sub: "overlay2",
      tone: "blue",
    },
  ];

  return (
    <div className="stats-panel">
      <div className="stats-grid">
        {metrics.map((metric) => (
          <section className="stats-card" key={metric.label}>
            <span>{metric.label}</span>
            <strong className={`stats-card__value stats-card__value--${metric.tone}`}>
              {metric.value}
            </strong>
            <small>{metric.sub}</small>
          </section>
        ))}
      </div>
      <Chart
        title="CPU %"
        values={history.cpu}
        max={100}
        tone="cpu"
      />
      <Chart
        title="Memory"
        values={history.memory}
        max={memoryLimit}
        tone="memory"
      />
    </div>
  );
}

function HostStatsPanel({
  store,
  container,
}: {
  store: AnchorageStore;
  container: AnchorageContainer;
}) {
  const history = store.statsHistoryFor(container);
  if (store.selectedDetailErrors.stats) {
    return (
      <DetailCapabilityState
        title="Stats unavailable"
        message={store.selectedDetailErrors.stats}
      />
    );
  }
  const stats = store.selectedStats;
  if (!stats) {
    return (
      <DetailCapabilityState
        title="Loading live stats"
        message="Stats are sampled only while this tab is visible."
      />
    );
  }
  const metrics = [
    {
      label: "CPU",
      value: `${stats.cpuPercent.toFixed(1)}%`,
      sub: `${stats.onlineCpus} online CPUs`,
      tone: "accent",
    },
    {
      label: "Memory",
      value: formatBytes(stats.memoryWorkingSetBytes),
      sub: `of ${formatBytes(stats.memoryLimitBytes)}`,
      tone: "warning",
    },
    {
      label: "Network I/O",
      value: `${formatBytes(stats.networkRxBytes)} ↓`,
      sub: `${formatBytes(stats.networkTxBytes)} ↑`,
      tone: "violet",
    },
    {
      label: "Block I/O",
      value: `${formatBytes(stats.blockReadBytes)} read`,
      sub: `${formatBytes(stats.blockWriteBytes)} written · ${stats.pids} PIDs`,
      tone: "blue",
    },
  ];
  return (
    <div className="stats-panel">
      <div className="stats-grid">
        {metrics.map((metric) => (
          <section className="stats-card" key={metric.label}>
            <span>{metric.label}</span>
            <strong
              className={`stats-card__value stats-card__value--${metric.tone}`}
            >
              {metric.value}
            </strong>
            <small>{metric.sub}</small>
          </section>
        ))}
      </div>
      <Chart
        title="CPU %"
        values={history.cpu}
        max={100}
        tone="cpu"
      />
      <Chart
        title="Memory %"
        values={history.memory}
        max={100}
        tone="memory"
      />
    </div>
  );
}

export function ContainerDetailScreen({ store }: { store: AnchorageStore }) {
  const container = store.selectedContainer;
  if (!container) return null;

  return (
    <section
      className="container-detail screen"
      data-testid="container-detail-screen"
    >
      <DetailHeader store={store} container={container} />
      {store.detailTab === "logs" && <LogsPanel store={store} />}
      {store.detailTab === "inspect" && (
        <InspectPanel store={store} container={container} />
      )}
      {store.detailTab === "mounts" && <MountsPanel store={store} />}
      {store.detailTab === "exec" &&
        (store.isHost ? (
          <HostExecPanel store={store} container={container} />
        ) : (
          <ExecPanel container={container} />
        ))}
      {store.detailTab === "files" &&
        (store.isHost ? (
          <ContainerFilesPanel store={store} />
        ) : (
          <FilesPanel container={container} />
        ))}
      {store.detailTab === "processes" &&
        (store.isHost ? (
          <div className="detail-panel" data-testid="container-processes">
            {store.selectedDetailErrors.processes ? (
              <DetailCapabilityState
                title="Processes unavailable"
                message={store.selectedDetailErrors.processes}
                action={{
                  label: "Open Command Center",
                  onClick: () => store.openCommandCenter("top"),
                }}
              />
            ) : store.processes ? (
              <div className="processes-table">
                <div
                  className="processes-row processes-row--head"
                  style={{
                    gridTemplateColumns: `repeat(${store.processes.titles.length}, minmax(0, 1fr))`,
                  }}
                >
                  {store.processes.titles.map((title) => (
                    <span key={title}>{title}</span>
                  ))}
                </div>
                {store.processes.processes.map((process, index) => (
                  <div
                    className="processes-row"
                    key={`${process.values[0] ?? index}-${index}`}
                    style={{
                      gridTemplateColumns: `repeat(${store.processes?.titles.length ?? 1}, minmax(0, 1fr))`,
                    }}
                  >
                    {process.values.map((value, column) => (
                      <span key={column} className="resource-mono">
                        {value}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <p className="resource-dim" role="status">
                Reading container processes…
              </p>
            )}
          </div>
        ) : (
          <DetailCapabilityState
            title="Processes unavailable"
            message="The deterministic browser preview has no daemon to read processes from."
            action={{
              label: "Open Command Center",
              onClick: () => store.openCommandCenter("top"),
            }}
          />
        ))}
      {store.detailTab === "changes" &&
        (store.isHost ? (
          <div className="detail-panel" data-testid="container-changes">
            {store.selectedDetailErrors.changes ? (
              <DetailCapabilityState
                title="Changes unavailable"
                message={store.selectedDetailErrors.changes}
                action={{
                  label: "Open Command Center",
                  onClick: () => store.openCommandCenter("diff"),
                }}
              />
            ) : store.changes ? (
              store.changes.changes.length === 0 ? (
                <div className="empty-state">
                  <strong>No filesystem changes</strong>
                  <p>Nothing has been written since this container started from its image.</p>
                </div>
              ) : (
                <ul className="changes-list">
                  {store.changes.changes.map((change) => (
                    <li key={change.path} data-kind={change.kind}>
                      <span className={`change-badge change-badge--${change.kind}`}>
                        {change.kind}
                      </span>
                      <code>{change.path}</code>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <p className="resource-dim" role="status">
                Reading filesystem changes…
              </p>
            )}
          </div>
        ) : (
          <DetailCapabilityState
            title="Changes unavailable"
            message="The deterministic browser preview has no daemon to diff against."
            action={{
              label: "Open Command Center",
              onClick: () => store.openCommandCenter("diff"),
            }}
          />
        ))}
      {store.detailTab === "stats" &&
        (store.isHost ? (
          <HostStatsPanel store={store} container={container} />
        ) : (
          <StatsPanel store={store} container={container} />
        ))}
    </section>
  );
}
