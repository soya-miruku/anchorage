# What is not implemented, and what is blocking each thing

An audit of every area where Anchorage does not do the work. Six dimensions were swept in
parallel — controls that render without acting, the stub screens, the store, the Go core, panels
inside working screens, and the preview/host split — producing **64 distinct findings**.

This codebase carries **no TODO or FIXME markers at all**, so nothing here was found by reading
comments. Gaps are structural: `UnsupportedSurface`, capability refusals in the core,
`if (!isHost) return` guards, and handlers that resolve to nothing.

## The classification is the point

A list of gaps is not useful until each one says who is holding it up.

| | Count | Meaning |
|---|---|---|
| **Us** | 54 | Docker exposes it, nothing external is missing, we have not built it. The real backlog. |
| **Environment** | 6 | The capability exists but needs a plugin or cluster this host lacks. Buildable, unverifiable here. |
| **Docker** | 4 | No API or CLI exists. Correctly unimplemented; the honest surface is a statement, not a view. |

Of the 54, **8 were adversarially verified**: 6 confirmed and fixed, 2 rejected as not gaps at
all. The remaining 46 are recorded below as found. They are evidence-backed and quote real code,
but they have not each been independently challenged — treat them as a strong lead, not a verdict.

## Fixed in this pass

Six defects where a control looked like it worked and did not. All six passed the test suite
before the fix; each now has a test that fails when the fix is reverted.

An adversarial review of this pass then found that two of the six were fixed only in the
renderer. `rename` and `update` were missing from the container-action allowlists in both
`app/electron/preload.cjs` and `app/electron/contracts.mjs`, so those requests were refused at
the Electron trust boundary and never reached the Go core, which has always handled them.
Underneath that, the option validation read `value.name` / `value.restartPolicy` rather than
`value.options.*`, which `assertOnlyKeys` forbids at the top level — so even with the allowlist
fixed, every option would have been silently dropped and `docker update` would have run with no
flags. Both faults are fixed and covered by contract tests.

| Area | What was wrong |
|---|---|
| Processes / Changes tabs | Both loaders ended `.catch(() => undefined)`. `docker top` returns 409 for a container that is not running and the tab strip has no state gate, so a routine refusal rendered as a spinner that never resolved. The core authors a distinct message for exactly this and it was discarded one line before display. |
| `openImageDetail` | The stale-response guard was `current && current.imageId === image.imageId ? current : current` — identical branches, so it discarded nothing. Two quick clicks could put one image's layers, size and platform under another's name. |
| Resources → restart policy | `"no"` was the sentinel for "unchanged" *and* Docker's own `no` policy, so the option that stops a container restarting was dropped before the patch was built. The core has always accepted the two separately. |
| Resources → Apply | No `disabled` binding, on a form that resets to inert defaults, so pressing it untouched submitted an empty patch. The originally recorded symptom — a flagless `docker update` surfacing a CLI usage error — was wrong: in host mode the request never got that far, because the Electron boundary refused the whole `update` action. The button is now gated, and an empty update is refused at the contract layer too. |
| Builds → record detail | A failed `buildx history inspect` was routed to `buildsError`, rendered only by Settings → Builders. Now has its own state: `buildsError` also carries buildx *limitations*, which are caveats, and collapsing the two would show a benign limitation as a broken record. |
| Image detail in preview | The store returns before setting either a detail or an error, so every row opened a panel reading "Loading image detail…" permanently. The panel now distinguishes *waiting*, *failed* and *no daemon to ask*. |

## The largest single finding

**The engine telemetry chrome shows less than the browser preview, in the mode where the data is
real.** The store samples per-container stats continuously and **only when `isHost`**
(`app/src/store/useAnchorageStore.ts:1989`). The comment above it justifies never stopping that
sampler on the grounds that `engineCpu` and `engineMemory` "are rendered by the sidebar engine
card and the status bar — chrome that is on screen everywhere."

Both then decline to render them in host mode: the card shows `"Stats tab"` with both meters
pinned to `width: 0` (`app/src/components/Shell.tsx:450-460`), and the status bar shows
`"live metrics on container Stats"` (`:557`). The preview, which has no engine, shows live
percentages. The cost is being paid and the answer is being thrown away.

## Built, wired, and unreachable

Work that is complete on every layer except the one that would let somebody use it.

