# Anchorage Core

`anchorage-core` is the privileged Docker boundary for Anchorage. It is a
Go 1.25, standard-library-only process. The renderer never receives filesystem,
shell, Docker socket, or arbitrary process access.

Build the Electron development binary from this directory:

```sh
go build -o bin/anchorage-core ./cmd/anchorage-core
```

Run the verification suite without contacting a real daemon:

```sh
go test ./...
go vet ./...
```

The tests use generated fake Docker executables and temporary Unix sockets.

## Boundary design

- The Docker executable is resolved once, symlinks are resolved, and the exact
  file is SHA-256 fingerprinted. All CLI calls execute that resolved file
  directly with an argv vector and no shell.
- Capability discovery is read-only and never calls `docker context use`.
  Version, info, context, plugin, and recursive command-help probes have hard
  deadlines and retain raw evidence.
- Local `unix://` contexts use the Engine HTTP API after `/version`
  negotiation. Unsupported transports fall back to the same fingerprinted CLI
  with an explicit `--context`; local Engine failures stay typed errors rather
  than being hidden by a fallback.
- Mutations accept a strict allowlist and a full immutable container ID.
  Container removal requires explicit confirmation. Mutations are submitted
  once and produce an operation receipt.
- First-class system, inspect, one-shot stats, image, and volume methods project
  exact Engine JSON into stable protocol types. Image/volume remove and prune
  require explicit confirmation; image removal requires a full immutable
  digest. Successful or ambiguous mutations emit reconciliation events.
- Image pull is an ordinary cancellable pipe session, preserving installed CLI
  credential-helper and progress behavior instead of reimplementing registry
  authentication.
- Generic CLI output is bounded and binary-safe. PTY, stdin streaming, and
  long-lived stream brokerage use the additive `session.*` protocol.
- Pipe sessions retain stdout/stderr separation. Linux terminal sessions use a
  real `/dev/ptmx` PTY with resize support. Acknowledged sequence windows apply
  OS-level backpressure without unbounded queues, and cancellation cleans the
  whole process group.

Protocol details live in `../protocol/`.
