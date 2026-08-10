# Sandbox isolation backend for the acceptance harness

**Date:** 2026-08-10
**Status:** approved, not yet implemented
**Scope:** `tools/run-core-acceptance.mjs`, `tools/acceptance-check-ids.mjs`,
`app/scripts/package-evidence-policy.mjs`. A Sandboxes UI surface is explicitly out of scope and
deferred to a later spec.

## Why

The mutation-conformance gate exercises destructive Docker operations — image removal, container
lifecycle, volume deletion, prune semantics — and needs somewhere disposable to do it. Today that
is a `--privileged docker:29-dind` container plus two Docker contexts, created on the developer's
own machine and torn down in a `finally` block.

Docker Sandboxes (`sbx`, v0.38.0, GA) offers stronger containment: a KVM-backed microVM per
sandbox, each with its own kernel, Docker daemon and network namespace. On a developer machine
that replaces a root-equivalent container on the real daemon with a virtual machine.

It cannot simply replace DinD. Mutation conformance is a required release gate that runs in GitHub
Actions, KVM is not reliably available on hosted runners, and `/dev/kvm` is absent on
`ubuntu-24.04-arm` — the exact runner this project's per-architecture release uses. Swapping
outright would permanently break arm64 releases.

## The leak, diagnosed correctly

A privileged DinD container from an earlier run has been alive on the developer host for two days,
with two stale contexts and a scratch directory still present.

The first reading was that the gate lies — that `cleanup: {status: "passed", errors: []}` was
asserted while debris survived. **That reading is wrong, and the correction matters.**
`artifacts/docker/conformance-results.json` describes run `32344486` and records every one of its
resources as `verifiedAbsent: true`. Those claims are true. The live debris is `40d348de`: a
*different* run, which never wrote evidence at all.

The mechanism is that `run-core-acceptance.mjs` registers no signal handlers — `process.on(`
appears zero times; the only `SIGTERM` in the file kills a child process. An interrupt between the
DinD launch and the `finally` block ends the process before cleanup runs and before anything is
recorded. The next successful run overwrites the output path, and the file on disk is honest,
passing, and silent about the privileged container still running.