- **`containers.kill`** — core verb, bridge method taking a signal, store action with a state
  guard, a presentation predicate, and a unit test. Two references in the entire renderer, both
  inside the store's own definition and export. No control calls it.
- **`networks.action` connect / disconnect** — declared in `protocol/types.ts`, validated in
  `app/electron/contracts.mjs`, implemented against `/networks/{id}/connect|disconnect`. No UI.
- **Unpause** — `primaryContainerAction` returns `unpause` for a paused container; the detail
  header's primary toggle handles only `stop` and `start`.

## Schema drift

`containers.rebindPorts` is live in the core and **validated at the trust boundary** in
`contracts.mjs` — so this is not a validation hole — but it appears in neither `protocol/types.ts`
nor `protocol/v1.schema.json`, which are meant to be the contract of record. `SecretsListRequest`
is declared and schema'd but missing from the `RPCRequest` union. There is no `networks.inspect`
verb anywhere.

## Not ours

**Environment (6).** Models, Sandboxes, Tools (MCP), Bosun and Agents all need CLI plugins that
are, on this host, **broken symlinks left by a removed Docker Desktop** — nine of them — rather
than absent software. "Install the plugin" is the wrong instruction for a dangling symlink, which
is exactly the distinction `usePluginPresence` exists to make. Also here: secrets create/remove,
which Docker does expose and we read only.

**Docker (4).** Governance is administered in a web console with no local surface. Hardened
Images is a Hub catalogue with no enumerating verb. Most of Kubernetes has no Docker API at all —
and the screen's own copy **overstates our culpability**, attributing to Anchorage a blocker that
is really the absence of any engine surface for cluster state. The remaining `nativeTransportRequired`
refusals in the core were checked and are correct.

**Rejected on verification (2).** The Shell update banner and the Settings toggle "locked" state
were both reported as missing capabilities and are neither.

## The remaining 46

Recorded as found, not individually verified. Grouped by what they have in common.

**Failures written but never rendered** — `toggleComposeProject` writes `composeError` under a
status the screen does not render it in; `refreshBuilds` distinguishes `unavailable` from `error`
and the screen branches only on the former; `refreshNetworks` discards `result.limitations`, so
the CLI transport's caveat about subnets never reaches the screen.

**Missing stale-response guards** — `refreshBuilds` and `refreshCompose` write whatever returns
with no context check, unlike every sibling; `setImageFilters` orders a refresh against a ref its
own updater has not written yet.

**Long-running work outside the activity system** — volume backup, restore, clone and empty are
the only jobs not recorded through `recordActivity`; `runTransferSession` has an exit that never
patches its entry to a terminal state.

**Core CLI-transport gaps** — `systemSnapshotCLI` unmarshals disk usage and then never reads it;
`images.inspect` refuses where `containers.inspect` falls back; `system.action`, `networks.action`
and `containers.create` refuse on non-unix transports while three sibling verbs already fall back;
`images.action` and `volumes.action` drop `Deleted`/`Prune`/`Volume` on the CLI path.

**Controls absent for capabilities we already carry** — network attach/detach; `network`, `labels`
and `autoRemove` on the run dialog; CPU shares in the Resources dialog (carried by the store,
protocol and core, including range validation); per-file download from a volume; build logs, which
buildx does report; log export from either log surface; `removeOrphans` and `timeoutSeconds` on
Compose up.

**Preview and host telling different stories** — five container-detail tabs fabricate a daemon
answer in preview while two neighbours refuse; `CommandCenter` has no mode awareness at all; the
status bar and engine card assert a connected engine with no preview indicator;
`UnsupportedSurface` prints a mode-scoped sentence from a component that cannot tell which mode it
is in; several headers interleave live values with frozen literals in one string.

### Full index

