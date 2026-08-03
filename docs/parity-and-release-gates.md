# Anchorage parity and release gates

Anchorage is releasable only when its generated evidence describes the
candidate that is actually packaged. A successful build is necessary, but is
not acceptance evidence.

## What “all Docker functionality” means

Anchorage recursively discovers canonical advertised command paths from
recognized help surfaces exposed by the installed Docker CLI and valid CLI
plugins. Discovery records versions, selected context, availability, Usage
text, and help hashes. It does not enumerate hidden commands or aliases, or
infer a command's full option schema, environment needs, TTY needs, or behavior
from help text.

Every discovered and available canonical advertised leaf command must remain
executable through the Command Center using literal argument arrays and either
pipes or a real PTY. There is no shell evaluation. Known hidden or alias argv
can still be entered literally and delegated to the installed client, but they
are not counted as inventory coverage. First-class graphical workflows
additionally cover the common container, image, volume, network, system-prune,
log, inspect, exec, and stats paths, plus structured container creation.

Transport coverage is deliberately not the parity claim. A leaf being reachable
through a literal-argv palette is evidence that nothing is unreachable, not
evidence that it has a first-class surface. The headline row count must never be
presented as a parity figure.

On the current Linux target, Command Center requests may select any existing
working directory the current user can traverse. The core process still starts
in the canonical user home, but is launched with filesystem-root cwd coverage
so Compose and project-aware plugins also work under `/srv`, `/mnt`, `/tmp`, or
other user-accessible paths. This changes no operating-system permissions and
provides no privilege elevation.

These are deliberately separate claims:

- **Transport coverage** means a leaf is installed and reachable through the
  shared exact-argv pipes/PTY path.
- **Behavioral conformance** means a specific operation was actually executed
  and its exit status, output, postcondition, and cleanup were checked.
- **Context unavailable** means the selected installation or context cannot
  provide the capability, with the reason shown instead of a simulated result.

Anchorage does not mass-execute every arbitrary or destructive leaf command to
turn transport reachability into a misleading “passed” count.

## Docker capability ledger

The generated ledger contains one row per discovered canonical advertised leaf
command:

| Field | Evidence |
|---|---|
| Identity | executable, plugin, complete command path, installation fingerprint |
| Discovery | Usage text, help hash, versions, context, and availability |
| Invocation path | literal argv and pipes/PTY transport |
| I/O transport | stdout, stderr, stdin, resize, signal, cancellation, exit |
| UI route | searchable Command Center route |
| Execution result | explicitly `not-run` unless that command has separate conformance evidence |
| Status | `transport-covered`, `context-unavailable`, or `blocked` |

Release fails if discovery is incomplete, a discovered available canonical
advertised leaf has no executable transport route, a shared session loses
output or exit status, or an interactive session cannot receive input,
terminal resize, signals, and cancellation.

Operation-level conformance is stored separately. Matrix v1 contains eight
read-only checks and ten disposable mutation checks. It covers the core
handshake and inventory, list/inspect/stats equivalence, pinned and literal
pipes sessions, container lifecycle and PTY control, image pull/one-tag
removal/dangling-and-all prune semantics, and volume default/all/exact-remove
semantics. Mutation mode owns an isolated Docker-in-Docker daemon and requires
the temporary context, daemon, containers, images, and volumes to be absent
afterward. A read-only package preflight cannot replace this mutation-enabled
artifact.

The matrix does not yet cover the archive verbs (`images.action` save/load,
`containers.export`) or `images.action` tag. Save, load and export are session
transfers whose failure mode is a partially written host file, and every one of
them writes outside the Docker-in-Docker daemon's own state, so a check has to
own and clean up a scratch directory as well as the temporary daemon. Tag is
cheap to cover and only omitted because it landed after the last matrix
revision. Both are stated here rather than left to be inferred from a passing
run, because a matrix that reports "18 checks passed" while silently not
exercising a verb is how an earlier session-cancellation defect survived.

## Canonical handoff visual conformance ledger