So the defect is not a false claim. It is that **`cleanup.status` is a per-run claim ("my
resources were removed") that the release policy reads as a host-state claim ("nothing leaked")**,
and an interrupted run is invisible to both. This is the same shape as the mtime-versus-digest
problem this repo already corrected: the weaker check passes while being wrong in spirit.

Every part of this applies to `sbx` too. An interrupted sbx run leaks a running microVM, its
contexts and its scratch directory. Contexts and scratch directories are host-global under both
backends — only the daemon moves into the VM. **`sbx` does not make cleanup moot.**

## Decision

Add an isolation-provider seam to the existing harness. One backend is the current DinD engine;
the other is sbx. Both satisfy one narrow contract, and the evidence records which ran and what it
measured against.

Rejected alternatives:

- **A separate sandbox-conformance harness.** `run-core-acceptance.mjs:23-25` records that a second
  copy of the check matrix "is what broke packaging when the matrix last grew". This recreates that
  failure and leaves DinD leaking by default.
- **Running the whole suite inside one sandbox with DinD still inside it.** The checks would still
  execute against a DinD daemon, now two layers down. Containment improves; the claim under test
  does not change; CI cannot run it.
- **Requiring releases to be built where sbx is available.** Kills arm64 CI releases to strengthen
  a property no consumer of the release reads.
- **Separate evidence filenames per backend.** Forks the policy and the packaging, and eventually
  the check matrix — the rejected separate-harness option by another route.

## Is a two-backend gate still a meaningful gate?

Yes, and the intuition that CI would become the weaker witness is backwards.

The fifteen mutation checks claim things about **the core's behaviour against a real Docker
Engine**: receipts, postconditions, archive byte integrity, prune semantics, PTY control. The
isolation backend is scaffolding with two jobs — protect the host, and provide a hermetic daemon so
postconditions are attributable. Neither job appears in what the release attests to a user.

If anything DinD is the *more controlled* measurement: a pinned `docker:29-dind`, a pinned
`--storage-driver=vfs`, and a daemon whose entire configuration the harness chose. sbx supplies
whatever engine version, storage driver and kernel its rootfs happens to ship. sbx's benefit is to
the person running the suite, and a release does not need to attest to that.

What genuinely differentiates the two is **the daemon**, not the isolation — a principle this repo
already states at `.github/workflows/release.yml:189-191`: *"the same binary on a different daemon
is a different measurement"*, which is why Docker's version is in the evidence cache key. The
evidence must therefore describe the measurement environment, not merely label the backend.

## Design

### Phase 0 — cleanup hardening (prerequisite, lands first)

A prerequisite rather than an alternative: the teardown contract belongs inside the seam, and
writing it twice is the cost of doing this second. It also fixes the CI path, which is the release
path.

1. **Signal-path teardown.** Handle `SIGINT`/`SIGTERM`, run the same cleanup, and write an evidence
   file with a distinct `aborted` status. An interrupted run that recorded what it left behind is
   worth more than one that vanished.
2. **Labelled-orphan preflight.** Before starting, enumerate containers carrying the
   `io.anchorage.acceptance` label, contexts matching `anchorage-dind-*` / `anchorage-sbx-*`, and
   `artifacts/docker/acceptance-scratch-*` directories. Either refuse or clean-and-record under
   `orphansRemoved`. Only then can `cleanup: passed` honestly mean *"at completion, zero Anchorage
   acceptance resources existed on this host"* — established by enumeration, per the house rule.
3. **Self-limiting debris.** Run the DinD container with `--rm` and a hard entrypoint timeout, so an
   orphaned privileged daemon removes itself within the hour even if no sweep runs. Contexts cannot
   self-clean; the sweep covers those.

### Phase 1 — the provider seam

**Spike first, and treat it as a go/no-go.** Two Engine-API checks (`volumes.files`,
`volumes.fileRead`) require a directly reachable Unix socket and fail with
`context_transport_unsupported` (`core/internal/core/domain.go:1871`) over TCP. DinD satisfies this
by publishing three `--host` endpoints and bind-mounting a socket into the scratch tree. sbx
forwards a TCP port and will not bind-mount a socket into `artifacts/docker`. The intended solution
is a zero-dependency Node proxy listening on a Unix socket in the scratch directory and piping
bytes to the forwarded port, since the Docker API is plain HTTP. **If the spike fails, the sbx
matrix loses two checks or changes their meaning, and this phase does not proceed.**

**Interface.** Deliberately narrow, because sbx is pre-1.0 and its command surface will churn:

```
createIsolatedEngine() -> {
  endpoint,        // Docker host the checks run against
  socketPath,      // Unix socket path for the direct-transport checks
  descriptor,      // backend, version, engineVersion, storageDriver, cgroupVersion
  teardown()       // idempotent; also invoked from the signal path
}
```

Churn in sbx stays inside one function.

**Backend selection.** Probe for `sbx` on `PATH`, `/dev/kvm`, and daemon health. Selection must
never depend on ambient login state silently: the harness **must not auto-start `sandboxd`**, and
the recorded `reason` must discriminate `sbx-absent` / `no-kvm` / `not-authenticated` /
`daemon-not-running` / `explicit-override`. `ANCHORAGE_ISOLATION=dind` is **mandatory**, so a
developer can reproduce the CI claim locally before tagging.

**The isolation check splits.** `dind-isolation` is one of the fifteen mutation checks
(`tools/acceptance-check-ids.mjs:32`) and asserts backend-specific facts: server version matching
`^29`, an ownership label, and both context endpoints. Under sbx it is meaningless as written, and
generalising it would dilute it. Replace it with `dind-isolation` and `sbx-isolation`, each
asserting what its backend can genuinely pin, and make the policy's expected check set conditional
on `isolation.backend`. The other fourteen are shared verbatim. This is a feature: the backends
produce explicitly non-interchangeable claims exactly where they differ.

**Evidence.** A new `isolation` block:

```json
{ "backend": "dind" | "sbx", "version": "...", "reason": "...",
  "engineVersion": "...", "storageDriver": "...", "cgroupVersion": "..." }
```

The policy validates coherence rather than presence alone: backend within the known set; if `dind`,
engine major is 29; if `sbx`, the engine version is recorded and asserted non-empty rather than
bounded — a floor cannot be chosen honestly until the spike observes what sbx's rootfs actually
ships, and inventing one now would be a number no measurement supports. Choosing that floor is
an explicit task in the implementation plan. Neither backend is ranked.

### Phase 2 — out of scope

A Sandboxes destination in the app. Deferred to its own spec, informed by whatever Phase 1 learns
about sbx's real behaviour. `sbx ls --json` exists, which is what a core verb would consume.

## Testing

- Phase 0 cleanup is verified by enumeration, not by assertion: start a run, interrupt it with a
  real signal, and assert that no labelled container, matching context or scratch directory
  survives, and that an `aborted` evidence file was written.
- The orphan preflight is tested by planting a labelled container and a matching context, then
  asserting they are found and recorded.
- Backend selection is unit-tested against each probe outcome, asserting the discriminated `reason`.
- The socket proxy is tested by running the two direct-transport checks through it.
- `package-evidence-policy.test.mjs` gains cases for a coherent and an incoherent `isolation` block,
  and for the backend-conditional check set.

## Risks

- **Local green and CI green are no longer the same run.** A defect that manifests only under DinD
  (vfs quirks, cgroup v1-isms) would surface at release time. Tolerable — it is the same class of
  divergence as "developer has Scout, CI does not", which the repo already handles with explicit
  skips — and it is why the `ANCHORAGE_ISOLATION=dind` override is not optional.
- **sbx is v0.38.0 and pre-1.0**, requires a Docker account, and its daemon runs in the foreground.
  Recording its version is necessary but not sufficient; expect command-surface churn.
- **The socket-transport spike may fail**, which stops Phase 1.

## Deliberately not done

- **sbx in CI.** GitHub may expose `/dev/kvm` on standard x64 runners (unverified here; arm64
  certainly lacks it). Even where it works, `sbx login` in CI means a Docker account credential as a
  repository secret — a new supply-chain surface bought for containment on a runner that is
  discarded minutes later. Declined.
- **Ranking the backends in evidence.** They are different measurement environments, not better and
  worse ones.

## Provenance

The design follows a review by Claude Fable 5, which corrected three things in the original
framing: the leak diagnosis above; the claim that the fifteen checks were untouched (`dind-isolation`
is one of them); and the direction of weakness between the backends. The Unix-socket transport
risk and the auto-start hazard were also raised there.