| Location | Area | Effort |
|---|---|---|
| `app/src/services/anchorageBridge.ts:818` | Fixture bridge — containers.update | small |
| `app/src/screens/CloudScreen.tsx:16` | Cloud screen | small |
| `app/src/store/useAnchorageStore.ts:2320` | Container detail — Processes & Changes tabs | small |
| `app/src/store/useAnchorageStore.ts:1550` | selectDockerContext — per-context cache invalidation | medium |
| `app/src/store/useAnchorageStore.ts:3396` | Volume backup / restore / clone / empty — activity log | medium |
| `app/src/store/useAnchorageStore.ts:3057` | runTransferSession — activity never reaches a terminal state | small |
| `app/src/store/useAnchorageStore.ts:3122` | BuildsScreen — selectBuildRecord failure | small |
| `app/src/store/useAnchorageStore.ts:3103` | BuildsScreen — refreshBuilds error state | small |
| `app/src/store/useAnchorageStore.ts:3197` | ComposeScreen — toggleComposeProject failure | small |
| `app/src/store/useAnchorageStore.ts:2715` | openImageDetail — stale-response guard is a no-op | small |
| `app/src/store/useAnchorageStore.ts:1403` | killContainer — implemented, unreachable | small |
| `app/src/store/useAnchorageStore.ts:3097` | refreshBuilds — limitations truncated to one | small |
| `app/src/store/useAnchorageStore.ts:1019` | Compose / Builds / Secrets — no refresh path | small |
| `app/src/store/useAnchorageStore.ts:2772` | setImageFilters — refresh ordered against a ref the updater has not written | small |
| `app/src/store/useAnchorageStore.ts:3093` | refreshBuilds / refreshCompose — missing stale-context guard | small |
| `core/internal/core/domain.go:2893` | system.snapshot (remote/CLI transport) | medium |
| `core/internal/core/domain.go:2960` | images.inspect | medium |
| `core/internal/core/domain.go:2101` | system.action / networks.action / containers.create | large |
| `core/internal/core/domain.go:3071` | containerArchiveClient gate (containers.top, containers.diff, images.search, containers.commit) | medium |
| `core/internal/core/service.go:193` | containers.rebindPorts (protocol drift) | small |
| `core/internal/core/domain.go:2303` | networks (no inspect verb) | small |
| `app/src/store/useAnchorageStore.ts:2627` | networks.action connect/disconnect (implemented, unreachable) | small |
| `core/internal/core/domain.go:1414` | images.action / volumes.action (CLI transport) | small |
| `core/internal/core/domain.go:2808` | containers.statsBatch (unverified provenance) | small |
| `protocol/types.ts:798` | protocol RPCRequest union | small |
| `app/src/screens/NetworksScreen.tsx:168` | Networks screen — attach/detach | medium |
| `app/src/components/CreateContainerDialog.tsx:67` | Run-a-container dialog — network / labels / auto-remove | small |
| `app/src/utils/containerPresentation.ts:114` | Container lifecycle — Kill | small |
| `app/src/screens/ContainerDetailScreen.tsx:259` | Container detail header — paused container | small |
| `app/src/components/VolumeFilesPanel.tsx:177` | Volume file browser — download | small |
| `app/src/store/useAnchorageStore.ts:753` | Networks screen — dropped transport caveat | small |
| `app/src/screens/DashboardScreen.tsx:153` | Dashboard — host Compose panel (and a conditional hook) | small |
| `app/src/screens/BuildsScreen.tsx:213` | Builds screen — build output | medium |
| `app/src/screens/ImagesScreen.tsx:234` | Images — registry search (host) | small |
| `app/src/screens/ContainerDetailScreen.tsx:459` | Container detail — Resources dialog | small |
| `app/src/screens/LogsScreen.tsx:136` | Log surfaces — export | small |
| `app/src/screens/ComposeScreen.tsx:726` | Compose — up options | small |
| `app/src/components/CommandCenter.tsx:943` | Command Center (fixture command inventory) | small |
| `app/src/screens/ContainerDetailScreen.tsx:631` | Container detail — Inspect / Mounts / Files / Logs tabs | medium |
| `app/src/components/Shell.tsx:524` | App chrome — status bar / engine card | small |
| `app/src/components/UnsupportedSurface.tsx:112` | UnsupportedSurface — mode-specific claim from a mode-blind component | small |
| `app/src/components/Shell.tsx:363` | Update banner | small |
| `app/src/screens/DashboardScreen.tsx:469` | Dashboard (preview) — hardcoded stat details beside live counts | small |
| `app/src/store/useAnchorageStore.ts:3968` | volumes summary (preview) | small |
| `app/src/screens/BuildsScreen.tsx:236` | Builds (preview) header | small |
| `app/src/components/Shell.tsx:450` | Engine telemetry chrome — host shows less than preview | small |

---

Regenerate by re-running the audit; the raw findings, including quoted evidence and the
verifiers' reasoning, are in the workflow journal for run `wf_2ea9d492-dfb`.