The source of truth is
`docs/design_handoff_anchorage/Anchorage.dc.html` plus its handoff README.
Reference and implementation captures use the same 1656 x 1056 outer viewport,
containing the canonical 1600 x 1000 application and its 28px desk. These
dimensions describe only the `?capture=<state>` visual-conformance route.
Normal browser previews and the Electron runtime fill and resize with their
viewports; Electron starts at a 1600 x 1000 content size and has a 1080 x 700
minimum.

The 24 canonical states predate several shipped capabilities, so the captured
application legitimately carries navigation and controls the handoff never
described. Those divergences are additive rather than drift: the review
attestation names them per state, and they are measured, not hidden. If they ever
consume enough of the 2% budget to mask a real regression, the reference set must
be re-baselined rather than the threshold relaxed.

The canonical ledger requires 100% state coverage: 24 named captures covering:

- Dashboard and the Containers list variations;
- all six container detail tabs;
- Images Local and Registry;
- Volumes, Builds, Dev Environments, and Extensions;
- every Settings section supplied by the source handoff.

The comparator checks exact dimensions and a per-state normalized mean-absolute
pixel difference threshold of 0.02. This is reviewed visual conformance, not a
claim of pixel identity. Only the two changing history plots in the Stats
capture are masked, with the mask coordinates and rationale recorded in the
ledger.

### The capture must be reproducible

The attestation binds the SHA-256 of each capture so a reviewer cannot approve
one image while a different one ships. That binding is only workable if a
re-run of an unchanged build reproduces the same bytes. It did not: the harness
rendered the live wall clock and whatever phase each looping indicator happened
to be in, so **0 of 24 captures were byte-identical across two consecutive runs
of one build**, and the attestation was invalidated by every re-capture whether
or not anything had changed.

The harness therefore navigates with `?designCapture=1`, which pins the
status-bar clock and holds animations at their first frame. Two consecutive runs
of one build now produce **24 of 24 byte-identical** captures. This is a
distinct key from `?capture=<state>`, which selects the default appearance and
changes which Settings rows render; conflating them would change what the gate
compares.

Both values are frozen rather than masked, so their glyphs, position and colour
stay under comparison and only the part with no design meaning is pinned. Prefer
that ordering for anything found varying in future: freeze it if you can, mask it
only if you cannot, and record why in the ledger either way. Every canonical pair is also reviewed side by side against the stated
geometry, typography, colour, borders, radii, spacing, icons, layer order,
clipping, and scroll criteria before its status is promoted from
`review-required` to `passed`. The review sidecar identifies the reviewer and
notes for every state and binds the exact reference and actual PNG hashes;
`ANCHORAGE_DESIGN_REVIEWED=1` alone is not acceptance evidence.

Canonical captures are deterministic FixtureBridge inputs because fixed data is
required for meaningful pixel comparison. Provenance binds each PNG, the exact
renderer build, Electron/Chromium runtime, capture harness, comparator, handoff
HTML/README/support files, and reference capture set.

Capture mode always applies Default/Dark, does not read or write the normal
saved appearance preference, and omits the new Appearance navigation row.
Docker and GitHub themes and the Light variants are normal product features,
but they are intentionally outside this source-parity ledger: adding them to
the canonical matrix would change its 24 source-defined states rather than
measure conformance to the supplied handoff.

Renderer interaction tests cover loading, empty, disconnected, partial, error,
permission, large-list, keyboard, focus, and mutation states that are not all
separate handoff screenshots. Runtime window checks are independent of the
fixed-source ledger: they assert that native content, renderer viewport, desk,
shell, document, and scroll extents converge at the initial 1600 x 1000 size,
the supported 1080 x 700 minimum, and a larger 1800 x 1100 size. This proves
that normal resizing expands the application rather than only a decorative
background.

The desktop window gate also verifies the custom Anchorage titlebar path. On
Linux the BrowserWindow must be frameless (`frame: false`), while the small
platform shadow and extended native resize boundary remain enabled so edge
resizing continues to work. Anchorage owns the visible titlebar, and its
controls remain allowlisted main-process requests. Each of the Default, Docker,
and GitHub families must provide both Light and Dark palettes through the same
semantic token contract. Appearance storage is versioned and validated, with
Default/Dark fallback for missing or invalid values and a visible session-only
fallback when persistence is unavailable.

