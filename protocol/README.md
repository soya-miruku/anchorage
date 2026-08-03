# Anchorage Core protocol v1

The Electron main process launches `core/bin/anchorage-core` and exchanges one
JSON object per UTF-8 line over stdin/stdout. Standard error is diagnostic-only.
Responses may arrive out of order; correlate them with `id`. Notifications have
no `id`.

```json
{"id":"startup-1","method":"health","params":{}}
{"id":"startup-1","result":{"status":"ok","version":"0.1.0","protocolVersion":"1","pid":123,"startedAt":"2026-08-02T12:00:00Z","dockerReady":true}}
```

```json
{"event":"operation.started","payload":{"operationId":"...","method":"cli.run","context":"default","startedAt":"..."}}
```

The exact request and response types are in [types.ts](./types.ts), and the
machine-readable envelope/request contract is in
[v1.schema.json](./v1.schema.json).

## Required safety semantics

- `containers.list`, `containers.action`, `cli.run`, and `session.start`
  require an explicit `context`. For CLI execution, omitted
  `targetMode` normalizes to `pinned`: the core injects
  `docker --context <name>` and rejects Docker target/config/TLS overrides.
- `targetMode: "literal"` keeps `context` as operation and discovery metadata
  but does not inject it. It permits Docker's target/config/TLS global flags
  and `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `DOCKER_TLS`,
  `DOCKER_TLS_VERIFY`, and `DOCKER_CERT_PATH`. The executable remains fixed;
  process-loader, executable-search, home, and askpass injection remain
  rejected in both modes.
- `containers.action.id` must be the full 64-character immutable ID.
- `cli.run.argv` contains Docker arguments only. It cannot select an executable
  and is never passed through a shell.
- `cli.run.cwd` must exist, resolve through symlinks, and remain inside a root
  configured with `--allow-cwd`. If omitted, the core startup directory is used.
  The current Linux desktop launches the core from canonical `$HOME` with
  `--allow-cwd /`, so project-aware commands can use any directory already
  accessible to that user; the allowlist does not bypass Linux permissions.
- Process-loader, executable-search, Docker-target, client-config, and
  credential-helper environment overrides are rejected.
- `interactive: true` and `streaming: true` return `unsupported_mode` in v1.
  Long-lived or interactive commands use `session.start`.
- Captured stdout and stderr are bounded to 1 MiB each. `bytes` reports the
  unbounded byte count; `truncated` says whether `data` is a prefix.
- Non-UTF-8 command output is returned as base64.
- Mutations are never retried. A timeout after submission returns
  `mutation_outcome_unknown` so the UI reconciles state rather than inventing
  success or failure.

## Streaming and terminal sessions

`session.start` executes the same exact fingerprinted Docker binary with the
normalized target mode, validated argv/environment, and an allowlisted working
directory. It returns immediately after the child starts. `mode: "pipes"`
preserves stdout/stderr separation; `mode: "pty"` allocates a real Linux PTY and
merges terminal output into the `pty` stream.

Session control methods are:

- `session.input` — literal UTF-8 or base64 bytes, with optional EOF;
- `session.resize` — PTY rows/columns and `SIGWINCH`;
- `session.signal` — allowlisted process-group signal;
- `session.cancel` — `SIGTERM` plus a bounded grace period, then `SIGKILL`;
- `session.ack` — release output through a sequence number.

The lifecycle is explicit:

1. `session.started`
2. zero or more sequenced `session.output` events
3. optional `session.output.truncated` or `session.error`
4. exactly one `session.exited`

Every session has a raw-byte ACK window (256 KiB by default, configurable from
1 KiB to 8 MiB). Once unacknowledged output fills that window, core pauses reads
and the OS pipes/PTY backpressure the Docker process. The renderer should ACK
only after it has accepted every event through that sequence. Output events from
stdout and stderr share one monotonically increasing sequence, so their observed
ordering is stable.

`maxOutputBytes` is an optional lifetime cap. Zero/omitted keeps output
unlimited while retaining bounded in-flight memory. A nonzero cap explicitly
drains and counts excess output, emits `session.output.truncated`, and reports
the final dropped-byte count in `session.exited`. Cancellation also switches to
drain/discard mode so process cleanup cannot deadlock behind an unresponsive
consumer.

On Linux, every session owns a process group and sets a parent-death signal.
Cancellation and core shutdown target the full group, not only the immediate
Docker process.

## Capability evidence

`system.capabilities` fingerprints the resolved executable and returns raw
evidence for version, info, contexts, and every recursively discovered help
node. A command node is `available` only when the exact executable's help probe
succeeds. `transports` records whether Anchorage has a native Unix Engine API
path, the exact CLI path, or both. `commandInventory.complete` must be true
before an exhaustive parity ledger can claim coverage.

## Structured Docker domains

Protocol v1 also exposes the typed data needed by Anchorage's first-class
screens:

- `system.snapshot` — negotiated Engine `/info` plus exact `/system/df` records;
- `containers.inspect` — a stable projection plus the exact inspect document;
- `containers.stats` — one-shot numeric CPU, memory, network, block-I/O, and PID
  counters plus the exact stats document;
- `images.list` and `images.action` (`remove`, `prune`, `pull`);
- `volumes.list` and `volumes.action` (`create`, `remove`, `prune`).

Every method requires an explicit context. Local Unix contexts use the
negotiated Engine API. Inspect and list methods can use exact Docker
`--format '{{json .}}'` output for other context transports and return a
`limitations` entry where the CLI only exposes display-formatted values.
`system.snapshot` and `containers.stats` return
`context_transport_unsupported` instead of guessing numeric values from human
units on transports without a directly reachable Engine endpoint.

Image pull deliberately runs as a `cli-session`: registry credential helpers,
Docker configuration, progress semantics, cancellation, backpressure, and exit
status therefore match the installed fingerprinted CLI. The returned
`sessionId` is controlled through the ordinary `session.*` methods.

Destructive container/image/volume remove and image/volume prune requests
require `confirmed: true`.
Image removal additionally requires the full immutable
`sha256:<64 hexadecimal characters>` ID; container inspect/stats/actions require
the full immutable 64-character container ID. Mutations are never retried. They
produce a typed receipt and then emit `reconciliation.requested`; a timeout
after submission returns `mutation_outcome_unknown` and emits
`reconciliation.required`.
