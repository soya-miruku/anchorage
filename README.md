# Anchorage

Anchorage is a Linux desktop interface for the Docker installation already on
the machine. It combines fast, native Engine API workflows with an exact
literal-argument pipes/PTY route for every recursively discovered canonical
advertised leaf of the installed Docker CLI and its advertised plugins. That
is transport reachability, not a claim that every leaf was behaviorally
executed. Hidden commands and aliases are not enumerated; a user who knows one
can still enter its literal argv and delegate it to the installed CLI.

In normal browser and Electron use, the renderer fills the available viewport
and resizes with it. Electron opens with a 1600 x 1000 content area and permits
resizing down to 1080 x 700. The fixed 1656 x 1056 design canvas, including its
28px desk around a 1600 x 1000 application, is used only by `?capture=...` URLs
for canonical handoff comparison.

## Run the packaged application

The Linux AppImage is built at:

```text
app/release/Anchorage-0.1.0-x86_64.AppImage
```

Treat that file as a release candidate only after `npm run package:linux`
finishes successfully and
`app/release/release-verification.json` reports `"status": "passed"`. The
receipt binds the exact AppImage, unpacked application, extracted AppImage
payload, renderer, core, Electron runtime, and release evidence; an
electron-builder output without that receipt is only an intermediate artifact.

Make sure the Docker daemon is available to the current user, then launch the
AppImage directly. Anchorage uses the same Docker executable, contexts,
credentials, plugins, and daemon permissions as the terminal user.

## Product surfaces

- Dashboard, Containers, container logs/inspect/mounts/exec/stats, Images, and
  Volumes are live first-class Docker workflows. They use the Engine API where
  it preserves Docker semantics and improves latency.
- The Command Center opens with `Ctrl/Cmd+Shift+P`, inventories the exact
  recursively discovered canonical advertised command tree, and runs literal
  argument arrays through pipes or a real PTY. This is the coverage path for
  Compose, Scout, interactive commands, and discovered long-tail CLI and
  plugin leaves without invoking a shell.
- Pinned targeting injects the visibly selected Docker context and blocks
  target overrides. Explicit literal targeting permits Docker's own
  context/host/config/TLS flags and environment variables while still fixing
  the executable and rejecting loader, PATH, HOME, and askpass injection.
- Capability-unavailable features are reported explicitly. Browser development
  previews use deterministic fixtures for design QA; the packaged desktop
  bridge uses live Docker data and never labels fixture data as live.
- Settings > Appearance provides Default, Docker, and GitHub theme families in
  both Light and Dark modes. The renderer applies the palettes through one
  semantic token contract and stores the choice locally when browser storage is
  available. If storage is unavailable or a write fails, the selected theme
  continues for the current renderer session and the UI reports it as
  session-only.
- The handoff's Builds, Dev Environments, Extensions, Settings, and container
  Files states remain part of canonical visual QA. Where the installed Engine
  and CLI do not expose the Docker Desktop data behind them, host mode shows an
  explicit unavailable state. When a relevant installed command exists it is
  available through Command Center; Anchorage does not invent an equivalent
  where Docker exposes none.

## Architecture

```text
React renderer
  -> sandboxed Electron preload
  -> private JSON Lines RPC
  -> standard-library Go core
     -> negotiated Docker Engine API
     -> fingerprinted installed Docker CLI and plugins
```

The renderer has no Node.js, filesystem, process, or Docker socket access.
Electron enables context isolation and sandboxing and denies renderer
navigation, popups, downloads, and permissions. The core injects the selected
Docker context, executes an argument vector without shell interpolation, caps
captured output, applies stream backpressure, and targets mutations by immutable
Docker IDs.

On Linux the BrowserWindow is frameless (`frame: false`), so Anchorage's own
draggable titlebar and main-process window controls are the only titlebar. The
small platform shadow and extended native resize boundary are intentionally
retained so the user can resize from the window edges. The renderer also
synchronizes the native window background to the active theme so resizing does
not reveal a differently coloured backing surface.

More detail is in [docs/architecture.md](docs/architecture.md) and the release
criteria are in
[docs/parity-and-release-gates.md](docs/parity-and-release-gates.md).

## Development

Prerequisites:

- a working Docker CLI and daemon;
- Go 1.25 or newer;
- Node.js 20.11 or newer, plus npm.

Install renderer dependencies and run the complete desktop development stack:

```bash
cd app
npm ci
npm run dev:desktop
```

The development launcher chooses an unused local port and proves that the
Electron process is loading the matching Vite instance. It fails closed instead
of attaching to an unrelated process already occupying a port.

Run a browser-only design preview:

```bash
cd app
npm run dev
```

The browser preview intentionally uses deterministic fixtures because no
privileged preload bridge exists in a web page.

Ordinary preview URLs use the resizable viewport layout. URLs with a
`?capture=<state>` query switch to the fixed canonical canvas, force
Default/Dark without reading or writing the saved appearance, and omit the new
Appearance settings row so the original 24-state handoff remains comparable.

## Verification

```bash
cd core
go test -race ./...
go vet ./...
go build -o bin/anchorage-core ./cmd/anchorage-core

cd ../app
npm test
npm run typecheck:renderer
npm run build
npm run package:preflight
npm run package:linux
```

Generate a capability ledger from the current Docker installation:

```bash
node tools/generate-capability-ledger.mjs
```

The command writes the raw discovery evidence and one row per discovered
canonical advertised leaf command to `artifacts/docker/`. A
`transport-covered` row means the command is installed and has a
literal-argument pipes/PTY route through Anchorage. It does not mean that
arbitrary or destructive commands were mass-executed, and it is kept separate
from operation-level behavioral conformance.

Visual source, actual captures, and paired comparisons live under
`docs/design_handoff_anchorage/` and `docs/design-qa/`.

Generate the remaining release evidence:

```bash
ANCHORAGE_ACCEPTANCE_MUTATIONS=1 node tools/run-core-acceptance.mjs
node tools/run-performance-evidence.mjs
node tools/generate-security-evidence.mjs
```

The performance command is an authoritative 30-minute soak by default. Package
preflight rejects shortened evidence, a different core or harness hash,
incomplete command/design matrices, failed cleanup, or stale source inputs.

## Packaging

`npm run package:linux` creates the AppImage and an unpacked Linux directory,
bundling a freshly built, stripped, hash-verified Go core. The AppImage is an
unsigned local build; release signing requires a project-owned signing key.

A `.deb` is intentionally not emitted until the project has a canonical
homepage for package metadata.