Fixture mode is used only for deterministic design QA. A second mandatory
staged-candidate gate launches the production Electron main/preload, freshly
staged core, exact renderer, and real HostBridge against the current Docker
context. It captures live Dashboard, Containers, detail, Images, Volumes,
Command Center pinned/literal, Files-unavailable, and Builds-unavailable states;
requires zero console/page/process errors; and binds every PNG and shipped
Electron runtime module. This is host integration evidence, not a dishonest
claim that changing live data is pixel-identical to fixed fixtures.

## Correctness gates

- Race-enabled Go tests and `go vet`.
- Renderer unit, store, protocol, lifecycle, redaction, and virtualization
  tests plus strict TypeScript checking.
- Electron contract tests for every bridge method and all known event
  envelopes.
- Mutation-enabled disposable-resource acceptance with postconditions and
  cleanup.
- Exact immutable IDs for destructive structured actions.
- Unknown Docker usage data remains unknown and cannot authorize destructive
  “unused” actions.
- Operation success is kept distinct from a later reconciliation failure.
- Package evidence hashes bind the renderer, core, protocols, generators, and
  harnesses used for the candidate.

The current evidence does not claim a tested matrix of remote, rootless, and
unreachable daemons unless those environments are present in that evidence
bundle.

## Performance gates

The release profile requires 20 warm health samples, 20 warm samples for each
measured method, four-way container stats over 20 rounds, and a complete
30-minute acknowledged `docker events` session.

`system.snapshot` and `system.capabilities` are measured explicitly because they
were previously the two slowest paths in the core and had no budget at all: the
snapshot walked `/system/df` on every call, and capability discovery re-walked
the whole CLI help tree. Both are now cached or opt-in, and the warm bounds
above exist to keep them that way. Snapshot latency is measured without disk
usage, which is opt-in precisely because it is a full daemon-side walk. Its policy-owned upper bounds are:

| Measurement | Release limit |
|---|---:|
| Cold process spawn plus health | 2,000 ms |
| Warm health p95 | 100 ms |
| Containers first / warm p95 | 5,000 / 2,000 ms |
| Images first / warm p95 | 10,000 / 5,000 ms |
| Volumes first / warm p95 | 15,000 / 5,000 ms |
| System snapshot first / warm p95 | 5,000 / 1,000 ms |
| Capabilities first / warm p95 | 10,000 / 500 ms |
| Four-container stats wall / individual p95 | 3,000 / 3,000 ms |
| Session cancel to exit | 2,000 ms |
| Core RSS p95 / maximum | 128 / 160 MiB |
| Positive core RSS growth | 32 MiB |

The other profile checks require exact sample floors and matrices, zero dropped
or truncated session bytes, exact event/byte acknowledgements, the full soak
duration, and clean core exit. The environment records the host, Docker
client/server, exact core, and exact harness hashes.

Renderer tests separately prove bounded DOM size with 10,000-row fixtures,
single-flight polling, and stale-response suppression. Host-candidate evidence
records conservative startup/paint/interaction/DOM observations when available.
No single-host result is presented as a universal cross-hardware frame-rate
claim.

## Security and packaging gates

- Electron security configuration and behavioral policy are asserted by
  automated tests.
- The renderer has no Node.js, filesystem, process execution, or Docker socket
  access.
- Commands use literal argv without shell interpolation.
- Secret-bearing environment and option forms are omitted from in-memory
  history and copied equivalents.
- Known event payloads are validated before renderer IPC delivery.
- The packaged AppImage includes a freshly built, hash-bound Go core and
  renderer.
- Stale release output is removed when preflight fails.

The local AppImage is unsigned. Production signing, upgrade-channel validation,
and additional operating-system packaging are not claimed without their own
project keys and evidence.

## Evidence bundle

The candidate release produces:

```text
artifacts/
  design/
    actual/
    diffs/
    masked/
    design-ledger.json
  docker/
    command-tree.json
    capability-ledger.json
    conformance-results.json
    read-only-acceptance.json
  host-candidate/
    host-candidate.json
    screens/
  performance/
    environment.json
    results.json
  security/
    electron-security.json
    dependency-audit.json
```

The release report links each claim to this bundle. Unsupported,
context-unavailable, unmeasured, and future capabilities are called out
explicitly rather than silently omitted.
