# Anchorage review — findings appendix

All 168 findings that survived adversarial verification, ordered by severity.
Companion to [`review-2026-08-03.md`](review-2026-08-03.md).

Verdicts: `CONFIRMED` = verifier reproduced the claim from source · `CORRECTED` = claim was
real but the verifier changed its scope, severity or state. `REFUTED` findings are excluded.

`state` values: `absent` (nothing exists anywhere) · `core-only-not-wired` (protocol/Go
supports it, no UI) · `wired-but-gated` (UI exists but unreachable in practice) ·
`fixture-only` (works only against browser fixtures) · `defect` (exists but broken).


### CRITICAL (3)

#### "Create volume" is permanently dead in the packaged Electron app (window.prompt returns null), and even when reachable it is name-only while driver/driverOpts/labels are fully implemented in core

`correctness` · `defect` · effort: small

**Impact.** In the shipped AppImage, clicking "Create volume" does nothing at all — no dialog, no error, no toast. The renderer test suites mask it by stubbing the exact browser global that does not exist in the host (`vi.spyOn(window,"prompt")`), and the desktop smoke gate blocks mutations, so nothing catches it. Secondarily, even the intended flow cannot create an NFS/CIFS/tmpfs/o=bind volume or a labelled volume a compose project can adopt, despite the wire contract and Go core supporting all of it.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/VolumesScreen.tsx:5-8 — `const handleCreate = () => { const name = window.prompt("Volume name", "project_data"); if (name) void store.createVolume(name); }`. VolumesScreen.tsx:49 is the only "Create volume" button in the app and it calls `handleCreate`.
- I decompiled the bundled Electron 43.2.0 browser bundle myself (`strings app/node_modules/electron/dist/electron`) and extracted the `-run-dialog` handler verbatim: `this.on("-run-dialog",async(e,t)=>{...const o=this.getLastWebPreferences();if(!o\|\|o.disableDialogs)return t(!1,"");if("prompt"===e.dialogType)return t(!1,"");...}`. `prompt` short-circuits to success=false/empty string before any dialog is shown, so Blink returns a null String → JS `null`. The same handler DOES service `confirm` via `dialog.showMessageBox(s,{...buttons:["OK","Cancel"],defaultId:0,cancelId:1})`, so `window.confirm` works and the container/image/volume delete flows are NOT broken by this.
- /home/soya/dev/tools/docker-ui/app/electron/security-policy.mjs:10-25 — `createSecureWebPreferences` never sets `disableDialogs` or `safeDialogs`; a repo-wide grep for both names across app/electron and app/src returns zero hits, so the short-circuit is Electron's own unconditional behaviour, not a policy choice.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1536-1601 — `createVolume` is fully implemented for host mode and is simply never reached; useAnchorageStore.ts:1564 sends `{context, action: "create", name: normalized}` with no driver/driverOpts/labels.
- /home/soya/dev/tools/docker-ui/protocol/types.ts:158-166 — the create variant accepts `driver`, `driverOpts`, `labels`. /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:1205-1214 marshals `{Name,Driver,DriverOpts,Labels}` to `POST /volumes/create`; domain.go:1264-1275 emits `--driver`/`--opt k=v`/`--label k=v` on the CLI fallback; domain.go:1366-1381 validates all three. Fully implemented, never invoked.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1538 — the name is silently mangled (`name.trim().replace(/\s+/g, "_")`) with no feedback.

**Fix.** Replace `window.prompt` with an in-app modal (the pattern already exists at DevEnvironmentsScreen.tsx:150-215: `role="dialog" aria-modal="true"`, disabled-until-valid submit) exposing name, driver (default `local`), a driver-options key/value editor and a labels key/value editor. Add a host-mode assertion that renders the real dialog rather than mocking a browser global, and audit every host path for reliance on browser-only globals.

<sub>Verifier (CONFIRMED): Merged surveyor 1's window.prompt finding with surveyor 0's "volume create is name-only" finding — same code site, same button. I independently decompiled the bundled Electron binary rather than trusting the quoted snippet; the quoted handler text is accurate. I also independently confirmed the corollary that `window.confirm` works, so surveyor 1's parenthetical that the delete flow is not broken is correct. Severity raised to critical on the merged finding because a primary CTA is a silent no-op in the only shipping build.</sub>

---

#### Docker networks are entirely absent: no screen, no nav item, no store action, no bridge method, no IPC channel, no protocol method, no core method

`parity-gap` · `absent` · effort: large

**Impact.** Networks are core daily Docker functionality. In Anchorage you cannot see what networks exist, cannot create a bridge network for a project, cannot connect/disconnect a running container, cannot prune orphaned networks, and cannot see which network a container is on without reading raw inspect JSON. The only route is hand-building argv token-by-token in the Command Center and reading raw text. For a GUI positioned as a Docker Desktop replacement this is the single largest missing management domain.

**Evidence.**
- /home/soya/dev/tools/docker-ui/protocol/types.ts:276-294 — the `RPCRequest` union is exactly health, system.capabilities, system.snapshot, containers.{list,inspect,stats,action}, images.{list,action}, volumes.{list,action}, cli.run, session.{start,input,resize,signal,cancel,ack}. No networks method of any kind. I read the union in full.
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:65-215 — I read the whole `Handle` switch. There is no `networks.*` case; unknown methods fall to `method_not_found` at service.go:211-214.
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:7-24 `RENDERER_RPC_METHODS` and contracts.mjs:45-69 `IPC_CHANNELS` — no network entry in either, so the preload could not forward one.
- /home/soya/dev/tools/docker-ui/app/src/types.ts:1-9 — `ViewId` is dashboard\|containers\|images\|volumes\|builds\|devenv\|extensions\|settings. /home/soya/dev/tools/docker-ui/app/src/components/Shell.tsx:29-45 — `workspaceNav`/`developNav` have no Networks item.
- /home/soya/dev/tools/docker-ui/protocol/types.ts:584-590 and /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:378-383 — `NetworkProjection` is read-only per-container endpoint data (networkId/endpointId/gateway/ipAddress/macAddress) on `containers.inspect`. app/src/types.ts:38-45 — `DetailTab` is logs\|inspect\|mounts\|exec\|files\|stats, so it is only visible in the raw JSON dump at ContainerDetailScreen.tsx:303-305.
- I ran the ledger myself: `artifacts/docker/capability-ledger.json` has 219 rows, 219 of which have `uiPath.surface == "Command Center"` (100%), including all 7 `docker network` leaves, every one `discovery.status == "available"`. `docker network --help` on this host confirms exactly 7 subcommands: connect, create, disconnect, inspect, ls, prune, rm.

**Fix.** Add `networks.list`/`networks.inspect`/`networks.action` (create\|remove\|prune\|connect\|disconnect) to protocol/types.ts and protocol/v1.schema.json, implement against `GET /networks`, `GET /networks/{id}`, `POST /networks/create`, `DELETE /networks/{id}`, `POST /networks/prune`, `POST /networks/{id}/connect\|disconnect` with the existing CLI-JSON fallback, add the IPC channel + contract validators, add a Networks nav item and screen modelled on VolumesScreen, and add a Networks tab to ContainerDetailScreen rendering the `networks` map the protocol already carries.

<sub>Verifier (CONFIRMED): Every citation checked and every line number accurate. One correction to the prose: surveyor 0 claims "the only occurrence of the word network as a Docker *command* in the whole codebase is commandCenterModel.ts:161". That is wrong — `app/src/data/commandFixtures.ts:88-93` also declares a `network` branch with ls/create/inspect/rm/prune leaves for the browser-mode Command Center inventory. That is fixture data for design QA, not a host route, so the substantive verdict (absent) stands unchanged.</sub>

---

#### Confirmed leak: a session that stops being acked wedges permanently — no exit event, session.cancel is a no-op, fds and OS threads leak

`correctness` · `defect` · effort: small

**Impact.** Any renderer reload, renderer crash, dropped subscription or failed ack while logs/exec/pull/Command Center output is streaming wedges the session for the lifetime of the core process: goroutines blocked forever, pipe fds never closed, the session never removed from the manager map (the tombstone at :523 is never scheduled), and the UI stuck showing "running". The documented recovery path, session.cancel, provably does nothing in this state.

**Evidence.**
- core/internal/core/session.go:421-424 — `for !s.discardOutput && s.outstandingBytes+int64(len(data)) > s.outputWindow { s.cond.Wait() }`; the predicate ignores processExited and finalized.
- core/internal/core/session.go:314-328 — the waiter sets processExited, broadcasts, then blocks on `readers.Wait()`; the blocked reader never returns, so `finish()` (:485) never runs and session.exited is never emitted.
- core/internal/core/session.go:707-713 — `sessionManager.cancel` returns {accepted:false,state:"exited"} and skips requestCancellation entirely when processExited is true, so the only code that sets discardOutput and broadcasts (:718-727) is unreachable.
- core/internal/core/session.go:350-352 — `defer reader.closer.Close()` never executes, so the pipe read ends stay open.
- REPRODUCED by verifier against core/bin/anchorage-core: 1 session.output, 0 session.exited after 5 s; cancel returned {"accepted": false, "state": "exited"}; fds/threads 3/1 -> 6/8 after one wedge -> 8/9 after three; `health` still answered in 50 ms.
- app/src/store/useAnchorageStore.ts:1099-1113 — log follow requests a 64 KiB window with 16 KiB chunks (session.go:24) and sets no timeoutSeconds, so only 4 unacked chunks are needed to wedge and core/internal/core/session.go:333-338 leaves the timeout branch disabled.

**Fix.** Include processExited/finalized/done in the cond.Wait predicate so process exit always releases the writer; make sessionManager.cancel set discardOutput and broadcast even when the process has already exited; and add a renderer-lifecycle hook in main.mjs that cancels all sessions owned by a window on reload/destroy.

<sub>Verifier (CONFIRMED): I reproduced this myself against core/bin/anchorage-core and it is exactly as described. session.start with argv ["buildx","--help"], outputWindowBytes 1024, no acks: one session.output arrived, the child exited, and after 5 s there was still no session.exited. session.cancel returned {"accepted":false,"state":"exited"} and released nothing. File descriptors went 3 -> 6 after one wedge and 3 -> 8 with 9 threads after three wedges. The deadlock is precisely the cond.Wait predicate at session.go:421-424 ignoring processExited/finalized, plus sessionManager.cancel short-circuiting before requestC</sub>

---


### HIGH (32)

#### Any container reconciliation event wipes the whole inspect cache and nothing ever refetches it — Inspect/Bind-mounts go permanently blank

`correctness` · `defect` · effort: small

**Impact.** Host mode. With container A selected and the Inspect or Bind mounts tab open, any successful container mutation anywhere — including one issued from a terminal outside the app, which the core reconciles — empties `inspectByContainer` for every container. The tab switches to the permanent "Loading inspect data" placeholder. Stats recovers because its 2 s poll (useAnchorageStore.ts:865-1023) refetches; inspect has no poll and no retry affordance, so the two tabs that show real daemon data stay blank until the user navigates Back and reselects the row.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:570-577 — the reconciliation branch runs `if (event.payload.context !== dockerContextRef.current) return;` then `case "container": setInspectByContainer({}); setStatsByContainer({});` at lines 573-574 (surveyor cited 571-577; the wipe is exactly 573-574)
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:693 — `bridge.containers.inspect(...)` appears at exactly one call site in the whole renderer; `grep -rn 'containers.inspect' app/src` returns only this line plus the bridge impl (anchorageBridge.ts:894) and a bridge unit test
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1881-1882 — `selectedInspect: selectedId === null ? null : inspectByContainer[selectedId] ?? null`
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:293-299 — `if (!store.selectedInspect) return <DetailCapabilityState title="Loading inspect data" .../>` with no `action` prop, i.e. no retry button; MountsPanel has the same dead end at 371-377
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:383-388 — `emitCompletion` emits `reconciliation.requested` with `"domain": "container"` for every receipt whose Outcome is "succeeded", including the user's own mutation
- /home/soya/dev/tools/docker-ui/app/src/App.tsx:26-29 — the detail screen REPLACES the container list (`store.selectedContainer ? <ContainerDetailScreen/> : <ContainersScreen/>`), so recovering requires Back (ContainerDetailScreen.tsx:146) then re-clicking the row

**Fix.** Delete only the mutated entry (`delete next[payload.resourceId]`) rather than resetting the map, and add an effect keyed on `[selectedId, detailTab, isHost]` that refetches inspect when `detailTab` is `inspect`/`mounts` and `inspectByContainer[selectedId]` is missing.

<sub>Verifier (CONFIRMED): Opened every cited file. Confirmed the wipe, confirmed the single inspect call site by grep, confirmed the core emits the event for the user's own mutation, and confirmed via App.tsx that the list is not visible from the detail screen so re-clicking is not a one-click recovery. Corrected the line range for the wipe (573-574, not 571-577).</sub>

---

#### Live log following and the Exec PTY are never re-established after a core crash/restart — they freeze silently and permanently

`correctness` · `defect` · effort: medium

**Impact.** Host mode. Kill or crash `anchorage-core` with a container's Logs tab open and Follow enabled. The supervisor restarts it, `core.status: ready` fires, `retryEngine()` refreshes the list, and the UI looks healthy — but the log pane never receives another line. No `session.error` arrives because the emitter died with the process, so `selectedDetailErrors.logs` is never set and nothing is shown. Recovery requires toggling Follow, switching tabs, or reselecting the container. The Exec PTY shows status "running" forever with a dead session.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1167-1174 — dependency array is exactly `[bridge, detailTab, followLogs, isHost, selectedContainer?.id, selectedContainer?.state]`; none of these changes on a core restart
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:204-205 — `const bridgeRef = useRef(createAnchorageBridge()); const bridge = bridgeRef.current;` so `bridge` is referentially stable for the lifetime of the store
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1120 — `owner = result.sessionId` captured from the dead core process
- /home/soya/dev/tools/docker-ui/app/electron/core-supervisor.mjs:255-282 — `#onChildExit` nulls `#rpc`, emits `{state:"crashed"}`, and calls `#scheduleRestart()`; the respawned process gets a fresh, empty sessionManager
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:555-568 — the `core.status` handler calls `retryEngine()` only on `state === "ready"` and sets `engineStatus` to "disconnected" for crashed/unavailable/incompatible; it never touches the follow session
- /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:508-524 — the Command Center DOES have the guard (`store.engineStatus !== "ready"` → mark session interrupted); no equivalent exists for logs or exec

**Fix.** Add `engineStatus` (or a core-generation counter bumped on each `core.status: ready`) to both dependency arrays, and surface the same inline "session interrupted" notice CommandCenter.tsx:508-524 already renders.

<sub>Verifier (CONFIRMED): Traced the full restart path through core-supervisor.mjs and confirmed `bridge` is a stable ref, so nothing in either dep array can change. Confirmed the CommandCenter guard exists and that HostExecPanel has the same defect. Also confirmed the existing crash/reconnect test does not cover it.</sub>

---

#### cli.run / session.start accept arbitrary docker argv, so every structured confirm/immutable-ID gate is bypassable by design

`architecture` · `defect` · effort: large

**Impact.** The renderer is a fully trusted control surface: anything that compromises it obtains `docker run --privileged -v /:/host` and therefore host root. The confirm/immutable-ID model protects against UI bugs and mis-clicks, not against a hostile renderer. Every other 'renderer escapes a restriction' finding in this review is bounded by this fact.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:427-458 - validateCLIArgv performs no subcommand check
- /home/soya/dev/tools/docker-ui/app/electron/main.mjs:654-661 - cliRun handler; /home/soya/dev/tools/docker-ui/app/electron/main.mjs:719-725 - assertMutationsEnabled only blocks under `smokeMode`
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:113-116 - session.start calls only validateCLIArgv/validateCLIEnvironment
- /home/soya/dev/tools/docker-ui/app/electron/preload.cjs:1007-1009 - `cli: Object.freeze({ run: ... })` exposed unconditionally to the renderer
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:613 and /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:1326,1334,1387,1394 - the confirm gates that cli.run walks around
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:1424-1429 validateImageReference and :1431-1440 validateVolumeName both reject leading `-`, so the structured paths are not argv-injectable

**Fix.** Document the boundary explicitly in docs/architecture.md: the Electron/Go split is a process-isolation and correctness boundary, not a renderer-containment boundary, and a renderer compromise is equivalent to shell access with docker rights. If containment is actually wanted, the confirmation must live outside the renderer (a main-process native dialog the renderer cannot paint) for any cli.run/session.start whose argv[0] is destructive, and destructive verbs must be rejected in validateCLIArgv.

<sub>Verifier (CONFIRMED): Confirmed exactly as described, and this is the single most consequential true statement across all three surveys - it is the reason ~8 other findings collapse in severity. core/internal/core/service.go:427-458 validateCLIArgv checks only: non-empty, <=1024 args, <=1 MiB each, no NUL, argv[0] is not a path and is not named `docker`, and (non-literal mode only) no target-override flags. There is no subcommand allowlist. app/electron/main.mjs:654-661 adds only `assertMutationsEnabled()`, which per main.mjs:719-725 fires only during desktop smoke. The contrast the surveyor draws is accurate: core</sub>

---

#### Command Center mutations never invalidate renderer state, and the app has no manual refresh anywhere

`correctness` · `defect` · effort: small

**Impact.** Run `system prune`, `network create`, `volume rm`, `compose up`, or `docker run` from the Command Center and nothing in the app is invalidated. Containers eventually catch up via the 2s poll; images and volumes only if you happen to be standing on that screen; the Dashboard's disk-usage panel and engine summary stay stale until restart or until an Anchorage-native mutation fires. The product's two most prominent CTAs ("Compose up", "Run new") are exactly the cases that leave the app wrong, and there is no recovery path short of restarting.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/services/anchorageBridge.ts:1053-1069 — `events.subscribe` subscribes to exactly three names: `core.status`, `reconciliation.requested`, `reconciliation.required`. `operation.started`/`operation.completed` are in the preload allowlist (app/electron/contracts.mjs:27-36 `CORE_EVENTS`, preload.cjs:31-44 `EVENTS`) but the renderer bridge never subscribes to them.
- I traced the core emit sites directly. `cli.run` (core/internal/core/service.go:265-296) emits only `operation.started` and `operation.completed`, and its completed payload is `{"result": result}` with NO `domain` field. `session.start` (core/internal/core/session.go:207) emits only `session.started`. Neither ever emits `reconciliation.requested`/`reconciliation.required` — those come only from `emitReconciliation` (domain.go:1548-1562, called from succeedDomainMutation/failSubmittedMutation at domain.go:1568,1596,1611) and from the containers.action path (engine.go:386,391). So the two events the bridge DOES listen for can never fire from a Command Center run.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:569-586 — the handler rejects anything whose `event.payload.context` differs from `dockerContextRef.current`, then switches on `event.payload.domain` with cases container/image/volume only.
- /home/soya/dev/tools/docker-ui/app/src/screens/DashboardScreen.tsx:172-178 (host) and :316-322 (fixture) — the Dashboard primary CTA is "Compose up", which only calls `store.openCommandCenter("compose up")`. /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:184-191 — the Containers primary CTA "Run new" likewise only calls `store.openCommandCenter("run")`.
- No refresh affordance exists: a repo-wide grep for `>Refresh<` across app/src returns nothing, and `retryEngine` (the only reload entry point) is wired to exactly one call site, WorkspaceStateScreen.tsx:65, which only renders when `store.engineStatus !== "ready"` (App.tsx:19-21). Once connected there is no way to force a reload of anything.

**Fix.** Subscribe the bridge to `operation.completed` and `session.exited`, and on any Command-Center-originated mutation completing successfully invalidate all domains (containers, images, volumes, snapshot) — or classify from the executed argv. At minimum add an explicit Refresh control to the Dashboard and each resource screen.

<sub>Verifier (CONFIRMED): Confirmed exactly as claimed; I additionally verified the negative (that cli.run/session.start emit no reconciliation event and carry no domain field) by reading every emit site in the core rather than inferring it, and I verified there is genuinely no reachable refresh path by checking retryEngine's only call site.</sub>

---

#### Volume "Clean up" is hardcoded to `--all`, so a button labelled "Clean up" behind one native confirm destroys every named unused volume (198 of them on the reference host)

`parity-gap` · `wired-but-gated` · effort: small

**Impact.** The button labelled "Clean up" performs the strictly more destructive variant of the command, removing named volumes the user deliberately created and merely is not using right now — a stopped database's data volume, for example. On the project's own reference host that is 198 named volumes behind a single unstyled GTK message box. The user cannot choose the anonymous-only behaviour plain `docker volume prune` gives them, cannot scope by label, cannot see which volumes will die, and there is no undo.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1670-1676 — `bridge.volumes.action({context, action: "prune", confirmed: true, filters: { all: ["true"] }})`, unconditionally.
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:1286-1291 — the CLI path translates the `all` filter into `--all`; domain.go:1221 passes it as an Engine API filter to `/volumes/prune`.
- `docker volume prune --help` on this host (I ran it): default removes anonymous volumes only; `-a, --all` removes "all unused volumes, not just anonymous ones".
- /home/soya/dev/tools/docker-ui/app/src/screens/VolumesScreen.tsx:29-43 — the button is labelled just "Clean up". The only disclosure is `window.confirm("Remove every unused Docker volume? Volume data cannot be recovered.")` at useAnchorageStore.ts:1657-1662.
- /home/soya/dev/tools/docker-ui/artifacts/host-candidate/screens/host-volumes.png — I opened the project's own live capture: "237 volumes · 543 GB · 198 unused" with the "Clean up" button rendered next to it. That is the real blast radius of one click plus one OK.
- /home/soya/dev/tools/docker-ui/protocol/types.ts:174-179 and core/internal/core/domain.go:1394-1403 — `label` and `label!` filters are implemented and validated in the core and never used by the UI, so there is no way to scope the prune either.

**Fix.** Give prune an explicit in-app dialog with an "include named volumes (--all)" checkbox defaulting to OFF, list the exact volume names that will be removed (the app already holds them with refCount 0), show the reclaimable byte total, and expose the already-supported label filter.

<sub>Verifier (CONFIRMED): All citations accurate. Severity raised from medium to high: the surveyor did not quantify the blast radius, but the project's own host capture shows 198 named unused volumes out of 543 GB, all removable in two clicks with no preview and no undo. This is the highest-consequence irreversible action in the product.</sub>

---

#### Host Containers table CPU and MEMORY columns are permanently "—", and the Stats-tab history charts are wiped every 2 seconds by the container poll

`parity-gap` · `defect` · effort: medium

**Impact.** Two of the eight columns are dead weight in the only mode that talks to real Docker, and the sidebar/status-bar aggregates are replaced with placeholder text. You cannot spot a runaway container from the list — the core reason people open a Docker GUI. And the one place metrics are supposed to work, the Stats tab, renders permanently flat history charts because the list poll clobbers the history array every two seconds.

**Evidence.**
- /home/soya/dev/tools/docker-ui/artifacts/host-candidate/screens/host-containers.png — I opened the project's own live evidence: 102 containers, every CPU and MEMORY cell is "—".
- /home/soya/dev/tools/docker-ui/app/src/services/anchorageBridge.ts:112-116 — `normalizeContainer` reads cpu/memory from `optionalNumber(raw.cpu, raw.CPU, raw.cpuPercent)` etc.; Docker's `/containers/json` (core/internal/core/engine.go:255-292 `engineContainer`) carries no such fields, so both are always null. ContainersScreen.tsx:139-149 then renders "—".
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:916-985 — `containers.stats` polls only when `detailTab === "stats"` for the single selected container.
- /home/soya/dev/tools/docker-ui/app/src/components/Shell.tsx:324-334 — the sidebar EngineCard hardcodes `store.isHost ? "Stats tab" : ...` and `"on demand"` with 0%-width bars; Shell.tsx:371-374 — the status bar reads "live metrics on container Stats".
- Additional defect I verified that the surveyor missed: the stats poll writes cpu/memory AND appends to `cpuHistory`/`memoryHistory` on the container row (useAnchorageStore.ts:958-980), but `refreshContainers` does a wholesale `setContainers(next)` every 2s (useAnchorageStore.ts:489-506) and `normalizeContainer` resets `cpuHistory: []`/`memoryHistory: []` (anchorageBridge.ts:161-166). The host Stats tab renders `container.cpuHistory`/`container.memoryHistory` directly (ContainerDetailScreen.tsx:895-906). Both timers are 2s, so the CPU% and Memory% charts on the Stats tab hold at most one sample and are effectively always empty.

**Fix.** Either poll `/containers/{id}/stats?stream=0` for the visible row window on an interval and populate the columns, or drop the CPU/MEMORY columns in host mode. Separately and independently: stop discarding cpuHistory/memoryHistory in `refreshContainers` — merge the incoming list into existing rows by id instead of replacing them, or hold the history in a store map keyed by container id rather than on the row.

<sub>Verifier (CONFIRMED): Confirmed as claimed, plus one additional verified defect the surveyors missed entirely (the 2s list poll wiping the Stats-tab history arrays), which I traced end to end from the poll through normalizeContainer to the Chart call sites.</sub>

---

#### Container logs are fetched exactly once per container per app run: "Follow" never streams, and "Clear" permanently poisons the fetch cache

`correctness` · `defect` · effort: medium

**Impact.** In host mode the Logs tab shows a frozen snapshot of the last 200 lines captured the first time the container was ever opened. "Follow" is affirmatively misleading. Pressing "Clear" is unrecoverable — navigate away and back and you get an empty pane with a "no log output" empty state implying the container produced nothing.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/services/anchorageBridge.ts:1000-1008 — host `logs` is a one-shot `cli.run` of `["logs","--timestamps","--tail","200", id]` with `timeoutSeconds: 30`. Grepping the whole repo, no follow/stream log variant exists anywhere.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:688-691 — `selectContainer` only fetches when the cache entry is falsy: `logsByContainer[id] ? Promise.resolve(logsByContainer[id]) : bridge.containers.logs(...)`.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1237-1240 — `clearLogs` sets `{...current, [selectedId]: []}`. An empty array is truthy in JS, so the guard above permanently short-circuits every future fetch for that container for the process lifetime.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:213-244 — the Follow toggle only drives `logRef.current.scrollTop = logRef.current.scrollHeight` in the effect at :216-219. It subscribes to nothing and is rendered `aria-pressed` and highlighted while nothing is being followed.
- The session/PTY transport that would fix this already exists and is release-gated: tools/run-performance-evidence.mjs:1285 starts `session.start {argv:["events","--format","{{json .}}"], mode:"pipes", outputWindowBytes:256*1024}` for a 30-minute acknowledged soak, and it is already used in-product by `pullRegistryImage` (useAnchorageStore.ts:1380+) and `HostExecPanel` (ContainerDetailScreen.tsx:590-620).

**Fix.** Route logs through the existing session transport (`sessions.start` with `["logs","--follow","--timestamps",...]`, which already has ack/backpressure/cancel), gated on the Follow toggle. Change the cache guard to `id in logsByContainer` or a sentinel so Clear empties the view without poisoning the fetch.

<sub>Verifier (CONFIRMED): Confirmed exactly; I verified the truthy-empty-array cache-poisoning by reading both the guard and the clearLogs setter. One correction to a supporting citation: surveyor 1 says "the only host subscription is `containers.changed`" (anchorageBridge.ts:1011-1017). That subscription is real but is dead code — the store only calls `bridge.containers.subscribe` when `bridge.mode === "fixture"` (useAnchorageStore.ts:547-552), and `containers.changed` is not in the preload's `EVENTS` set anyway. The substance of the finding is unaffected.</sub>

---

#### Images "Clean up" prunes only dangling images while the header advertises 166 unused; the Dashboard "Prune images" button is a silent no-op; the fixture build labels the same handler "Prune system"

`ux` · `defect` · effort: medium

**Impact.** The screen promises 166 reclaimable images and delivers a button that can only delete untagged layers. From the Dashboard the button is always enabled and, when there is nothing dangling, does absolutely nothing — no dialog, no message, no spinner — which reads as a broken app. And a design-QA-reviewed surface ships copy promising a materially more destructive operation than the code performs.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1308-1314 — `cleanUpImages` always sends `filters: { dangling: ["true"] }`.
- /home/soya/dev/tools/docker-ui/app/src/screens/ImagesScreen.tsx:214-223 — `canCleanUp` additionally requires `image.reference === null` (untagged), so tagged-but-unused images can never be cleaned.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1268-1279 — the header string reports `${unused} unused` computed from `image.reclaimable`, a different and much larger set.
- /home/soya/dev/tools/docker-ui/artifacts/host-candidate/screens/host-images.png — I opened the live capture: header reads "231 images · 164.61 GB listed size · 166 unused" beside a "Clean up" button that can only ever touch `<none>` images.
- /home/soya/dev/tools/docker-ui/app/src/screens/DashboardScreen.tsx:164-171 — the host Dashboard "Prune images" button is disabled only by `store.imageMutationPending`, NOT by `canCleanUp`; useAnchorageStore.ts:1284-1296 early-returns with no error, no toast and no state change when nothing is dangling.
- /home/soya/dev/tools/docker-ui/app/src/screens/DashboardScreen.tsx:308-315 — in fixture mode the identical handler is labelled "Prune system", implying `docker system prune` semantics it does not have. The fixture Dashboard is one of the 24 pixel-compared canonical states (artifacts/design/design-ledger.json row `dashboard`).

**Fix.** Build a real clean-up dialog with an Unused/Dangling choice mapped to `filters:{dangling:["false"]}` / `{dangling:["true"]}`, show the bytes each option reclaims, never leave a destructive button enabled when the action is a guaranteed no-op, and rename the fixture "Prune system" button to match the host build.

<sub>Verifier (CONFIRMED): Merged surveyor 1's images-cleanup finding with surveyor 0's separate "Prune system label" finding — same handler, same defect family. All line numbers verified within one or two lines. I independently confirmed the transport already accepts `dangling=false` by reading both the preload validator and the Go validator.</sub>

---

#### Context switching is not exposed: the app pins itself to the daemon's context at connect, and the Command Center's context selector changes only its own dialog — a genuine wrong-target hazard

`parity-gap` · `core-only-not-wired` · effort: medium

**Impact.** Anyone with more than one Docker endpoint — remote build host, rootless daemon, colima/podman context, DinD test daemon — cannot point Anchorage at it from the UI; they must `docker context use` in a terminal and restart. Worse, the Command Center *appears* to offer context switching, so a user can run a destructive command against `staging` in the palette while every list, the Dashboard and every action button remain bound to `default`. That is a wrong-target hazard, not merely a missing feature.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:510-524 — `retryEngine` calls `bridge.system.capabilities()` with no argument and derives the context from `selectedContext ?? currentContext ?? contexts.find(c=>c.current)?.name ?? contexts[0]?.name`. It writes `dockerContextRef.current` and `setDockerContext(context)` and is never changed again.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1853-1950 — I read the entire returned store object. `dockerContext` is exposed as a read value; there is no `setDockerContext` in the returned API.
- /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:249 — `const [context, setContext] = useState("")` is local dialog state. CommandCenter.tsx:886-911 is the only context `<select>` in the app; its onChange calls `setContext(next)` and `loadCapabilities(next)` and touches nothing in the store. CommandCenter.tsx:713, 744, 759 use it for that dialog's `session.start` only.
- /home/soya/dev/tools/docker-ui/app/src/screens/SettingsScreen.tsx:460-479 — the Settings sections are Appearance, Resources, Docker Engine, Kubernetes, Software updates, Advanced. No Contexts section; in host mode everything except Appearance short-circuits to `HostSettingsUnavailable`.
- The core fully supports it: `CapabilitiesParams.Context` (core/internal/core/discovery.go) and every domain method takes a `context` param (protocol/types.ts:41,47,53,105,153). I ran the ledger: all 9 `docker context {create,export,import,inspect,ls,rm,show,update,use}` rows are `uiPath.surface == "Command Center"`.

**Fix.** Add a context picker to the title bar or status bar wired to a store `setDockerContext` that resets `dockerContextRef`, clears the per-context inspect/stats/logs caches, and re-runs `retryEngine`; then have the Command Center default to and reflect the app-level selection instead of holding its own.

<sub>Verifier (CONFIRMED): Confirmed exactly, including the negative that no `setDockerContext` is exported — I read the full 100-line return object rather than grepping.</sub>

---

#### No compose project model: no grouping, no project-level actions, and container labels are discarded at the bridge (and never populated at all on the CLI transport)

`parity-gap` · `absent` · effort: large

**Impact.** Compose is how most people run multi-container work, and Anchorage has no concept of it. Containers from one project are scattered alphabetically among 102 unrelated rows with no grouping, no project column, and no way to stop or restart a project as a unit. `compose up/down/logs/ps` are palette-only with raw-text output. The Dashboard's most prominent button is named after a compose action it cannot perform.

**Evidence.**
- No compose protocol method exists (protocol/types.ts:276-294) and no compose case exists in core (core/internal/core/service.go:65-215) — I read both in full.
- A grep for `com.docker.compose` across app/src returns nothing; the only compose strings in the renderer are the Command Center's global-option skip lists (app/src/components/commandCenterModel.ts:108-119,147-152).
- The data arrives and is thrown away: core/internal/core/engine.go:260,289 projects container `Labels`, protocol/types.ts:540 carries `labels?: Record<string,string>` on `ContainerProjection`, but anchorageBridge.ts:142-168 `normalizeContainer` builds `AnchorageContainer` without labels and app/src/types.ts:54-71 has no labels field.
- Additional gap I verified that the surveyor missed: `containersListCLI` (core/internal/core/engine.go:293-349) constructs `Container{ID,Name,Image,State,Status,Health,Ports}` with NO Labels at all, so on any CLI-fallback context the labels are not merely dropped at the bridge — they are never fetched. Fixing the renderer alone would not give compose grouping on remote contexts.
- /home/soya/dev/tools/docker-ui/app/src/screens/DashboardScreen.tsx:172-178 — the "Compose up" primary CTA only calls `store.openCommandCenter("compose up")`; it runs nothing and refreshes nothing.
- /home/soya/dev/tools/docker-ui/app/src/screens/BuildsScreen.tsx:5-16 — Builds renders `UnsupportedSurface` in host mode; useAnchorageStore.ts:1898 — `builds: isHost ? [] : BUILD_FIXTURES`.

**Fix.** Short term: add `Labels` to the CLI list projection in engine.go, stop dropping `labels` in `normalizeContainer`, then group the Containers list by `com.docker.compose.project` with a collapsible header showing aggregate state. Medium term: project-scoped start/stop/restart fanning out over member IDs via the existing `containers.action`, and a project logs view over the follow-session machinery.

<sub>Verifier (CONFIRMED): Confirmed as claimed. Added one verified sub-gap the surveyor missed: labels are absent from the core's CLI-transport container list entirely, so this is not a renderer-only fix on remote contexts.</sub>

---

#### Global search advertises containers + images + volumes but filters only containers, and force-navigates the user off the current screen on every keystroke

`ux` · `defect` · effort: medium

**Impact.** With 231 images and 237 hex-named volumes there is no way to find a resource by name on either screen. Worse, a user standing on Images or Volumes who types into the search box is silently thrown to Containers mid-keystroke, losing their place. Docker Desktop scopes search per screen.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/components/Shell.tsx:180 — `<span className="sr-only">Search containers, images, and volumes</span>`; Shell.tsx:194 — `placeholder="Search containers, images, volumes…"`.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:666-670 — `setSearch` calls `setView("containers")` and `setSelectedId(null)` on every keystroke.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1176-1191 — `filteredContainers` is the only consumer of `search`. I grepped: the identifier `search` appears in the store only at :215 (state), :1177/:1191 (filteredContainers), and :1859 (export). Nothing else reads it.
- /home/soya/dev/tools/docker-ui/app/src/screens/ImagesScreen.tsx:24 — `items={store.images}` (unfiltered). /home/soya/dev/tools/docker-ui/app/src/screens/VolumesScreen.tsx:63 — `store.volumes.map(...)` (unfiltered). The only search inputs on Images are the two `registry-search` boxes (ImagesScreen.tsx:101-105, 151-155), which are pull-reference inputs, not local filters.
- artifacts/host-candidate/screens/host-images.png and host-volumes.png — 231 images and 237 volumes (many named as 64-hex strings) on the reference host with no filter field on either screen.

**Fix.** Either scope the search to the active view (filter images/volumes with the same query and stop force-navigating) or relabel the box "Search containers" and add per-screen search inputs to Images and Volumes. Do not navigate on keystroke.

<sub>Verifier (CONFIRMED): Confirmed; I verified the "only consumer" claim by grepping every occurrence of the identifier in the store rather than trusting it.</sub>

---

#### No multi-select, no bulk actions, no column sorting, and no per-row overflow menu anywhere in the app

`parity-gap` · `absent` · effort: large

**Impact.** On the reference host every clean-up action is one row at a time behind a native modal dialog. Docker Desktop ships checkbox multi-select with a bulk Start/Stop/Delete toolbar on Containers and bulk Delete on Images and Volumes, plus sortable columns and a per-row overflow menu. For a 102/231/237-row workload this is the largest day-to-day friction gap.

**Evidence.**
- I ran the grep myself over /home/soya/dev/tools/docker-ui/app/src for `type="checkbox"`, `bulk`, `selectedRows`, `sortBy`, `sortColumn`, `aria-sort` — zero hits across all of app/src and app/electron.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:195-204 — the header row is eight static `<span>` labels, no sort controls, no leading checkbox column.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:38-84 — `ContainerActions` is exactly three icon buttons (toggle / restart / delete). No `…` overflow menu.
- /home/soya/dev/tools/docker-ui/app/src/screens/ImagesScreen.tsx:12-19 and VolumesScreen.tsx:55-61 — image and volume header rows, same shape.
- artifacts/host-candidate/screens/host-containers.png, host-images.png, host-volumes.png — live captures with 102 / 231 / 237 rows confirm no selection column and no sort affordances.
- docs/design_handoff_anchorage/reference-captures/containers.png — the design source itself omits these, so the gap originates upstream in the handoff.

**Fix.** Add a leading checkbox column plus an "N selected" action bar to Containers/Images/Volumes with one confirmation covering the batch, sortable headers with `aria-sort`, and a per-row overflow menu to house the actions that do not fit (the menu pattern already exists at DevEnvironmentsScreen.tsx:103-140).

<sub>Verifier (CONFIRMED): Confirmed by independent grep and by reading all three screens in full.</sub>

---

#### `docker system prune` does not exist anywhere in the product

`parity-gap` · `absent` · effort: medium

**Impact.** The single most common maintenance operation in daily Docker use has no button. A user who wants to reclaim disk must either run narrower operations (two of which exist and one of which is mislabelled) or hand-type `system prune -a --volumes` into the Command Center argv rows and read a raw-text result that invalidates nothing in the app.

**Evidence.**
- Repo-wide grep for "system prune" across app/src, core, protocol and app/electron returns zero hits (I ran it).
- protocol/types.ts:113 — `ImageAction` is remove\|prune\|pull; protocol/types.ts:156 — `VolumeAction` is create\|remove\|prune. There is no `system.action` method in the `RPCRequest` union at protocol/types.ts:276-294 and no such case in core/internal/core/service.go:65-215.
- The only cleanup buttons are DashboardScreen.tsx:164-171 ("Prune images" → dangling only), ImagesScreen.tsx:243-250 ("Clean up" → dangling only) and VolumesScreen.tsx:29-43 ("Clean up" → volume prune --all). Unused *networks* and stopped *containers* — two of the four things `system prune` reclaims — cannot be bulk-cleaned by any route other than the palette.
- `docker system prune --help` on this host (I ran it): "Remove unused data", with `-a/--all` (all unused images not just dangling) and `--volumes` (prune anonymous volumes).
- I ran the ledger: `docker system {df,events,info,prune}` are all 4 rows `uiPath.surface == "Command Center"`.

**Fix.** Add a `system.action` protocol method with `action:"prune"` and explicit `all`/`volumes` booleans plus `confirmed:true`, backed by the Engine prune endpoints (`/containers/prune`, `/images/prune`, `/networks/prune`, `/build/prune`, `/volumes/prune`) so the receipt can report per-category reclaimed bytes, and surface it on the Dashboard beside the disk-usage panel with per-category checkboxes and a reclaim preview.

<sub>Verifier (CONFIRMED): Confirmed by independent grep and by reading the full protocol union and core switch.</sub>

---

#### The Dashboard and the container Stats tab are unavailable entirely on any CLI-fallback (remote/SSH) context, because system.snapshot and containers.stats are native-transport-only

`parity-gap` · `wired-but-gated` · effort: medium

**Impact.** On any Docker context that resolves to the CLI transport — the common remote/SSH daemon case — the user loses the entire Dashboard (disk usage, engine facts, container/CPU/memory totals, reclaimable) and the entire Stats tab, on top of the already-documented volume read-only lockout. Three of the product's headline surfaces silently degrade to error panels with no explanation that the cause is the connection method rather than a transient failure. Together with the volumes lockout this makes remote contexts a materially different and much poorer product, and nothing in the UI, README or docs says so.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:33-42 — `systemSnapshot` returns `nativeTransportRequired("system.snapshot", contextName, err)` on both `errTransportUnsupported` branches (endpoint resolution and client construction). There is no CLI fallback for `docker system df`/`docker info`, unlike every other domain method.
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:426-435 — `containerStats` does the same: `nativeTransportRequired("containers.stats", ...)` with no CLI fallback, despite `docker stats --no-stream --format json` existing.
- Contrast with the domains that DO fall back: containers.list (engine.go:293 `containersListCLI`), containers.inspect, images.list/action (domain.go:914-931 `imagesActionCLI`), volumes.list/action (domain.go:845 `volumesListCLI`, domain.go:1176-1193 `volumesActionCLI`). Snapshot and stats are the only two hard-gated methods.
- /home/soya/dev/tools/docker-ui/app/src/screens/DashboardScreen.tsx:72-95 — with no snapshot the entire Dashboard collapses to a `role="status"` block reading "System snapshot unavailable" plus whatever `hostDomainState.snapshot.error` says. There is no degraded Dashboard.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:326-378 — `refreshSnapshot` catches and stores the error but never retries and never explains that the cause is the transport.

**Fix.** Either add CLI fallbacks for these two methods (`docker system df --format {{json .}}` + `docker info --format {{json .}}`, and `docker stats --no-stream --format {{json .}}`), or surface the transport as a first-class piece of UI state: when a context is CLI-only, say so once at the top of the app and mark the degraded surfaces with the reason rather than a generic "unavailable".

---

#### Container removal is state-gated to stopped containers and `force` is structurally unreachable from the renderer

`parity-gap` · `wired-but-gated` · effort: small

**Impact.** In host mode the Delete control is permanently disabled for running, paused, restarting, removing and unknown containers, with no tooltip or explanation. Every layer below the renderer implements force removal and is validated for it; only the top ~3 lines of TypeScript withhold it. This is the user's reported bug.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/utils/containerPresentation.ts:92-94 — `canRemoveContainer` returns true only for ["created","exited","dead","stopped"]. Verified verbatim.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:79 — `disabled={isPending \|\| !canRemoveContainer(container)}` on the row Delete button. Verified.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:187 — identical guard on the detail-header Delete button. Verified.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:848 — `if (!canRemoveContainer(container)) return;` silent no-op with no error surfaced. Verified.
- STRONGER EVIDENCE THE SURVEYOR MISSED: /home/soya/dev/tools/docker-ui/app/src/types.ts:443-455 — the renderer-facing bridge interface itself is `remove(id: string, context?: string): Promise<void>`. There is no options parameter anywhere in `ContainerOperations`, so force/volumes/timeoutSeconds are unreachable by type, not merely unset.
- /home/soya/dev/tools/docker-ui/app/src/services/anchorageBridge.ts:834-850 — `action()` builds `...(operation === "remove" ? { options: { confirmed: true as const } } : {})`. `force` is never sent. Verified.

**Fix.** Widen `canRemoveContainer`, add an options argument to `ContainerOperations.remove` (app/src/types.ts:448) and thread `{ force, volumes }` through `anchorageBridge.ts:834-850`. Replace the two `window.confirm` calls (ContainersScreen.tsx:32-37, ContainerDetailScreen.tsx:119-127) with a dialog that states plainly the container will be SIGKILLed. Remove the silent early-return at useAnchorageStore.ts:848 or surface it as an error.

<sub>Verifier (CONFIRMED): Every citation is real and says what is claimed. I added a stronger piece of evidence the surveyor missed: the bridge INTERFACE (types.ts:443-455) has no options parameter at all, so this is a structural, not a stylistic, omission. SEVERITY RE-GRADED critical -> high: two in-product workarounds exist (Stop then Delete for running containers; Command Center `container rm -f <name>` — and the Command Center accepts a literal container NAME, so the surveyor's 'must transcribe a 64-char ID' framing is wrong; only the structured RPC requires the full 64-hex ID, see engine.go:582-594). The paused de</sub>

---

#### Stats-tab CPU/Memory charts are permanently empty in host mode — the 2s container-list poll destroys the history the stats poll builds

`correctness` · `defect` · effort: small

**Impact.** The two sparklines under the Stats tab render zero or one bar forever in host mode while looking correct in browser mode against fixtures. The numeric stat cards work (they read `store.selectedStats`, held separately at useAnchorageStore.ts:960-963), so the failure reads as a styling bug rather than a data bug. The release design gate masks precisely these two plots, so it is structurally incapable of detecting the regression.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:964-983 — the stats poll patches the selected container with `cpuHistory: [...container.cpuHistory, next.cpuPercent].slice(-48)` and the same for memoryHistory. Verified.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:490-508 — `refreshContainers` calls `setContainers(next)`, a wholesale replacement with freshly normalized objects. Verified.
- /home/soya/dev/tools/docker-ui/app/src/services/anchorageBridge.ts:160-165 — `normalizeContainer` sets `cpuHistory: Array.isArray(raw.cpuHistory) ? ... : []`; `containers.list` never returns cpuHistory (core/internal/core/types.go:159-170 has no such field), so every refresh yields `[]`. Verified.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:603-625 — the list poll runs on `window.setInterval(poll, 2_000)` whenever isHost && engineStatus === 'ready', on every screen. Verified.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:928-934 — the stats poll re-arms via `window.setTimeout(..., 2_000)`, so at most one sample exists between wipes. Verified.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:896-907 — `HostStatsPanel` renders `<Chart values={container.cpuHistory}>` / `container.memoryHistory` — exactly the arrays being reset. Verified.

**Fix.** Stop storing derived metric history on the container projection. Keep a dedicated `Record<containerId, { cpu: number[]; mem: number[] }>` written only by the stats poll and have `HostStatsPanel` read from it; or make `refreshContainers` merge by id instead of replacing. Add a host-mode test asserting N stats samples produce N chart bars.

<sub>Verifier (CONFIRMED): Reproduced by reading: both the wipe and the append are unconditional and run on ~2s cadences. I added two pieces of evidence the surveyor missed — the `Chart` implementation at ContainerDetailScreen.tsx:743-769 (proving 0-1 values renders blank) and docs/parity-and-release-gates.md:94-95 (the design gate masks these exact plots, explaining why QA never caught it). Severity held at high.</sub>

---

#### Live stats are one-shot polls of a single selected container; the Containers list CPU and MEMORY columns are permanently "—"

`parity-gap` · `wired-but-gated` · effort: medium

**Impact.** The Containers table advertises CPU and MEMORY columns that show an em-dash for every row, always, in host mode. Users cannot see which container is consuming the machine — the single most common reason to open a Docker UI. Even the detail view samples one container, at 2s granularity, only while its Stats tab is foregrounded.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:439-441 — `containerStats` hardcodes `values.Set("stream", "false")` and `values.Set("one-shot", "true")`; there is no streaming or batch stats path in the core. Verified.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:917-924 — the stats effect early-returns unless `isHost && selectedContainer && detailTab === "stats"`. Verified.
- /home/soya/dev/tools/docker-ui/core/internal/core/types.go:159-170 — the `Container` projection returned by containers.list carries id/name/image/imageId/state/status/health/ports/labels/created and NO cpu or memory field. Verified.
- /home/soya/dev/tools/docker-ui/app/src/services/anchorageBridge.ts:111-117,155-157 — `normalizeContainer` therefore always yields `cpu: null, memory: null`. Verified.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:136-149 — rows render `container.state === "running" && container.cpu !== null ? ... : "—"`. Verified.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:196-205 — the table head renders permanent CPU and MEMORY column headers. Verified.

**Fix.** Either (a) add a batch stats path (`docker stats --no-stream --format '{{json .}}'` via cli.run, or per-container `GET /containers/{id}/stats?stream=true`) driving the list columns on a slower cadence, or (b) drop the CPU/MEMORY columns in host mode. (b) is honest and trivial; (a) is the parity fix.

<sub>Verifier (CONFIRMED): All citations verified verbatim. I added Shell.tsx:325,332 as corroborating evidence — the sidebar already degrades to literal 'Stats tab'/'on demand' placeholders in host mode, which the surveyor missed and which shows the gap is known but undocumented. Severity held at high.</sub>

---

#### One-shot stats make the reported CPU percentage a lifetime average, not a live rate — empirically wrong by 8x to 50x against the same daemon

`correctness` · `defect` · effort: small

**Impact.** The Stats tab's headline CPU number — the only live CPU figure Anchorage produces in host mode — is a lifetime average of the container's CPU consumption since it started, not its current usage. Because it barely moves between samples it also looks plausible and stable, so the error is invisible. This is worse than the empty charts reported separately: the empty chart is obviously broken, this silently lies. It also directly undermines the project's stated evidence-not-simulation principle (docs/parity-and-release-gates.md:37-41). Note the memory figures are unaffected (they are absolute, not deltas).

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:439-441 — `containerStats` sets `stream=false` AND `one-shot=true`.
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:504-513 — `projectContainerStats` computes `cpuPercent = cpuDelta / systemDelta * onlineCpus * 100` where `cpuDelta = positiveDelta(CPUStats.total_usage, PreCPUStats.total_usage)` and `systemDelta = positiveDelta(CPUStats.system_cpu_usage, PreCPUStats.system_cpu_usage)` (positiveDelta at domain.go:1717-1722).
- EMPIRICAL PROOF against the user's live daemon (Docker 29.6.2, API 1.55, read-only): `GET /containers/<id>/stats?stream=false&one-shot=true` returns `precpu_stats = {"cpu_usage":{"total_usage":0,...}}` with no `system_cpu_usage`. There is no previous sample to delta against, so cpuDelta degenerates to the container's LIFETIME cpu time and systemDelta to the host's total CPU time since boot.
- EMPIRICAL COMPARISON, three containers, same instant — Anchorage's one-shot formula vs the two-cycle (`stream=false` only) formula vs `docker stats --no-stream`: buzz-minio one-shot=1.6694% / two-cycle=0.0322% / docker=0.02%; hyper-trader-operator-api-1 one-shot=0.0612% / two-cycle=0.4829% / docker=0.36%; hyper-trader-grafana-1 one-shot=0.2151% / two-cycle=0.1150% / docker=0.15%. The one-shot value is off by ~52x high in the first case and ~8x low in the second.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:855-861 — `HostStatsPanel` renders `${stats.cpuPercent.toFixed(1)}%` as the headline CPU number with no caveat.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:964-983 — the same value is also written onto `container.cpu`, which feeds `cpuTone` (containerPresentation.ts:58-63) and would drive the list CPU column if it ever survived.

**Fix.** Drop `one-shot=true` at domain.go:440-441 and keep only `stream=false`, which makes the daemon wait two collection cycles and populate `precpu_stats` correctly (verified above: the two-cycle values match `docker stats` to within rounding). The cost is ~1s of added latency per sample, which is acceptable for a 2s poll; alternatively keep one-shot and compute the delta client-side across consecutive samples in the core. Add a core test asserting cpuPercent is within tolerance of a two-sample delta.

---

#### No network management of any kind — not in the protocol, not in the core, not in the UI

`parity-gap` · `absent` · effort: large

**Impact.** Networks are one of Docker's four core object types alongside containers, images and volumes. Anchorage ships dedicated screens for the other three and nothing for networks: you cannot list networks, see which containers are attached to which network, create or remove a network, or connect/disconnect a running container. Debugging 'why can't service A reach service B' — an extremely common compose workflow — has no in-product surface at all. The container inspect projection carries per-container network membership but nothing aggregates it.

**Evidence.**
- I grepped app/src, app/electron, protocol and core for `networks.list`, `networks.action`, `NetworksList`: zero hits.
- /home/soya/dev/tools/docker-ui/protocol/types.ts:276-294 — the `RPCRequest` union has no network method.
- /home/soya/dev/tools/docker-ui/protocol/v1.schema.json — I enumerated every enum: the reconciliation domain enum is exactly `['container','image','volume']` and the destructive-domain enum is `['image','volume']`. Networks are not a domain the protocol knows about.
- /home/soya/dev/tools/docker-ui/app/src/types.ts:1-9 — `ViewId` is dashboard\|containers\|images\|volumes\|builds\|devenv\|extensions\|settings. There is no networks screen.
- The word 'network' appears in the product only as read-only sub-structure: core/internal/core/domain.go:314-326 and 378-383 project `NetworkSettings.Networks` into container inspect, and app/src/data/commandFixtures.ts:90 lists `network create` as a BROWSER-MODE command-tree fixture.
- docker-help-groups.txt — `network` is one of Docker's top-level management commands (connect, create, disconnect, inspect, ls, prune, rm).

**Fix.** Add a `networks.list` / `networks.action` domain mirroring the existing volumes domain exactly (protocol/types.ts:150-185, core/internal/core/domain.go:750-889 volumesList and 1156-1259 volumesAction are a direct template, including the prune result shape), plus a Networks screen alongside Volumes. Even a read-only list with attached-container names would close most of the gap. As an interim step, surface the already-projected `ContainerInspectProjection.networks` as a card in the container detail header.

---

#### Untagged and in-use image rows have a permanently dead delete button; remove-by-ID has no protocol shape

`parity-gap` · `wired-but-gated` · effort: medium

**Impact.** 221 of 232 rows on this machine render a delete control that can never be clicked. The dangling subset (178) is only reclaimable as an all-or-nothing bulk prune, so dropping one 1.1 GB dangling layer means pruning all 178. The in-use subset (43) has no force path. The in-app fallback is typing `docker rmi <id>` into Command Center, i.e. the GUI's core image-management promise degrades to a terminal.

**Evidence.**
- app/src/screens/ImagesScreen.tsx:61-66 — `disabled={!image.usageKnown \|\| image.inUse \|\| !image.reference \|\| store.imageMutationPending}`
- app/src/store/useAnchorageStore.ts:105-106 — `const visibleReferences: Array<string \| null> = references.length > 0 ? references : [null];`
- app/src/store/useAnchorageStore.ts:1336 — `if (!image.usageKnown \|\| image.inUse \|\| !image.reference) return;` re-blocks even if the button were enabled
- protocol/types.ts:115-126 — the remove variant requires both `id: string` and `reference: string`; there is no remove-by-ID-only shape
- core/internal/core/domain.go:1319-1325 — validateImagesAction calls validateImageID then validateImageReference; both mandatory
- app/electron/preload.cjs:585,588 and app/electron/contracts.mjs:669,672 — `request.reference is required for image remove` enforced twice in the sandbox layer

**Fix.** Make `reference` optional on the remove variant in protocol/types.ts:115-126, domain.go:1319-1325, preload.cjs:585-590 and contracts.mjs:669-674. When absent, skip the tag→ID re-resolution (the ID is already immutable) and DELETE `/images/<id>`. Then relax ImagesScreen.tsx:61-66 so a null reference enables the button.

<sub>Verifier (CORRECTED): Every citation is real and says what is claimed. ImagesScreen.tsx:61-66 gate, useAnchorageStore.ts:105-106 (visibleReferences), 1336 (hard return), protocol/types.ts:115-126 (remove requires BOTH id and reference), domain.go:1319-1325 (validateImagesAction), preload.cjs:585/588 and a second copy in contracts.mjs:669/672 all check out. CORRECTED on two points. (1) The surveyor's number understates the problem: I replayed the exact query pair the core issues against this daemon and applied the core merge (domain.go:632-641) plus projectImages verbatim — 231 unique images, 232 rendered rows, of w</sub>

---

#### Bridge hardcodes `all: false, includeDangling: true`; no caller can vary it and the screen has no filter, search, sort, or -a toggle

`ux` · `defect` · effort: small

**Impact.** The Images screen renders 232 rows where `docker image ls` renders 54, 178 of them identical `<none>/<none>` entries with disabled delete buttons, and offers no way to narrow the list. It inverts Docker's own default, which deliberately hides dangling images. Combined with the global-search defect below, there is no way at all to locate an image by name in the UI.

**Evidence.**
- app/src/services/anchorageBridge.ts:911-912 — `const listImages = async (context: string) => { const request = { context, all: false, includeDangling: true };`
- app/src/store/useAnchorageStore.ts:398 — `const result = await bridge.images.list(context);` — the only call site, context-only signature
- protocol/types.ts:102-111 — `all` and `includeDangling` are both settable request fields
- core/internal/core/domain.go:594-641 — the core issues the second `dangling=true` query and merges it whenever `includeDangling` is set
- MEASURED: `docker image ls -q \| wc -l` = 54; `docker image ls --filter dangling=true -q \| wc -l` = 178; the replayed Anchorage request pair yields 231 unique IDs / 232 rows
- app/src/screens/ImagesScreen.tsx:214-293 — two tabs, Clean up, Pull image; no filter box, no column sort, no all/dangling toggle

**Fix.** Default to `includeDangling: false` to match `docker image ls`; add explicit `Show dangling` / `Show all (-a)` toggles bound to `ImagesListRequest.includeDangling` / `all`, plus a client-side repository/tag filter box.

<sub>Verifier (CONFIRMED): Citation line is 912, not 911 (`const request = { context, all: false, includeDangling: true };`) — cosmetic. Confirmed that `bridge.images.list(context)` takes only a context (useAnchorageStore.ts:398), so no caller can vary the request; grep of app/src finds `includeDangling` only at anchorageBridge.ts:912 and in two test files. Confirmed 232 rendered rows by replay vs 54 from `docker image ls`. Confirmed ImagesScreen.tsx:214-293 has exactly two tabs, a Clean up button and a Pull button — no filter input, no sort, no -a toggle. Added evidence: because `all` is also hardcoded false, images re</sub>

---

#### Dashboard "Reclaimable" and "Images" disk figures double-count shared layers — and the daemon already returns the correct numbers in the same response

`correctness` · `defect` · effort: small

**Impact.** The headline disk numbers on the app's landing screen are wrong by 14x (reclaimable) and 2.3x (image total) because per-image `Size` repeats every shared parent layer. A user reading "133 GB reclaimable" runs a prune expecting 133 GB back and recovers 9 GB. There is no in-app signal that the number is derived rather than reported.

**Evidence.**
- app/src/screens/DashboardScreen.tsx:99-102 — `reclaimableImages = snapshot.diskUsage.images.reduce((total, image) => total + (image.containers === 0 ? image.sizeBytes : 0), 0)`
- app/src/screens/DashboardScreen.tsx:109-116 — Images disk bar = `images.reduce((total, image) => total + image.sizeBytes, 0)`
- app/src/screens/DashboardScreen.tsx:210-224 — rendered as the "Reclaimable" stat card, detail "unused images and build cache"
- core/internal/core/domain.go:108-115 — `type engineDiskUsage struct { LayersSize; BuilderSize; Images; Containers; Volumes; BuildCache }` — `ImageUsage` is not modelled
- core/internal/core/domain.go:186-198 — projectDiskUsage copies per-image Size/SharedSize but computes no aggregate
- protocol/types.ts:511-519 — `diskUsage` exposes layersSizeBytes/builderSizeBytes and the record arrays; there is no reclaimable field

**Fix.** Add `ImageUsage { ActiveCount, TotalCount, TotalSize, Reclaimable }` to `engineDiskUsage` (domain.go:108-115) and surface it on `SystemSnapshotResult.diskUsage` (protocol/types.ts:511-519), then render the Images bar from `imageUsage.totalSize` and the Reclaimable card from `imageUsage.reclaimable`. Fall back to `layersSizeBytes` and an explicit "unavailable" when the daemon predates the field, never to the current sum.

<sub>Verifier (CORRECTED): All citations verified: DashboardScreen.tsx:99-102 (reclaimableImages), 109-116 (Images bar), 210-224 (Reclaimable stat card), protocol/types.ts:448-456 and 511-519, domain.go:186-198. Measured against this daemon: Anchorage's formulas give 132.99 GB reclaimable and 164.66 GB images vs `docker system df` Images 71.24 GB / 9.336 GB reclaimable — a 14.2x and 2.3x overstatement, exactly as claimed. CORRECTED because I found a materially better fix than the surveyor's: API v1.55 `/system/df` already returns `ImageUsage.TotalSize` = 71,240,380,554 and `ImageUsage.Reclaimable` = 9,335,605,713, which</sub>

---

#### Ten image verbs have no protocol representation: tag, push, save, load, import, export, history, image inspect, manifest, scout

`parity-gap` · `absent` · effort: large

**Impact.** Beyond list/remove/prune/pull, Anchorage is a terminal wearing an image manager's UI. `docker image inspect` and `docker history` are read-only and cheap (the container equivalent already exists as `containers.inspect`), and `tag` is a two-argument mutation. Their absence means "what layers make up this 1.1 GB image" and "what is this image's entrypoint" have no answer in the GUI.

**Evidence.**
- protocol/types.ts:113 — `export type ImageAction = "remove" \| "prune" \| "pull";` — the complete set
- protocol/v1.schema.json — every method literal in the file: health, system.capabilities, system.snapshot, containers.{list,inspect,stats,action}, images.{list,action}, volumes.{list,action}, cli.run, session.*
- docker image --help (29.7.1) — build, history, import, inspect, load, ls, prune, pull, push, rm, save, tag (12 verbs); docker --help adds search, login, logout, manifest, scout
- app/src/screens/ImagesScreen.tsx:27-74 — the image row has exactly one action control (remove); no context menu, no inspect, no history, no tag, no push
- app/src/components/CommandCenter.tsx:260,1032-1036 and app/electron/contracts.mjs:435-439 — a validated absolute `cwd` is settable, so `docker save -o file.tar` works today without any file-picker affordance
- app/src/components/CommandCenter.tsx:68-69,412-434 — `MAX_RENDERER_OUTPUT_BYTES = 1_048_576` / `MAX_RENDERER_OUTPUT_CHUNKS = 800` ring buffer with byte-drop accounting; this only affects stdout-streaming forms of save

**Fix.** Add `images.inspect` and `images.history` mirroring the existing `containers.inspect` shape (including the raw document field for a JSON tab), then `tag` as a fourth `images.action` variant. Document save/load/import/export as Command-Center-with-cwd operations rather than implying they are impossible.

<sub>Verifier (CORRECTED): The enumeration is exact. protocol/types.ts:113 `export type ImageAction = "remove" \| "prune" \| "pull";`. I extracted every method literal from v1.schema.json: health, system.capabilities, system.snapshot, containers.{list,inspect,stats,action}, images.{list,action}, volumes.{list,action}, cli.run, session.{start,input,resize,signal,cancel,ack} — no image inspect/history/tag/push/save/load. `docker image --help` on 29.7.1 lists 12 verbs (build, history, import, inspect, load, ls, prune, pull, push, rm, save, tag). ImagesScreen.tsx:27-74 has exactly one row action. CORRECTED on the transport </sub>

---

#### One transient poll failure permanently stops polling and replaces the entire UI

`correctness` · `defect` · effort: small

**Impact.** A momentarily slow or erroring Docker daemon blows the whole application away to a full-screen error, discards the current screen's state, and stops all polling until the user clicks Retry. No tolerance threshold, no backoff, no distinction between one failed tick and a dead engine.

**Evidence.**
- app/src/store/useAnchorageStore.ts:603-625 — poll effect early-returns unless `engineStatus === "ready"`; on rejection it calls `setEngineStatus(failure.status)` (610-612), which changes the dep at :625 so the cleanup runs `window.clearInterval(timer)`.
- app/src/store/useAnchorageStore.ts:510-543 — `retryEngine` is the only path back to `ready`; invoked from the mount effect (:546), a `core.status` ready event (:555-557), and the manual button.
- app/src/screens/WorkspaceStateScreen.tsx:61-68 — "Retry connection" is the only user-reachable recovery; verified present.
- app/src/App.tsx:18-21 — `if (store.engineStatus !== "ready") return <WorkspaceStateScreen …>` unmounts the active screen entirely.
- app/electron/main.mjs:610-612 — containers.list IPC timeout is 45,000 ms (not the 30 s jsonl-rpc default).
- app/src/store/useAnchorageStore.ts:176-192 — `classifyEngineFailure` maps a generic timeout to status "error", so a single slow tick renders "Could not load the engine".

**Fix.** Tolerate N consecutive failures before flipping `engineStatus`, keep the interval alive across failures (or install an exponential-backoff retry when it does flip), and surface transient failures as a non-destructive status strip rather than unmounting the screen.

<sub>Verifier (CONFIRMED): Mechanism verified end to end. One evidence line corrected: containers.list does not use the 30 s jsonl-rpc default — app/electron/main.mjs:610-612 gives it `timeoutMs: 45_000`. Everything else holds: a single rejection flips engineStatus, which is a dependency of the poll effect, so the cleanup clears the interval and nothing re-arms it except a manual Retry or a core restart. I also confirmed there is no backoff timer anywhere in the store.</sub>

---

#### Host Stats CPU/Memory history charts can never accumulate — the 2s container poll erases the history the stats sampler writes

`correctness` · `defect` · effort: small

**Impact.** In host mode the Stats tab's CPU % and Memory % charts oscillate between empty and one bar. The advertised 48-sample sliding window never fills. Two independent 2 s writers own the same state with no ownership rule and the poll always wins because it replaces rather than merges.

**Evidence.**
- app/src/store/useAnchorageStore.ts:964-983 — the stats sampler appends one sample per tick with `cpuHistory: [...container.cpuHistory, next.cpuPercent].slice(-48)`.
- app/src/store/useAnchorageStore.ts:490-501 — `refreshContainers` replaces the whole array with `setContainers(next)` from `bridge.containers.list`.
- app/src/services/anchorageBridge.ts:160-165 — `normalizeContainer` sets `cpuHistory: Array.isArray(raw.cpuHistory) ? … : []`; the core's containers.list projection carries no such field (grep for cpuHistory in core/ and protocol/ returns zero hits).
- app/src/store/useAnchorageStore.ts:615 (poll, 2,000 ms) and :928-933 (stats sampler, 2,000 ms) interleave continuously.
- app/src/screens/ContainerDetailScreen.tsx:896-907 — `HostStatsPanel` renders `<Chart values={container.cpuHistory}/>` and `<Chart values={container.memoryHistory}/>` from the wiped array.
- app/src/data/fixtures.ts:17-22,42-43 — browser mode gets synthetic 48-point histories, which is why this is invisible in design QA.

**Fix.** Keep sampled history in a dedicated `statsHistoryByContainer` map keyed by container id (never inside the poll-replaced `containers` array), or have `refreshContainers` merge by id and preserve `cpuHistory`/`memoryHistory` from the previous entry.

<sub>Verifier (CONFIRMED): Verified every link. Both loops run at 2 s and the poll writes last with an empty array, so the 48-sample window holds 0 or 1 entries forever in host mode. It works in browser mode only because fixtures ship pre-populated histories (app/src/data/fixtures.ts:42-43 etc.) — a textbook 'works against fixtures, broken live' case. No test covers it: grep for cpuHistory in app/src/*.test.* finds only containerPresentation.test.ts:38-39 with empty arrays.</sub>

---

#### Every structured RPC re-forks `docker context inspect` and re-negotiates the Engine API; no HTTP connection is ever reused between calls

`performance` · `defect` · effort: medium

**Impact.** ~87% of every containers.list poll is rediscovery that produces no data, and at the shipped 2 s cadence that is 30 docker CLI process spawns per minute (~43,000/day), each exec'ing a large binary, plus two extra unix round trips. Stats polling (2 s) and images/volumes polling (10 s) each pay the same tax independently.

**Evidence.**
- core/internal/core/engine.go:38-47 — `resolveEngineEndpoint` runs `docker context inspect <ctx>` as a subprocess on every call.
- core/internal/core/engine.go:93-116 — `newEngineClient` builds a fresh http.Transport per call; :122 issues a throwaway GET /version before any real work; :156-160 `close()` calls `transport.CloseIdleConnections()`.
- core/internal/core/engine.go:209,216 (containers.list) plus domain.go:31/38, 233/240, 424/431, 562/569, 757/764, 923/925, 1187 — every structured method repeats the same pair.
- core/internal/core/service.go:20-27 — the Service struct has no endpoint or client cache field.
- app/src/store/useAnchorageStore.ts:615 — containers.list is polled every 2,000 ms.
- Measured by verifier on this host: context inspect median 10.9 ms; fresh-dial GET /version 4.1 ms; GET /v1.51/containers/json?all=1 3.0 ms / 164,127 B; core containers.list 23 ms warm — 87% overhead.

**Fix.** Cache the resolved contextEndpoint and a long-lived engineClient per context on the Service, invalidated on context change or connection error, and drop `client.close()` from the per-request path so the keep-alive pool survives. Negotiate the API version once per client. Cache `docker context inspect` with an explicit TTL.

<sub>Verifier (CONFIRMED): Independently reproduced on this host. Median `docker context inspect default` = 10.9 ms over 7 runs; a fresh unix-socket GET /version = 4.1 ms; GET /v1.51/containers/json?all=1 = 3.0 ms for 164 KB; the real core's containers.list = 22.8-23.8 ms warm. That is ~87% rediscovery overhead per poll, even higher than the surveyor's 81%. The Service struct genuinely has no cache field of any kind and `defer client.close()` destroys the keep-alive pool at the end of every request.</sub>

---

#### system.snapshot hard-fails after 60 s on a real host: it calls the unfiltered /system/df and is triggered on engine-ready and after every mutation

`performance` · `defect` · effort: medium

**Impact.** Every container start/stop/remove queues a ~7 s daemon-side disk-usage walk that no screen asked for, serialising against every other Docker client on the machine. On a host with a larger image/volume population it will eventually cross the 45 s IPC timeout and then the 60 s core deadline, at which point the Dashboard genuinely stops loading.

**Evidence.**
- core/internal/core/domain.go:60-67 — systemSnapshot issues GET /v<api>/system/df with no type filter; :29 bounds the whole snapshot at domainReadTimeout = 60 s (:19).
- app/src/store/useAnchorageStore.ts:530-535 — refreshSnapshot runs as soon as the engine is ready; :775, :576, :580, :584 — re-issued after every container/image/volume mutation and on every reconciliation event.
- app/electron/main.mjs:605-609 — system.snapshot IPC timeout is 45,000 ms, shorter than the core's own 60 s deadline.
- Measured by verifier: core system.snapshot = 6,722.7 ms (first) / 6,149.8 ms (warm), returning a result, not an error; raw GET /v1.51/system/df = 6,764 ms / 348,443 B; GET /v1.51/system/df?type=volume = 1,022 ms / 91,947 B.
- app/src/store/useAnchorageStore.ts:554-568 — a `core.status` with state `protocol-error` (what jsonl-rpc.mjs:177-182 triggers on a late reply) matches none of crashed/unavailable/incompatible, so the renderer ignores it; app/electron/core-supervisor.mjs:194-195 only re-emits it as status.

**Fix.** Take /system/df off every automatic path. Split system.snapshot into a cheap /info call and an explicitly user-invoked disk-usage call with its own longer timeout and a visible progress/cancel affordance, or request per-type df and cache with an age stamp. Make the IPC timeout strictly larger than the core deadline for every method.

<sub>Verifier (CORRECTED): The design defect is CONFIRMED; the failure claim is REFUTED as measured. Running the real core against this daemon today, system.snapshot returned successfully in 6,723 ms cold and 6,150 ms warm — no engine_timeout — and a raw GET /v1.51/system/df completed in 6,764 ms returning 348 KB, not '>295 s'. So the Dashboard does load. The surveyor's 60 s figure is not reproducible; it was likely a cold page-cache artifact. What stands: /system/df is unfiltered, sits on an automatic path (engine-ready plus every container/image/volume mutation and every reconciliation event), and 6-7 s of daemon-wide</sub>

---

#### No per-request cancellation exists: abandoned RPCs run to completion holding goroutines, sockets and subprocesses

`architecture` · `absent` · effort: medium

**Impact.** An IPC timeout or a user navigating away leaves the core executing up to 60 s of read work (unbounded for containers.list) or 5 minutes of mutation work, holding an Engine connection and, on CLI-fallback paths, a live docker subprocess. Repeated timeouts accumulate in-flight work with no ceiling.

**Evidence.**
- core/internal/rpc/server.go:88-96 — the request goroutine receives the server-level ctx from Serve; nothing derives a per-request cancellable context.
- core/cmd/anchorage-core/main.go:54,61 — that ctx is the process signal context, cancelled only by SIGINT/SIGTERM.
- core/internal/rpc/server.go:29-31 — `active sync.Map` stores struct{}{}; no cancel func is retained.
- protocol/types.ts — no request-cancel method exists (only session.cancel for CLI sessions).
- app/electron/jsonl-rpc.mjs:69-78 — the client timeout only deletes the local pending entry and rejects; nothing is sent to the core. :177-182 — the late reply hits RPC_UNKNOWN_ID and emits a protocol-error.
- Verifier addition: core/internal/core/engine.go:200-255 (containersList, Engine-API path) has no context.WithTimeout, unlike every method in domain.go.

**Fix.** Derive a per-request context.WithCancel in Serve, store the cancel func in the existing `active` map keyed by request id, add a `request.cancel` protocol method the preload calls when its own timeout fires, and give containers.list the same domainReadTimeout every other read has.

<sub>Verifier (CONFIRMED): Confirmed exactly, and I found the gap is worse than described in one place: containers.list — the 2 s hot path — is the ONLY structured read method with no core-side deadline at all. core/internal/core/engine.go:200-255 never wraps the context, while domain.go wraps snapshot (:29), inspect (:231), stats (:422), images (:560) and volumes (:755) in domainReadTimeout. So a stalled /containers/json read is unbounded in both directions: no deadline and no cancellation. The `active` sync.Map holds only struct{}{} for duplicate-id detection, so the plumbing for a cancel map does not exist.</sub>

---

#### system.capabilities spawns 244 `docker … --help` subprocesses on the first-paint path and re-runs on every Command Center open, with no cache

`performance` · `defect` · effort: medium

**Impact.** First paint of real Docker data is gated on ~2 s and 244 process spawns; the container list cannot appear until the whole CLI help tree has been re-walked. Opening the Command Center ten times costs ~2,440 docker process spawns. The inventory also re-runs on every core restart via the core.status ready -> retryEngine path.

**Evidence.**
- core/internal/core/discovery.go:179-266 — discoverCommandInventory BFS-probes every node with concurrency 8, depth 8, up to 2048 nodes; :268-283 runs one `docker --context <ctx> <path> --help` subprocess per node.
- core/internal/core/discovery.go:163-166 — three more subprocesses for compose/scout/buildx version probes, plus context show/ls/version/info earlier in capabilities().
- Measured by verifier: system.capabilities = 1,945 ms first call, 1,942 ms second call in the same process (no cache); commandInventory.nodeCount = 244; response 399,726 bytes.
- app/src/store/useAnchorageStore.ts:516-525 — `retryEngine` awaits `bridge.system.capabilities()` BEFORE the first `bridge.containers.list(context)`.
- app/src/components/CommandCenter.tsx:395 — every Command Center open calls `loadCapabilities()` again; there is no cache in the store, the bridge, or the core.

**Fix.** Fetch capabilities in parallel with, not before, the first containers.list, and cache the inventory in the core keyed by (docker binary SHA-256, context) with explicit invalidation. Expose a cheap capabilities subset (contexts + current context) for the startup path and the full inventory lazily.

<sub>Verifier (CONFIRMED): Reproduced against the real core: system.capabilities took 1,945 ms and a second call in the same core process took 1,942 ms — proving there is no cache at any layer. commandInventory.nodeCount = 244 and the response line is 399,726 bytes. The surveyor's 2,690 ms is in range; 1.9-2.7 s is the honest band. The first-paint gating and the per-open re-fetch are both confirmed in the renderer.</sub>

---

#### Performance evidence covers a narrow happy path and omits the two slowest core methods entirely

`process` · `defect` · effort: medium

**Impact.** The RSS numbers describe an idle core, not the polling steady state. The 'no dropped bytes / all acknowledged' claim is proven only at 13 KB/s, so backpressure, ack-window exhaustion, head-of-line blocking and the reproduced wedged-session leak are all outside the evidence, while the two slowest core methods have no SLO at all.

**Evidence.**
- tools/run-performance-evidence.mjs:1121-1141 — measureNativeLists defines only containers.list, images.list and volumes.list; grep for system.snapshot / system.capabilities across the whole script returns zero hits.
- docs/parity-and-release-gates.md:168-179 — the release SLO table has no threshold for snapshot or capabilities.
- tools/run-performance-evidence.mjs:1277-1310 — the RSS soak runs a lone `docker events` session; there is no concurrent list polling anywhere in the function.
- artifacts/performance/results.json — streamingSoak.sessionOutput = 13,326 events / 23,612,499 bytes / 13,326 acknowledgements over 1,800,001 ms (13 KB/s), droppedBytes 0; rssBytes p50 9.58 MB, max 14.4 MB under that idle profile.
- tools/run-performance-evidence.mjs:1141-1174 — list latency is 21 back-to-back sequential requests, never at the 2 s / 10 s cadences the app actually uses and never concurrently.
- Measured by verifier on the same host: system.snapshot 6.7 s and system.capabilities 1.9 s — neither is gated; and the ack-window wedge I reproduced is exactly the case the soak's 'all acknowledged' claim assumes away.

**Fix.** Add system.snapshot and system.capabilities to the measured methods with their own SLOs; run the RSS soak with the real polling profile active (containers 2 s, images/volumes 10 s, stats 2 s); add a high-rate session case (>1 MB/s) and a deliberately non-acking consumer case to prove backpressure and cleanup rather than assuming them.

<sub>Verifier (CONFIRMED): Confirmed on every point by reading the harness and the artifact. `grep -n 'system.snapshot\|system.capabilities' tools/run-performance-evidence.mjs` returns nothing; measureNativeLists (:1121-1141) covers only the three lists; runStreamingSoak (:1277-1310) starts a single `docker events` session and samples RSS in a loop with no concurrent polling of any kind. The soak arithmetic checks out from results.json: 23,612,499 bytes / 1,800,001 ms = 13 KB/s, 13,326 events = 7.4/s, 13,326 acknowledgements, droppedBytes 0. One correction: the bundle does NOT report passing on a machine where the Dashb</sub>

---

#### Shipped AppImage .desktop entry hard-codes --no-sandbox, disabling the Chromium OS sandbox while docs claim it is enabled

`security` · `defect` · effort: small

**Impact.** webPreferences.sandbox (no Node in the renderer) and the Chromium OS sandbox (seccomp-bpf + namespaces) are different controls and the evidence conflates them. On any desktop-integrated launch the renderer runs with no OS-level confinement in a process that holds the user's Docker socket access — root-equivalent on a standard Linux install. A renderer bug reachable from container-supplied text escalates straight to user code execution with no sandbox boundary, and no gate would catch it.

**Evidence.**
- app/release/Anchorage-0.1.0-x86_64.AppImage — squashfs at offset 188392 (verified by superblock scan); `anchorage.desktop` reads `Exec=AppRun --no-sandbox %U`.
- Same payload, AppRun lines 38-57: `HAVE_NO_SANDBOX=0` … `if [ $HAVE_NO_SANDBOX -eq 0 ] && ! unshare -Ur true 2>/dev/null ; then NO_SANDBOX=(--no-sandbox) fi`, with an in-script comment stating the app should start without sandboxing rather than crash.
- app/electron-builder.yml:49-57 — the `linux.desktop.entry` block sets Name/GenericName/Comment/Categories/Keywords/StartupWMClass but never overrides Exec, so electron-builder's --no-sandbox default stands.
- app/electron/main.mjs:70 — `app.enableSandbox()` sets webPreferences.sandbox; :482-493 the packaged smoke reads `getLastWebPreferences()` and asserts only those, never process.argv or app.commandLine.
- app/scripts/package-desktop.mjs:1782-1797 — both smokes invoke PACKAGED_EXECUTABLE and appImage.path directly with APPIMAGE_EXTRACT_AND_RUN=1, never through AppRun, so the --no-sandbox path is never exercised by any gate.
- README.md:77-78 "Electron enables context isolation and sandboxing"; docs/release-report.md:140-141 "The renderer is sandboxed…"; artifacts/security/electron-config.json check `renderer-process-isolation` records only `"sandbox": true` from webPreferences.

**Fix.** Set `linux.desktop.entry.Exec: AppRun %U` in app/electron-builder.yml. Add a runtime assertion in the packaged smoke that fails if process.argv contains --no-sandbox/--disable-setuid-sandbox or app.commandLine.hasSwitch('no-sandbox'), and record the observed OS-sandbox state in artifacts/security/electron-config.json as a check distinct from webPreferences.sandbox. If the AppImage format genuinely cannot keep it on, say so explicitly in README.md:78 and docs/release-report.md:141 instead of asserting the renderer is sandboxed.

<sub>Verifier (CONFIRMED): I independently extracted the squashfs (offset 188392, confirmed by scanning for the hsqs superblock) and read both files. anchorage.desktop contains exactly `Exec=AppRun --no-sandbox %U`, and AppRun lines 38-57 fail open on `unshare -Ur true` with the comment 'we prefer the app to start without sandboxing rather than crash on startup'. Threat model: the attacker is whoever controls content the renderer parses — container/image names, `docker logs` bytes, xterm output from a pulled image — combined with a Chromium renderer bug. They start with NO local access and no Docker socket access, so th</sub>

---

#### Release is an unsigned AppImage with no update channel and no signature-verification path

`security` · `absent` · effort: medium

**Impact.** Users have no cryptographic way to distinguish a genuine Anchorage build from a trojaned one, and there is no channel to deliver Chromium security fixes — an installed copy will still run Chromium 150.0.7871.129 whenever the next Chromium 0-day lands. For a tool whose purpose is driving the Docker socket, both matter more than for a typical desktop app.

**Evidence.**
- readelf -S app/release/Anchorage-0.1.0-x86_64.AppImage shows .digest_md5 @0x2ae58, .upd_info @0x2ae68, .sha256_sig @0x2b268, .sig_key @0x2b668; reading each range gives 0 non-zero bytes (verified by verifier).
- app/release/ contains only Anchorage-0.1.0-x86_64.AppImage, builder-debug.yml, linux-unpacked/ and release-verification.json — no latest-linux.yml.
- app/scripts/package-desktop.mjs:1760-1768 — builder is invoked with `--publish never`; app/electron-builder.yml has no publish block.
- `grep -rn 'autoUpdater\|electron-updater\|feedURL' app/electron/*.mjs app/electron/*.cjs` returns nothing; electron-updater is absent from app/package.json.
- docs/release-report.md:17 (`\| Signing \| Unsigned \|`) and :161, README.md:177-178, and docs/parity-and-release-gates.md:206 all state this honestly.

**Fix.** Before any public distribution: (a) sign the AppImage (`appimagetool --sign`, populating .sha256_sig/.sig_key) or publish detached .asc + SHA256SUMS; (b) publish the release-verification.json receipt hash alongside the download so the existing chain is externally checkable; (c) only then add an update channel, requiring signature verification rather than sha512-in-YAML alone. Until (a) exists, keep the current no-updater posture — an unverified auto-update would be worse.

<sub>Verifier (CONFIRMED): Independently verified. readelf shows .digest_md5 (16 B), .upd_info (1024 B), .sha256_sig (1024 B) and .sig_key (8192 B) present; reading each at its file offset gives 0 non-zero bytes in all four. app/release/ contains no latest-linux.yml, and package-desktop.mjs:1766-1767 passes `--publish never`. Threat model: the attacker is the distribution channel (mirror, MITM, re-upload) and needs no prior access, so this passes the threat test cleanly. The docs disclose it honestly in three places, so this is a shipping-readiness gap rather than a false claim.</sub>

---


### MEDIUM (74)

#### Follow-mode log line IDs collide (Date.now() + chunk-local index), producing duplicate React keys and permanently dropping lines on re-select

`correctness` · `defect` · effort: small

**Impact.** Host mode, any container writing to both stdout and stderr or producing more than one 16 KiB chunk per millisecond. Colliding ids such as `<id>-follow-1754212345678-0` produce React duplicate-key warnings and can reuse the wrong DOM node. On the next re-select of that container the dedupe pass runs over `cached ++ cached` and silently discards every duplicate-id line beyond the first — real log content is lost with no indication.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1045 — ``id: `${selectedContainer.id}-follow-${Date.now()}-${index}` `` where `index` is the position within a single event's line array and restarts at 0 for every `session.output`
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:305-313 — `startReadersAndWaiter` starts one goroutine per `s.readers` entry, so stdout and stderr are read concurrently; a single stream also emits multiple events per millisecond at 16 KiB chunks
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:260-261 — `store.visibleLogs.map((line) => (<div className="log-line" key={line.id}>` uses the colliding value directly as the React key
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:697-712 — `selectContainer` builds `merged = [...logsResult.value, ...(current[id] ?? [])]` then drops any repeated `line.id`
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:689-691 — because cached logs are reused verbatim, the merge on re-select is `cached ++ cached`, and the id-dedupe therefore keeps only the FIRST line for each id — every colliding line after the first is permanently discarded

**Fix.** Use `${sessionId}-${payload.sequence}-${index}`; `sequence` is strictly increasing per session (core/internal/core/session.go:434-436) so it is unique by construction.

<sub>Verifier (CONFIRMED): Confirmed the id template and the React key. CORRECTED the loss mechanism: the surveyor attributed it to a fresh `docker logs --tail 200` fetch on re-select, but that fetch never happens (see the refuted finding below) — the loss actually comes from the self-concatenation `cached ++ cached` being run through the id-dedupe, which is a stronger and more reliable trigger. Downgraded high→medium: the user-visible harm is key warnings plus occasional line loss, not corruption of Docker state.</sub>

---

#### Mutations reconcile against a possibly pre-mutation containers.list because refreshContainers shares an in-flight promise with the 2 s poll

`correctness` · `defect` · effort: small

**Impact.** Host mode. If a poll is still in flight at the instant the mutation RPC resolves, `runMutation` awaits it and calls `setContainers(preMutationData)` while clearing the pending spinner and the error, so the row briefly shows the old state as though the action did nothing. Measured window is roughly (list latency)/(poll interval) ≈ 40-70 ms / 2 000 ms ≈ 2-3 % of mutations on a local socket, and it self-corrects on the next poll ≤ 2 s later. On a remote (ssh:// or tcp://) context, where list latency is far higher, the probability rises proportionally.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:490-507 — `refreshContainers` returns the in-flight promise unconditionally (`if (containerRefreshRef.current) return containerRefreshRef.current;`) with no context-chaining, unlike refreshSnapshot (326-336), refreshImages (379-390) and refreshVolumes (429-440) which all chain when the context differs
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:770-785 — `runMutation` does `await refreshContainers()` then `setError(null)` and clears `pendingIds`
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:600-615 — the background poll calls `refreshContainers()` on a 2 000 ms interval
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:575 — the `reconciliation.requested` handler also calls the same shared `refreshContainers()`, so the event that arrives before the RPC reply does NOT rescue the case
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:881-892 — `deleteContainer` deliberately bypasses `refreshContainers` and calls `bridge.containers.list` directly
- MEASURED: `printf '{"id":1,"method":"containers.list","params":{"context":"default","all":true}}' \| ./core/bin/anchorage-core` completes in 0.072 s wall INCLUDING Go process startup, against a local unix socket via the engine-api path — not "hundreds of ms"

**Fix.** Give `refreshContainers` a `{ force: true }` option that chains off the in-flight request the way `refreshSnapshot`/`refreshImages` already do, and use it from `runMutation` and from the `reconciliation.*` handler.

<sub>Verifier (CORRECTED): The code path is exactly as described and I confirmed the reconciliation event does not rescue it (it calls the same shared function). But I refuted the magnitude: I measured `containers.list` end-to-end at 72 ms including process spawn, so the surveyor's "routinely takes hundreds of ms" is wrong for local sockets. Combined with the ≤2 s self-correction this is a medium, not a high. Also noted the single-flight design is intentional and test-covered, so the fix must be additive.</sub>

---

#### Paused containers are a UI dead end: no pause/unpause action exists, the primary control is disabled, and delete is disabled

`parity-gap` · `absent` · effort: medium

**Impact.** Host mode. `docker pause <container>` outside the app leaves Anchorage showing the container with the amber "pulling" treatment, a greyed-out primary button with no glyph, Delete greyed out, and only Restart enabled. `removing` and `unknown` are worse — Restart is disabled there too (canRestartContainer at containerPresentation.ts:83-90). Recovery requires the literal-argv Command Center or a terminal; there is no first-class control.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/utils/containerPresentation.ts:67-81 — `primaryContainerAction` returns "stop" for running/restarting, "start" for created/exited/stopped, and `null` for paused, removing, dead, unknown, pulling
- /home/soya/dev/tools/docker-ui/app/src/utils/containerPresentation.ts:91-93 — `canRemoveContainer` is `["created","exited","dead","stopped"]`, excluding paused
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:53-60 — `disabled={isPending \|\| primaryAction === null}`, title "Unavailable" (line 29), and the ternary at 56-60 renders `null` (no glyph) when `primaryAction` is neither stop nor start
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:596-603 — `validateAction` allows only start/stop/restart/remove and returns `unsupported_container_action` otherwise
- `grep -rniw unpause app/src app/electron core protocol` returns ZERO matches; `pause` matches only the Phosphor icon glyph (app/src/components/AnchorageIcon.tsx:38, 130-133) used for the Stop button
- /home/soya/dev/tools/docker-ui/app/src/utils/containerPresentation.ts:5-24 — `statusKind` folds `paused` into the `"pulling"` visual bucket alongside restarting/removing

**Fix.** Add `pause`/`unpause` to `ContainerAction` in protocol/types.ts:70, to `validateAction` (engine.go:596), to `containerActionEngine`'s switch (engine.go:435-448, `/containers/{id}/pause` and `/unpause`) and to the contracts/preload action sets; make `primaryContainerAction` return `"unpause"` for paused and give paused its own `statusKind` bucket.

<sub>Verifier (CORRECTED): Verified the total absence of pause/unpause in protocol, core, preload, contracts and UI, and verified every disabled-control claim in ContainersScreen. CORRECTED one claim: the Command Center imposes no subcommand allowlist (I read validateDockerArgv end to end), so an in-app workaround does exist. Downgraded high→medium accordingly.</sub>

---

#### Multi-byte UTF-8 split across a 16 KiB read boundary is corrupted into replacement characters in all live output views

`correctness` · `defect` · effort: medium

**Impact.** Host mode. A container logging CJK, Cyrillic, emoji, or box-drawing progress output will eventually have a code point straddle a 16 KiB read boundary. The core marks that chunk base64, the renderer decodes it standalone, and the trailing partial sequence plus the leading continuation bytes of the next chunk each decode to U+FFFD — one character becomes two or three replacement glyphs. Affects the Logs pane, the Exec PTY, the Command Center terminal and image-pull output. `docker pull` progress is a very likely trigger given its rate and its use of Unicode progress bars.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:24 — `outputChunkSize = 16 * 1024`
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:350-364 — `readOutput` reads into a fixed buffer and hands `buffer[:count]` (line 362) straight to `handleOutput`; boundaries fall wherever the pipe delivers
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:439-442 — `if !utf8.Valid(data) { encoding = "base64"; encoded = base64.StdEncoding.EncodeToString(data) }` — a chunk ending mid-sequence ships as base64 instead of being held back
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:413 — the truncation path `s.emitOutput(stream, data[:allowed])` can split mid-sequence too (surveyor mis-cited this as domain.go)
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:164-174 — `decodeSessionData` constructs `new TextDecoder()` per event with no `{stream:true}` and no cross-event state
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:68-78 — HostExecPanel's private `decodeSessionOutput`, same pattern

**Fix.** Hold back a trailing incomplete UTF-8 sequence in `cliSession.readOutput` until the next read completes it (falling back to base64 only for genuinely binary data), or have each renderer reuse one `TextDecoder` per session with `decode(bytes, {stream: true})`.

<sub>Verifier (CONFIRMED): Read all four sites. Mechanism is exactly as described and none of the three renderer decoders carries streaming state. Corrected one file citation (the truncation split is session.go:413, not domain.go).</sub>

---

#### domainCLIOutputLimit (16 MiB) exceeds the 8 MiB JSONL line cap, so a large CLI-fallback mutation receipt makes Electron SIGTERM the core mid-operation

`correctness` · `defect` · effort: small

**Impact.** Host mode against a context whose endpoint is not a local unix socket (ssh:// or tcp://), which forces `errTransportUnsupported` and the CLI mutation path (domain.go:914-931, 1176-1193). A prune emitting more than 8 MiB of `deleted: sha256:…` lines tears down the RPC connection, SIGTERMs the core mid-prune, rejects the in-flight `images.action` with RPC_LINE_TOO_LARGE so the UI reports failure for an operation that actually succeeded, and triggers a supervisor restart (which then also fires a full ~2.4 s capabilities sweep — see the discovery finding).

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:21 — `domainCLIOutputLimit = 16 * 1024 * 1024`, versus /home/soya/dev/tools/docker-ui/core/internal/core/command.go:25 `cliOutputLimit = 1024 * 1024` used by the `cli.run` path (engine.go:507, service.go:274) which DOES match the contract
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:1137-1139 and 1298-1300 — `receipt.Stdout = string(result.stdout); receipt.Stderr = string(result.stderr)` with no bound
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:1537-1546 — `emitDomainCompleted` serialises that receipt into one `operation.completed` line; the same receipt is ALSO returned in the RPC result (domain.go:1152, 1313), so both lines can be oversized
- /home/soya/dev/tools/docker-ui/core/internal/rpc/server.go:132-147 — `write` applies no size limit to outbound lines (the 8 MiB `maxRequestLineBytes` at line 18 is inbound only)
- /home/soya/dev/tools/docker-ui/app/electron/jsonl-rpc.mjs:6 and 96-110 — `MAX_RPC_LINE_BYTES = 8 * 1_024 * 1_024`; exceeding it emits `RPC_LINE_TOO_LARGE`, calls `#close(...)` rejecting every pending request, then `child?.kill?.("SIGTERM")`
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:1200-1208 — receipt `stdout`/`stderr` capped at 1_048_576 chars; main.mjs:778-787 drops the whole event with only a `console.error` when validation throws

**Fix.** Truncate `receipt.Stdout`/`Stderr` where they are populated to well under the 1 MiB contract cap with an explicit truncation flag, and add a build/test assertion that `domainCLIOutputLimit <= MAX_RPC_LINE_BYTES`.

<sub>Verifier (CORRECTED): Confirmed the constant mismatch, the unbounded receipt copy, the unbounded outbound write in rpc/server.go, and the SIGTERM path in jsonl-rpc.mjs. I also found the receipt is returned in the RPC *result* as well as the event, so there are two oversized-line paths, not one. CORRECTED the 1 MiB half: nothing in the renderer consumes `operation.completed`, so the contracts drop is inert. Note the 8 MiB threshold needs ~100k prune output lines, so it is a real but unlikely trigger — severity stays medium mainly because the failure mode (false failure report on a succeeded destructive op + core kil</sub>

---

#### `system.capabilities` spawns ~245 `docker --help` processes per call with no cache, and is re-run on every core restart, Command Center open, and context switch

`performance` · `defect` · effort: medium

**Impact.** Host mode. Every app start, every automatic core restart, every Command Center open and every context switch costs a measured 2.4 s of wall time and ~30 CPU-seconds of `docker` process churn, with nothing cached between calls. Because `retryEngine` awaits capabilities before listing containers, the first paint of live container data is gated behind that sweep. In a crash loop the sweep repeats at 250 ms/1 s/2.5 s backoff intervals. Caveat: the supervisor emits `ready` only after a successful `health` handshake (core-supervisor.mjs:198-220), so a core that dies before handshaking does not trigger the sweep — the amplification requires a core that crashes after handshake (which is exactly what the RPC_LINE_TOO_LARGE path produces).

**Evidence.**
- MEASURED on this machine: `printf '{"id":1,"method":"system.capabilities","params":{}}' \| ./core/bin/anchorage-core` → **2.364 s wall, 16.69 s user + 13.79 s system CPU, 1289 % CPU**. Response line is 388,962 bytes. That is ~30 CPU-seconds burned per call
- /home/soya/dev/tools/docker-ui/core/internal/core/discovery.go:14-20 — `inventoryMaxNodes = 2048`, `inventoryConcurrency = 8`, `inventoryCommandTimeout = 4s`
- /home/soya/dev/tools/docker-ui/core/internal/core/discovery.go:268-282 — `probeHelpNode` runs one `docker --context <ctx> <path...> --help` subprocess per inventory node
- /home/soya/dev/tools/docker-ui/artifacts/docker/system-capabilities.json — `commandInventory: {nodeCount: 244, complete: true, limitReached: false, maxDepth: 8}` on this machine
- MEASURED: `docker --help` alone averages ~84 ms wall (0.421 s for 5 sequential runs)
- NO CACHE: `grep -n 'cache' core/internal/core/discovery.go core/internal/core/service.go` returns zero matches

**Fix.** Cache the command inventory keyed by (docker binary sha256, context name) with a TTL — the binary fingerprint at core/internal/core/command.go:128-139 is a sound invalidation key — and serve repeat `system.capabilities` calls from it. Separately, stop gating `containers.list` behind capabilities in `retryEngine`.

<sub>Verifier (CONFIRMED): CONFIRMED and strengthened by direct measurement against the built core binary: 2.364 s wall / ~30 CPU-seconds, and I verified by grep that no cache exists in discovery.go or service.go. Added the ordering observation that capabilities blocks first paint. Added the correct precondition on the crash-loop amplification (post-handshake crashes only), which the surveyor stated too broadly.</sub>

---

#### `docker rm` and host restart have no store-level host-mode test

`correctness` · `defect` · effort: medium

**Impact.** The most destructive user action in the app has no coverage of the store-level orchestration that talks to Docker. A regression in the optimistic-removal-then-reconcile ordering, in the `reconciliationFailureMessage` branch (useAnchorageStore.ts:884-889), or in the selection-clearing logic would ship undetected, because the fixture bridge cannot exercise any of it.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:846-910 — `deleteContainer` is ~65 lines of host-only orchestration: optimistic `setContainers` filter, three cache evictions (logs/inspect/stats), a direct `bridge.containers.list` reconciliation, two distinct failure branches, and selection clearing
- `grep -n 'container-delete\\|deleteContainer\\|container-restart\\|restartContainer' app/src/HostApp.test.tsx` → ZERO hits. The only container mutation exercised against the host bridge is `container-toggle` at HostApp.test.tsx:1105
- /home/soya/dev/tools/docker-ui/app/src/App.test.tsx:137-141 — the only delete test drives `FixtureBridge.containers.remove` (anchorageBridge.ts:608-611), a two-line array splice that never touches `containers.action`
- By contrast image and volume remove/prune ARE covered against the host bridge: HostApp.test.tsx:1003-1017 and 1114-1157
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:836-844 — `restartContainer` likewise has no host-mode test
- REFUTES the surveyor's last evidence bullet: /home/soya/dev/tools/docker-ui/app/src/services/anchorageBridge.test.ts:149-163 DOES assert the exact payload — `expect(action).toHaveBeenCalledWith({context: "staging", id: fullId, action: "remove", options: {confirmed: true}})`

**Fix.** Add HostApp.test.tsx cases mirroring the existing image/volume removal tests: assert the row disappears, assert the mutation is submitted exactly once when the follow-up `containers.list` rejects, and assert the reconciliation-failure copy renders. Do the same for `restartContainer`.

<sub>Verifier (CORRECTED): CORRECTED. I grepped the test files rather than trusting the claim. The gap in HostApp.test.tsx is real and confirmed, but the surveyor's claim that "no test asserts that shape reaches containers.action" is false — anchorageBridge.test.ts:149-163 asserts the exact `options: {confirmed: true}` payload. The untested surface is the store orchestration, not the wire payload; I narrowed the finding accordingly.</sub>

---

#### Host Exec tab renders raw PTY bytes (ANSI escapes, CR, bracketed paste) as plain text into a <pre>

`ux` · `defect` · effort: medium

**Impact.** Host mode. Opening a running container's Exec tab starts a real interactive shell that immediately emits bracketed-paste (\x1b[?2004h), cursor positioning, CR line rewrites and SGR colour codes. Rendered as literal text in a <pre>, the pane fills with escape gibberish, line rewrites append instead of overwriting, and any TUI-ish output is unreadable. The PTY plumbing works; the presentation makes the tab unusable for a real shell.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:539-717 — `HostExecPanel`; the session is started at 598-612 with `argv: ["exec", "-it", container.id, "/bin/sh"], mode: "pty", rows: 30, cols: 120`
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:564-567 — ``setOutput((current) => `${current}${decodeSessionOutput(event)}`.slice(-64 * 1024))`` accumulates raw bytes as a plain string with no escape parsing
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:698-701 — `<pre className="host-terminal-output">{output \|\| ...}</pre>`
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:926-931 — the host branch selects `HostExecPanel`, so this is the shipped host-mode Exec experience
- /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:92-227 — `TerminalSurface` is already exported and handles xterm loading, the JSDOM fallback, resize, and ACK plumbing for exactly this kind of stream
- The `.slice(-64 * 1024)` window also cuts at an arbitrary UTF-16 offset, so it can split an escape sequence or a surrogate pair

**Fix.** Reuse the exported `TerminalSurface` from app/src/components/CommandCenter.tsx:92-227 in `HostExecPanel` instead of the raw `<pre>`.

<sub>Verifier (CONFIRMED): Confirmed by reading HostExecPanel end to end and confirming the host branch in the tab switch. `TerminalSurface` is already `export function`, so the reuse is straightforward. Line numbers corrected (panel at 539, <pre> at 699).</sub>

---

#### "Clear" permanently blanks the Logs tab for any non-running container, and the CLI log tail is fetched exactly once per container per app session with no refresh control

`correctness` · `defect` · effort: small

**Impact.** Host mode. Select an exited/created/dead container, click Clear, and the Logs tab shows "— no log output —" permanently — Back-and-reselect does not recover it because the empty array counts as a cache hit. Independently, even without Clear, a stopped container's log tail is a one-time snapshot taken on first selection: if the container is restarted and stops again, the Logs tab keeps showing the original pre-restart output with no indication it is stale and no way to refresh short of restarting the app.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1237-1240 — `clearLogs` sets `logsByContainer[selectedId] = []`
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:688-691 — `selectContainer` refetches only when `logsByContainer[id]` is falsy. `[]` is truthy in JavaScript, so after Clear the container is treated as "already cached" forever and `bridge.containers.logs` is never called again
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1026-1032 — the live follow effect returns early unless `selectedContainer.state === "running"`, so a stopped container has no other source of log lines
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:225-251 — the Logs toolbar offers only a filter input, Follow and Clear; there is no Refresh action
- Nothing else resets the cache: `grep -n setLogsByContainer app/src/store/useAnchorageStore.ts` → 697, 819, 865 (delete only), 1054, 1239

**Fix.** Change the cache check to `logsByContainer[id]?.length ? ... : bridge.containers.logs(...)`, or better, add an explicit Refresh button to the Logs toolbar that always re-issues `bridge.containers.logs` and replaces the buffer.

---

#### Every live log line re-renders the entire app tree and up to 200 unvirtualized log rows, plus a forced layout read

`performance` · `defect` · effort: medium

**Impact.** Host mode with Follow enabled on a chatty container. At ~30 output events/second the renderer performs ~30 full-tree re-renders per second, each reconciling ~800 log elements and forcing a synchronous layout for the auto-scroll — roughly 24,000 element reconciliations plus 30 forced layouts per second. This is the single hottest path in the app and it is also the one path with no memoization and no virtualization.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1053-1060 — `appendText` issues one `setLogsByContainer` per `session.output` event; IPC events arrive as separate macrotasks so React cannot batch them
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1853 — the store returns a plain object literal with no `useMemo`, so every state update produces a new store object and re-renders the whole tree from App down
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1223-1235 — `visibleLogs` recomputes on every `logsByContainer` change and yields up to 200 lines
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:259-270 — `store.visibleLogs.map(...)` renders each line as a `<div>` containing `<time>`, a level `<span>` and a message `<span>`; there is NO `React.memo` on the row and NO windowing (`FixedRowWindow` is used for containers at ContainersScreen.tsx:205 and images, but not for logs)
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:216-219 — the follow auto-scroll effect reads `logRef.current.scrollHeight` on every `visibleLogs` change, forcing a synchronous layout each time
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:24 — the core emits one event per 16 KiB read, so a chatty service produces tens of events per second

**Fix.** Wrap the log row in `React.memo`, render the log list through the existing `FixedRowWindow` component, and coalesce `appendText` updates with a short rAF/microtask flush so bursts of `session.output` events produce one state update instead of one each.

---

#### `retryEngine` blocks first paint of live container data behind the full ~2.4 s command-inventory sweep

`performance` · `defect` · effort: small

**Impact.** Host mode. The app shows the engine "loading" state for ~2.4 s on every cold start and every core restart before any container is listed, even though the container list itself is available in under 100 ms. The entire delay is spent enumerating 244 `docker … --help` subcommands the startup path does not use.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:514-527 — `retryEngine` sets `engineStatus` to "loading", then `await bridge.system.capabilities()` (line 516), and only afterwards `await bridge.containers.list(context)` (line 523)
- MEASURED: `system.capabilities` takes 2.364 s wall on this machine; `containers.list` takes 0.072 s including process spawn — the cheap call is serialized behind the expensive one
- /home/soya/dev/tools/docker-ui/app/electron/main.mjs:602-604 — the capabilities handler is given a 120 s timeout, versus 45 s for `containers.list` (main.mjs:632-635), confirming it is understood to be slow
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:543 — `void retryEngine()` runs on mount, and useAnchorageStore.ts:555-559 runs it again on every `core.status: ready`
- The only thing `retryEngine` needs from capabilities is a context name (lines 517-522), which `docker context show` alone provides in ~11 ms per artifacts/docker/system-capabilities.json evidence.contextShow.durationMs

**Fix.** Resolve the context with a cheap dedicated call (or a `system.capabilities` variant that skips the inventory), list containers immediately, and fetch the full command inventory lazily in the background for the Command Center.

---

#### Shipped AppImage desktop entry disables Chromium's namespace sandbox (`Exec=AppRun --no-sandbox %U`)

`security` · `defect` · effort: small

**Impact.** Desktop-integrated launches (appimaged / Gear Lever / AppImageLauncher / file association `%U`) run every Chromium process outside a user namespace, losing chroot/PID/net isolation for the renderer. Seccomp-bpf survives, so this is a partial degradation of defence-in-depth, not its removal. Because a renderer compromise already implies arbitrary `docker` argv and therefore host root through the bridge, the practical escalation delta is near zero - but the app documents a guarantee it does not deliver on its most common launch path, and the release gate structurally cannot observe it.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/release/Anchorage-0.1.0-x86_64.AppImage -> extracted `anchorage.desktop`: `Exec=AppRun --no-sandbox %U`
- /home/soya/dev/tools/docker-ui/app/electron-builder.yml:44-57 - `linux.desktop.entry` block sets no `Exec`, so electron-builder's default ships as-is
- /home/soya/dev/tools/docker-ui/app/release/linux-unpacked/chrome-sandbox is `-rwxr-xr-x` (no setuid); `unshare -Ur true` succeeds on this host, so the userns sandbox is otherwise available
- MEASURED (Xvfb, /proc/<pid>/status) default launch: `pid=4056058 type=--type=renderer Seccomp: 2 userns=user:[4026534616]` vs host `user:[4026531837]`
- MEASURED with `--no-sandbox`: `pid=4077757 type=--type=renderer Seccomp: 2 userns=user:[4026531837]` - seccomp retained, namespace isolation lost
- /home/soya/dev/tools/docker-ui/app/electron/main.mjs:70 `app.enableSandbox();` and /home/soya/dev/tools/docker-ui/app/electron/security-policy.mjs:17 `sandbox: true` both still report true under `--no-sandbox`, so main.mjs:487-493 `assertRuntimeSecureWebPreferences` cannot detect it

**Fix.** Set `linux.desktop.entry.Exec: anchorage %U` in app/electron-builder.yml so the generated desktop file stops passing `--no-sandbox`. Add a startup check in app/electron/main.mjs for `app.commandLine.hasSwitch('no-sandbox')` that logs a loud degraded-security state. Extend app/scripts/package-desktop.mjs to extract `anchorage.desktop` from the built AppImage and assert its `Exec` contains no `--no-sandbox`.

<sub>Verifier (CORRECTED): Facts confirmed, effect measured, severity cut critical->medium. I extracted the AppImage and confirmed `squashfs-root/anchorage.desktop` contains `Exec=AppRun --no-sandbox %U`; app/electron-builder.yml:44-57 sets `linux.desktop.entry` Name/GenericName/Comment/Categories/Keywords/StartupWMClass but never Exec; release/linux-unpacked/chrome-sandbox is 0755 (no setuid). The surveyor asserted the impact instead of measuring it, and got it partly wrong. I ran the packaged binary under Xvfb both ways and read /proc/<pid>/status: DEFAULT launch -> renderer `Seccomp: 2`, userns `4026534616` (own name</sub>

---

#### Session output ack-window has no deadline: a renderer that never acks deadlocks the reader and waiter goroutines and leaks the session

`performance` · `defect` · effort: medium

**Impact.** Per un-acked session the core leaks a blocked reader goroutine (two in pipes mode), a blocked waiter, a watchLifetime goroutine, the buffered pending slice and a permanent map entry, and session.exited is never delivered. With no session-count cap this is unbounded. No external attacker; the trigger is a renderer bug or a deliberately misbehaving renderer, so this is a reliability and resource-leak defect rather than a privilege issue.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:423-425 - unbounded cond.Wait in emitOutput
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:315-322 - waiter blocks in readers.Wait() after reaping; Broadcast at :318 does not change the predicate
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:331-348 - watchLifetime has no default timeout (timeoutSeconds 0 = unlimited, range-checked only at :124-126)
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:201-203 - no cap on concurrent sessions
- MITIGATION VERIFIED: /home/soya/dev/tools/docker-ui/core/internal/core/session.go:759-775 - ack is cumulative (drains all pending <= throughSequence)
- MITIGATION VERIFIED: /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1064-1070 acks every output event; :1152-1165 cleanup always cancels the session

**Fix.** Bound the wait: replace the bare cond.Wait() with a deadline (cond plus a timer, or move the window to a buffered channel with select-on-timer). On expiry set discardOutput, emit session.output.truncated with a stall reason, and proceed to finish(). Independently enforce a maximum concurrent-session count in sessionManager.start and give watchLifetime a non-zero default timeout.

<sub>Verifier (CORRECTED): Code path CONFIRMED, severity cut high->medium and reframed from security to reliability. The deadlock is real: core/internal/core/session.go:423-425 `for !s.discardOutput && s.outstandingBytes+int64(len(data)) > s.outputWindow { s.cond.Wait() }`; the waiter at session.go:315-322 calls `readers.Wait()` after `command.Wait()`, and its Broadcast at :318 does not help because the predicate is still true; finish() (:485-530, which closes s.done and schedules the 5-minute tombstone at :523-529) is only reachable from the blocked waiter; watchLifetime (:331-348) escapes only on parent.Done() (proces</sub>

---

#### exec.Cmd.WaitDelay is never set, so cli.run timeouts are unenforceable when a grandchild inherits stdout

`correctness` · `defect` · effort: trivial

**Impact.** Any docker invocation leaving a background descendant holding stdout makes command.Run() block past its deadline indefinitely: the RPC handler goroutine hangs, operation.completed never fires, and the documented timeout guarantee does not hold. Renderer-reachable via cli.run, so it also pins goroutines in the privileged process - though the renderer can already fork docker freely, so this is robustness rather than escalation.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/command.go:150-161 - exec.CommandContext with prefixWriter Stdout/Stderr, then `err := command.Run()`
- grep for `WaitDelay` and `Cancel =` across core/internal and core/cmd returns no non-test matches
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:272-274 - cliRun relies only on context.WithTimeout
- /home/soya/dev/tools/docker-ui/core/internal/core/pty_linux.go:74-94 and session.go:225,254 - sessions correctly set Setpgid; command.go:150 sets no SysProcAttr
- /home/soya/dev/tools/docker-ui/docs/architecture.md:113 claims 'cancellation, deadlines, bounded buffers, backpressure'

**Fix.** Set `command.WaitDelay = 5 * time.Second` in DockerCLI.run so os/exec force-closes inherited pipes after the process is killed. Also set `SysProcAttr{Setpgid: true}` and a custom `Cancel` that signals the whole process group, matching what pty_linux.go already does for sessions.

<sub>Verifier (CONFIRMED): Confirmed exactly as described. `grep -rn 'WaitDelay\|Cancel =' core/` returns nothing outside tests. core/internal/core/command.go:150-161 uses exec.CommandContext with non-*os.File writers (prefixWriter), which makes os/exec create internal pipes and copy in goroutines; command.Run() waits for those copies, which requires every holder of the pipe write end to close it, not just the direct child. command.go:150 sets no SysProcAttr, so cli.run children share the core's process group - note the asymmetry with sessions, which DO set Setpgid via core/internal/core/pty_linux.go:74-94 and session.g</sub>

---

#### No aggregate payload size cap on cli.run / session.start - one IPC call can force hundreds of MB of main-process allocation

`security` · `defect` · effort: small

**Impact.** A renderer bug or a runaway effect loop can drive the main process into GC thrashing or OOM, taking down the window and the core supervisor with it. Not an escalation (the renderer already has stronger primitives), but the 8 MB frame cap reads like a defence while being enforced strictly after the cost is paid.

**Evidence.**
- VERIFIED BY EXECUTION: `validateCliRun({context:'default', argv:['ps', ...200 x 'a'.repeat(1048576)]})` returned successfully with 209,715,202 argv characters in 5 ms
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:375-384 - validateDockerArgv caps count and per-element length only
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:442-470 - validateEnvironment caps 1024 entries x 1 MiB with no aggregate bound
- /home/soya/dev/tools/docker-ui/app/electron/jsonl-rpc.mjs:61-64 - `const serialized = JSON.stringify(envelope)+'\n'; if (Buffer.byteLength(serialized) > this.#maximumLineBytes) throw` - allocation happens before the check
- /home/soya/dev/tools/docker-ui/app/electron/preload.cjs:306-358, 371-397 - preload copy has the same omission, so the payload is materialised twice

**Fix.** Add an aggregate byte budget to validateDockerArgv and validateEnvironment in app/electron/contracts.mjs (accumulate Buffer.byteLength; fail past ~1 MB argv / 256 KB env), mirror it in app/electron/preload.cjs, and in app/electron/jsonl-rpc.mjs compute a cheap size estimate before JSON.stringify.

<sub>Verifier (CONFIRMED): Confirmed by execution, severity cut high->medium and reframed. I ran validateCliRun with 200 x 1 MiB argv entries: ACCEPTED, 209,715,202 total argv characters, in 5 ms. contracts.mjs:375-384 caps only count (1024) and per-element length (1 MiB) with no running total; contracts.mjs:442-470 does the same for env. The jsonl-rpc observation is also correct and is the sharpest part of the finding: app/electron/jsonl-rpc.mjs:61-64 builds the full `JSON.stringify(envelope)` string BEFORE comparing against the 8 MB limit, so the cap never prevents the allocation it appears to guard. Downgraded becaus</sub>

---

#### Live-host evidence artifacts are committed to the repo with no redaction anywhere in the generation pipeline

`security` · `defect` · effort: small

**Impact.** This is the one place in the system where Docker-derived data reaches durable, shareable storage. The brief's 'secrets leaking into logs, history, or evidence artifacts' class lands here and all three surveyors missed it - they checked localStorage (correctly finding only the appearance preference) but not the committed artifacts tree. Today's contents are benign because this host has empty proxy settings, but the pipeline has no control that would prevent a proxy URL with embedded credentials (`HttpsProxy: http://user:pass@proxy`), a registry mirror hostname, a secret-bearing container name, or a token printed in a container log line captured in a screenshot from being committed verbatim and published with the repository. Unlike the runtime findings, this one has a real non-renderer beneficiary: anyone the repo is shared with.

**Evidence.**
- /home/soya/dev/tools/docker-ui/.gitignore excludes app/node_modules, app/dist, app/release, app/build/core/anchorage-core and core/bin - but NOT artifacts/
- /home/soya/dev/tools/docker-ui/artifacts/docker/system-capabilities.json (521,586 bytes) embeds the raw `docker info` JSON under `evidence.info`, including `HttpProxy`, `HttpsProxy`, `NoProxy`, `RegistryConfig` with `Mirrors`/`InsecureRegistryCIDRs`, `DockerRootDir`, the host name `altgard`, kernel `7.1.5-1-cachyos`, NCPU 64 and MemTotal
- Same file records every context endpoint path verbatim, including `unix:///home/soya/.docker/desktop/docker.sock` and `unix:///run/user/1000/podman/podman.sock`
- /home/soya/dev/tools/docker-ui/artifacts/host-candidate/screens/host-container-detail.png is a screenshot of the user's real machine showing a real container name (`2009scape-db-1`), its image tag, and ~40 lines of that container's live log output
- `grep -rl 'redact\|REDACT' /home/soya/dev/tools/docker-ui/tools/` returns nothing - none of capture-host-candidate.mjs, generate-capability-ledger.mjs or run-core-acceptance.mjs redact anything
- /home/soya/dev/tools/docker-ui/app/electron/redaction.mjs is imported only by app/electron/main.mjs and app/electron/core-supervisor.mjs, so it is not on the artifact-generation path at all

**Fix.** Add `artifacts/` (or at minimum `artifacts/docker/` and `artifacts/host-candidate/`) to .gitignore, or gate committing them on a scrubbing step. Reuse app/electron/redaction.mjs's redactSensitiveText from tools/generate-capability-ledger.mjs and tools/capture-host-candidate.mjs, and explicitly drop `evidence.info.HttpProxy/HttpsProxy/NoProxy/RegistryConfig` and the `Name` host field before serializing. For screenshots, capture host-candidate screens against a dedicated throwaway container set rather than the developer's live daemon.

---

#### `docker system df` data is fetched once at connect and never refreshed, and the Dashboard's "Reclaimable" headline omits two of the four reclaimable categories

`correctness` · `defect` · effort: small

**Impact.** The Dashboard is the disk-usage screen and its numbers are a point-in-time reading from app start. Pull a 3 GB image, run a build, or prune from the palette and the panel keeps showing the old figures indefinitely, betrayed only by a small timestamp with no way to act on it.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:61-79 — `system.snapshot` fetches `GET /system/df` (all types); domain.go:186-221 projects the full per-image/per-container/per-volume/per-build-cache breakdown.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:326-378 — `refreshSnapshot` has no polling timer. I grepped every `setInterval` in the store: only :615 (containers, 2s), :639 (images/volumes, 10s, and only while that view is open), :657 (wall clock, 1s). `refreshSnapshot`'s callers are initial connect (:532) and Anchorage-issued mutation completions only (:576,580,584,775,893,1327,1375,1395,1594,1640,1689).
- /home/soya/dev/tools/docker-ui/app/src/screens/DashboardScreen.tsx:107-145 — the disk panel reduces everything to four totals. `docker system df`'s per-category RECLAIMABLE column is not reproduced.
- /home/soya/dev/tools/docker-ui/app/src/screens/DashboardScreen.tsx:99-106 and :209-224 — the "Reclaimable" stat is `reclaimableImages + reclaimableCache` only. Reclaimable volumes (refCount 0) and stopped-container writable layers are excluded, so it structurally under-reports what `system prune -a --volumes` would free.
- DashboardScreen.tsx:239-240 renders `snapshot.observedAt`, which is honest, but there is no refresh control anywhere in the app to act on it (verified: `retryEngine` is reachable only from WorkspaceStateScreen.tsx:65 when the engine is not ready).

**Fix.** Poll `system.snapshot` on an interval while the Dashboard is the active view using the same visibility-gated pattern already at useAnchorageStore.ts:627-654, add a manual Refresh control, and extend the disk panel to a per-category TOTAL/ACTIVE/RECLAIMABLE table — every input is already in `SystemSnapshotResult.diskUsage`.

<sub>Verifier (CONFIRMED): Confirmed. Overlaps with the Command-Center-invalidation finding (same root cause, different symptom) and with the polling-architecture finding; kept separate because it is a concrete, independently fixable defect.</sub>

---

#### No `docker events` stream: the app polls containers every 2s and images/volumes every 10s, despite the session transport already being release-gated against `docker events`

`architecture` · `absent` · effort: medium

**Impact.** Change made outside Anchorage is invisible for up to 2s for containers, up to 10s for images/volumes and only if that screen is open, and forever for the Dashboard. Meanwhile the app issues ~43k container-list requests per day against the daemon whether or not anything changed. The event stream would give lower latency and lower load simultaneously.

**Evidence.**
- No `/events` Engine API call exists anywhere in the core — I grepped every `client.request` path; the endpoints hit are `/version`, `/info`, `/system/df`, `/containers/json`, `/containers/{id}/json`, `/containers/{id}/stats`, `/images/json`, `/volumes`, plus mutation paths.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:604-615 — `window.setInterval(poll, 2_000)` calls `containers.list` every 2s whenever the engine is ready and the document is visible.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:626-654 — images/volumes refresh on a 10s interval, and the effect returns early unless `view === "images" \|\| view === "volumes"`, so they go stale the moment you navigate away.
- /home/soya/dev/tools/docker-ui/tools/run-performance-evidence.mjs:1285 — the release harness already starts `session.start {argv:["events","--format","{{json .}}"], mode:"pipes", outputWindowBytes:256*1024}` and runs a soak with full ack accounting (tools/run-performance-evidence.mjs:822-954,1335-1368); docs/parity-and-release-gates.md:167 gates the release on "a complete 30-minute acknowledged `docker events` session". The capability is proven; the product does not use it.

**Fix.** Start one long-lived pipes session running `events --format {{json .}}` on connect, ACK it with the existing window logic, and dispatch on the event Type/Action to invalidate exactly the affected domain. Keep a slow (30-60s) reconciliation poll as a safety net rather than the primary mechanism.

<sub>Verifier (CONFIRMED): Confirmed; every citation checked including the performance harness argv. Severity lowered from high to medium: the user-visible consequences are already itemized as their own defects (Command Center invalidation, stale df); this finding is the architectural remedy rather than an independent break. The 2s container latency itself is acceptable for a daily driver.</sub>

---

#### Volumes become permanently read-only on any CLI-fallback (remote) context, because both remove and prune are hard-gated on usage data the CLI transport never provides

`parity-gap` · `wired-but-gated` · effort: small

**Impact.** On any context that resolves to the CLI transport (remote/SSH daemons), every volume reports unknown usage, so the Volumes screen becomes strictly read-only forever, with the only explanation being the word "Unknown" in a table column. The conservative design intent is right for *prune*, which infers "unused", but over-applied to *exact-name removal*, which does not depend on usage inference at all and which Docker itself allows with `--force`.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1604-1606 — `removeVolume` returns immediately unless `volume.usageKnown && volume.refCount === 0`. useAnchorageStore.ts:1649-1655 — `pruneVolumes` returns early if any volume has `!usageKnown`.
- /home/soya/dev/tools/docker-ui/app/src/screens/VolumesScreen.tsx:82-87 — the per-row remove button is `disabled` when `!volume.usageKnown \|\| Boolean(volume.usedBy) \|\| store.volumeMutationPending`. VolumesScreen.tsx:31-39 — "Clean up" is disabled on `!store.volumes.every(v => v.usageKnown)`.
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:876-882 — the remote CLI-JSON volume list constructs `VolumeProjection{Name,Driver,Scope,Mountpoint,Labels:{},Options:{},Status:{},LabelsText,SizeDisplay}` with no `UsageData` at all. domain.go:886 records this as a limitation string. app/src/store/useAnchorageStore.ts:131-145 then computes `usageKnown = refCount !== undefined` = false for every volume.
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:815-820 — even on the native path, if `/system/df?type=volume` fails or returns invalid data, every volume loses usage and the same lockout applies.
- The remedy is already implemented and unreachable: protocol/types.ts:167-173 accepts `force?: boolean` on remove; core/internal/core/domain.go:1215-1219 passes `?force=<bool>` to `DELETE /volumes/{name}` and domain.go:1276-1281 emits `--force` on the CLI path; I read `validateVolumesAction`'s remove case at domain.go:1382-1392 and it explicitly does NOT reject `Force`. The renderer never sends it (useAnchorageStore.ts:1618-1624).

**Fix.** Allow exact-name removal regardless of `usageKnown` (the user named the target and the core already requires `confirmed: true`), surface `force` behind a second explicit confirmation for the in-use case, keep the unknown-usage lockout for prune only, and render an inline explanation ("volume usage is unavailable on this transport") instead of a silently disabled button.

<sub>Verifier (CONFIRMED): Confirmed, and I additionally verified the core-side claim by reading `validateVolumesAction` to confirm `Force` is genuinely accepted on the remove path rather than merely present in the struct.</sub>

---

#### Every `force` option the protocol and core implement is unreachable from any UI, and disabled destructive controls never state their precondition

`parity-gap` · `core-only-not-wired` · effort: small

**Impact.** A user with 60 running containers sees a greyed trash icon on every one with no reason and no path forward. Docker Desktop lets you delete a running container behind a force warning. The capability exists end to end in the protocol, the core and the preload contract, so this ships as a capability claim with no UI, and every disabled control is a wall rather than an informed choice.

**Evidence.**
- /home/soya/dev/tools/docker-ui/protocol/types.ts:78-91 — `containers.action` remove accepts `force?: boolean` and `volumes?: boolean`. /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:310-364 — the preload contract validates and forwards both (`assertOnlyKeys(...new Set(["timeoutSeconds","force","volumes","confirmed"])...)`, with an explicit rule that force/volumes are remove-only).
- /home/soya/dev/tools/docker-ui/app/src/services/anchorageBridge.ts:834-845 — the renderer hardcodes `...(operation === "remove" ? { options: { confirmed: true as const } } : {})` and never sends `force` or `volumes`.
- protocol/types.ts:107-119 — image remove accepts `force`/`noPrune`; protocol/types.ts:167-173 — volume remove accepts `force`. Neither is ever sent by the store.
- /home/soya/dev/tools/docker-ui/app/src/utils/containerPresentation.ts:91-93 — `canRemoveContainer` returns false for running/paused/restarting/removing, so running containers are undeletable. ContainersScreen.tsx:71-83 — the delete button has a constant `title="Delete"` and a static aria-label with no reason.
- /home/soya/dev/tools/docker-ui/app/src/screens/ImagesScreen.tsx:56-70 — remove button `disabled={!image.usageKnown \|\| image.inUse \|\| !image.reference \|\| store.imageMutationPending}` with no `title`. VolumesScreen.tsx:78-92 — same shape, no `title`. ImagesScreen.tsx:243-250 and VolumesScreen.tsx:29-43 — both "Clean up" buttons have complex disabled predicates and no explanatory text.

**Fix.** Add `title`/`aria-describedby` text to every disabled destructive control stating the precondition ("Stop the container before deleting", "Image is used by 3 containers", "Volume is attached to postgres-main"), then wire the existing `force` flag into the confirmation dialog as an explicit opt-in.

<sub>Verifier (CONFIRMED): Confirmed; I read the preload contract validator in full to verify force/volumes really are accepted and forwarded, and read the bridge to confirm they are never populated. Merged with the volume-specific `force` half of surveyor 0's finding to avoid duplication.</sub>

---

#### All five destructive flows use a native OS dialog with no reclaimable-size preview, no options, no affected-resource list, and no undo

`ux` · `defect` · effort: medium

**Impact.** A frameless app that pixel-clones Docker Desktop pops an unstyled GTK message box whose only content is a sentence. It cannot show what will be reclaimed, cannot offer Docker's force or anonymous-volumes options, cannot list which volumes/images are about to die, and blocks the renderer thread while open. There is no undo and no post-action confirmation of what was removed.

**Evidence.**
- I grepped every `window.confirm` in app/src: ContainersScreen.tsx:32-35, ContainerDetailScreen.tsx:119-127 (duplicated `confirmDelete`), useAnchorageStore.ts:1299-1303 (cleanUpImages), :1343-1347 (removeImage), :1613 (removeVolume), :1657-1662 (pruneVolumes). Six call sites, five flows.
- /home/soya/dev/tools/docker-ui/app/electron/security-policy.mjs:10-25 — `createSecureWebPreferences` never sets `disableDialogs`; I decompiled Electron 43.2.0's `-run-dialog` handler and it services `confirm` via `dialog.showMessageBox(ownerWindow,{message,buttons:["OK","Cancel"],defaultId:0,cancelId:1})`. So `window.confirm` genuinely works and the delete flows are not broken by the security policy.
- /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:1246-1269 — by contrast the Command Center has a proper in-app two-step confirm with a `role="alert"` danger banner and an argv fingerprint (CommandCenter.tsx:711-721), proving the better pattern already exists in this codebase.
- The data for a preview is already loaded: DashboardScreen.tsx:99-145 computes reclaimable bytes from `systemSnapshot.diskUsage`, and the store already holds every volume's `refCount`/`sizeBytes` (useAnchorageStore.ts:131-161).

**Fix.** Replace all six `window.confirm` calls with one shared in-app `<ConfirmDestructive>` modal (`role="dialog" aria-modal="true"`, initial focus on Cancel, Escape to close, focus returned to the invoking control). For prune/clean-up, render the affected resource list and total reclaimable bytes.

<sub>Verifier (CONFIRMED): Confirmed, and I independently reproduced the Electron decompilation that establishes `confirm` works (which is the load-bearing negative result here). Severity lowered from high to medium: this is a quality/UX gap rather than a break; the specific dangerous consequence (volume prune --all with no preview) is graded high as its own finding.</sub>

---

#### Volumes screen is a flat five-column table: no detail view, no used-by drill-down, no mountpoint/labels/options, no export/import/browse, and no virtualization at 237 rows

`parity-gap` · `core-only-not-wired` · effort: medium

**Impact.** You cannot find out where a volume lives on disk, what driver options it was created with, what labels it carries (so you cannot tell which compose project owns it), or which containers reference it — the UI tells you only how many. Two of those fields (mountpoint, labels) are already on the wire and thrown away three lines before render. Docker Desktop's volume browser and export/import are a common reason people keep a GUI installed; combined with the `--all` prune above, a user can destroy volume data from this screen but has no UI path to have backed it up first.

**Evidence.**
- /home/soya/dev/tools/docker-ui/protocol/types.ts:476-490 — `VolumeProjection` carries `mountpoint`, `createdAt`, `scope`, `labels`, `options`, `status`, `usage`. core/internal/core/domain.go:832-844 `projectVolume` populates all of them from the Engine API response.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:131-161 — the renderer's `projectVolume` keeps only name, driver, size, usedBy, created, usageKnown, sizeBytes, refCount. mountpoint, scope, labels, options and status are discarded at this boundary; app/src/types.ts:97-106 `AnchorageVolume` has no field for any of them.
- /home/soya/dev/tools/docker-ui/app/src/screens/VolumesScreen.tsx:55-61 — exactly five columns (NAME, DRIVER, SIZE, USED BY, CREATED). Rows have no onClick (VolumesScreen.tsx:63-96) and there is no volume detail route in App.tsx:17-45.
- VolumesScreen.tsx:70-76 — the USED BY cell renders the string `${refCount} container(s)` built at useAnchorageStore.ts:150-153; container names are never resolved and the cell is not clickable.
- Virtualization inconsistency I verified: VolumesScreen.tsx:63 uses a bare `store.volumes.map(...)`, while ContainersScreen.tsx:206-215 and ImagesScreen.tsx:20-74 use `FixedRowWindow` (threshold 200, FixedRowWindow.tsx:22,39). With 237 volumes on the reference host (artifacts/host-candidate/screens/host-volumes.png) every row plus every delete button is in the DOM, while the 231-image sibling screen virtualizes.
- No `volumes.inspect` method exists (protocol/types.ts:276-294, core/internal/core/service.go:65-215), and a repo-wide grep for backup/restore/tar-export across app/src and core returns only `liveRestoreEnabled` and Electron window restore.

**Fix.** Stop discarding the fields in the store projection and add a volume detail pane or expandable row showing mountpoint, scope, driver options, labels and status; resolve `refCount` to real container names from the already-loaded `containers` list and link them; wrap the list in `FixedRowWindow` (a one-line change matching Images). Treat export/import/browse as a separate protocol addition, or state it as out of scope in README.md's product-surfaces list.

<sub>Verifier (CONFIRMED): Merged surveyor 0's "no volume inspect" and "no backup/restore" findings with surveyor 1's "Volumes screen" finding — same screen, same root cause. I additionally verified the FixedRowWindow threshold (200) to confirm the virtualization asymmetry is real rather than incidental.</sub>

---

#### No pause/unpause/kill in the protocol, and the running-container button uses a pause glyph to perform a stop

`parity-gap` · `absent` · effort: medium

**Impact.** There is no way to pause a container, no way to resume a paused one in a state-preserving manner, and no `kill` for a hung container. Separately, the ∥ glyph on running rows is the universally understood pause symbol but issues `docker stop` — a materially different, process-terminating operation. The title/aria-label say "Stop", so sighted mouse users who do not hover are the ones misled.

**Evidence.**
- /home/soya/dev/tools/docker-ui/protocol/types.ts:70 — `export type ContainerAction = "start" \| "stop" \| "restart" \| "remove";` — pause/unpause/kill absent from the protocol entirely. app/electron/contracts.mjs:1-6 `CONTAINER_ACTIONS` and app/electron/preload.cjs:46-51 `ACTIONS` mirror the same four.
- /home/soya/dev/tools/docker-ui/core/internal/core/types.go:299 — the core surfaces a `Paused bool` on the inspect state projection it can never act on.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:55-60 — `{isRunning ? <AnchorageIcon name="pause" size={10} /> : ...}` where `isRunning` is `primaryContainerAction(container) === "stop"`; containerPresentation.ts:67-80 returns "stop" for running/restarting with no pause branch. The `title`/`aria-label` say "Stop" (ContainersScreen.tsx:50-51).
- /home/soya/dev/tools/docker-ui/app/src/utils/containerPresentation.ts:70-80 — paused containers get `null` from `primaryContainerAction`, so the toggle renders as an empty disabled box with `aria-label="Unavailable <name>"`.
- `docker --help` on this host (scratchpad/docker-help-root.txt) confirms `pause`, `unpause` and `kill` are all present in Docker 29.6.2.

**Fix.** Add `pause`/`unpause`/`kill` to `ContainerAction`, the core switch, the preload allowlist and a row overflow menu. In the meantime change the running-state glyph to a stop square so the icon matches the verb.

<sub>Verifier (CORRECTED): CORRECTED on one factual sub-claim. Surveyor 1 states "a paused container can never be resumed from the UI". That is wrong: `canRestartContainer` (app/src/utils/containerPresentation.ts:83-89) explicitly includes "paused", so the Restart button IS enabled on a paused row and `docker restart` will bring it back. The accurate statement is that there is no state-preserving unpause — only a full restart, which destroys the process state pausing exists to preserve. Everything else in the finding is confirmed verbatim.</sub>

---

#### Container detail Exec tab is a plain <input> over a <pre> with a hardcoded /bin/sh, while the Command Center already ships a real xterm terminal

`parity-gap` · `defect` · effort: medium

**Impact.** The Exec tab cannot render colour, cursor movement, TUI programs or `clear`; it has no command history, no Ctrl-C, no arrow keys, no tab completion, never resizes the PTY, and cannot open a shell that is not literally `/bin/sh`. Docker Desktop's Exec tab is a full terminal with a shell selector. The correct component is already in the same bundle 400 lines away.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:684-717 — `HostExecPanel` renders `<pre className="host-terminal-output">{output}</pre>` plus a single-line `<input>` that sends `${input}\r` on Enter.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:600-609 — the session is started with `mode:"pty", rows:30, cols:120`, so raw ANSI/VT escape sequences arrive and are dumped verbatim into the `<pre>`.
- /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:9-10,61,137,226 — the Command Center dynamically imports `@xterm/xterm` and mounts a real terminal, proving the dependency ships and works in this bundle.
- No `sessions.resize` call is made anywhere in ContainerDetailScreen (I grepped the file), despite `bridge.sessions.resize` existing (anchorageBridge.ts:1037).
- Additional gap I verified that the surveyor missed: ContainerDetailScreen.tsx:603 hardcodes `argv: ["exec","-it", container.id, "/bin/sh"]`. There is no shell picker and no fallback to `/bin/bash` or `sh`, so any image without `/bin/sh` (distroless, scratch-based, some Windows images — and the reference host runs `ghcr.io/dockur/windows`) fails with a raw session error and no remedy inside the tab.
- ContainerDetailScreen.tsx:457-536 — in fixture mode the Exec tab is a hardcoded fake shell returning canned strings for ls/pwd/whoami/ps/env/df.

**Fix.** Reuse the Command Center's lazy xterm host in `HostExecPanel`, wire `onData` to `sessions.input`, `onResize` to `sessions.resize`, forward signals via `sessions.signal`, and add a shell selector (or probe sh→bash→ash) instead of hardcoding `/bin/sh`.

<sub>Verifier (CONFIRMED): Confirmed, with one added sub-gap the surveyors missed (hardcoded /bin/sh with no picker or fallback), verified at the exact argv line.</sub>

---

#### Container Files tab: unavailable in host mode, fabricated in fixture mode, and there is no cp/upload/download anywhere

`parity-gap` · `absent` · effort: large

**Impact.** The Files tab is one of six tabs in the design and one of Docker Desktop's headline container features. Anchorage is honest about it in host mode, which is the right call, but it ships a convincing fake in the mode used for all design QA captures, and it leaves a permanently-dead tab in the host nav.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:933-945 — host mode renders `DetailCapabilityState` titled "Files unavailable" with the message "The current host protocol has no literal-path container file browser. No synthetic filesystem is shown." and a button that opens the Command Center pre-seeded with `"container cp"`.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:56-66 — fixture mode renders a hardcoded 9-entry `files` array. ContainerDetailScreen.tsx:721-741 — `FilesPanel` is read-only with a static path string; no navigation, download, upload, edit or delete.
- /home/soya/dev/tools/docker-ui/app/electron/security-policy.mjs:116-118 — `willDownload: (event) => { event.preventDefault(); }` unconditionally blocks all downloads, so a "download this file" affordance could not work without a main-process policy change.
- scratchpad/docker-help-root.txt — `docker cp`, `docker diff` and `docker export` all exist on the installed CLI and could be driven through `cli.run`/`session.start` today.
- artifacts/design/design-ledger.json includes `container-detail-files` as one of the 24 pixel-compared canonical states, so the fabricated filesystem is part of reviewed design evidence.

**Fix.** Either build the browser on `docker cp` / `docker exec ls` through the existing session transport, or drop the tab from host mode rather than leaving a dead entry. If download is ever added, the `willDownload` blanket block must gain an allowlisted path.

<sub>Verifier (CORRECTED): CORRECTED on state classification only. Surveyor 1 filed this as `core-only-not-wired`, which implies the core implements a file browser that is not wired up. It does not — there is no file/archive method in the protocol union or the core switch, only the generic `cli.run`/`session.start` escape hatch that could reach `docker cp`. The correct state is `absent` in host mode with a fixture-only fake. Every cited line is accurate.</sub>

---

#### Settings is Appearance-only in host mode: Resources, Docker Engine, Kubernetes, Updates and Advanced are five dead navigation entries

`parity-gap` · `wired-but-gated` · effort: large

**Impact.** Docker Desktop's Settings is where users set CPU/memory/disk limits, edit and apply daemon.json, enable Kubernetes and configure updates. In Anchorage's host mode none of that exists; the section is a themed colour picker with five dead ends.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/SettingsScreen.tsx:466-479 — `if (store.settingsTab === "appearance") {...} else if (store.isHost) { content = <HostSettingsUnavailable .../> }` — every non-appearance tab short-circuits in host mode.
- /home/soya/dev/tools/docker-ui/app/src/screens/SettingsScreen.tsx:432-454 — the unavailable panel says "Engine settings are read-only through the current host protocol" and offers only an "Open Command Center" escape hatch seeded with `"system"`.
- /home/soya/dev/tools/docker-ui/app/src/screens/SettingsScreen.tsx:460-465 and :481-494 — all six sections remain in the left nav in host mode, so five are guaranteed dead ends.
- /home/soya/dev/tools/docker-ui/app/src/screens/SettingsScreen.tsx:382-390 — `EngineSettings` renders a `DAEMON_JSON_FIXTURE` in a read-only `<pre>`; there is no editor and no Apply & Restart even in fixture mode. SettingsScreen.tsx:314-379 — the CPU/memory/swap/disk sliders and `applyResources` exist only in fixture mode and write to local React state.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1908-1912,1943-1946 — `resources`, `featureFlags`, `applyResources`, `toggleFeatureFlag` are exported with no host implementation behind them.
- artifacts/design/design-ledger.json — five of the 24 canonical captures (`settings-resources`, `settings-engine`, `settings-kubernetes`, `settings-updates`, `settings-advanced`) document behaviour that does not exist in the product.

**Fix.** Hide the unimplemented sections from the host-mode nav instead of routing them all to the same panel, or implement at least a read+write daemon.json editor with an explicit restart confirmation. Mark the five fixture-only Settings captures as design-source-only in the ledger.

<sub>Verifier (CONFIRMED): Confirmed; I read the full SettingsScreen dispatch and verified the nav is not filtered in host mode (only the `?capture=appearance` case filters, SettingsScreen.tsx:461-464).</sub>

---

#### No pending/progress indication per row, no success feedback, and an error toast the user cannot dismiss

`ux` · `defect` · effort: small

**Impact.** Deleting a 14 GB volume gives no progress signal, no completion signal, and if it fails the message parks itself over the bottom-right of the content area until some unrelated action succeeds. Because the pending flags are global, one slow image delete freezes every delete button on the screen with no explanation. Screen-reader users get nothing at all on success.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/App.tsx:50-54 — the only error surface in the entire app: `{store.error && <div className="engine-error" role="alert">{store.error}</div>}`.
- /home/soya/dev/tools/docker-ui/app/src/styles/shell.css:537-549 — `.engine-error` is `position:absolute; right:18px; bottom:18px` with no close affordance and no auto-expiry.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1853-1950 — I read the full returned object: it exposes `error` but no `setError`/`clearError`, so nothing can dismiss it except a later mutation calling `setError(null)`.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:21,52,67,78 — `store.pendingIds.has(container.id)` only disables buttons; no spinner, no row state, no text.
- /home/soya/dev/tools/docker-ui/app/src/screens/ImagesScreen.tsx:64 and VolumesScreen.tsx:32,46 — `imageMutationPending`/`volumeMutationPending` are single global booleans that disable every row's delete button at once with no indication of which one is in flight.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1366-1376 and :1631-1641 — successful removal is silent; nothing announces "volume removed".

**Fix.** Track pending state per resource identity (as `pendingIds` already does for containers), render an inline spinner in the acting row, add an `aria-live="polite"` region announcing "Removing <name>…" / "Removed <name>", and give the error toast a close button plus auto-expiry.

<sub>Verifier (CONFIRMED): Confirmed; I read the store's full return object to verify the absence of any error-clearing export rather than grepping for it.</sub>

---

#### No focus management around destructive actions — focus drops to <body> after every delete

`accessibility` · `defect` · effort: small

**Impact.** Keyboard and screen-reader users lose their place entirely after every delete: focus resets to the document body, so the next Tab restarts from the title bar. Deleting several containers in a row is effectively unusable without a mouse on a 102-row list.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:71-83 — the delete button unmounts with its row when `deleteContainer` filters the list (useAnchorageStore.ts:862-864); nothing calls `.focus()` afterwards.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:880 and :894-899 — deleting from the detail screen calls `setSelectedId(null)`, unmounting `ContainerDetailScreen` entirely with no focus target set.
- /home/soya/dev/tools/docker-ui/app/src/screens/ImagesScreen.tsx:56-70 and VolumesScreen.tsx:78-92 — same unmount-on-success pattern.
- I ran the `.focus()` grep across app/src myself. Hits: Shell.tsx:118 (⌘K focuses the search box), SettingsScreen.tsx:71 (roving radiogroup), ContainerDetailScreen.tsx:515 (click-to-focus terminal), CommandCenter.tsx:405/408 (dialog autofocus + restore-on-close) and CommandCenter.tsx:848/851 (focus trap wrap). None of these is in a destructive path.
- /home/soya/dev/tools/docker-ui/app/src/App.tsx:50-54 — the error alert is not focusable and receives no focus when a delete fails.

**Fix.** After a successful removal, move focus to the next row's delete button (or the table container / empty-state heading when the list becomes empty). When returning from the detail screen, focus the neighbouring row. On failure, move focus to the error alert and make it programmatically focusable (`tabIndex={-1}`).

<sub>Verifier (CORRECTED): CORRECTED on the evidence, not the conclusion. Surveyor 1 says the repo-wide grep finds `.focus()` "only in SettingsScreen.tsx:69-71 and ContainerDetailScreen.tsx:515". That is incomplete — CommandCenter.tsx has a full focus trap with restore-on-close (405-408, 848-851) and Shell.tsx:118 focuses search on ⌘K. The correct claim is that focus management exists in the modal and shortcut paths but in no destructive path, which is what actually matters here. Conclusion and severity unchanged.</sub>

---

#### No port link-opening and no copy-ID; the Electron policy would block link-opening even if the UI were added

`parity-gap` · `absent` · effort: medium

**Impact.** Clicking a published port to open http://localhost:8080 is one of Docker Desktop's most-used shortcuts, as is copying a container or image ID. Neither exists. Adding the port link is not a renderer-only change: the current policy has no external-open channel and denies both `window.open` and the `openExternal` permission, so this is a main-process gap too.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:150-152 — ports render as `<span className="container-ports" title={container.ports}>{container.ports}</span>`, plain truncated text.
- artifacts/host-candidate/screens/host-containers.png — I opened it: live rows show `0.0.0.0:43594->43594/tcp, :::43…` truncated with no affordance.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:115-121 — the short container ID is display-only text with no copy button; ImagesScreen.tsx:41 — image ID likewise.
- I grepped app/electron for `openExternal` and `shell` — no hits, no import. /home/soya/dev/tools/docker-ui/app/electron/security-policy.mjs:160 — `windowOpen: () => ({ action: "deny" })`; :151-159 — `willNavigate`/`willRedirect` deny anything failing `isTrustedNavigation`; :111-114 — `permissionCheck: () => false` and `permissionRequest: (...)=>callback(false)`, and `openExternal` is in Electron 43's permission enum (electron.d.ts:13246,13255), so it would be denied too.

**Fix.** Add a narrowly-scoped IPC channel that validates a loopback http(s) URL against the container's actual published ports before calling `shell.openExternal`, and expose it as a link on published-port cells. Add copy-to-clipboard buttons for container and image IDs.

<sub>Verifier (CONFIRMED): Confirmed; I verified the openExternal permission is genuinely in Electron 43.2.0's permission enum (and therefore covered by the blanket deny) by reading the bundled electron.d.ts rather than assuming.</sub>

---

#### Images: no detail view, no in-use/unused/dangling filters, no run-from-image, no tag/push/history/inspect

`parity-gap` · `absent` · effort: large

**Impact.** Docker Desktop lets you click an image to see its layers and history, its Scout vulnerability summary, and run/tag/push/delete it. Anchorage's Images screen is a flat read-only table with one delete button. With 231 images and no filter chips, isolating the 166 unused ones from the UI is impossible.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/ImagesScreen.tsx:27-73 — image rows have no onClick and no overflow menu; the only per-row control is the delete button at :56-70. /home/soya/dev/tools/docker-ui/app/src/App.tsx:17-45 — there is no image detail route.
- /home/soya/dev/tools/docker-ui/app/src/screens/ImagesScreen.tsx:260-283 — the only tabs are Local and Registry search; there are no filter chips. ImagesScreen.tsx:44-55 — the IN USE column is a static pill, not a filter control.
- /home/soya/dev/tools/docker-ui/protocol/types.ts:113 — `ImageAction` is only `remove \| prune \| pull`; there is no history/inspect/tag/push/save in the protocol or in core/internal/core/service.go:65-215.
- scratchpad/docker-help-root.txt — `history`, `tag`, `push`, `save`, `inspect` all exist on the installed CLI (Docker 29.6.2), and I ran the ledger: all 12 `docker image *` leaves are Command-Center-only.
- artifacts/host-candidate/screens/host-images.png — 231 images, 166 unused, no filter chips and no way to isolate them.

**Fix.** Add filter chips (All / In use / Unused / Dangling) driving the existing `usageKnown`/`inUse`/`reclaimable` fields, make rows open a detail panel backed by new `images.history`/`images.inspect` protocol methods, and add a per-row overflow with Run and Delete.

<sub>Verifier (CONFIRMED): Confirmed; every citation checked and the ledger group counts verified by running it.</sub>

---

#### The Command Center is a literal-argv escape hatch with no option schema, and it is the sole route for 219 of 219 discovered leaves

`ux` · `wired-but-gated` · effort: medium

**Impact.** For long-tail commands the palette is a genuinely good design and better than most GUIs offer. For head commands it is worse than a terminal: raw text you cannot click, in a modal, with no persistence, and nothing in the app updating afterwards. The 219/219 figure is best read as evidence of how much of Docker has no first-class surface rather than as coverage.

**Evidence.**
- I ran artifacts/docker/capability-ledger.json myself: 219 rows, 219 with `uiPath.surface == "Command Center"` (100%), `inventory.commandExecutedConformancePassed: 0`, `inventory.transportCovered: 219`.
- /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:599-606 — `selectCommand` prefills `argumentRows` with the command *path* tokens only (e.g. ["network","create"]). Every flag and value after that is a hand-typed row.
- The project states this plainly itself: capability-ledger.json `coverageDefinition` — "Transport coverage is not command-behavior conformance: the generator intentionally does not execute arbitrary, destructive, credentialed, or environment-specific leaf commands."
- /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:1281-1299 — results are a raw session output pane; no table, no row selection, no click-through to any app object.
- /home/soya/dev/tools/docker-ui/app/src/components/commandCenterModel.ts:154-181 — destructive argv (rm/rmi/prune on 14 roots, `compose down`, `swarm leave`) is gated behind a re-click confirm (CommandCenter.tsx:718-721, 1246-1269), which is correct safety behaviour but adds friction to a route that is already the only route.
- /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:694-697 — the run is blocked without a selected context, and that context is the dialog's own (see the context-switching finding).

**Fix.** Keep the Command Center as the long-tail route and stop counting it as parity for head commands. Prioritise first-class surfaces in order of daily-use frequency: networks, system prune + live df, compose grouping, context switching. Two cheap palette improvements: parse the `--help` Options block that discovery already captures (`evidence.stdout`) into flag suggestions, and render `--format {{json .}}` output as a table.

<sub>Verifier (CORRECTED): CORRECTED on severity only, from high to medium. Every factual claim checks out and I reproduced the ledger statistics independently. But this is an assessment of a design trade-off rather than an independent defect — the specific head-command gaps it argues for (networks, system prune, contexts, compose) are already filed individually at critical/high, so grading this high double-counts them.</sub>

---

#### There is no container-creation surface at all: both primary CTAs in the product just open the Command Center with a search string

`parity-gap` · `absent` · effort: large

**Impact.** Two of the three primary buttons in the product are navigation shims to a raw-argv palette. There is no equivalent of Docker Desktop's Run dialog (image, container name, published ports, volume mounts, environment variables), which is how most GUI users start a one-off container. Combined with the fact that a Command Center run invalidates nothing, the most prominent action in the app produces a container the app will not notice for up to two seconds and a Dashboard that never updates at all.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:184-191 — the Containers screen's `primary-button` is "Run new" and its entire implementation is `onClick={() => store.openCommandCenter("run")}`.
- /home/soya/dev/tools/docker-ui/app/src/screens/DashboardScreen.tsx:172-178 (host) and :316-322 (fixture) — the Dashboard's `primary-button` is "Compose up" and its entire implementation is `onClick={() => store.openCommandCenter("compose up")}`.
- /home/soya/dev/tools/docker-ui/app/src/screens/ImagesScreen.tsx:251-258 — the Images screen's `primary-button` "Pull image" is the one primary CTA that does real work (`store.setImageTab("registry")` → `pullRegistryImage`, useAnchorageStore.ts:1380+).
- protocol/types.ts:70 `ContainerAction` is start\|stop\|restart\|remove — there is no create/run in the protocol, and core/internal/core/service.go:65-215 has no create case.
- Once in the palette, `selectCommand` prefills only the path token `["run"]` (CommandCenter.tsx:599-606); the image, name, `-p`, `-v`, `-e` and `--restart` values are each a separately hand-typed argv row.

**Fix.** Add a `containers.create` protocol method (or a structured `run` action) backed by `POST /containers/create` + `POST /containers/{id}/start`, and build a Run dialog behind the "Run new" button covering image, name, ports, volumes, env and restart policy. Keep the palette route for everything the dialog does not model.

---

#### No pause/unpause anywhere — a paused container is an unmanageable dead end in the UI

`parity-gap` · `absent` · effort: medium

**Impact.** A container paused from a terminal or by a compose stack appears in Anchorage with the toggle disabled, Delete disabled, and only Restart enabled — an action that discards the paused process state rather than resuming it. Docker Desktop exposes pause/unpause in its per-container menu.

**Evidence.**
- /home/soya/dev/tools/docker-ui/protocol/types.ts:70 — `export type ContainerAction = "start" \| "stop" \| "restart" \| "remove";`. Verified.
- /home/soya/dev/tools/docker-ui/protocol/v1.schema.json — I enumerated every const/enum in the schema; the container action enum is exactly ['start','stop','restart','remove']. No pause/unpause/kill/top/prune anywhere in the wire contract.
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:596-603 — `validateAction` allowlist is `case "start", "stop", "restart", "remove":` else `unsupported_container_action`. Verified.
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:1-6 — `CONTAINER_ACTIONS = new Set(["start","stop","restart","remove"])`. Verified.
- /home/soya/dev/tools/docker-ui/app/src/utils/containerPresentation.ts:67-81 — `primaryContainerAction` returns null for `paused`, so the toggle renders "Unavailable" and is disabled (ContainersScreen.tsx:53, ContainerDetailScreen.tsx:167). Verified.
- /home/soya/dev/tools/docker-ui/app/src/utils/containerPresentation.ts:83-90 — `canRestartContainer` includes `paused`, making Restart the only enabled control. Verified.

**Fix.** Extend `ContainerAction` with `"pause" \| "unpause"` across protocol/types.ts:70, v1.schema.json, contracts.mjs:1-6, and validateAction/containerActionEngine/containerActionCLI in engine.go (Engine POST /containers/{id}/pause\|unpause; CLI `container pause\|unpause`). Let `primaryContainerAction` return `"unpause"` for paused containers.

<sub>Verifier (CONFIRMED): Confirmed absent at every layer by exhaustive grep plus a full enumeration of protocol/v1.schema.json enums. I note the escape hatch the surveyor understated: `container pause <name>` IS runnable from the Command Center (docs/architecture.md:24-29 makes 'no bespoke workflow must make an installed command unreachable' an explicit design policy), so this is 'absent from the graphical workflow', not absent from the product. SEVERITY RE-GRADED high -> medium: pausing is not a daily-driver operation and the dead-end only manifests for containers paused outside Anchorage.</sub>

---

#### No `docker kill` and no signal delivery to containers; stop/restart timeout is implemented in three layers but never sent

`parity-gap` · `absent` · effort: medium

**Impact.** There is no way to send an application signal (SIGHUP to reload config, SIGUSR1 to dump state) to a container, and no reachable stop-timeout override — databases and queue workers are always SIGKILLed after 10s, and known-hung containers cannot be stopped faster. Four layers implement the timeout knob; only the topmost declines to turn it, so validated code ships dead in the packaged binary.

**Evidence.**
- /home/soya/dev/tools/docker-ui/protocol/types.ts:70 — `ContainerAction` has no `kill`. Verified.
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:596-603 — the allowlist rejects it. Verified.
- /home/soya/dev/tools/docker-ui/protocol/types.ts:252 — `SessionSignal = "interrupt"\|"terminate"\|"kill"\|"hangup"\|"quit"` targets the spawned docker CLI process, confirmed at core/internal/core/session.go:829-830 (`case "kill": return syscall.SIGKILL`) which signals the session process group, not the container.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:39-85 and ContainerDetailScreen.tsx:161-192 — the complete action sets are toggle/restart/delete. No kill control. Verified.
- MERGED FROM THE SEPARATE 'timeout' FINDING: protocol/types.ts:78-83 declares `options?: { timeoutSeconds?: number }` for stop/restart; app/electron/contracts.mjs:332-335 validates it 0..600 and forwards it; engine.go:450-451 appends `?t=<n>`; engine.go:485-494 appends `--time <n>`; engine.go:604-609 enforces the range. But app/src/types.ts:443-455 gives `stop(id, context?)` / `restart(id, context?)` no options parameter at all, and anchorageBridge.ts:834-850 builds start/stop/restart with no `options` object, so Docker's implicit 10s grace always applies.
- docker kill --help (29.6.2): `-s, --signal string`. docker stop --help (29.6.2): `-s, --signal` and `-t, --timeout int`.

**Fix.** Add `kill` to `ContainerAction` with an optional `signal` validated against an allowlist in `validateAction` (Engine POST /containers/{id}/kill?signal=). Separately and much cheaper: add an optional timeout argument to `ContainerOperations.stop/restart` in app/src/types.ts:446-447 and pass it through anchorageBridge.ts:834-850.

<sub>Verifier (CONFIRMED): CONFIRMED and MERGED with the surveyor's separate low-severity 'stop/restart timeout never sent' finding — they are the same defect class (signal/timeout shaping of stop) and the same one-line fix site. All citations verified. SEVERITY RE-GRADED high -> medium: `docker stop` already escalates to SIGKILL after the grace period, so a wedged container is not a true dead end, only a 10-second wait; and `container kill -s <SIG> <name>` is runnable from the Command Center. The dead validated timeout code is a genuine defect but low-impact on its own.</sub>

---

#### `docker top` does not exist in host mode; the only process list in the product is a browser-fixture string

`parity-gap` · `fixture-only` · effort: medium

**Impact.** There is no way to see what is running inside a container from the graphical workflow. The Stats card displays a PID count, which advertises the concept. The only path is Command Center -> `container top <name>`.

**Evidence.**
- /home/soya/dev/tools/docker-ui/protocol/types.ts:276-294 — the `RPCRequest` union is Health/SystemCapabilities/SystemSnapshot/ContainersList/ContainerInspect/ContainerStats/ContainersAction/Images*/Volumes*/CLIRun/Session*. No containers.top. Verified.
- Repo-wide grep for `containers.top`, `"top"`, `/top` across app/src, app/electron, protocol, core: zero hits.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:23-30 — the six tabs are logs, inspect, mounts, exec, files, stats. No processes tab. Verified.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:414-455 — `commandOutput()` returns a hardcoded 4-line `ps aux` string; this is the only process listing in the codebase. Verified at lines 421-427.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:927-932 — in host mode that fixture panel is replaced by `HostExecPanel`, so even the fake output is absent against a real daemon. Verified.
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:492-494 and protocol/types.ts (ContainerStatsResult.pids) — stats returns a bare PID count; ContainerDetailScreen.tsx:877 renders `${stats.pids} PIDs`, advertising the concept without delivering it. Verified.

**Fix.** Add a `containers.top` RPC (Engine GET /containers/{id}/top returns `{Titles, Processes}` — a clean structured projection needing no free-form parsing) and a Processes detail tab. It reuses the containerInspect plumbing in domain.go:223-265 and is self-contained.

<sub>Verifier (CONFIRMED): Confirmed absent by exhaustive grep. Note the exec panel in host mode is a real PTY (ContainerDetailScreen.tsx:600-609) so a user CAN type `ps` inside it when the image has a shell — the surveyor's claim that the app has no process view is right for the graphical workflow, slightly overstated as an absolute. SEVERITY RE-GRADED high -> medium: Docker Desktop has no processes tab either; this is a lazydocker-class nicety, not a daily-driver blocker.</sub>

---

#### `docker rm -v` (anonymous volume removal) is implemented end-to-end but no UI can set it

`parity-gap` · `core-only-not-wired` · effort: small

**Impact.** Every container deleted through Anchorage leaves its anonymous volumes on disk, with no in-product signal. The plumbing to prevent it is written, validated and shipped in the Go core; the renderer simply never asks for it.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/types.ts:448 — `remove(id: string, context?: string): Promise<void>` — the bridge interface has no options parameter, so `volumes` is unreachable by type.
- /home/soya/dev/tools/docker-ui/app/src/services/anchorageBridge.ts:843-845 — remove options are literally `{ confirmed: true as const }`. Verified.
- /home/soya/dev/tools/docker-ui/protocol/types.ts:88-92 — remove options declare `volumes?: boolean`. Verified.
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:338-343 — the preload validates and forwards `request.options.volumes`. Verified.
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:447 — Engine transport sets query parameter `v` from `params.Options.Volumes`. Verified.
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:500-502 — CLI transport appends `--volumes`. Verified.

**Fix.** Add an 'Also delete anonymous volumes' checkbox to a real delete dialog (replacing `window.confirm` at ContainersScreen.tsx:32-37 and ContainerDetailScreen.tsx:119-127) and pass `options.volumes`. This is the same dialog that must host the `force` toggle.

<sub>Verifier (CONFIRMED): All citations verified; I strengthened the root cause to the bridge interface (types.ts:448) rather than the call site. SEVERITY RE-GRADED high -> medium: the Volumes screen DOES ship a working 'Clean up' that prunes all unused volumes (useAnchorageStore.ts:1649-1694, VolumesScreen.tsx:30-42, filters `{ all: ["true"] }`), so the leak has a one-click in-product remedy. 'Unbounded disk growth the user gets no signal about' is therefore overstated.</sub>

---

#### Logs: no since/until/tail control, 500-line ceiling, and log levels are invented by regex over real output

`correctness` · `defect` · effort: medium

**Impact.** (1) Parity: no --since/--until/adjustable tail and only 200 lines of initial history; the filter silently searches a truncated corpus. (2) Truthfulness: Anchorage paints ERROR/WARN badges by substring match while discarding the one real provenance signal it has (stdout vs stderr). A line reading `no errors found` is badged ERROR. That contradicts the project's own evidence-not-simulation principle.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/services/anchorageBridge.ts:1001-1008 — the one-shot fetch is hardcoded `argv: ["logs","--timestamps","--tail","200", id]` with a fixed 30s timeout. Verified.
- /home/soya/dev/tools/docker-ui/app/src/types.ts:449 — `logs(id: string, context?: string)` — the bridge interface accepts no tail/since/until parameter, so this is unreachable by type, not merely unset.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1099-1113 — the follow session is hardcoded `["logs","--timestamps","--tail","0","--follow", id]`. Verified.
- /home/soya/dev/tools/docker-ui/app/src/services/anchorageBridge.ts:178-229 — `normalizeCliLogs` reads stdout and stderr, assigns default levels INFO/LOG respectively, then OVERRIDES them whenever the message text matches `/\b(INFO\|LOG\|WARN\|ERROR)\b/iu` (lines 202-210), then merges and sorts. Verified.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1044-1053 — the follow path assigns levels purely by `/\berror\b/iu` and `/\bwarn(?:ing)?\b/iu` over line text, discarding the real `stream` field carried on `SessionOutputPayload` (protocol/types.ts:830-839, `stream: "stdout"\|"stderr"\|"pty"`). Verified.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:709 and :1059 — buffer capped at `.slice(-500)`; :1234 — display capped at `.slice(-200)`. Verified.

**Fix.** Add tail/since/until parameters to `ContainerOperations.logs` (app/src/types.ts:449) and expose them in the logs toolbar. Derive the badge from `SessionOutputPayload.stream` rather than regex, or drop the badge column and add a stderr-only filter toggle. Raise the buffer well above 500 lines.

<sub>Verifier (CONFIRMED): Every citation verified; the surveyor's line references were accurate to within a line or two. I added app/src/types.ts:449 to show the parameter is unreachable by type. Severity held at medium. Additional defect found while reading this code, not worth a separate finding: normalizeCliLogs' sort comparator (anchorageBridge.ts:222-226) returns 0 whenever either timestamp is missing, which is a non-transitive comparator and yields arbitrary stdout/stderr interleaving for untimestamped lines.</sub>

---

#### Exec is hardcoded to `/bin/sh` with no user, workdir, env or command choice, and fails opaquely on shell-less images

`parity-gap` · `wired-but-gated` · effort: small

**Impact.** Any distroless/scratch/minimal image produces an opaque session failure with no way to retry with /bin/bash or /bin/ash. There is no way to exec as a different user (e.g. `-u root` into a container running unprivileged), the most common exec flag in practice.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:600-609 — `argv: ["exec","-it", container.id, "/bin/sh"]`, `mode: "pty"`, rows/cols fixed at 30/120. No other exec shape is reachable. Verified.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:555-560 — exec is refused unless `container.state === "running"` with the bare message 'Exec requires a running container.' Verified.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:629-638 — a start failure sets status 'unavailable' with a raw message and no retry affordance. Verified.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:687 — the panel prints the literal string `docker exec -it {name} /bin/sh`, so the hardcoding is visible to the user with no way to change it.
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:294-303,355-357 and protocol/types.ts (ContainerInspectProjection.user/workingDir) — the inspect projection already carries `user` and `workingDir`, and the store already fetches inspect on select (useAnchorageStore.ts:688-695), so the data to prefill a proper exec dialog is already in memory and unused. Verified.
- docker exec --help (29.6.2) — -u/--user, -w/--workdir, -e/--env, --privileged, -d/--detach and an arbitrary command.

**Fix.** Add a small launcher above the terminal: command input defaulting to /bin/sh with quick-picks for /bin/bash and /bin/ash, plus user and workdir fields prefilled from `store.selectedInspect.container.user` / `.workingDir`. On failure offer one-click retry with the next shell candidate. All of this composes literal argv through the existing `sessions.start` path — no protocol change needed.

<sub>Verifier (CONFIRMED): All citations verified. I added ContainerDetailScreen.tsx:687 (the panel prints the fixed command back at the user) and useAnchorageStore.ts:688-695 (inspect is already fetched on select, so the prefill data is already loaded). Severity held at medium.</sub>

---

#### No multi-select, no bulk action, no sorting, no compose-project grouping — container labels and created timestamps cross the RPC boundary and are then discarded

`ux` · `core-only-not-wired` · effort: medium

**Impact.** Stopping or removing a compose stack means clicking each container individually, each behind its own `window.confirm`. The list cannot be grouped by project, sorted, or filtered by label, and has no CREATED column despite `docker ps` showing one by default. The label data already arrives at the renderer on the Engine path and is thrown away one function later.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:88-156 — `ContainerRow` has no checkbox; the screen holds no selected-ids state; every action targets one container. Verified.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:196-205 — the table head is static `<span>` text; no header is clickable and no sort state exists in the store. Verified.
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:665-672 — `sortContainers` fixes ordering server-side by name then id, with no client override. Verified.
- /home/soya/dev/tools/docker-ui/core/internal/core/types.go:168-169 — the `Container` projection carries `Labels map[string]string` and `Created int64`. Verified.
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:287-291 — the Engine path populates both. Verified.
- /home/soya/dev/tools/docker-ui/app/src/services/anchorageBridge.ts:143-166 — `normalizeContainer` builds the renderer object with neither labels nor created. Verified.

**Fix.** Carry `labels` and `created` through `normalizeContainer` into `AnchorageContainer`. That single change unlocks a Created/age column, grouping by `com.docker.compose.project`, and label filtering. Widen the CLI-fallback decode struct at engine.go:323-331 to capture Labels/CreatedAt (they are already in the response) so remote contexts are not degraded. Then add row checkboxes plus a bulk action bar fanning out to the existing per-container mutations.

<sub>Verifier (CORRECTED): CORRECTED one sub-claim: the surveyor wrote 'the CLI fallback list does not even request Labels in its --format'. It does — `{{json .}}` at engine.go:299 includes Labels; the Go struct at engine.go:323-331 simply does not decode them. I verified this against the installed Docker 29.6.2 by running `docker ps --format '{{json .}}'` and listing the keys. Everything else confirmed verbatim; I added the search-field limitation at useAnchorageStore.ts:1176-1191. Severity held at medium.</sub>

---

#### No `docker container prune` — asymmetric with images and volumes, which both ship a working "Clean up" button

`parity-gap` · `absent` · effort: medium

**Impact.** Cleaning up dozens of exited containers means clicking Delete on each, each behind its own confirm dialog, while the equivalent one-click cleanup exists for images and volumes. Since stopped containers are the only ones Anchorage will delete at all, this is precisely the workflow the product is best positioned to serve, and it is the one that is missing.

**Evidence.**
- /home/soya/dev/tools/docker-ui/protocol/types.ts:113 `ImageAction = "remove"\|"prune"\|"pull"`, :156 `VolumeAction = "create"\|"remove"\|"prune"`, :70 `ContainerAction` has no prune. Verified.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1284-1332 — `cleanUpImages` issues `images.action { action: "prune", filters: { dangling: ["true"] } }`. Verified.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1649-1694 — `pruneVolumes` issues `volumes.action { action: "prune", confirmed: true, filters: { all: ["true"] } }`. Verified.
- /home/soya/dev/tools/docker-ui/app/src/screens/ImagesScreen.tsx:243-250 and VolumesScreen.tsx:29-43 — both surface a 'Clean up' button. Verified.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:172-192 — the Containers header offers only the only-running filter and 'Run new'. Verified.
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:1242-1254 — the volume prune result decoder (`VolumesDeleted`, `SpaceReclaimed`) is structurally identical to what container prune needs (`ContainersDeleted`, `SpaceReclaimed`). Verified.

**Fix.** Add `prune` to `ContainerAction` mirroring the existing image/volume prune shape (confirmed: true plus a filters allowlist of until/label/label!). Engine POST /containers/prune returns `{ContainersDeleted, SpaceReclaimed}`, decoded exactly like domain.go:1242-1254. Add a 'Clean up' button to the Containers header.

<sub>Verifier (CONFIRMED): All citations verified verbatim, including the structural symmetry with volume prune. Severity held at medium — `container prune` is reachable from the Command Center and is a single typed command with no ID to transcribe, so the workaround here is cheap.</sub>

---

#### No Docker event stream — freshness depends on a full re-list of every container every 2 seconds

`performance` · `absent` · effort: large

**Impact.** Every 2s, indefinitely, the app issues a full container list and replaces every object — which is also the direct cause of the stats-history defect reported separately. External changes (a `docker run` in a terminal, a compose up, a container exiting) take up to 2s to appear.

**Evidence.**
- /home/soya/dev/tools/docker-ui/protocol/types.ts:949-954 — `CoreEvent` is SessionEvent \| operation.started \| operation.completed \| reconciliation.requested \| reconciliation.required. No Docker daemon event. Verified.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:603-625 — host mode polls `refreshContainers()` on `window.setInterval(poll, 2_000)` for the app's lifetime, on every screen (it does skip while `document.visibilityState === "hidden"`). Verified.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:490-508 — each poll is a full `containers.list` (Engine GET /containers/json?all=1 per anchorageBridge.ts:829) whose result replaces the entire array. Verified.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:571-577 — the only reactive refresh path is Anchorage's own `reconciliation.*` events after its own mutations; externally-caused changes have no push path. Verified.
- CORRECTION — the transport already exists and is already exercised: /home/soya/dev/tools/docker-ui/tools/run-performance-evidence.mjs:1285 starts a session with `argv: ["events", "--format", "{{json .}}"]`, and docs/parity-and-release-gates.md:167 makes 'a complete 30-minute acknowledged `docker events` session' a mandatory release performance gate. So `docker events` is proven end-to-end through `session.start` in the release harness and simply never consumed by the product.
- CORRECTION — /home/soya/dev/tools/docker-ui/app/src/components/FixedRowWindow.tsx has no `React.memo` on rows and virtualizes only above `threshold = 200` items. There is no row memoisation for the array churn to 'defeat'; the real cost is a full re-render of all rendered rows every 2s.

**Fix.** Consume the `docker events` session that the perf harness already proves works — start a long-lived `session.start` with `["events","--filter","type=container","--format","{{json .}}"]`, or add Engine GET /events as a core event — and reduce the poll to a slow reconciliation safety net (30s). Merging list results by id instead of replacing is a prerequisite either way and independently fixes the stats charts.

<sub>Verifier (CORRECTED): CORRECTED on two points. (1) The state is not cleanly 'absent': the literal-argv session transport for `docker events` exists and is a mandatory release gate (run-performance-evidence.mjs:1285, parity-and-release-gates.md:167). The product-level wiring is what is missing, which makes this substantially cheaper than the surveyor's 'large' framing suggests. (2) The claim that array churn 'defeats memoisation in FixedRowWindow' is false — I read FixedRowWindow.tsx and there is no memoisation there at all. Severity held at medium.</sub>

---

#### No first-class surface for attach, cp, diff, export, commit, port, or wait

`parity-gap` · `escape-hatch-only` · effort: large

**Impact.** Copying a file out of a container, diffing its filesystem, or committing a debug image requires dropping to a raw argv console and typing the container name and every flag by hand. `docker cp` in particular is the most-requested container-UI feature and has no assisted path.

**Evidence.**
- /home/soya/dev/tools/docker-ui/protocol/types.ts:276-294 — the RPC method union contains no container method for any of these verbs. Verified.
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:596-603 — the mutation allowlist rejects anything outside start/stop/restart/remove. Verified.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:23-30 — no tab or control for any of them. Verified.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:933-945 — the Files tab is explicitly declared unavailable in host mode ('The current host protocol has no literal-path container file browser. No synthetic filesystem is shown.') with an escape hatch to `openCommandCenter("container cp")`. Verified.
- /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:599-610 — `selectCommand` prefills argv rows with only `command.path`; the target and every flag must be typed by hand. Verified.
- CORRECTION TO STATE: /home/soya/dev/tools/docker-ui/docs/architecture.md:24-29 makes this an explicit, documented design policy — 'A missing bespoke workflow must never make an installed Docker command unreachable' — and core/internal/core/discovery.go:186-259 recursively probes `docker <path> --help` so every advertised leaf (attach, commit, cp, diff, export, port, wait) becomes a searchable Command Center route with a real PTY/pipes transport. These verbs are reachable by design, not undocumented gaps.

**Fix.** Prioritise `cp` (bidirectional, Engine PUT/GET /containers/{id}/archive) and `commit` — structured, low-risk, and together they unlock the Files tab. `diff` (GET /containers/{id}/changes) is a trivial add that pairs with Files. Treat attach/wait/export as legitimately Command-Center-only and say so in docs rather than leaving them implicit.

<sub>Verifier (CORRECTED): CORRECTED state from 'absent' to 'escape-hatch-only'. Per the reporting rules I must distinguish 'not implemented at all' from other states: these verbs have a documented, working, searchable Command Center route backed by real help-tree discovery (discovery.go:186-259) and an explicit architecture policy (docs/architecture.md:24-29). Calling them 'absent' misrepresents the product. Also corrected the '64-char ID' framing. Severity held at medium.</sub>

---

#### "Run new" is a misleading primary CTA — it opens a raw argv editor, not a container-creation form

`ux` · `wired-but-gated` · effort: large

**Impact.** The most prominent button on the Containers screen promises container creation and delivers a blank command-line argument table. Combined with the Images screen having no run affordance, there is no assisted path from an image to a running container.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:185-191 — the primary CTA is `Run new`, wired to `store.openCommandCenter("run")`. Verified.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:672-675 — `openCommandCenter(initialQuery)` only sets a search string; there is no argv prefill parameter anywhere in the store. Verified.
- /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:374-400 — opening seeds only `query` and resets argumentRows to `[]`. Verified.
- /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:599-610 — selecting the `run` leaf prefills argv rows with `["run"]` and nothing else. Verified.
- /home/soya/dev/tools/docker-ui/protocol/types.ts:70 — no `create` container action exists. I grepped app/src for restartPolicy / port mapping / publishPort / containers.create: the only `"create"` action in the product is for VOLUMES (useAnchorageStore.ts:1564, types.ts:356). There is no image picker, port-mapping, volume-mount, env, name or restart-policy field anywhere.
- /home/soya/dev/tools/docker-ui/app/src/screens/ImagesScreen.tsx — grepped: the only header actions are 'Clean up' (line 249) and 'Pull image' (line 252). No 'run this image' affordance, so there is no assisted image->container path anywhere in the product.

**Fix.** Either build a real run/create form (name, image, port bindings, volume mounts, env, restart policy -> Engine POST /containers/create + /start, which also gives restart-policy parity a home), or relabel the button to something truthful such as 'Docker command…'. A misleading primary CTA is worse than no CTA.

<sub>Verifier (CORRECTED): CORRECTED one citation: the surveyor cited CommandCenter.tsx:691-707 as 'the user must supply every remaining token themselves', but that range is the `runCommand` submit validator, not the argv row editor. I substituted useAnchorageStore.ts:672-675 and CommandCenter.tsx:374-400, which actually prove the claim (openCommandCenter carries only a query string; argumentRows is reset to []). I independently confirmed the absence of any creation form by grepping the whole renderer. Severity held at medium.</sub>

---

#### `docker update` is absent and restart policy / resource limits are invisible except in raw inspect JSON

`parity-gap` · `absent` · effort: medium

**Impact.** Users cannot change a container's memory/CPU limits or its restart policy, and cannot read them without eyeballing raw JSON. The browser-mode fixture displays a clean HostConfig block, so design QA captures show something the real app does not deliver.

**Evidence.**
- /home/soya/dev/tools/docker-ui/protocol/types.ts:70 — no `update` action. Verified.
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:267-327 — the `engineContainerInspect` decode struct captures Id, Created, Path, Args, Image, Name, RestartCount, Driver, Platform, LogPath, State, Config, Mounts and NetworkSettings. There is NO `HostConfig` field at all, so RestartPolicy, Memory, NanoCpus and PidsLimit are never decoded. Verified.
- /home/soya/dev/tools/docker-ui/protocol/types.ts (ContainerInspectProjection) — no HostConfig/restartPolicy/resources fields. Verified.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:301-307 — in host mode the Inspect tab renders `JSON.stringify(store.selectedInspect.document, null, 2)`; since `document` is the raw Engine body (domain.go:262 `Document: cloneJSON(body)`), restart policy IS present but only as unstructured JSON the user must scroll to find.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:331-336 — the BROWSER-MODE inspect fixture shows a tidy `HostConfig: { NetworkMode, RestartPolicy: { Name: "unless-stopped" }, Memory, NanoCpus }`, implying a structured resource display that host mode does not provide. Verified.
- docker update --help (29.6.2) — --cpus, --memory, --memory-swap, --pids-limit, --restart, --cpu-shares, --blkio-weight, --cpuset-cpus.

**Fix.** Cheap win first: add `HostConfig` to the decode struct at domain.go:267-327, project RestartPolicy/Memory/NanoCpus/PidsLimit into `ContainerInspectProjection`, and render them as an overview card in the detail header — read-only parity at near-zero risk. Mutation (action `update`, Engine POST /containers/{id}/update) can follow.

<sub>Verifier (CONFIRMED): All citations verified; I widened the domain.go citation from 294-303 (which is only the Config sub-struct) to 267-327 (the whole decode struct) because the absence of HostConfig is only provable by reading the complete struct. Severity held at medium — the data is at least present in the raw Inspect document, so this is a presentation and mutation gap, not a blindness.</sub>

---

#### Every single RPC re-executes `docker context inspect` and re-negotiates a fresh Engine connection — there is no endpoint cache and no connection reuse

`performance` · `defect` · effort: medium

**Impact.** Idling on the Containers screen forks a `docker` CLI process every 2 seconds, forever, plus a redundant `/version` handshake and a new socket connection per RPC — roughly 30 process spawns per minute at rest, 60/min with the Stats tab open. This is invisible in the project's own performance gates because they measure end-to-end p95 latency (docs/parity-and-release-gates.md:169-179, containers warm p95 <= 2000 ms) which 14 ms of overhead comfortably passes. It also partially undercuts README.md:38-40's claim that the Engine-API path exists because 'it preserves Docker semantics and improves latency' — every Engine-API call still pays for a CLI exec first.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:40-96 — `resolveEngineEndpoint` unconditionally runs `docker context inspect <name>` as a subprocess on every call. I grepped engine.go and service.go for cache/Cache/sync.Map/endpointCache: zero hits. There is no memoisation.
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:98-140 — `newEngineClient` builds a brand-new `http.Transport` and issues `GET /version` for API negotiation on every call.
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:209-223 — `containersList` calls `resolveEngineEndpoint` then `newEngineClient` then `defer client.close()`, so the transport (and its idle-connection pool, MaxIdleConns: 8) is discarded after a single request. The same pattern is at domain.go:233-247 (inspect), domain.go:424-438 (stats), engine.go:398-411 (actions), and the images/volumes paths.
- MEASURED on the user's machine: `docker context inspect default` takes 13-14 ms warm (5 runs: 60, 14, 14, 13, 13 ms; the first is cold-cache).
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:615 — the container list poll runs every 2 s for the app's lifetime; :639 — images/volumes refresh every 10 s on those screens; :930-933 — stats poll every 2 s while the Stats tab is open. Each of those is one fork+exec of the docker CLI plus two HTTP round trips over a freshly dialled unix socket.

**Fix.** Cache the resolved `contextEndpoint` per context name with invalidation on `system.capabilities` refresh or on any engine error, and keep one long-lived `engineClient` (with its negotiated apiVersion) per endpoint instead of constructing and closing one per request. Both are localised to engine.go:40-140 and would remove the subprocess and the `/version` round trip from the steady-state poll entirely.

---

#### `containers.stats` and `system.snapshot` hard-fail on any Docker context that is not a local unix socket — no CLI fallback, unlike every other read

`parity-gap` · `defect` · effort: medium

**Impact.** On a remote Docker context (ssh:// is the standard way to drive a remote daemon, and Docker Desktop / colima / rootless setups can also present non-unix endpoints) Anchorage degrades unevenly: the container list, inspect, start/stop/restart/remove, images and volumes all keep working via the CLI, but the entire Stats tab AND the Dashboard's system snapshot go permanently dark with an 'unavailable' message. That is a confusing partial failure rather than a clean degradation, and the project's docs (docs/parity-and-release-gates.md:159-161) already flag that remote/rootless daemons are not covered by the evidence bundle.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:84-88 — `resolveEngineEndpoint` returns `errTransportUnsupported` unless the context's Docker host URL has `Scheme == "unix"`. Any `ssh://` or `tcp://` context is therefore unsupported on the native path.
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:424-437 — `containerStats` responds to `errTransportUnsupported` with `nativeTransportRequired("containers.stats", ...)` — a hard error. There is no CLI fallback.
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:31-42 — `systemSnapshot` does the same: `nativeTransportRequired("system.snapshot", ...)`.
- CONTRAST — every other read and mutation DOES fall back: containers.list -> `s.containersListCLI` (engine.go:209-220), containers.inspect -> `s.containerInspectCLI` (domain.go:235-244), containers.action -> `s.containerActionCLI` (engine.go:398-414), and the images/volumes paths have `imagesListCLI` / `volumesListCLI` / `imagesActionCLI` / `volumesActionCLI`.
- `docker stats --no-stream --format '{{json .}}'` and `docker system info --format '{{json .}}'` both work over any context including ssh:// and tcp://, so the fallback is available and simply not written.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainerDetailScreen.tsx:838-845 — the renderer surfaces this as a generic 'Stats unavailable' capability state, so the user is told the capability is missing rather than that their context type is unsupported.

**Fix.** Add `containerStatsCLI` (`docker stats --no-stream --format '{{json .}}' <id>`) and `systemSnapshotCLI` (`docker system info --format '{{json .}}'` plus `docker system df --format '{{json .}}'`) mirroring the existing `containerInspectCLI` / `volumesListCLI` shape, and dispatch to them on `errTransportUnsupported` exactly as domain.go:235-244 already does for inspect. Note that the CLI stats path also fixes the CPU-percent defect reported above for free, because `docker stats` computes the delta correctly.

---

#### `force` and `noPrune` are implemented end-to-end in core and never sent by the renderer

`parity-gap` · `core-only-not-wired` · effort: small

**Impact.** `docker rmi -f` on an image held only by stopped containers is unreachable from the Images screen (43 rows on this host). The untag-a-multi-tag-image case is a real logic hole but currently affects nothing on this machine. Both have a literal-argv route in Command Center.

**Evidence.**
- protocol/types.ts:124-125 — `force?: boolean; noPrune?: boolean` on the remove variant
- core/internal/core/domain.go:973-974 — `values.Set("force", strconv.FormatBool(params.Force))` / `values.Set("noprune", ...)`
- core/internal/core/domain.go:1116-1121 — CLI path appends `--force` / `--no-prune`
- app/src/store/useAnchorageStore.ts:1353-1359 — the sole call site sends `{context, action:"remove", id, reference, confirmed:true}`; grep of app/src finds no other producer of `force`/`noPrune`
- app/src/screens/ImagesScreen.tsx:63 — `image.inUse` is a blanket block; useAnchorageStore.ts:111 computes it per image ID, so it applies to every tag row of a multi-tag image
- MEASURED: only 1 of 231 images on this host carries >1 repoTag (ollama/ollama) and it has containers===0, so the untag-blocked scenario has 0 live instances here

**Fix.** Surface force/no-prune on the remove confirmation (checkboxes plus the resulting argv), and stop treating `inUse` as a blanket block when the image has more than one repoTag — removing one of several tags is an untag, which Docker permits without force.

<sub>Verifier (CORRECTED): The wiring claim is fully confirmed: protocol/types.ts:124-125, domain.go:973-974 (Engine `force`/`noprune` query params), domain.go:1116-1121 (CLI `--force`/`--no-prune`), and useAnchorageStore.ts:1353-1359 sends neither. I grepped all of app/src — `force` and `noPrune` appear in no images.action call site. CORRECTED on impact and severity. The sub-claim that in-use multi-tag images can never be untagged is structurally true but I measured its blast radius on this daemon: there is exactly ONE multi-tag image (ollama/ollama:0.32.5 + :latest) and it is not in use, so ZERO rows are currently blo</sub>

---

#### Images header summary reports the same double-counted total, drops the reclaimable byte figure in host mode, and renders unrounded floats

`correctness` · `defect` · effort: small

**Impact.** The one aggregate a user sees above the image table overstates on-disk usage by 2.3x. "listed" is a hedge but nothing explains that the figure is a sum of overlapping layer sets, and below 1 GB the string shows raw float noise.

**Evidence.**
- app/src/store/useAnchorageStore.ts:1254-1265 — `totalMb` and `reclaimableMb` sum `image.sizeMb` over unique image IDs
- app/src/store/useAnchorageStore.ts:123 — `sizeMb: image.sizeBytes / 1_000_000`
- app/src/store/useAnchorageStore.ts:1266-1273 — `totalMb >= 1000 ? (totalMb/1000).toFixed(2)+" GB" : `${totalMb} MB`` — no rounding on the MB branch
- app/src/store/useAnchorageStore.ts:1274-1279 — host branch returns `"N images · X listed size · N unused"`; `reclaimableMb` is computed and thrown away
- app/src/store/useAnchorageStore.ts:61-70 — `formatBytes` uses 1024^n, so the row SIZE column and the header total use different unit bases
- app/src/screens/ImagesScreen.tsx:231 — `{store.imageSummary}` is the sole header line

**Fix.** Feed the header from the corrected snapshot aggregate (`imageUsage.totalSize` / `imageUsage.reclaimable`) rather than re-deriving from the projection, and round the MB branch. Use one unit base across the row SIZE column and the header.

<sub>Verifier (CONFIRMED): useAnchorageStore.ts:1254-1281 verified line for line: totalMb sums `sizeMb` (= sizeBytes / 1_000_000, line 123) across unique image IDs; the host-mode branch at 1274-1279 emits only counts and discards `reclaimableMb` computed at 1262-1265; ImagesScreen.tsx:231 is the sole consumer. My replay gives "231 images · 164.36 GB listed size · 169 unused" against `docker system df`'s 71.24 GB / 9.336 GB. Added two defects the surveyor missed in the same block: `${totalMb} MB` at line 1269 and `${reclaimableMb} MB` at line 1273 are unrounded floats for anything under 1000 MB (a 62.1 MB image renders a</sub>

---

#### `docker image prune -a` and the until/label prune filters are validated and allowlisted end-to-end but have no UI

`parity-gap` · `core-only-not-wired` · effort: small

**Impact.** Time- and label-scoped pruning and all-unused pruning have complete, validated, sandbox-allowlisted core support and zero UI. Users can only clear dangling layers from the GUI.

**Evidence.**
- app/src/store/useAnchorageStore.ts:1309-1314 — the only prune call site: `filters: { dangling: ["true"] }`
- core/internal/core/domain.go:1337-1339 — `validateFilters(params.Filters, map[string]bool{"dangling": true, "until": true, "label": true, "label!": true})`
- core/internal/core/domain.go:1124-1133 — CLI fallback maps `dangling=false` → `--all`, other keys → `--filter k=v`
- core/internal/core/domain.go:978 — Engine path: `"/images/prune?" + encodedFilters(params.Filters)`
- app/electron/contracts.mjs:131 — `IMAGE_PRUNE_FILTERS = new Set(["dangling", "until", "label", "label!"])`
- app/src/screens/ImagesScreen.tsx:243-250 — one "Clean up" button, no options

**Fix.** Add prune options to the Clean up flow (dangling-only vs all-unused, plus until/label) bound to the already-allowed filter keys, and show the equivalent `docker image prune` argv in the confirmation so the two modes stay visibly distinct, as docs/architecture.md:192-193 requires.

<sub>Verifier (CORRECTED): Every citation is real. useAnchorageStore.ts:1309-1314 hardcodes `filters: { dangling: ["true"] }` and is the only images prune producer in app/src. domain.go:1337-1339 allows dangling/until/label/label!, domain.go:1124-1133 translates `dangling=false` into `--all` and other keys into `--filter k=v`, domain.go:978 passes filters straight to `/images/prune`, contracts.mjs:131 allowlists the same four keys. ImagesScreen.tsx:243-250 is a single option-less Clean up button. CORRECTED on severity only: `docker image prune -a` is a full literal-argv route in Command Center and is already classified </sub>

---

#### Builds screen is fixture-only in host mode; no build, builder, or build-cache surface exists

`parity-gap` · `fixture-only` · effort: large

**Impact.** Build has no first-class surface. The UnsupportedSurface message is accurate for build *history* (no Engine API exists) but conflates it with build *cache*, which does have one (`POST /build/prune`, `GET /system/df`). On a BuildKit host the cache records already reach the renderer and are reduced to a count.

**Evidence.**
- app/src/screens/BuildsScreen.tsx:5-16 — `if (store.isHost) return <UnsupportedSurface title="Builds" commandQuery="build" .../>`
- app/src/screens/BuildsScreen.tsx:17-99 and app/src/data/fixtures.ts:442 — the entire real screen is BUILD_STEP_FIXTURES, browser mode only
- protocol/types.ts:492-503 — `BuildCacheUsage { id, parent, parents, type, description, inUse, shared, sizeBytes, createdAt, lastUsedAt, usageCount }`
- core/internal/core/domain.go:209-215 — parsed from `/system/df` and delivered on every system.snapshot
- app/src/screens/DashboardScreen.tsx:139-142 — the only consumer: `bytes: snapshot.diskUsage.builderSizeBytes`, `detail: ${...buildCache.length} cache records`
- protocol/v1.schema.json — enumerated methods are health, system.capabilities, system.snapshot, containers.{list,inspect,stats,action}, images.{list,action}, volumes.{list,action}, cli.run, session.*; no build/builder/buildx method

**Fix.** Split the claims: keep the UnsupportedSurface message for build history, and render `diskUsage.buildCache` as a real table when non-empty. Add a `build.prune` method mapping to `POST /build/prune`, mirroring the existing images/volumes prune shape.

<sub>Verifier (CORRECTED): BuildsScreen.tsx:5-16 confirmed — host mode returns `UnsupportedSurface` with `commandQuery="build"`, everything from line 17 renders BUILD_STEP_FIXTURES (fixtures.ts:442). protocol/types.ts:492-503 BuildCacheUsage confirmed; domain.go:209-215 parses those records from /system/df; DashboardScreen.tsx:139-142 consumes only `buildCache.length` and `builderSizeBytes`. The schema method list contains no build/builder/buildx method. CORRECTED because the surveyor's central premise — 'live build-cache records already arrive, enough to render a real cache table' — does not hold on a machine like this</sub>

---

#### Registry Search tab is fixture-only; in host mode it silently becomes a pull box while keeping the "Registry search" label

`parity-gap` · `fixture-only` · effort: medium

**Impact.** A reviewer running the packaged app sees a tab labelled "Registry search" that cannot search. Docker Hub discovery is absent from the product, while the browser-mode screenshots used for design QA show a search experience that does not ship.

**Evidence.**
- app/src/screens/ImagesScreen.tsx:81-142 — the entire host branch of `RegistrySearch` renders "Pull from a registry"; no search occurs
- app/src/screens/ImagesScreen.tsx:144-211 — the search-results UI (stars, pulls, OFFICIAL badge) renders only in the non-host branch
- app/src/store/useAnchorageStore.ts:1242-1243 — `const registryResults = useMemo(() => { if (isHost) return [];`
- app/src/data/fixtures.ts:282 — `export const REGISTRY_FIXTURES: RegistryImage[] = [` — hand-written entries with fabricated star and pull counts
- app/src/screens/ImagesScreen.tsx:273-283 — the tab button still reads "Registry search" in host mode
- protocol/v1.schema.json — no `search` method; `docker --help` lists `search  Search Docker Hub for images` as a Common Command

**Fix.** Rename the host-mode tab to "Pull" (it is a pull surface). Either add a real `images.search` method or delete the fixture search UI so design QA stops validating a non-feature.

<sub>Verifier (CORRECTED): All citations verified: ImagesScreen.tsx:81-142 is the host branch ("Pull from a registry", reference input, Pull button, no search), 144-211 is the fixture search UI with stars/pulls/OFFICIAL, useAnchorageStore.ts:1242-1243 `if (isHost) return [];`, fixtures.ts:282 REGISTRY_FIXTURES, ImagesScreen.tsx:273-283 the tab still reads "Registry search" in host mode, and there is no `search` method in v1.schema.json. CORRECTED on severity: this is a mislabelled tab plus a missing discovery verb, not a broken core workflow — pulling by reference works, and `docker search` is available via Command Cent</sub>

---

#### Image pull accepts only a bare reference (no --platform / --all-tags) and cannot be cancelled from the UI

`parity-gap` · `absent` · effort: small

**Impact.** On a multi-arch host, pulling a specific platform variant is impossible from the GUI. A 10 GB pull started by mistake cannot be stopped from the Images screen — the user must close the app or start a second pull to trigger the cleanup path. Command Center, which does have a Cancel button, cannot see this session.

**Evidence.**
- protocol/types.ts:133-142 — pull variant fields: reference, cwd, timeoutSeconds, outputWindowBytes, maxOutputBytes; no platform, no allTags, no quiet
- core/internal/core/domain.go:1061-1062 — `Argv: []string{"image", "pull", params.Reference}`
- core/internal/core/domain.go:1353-1354 — `if params.ID != "" \|\| params.Force \|\| params.NoPrune \|\| len(params.Filters) > 0 \|\| params.Confirmed { return opError("invalid_action_options", ...) }`
- app/src/screens/ImagesScreen.tsx:115-122 — Pull button `disabled={!reference \|\| running}`; no Cancel anywhere on the screen
- app/src/store/useAnchorageStore.ts:264 — `const [imagePull, setImagePull] = useState<{...}>` carries no sessionId
- app/src/store/useAnchorageStore.ts:1390 and 589-593 — the only `sessions.cancel` path fires on next-pull-start or store-effect teardown

**Fix.** Add `platform` and `allTags` to the pull params, append the corresponding argv at domain.go:1061-1062, and relax the validator at 1353-1354. Expose the pull session id on the `imagePull` state so the Images screen can render a Cancel that calls `sessions.cancel`.

<sub>Verifier (CONFIRMED): protocol/types.ts:133-142 — the pull variant carries reference, cwd, timeoutSeconds, outputWindowBytes, maxOutputBytes only. domain.go:1061-1062 — `Argv: []string{"image", "pull", params.Reference}`, fixed. domain.go:1353-1354 — validateImagesAction actively rejects any other option on pull. ImagesScreen.tsx:115-122 — Pull button disabled while running, no Cancel control on the screen; grep of ImagesScreen/store finds no cancelPull. useAnchorageStore.ts:264 — the `imagePull` state object has reference/status/output/error and no sessionId, so the id is never exposed. useAnchorageStore.ts:1390 a</sub>

---

#### buildx / scout / compose / checkpoint capability status is probed by core and stripped by the bridge before any screen could read it

`parity-gap` · `core-only-not-wired` · effort: small

**Impact.** Anchorage discovers whether buildx, scout, compose and checkpoint are installed, at what version, and why not — and throws all of it away at the bridge. There is nowhere in the app to see "buildx: unavailable". BuildsScreen instead shows a hardcoded "unavailable in this build", conflating "Docker Desktop-only" with "plugin not installed", which have completely different remedies.

**Evidence.**
- core/internal/core/discovery.go:163-166 — `for _, name := range []string{"compose", "scout", "buildx"} { result.Capabilities[name] = s.probePluginCapability(...) }` plus `result.Capabilities["checkpoint"]`
- core/internal/core/discovery.go:685-700 — probePluginCapability returns `CapabilityStatus{Name, Status, Reason, Transports, Evidence}`
- protocol/types.ts:386-393, 411 — `CapabilityStatus { name, status, version, reason, transports, evidence, metadata }` and `capabilities: Record<..., CapabilityStatus>` on SystemCapabilitiesResult
- app/src/services/anchorageBridge.ts:333-360 — `normalizeCapabilities` returns only `{protocolVersion, selectedContext, currentContext, contexts, commandInventory, warnings, observedAt}`; capabilities/plugins/versions/binary/apiMin/apiMax/serverExperimental/evidence are dropped
- app/src/types.ts:551-559 — the renderer's `SystemCapabilities` interface does not declare `capabilities`, `plugins`, or `versions`
- app/src/screens/SettingsScreen.tsx (508 lines) — zero matches for capabilit/scout/buildx/compose

**Fix.** Extend `SystemCapabilities` in app/src/types.ts and pass `capabilities`, `plugins` and `versions` through `normalizeCapabilities`. Render the capability map (name, status, version, reason) in Settings, and have the Builds/Scout unsupported surfaces quote the actual probe reason.

<sub>Verifier (CORRECTED): The core half is confirmed: discovery.go:163-166 probes compose, scout, buildx plus checkpoint; discovery.go:685-700 `probePluginCapability` returns a CapabilityStatus with status/reason/evidence; protocol/types.ts:386-393 and 411 define the shape. The surveyor said no screen reads it — CORRECTED to something stronger and more actionable: the data never reaches the renderer at all. `normalizeCapabilities` (anchorageBridge.ts:333-360) reconstructs the object from scratch and returns only protocolVersion, selectedContext, currentContext, contexts, commandInventory, warnings, observedAt — droppin</sub>

---

#### Global search advertises images and volumes but only filters containers, and navigates away from the Images screen on every keystroke

`ux` · `defect` · effort: small

**Impact.** Typing into a box that claims to search images navigates the user off the Images screen to Containers. Combined with the 232-row dangling-inflated list and the absence of a per-screen filter, there is no way at all to locate an image by name in the UI.

**Evidence.**
- app/src/components/Shell.tsx:180 — screen-reader label "Search containers, images, and volumes"
- app/src/components/Shell.tsx:194 — `placeholder="Search containers, images, volumes…"`
- app/src/store/useAnchorageStore.ts:666-670 — `setSearch` calls `setSearchValue(value); setView("containers"); setSelectedId(null);`
- app/src/store/useAnchorageStore.ts:1177,1191 — the `search` value is consumed only by `filteredContainers`; no other reader in the store
- app/src/screens/ImagesScreen.tsx:214-293 — no filter input on the Images screen

**Fix.** Scope search per view — filter images when `view === "images"` instead of forcing a jump — or correct the label and add a dedicated filter box to the Images and Volumes screens.

<sub>Verifier (CONFIRMED): Shell.tsx:180 `Search containers, images, and volumes` (sr-only label) and Shell.tsx:194 `placeholder="Search containers, images, volumes…"` both verified. useAnchorageStore.ts:666-670 `setSearch` calls `setView("containers")` and `setSelectedId(null)` unconditionally. Grep of the store for the `search` value shows exactly two consumers: line 1177 `const query = search.trim().toLocaleLowerCase();` inside filteredContainers, and its dependency array at 1191 — nothing else. ImagesScreen has no filter input of its own. All confirmed.</sub>

---

#### Packaged build silently falls back to fabricated Docker data when the preload bridge is missing

`correctness` · `defect` · effort: medium

**Impact.** If contextBridge exposure fails on a user's machine (corrupt asar, preload load error), the packaged desktop app does not error — it renders CONTAINER_FIXTURES as the user's real containers, with a fake interactive shell, fake bind mounts and a fake update banner. Nothing in the UI distinguishes the two modes.

**Evidence.**
- app/src/services/anchorageBridge.ts:1106-1111 — `createAnchorageBridge()` returns `createHostBridge(window.anchorage)` only if `window.anchorage` is truthy, otherwise `new FixtureBridge()`. No build-mode, app.isPackaged, or Electron probe.
- app/src/store/useAnchorageStore.ts:204-206 — the whole host/browser split derives from that one probe (`isHost = bridge.mode === "host"`).
- Verified in the shipped bundle: `grep -c acme-platform app/dist/client/assets/index-CH9rkaSt.js` = 1, `grep -c 'Logs Explorer'` = 2, and the string 'faster BuildKit cache' is present. The 396,644-byte production chunk contains the fixture corpus and FixtureBridge.
- app/src/components/Shell.tsx:238-259 — fixture mode renders a fabricated update banner ("Anchorage 4.32.0 is available…").
- app/src/screens/ContainerDetailScreen.tsx:32-50 hardcoded mounts (core_pgdata, /home/dev/acme/platform/src); :414-455 `commandOutput()` is a fake shell answering ls/ps aux/df -h/cat /etc/os-release with invented output.
- Mitigation found by verifier: app/electron/main.mjs:427-470 packaged smoke asserts all 24 bridge methods are functions and fails the build otherwise — but only on the build machine, never at user runtime.

**Fix.** Gate FixtureBridge behind `import.meta.env.DEV` or an explicit `?fixtures` query param so Rollup dead-code-eliminates data/fixtures.ts, data/commandFixtures.ts and the FixtureBridge class out of the packaged chunk; in the packaged build a missing `window.anchorage` must render a hard failure state.

<sub>Verifier (CORRECTED): Code path confirmed exactly. I additionally confirmed the fixture corpus really is in the shipped chunk (grep of app/dist/client/assets/index-CH9rkaSt.js finds 'acme-platform' and 'faster BuildKit cache'). Severity corrected critical -> medium: the trigger requires contextBridge exposure to fail at runtime, and app/electron/main.mjs:402-470 (packaged smoke) asserts every bridge method is a function at package time, so a structurally broken preload is caught before release. What remains true and unmitigated is that there is NO runtime guard: if window.anchorage is absent for any reason in a shi</sub>

---

#### Any container reconciliation event permanently blanks the Inspect and Bind-mounts tabs

`correctness` · `defect` · effort: small

**Impact.** Restart or Stop a container from its own detail view, then open Inspect or Bind mounts: both show "Loading inspect data" / "Loading mounts" indefinitely. Nothing re-fetches. The user must navigate back to the list and re-click the row. The wipe is also global — mutating container A blanks the cached inspect for every other container.

**Evidence.**
- app/src/store/useAnchorageStore.ts:571-577 — on `event.payload.domain === "container"` the store calls `setInspectByContainer({})` and `setStatsByContainer({})`, wiping every container's entry.
- app/src/store/useAnchorageStore.ts:688-695 — `bridge.containers.inspect(...)` is called from exactly one site, inside `selectContainer`, guarded by `isHost && !inspectByContainer[id]`; grep confirms no other call site in app/src outside the bridge plumbing and tests.
- core/internal/core/engine.go:374-394 — reconciliation.requested/required are emitted from `emitCompletion` inside `containersAction`, i.e. only after Anchorage's own mutation. `grep -rn reconciliation core/` finds no other emitter and no docker-events watcher.
- app/src/screens/ContainerDetailScreen.tsx:174-186 — the detail header carries Stop / Restart / Delete buttons, so the wipe is one click away while the Inspect tab is open.
- app/src/screens/ContainerDetailScreen.tsx:293-300 renders "Loading inspect data" and :371-378 renders "Loading mounts" while `store.selectedInspect` is null.
- app/src/store/useAnchorageStore.ts:1881-1884 — `selectedInspect` reads straight out of the wiped map.

**Fix.** Scope the invalidation to `event.payload.resourceId` instead of clearing the whole map, and add an effect that re-fetches inspect whenever the detail view is mounted with `selectedInspect === null`, rather than relying solely on the click handler.

<sub>Verifier (CORRECTED): The cache wipe and the absence of any re-fetch are CONFIRMED. The stated trigger is REFUTED: the Go core has no `docker events` watcher. `grep -rn reconciliation core/` shows reconciliation events are emitted only from core/internal/core/engine.go:386,391 (containers.action completion) and core/internal/core/domain.go:1054,1552 (images/volumes actions). An external `docker run`, a healthcheck transition, or another container starting produces NO event. Real trigger: the user performs a Stop/Restart/Delete through Anchorage itself. Still one-click reachable from the detail header. Severity high</sub>

---

#### No selector/subscription split: every store change re-renders the entire application tree

`performance` · `absent` · effort: large

**Impact.** Idle cost is small (~2 full-tree renders/s of a few ms). The material costs are typing in global search on a large host (full-tree render plus an O(n) allocating filter per keystroke) and the streaming paths (log follow, image pull) which push the same full-tree render at chunk rate.

**Evidence.**
- app/src/store/useAnchorageStore.ts:1853-1950 — a fresh 93-key object literal returned every render, fed by 43 useState and 32 useCallback; identity never stable.
- app/src/App.tsx:16-56 — `useAnchorageStore()` called once, `store` passed to Shell and all nine screens.
- grep over app/src for React.memo / memo( / createContext / useContext / useSyncExternalStore / useDeferredValue / useTransition returns zero hits (verified).
- app/src/store/useAnchorageStore.ts:656-659 — 1 Hz `setClock`; its only consumer is `<time>{store.clock}</time>` at app/src/components/Shell.tsx:376.
- Measured by verifier (node, this machine): 20,000 iterations of `new Intl.DateTimeFormat(...).format(new Date())` = 51.43 us/call vs 1.23 us/call with a hoisted formatter.
- app/src/store/useAnchorageStore.ts:1176-1191 — `filteredContainers` allocates a joined lowercased string per container on every keystroke; app/src/components/Shell.tsx:182-197 -> store:666-670 has no debounce and no `useDeferredValue`.

**Fix.** In payoff order: (1) hoist the Intl.DateTimeFormat to module scope; (2) move `clock` into a self-contained <StatusClock/> leaf; (3) debounce or `useDeferredValue` the search input and precompute a lowercased search key per container at normalization time; (4) split the store into a memoized stable actions object plus a useSyncExternalStore-backed state source and wrap Shell/Sidebar/row components in React.memo.

<sub>Verifier (CORRECTED): The architecture claim is fully CONFIRMED: `grep -rn 'React.memo\|memo\(\|createContext\|useContext\|useSyncExternalStore\|useDeferredValue\|useTransition' app/src` returns ZERO hits, the store returns a fresh 93-key literal, and App threads it into Shell plus every screen. But the magnitudes are overstated and I corrected them. (a) The clock's Intl cost: I measured 51.4 us per construct+format vs 1.23 us hoisted (41.7x) on this machine — at 1 Hz that is 51 us/s, i.e. genuinely irrelevant; the clock's real cost is the full-tree render, not the formatter. (b) The idle full-tree render with <=20</sub>

---

#### A chatty container's log stream re-renders the whole app per chunk and constructs an Intl formatter per log line

`performance` · `defect` · effort: medium

**Impact.** A chatty container drives a full-tree React re-render plus a forced reflow per 16 KiB chunk, re-rendering 200 `.log-line` divs each time. The UI (including navigation and the Command Center) becomes sluggish while the Logs tab is open; it degrades progressively rather than locking up.

**Evidence.**
- app/src/store/useAnchorageStore.ts:1040-1061 — `appendText` calls `setLogsByContainer` once per chunk, allocating `{...current}` plus a 500-element array copy; no rAF/microtask coalescing anywhere in the path.
- app/src/store/useAnchorageStore.ts:1044-1053 — `formatClock()` per line, and `formatClock` (:53-59) constructs a new Intl.DateTimeFormat each call; two regex tests per line on top.
- app/src/store/useAnchorageStore.ts:1223-1235 — `visibleLogs` re-filters up to 500 lines and re-slices to 200 on every store render.
- app/src/screens/ContainerDetailScreen.tsx:215-219 — `useEffect(…, [store.followLogs, store.visibleLogs])` writes `scrollTop = scrollHeight`, forcing a synchronous layout whenever the memo identity changes.
- app/src/store/useAnchorageStore.ts:222-224 — `logsByContainer` is global store state, so each chunk re-renders App/Shell/Sidebar/screen, not just the log panel.
- Bound found by verifier: store:1111 requests `outputWindowBytes: 64*1024`, core/internal/core/session.go:24 chunks at 16 KiB, and store:1065-1069 issues one ack RPC per event — so at most 4 unacked chunks exist at a time.

**Fix.** Buffer incoming lines in a ref and flush once per animation frame, hoist the Intl.DateTimeFormat to module scope, move `logsByContainer` out of the global store into the logs panel's own state, and only write scrollTop when the user is actually pinned to the bottom.

<sub>Verifier (CORRECTED): Every code claim CONFIRMED and the Intl measurement independently reproduced (51.4 us per construct+format, 41.7x a hoisted formatter). Severity high -> medium because throughput is bounded: the log session requests a 64 KiB ack window (store:1111) with 16 KiB chunks (session.go:24), so only 4 chunks can be in flight and each requires a renderer->main->core ack round trip. The path self-throttles rather than hard-locking; the '57 ms/s at 1,000 lines/s' figure is right in principle but 1,000 lines/s through this ack path is optimistic. The forced synchronous layout per chunk and the full-tree r</sub>

---

#### Followed log lines can collide on duplicate React keys

`correctness` · `defect` · effort: trivial

**Impact.** React sees duplicate keys in the log list: it warns and reconciles incorrectly, so log rows can render stale text or be dropped — in exactly the view the log viewer exists for.

**Evidence.**
- app/src/store/useAnchorageStore.ts:1044-1046 — `id: `${selectedContainer.id}-follow-${Date.now()}-${index}`` — wall-clock millisecond plus the index within the current chunk, which restarts at 0 for each chunk.
- app/src/store/useAnchorageStore.ts:1133-1137 — buffered pending events are flushed synchronously in one loop, guaranteeing identical `Date.now()` across chunks.
- app/src/screens/ContainerDetailScreen.tsx:260-268 — those ids are used directly as React keys.
- app/src/store/useAnchorageStore.ts:696-711 — the only dedupe pass lives in `selectContainer`'s initial merge, not in the follow path.

**Fix.** Use a monotonically increasing counter ref, or the session sequence already on `event.payload.sequence`, as the line id instead of `Date.now()`.

<sub>Verifier (CONFIRMED): Confirmed, and I found a stronger reachability path than the surveyor gave: at session start the buffered pending events are flushed in a synchronous `buffered.filter(...).forEach(accept)` loop (store:1133-1137), so every buffered chunk is processed within the same millisecond and every one of them restarts its line index at 0. Duplicate ids are therefore near-certain, not merely possible, whenever more than one chunk arrives before `sessions.start` resolves. The same happens for multiple ipcRenderer events delivered in one tick.</sub>

---

#### Command Center copies an 800-element ring and re-renders the whole dialog per output chunk, for a value that is not rendered when xterm loads

`performance` · `defect` · effort: small

**Impact.** A verbose command (compose up --build, pull, buildx build) drives one full-dialog re-render plus an 800-element array copy per chunk, none of which affects what the user sees because xterm owns rendering. In the JSDOM/fallback path the `<pre>` re-concatenates up to 1 MiB of text per render.

**Evidence.**
- app/src/components/CommandCenter.tsx:412-434 — `appendOutput` ends with `setOutputChunks([...outputRingRef.current])`, a full ring copy per chunk.
- app/src/components/CommandCenter.tsx:68-69 — MAX_RENDERER_OUTPUT_CHUNKS = 800, MAX_RENDERER_OUTPUT_BYTES = 1,048,576.
- app/src/components/CommandCenter.tsx:426-428 — once saturated, `setLocalDroppedBytes` fires on every chunk as a second state update.
- app/src/components/CommandCenter.tsx:1303-1304 and :227-234 — `chunks` is only rendered when `fallback` is true; :138-173 keeps `fallback` false on the xterm path.
- app/src/components/CommandCenter.tsx:331-333 and :984-1004 — up to 100 `commandResults` buttons re-render on each of those renders, with no memo boundary.
- app/src/components/CommandCenter.tsx:483-501 — `appendOutput` is called synchronously from the sessions subscription; there is no rAF or interval coalescing.

**Fix.** Stop mirroring the ring into React state on the xterm path — keep it in the ref and expose it through a getter used only by the fallback transcript, or flush `setOutputChunks` on a rAF/250 ms timer.

<sub>Verifier (CONFIRMED): Verified in full. `outputChunks` reaches the DOM only through `TerminalSurface`'s `{fallback && <pre>{chunks.map(c=>c.text).join('')}</pre>}` (CommandCenter.tsx:227-234) and `fallback` stays false whenever xterm loads (:138-173), so in the real host path the state is 100% dead weight. `commandResults` is memoized on [availableCommands, query] so the search is not recomputed, but the up-to-100 result buttons have no memo boundary and do re-render on every chunk. Blast radius is correctly stated as the dialog, not the whole app (outputChunks is component-local state).</sub>

---

#### Image pull output is store state: every progress chunk allocates a 64 KiB string and re-renders the whole app, with raw ANSI dumped into a <pre>

`performance` · `defect` · effort: small

**Impact.** A `docker pull` streams progress several times per second per layer; each update costs a 64 KiB allocation plus a full-tree render, and the pane shows escape sequences as literal garbage rather than a progress display.

**Evidence.**
- app/src/store/useAnchorageStore.ts:1398-1408 — per chunk: `setImagePull(current => ({...current, status:"running", output: `${current.output}${text}`.slice(-64*1024)}))`, a new up-to-64 KiB string each time.
- app/src/store/useAnchorageStore.ts:264-269 and :1893 — `imagePull` is global store state, so each chunk re-renders App/Shell/Sidebar/ImagesScreen.
- app/src/screens/ImagesScreen.tsx:137 — `<pre>{store.imagePull.output \|\| "Waiting for registry output…"}</pre>` re-renders the entire buffer as one text node per chunk with no ANSI handling.
- app/src/screens/ContainerDetailScreen.tsx:565-567 — the exec panel uses the same string-append pattern but in component-local state, confining its re-render.

**Fix.** Move pull output into the Images screen's own state (or a ref with a rAF flush) and either strip ANSI or render it through the xterm surface the Command Center already lazy-loads.

<sub>Verifier (CONFIRMED): All four code claims verified, including the instructive contrast with ContainerDetailScreen.tsx:565-567 which uses the identical append pattern in component-local state. The ANSI point is real: `docker pull` emits cursor-movement sequences that a plain <pre> renders as literal garbage, and no stripping exists anywhere in app/src.</sub>

---

#### The Volumes list is not virtualized despite the documented guarantee

`performance` · `absent` · effort: trivial

**Impact.** A host with thousands of volumes (routine on CI machines and heavy Compose users) renders tens of thousands of DOM elements and re-renders all of them twice a second. The release gate that claims bounded DOM size does not cover this screen.

**Evidence.**
- app/src/screens/VolumesScreen.tsx:63-97 — `{store.volumes.map((volume) => …)}` renders every volume; FixedRowWindow is not imported in this file.
- app/src/screens/ContainersScreen.tsx:206-216 and app/src/screens/ImagesScreen.tsx:21-75 both do use FixedRowWindow.
- docs/architecture.md:52 — "Large lists are virtualized and keyed by immutable Docker IDs."
- docs/parity-and-release-gates.md:186-187 — "Renderer tests separately prove bounded DOM size with 10,000-row fixtures"; app/src/components/FixedRowWindow.test.tsx:16-60 and app/src/HostApp.test.tsx:322-353 only exercise containers and images, never volumes.
- This host has 237 volumes; each row is 6 spans plus a delete button with an SVG icon (VolumesScreen.tsx:65-96), and the whole list re-renders on every 1 Hz clock tick because it consumes `store`.

**Fix.** Wrap the volume rows in FixedRowWindow with `rowHeight` matching the `.volume-row` CSS height and `keyFor={(v) => v.name}`, mirroring ImagesScreen, and extend the 10k-row DOM test to cover it.

<sub>Verifier (CONFIRMED): Confirmed as stated, including the documentation and release-gate mismatch. Verified the gate tests cover only ContainersScreen and ImagesScreen.</sub>

---

#### Virtualized rows expose no ARIA size/position information to assistive technology and are unreachable by keyboard

`accessibility` · `defect` · effort: medium

**Impact.** On a host above 200 containers, a screen-reader user is told there are ~28 buttons with no total or position, and a keyboard-only user can tab through the 28 rendered rows and then straight out of the list — the remainder are unreachable without a mouse.

**Evidence.**
- app/src/components/FixedRowWindow.tsx:99-125 — the virtualized host is a bare `<div>` with `data-virtualized`; no role, aria-rowcount, aria-setsize, aria-posinset or aria-label on any wrapper.
- app/src/screens/ContainersScreen.tsx:196 — `<div className="container-table__head" role="row">` with no ancestor `role="grid"`/`role="table"`, so the row role is orphaned.
- app/src/screens/ContainersScreen.tsx:98-112 — each row is `role="button" tabIndex={0}` with an Enter/Space handler, so rows are in the tab order.
- app/src/components/FixedRowWindow.tsx:117-121 — only `items.slice(windowRange.start, windowRange.end)` exists in the DOM; nothing scrolls the window on focus movement.
- app/src/screens/ImagesScreen.tsx:21-75 — same gap on the images window.
- Scope: below 200 items FixedRowWindow renders every row (:87-97), so the defect is specific to large hosts.

**Fix.** Give the window `role="grid"` + `aria-rowcount={items.length}`, give each row `aria-rowindex`/`aria-posinset` + `aria-setsize`, implement roving-tabindex arrow navigation, and scroll the window to bring the focused index into range.

<sub>Verifier (CONFIRMED): Confirmed as stated, with one scope note the finding omits: this only bites above the 200-item virtualization threshold. Below it every row is in the DOM and reachable by Tab. Above it, only the ~28 windowed rows exist and nothing scrolls the window in response to focus, so the rest are genuinely unreachable without a pointer. The orphaned `role="row"` is real.</sub>

---

#### volumes.list pays a full volume disk-usage scan on every call and is polled every 10 s

`performance` · `defect` · effort: small

**Impact.** About 99% of volumes.list latency is the daemon-side usage walk. With the Volumes screen open the daemon spends roughly 10% of wall-clock time on disk-usage scanning, slowing every other Docker client on the machine.

**Evidence.**
- core/internal/core/domain.go:788-794 — volumesList always follows the /volumes call with GET /v<api>/system/df?type=volume; there is no flag or cache.
- app/src/store/useAnchorageStore.ts:627-639 — the Volumes screen re-lists on a 10,000 ms interval while visible.
- Measured by verifier: GET /v1.51/volumes not separately timed, GET /v1.51/system/df?type=volume = 1,022.5 ms / 91,947 B; core volumes.list = 1,040.7 ms first / 1,033.9 ms warm.

**Fix.** Return volumes immediately from /volumes and hydrate UsageData from a separately triggered, cached, user-visible "compute size" action (what `docker system df -v` is for). At minimum cache the usage map with a TTL far longer than the poll interval.

<sub>Verifier (CORRECTED): The code path is CONFIRMED — volumesList unconditionally follows GET /volumes with GET /system/df?type=volume. The magnitude is corrected by my own measurement: df?type=volume = 1,022 ms and the full core volumes.list = 1,034-1,041 ms on this host (237 volumes), not 3,083 ms / 1,518 ms. The structural point (~99% of the latency is the daemon usage walk) is exactly right; the duty cycle at the 10 s cadence is ~10%, not 15-30%. Severity high -> medium.</sub>

---

#### images.list issues two full /images/json requests with shared-size=true on every call

`performance` · `defect` · effort: small

**Impact.** Roughly 600-840 ms of daemon work every 10 s while the Images screen is open — about half attributable to shared-size computation the poll does not need, and half to a second query returning rows already present in the first.

**Evidence.**
- core/internal/core/domain.go:577-581 — the first request always sets shared-size=true.
- core/internal/core/domain.go:594-612 — a second full /images/json with filters={"dangling":["true"]} and shared-size=true whenever `!all && IncludeDangling`.
- app/src/services/anchorageBridge.ts:912 — the renderer always sends `{ context, all: false, includeDangling: true }`, so both requests always fire.
- app/src/store/useAnchorageStore.ts:627-639 — the Images screen re-lists every 10,000 ms.
- Measured by verifier: /v1.51/images/json?all=false = 230 ms; &shared-size=true = 416 ms; the dangling-filtered variant = 421 ms / 57,581 B; core images.list = 620.3 ms first / 596.4 ms warm, 597 KB result.

**Fix.** Drop shared-size=true from the polling path (compute it only when the user opens size details) and derive dangling images from the single all=true response instead of issuing a second query.

<sub>Verifier (CONFIRMED): Confirmed and quantified. I also verified the second request always fires in the real app: app/src/services/anchorageBridge.ts:912 hardcodes `{ context, all: false, includeDangling: true }`, which is precisely the `!all && IncludeDangling` branch. Measured on this host (1,760 images): plain /images/json?all=false = 230 ms; with shared-size=true = 416 ms; the dangling-filtered second request = 421 ms; core images.list warm = 596-620 ms.</sub>

---

#### Session output and control responses share one unbuffered stdout pipe serialized by a single mutex (head-of-line blocking)

`performance` · `defect` · effort: medium

**Impact.** When the Electron main process falls behind, the 64 KiB OS pipe fills and the core blocks inside Write while holding writeMu, queueing control responses behind bulk session output for the duration of the main-loop stall. Bounded by the ack window, but it is exactly the path a `session.cancel` must traverse.

**Evidence.**
- core/internal/rpc/server.go:135-147 — write() marshals, appends '\n', then holds writeMu across a single s.output.Write for every message.
- core/cmd/anchorage-core/main.go:61 — output is raw os.Stdout: no bufio.Writer, no separate channel for bulk data.
- core/internal/rpc/server.go:121-126 — the emit callback used by sessions writes through the same locked path.
- core/internal/core/session.go:443-450 — every 16 KiB chunk becomes one session.output event on that path.
- app/electron/contracts.mjs:1074-1088 — main re-stringifies each event payload to measure its size, on the same event loop that drains the pipe.
- Bound found by verifier: core/internal/core/session.go:19 defaultOutputWindow = 256 KiB and app/src/store/useAnchorageStore.ts:1111 requests 64 KiB, so unacked output ahead of a control response is capped; `health` answered in 50 ms during the reproduced wedge.

**Fix.** Wrap stdout in a bufio.Writer with explicit flush points and decouple bulk session output from control responses (separate fd, or a bounded per-session outbound queue that coalesces rather than blocking the shared writer). At minimum, never let an event write block a response write.

<sub>Verifier (CORRECTED): The structure is CONFIRMED verbatim: one writeMu held across a single write to a raw os.Stdout, with session events emitted through the same path. But the unbounded-stall impact is overstated. The ack window bounds outstanding unacked output to 64 KiB for logs/pull and 256 KiB by default, so at most a handful of chunks can be queued ahead of a control response before the writer blocks on cond.Wait instead — and in my wedge repro the core answered `health` in 50 ms with three sessions blocked mid-write path. Head-of-line delay is therefore bounded by how long the Electron main loop is busy, not</sub>

---

#### Ack-window backpressure requires one full round-trip RPC per 16 KiB chunk, capping session throughput

`performance` · `defect` · effort: small

**Impact.** Effective session throughput is window/RTT-bounded, and every 16 KiB of log output also costs a React state update plus a full IPC round trip. The soak evidence proves correctness only at 13 KB/s, three orders of magnitude below the ceiling.

**Evidence.**
- core/internal/core/session.go:19,24 — defaultOutputWindow 256 KiB, outputChunkSize 16 KiB.
- app/src/store/useAnchorageStore.ts:1111 and :1486 — log-follow and image-pull sessions request a 64 KiB window, i.e. 4 in-flight chunks.
- app/src/store/useAnchorageStore.ts:1065-1069 and app/src/components/CommandCenter.tsx:634-653 — one `bridge.sessions.ack()` RPC per session.output event, with no batching or coalescing.
- app/electron/main.mjs:692-697 — each ack traverses IPC -> main -> core stdin as its own request.
- artifacts/performance/results.json streamingSoak.sessionOutput — 13,326 events and exactly 13,326 acknowledgements for 23,612,499 bytes over 1,800,001 ms, i.e. 7.4 events/s and 13 KB/s (verified by reading the artifact).

**Fix.** Coalesce acks (ack the highest observed sequence on a short timer rather than per event), raise the log-follow window so RTT is amortised over more bytes, and consider acking in the preload once a chunk is delivered so flow control is decoupled from React render timing.

<sub>Verifier (CONFIRMED): Confirmed exactly; I re-derived the soak numbers from artifacts/performance/results.json. This is also the mechanism that bounds the R5 and C6 impacts, which is worth stating: the ack-per-chunk design is simultaneously the throughput ceiling and the accidental safety valve.</sub>

---

#### Full help stdout/stderr is retained per inventory node and shipped in one RPC line; the client kills the core if any line exceeds 8 MiB

`performance` · `defect` · effort: small

**Impact.** The core can construct a legitimate response it cannot deliver, and the client's failure mode is killing the core (followed by supervised restart) rather than returning an error. Headroom is ~20x for capabilities on this host, but containers.list already emits 103 KB for 76 containers (~1.4 MB at 1,000) and the CLI inspect path has a 16 MiB producer limit against an 8 MiB consumer limit.

**Evidence.**
- core/internal/core/discovery.go:278,281 — every node stores commandEvidence(...) including full Stdout/Stderr strings.
- core/internal/core/command.go:24 — discoveryOutputLimit = 256 KiB each; command.go:230-244 CommandEvidence carries Stdout and Stderr as strings.
- Measured by verifier: system.capabilities response = 399,726 bytes with 250 "stdout" fields for 244 nodes.
- app/electron/jsonl-rpc.mjs:6,104-112 — a line over MAX_RPC_LINE_BYTES (8 MiB) emits RPC_LINE_TOO_LARGE, closes the RPC, and SIGTERMs the core.
- core/internal/core/engine.go:22 — the core buffers up to 64 MiB of Engine response, 8x the line the client accepts.
- Verifier addition: core/internal/core/domain.go:21 domainCLIOutputLimit = 16 MiB and :389,:410 containerInspectCLI returns that stdout verbatim as `Document` — a documented 16 MiB producer feeding an 8 MiB consumer.

**Fix.** Cap or omit per-node help evidence by default (return it only for a specifically requested node), align domainCLIOutputLimit with the transport limit, and enforce the 8 MiB budget inside the core's write path so an oversized result becomes a structured `response_too_large` error instead of a client-side kill.

<sub>Verifier (CONFIRMED): Confirmed and quantified: the capabilities response I captured contains 250 occurrences of the "stdout" field and is 399,726 bytes for 244 nodes. I found an additional, more concrete over-limit path the surveyor missed: core/internal/core/domain.go:21 sets domainCLIOutputLimit = 16 MiB and containerInspectCLI (:389, :410) returns that raw stdout as `Document`, so the core's own limit on that path is exactly 2x the 8 MiB line the client will accept. The failure mode is confirmed to be a SIGTERM of the core, not a structured error.</sub>

---

#### No ceiling on concurrent CLI sessions or on the docker subprocesses they spawn

`architecture` · `absent` · effort: small

**Impact.** A renderer loop or a user repeatedly opening the Command Center can create unbounded docker processes, pipes and goroutines in the core. Combined with the wedge defect, wedged sessions never leave the map at all. Nothing in the core enforces the bounded-resource story the docs claim.

**Evidence.**
- core/internal/core/session.go:102-212 — `start` never inspects len(m.sessions); :201-203 inserts unconditionally.
- core/internal/core/session.go:523-529 — exited sessions linger for a 5-minute tombstone, each with its own time.AfterFunc timer.
- core/internal/core/session.go:305-329 — each session holds 2 reader goroutines plus a waiter goroutine and 3 pipe fds.
- Reproduced by verifier: three wedged sessions took the core from 3 fds / 1 thread to 8 fds / 9 threads, and none of them ever left the manager map.

**Fix.** Add a configurable maximum concurrent session count (rejecting with a structured error past the limit) and an idle/no-ack watchdog that force-terminates sessions whose consumer has stopped acking for N seconds.

<sub>Verifier (CONFIRMED): Confirmed: sessionManager.start performs a dozen parameter validations and never once looks at len(m.sessions) before inserting. This is the amplifier for the wedged-session leak I reproduced — wedged sessions never leave the map because finish() (which schedules the 5-minute tombstone) is exactly the function the deadlock prevents from running.</sub>

---

#### Packaging pipeline never runs `npm ci`; dependency evidence binds lockfile bytes, not the installed dependency tree

`security` · `defect` · effort: small

**Impact.** The evidence proves the renderer bundle's output hash and Electron's input hash, but nothing about vite, esbuild, @vitejs/plugin-react, react/react-dom or the other ~500 installed packages that actually produce dist/client. A locally modified package under node_modules would leave package-lock.json byte-identical, pass every gate, and emit a renderer whose hash is then faithfully recorded as evidence.

**Evidence.**
- app/scripts/package-desktop.mjs:1311-1331 buildAndStage runs test:renderer, typecheck, test:protocol, test:security-evidence, test:package-evidence, test:electron, test:sites, go test -race, go vet and `npm run build`; `grep -rn 'npm ci' app/scripts tools` returns nothing.
- app/scripts/package-desktop.mjs:497-546 validateSources asserts ~35 required files exist but never lists app/package-lock.json and never compares node_modules against it.
- app/scripts/package-desktop.mjs:1268-1272 — the only lockfile binding is `assertCurrentFileHash(app/package-lock.json, dependencyAudit.evidence.packageLockSha256)`, i.e. the lockfile matches the one that was audited.
- Verified by verifier: app/package-lock.json has 513 package entries, all with integrity hashes and all `resolved` on registry.npmjs.org.
- tools/capture-host-candidate.mjs:44 and app/scripts/package-desktop.mjs:1449-1469 — the one build input bound to installed bytes is Electron itself.

**Fix.** Run `npm ci --ignore-scripts` as the first step of buildAndStage(), and record a hash over the installed tree (sorted name/version/integrity from `npm ls --all --json`, or a hash of node_modules/.package-lock.json) into artifacts/security/dependency-audit.json so the evidence binds what was installed, not just what was declared.

<sub>Verifier (CONFIRMED): Verified: `grep -rn 'npm ci\|npm install' app/scripts tools app/package.json` returns nothing at all. buildAndStage runs tests, typecheck, go test/vet and `npm run build`, but never reconciles node_modules against the lockfile. The lockfile itself is in good shape — 513 entries, all with integrity hashes, zero non-npmjs `resolved` URLs (verified) — which is exactly why the gap matters: the chain is tight everywhere except the one hop from declared to installed.</sub>

---

#### No Go toolchain or stdlib vulnerability gate, and the dependency audit covers zero shipped runtime code

`security` · `absent` · effort: small

**Impact.** The zero-vulnerability claim describes only build-time JavaScript tooling. The two things that execute on a user's machine are Chromium/Electron (which npm audit does not scan for Chromium CVEs) and the Go core, which nothing scans — and the Go core is the privileged component, parsing Docker Engine JSON over HTTP, handling PTY ioctls and managing process groups on stdlib net/http, encoding/json, os/exec and syscall.

**Evidence.**
- core/go.mod verified: `module anchorage/core` / blank / `go 1.25` — no toolchain directive, so any go1.25.x satisfies the build.
- `grep -rn govulncheck` across the repository (excluding node_modules) returns zero matches.
- app/scripts/package-desktop.mjs:1379-1381 only captures `go version` output and :1396 records it as `goToolchain` in the manifest; app/scripts/package-evidence-policy.mjs contains no assertion on that string.
- app/build/core/manifest.json records goToolchain "go version go1.25.5 linux/amd64" — recorded, never gated.
- app/scripts/package-desktop.mjs:1511-1520 fails the build if `/node_modules/` appears in the archive, confirming that none of the audited packages ship.
- docs/release-report.md:141 — "The dependency audit reported zero known vulnerabilities at every severity" — true, but scoped to build tooling only.

**Fix.** Add `govulncheck ./...` as a release gate in buildAndStage() and write its result into artifacts/security/ next to dependency-audit.json. Pin a minimum with a `toolchain go1.25.x` directive in core/go.mod and assert the recorded goToolchain meets it in package-evidence-policy.mjs. Reword docs/release-report.md:141 to scope the claim.

<sub>Verifier (CONFIRMED): Verified directly: core/go.mod is exactly three lines (`module anchorage/core`, blank, `go 1.25`) with no `toolchain` directive, and `grep -rn govulncheck` across the whole tree excluding node_modules returns nothing. The scoping point is also correct — the packaged app.asar contains no node_modules (package-desktop.mjs fails the build if `/node_modules/` appears in the archive), so none of the audited packages ship.</sub>

---

#### Shipped titlebar hardcodes version "4.31.2" in host mode while the product is 0.1.0

`correctness` · `defect` · effort: trivial

**Impact.** The shipped desktop application tells every user it is version 4.31.2. Bug reports, support triage and any user-side integrity check ('which build am I running?') are all misdirected, and the number implies a maturity the 0.1.0 release does not have. This is the single most visible false statement in the running product and it is one line.

**Evidence.**
- app/src/components/Shell.tsx:174-176 — `<span className="titlebar__version">4.31.2</span>` is rendered unconditionally by TitleBar; there is no `store.isHost` guard and no value read from package.json or the bridge.
- app/package.json — `"version": "0.1.0"`; app/electron-builder.yml artifactName produces Anchorage-0.1.0-x86_64.AppImage and the extracted anchorage.desktop carries `X-AppImage-Version=0.1.0` (verified).
- docs/release-report.md:10-17 documents the release as 0.1.0 with SHA-256 2ba863dd…
- The value is a leftover from the Docker Desktop-shaped fixture design (the fixture update banner at Shell.tsx:244-247 offers "Anchorage 4.32.0"), but unlike the banner it is NOT gated on `!store.isHost`.

**Fix.** Render the real version: expose `app.getVersion()` through the existing preload bridge (or inject `import.meta.env.VITE_APP_VERSION` from package.json at build time) and assert in the packaged smoke that the titlebar text matches the packaged package.json version.

---

#### Live log following never recovers after its session dies — no session.exited handling and the effect cannot re-run

`correctness` · `defect` · effort: small

**Impact.** After any core crash-and-restart, or any premature exit of `docker logs -f`, the Logs tab silently stops updating while still showing the Follow toggle as active and displaying stale lines. The user has no signal that live following has stopped; the only recovery is to navigate away and re-select the container or toggle Follow off and on.

**Evidence.**
- app/src/store/useAnchorageStore.ts:1062-1091 — the log-follow `accept()` handles only `session.output` and `session.error`. There is no `session.exited` branch, so the end of `docker logs -f` is silently ignored: no error is surfaced and no restart is attempted.
- app/src/store/useAnchorageStore.ts:1167-1174 — the effect's dependencies are [bridge, detailTab, followLogs, isHost, selectedContainer?.id, selectedContainer?.state]. `engineStatus` is deliberately absent, so a core restart does not re-run it.
- app/src/store/useAnchorageStore.ts:554-567 — a core crash produces `core.status` crashed/unavailable, which sets engineStatus to "disconnected"; app/src/App.tsx:18-21 then swaps to WorkspaceStateScreen, but `useAnchorageStore` lives in App and is never unmounted, so the log-follow effect survives with a session id that no longer exists in the restarted core.
- app/electron/core-supervisor.mjs:287-292 — the supervisor restarts the core with backoff; every session dies with the old process.
- Contrast: the store's stats sampler (:917-1024) re-polls unconditionally and therefore self-heals, which is why this asymmetry is easy to miss.

**Fix.** Handle `session.exited` in the follow path (surface it and clear the owner), and add `engineStatus` to the effect's dependency array (or key the effect on a session-generation counter bumped by `core.status: ready`) so following re-establishes after a core restart.

---

#### containers.list — the only 2 s hot-path read — has no core-side deadline

`correctness` · `defect` · effort: trivial

**Impact.** A stalled /containers/json read (hung daemon, wedged containerd, socket contention) leaks a goroutine plus an Engine connection permanently, with no timeout and no cancellation. It is precisely the method most likely to be executed while something is wrong, and it is the only read method without the deadline every sibling has — which reads as an oversight rather than a decision.

**Evidence.**
- core/internal/core/engine.go:200-255 — `containersList` uses the caller's ctx directly; there is no `context.WithTimeout` anywhere in the Engine-API path.
- Every other structured read does wrap: core/internal/core/domain.go:29 (snapshot), :231 (inspect), :422 (stats), :560 (images), :755 (volumes) all use `context.WithTimeout(parent, domainReadTimeout)`; even the CLI fallback for containers gets one at engine.go:300 (30 s).
- core/internal/rpc/server.go:88-96 — the ctx handed to the handler is the process signal context (core/cmd/anchorage-core/main.go:54,61), so with no per-request deadline there is nothing at all bounding the request.
- app/electron/main.mjs:610-612 — the renderer side gives up after 45 s and rejects locally; app/electron/jsonl-rpc.mjs:69-78 sends nothing to the core, so the goroutine and its unix connection are never released.
- app/src/store/useAnchorageStore.ts:615 — this is the method polled every 2,000 ms, i.e. the most-executed RPC in the product.

**Fix.** Wrap containersList in `context.WithTimeout(parent, domainReadTimeout)` for parity with domain.go, and land the per-request cancellation described in the core-perf finding so the client-side 45 s timeout actually stops the work.

---


### LOW (59)

#### Host image summary renders an unrounded float, e.g. '543.2500000000001 MB'

`ux` · `defect` · effort: trivial

**Impact.** Host mode only when total image size is under 1000 MB. Accumulated float error can render as e.g. "342.10000000000005 MB" in the Images header. Most real hosts exceed 1 GB and hit the `.toFixed(2)` GB branch, which is why this is low rather than medium.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1257-1270 — `totalMb` is a running float sum and the sub-1000 branch interpolates it raw: `` totalMb >= 1000 ? `${(totalMb / 1000).toFixed(2)} GB` : `${totalMb} MB` ``
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:123 — `sizeMb: image.sizeBytes / 1_000_000`, producing non-terminating binary fractions
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1273-1279 — the host branch embeds the raw string into `${uniqueImages.length} images · ${total} listed size · ${unused} unused`
- /home/soya/dev/tools/docker-ui/app/src/screens/ImagesScreen.tsx:231 — `{store.imageSummary}` rendered verbatim
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1269-1272 — `reclaimableMb` has the identical raw interpolation (browser mode only)
- A working `formatBytes` helper already exists at useAnchorageStore.ts:59-69

**Fix.** Reuse `formatBytes` for both branches, or at minimum `.toFixed(1)` the MB branch as the GB branch already does.

<sub>Verifier (CONFIRMED): Confirmed the code. Downgraded medium→low: the defect is only reachable below 1000 MB total image size, which is uncommon on a machine that runs Docker seriously, and the consequence is purely cosmetic.</sub>

---

#### Image pull session listener is never torn down on exit and the pull panel state is never cleared

`correctness` · `defect` · effort: trivial

**Impact.** Host mode. After a pull completes, one inert listener stays registered against a dead session id and the Images screen shows the finished pull's status and up to 64 KiB of retained output indefinitely with no way to dismiss it. The subscription leak is bounded at one, not one per pull.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1436-1452 — the `session.exited` branch sets the final status and calls `finish()` but never calls the `cleanup()` closure defined at 1458-1473
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1474 — `pullCleanupRef.current = cleanup`, so `unsubscribe()` runs only on the NEXT pull (line 1390 `pullCleanupRef.current?.()`) or on store unmount (line 589)
- `grep -n 'setImagePull(null)\\|dismissImagePull' app/src` → zero matches; `imagePull` is never reset
- /home/soya/dev/tools/docker-ui/app/src/screens/ImagesScreen.tsx:124-138 — the pull panel renders `store.imagePull` with no dismiss control
- BOUNDS THE LEAK: because line 1390 cleans up the previous pull before starting a new one, at most ONE stale listener exists at a time, and it filters on `owner` so it is inert

**Fix.** Call `cleanup()` inside the `session.exited` branch and add a dismiss action (or auto-clear `imagePull` once `finish()` resolves).

<sub>Verifier (CORRECTED): Confirmed the missing `cleanup()` call and the absent reset. CORRECTED the impact: the surveyor implied an unbounded listener accumulation; line 1390 caps it at one, and the stale listener does nothing because of the `owner` filter. The only real symptom is the undismissable stale panel, so severity stays low.</sub>

---

#### `--` separator disables pinned-target argv checks and Docker still honours `--host` after it

`security` · `defect` · effort: trivial

**Impact.** A user (or renderer) who types `--` followed by `--host=...` runs against a different daemon while the request is still labelled pinned. Because literal mode is freely selectable, no privilege is gained; the real cost is that a guard the code and docs present as an invariant does not hold, which erodes trust in the receipt's `targetMode` field even though the receipt's argv is accurate.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:446-449 `if argument == "--" { positionalOnly = true; continue }` then :450 `if targetMode != "literal" && !positionalOnly && targetOverrideFlag(argument)`
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:386-392 - identical `--` short-circuit in the preload/main validator
- VERIFIED LIVE (docker 29.6.2): `docker --context default -- --host=tcp://127.0.0.1:2 ps` -> 'Cannot connect to the Docker daemon at tcp://127.0.0.1:2'; without `--`: 'conflicting options: cannot specify both --host and --context'
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:369-373 - targetMode is taken verbatim from the request
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:384-389 - literal mode returns argv unchanged, no `--context` injection
- /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:250,917,943 - target mode is a user-selectable control with a literal-mode notice

**Fix.** Delete the `--` special case from core/internal/core/service.go:446-449 and app/electron/contracts.mjs:388-391 - Docker's root command does not stop honouring global flags at `--`, so treating it as an end-of-flags marker is simply wrong. Check every argument unconditionally in pinned mode.

<sub>Verifier (CORRECTED): Code and Docker behaviour both CONFIRMED by me; the security framing is REFUTED and severity cut critical->low. Code: core/internal/core/service.go:446-449 sets positionalOnly and skips all further target checks; app/electron/contracts.mjs:386-392 has the identical gap. Docker behaviour verified live on 29.6.2: `docker --context default -- --host=tcp://127.0.0.1:2 ps` -> 'Cannot connect to the Docker daemon at tcp://127.0.0.1:2' (redirect succeeded, and the conflict check was suppressed), whereas without `--` the same pair errors 'conflicting options: cannot specify both --host and --context'.</sub>

---

#### Combined short-flag cluster `-Dc <ctx>` bypasses targetOverrideFlag and overrides the pinned context

`security` · `defect` · effort: trivial

**Impact.** Same as the `--` bypass: a pinned-labelled request can target a different context. No privilege gain over the freely available literal mode; the cost is an unsound guard and a misleading `targetMode` label on the receipt.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:474 `if len(argument) > 2 && (strings.HasPrefix(argument, "-c") \|\| strings.HasPrefix(argument, "-H"))` - `-Dc` starts with `-D`, returns false
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:460-473 - exact-match switch and prefix list never match `-Dc`, `-Dc=`, `-DH`, `-Dcfoo`
- VERIFIED LIVE (docker 29.6.2): `docker --context default -Dc=anchorage-nope-xyz ps` -> 'unable to resolve docker endpoint: context "anchorage-nope-xyz": context not found'
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:166-177 - TARGET_OVERRIDE_PREFIXES applied with startsWith, same blind spot
- Installed docker 29.6.2 global flags include `-c/--context`, `-D/--debug`, `-H/--host` - pflag clusters shorthands, so `-Dc X` parses as `--debug --context=X`

**Fix.** Stop pattern-matching flag spellings. Walk the argv prefix as pflag would: for any `-xyz` cluster expand each shorthand character and reject if any is `c` or `H`; reject any long flag whose name before `=` is in {context, host, config, tls, tlsverify, tlscacert, tlscert, tlskey}. Mirror in app/electron/contracts.mjs and add table-driven tests for `-Dc`, `-Dc=v`, `-Dcfoo`, `-DH`, `-vc`.

<sub>Verifier (CORRECTED): Code and Docker behaviour CONFIRMED; severity cut high->low for exactly the reason above. Verified live: `docker --context default -Dc=anchorage-nope-xyz ps` -> 'unable to resolve docker endpoint: context "anchorage-nope-xyz": context not found' - the clustered shorthand won over the core-injected `--context default`. Code confirmed: core/internal/core/service.go:474 only matches when `-c`/`-H` is FIRST in the cluster, so `-Dc` slips past the exact-match switch (:460-466), the prefix list (:467-473) and the attached-value check; app/electron/contracts.mjs:166-177 TARGET_OVERRIDE_PREFIXES has t</sub>

---

#### Core stderr line of 4097-8192 characters would crash the main process (un-guarded `core.on("status")` listener)

`correctness` · `defect` · effort: trivial

**Impact.** If some future core change emits a long stderr line without a newline before exit, the whole Electron main process dies with an uncaught TypeError at exactly the moment it should be surfacing the crash. Today there is no code path that produces such a line and no attacker who can cause one.

**Evidence.**
- VERIFIED BY EXECUTION: validateRendererEventEnvelope with a 5000-char stderrTail entry throws 'event.payload.stderrTail[0] must contain at most 4096 characters'
- /home/soya/dev/tools/docker-ui/app/electron/redaction.mjs:1,11 - truncates at 8192; /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:1669-1676 - rejects past 4096
- /home/soya/dev/tools/docker-ui/app/electron/main.mjs:771-777 - `core.on("status", ...)` has no try/catch, unlike main.mjs:778-788
- REACHABILITY: /home/soya/dev/tools/docker-ui/core/cmd/anchorage-core/main.go:50,63 are the ONLY os.Stderr writes in the core, both short `fmt.Fprintln` messages
- /home/soya/dev/tools/docker-ui/core/internal/core/command.go:156-158 and session.go:222-224 - docker child stderr is captured, never inherited to the core's stderr
- /home/soya/dev/tools/docker-ui/core/internal/rpc/server.go:110-120 - request-handler panics are recovered, so no runtime dump from that path

**Fix.** Make redaction.mjs and contracts.mjs share one truncation constant (truncate in RedactedLogTail.push to the contract's 4096, or raise the contract to 8192). Independently wrap the main.mjs:771 status listener in the same try/catch used at :778, and add a `process.on('uncaughtException')` backstop that stops the core cleanly.

<sub>Verifier (CORRECTED): Mechanism CONFIRMED by execution, severity cut high->low because I could find no realistic producer. Verified: `validateRendererEventEnvelope('core.status', {state:'crashed', code:1, signal:null, stderrTail:['x'.repeat(5000)]})` throws 'event.payload.stderrTail[0] must contain at most 4096 characters'. The constant mismatch is real (redaction.mjs:1 MAX_LOG_LINE_CHARACTERS = 8192 vs contracts.mjs:1669-1676 eventText cap 4096) and the asymmetry is real (main.mjs:771-777 core.on('status') has no try/catch while main.mjs:778-788 core.on('notification') does; no uncaughtException handler exists any</sub>

---

#### Environment blocklist is incomplete in both layers (proxy/CA vars, and Docker-specific vectors the Go core misses)

`security` · `defect` · effort: small

**Impact.** In pinned mode DOCKER_CLI_OTEL_EXPORTER_OTLP_ENDPOINT gives an outbound-telemetry exfil channel, DOCKER_CUSTOM_HEADERS injects headers into daemon requests, DOCKER_AUTH_CONFIG supplies attacker registry credentials, and HTTPS_PROXY/SSL_CERT_FILE redirect and re-anchor registry TLS. All of these are available to the renderer anyway via literal mode, so there is no privilege gain - the value of fixing this is that the blocklist should actually match its own stated intent, and the Go core (the real privileged boundary) should be self-sufficient rather than relying on the Electron layer above it.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:413-425 unsafeEnvironmentKey - no BASH_ENV/GCONV_PATH/NODE_OPTIONS/PYTHONPATH, no proxy/CA vars, no DOCKER_CUSTOM_HEADERS/AUTH_CONFIG/OTEL/BUILDX
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:141-142 BLOCKED_ENVIRONMENT_KEYS - blocks the interpreter set but no proxy/CA vars
- VERIFIED: `strings -a /usr/bin/docker \| grep -oE 'DOCKER_[A-Z_]{3,40}'` yields DOCKER_CUSTOM_HEADERS, DOCKER_AUTH_CONFIG, DOCKER_API_VERSION, DOCKER_CLI_OTEL_EXPORTER_OTLP_ENDPOINT, DOCKER_CLI_HOOKS, DOCKER_BUILDKIT, BUILDX_BUILDER
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:367,393-398 - environmentKeyPattern `^[A-Za-z_][A-Za-z0-9_]*$` is applied to the raw key before the ToUpper lookup, correctly closing empty-name, '='-in-name and unicode-homoglyph bypasses
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:47 and command.go:152,201-228 - the core's own commands pass nil env; renderer env never contaminates discovery or context inspection

**Fix.** Move to an explicit allowlist (the CLI palette realistically needs LANG/LC_*, TERM, NO_COLOR, COMPOSE_PROJECT_NAME and little else). If a blocklist must stay, port contracts.mjs:141-142's entries into service.go's unsafeEnvironmentKey so the core holds the line alone, and add the DOCKER_*/BUILDX_* set plus (HTTP\|HTTPS\|ALL\|NO\|FTP)_PROXY, SSL_CERT_FILE, SSL_CERT_DIR, CURL_CA_BUNDLE, REQUESTS_CA_BUNDLE, GLIBC_TUNABLES.

<sub>Verifier (CORRECTED): Merged surveyor 0's finding 6 with surveyor 1's finding 7 - same defect. Facts CONFIRMED including the part I initially doubted: I re-ran `strings -a /usr/bin/docker \| grep -oE 'DOCKER_[A-Z_]{3,40}'` and DOCKER_CUSTOM_HEADERS, DOCKER_AUTH_CONFIG, DOCKER_API_VERSION, DOCKER_CLI_OTEL_EXPORTER_OTLP_ENDPOINT, DOCKER_CLI_HOOKS, DOCKER_BUILDKIT, BUILDX_BUILDER, DOCKER_DEFAULT_PLATFORM are all present in the installed 29.6.2 binary. None are blocked in either layer, in either mode. The Go/preload divergence is real: contracts.mjs:141-142 blocks BASH_ENV\|ENV\|GCONV_PATH\|NODE_OPTIONS\|PERL5OPT\|PYTH</sub>

---

#### Shipped launcher passes `--allow-cwd /`, making the Go cwd allowlist a no-op

`security` · `defect` · effort: small

**Impact.** Renderer-supplied cwd reaches any directory the user can traverse, which is what the design intends. The residual cost is readability: core-launch-policy.mjs performs elaborate realpath/stat/access/root validation of $HOME whose result has no bearing on the allowlist it computes, so the module reads as a guard while configuring none.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/electron/core-launch-policy.mjs:44,58-62 - `allowedCwdRoot: filesystemRoot`, `args: ['--allow-cwd', '/']`
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:304-322 - resolveAllowedCWD accepts any canonical path under a configured root
- /home/soya/dev/tools/docker-ui/docs/architecture.md:165-170 - the `--allow-cwd /` policy and its rationale are documented verbatim
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:324-341 - canonicalDirectory does Abs + EvalSymlinks + Stat + IsDir, so the mechanism is sound

**Fix.** Either narrow the default to the canonical home plus explicitly user-added project roots and surface the active allowlist in Settings, or - if `/` is genuinely intended, as the docs say - add a one-line comment at core-launch-policy.mjs:44 pointing at docs/architecture.md:167 so the intent is visible at the call site.

<sub>Verifier (CORRECTED): Merged surveyor 0's finding 5 and surveyor 1's finding 8. Code CONFIRMED: app/electron/core-launch-policy.mjs:44 `const filesystemRoot = parse(canonical).root` is always '/' on Linux, and :58-62 returns `args: ['--allow-cwd', '/']`; core/internal/core/service.go:304-322 accepts any path when a root is '/'. SEVERITY CUT medium->low and the central claim REFUTED: the surveyors both assert a reader would be misled into thinking cwd is confined to home, but docs/architecture.md:165-170 documents the choice explicitly and gives the rationale - 'the core process itself starts in the canonical curren</sub>

---

#### Packaged Go core binary is never verified at runtime despite a shipped manifest recording its sha256

`security` · `defect` · effort: small

**Impact.** In the linux-unpacked layout a same-user process can swap resources/core/anchorage-core and Anchorage executes it with the user's full docker privileges on next launch. That attacker already owns the user's session, so the escalation is nil; the real value of fixing this is closing the asymmetry where the dev-only path is carefully verified and the shipped path is not verified at all.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/electron/core-path.mjs:55-59 - packaged branch returns join() with no verification
- /home/soya/dev/tools/docker-ui/app/electron/core-path.mjs:18-31,44-46,52 - assertExecutableFile is dev-override-only by construction
- /home/soya/dev/tools/docker-ui/app/electron-builder.yml:22-28 - manifest.json is shipped via extraResources; no code reads it
- /home/soya/dev/tools/docker-ui/artifacts/docker/capability-generation.json records `coreSha256: f39a914f...` - the same digest, also unused at runtime
- /home/soya/dev/tools/docker-ui/app/electron/core-supervisor.mjs:172-178 - `this.#spawn(this.#binaryPath, ...)` executes whatever the path resolves to

**Fix.** Apply assertExecutableFile to the packaged branch of core-path.mjs:55-59 regardless, and at startup in main.mjs read resources/core/manifest.json and verify a streaming sha256 against `manifest.core.sha256` before CoreSupervisor.start(), refusing to launch on mismatch.

<sub>Verifier (CORRECTED): Facts CONFIRMED, severity cut medium->low per the stated threat-model rule. app/electron/core-path.mjs:55-59 packaged branch is a bare `join(resourcesPath, 'core', name)` with no stat, symlink or hash check; assertExecutableFile (:18-31) exists but is reachable only from the override branch (:52), which is hard-disabled when packaged (:44-46); app/build/core/manifest.json records `core.sha256` and electron-builder.yml:22-28 ships it, yet grep finds no reference to manifest.json in main.mjs, core-path.mjs or core-supervisor.mjs. DOWNGRADED because the attacker must already be able to write to t</sub>

---

#### Redaction covers main-process logs and IPC error strings only, not the success path, receipts, or recorded argv

`security` · `defect` · effort: small

**Impact.** Registry credentials, container env blocks and secrets typed as CLI flags reach the renderer verbatim. Given the renderer is the user's own UI showing the user's own containers, and given the Command Center already masks detected secrets and keeps them out of history, the residual exposure is devtools and screenshots rather than anything crossing a trust boundary. main.mjs:810 is a genuine one-line miss.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/electron/main.mjs:552 vs :561-564 - success path unredacted, error path redacted
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:1211-1259 validateCliResult and :1305-1317 validateOperationStarted - argv/stdout/stderr shape-checked only
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:357 `Environment: nonNilStrings(raw.Config.Env)` and :262 `Document: cloneJSON(body)`
- COMPENSATING CONTROL (missed by both surveyors): /home/soya/dev/tools/docker-ui/app/src/components/commandCenterModel.ts:57-92 secretArgumentIndices + /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:1274 masking, history exclusion and copy disable
- NO PERSISTENCE: the only localStorage use in app/src is /home/soya/dev/tools/docker-ui/app/src/theme/appearance.ts:128 (appearance preference)
- /home/soya/dev/tools/docker-ui/core/internal/core/errors.go:35-48 - AsOpError already refuses to leak unexpected Go error strings

**Fix.** Route main.mjs:810 through redactSensitiveText. Then either extend redaction to the stdout/stderr/argv fields of operation.started, operation.completed and cli.run results, or - preferably - document in docs/architecture.md that redaction.mjs is a logging-only control and that command output must be treated as secret-bearing by anything that captures or persists it.

<sub>Verifier (CORRECTED): Merged with surveyor 1's finding 12 (core forwards stderr/env/raw documents verbatim) - same underlying claim. Facts CONFIRMED: main.mjs:552 returns `{ ok: true, value: await handler(value) }` unredacted; redaction applies only in the `{ ok: false }` branch at :561-564; validateOperationReceipt (contracts.mjs:1200-1209) and validateCliResult (:1211-1259) shape-check stdout/stderr/argv without redacting; validateOperationStarted (:1305-1317) carries argv verbatim; main.mjs:810 logs an unredacted stack. On the Go side, domain.go:357 projects raw.Config.Env and domain.go:262 returns the full raw </sub>

---

#### No concurrency or rate limiting on any IPC channel or RPC request; unbounded pending map, sessions, and capability fork amplification

`performance` · `absent` · effort: medium

**Impact.** A renderer bug or hostile renderer can pin unbounded goroutines, timers and docker child processes in the privileged core and the main process. No escalation past what cli.run already permits, so this is capacity hardening rather than a boundary defect. The containersList missing timeout is the one piece with a non-renderer trigger: a daemon that accepts and never answers pins a handler goroutine.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/electron/main.mjs:548-569 - registerHandler has no counter, semaphore or token bucket
- /home/soya/dev/tools/docker-ui/app/electron/jsonl-rpc.mjs:20,78-79 - unbounded #pending map, ignored stdin.write backpressure
- /home/soya/dev/tools/docker-ui/core/internal/rpc/server.go:91-96 - goroutine per request line, no in-flight limit
- /home/soya/dev/tools/docker-ui/core/internal/core/discovery.go:14-19,197-215 - 2048 nodes x 8 concurrency, one `docker <path> --help` exec each, no aggregate deadline
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:200-231 vs :300 - containersList has no own timeout while containersListCLI sets 30s
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:201-203 - no cap on concurrent sessions

**Fix.** Give containersList its own context.WithTimeout like containersListCLI already has (engine.go:300). Add a bounded worker pool in rpc.Server.Serve with a typed busy error past the cap, wrap capabilities in an aggregate context.WithTimeout and cache the inventory keyed by binary digest + context, bound #pending in jsonl-rpc.mjs, and cap concurrent sessions in sessionManager.start.

<sub>Verifier (CONFIRMED): Merged surveyor 0's finding 4 with surveyor 1's finding 9 - same absence at two layers, both CONFIRMED. Electron: main.mjs:548-569 registerHandler adds only sender validation and try/catch; all 22 channels go through it; jsonl-rpc.mjs:20 `#pending = new Map()` is never size-checked and :79 ignores the stdin.write backpressure return. Go: rpc/server.go:91-96 spawns one goroutine per request line gated only by the duplicate-ID check at :80, with no in-flight cap and no per-request timeout; service.go:76-81 hands `capabilities` the process-lifetime server ctx, so the 2048-node / 8-concurrency BFS</sub>

---

#### Docker binary SHA-256 fingerprint is computed once at startup and never verified

`security` · `defect` · effort: medium

**Impact.** The digest is startup-observed provenance shown in Settings, not an enforcement control, and the app does not claim otherwise. Swapping the docker binary mid-session is undetected, but doing so requires privileges that already defeat the whole application.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/command.go:114-139 - resolveDockerBinary hashes once and stores the hex digest
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:53 - resolveDockerBinary is called exactly once, from NewService
- grep for sha256/Fingerprint across non-test Go: only compute (command.go:118,133), serialize (types.go:34), an unrelated endpoint hash (engine.go:89) and image-ID validation (domain.go:1413-1416) - no comparison
- /home/soya/dev/tools/docker-ui/core/internal/core/command.go:150 and session.go:163 - every exec uses the cached RealPath with no re-stat or re-hash
- /home/soya/dev/tools/docker-ui/docs/parity-and-release-gates.md:50 lists 'installation fingerprint' under Identity/evidence, not under an integrity guarantee

**Fix.** Label the field 'observed at startup' wherever it is surfaced so nobody mistakes it for enforcement. If enforcement is later wanted, the cheap robust variant is to hold the binary's fd open for the process lifetime and exec via /proc/self/fd/N, so the hashed bytes and the executed bytes are provably identical.

<sub>Verifier (CORRECTED): Fact CONFIRMED, severity cut high->low, and the 'broken documented guarantee' framing REFUTED. Grep for sha256/Fingerprint across non-test Go files yields exactly: command.go:118,133 (compute), types.go:34 (serialize to the renderer), engine.go:89 (unrelated endpoint hash), domain.go:1413-1416 (image-ID string validation). There is no comparison anywhere, no expected hash in Config (service.go:15-18) or the CLI flags (cmd/anchorage-core/main.go:35-37), and command.go:150 / session.go:163 exec the cached RealPath with no re-stat. THREAT MODEL REFUTES THE SEVERITY: replacing /usr/bin/docker requ</sub>

---

#### Post-reap kill(-pid) and unlocked exited-checks create PID/PGID-reuse windows; resize touches a concurrently-closing pty fd

`security` · `defect` · effort: small

**Impact.** In the worst case a SIGKILL/SIGTERM is delivered to a process group that has been reallocated to an unrelated same-user process, or resize touches a closed fd. The PID-reuse variants need an extremely narrow race the renderer cannot steer; the fd race is an ordinary use-after-close.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:316-322 - Wait() reaps, then unconditional signalProcessGroup(s.pid, SIGKILL)
- /home/soya/dev/tools/docker-ui/core/internal/core/pty_linux.go:89-94 - signalProcessGroup is `syscall.Kill(-pid, signal)`
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:740-746 and :680-692 - exited-check under the lock, signal delivered after unlocking
- /home/soya/dev/tools/docker-ui/core/internal/core/session.go:647-654 vs :324-326 - resize reads session.pty under the lock, calls resizePTY (Fd()) outside it, while the waiter may Close() it

**Fix.** Capture the child's PGID before Start returns and stop signalling once Wait() has reaped - drop the unconditional kill at session.go:322, since Pdeathsig plus the pre-Wait cancellation kills already cover the intended case. Perform the exited-check and the kill under a single mutex hold in requestCancellation and sessionManager.signal. For resize, hold s.mu across resizePTY or use an fd guard.

<sub>Verifier (CORRECTED): Code CONFIRMED, severity cut medium->low. session.go:316-322: the waiter calls `s.command.Wait()` (which reaps the child and frees its PID) and then unconditionally `_ = signalProcessGroup(s.pid, syscall.SIGKILL)`, implemented as `syscall.Kill(-pid, signal)` at pty_linux.go:89-94. The check-then-signal races are real at session.go:740-746 (grace goroutine), :680-692 (renderer-driven session.signal) and :647-654 (resize reads session.pty under the lock then calls resizePTY -> Fd() outside it, while the waiter may close the pty at :324-326). DOWNGRADED because exploitation requires PID wraparoun</sub>

---

#### Docker context name is not validated as a context name and is passed positionally to `docker context inspect`

`security` · `defect` · effort: trivial

**Impact.** The renderer can inject exactly one flag token into `docker context inspect`. Realistic outcomes are a decode failure or reading a different --config directory. Low, but it is a latent argv-injection primitive on the privileged path, and the missing validation also lets nonsense names propagate into receipts and endpoint hashes.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:572-580 - validateContextName permits a leading `-`
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:46-47 - `args := []string{"context", "inspect", contextName}` places the name positionally
- VERIFIED LIVE: `docker context inspect --format=INJECTED` -> prints `INJECTED`, exit 0 (the value is parsed as a flag, not a name)
- VERIFIED LIVE: `docker context inspect -- --format` -> `context "--format": context not found` (a `--` guard makes it positional again)
- /home/soya/dev/tools/docker-ui/core/internal/core/discovery.go:826-830 withContext - always `--context <name>`, safely consumed as a flag value

**Fix.** Validate context names against Docker's own rule `^[a-zA-Z0-9][a-zA-Z0-9_.+-]*$` inside validateContextName so every call site is fixed at once, and additionally pass the name after a `--` guard in resolveEngineEndpoint so a positional value can never be read as a flag.

<sub>Verifier (CONFIRMED): Confirmed by reading and by live test - the surveyor's severity and impact assessment is accurate, which is rare in this set. engine.go:572-580 validateContextName rejects only >255 bytes and NUL/CR/LF, so a leading `-` passes; engine.go:46-47 places the name in a positional slot. I verified `docker context inspect --format=INJECTED` prints INJECTED and exits 0, so a context name spelled `--format=...` is parsed as a flag. Also verified the contrast the surveyor drew: withContext (discovery.go:826-830) always emits `--context <name>`, where the name is safely consumed as a flag value, so the i</sub>

---

#### Core->renderer RPC response path is neither validated nor size-bounded, unlike requests and notifications

`architecture` · `defect` · effort: medium

**Impact.** A buggy core can return arbitrarily shaped results to the renderer with no main-process check, so the renderer's type assumptions are unenforced at the trust boundary. Bounded in size by the 8 MB frame cap, so not an OOM path.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/electron/main.mjs:549-552 - `return { ok: true, value: await handler(value) }` forwards the core result verbatim
- /home/soya/dev/tools/docker-ui/app/electron/jsonl-rpc.mjs:201 - `pending.resolve(envelope.result)` with no checks
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:1604-1609 validateCoreEventEnvelope + :1075-1088 assertEventPayloadSize - the standard applied to notifications
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:1090+ normalizeRpcError - the standard applied to errors

**Fix.** Add response validators mirroring the existing event validators in app/electron/contracts.mjs and apply them in registerHandler before returning `{ ok: true, value }`; at minimum apply assertEventPayloadSize-style bounding.

<sub>Verifier (CONFIRMED): Confirmed exactly as described; the surveyor's own severity and reasoning are correct. main.mjs:549-552 returns the core's result verbatim; jsonl-rpc.mjs:201 `pending.resolve(envelope.result)` with no shape or size check. The asymmetry is real and clearly unintentional: core notifications go through validateCoreEventEnvelope including the 8 MB assertEventPayloadSize (contracts.mjs:1075-1088, 1604-1609), and core errors go through normalizeRpcError (contracts.mjs:1090+). Only successful results skip both. The surveyor correctly notes the 8 MB frame cap at jsonl-rpc.mjs:104 bounds the size, so t</sub>

---

#### Vite dev server binds 0.0.0.0 and whitelists a non-loopback host

`security` · `defect` · effort: trivial

**Impact.** `npm run dev` publishes the renderer, Vite's /@fs surface and the full source tree to the LAN, and the explicit allowedHosts entry weakens Vite's DNS-rebinding host check for that name. Source disclosure on a developer machine; no Docker privilege.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/vite.config.mjs:48-51 - `host: "0.0.0.0"`, `allowedHosts: ["terminal.local"]`
- /home/soya/dev/tools/docker-ui/app/package.json:14 - `"dev": "vite"`
- /home/soya/dev/tools/docker-ui/app/scripts/dev-desktop.mjs - desktop dev path correctly forces 127.0.0.1 + strictPort
- /home/soya/dev/tools/docker-ui/app/electron/dev-server-proof.mjs:35-53 - Electron only loads loopback renderer URLs

**Fix.** Change server.host to "127.0.0.1" in app/vite.config.mjs and drop or env-gate the allowedHosts entry; put LAN preview behind an explicit opt-in env var.

<sub>Verifier (CONFIRMED): Confirmed verbatim; severity trimmed medium->low. app/vite.config.mjs:48-51 is `server: { host: "0.0.0.0", allowedHosts: ["terminal.local"], warmup: {...} }`, package.json:14 `"dev": "vite"` uses it as-is. The surveyor's own mitigations are accurate: app/scripts/dev-desktop.mjs correctly overrides with `--host 127.0.0.1 --strictPort` for the desktop dev path, and app/electron/dev-server-proof.mjs:35-53 validateLoopbackRendererUrl restricts what Electron will load. This is dev-only and fixture-only - createAnchorageBridge falls back to FixtureBridge when window.anchorage is absent - so no Docke</sub>

---

#### webPreferences allowlist does not pin experimentalFeatures, enableBlinkFeatures, plugins, or safeDialogs

`security` · `absent` · effort: trivial

**Impact.** No live vulnerability - the unpinned preferences all default safe. The release gate that exists specifically to prove hardened preferences cannot detect a future regression on them, and unset safeDialogs lets a renderer fault wedge the window with blocking dialogs.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/electron/security-policy.mjs:10-25 - createSecureWebPreferences enumerates 12 keys, none of them experimentalFeatures/enableBlinkFeatures/plugins/safeDialogs
- /home/soya/dev/tools/docker-ui/app/electron/security-policy.mjs:62-76 - the runtime assertion iterates only the expected object's keys
- /home/soya/dev/tools/docker-ui/app/electron/main.mjs:487-493 - the packaged smoke can only assert keys present in the expected object

**Fix.** Add `experimentalFeatures: false`, `enableBlinkFeatures: ""`, `plugins: false`, `safeDialogs: true` and `safeDialogsMessage` to createSecureWebPreferences so the existing runtime assertion covers them.

<sub>Verifier (CONFIRMED): Confirmed and correctly self-assessed by the surveyor as having no live vulnerability. security-policy.mjs:10-25 createSecureWebPreferences sets 12 keys and nothing else; assertRuntimeSecureWebPreferences (:38-77) iterates `Object.entries(runtimeExpected)`, so the gate is exactly as wide as the allowlist and an unpinned preference is structurally invisible to it. The defaults are safe today, so this is purely gate coverage against future regression, plus the safeDialogs dialog-spam point.</sub>

---

#### No ASAR integrity fuse, no artifact signature, and no update channel for the Linux build

`security` · `absent` · effort: medium

**Impact.** In the unpacked layout a same-user process can rewrite app.asar and the next launch runs it. The AppImage payload is read-only squashfs, which covers the shipped artifact. Attacker must already own the user's session.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/electron-builder.yml:4 - `asar: true` with no asarIntegrity; electron-builder enforces ASAR integrity only on macOS/Windows
- /home/soya/dev/tools/docker-ui/app/electron-builder.yml - no `publish` block, so no auto-updater exists (a positive)
- /home/soya/dev/tools/docker-ui/app/release/linux-unpacked/resources/app.asar is `-rw-r--r-- soya soya`
- /home/soya/dev/tools/docker-ui/app/release/release-verification.json - package-time sha256 evidence with no runtime counterpart

**Fix.** Ship a detached signature (or publish release-verification.json's digest list) alongside the AppImage, and enable Electron's EnableEmbeddedAsarIntegrityValidation, OnlyLoadAppFromAsar and RunAsNode:false fuses via @electron/fuses.

<sub>Verifier (CONFIRMED): Confirmed, including the surveyor's own correct observation that the absent publish block is a positive (no unsigned update channel to hijack). electron-builder.yml:4 is `asar: true` with no asarIntegrity, and there is no @electron/fuses usage anywhere in app/. release/linux-unpacked/resources/app.asar is 0644 owned by the user. release/release-verification.json exists and is thorough, but it is package-time evidence with no runtime counterpart. Same threat-model caveat as the core-binary finding: rewriting app.asar requires the attacker to already be the same user.</sub>

---

#### JSONL protocol treats an envelope carrying both `id` and `event` as a response, resolving the pending request with undefined

`correctness` · `defect` · effort: trivial

**Impact.** A malformed core frame such as `{"id":"5","event":"session.output",...}` silently resolves in-flight request 5 with undefined and drops the event, so the renderer sees a successful RPC with a missing result instead of a protocol error.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/electron/jsonl-rpc.mjs:165-168 - notification branch requires the absence of `id`
- /home/soya/dev/tools/docker-ui/app/electron/jsonl-rpc.mjs:170-201 - anything with an id falls through to `pending.resolve(envelope.result)`
- /home/soya/dev/tools/docker-ui/app/electron/jsonl-rpc.mjs:59 - ids are main-generated and monotonic, never taken from core input

**Fix.** In app/electron/jsonl-rpc.mjs:165, reject envelopes carrying both `event` and `id` with an RPC_INVALID_ENVELOPE protocol error, and require that a response envelope carry exactly one of `result` or `error`.

<sub>Verifier (CONFIRMED): Confirmed verbatim and correctly scoped by the surveyor. jsonl-rpc.mjs:165-168 gates the notification branch on `!Object.hasOwn(envelope, "id")`, so an envelope with both falls through to the response path and ends at :201 `pending.resolve(envelope.result)` = undefined. The surveyor's own caveat is right and I verified it: request ids are locally generated at :59 `String(++this.#counter)` and never derived from core input, and replays land on the RPC_UNKNOWN_ID path at :176-186, so there is no id-confusion attack. Robustness gap only.</sub>

---

#### Hosted browser-preview worker sets no security response headers

`security` · `defect` · effort: trivial

**Impact.** Clickjacking / UI-redress of a fixture-only demo surface. No Docker privilege is reachable in the hosted preview.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/worker/index.js:1-15 - SPA fallback only; no CSP, X-Frame-Options, X-Content-Type-Options or Referrer-Policy
- /home/soya/dev/tools/docker-ui/app/dist/client/index.html - meta CSP present but omits frame-ancestors (ignored in meta by spec)
- /home/soya/dev/tools/docker-ui/app/scripts/prepare-sites-build.mjs:15-19 - copies worker/index.js unchanged into the hosted build

**Fix.** Have app/worker/index.js clone the asset response and attach Content-Security-Policy (including `frame-ancestors 'none'`), X-Content-Type-Options: nosniff and Referrer-Policy: no-referrer before returning it.

<sub>Verifier (CONFIRMED): Confirmed. app/worker/index.js is 15 lines that only perform SPA 404 fallback to /index.html and add no headers. I verified the shipped app/dist/client/index.html DOES carry a meta CSP (the surveyor's grep apparently missed it because the tag spans lines) - `default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; script-src 'self'; ...` with no unsafe-eval - but it omits frame-ancestors, which is ignored in meta CSP by spec anyway, so nothing prevents framing of the hosted preview. Correctly scoped by the surveyor: the hosted build is fixture-only with no </sub>

---

#### Renderer-creatable Docker contexts allow local unix-socket reach-out from the privileged core

`security` · `defect` · effort: small

**Impact.** The core can be induced to write HTTP requests to any unix socket the app user can reach - but only by a renderer that already possesses arbitrary docker argv, which is strictly more powerful. No escalation.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:84-88 - accepts any unix:// path with a non-empty Path
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:106-108 - DialContext dials `unix` at endpoint.socketPath unconditionally
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:98-116,163 - Proxy nil and a constant URL host, so no network SSRF
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:143-152 - API version handshake is bounded (>=1.40, clamped to 1.55)

**Fix.** Cheap hardening only: require the resolved socket path to Stat as ModeSocket and warn (rather than silently dial) when it lies outside /var/run, /run or $XDG_RUNTIME_DIR.

<sub>Verifier (CORRECTED): Facts CONFIRMED, but this should not have been reported as a distinct issue - it is a restatement of the cli.run finding. engine.go:84-88 accepts any `unix://` path with a non-empty Path and engine.go:106-108 dials it unconditionally. The surveyor correctly notes the strong parts: Proxy is nil, the URL host is the constant "http://docker" (engine.go:163) so there is no arbitrary-host or TCP SSRF, and the /version handshake clamps API version between 1.40 and coreMaxAPIVersion 1.55 (engine.go:143-152, types.go:15-16). To reach an arbitrary socket path the renderer must first run `docker context</sub>

---

#### `targetMode` is a renderer-chosen request field, so "pinned mode" is a UI default rather than a security control - and the README presents it as one

`architecture` · `defect` · effort: trivial

**Impact.** This is the root cause that collapses four separately-reported 'critical/high' findings (the `--` bypass, the `-Dc` bypass, the env blocklist gaps, and part of the sandbox argument) into low-severity correctness bugs. Anyone reviewing the code from README.md alone will over-value the pinned-mode checks and under-value the fact that the renderer selects the mode. Conversely, the invariant that DOES hold in both modes - that the executable is always the fingerprinted resolved docker path, since exec.Command always receives binary.RealPath and validateCLIArgv rejects argv[0] containing a path separator or named `docker` - is the one worth documenting and defending.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:369-373 - `validateTargetMode` returns whatever the request supplies, defaulting to 'pinned' only when undefined
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:369-382 - normalizeTargetMode does the same on the Go side
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:384-389 - `commandArgs` returns argv verbatim with no `--context` injection when targetMode is 'literal'
- /home/soya/dev/tools/docker-ui/core/internal/core/service.go:450 - the target-override check is guarded by `targetMode != "literal"`; service.go:419-421 - DOCKER_HOST/CONTEXT/CONFIG/TLS* env is blocked only when `targetMode != "literal"`
- /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:250,917,943 - target mode is a user-facing `<select>` with a literal-mode notice
- /home/soya/dev/tools/docker-ui/README.md:76-80 states without qualification 'The core injects the selected Docker context, executes an argument vector without shell interpolation...'

**Fix.** State in README.md and docs/architecture.md that pinned mode is an accident-prevention default the renderer may opt out of, that the enforced invariants are the fixed executable and the absence of shell interpolation, and that a renderer compromise is equivalent to shell access with the user's docker rights. Then fix the pinned-mode checks as ordinary correctness bugs rather than as security patches.

---

#### `__proto__` is accepted as a cli.run environment key; safe today only because of an implementation detail of Object.fromEntries

`security` · `defect` · effort: trivial

**Impact.** No live vulnerability - I confirmed by execution that nothing is polluted, and the Go side treats the key as an ordinary map entry. The concern is that the safety is incidental: the map-shaped validators rely on `Object.fromEntries` semantics rather than on an explicit reject, so a future refactor to a reduce-with-assignment or a spread-into-accumulator in either contracts.mjs or preload.cjs turns this into a live prototype-pollution sink in the main process. Surveyor 0 asserted the layer is 'prototype-pollution-safe' without noting that the map-shaped path is safe only by construction.

**Evidence.**
- VERIFIED BY EXECUTION: `validateCliRun(JSON.parse('{"context":"default","argv":["ps"],"env":{"__proto__":"pwned"}}'))` is ACCEPTED; the result's env has `__proto__` as an OWN property and `Object.getPrototypeOf(result.env) === Object.prototype`; no global pollution occurs
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs - `ENVIRONMENT_KEY` is `^[A-Za-z_][A-Za-z0-9_]*$`, which matches `__proto__` and `constructor`
- /home/soya/dev/tools/docker-ui/app/electron/contracts.mjs:468 - the result is built with `Object.fromEntries(normalizedEntries)`, which uses CreateDataProperty rather than [[Set]], which is the only reason no pollution occurs
- CONTRAST (verified safe): fixed-shape objects ARE protected - `validateCliRun(JSON.parse('{"context":"default","argv":["ps"],"__proto__":{"x":1}}'))` is rejected with 'request.__proto__ is not supported' by assertOnlyKeys (contracts.mjs:198-204), which uses Object.keys

**Fix.** Add `__proto__`, `constructor` and `prototype` to an explicit reject in `validateEnvironment` (and any other Object.fromEntries-shaped validator) in both app/electron/contracts.mjs and app/electron/preload.cjs, and build the result with `Object.create(null)` plus explicit defineProperty so the guarantee is structural rather than incidental. Add a regression test covering the JSON.parse-own-property form, which the current preload.test.mjs/contracts.test.mjs do not.

---

#### Swarm, service, node, secret, config and stack are Command-Center-only, and the swarm state the core already fetches is never displayed

`parity-gap` · `core-only-not-wired` · effort: trivial

**Impact.** Low practical severity for a single-host Linux desktop tool. But the app already knows whether the local daemon is a swarm manager and does not say so, which is a one-line miss: a swarm-active daemon looks identical to a plain one, so nothing signals that the palette-only swarm surface is even relevant.

**Evidence.**
- I ran the ledger: 8 `docker swarm`, 9 `docker service`, 7 `docker node`, 4 `docker secret`, 4 `docker config`, 6 `docker stack` rows, all `discovery.status == "available"`, all `uiPath.surface == "Command Center"`. The counts match the surveyor's exactly.
- /home/soya/dev/tools/docker-ui/core/internal/core/domain.go:181 — `SwarmState: raw.Swarm.LocalNodeState` is parsed from `/info`; protocol/types.ts:444 exposes `swarmState?: string`; app/src/types.ts:130 mirrors it.
- /home/soya/dev/tools/docker-ui/app/src/screens/DashboardScreen.tsx:232-241 — the host engine facts panel renders API version, storage driver, docker root and observed time. I grepped `swarmState` across all of app/src/screens and app/src/components: zero hits. The value is carried the whole way and dropped at render.
- /home/soya/dev/tools/docker-ui/app/src/components/commandCenterModel.ts:157-181 — swarm/service/stack/node/secret/config appear only in the destructive-argv classifier.

**Fix.** Render `engine.swarmState` in the Dashboard engine-facts panel, and document swarm/service/node/secret/config/stack as Command-Center-only scope in README.md rather than leaving it implied.

<sub>Verifier (CONFIRMED): Confirmed exactly, including the group counts which I reproduced from the ledger.</sub>

---

#### Docker plugins and CLI plugins are discovered by the core on every capabilities call but never shown; the Extensions screen is a dead end in host mode

`parity-gap` · `core-only-not-wired` · effort: small

**Impact.** The app performs a full plugin inventory with versions and availability reasons on every capabilities call and shows the user none of it. A user cannot see which CLI plugins are installed, at what version, or why one is degraded — exactly the information that would explain Command Center inventory gaps.

**Evidence.**
- /home/soya/dev/tools/docker-ui/core/internal/core/discovery.go:154 and :161 — `result.Plugins = convertPlugins(info.ClientInfo.Plugins)` then `mergeHelpPlugins(...)`. discovery.go:163-166 — per-plugin capability probes for compose/scout/buildx plus a checkpoint capability status.
- /home/soya/dev/tools/docker-ui/protocol/types.ts:374-384 defines `Plugin` (name/version/vendor/description/path/schemaVersion/status/discoverySource/availabilityNote); protocol/types.ts:410-411 returns `plugins: Plugin[]` and `capabilities: Record<...,CapabilityStatus>`.
- I grepped all of app/src for `.plugins`, `capabilities.capabilities`, `serverExperimental`, `apiMin`, `apiMax` — zero non-test hits. CommandCenter.tsx consumes only `commandInventory` (:327,:935) and `contexts` (:901); the store consumes only the context fields (useAnchorageStore.ts:516-521).
- /home/soya/dev/tools/docker-ui/app/src/screens/ExtensionsScreen.tsx:5-16 — host mode renders `UnsupportedSurface`; useAnchorageStore.ts:1902 — `extensions: isHost ? [] : EXTENSION_FIXTURES`.
- I ran the ledger: all 10 `docker plugin *` rows (managed engine plugins) are Command-Center-only.

**Fix.** Repurpose the host-mode Extensions screen into a read-only "Plugins & capabilities" view rendering `capabilities.plugins` and `capabilities.capabilities` with their status/version/reason strings. Renderer-only work against data already on the wire, replacing a dead screen with something honest.

<sub>Verifier (CONFIRMED): Confirmed by independent grep of every capabilities field the renderer could consume.</sub>

---

#### Extensions, Dev Environments and Builds are fixture-only; the host renders an unavailable placeholder while all three keep permanent sidebar entries

`parity-gap` · `fixture-only` · effort: medium

**Impact.** Three of eight sidebar destinations are dead ends against real Docker. The app is honest about it (no fake data is shown in host mode, which is the right call), but the design-QA captures document behaviour the product does not have. Builds in particular is achievable — BuildKit history is reachable through the existing literal-argv session transport.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/ExtensionsScreen.tsx:5-16, DevEnvironmentsScreen.tsx:22-32, BuildsScreen.tsx:5-16 — all three return `UnsupportedSurface` when `store.isHost`.
- /home/soya/dev/tools/docker-ui/app/src/store/useAnchorageStore.ts:1898 and :1902 — `builds: isHost ? [] : BUILD_FIXTURES` and `extensions: isHost ? [] : EXTENSION_FIXTURES`.
- artifacts/host-candidate/screens/host-unsupported-builds.png — the live host capture confirms the placeholder.
- /home/soya/dev/tools/docker-ui/app/src/components/Shell.tsx:29-45 — all three remain permanent sidebar entries in host mode, so three of eight destinations are guaranteed dead ends.
- artifacts/design/design-ledger.json — `builds`, `dev-environments` and `extensions` are three of the 24 pixel-compared canonical states documenting behaviour that does not exist in the product.

**Fix.** Either hide the three entries in host mode or, for Builds, wire `docker buildx history ls` through the existing `cli.run` path. Label the fixture-only captures as design-source states in the release report rather than product evidence.

<sub>Verifier (CONFIRMED): Confirmed exactly.</sub>

---

#### Host-mode destructive controls appear in zero design captures despite a claimed 100% state-coverage ledger, and the desktop smoke gate blocks mutations

`parity-gap` · `defect` · effort: small

**Impact.** The most dangerous controls in the product are the only ones with no visual review and no runtime smoke coverage. The volume delete button in particular is injected into a column the reference design shows as a plain date cell, so its host-mode layout was never compared against anything.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/VolumesScreen.tsx:28-44 — the "Clean up" button renders only under `store.isHost &&`. VolumesScreen.tsx:77-92 — the per-row remove button is likewise host-gated AND is placed inside the CREATED cell (`<span className="resource-dim volume-row__created">`), changing that column's layout relative to the reference. ImagesScreen.tsx:56-70 — the per-image remove button is host-gated too.
- docs/parity-and-release-gates.md:84-90 — "The canonical ledger requires 100% state coverage: 24 named captures". I enumerated the ledger rows myself: containers, containers-current, containers-only-running, containers-search-empty, containers-row-hover, containers-banner-dismissed, container-detail-{logs,inspect,mounts,exec,files,stats}, dashboard, images-local, images-registry, volumes, builds, dev-environments, extensions, settings-{resources,engine,kubernetes,updates,advanced}. Exactly 24, none of them a destructive, confirmation, pending, or host-delete state — and all are FixtureBridge captures (parity-and-release-gates.md:104-106).
- /home/soya/dev/tools/docker-ui/app/electron/main.mjs:718-725 — `assertMutationsEnabled` throws `SMOKE_MUTATION_BLOCKED` during desktop smoke, so the packaged runtime gate never exercises a destructive path either.

**Fix.** Add host-mode capture states for the destructive affordances (idle, disabled-with-reason, pending, error) to the design ledger and a mutation-enabled UI acceptance state to the host-candidate harness. At minimum, stop describing the ledger as 100% state coverage while whole classes of host-only UI are excluded.

<sub>Verifier (CONFIRMED): Confirmed; I enumerated all 24 ledger rows programmatically rather than trusting the count.</sub>

---

#### Accessibility defects in the resource tables: orphaned role="row", interactive controls nested inside a role="button", role-less aria-label on the status dot

`accessibility` · `defect` · effort: medium

**Impact.** An orphaned `role="row"` is invalid ARIA; column headers are never associated with cells, so a screen reader user hears eight unlabelled values per row. Interactive descendants of a `role="button"` are not a supported pattern — the delete/restart buttons live inside an element that announces itself as "Open <name>, button". `aria-label` on a role-less `<span>` is not exposed.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:195 — `<div className="container-table__head" role="row">` whose parent (ContainersScreen.tsx:194 `<div className="container-table" data-testid="container-table">`) has no role at all; its eight children are bare `<span>`s with no `role="columnheader"`.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:97-111 — each row is a `div role="button" tabIndex={0}` handling Enter/Space, and ContainersScreen.tsx:38-84 renders three real `<button>` elements inside it, with `onClick={(event) => event.stopPropagation()}` at :42 as the only mitigation.
- /home/soya/dev/tools/docker-ui/app/src/components/FixedRowWindow.tsx:99-124 — the virtualized branch inserts two role-less wrapper divs (`fixed-row-window__space`, `fixed-row-window__items`) between the list container and the rows, so even a corrected role hierarchy would be broken by non-role elements.
- /home/soya/dev/tools/docker-ui/app/src/screens/ContainersScreen.tsx:112-115 — the status dot is a `<span>` carrying `aria-label` with no role, so the label is dropped by the accessibility mapping.
- /home/soya/dev/tools/docker-ui/app/src/screens/ImagesScreen.tsx:12-19 and VolumesScreen.tsx:55-61 — image and volume header rows carry no table semantics at all (not even the orphaned role="row").

**Fix.** Model the tables as `role="table"` with rowgroup/row/columnheader/cell (adding the roles to FixedRowWindow's wrapper divs), and replace the row-level `role="button"` with a dedicated "Open <name>" cell button or an `aria-rowindex` grid pattern so the action buttons are siblings rather than descendants. Give the status dot `role="img"` or move the text into a visually-hidden span.

<sub>Verifier (CONFIRMED): Confirmed; I verified the parent of the orphaned role="row" has no role by reading the surrounding JSX rather than assuming.</sub>

---

#### Dev Environments delete has no confirmation at all (fixture-only surface)

`ux` · `fixture-only` · effort: trivial

**Impact.** No real-world impact because the surface never reaches live Docker, but it is an inconsistency in the destructive-action contract: every other delete in the app confirms, this one does not. If a Dev Environments provider is ever wired up, the confirmation gap ships with it.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/screens/DevEnvironmentsScreen.tsx:128-138 — the overflow menu's Delete calls `store.deleteDevEnvironment(environment.id)` directly with no confirm, no undo and no error path.
- /home/soya/dev/tools/docker-ui/app/src/screens/DevEnvironmentsScreen.tsx:22-32 — the whole screen is replaced by `UnsupportedSurface` when `store.isHost`, so this only affects fixture/design-QA mode.
- /home/soya/dev/tools/docker-ui/app/src/screens/ExtensionsScreen.tsx:50-59 — likewise, `toggleExtension` install/uninstall is fixture-only local state.

**Fix.** Route it through the same shared confirmation component recommended for the other destructive flows so the pattern is already correct if the surface goes live.

<sub>Verifier (CONFIRMED): Confirmed exactly.</sub>

---

#### navigator.clipboard.writeText may be denied by the blanket permission handlers

`ux` · `unverified` · effort: small

**Impact.** If confirmed, the app's single export affordance always fails with a soft message and users have no way to copy a constructed command out. Because the failure is caught and turned into a notice, no test or gate would flag it.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/electron/security-policy.mjs:111-114 — `permissionCheck: () => false` and `permissionRequest: (_wc,_perm,callback) => callback(false)` deny every permission unconditionally.
- I confirmed `clipboard-sanitized-write` IS in Electron 43.2.0's permission enum for both handlers: app/node_modules/electron/electron.d.ts:13246 (`setPermissionCheckHandler`) and :13255 (`setPermissionRequestHandler`), and the string appears in the bundled binary. So the permission the async clipboard write would need is one this policy denies.
- /home/soya/dev/tools/docker-ui/app/src/components/CommandCenter.tsx:612-631 — `copyArgv` is the app's only copy/export path; on rejection it silently degrades to the notice "Clipboard access is unavailable" (CommandCenter.tsx:629). CommandCenter.tsx:1230-1245 — the "Copy argv JSON" button is the only way to get a command out of Anchorage.
- I could NOT resolve this statically. Whether Chromium routes `writeText` through Electron's permission handler (versus auto-granting for a focused document with transient activation) is runtime behaviour I did not execute, and I deliberately did not launch the packaged app on the user's machine.

**Fix.** Run the packaged app and click "Copy argv JSON", or add an Electron test that calls `navigator.clipboard.writeText` in the real renderer. If it is denied, allowlist `clipboard-sanitized-write` in `createSessionSecurityHandlers` for the trusted renderer origin only, or fall back to `electron.clipboard.writeText` over a dedicated IPC channel.

<sub>Verifier (CORRECTED): CORRECTED to state `unverified` rather than `defect`. I strengthened the supporting evidence (I confirmed `clipboard-sanitized-write` really is in Electron 43.2.0's permission enum, which the surveyor asserted but did not cite), but I could not and did not reproduce the runtime failure. Per the default-to-refuted rule this should not be reported as a confirmed defect — it is a testable hypothesis with a concrete one-step verification, which is exactly how the surveyor framed it.</sub>

---

#### The host bridge subscribes to a `containers.changed` event that is not in the preload's allowlist and would throw a TypeError if ever reached

`correctness` · `defect` · effort: trivial

**Impact.** Latent crash rather than a live one. The host bridge advertises a `containers.subscribe` capability whose only implementation would synchronously throw a TypeError out of the store's mount effect. Anyone wiring host push updates — which is exactly the fix the surveyors recommend for the events/polling finding — would hit it immediately, and the contract test at contracts.test.mjs:421 asserts the rejection, so the two halves of the codebase disagree about whether this event exists.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/services/anchorageBridge.ts:1011-1017 — the host bridge's `containers.subscribe` calls `host.subscribe?.("containers.changed", ...)`.
- /home/soya/dev/tools/docker-ui/app/electron/preload.cjs:31-44 — the `EVENTS` set is core.status, operation.started, operation.completed, reconciliation.requested, reconciliation.required, session.{started,output,output.truncated,error,exited}, window.maximized. `containers.changed` is not present. preload.cjs:1018-1021 — `subscribe` calls `fail("event is not supported")` for anything not in the set, and preload.cjs:120-122 — `fail` does `throw new TypeError(message)`.
- app/electron/contracts.mjs:7-42 — `CORE_EVENTS`/`RENDERER_EVENTS` confirm the same allowlist; the only places `containers.changed` appears are three test files (contracts.test.mjs:421 asserting it is rejected, jsonl-rpc.test.mjs:45-47, protocol-contract.test.mjs:775).
- It is dead today only by accident: useAnchorageStore.ts:547-552 calls `bridge.containers.subscribe` exclusively when `bridge.mode === "fixture"`, and takes the `bridge.events.subscribe` branch in host mode.

**Fix.** Either delete the host `containers.subscribe` implementation (it is unreachable) or, if push updates are wanted, add `containers.changed` to CORE_EVENTS/RENDERER_EVENTS and emit it from the core. Do not leave a bridge capability whose only outcome is a thrown TypeError.

---

#### Health state "starting" is collapsed to "—", and unrecognised container states become permanently unmanageable

`correctness` · `defect` · effort: trivial

**Impact.** A container inside its healthcheck start-period is visually indistinguishable from one with no healthcheck at all. Separately, any container whose state string Anchorage does not recognise becomes completely unactionable — no start, stop, restart or delete — labelled 'Unknown (…)' with no escape; a future Docker state value would silently brick those rows. The header counts also do not sum.

**Evidence.**
- /home/soya/dev/tools/docker-ui/app/src/services/anchorageBridge.ts:97-100 — `normalizeHealth` returns the value only for "healthy" or "unhealthy", mapping everything else (including "starting" and "none") to "—". Verified.
- /home/soya/dev/tools/docker-ui/protocol/types.ts:538 — `ContainerProjection.health` is declared `"none"\|"healthy"\|"unhealthy"\|"starting"\|string`. Verified.
- /home/soya/dev/tools/docker-ui/core/internal/core/engine.go:651-663 — `healthFromStatus` explicitly detects `(health: starting)` and emits `"starting"`. Verified.
- /home/soya/dev/tools/docker-ui/app/src/types.ts:22 — `ContainerHealth = "healthy" \| "unhealthy" \| "—"`, so the renderer type cannot represent starting. Verified.
- /home/soya/dev/tools/docker-ui/app/src/utils/containerPresentation.ts:5-25 — `statusKind` therefore classifies a starting-health container as plain "running". Verified.
- /home/soya/dev/tools/docker-ui/app/src/utils/containerPresentation.ts:67-94 — for state "unknown", `primaryContainerAction` returns null and both `canRestartContainer` and `canRemoveContainer` return false: all three controls disabled with no recovery path. Verified, and locked in by containerPresentation.test.ts:51.

**Fix.** Widen `ContainerHealth` to include "starting" and "none", render a distinct pill for starting, and surface healthcheck detail (FailingStreak, last probe output) which is already in the raw inspect document. For unknown states, permit force-remove rather than disabling every control so a user is never stuck.

<sub>Verifier (CONFIRMED): All citations verified verbatim. I added a same-root-cause observation the surveyor missed: the ContainersScreen header counters (useAnchorageStore.ts:1192-1200) also drop paused/restarting/removing/unknown, so the summary line does not add up. Severity held at low.</sub>

---

#### Prune and remove results (space reclaimed, untagged/deleted records) cross the bridge intact and are discarded by the renderer

`ux` · `core-only-not-wired` · effort: trivial

**Impact.** After Clean up the user gets no confirmation of what happened — no "reclaimed 9.3 GB", no list of deleted images. `docker image prune` always prints "Total reclaimed space". The only feedback is rows disappearing on the next refresh.

**Evidence.**
- protocol/types.ts:716-731 — `ImageDeleteRecord { deleted?, untagged? }`, `ImagesActionResult.deleted?`, `prune?: { imagesDeleted, spaceReclaimedBytes }`
- core/internal/core/domain.go:990-1008 — both parsed and populated from the Engine response
- app/src/services/anchorageBridge.ts:442-448 — `normalizeImagesAction` returns `structuredClone(raw)`, so the payload reaches the renderer unaltered
- app/src/store/useAnchorageStore.ts:1309-1314 — `await bridge.images.action({...})` with the result discarded (prune)
- app/src/store/useAnchorageStore.ts:1353-1359 — same for remove; only the local row is filtered at 1362-1364
- app/src/screens/ImagesScreen.tsx:243-250 — no result surface anywhere on the screen

**Fix.** Render `spaceReclaimedBytes` and the deleted/untagged records in a transient result banner on the Images screen; the data is already in hand.

<sub>Verifier (CONFIRMED): Verified the whole chain. protocol/types.ts:716-731 defines ImageDeleteRecord, `deleted?: ImageDeleteRecord[]` and `prune?: { imagesDeleted, spaceReclaimedBytes }`; domain.go:990-1008 parses both from the Engine response; anchorageBridge.ts:442-448 `normalizeImagesAction` does `structuredClone(raw)` so nothing is stripped; useAnchorageStore.ts:1309-1314 and 1353-1359 both `await` and drop the return value; ImagesScreen.tsx has no result surface. Downgraded to low — it is a missing confirmation, not a wrong or unreachable operation.</sub>

---

#### Tag→ID verification before removal is a check-then-act race

`correctness` · `defect` · effort: medium

**Impact.** Between the inspect and the delete, a concurrent `docker pull` or `docker tag` — including one started from Anchorage's own pull session or Command Center — can re-point the tag, and the delete then removes a tag the user never selected. The window is short and no doc claim is actually violated.

**Evidence.**
- docs/architecture.md:190-191 — "Remove an image tag only after resolving that reference and verifying it / still names the requested immutable image ID." (an ordering claim, not an atomicity claim)
- core/internal/core/domain.go:943-970 — Engine path: GET `/images/<reference>/json`, `strings.EqualFold(inspected.ID, params.ID)`, else `image_reference_changed`
- core/internal/core/domain.go:971-975 — then `path = "/v"+apiVersion+"/images/"+url.PathEscape(params.Reference)+"?"+values.Encode()` — DELETE by reference
- core/internal/core/domain.go:1088-1121 — CLI path: `image inspect --format {{.Id}} <reference>` then `image rm ... <reference>`
- Docker semantics: `docker rmi <id>` on an image carrying multiple tags requires `-f`, so deleting by the verified ID is not semantically equivalent to deleting the selected tag

**Fix.** Narrow the doc bullet to state that a concurrent retag can still race, and re-inspect after the DELETE so the receipt can report the race. Deleting by ID is only a valid substitute when the image has exactly one reference.

<sub>Verifier (CORRECTED): The implementation description is exactly right: domain.go:943-970 does GET `/images/<reference>/json`, compares `Id` to `params.ID`, errors `image_reference_changed` on mismatch, then domain.go:971-975 DELETEs by *reference*, not by the verified ID; domain.go:1088-1122 has the identical shape on the CLI path. The race window is real. But the claim that this contradicts the docs is an over-read — docs/architecture.md:190-191 reads "Remove an image tag only after resolving that reference and verifying it still names the requested immutable image ID", which is satisfied literally; it asserts an </sub>

---

#### repoDigests are carried through the whole stack and dropped at the renderer — no DIGEST column

`parity-gap` · `core-only-not-wired` · effort: small

**Impact.** Users cannot see which digest a tag resolves to — the primary way to tell whether `:latest` drifted — and cannot select a digest reference for removal, even though the core would accept one.

**Evidence.**
- protocol/types.ts:675 — `repoDigests: string[]` on ImageProjection (and 451 on ImageDiskUsage)
- core/internal/core/domain.go:654-655 — Engine path populates RepoDigests
- core/internal/core/domain.go:668,723-729,738 — CLI path runs `image ls --no-trunc --digests` and reconstructs `repo@sha256:...`
- app/src/store/useAnchorageStore.ts:97-104 — projectImages reads only `image.repoTags`; grep of app/src finds no consumer of repoDigests outside type declarations
- app/src/screens/ImagesScreen.tsx:13-19 — columns REPOSITORY, TAG, IMAGE ID, CREATED, SIZE, IN USE — no DIGEST
- core/internal/core/domain.go:1424-1430 — `validateImageReference` accepts any non-option, whitespace-free ≤2048-char string, so a digest reference already validates

**Fix.** Add an optional DIGEST column fed from `repoDigests`, and let a digest row project a `reference` of `repo@sha256:...` so remove works unchanged.

<sub>Verifier (CORRECTED): Confirmed the plumbing: protocol/types.ts:675 `repoDigests: string[]`, domain.go:654-655 (Engine) and domain.go:723-729/738 (CLI path, which runs `--digests` and reconstructs `repo@sha256:...`). Confirmed the drop: grep of app/src for repoDigests returns only the type declarations (app/src/types.ts:159, 288) and one test fixture (HostApp.test.tsx:56) — projectImages (useAnchorageStore.ts:97-104) reads only repoTags. ImagesScreen.tsx:13-19 columns are REPOSITORY/TAG/IMAGE ID/CREATED/SIZE/IN USE. CORRECTED on the second half of the claim: remove-by-digest is NOT blocked at the protocol level — v</sub>

---

#### Non-unix-socket contexts fall back to the CLI path, and `ImagesListResult.limitations` is never rendered

`parity-gap` · `defect` · effort: small

**Impact.** Confirmed today: whenever the core returns image-list limitations (which it always does on the CLI fallback), the Images screen shows nothing about them. Conditional: if a remote CLI ever omits Containers, every row degrades to "Unknown" with a dead delete button and a dead Clean up button, with no on-screen explanation.

**Evidence.**
- core/internal/core/engine.go:20 — `var errTransportUnsupported = errors.New("docker context transport is not a local unix socket")`
- core/internal/core/engine.go:86-87 — `if err != nil \|\| parsed.Scheme != "unix" \|\| parsed.Path == "" { return contextEndpoint{}, fmt.Errorf("%w: ...", errTransportUnsupported, ...) }`
- core/internal/core/domain.go:565,572 — both errTransportUnsupported branches route images.list to `imagesListCLI`
- core/internal/core/domain.go:732-735 — `containerCount := int64(-1)` unless `row.Containers` parses as a non-negative integer
- core/internal/core/domain.go:746 — the limitation string already says "Image usage remains unknown when the CLI omits or cannot parse its Containers field"
- app/src/store/useAnchorageStore.ts:107-110 and app/src/screens/ImagesScreen.tsx:62 — usageKnown false ⇒ delete disabled; useAnchorageStore.ts:1289-1298 also makes Clean up a no-op when nothing is reclaimable

**Fix.** Render `ImagesListResult.limitations` on the Images screen the way DashboardScreen renders snapshot limitations, and offer an explicit "usage unknown — remove anyway" confirmation instead of a silently dead button.

<sub>Verifier (CORRECTED): Two halves with different verdicts. CONFIRMED: engine.go:20 and 86-87 reject any endpoint whose scheme is not `unix` with errTransportUnsupported; domain.go:565 and 572 route to imagesListCLI; domain.go:732-735 defaults containerCount to -1 on parse failure; domain.go:746 already admits the limitation in its string; useAnchorageStore.ts:107-110 sets usageKnown false when containers < 0; ImagesScreen.tsx:62 disables on !usageKnown. And `ImagesListResult.limitations` (protocol/types.ts:695) is rendered nowhere — grep shows the only `limitations` consumer in app/src is DashboardScreen.tsx:244-258</sub>

---

#### Dashboard "Prune images" button is always enabled, silently no-ops, and is mislabelled for a dangling-only operation

`ux` · `defect` · effort: trivial

**Impact.** On a machine with no dangling images, clicking "Prune images" produces no dialog, no toast and no error — indistinguishable from a broken button. The label also implies `docker image prune` scope while the action is dangling-only.

**Evidence.**
- app/src/screens/DashboardScreen.tsx:164-171 — `disabled={store.imageMutationPending}` only; label "Prune images"
- app/src/screens/ImagesScreen.tsx:215-223,246 — the Images screen computes and applies a `canCleanUp` gate the Dashboard does not reuse
- app/src/store/useAnchorageStore.ts:1289-1298 — `cleanUpImages` returns silently when no image satisfies `reference === null && usageKnown && reclaimable`, before any confirm or error
- app/src/store/useAnchorageStore.ts:1300-1302 — confirm text: "Remove all unused dangling Docker images (images without tags)?"
- docker image prune --help — bare `prune` is dangling-only; `-a` is all-unused

**Fix.** Reuse the Images screen's `canCleanUp` predicate on the Dashboard button, rename it "Prune dangling images", and emit an explicit "nothing to reclaim" status when the predicate is false.

<sub>Verifier (CONFIRMED): DashboardScreen.tsx:164-171 verified — `disabled={store.imageMutationPending}` is the only gate, whereas ImagesScreen.tsx:215-223 computes a full `canCleanUp` predicate (`hostDomainState.images.status === "ready"` plus at least one image with `reference === null && usageKnown && reclaimable`) and applies it at 246. useAnchorageStore.ts:1289-1298 returns before any confirm or error when nothing qualifies. useAnchorageStore.ts:1300-1302 confirm text is "Remove all unused dangling Docker images (images without tags)?" while the button says "Prune images". Note the button is in HostDashboard (Dash</sub>

---

#### `docker image rm --platform` and multi-platform image handling have no representation

`parity-gap` · `absent` · effort: medium

**Impact.** On a containerd-image-store daemon a single image ID can hold several platform variants. Anchorage treats every image as single-platform, so a user cannot see or remove one variant and size figures silently aggregate across variants.

**Evidence.**
- docker image rm --help (29.7.1) — `--platform strings  Remove only the given platform variant. Formatted as "os[/arch[/variant]]" (e.g., "linux/amd64")`
- docker image ls --help — `--tree  List multi-platform images as a tree (EXPERIMENTAL)`
- protocol/types.ts:115-126 — the remove variant has no platform field
- core/internal/core/domain.go:971-975 and 1114-1122 — neither removal path emits a platform parameter
- protocol/types.ts:671-686 — `ImageProjection` carries no platform or manifest information, so the UI cannot display which variants an image holds

**Fix.** Expose the manifest/platform list on `ImageProjection` so the UI can at least show which variants an image holds before claiming its size; add `platform` to the remove variant afterwards.

<sub>Verifier (CONFIRMED): `docker image rm --help` on 29.7.1 confirms `--platform strings  Remove only the given platform variant. Formatted as "os[/arch[/variant]]"`. protocol/types.ts:115-126 has no platform field on the remove variant; domain.go:971-975 (Engine) and 1114-1122 (CLI) emit no platform parameter; ImageProjection (protocol/types.ts:671-686) carries no manifest or platform information. All verified. Severity low is correct — this daemon is not on the containerd image store, so there is no live multi-variant case here.</sub>

---

#### Images referenced only by digest are silently dropped from images.list while still counted as reclaimable on the Dashboard

`correctness` · `defect` · effort: small

**Impact.** Images pulled or pinned by digest — the normal shape for immutable deploys — are invisible in the Images screen and therefore undeletable through it, while the Dashboard counts their bytes toward reclaimable space. The two screens disagree about how many images exist (231 vs 233) with no explanation. This is a smaller set than the dangling problem but it is a silent omission rather than a visible dead button.

**Evidence.**
- core/internal/core/domain.go:632-635 — `if !all && len(item.RepoTags) == 0 && !danglingIDs[item.ID] { continue }` — an image with no repoTags that is not in the dangling result set is discarded outright
- app/src/services/anchorageBridge.ts:912 — `all` is hardcoded false and there is no `-a` toggle anywhere in the UI, so this branch is always taken
- MEASURED on this daemon: `/v1.55/images/json?all=false` returns 233 records; the merge keeps 231. The two discarded are `sha256:274331e27237…` (RepoDigests `["nginx@sha256:123827f4…"]`, 62 MB) and `sha256:b65be49cfd82…` (RepoDigests `["node@sha256:a22207f2…"]`, 233 MB), both with Containers 0
- MEASURED: `docker image ls -a --no-trunc` DOES show both, as `nginx  <none>  sha256:274331e2…` and `node  <none>  sha256:b65be49c…`
- app/src/screens/DashboardScreen.tsx:99-102 — the Dashboard's reclaimable sum reads `snapshot.diskUsage.images` (from /system/df, 233 records), which includes both, so the Dashboard counts ~295 MB as reclaimable for images the Images screen will not render

**Fix.** Keep untagged-but-digested images in the merge (they are top-level leaves, not intermediate layers) and render them with the repository name derivable from `repoDigests`, exactly as `docker image ls -a` does. Add the `-a` toggle from the includeDangling finding so the intermediate-layer case stays opt-in.

---

#### `diskUsage.builderSizeBytes` reads a /system/df field this daemon does not return, so the Dashboard's Build cache bar may always be 0

`correctness` · `defect` · effort: small

**Impact.** If `BuilderSize` is genuinely gone from modern API versions, the Dashboard's Build cache bar reads 0 B on every BuildKit host and the Reclaimable percentage is computed against a too-small denominator. On this host both are legitimately zero, so the bug is invisible here.

**Evidence.**
- core/internal/core/domain.go:108-115 — `type engineDiskUsage struct { LayersSize int64 `json:"LayersSize"`; BuilderSize int64 `json:"BuilderSize"`; ... }`
- core/internal/core/domain.go:188 — `LayersSizeBytes: raw.LayersSize, BuilderSizeBytes: raw.BuilderSize`
- app/src/screens/DashboardScreen.tsx:139-142 — the Build cache disk bar is `bytes: snapshot.diskUsage.builderSizeBytes`; DashboardScreen.tsx:215-220 also uses it in the Reclaimable percentage denominator
- MEASURED: `Object.keys()` of this daemon's `/v1.55/system/df` response is `['LayersSize','Images','Containers','Volumes','BuildCache','ImageUsage','ContainerUsage','VolumeUsage','BuildCacheUsage']` — there is no `BuilderSize` key; the newer aggregate is `BuildCacheUsage` (an object, `{}` here)
- NOT VERIFIED: this host has zero build cache, so I cannot distinguish "the field was removed from the API" from "the field is omitted when zero". Confirming this requires a daemon with a non-empty BuildKit cache, which I did not have.

**Fix.** Read `BuildCacheUsage` (`{TotalSize, Reclaimable, ...}`) alongside `BuilderSize` and prefer it when present, the same way `ImageUsage` should be preferred over the per-image sum. Verify against a daemon with a populated BuildKit cache before shipping.

---

#### deleteContainer races the poll: bypasses the single-flight guard and a stale selectedId closure ejects the user from a different container

`correctness` · `defect` · effort: small

**Impact.** Roughly one delete in a hundred flickers: the removed row reappears for up to 2 s before the next poll corrects it. The stale-selectedId ejection is real code but requires a sub-50 ms user action on a fast host; it becomes plausible on slow or CLI-fallback contexts.

**Evidence.**
- app/src/store/useAnchorageStore.ts:881-892 — post-delete reconciliation calls `bridge.containers.list(...)` directly, bypassing `refreshContainers`/`containerRefreshRef` (the single-flight guard at :490-492).
- app/src/store/useAnchorageStore.ts:606-615 — the 2 s poll keeps calling `refreshContainers()`, which also calls `setContainers`; two concurrent list requests, last writer wins.
- app/src/store/useAnchorageStore.ts:880, :894-899, dep array :909 — `selectedId` is read from the closure captured when the delete was initiated.
- Measured by verifier: core containers.list warm latency = 22.8-23.8 ms (76 containers, Engine API path), so the race window is ~1% of the 2,000 ms poll period.

**Fix.** Route post-delete reconciliation through `refreshContainers()` so it shares the single-flight guard and last-writer ordering, and use the functional form `setSelectedId(current => current === container.id ? null : current)` so the guard reflects current selection.

<sub>Verifier (CORRECTED): The single-flight bypass and the stale-closure read are CONFIRMED as code. Both consequences are overstated. (1) Re-insertion of a deleted row requires a poll issued before the removal to resolve after the delete's reconciliation — window = list latency / 2,000 ms, and I measured containers.list at 23 ms warm through the real core against this host's 76 containers, so ~1% per delete, self-correcting on the next 2 s tick. (2) Ejection from container B requires the user to select another container inside that same ~30-50 ms window between `await bridge.containers.list` being issued and resolving</sub>

---

#### runMutation's post-mutation reconcile can await a list request that was issued before the mutation

`correctness` · `defect` · effort: small

**Impact.** Occasionally a Stop completes and the row briefly shows Running with a Stop button again until the next 2 s poll. Users may double-issue actions. Rare on a fast local daemon, likely on slow/CLI-fallback contexts.

**Evidence.**
- app/src/store/useAnchorageStore.ts:772-785 — after the operation resolves, `runMutation` does `await refreshContainers()` and treats the result as authoritative.
- app/src/store/useAnchorageStore.ts:490-492 — `if (containerRefreshRef.current) return containerRefreshRef.current;` — the call is deduped into any in-flight request.
- app/src/store/useAnchorageStore.ts:788-794 — `pendingIds` is cleared in the `finally`, re-enabling the buttons on the strength of that possibly-stale list.
- Measured by verifier: containers.list warm = 23 ms through the real core, against a 2,000 ms poll period.
- core/internal/core/engine.go:300 — the CLI-fallback list path allows 30 s, which is where this becomes likely rather than rare.

**Fix.** Give `refreshContainers` a `force` mode that queues behind rather than dedupes into an in-flight request, and use it for post-mutation reconciliation; the poll keeps the deduping behaviour.

<sub>Verifier (CORRECTED): The logic hole is real — `refreshContainers` returns the already-in-flight promise rather than starting a fresh request, so the 'reconciliation' can be a snapshot older than the mutation. But the probability is list-latency / poll-period = 23 ms / 2,000 ms ~= 1.2% on this host, and the next 2 s poll always corrects it. It matters materially only where containers.list is slow (CLI fallback with a 30 s ceiling, remote contexts). Severity medium -> low.</sub>

---

#### Escape and the close button do not dismiss the Command Center until the cancel RPC round-trips

`ux` · `defect` · effort: trivial

**Impact.** Normally imperceptible. If the core is wedged or slow, Escape and × appear dead for up to 30 s while the modal keeps trapping focus.

**Evidence.**
- app/src/components/CommandCenter.tsx:808-826 — `close()` awaits `bridge.sessions.cancel({ sessionId, gracePeriodMs: 1_500 })` before calling `store.closeCommandCenter()`.
- app/src/components/CommandCenter.tsx:831-834 (Escape) and :875-882 (× button) both route through `void close()`.
- core/internal/core/session.go:696-715 — cancel returns as soon as `requestCancellation` is invoked; :738-752 the SIGKILL after the grace period runs in a separate goroutine. The RPC does not block for the grace period.
- app/electron/main.mjs:686-691 — session.cancel IPC timeout is 30,000 ms, which is the real worst case.
- app/src/components/Shell.tsx:406 — the dialog is conditionally mounted on `store.commandCenterOpen`, so it stays modal and focus-trapped (CommandCenter.tsx:828-853) until that flag flips.

**Fix.** Flip `store.closeCommandCenter()` immediately and fire the cancel as a detached best-effort promise; the host already owns bounded session lifetime, as the comment at CommandCenter.tsx:814-815 acknowledges.

<sub>Verifier (CORRECTED): The await-before-close is CONFIRMED. The '1.5 s grace period' part is REFUTED: core/internal/core/session.go:696-715 shows `sessionManager.cancel` sends SIGTERM and returns `{accepted:true,state:"canceling"}` immediately, serving the grace period in a detached goroutine (:738-752). So the normal round trip is milliseconds, not 1.5 s. The genuine residual is the 30 s worst case if the core is unresponsive (app/electron/main.mjs:686-691). Severity medium -> low.</sub>

---

#### FixedRowWindow re-renders per raw scroll event and loses scroll position when the list crosses the virtualization threshold

`performance` · `defect` · effort: small

**Impact.** On a host whose container/image count oscillates around 200 (or when a filter moves it across the boundary), the list can render a blank window at an arbitrary scroll position until the user scrolls again. Scroll perf itself is fine.

**Evidence.**
- app/src/components/FixedRowWindow.tsx:83-85 — `setScrollTop(event.currentTarget.scrollTop)` with no coalescing; but scrollTop is local state (:35) so only this subtree re-renders, and Blink already caps scroll dispatch at one per frame.
- app/src/components/FixedRowWindow.tsx:39 — `const virtualized = items.length > threshold` with threshold 200 (:22); crossing it swaps between structurally different subtrees (:87-97 vs :99-125), unmounting and remounting every row.
- app/src/components/FixedRowWindow.tsx:57-68 — on becoming virtualized the effect returns early via `if (host.scrollTop <= maximum) return;` without pushing the DOM scrollTop into state, leaving state at 0 while the DOM is scrolled — the window then renders the wrong rows.
- app/src/components/FixedRowWindow.tsx:51-54 — no window.resize fallback when ResizeObserver is undefined (immaterial in Electron/Chromium 150).
- app/src/screens/ContainersScreen.tsx:206 — the window is unmounted entirely whenever a filter empties the list, discarding scroll.

**Fix.** Always render the virtualized structure and widen the window to cover the whole list below the threshold so the DOM shape never changes; on transition, seed `scrollTop` state from `hostRef.current.scrollTop` rather than leaving it at 0.

<sub>Verifier (CORRECTED): Split verdict. The scroll-throttling claim is REFUTED: Blink coalesces scroll events to at most one dispatch per frame, so `setScrollTop` per scroll event already produces exactly one render per frame — a rAF wrapper would change nothing — and `scrollTop` is FixedRowWindow-local state, so the blast radius is the 28 windowed rows, not the app. '60-120 re-renders per second' is not achievable. The ResizeObserver-fallback claim is REFUTED as immaterial: the host renderer is Chromium 150 where ResizeObserver always exists. What IS confirmed is a genuine state/DOM desync at the threshold: when the </sub>

---

#### hostDomainState transitions allocate a new object unconditionally, adding two extra full-tree renders per domain refresh

`performance` · `defect` · effort: small

**Impact.** Three redundant whole-application renders every 10 s while the Images or Volumes screen is open, plus a redundant summary recompute. Measurable in a profiler, invisible to a user.

**Evidence.**
- app/src/store/useAnchorageStore.ts:339-342, 347-350 — `refreshSnapshot` always spreads a new object, even when the status is unchanged; identical pattern in `refreshImages` (:393-396, 402-405) and `refreshVolumes` (:448-451, 456-459).
- app/src/store/useAnchorageStore.ts:639 — 10 s interval while the images/volumes view is open, so each cycle is loading-render + ready-render + setImages/setVolumes render.
- app/src/store/useAnchorageStore.ts:1254-1282 — `imageSummary` rebuilds a Map and runs two reduce plus two filter passes whenever `images` identity changes; `projectImages` (:97-129) always allocates fresh objects.
- Correction: app/src/screens/ImagesScreen.tsx:21-32 renders through FixedRowWindow, so the row DOM is bounded to ~28 regardless of image count.

**Fix.** Return `current` from the `setHostDomainState` updater when the status is unchanged, and skip `setImages`/`setVolumes` when the projected list is structurally equal to the previous one.

<sub>Verifier (CORRECTED): The code observations are all CONFIRMED, but the impact statement is wrong and I corrected it. Three full-tree renders per 10 s is 0.3 renders/s — an order of magnitude below the 1 Hz clock the same finding calls out, so it cannot be 'the dominant idle CPU cost on those screens'. The `imageSummary` recompute is also bounded: ImagesScreen renders through FixedRowWindow, so with this host's 1,760 images only ~28 rows exist in the DOM and the Map/reduce/filter passes over 1,760 entries take ~1 ms. True, but immaterial.</sub>

---

#### TerminalSurface writes to a ref during render

`correctness` · `defect` · effort: trivial

**Impact.** Mutating a ref during render is unsafe under concurrent rendering: a render React discards still mutates the ref, so the committed tree can hold callbacks from a render that never committed.

**Evidence.**
- app/src/components/CommandCenter.tsx:119-129 — `const callbackRef = useRef({onAccepted,onInput,onDimensions,registerSink});` followed by a bare `callbackRef.current = {…}` statement in the component body, outside any effect.
- app/src/main.jsx:29-33 — the app is wrapped in React.StrictMode, which double-invokes render in development.
- app/src/components/CommandCenter.tsx:202-217 — the sink registered in the effect reads `callbackRef.current` asynchronously from xterm's write callback.

**Fix.** Move the assignment into a `useEffect`/`useLayoutEffect` with the callbacks as dependencies.

<sub>Verifier (CONFIRMED): Confirmed verbatim, including StrictMode. It is latent today (React discards the extra render's ref write only in ways that happen to be harmless here) but is an explicit React rule violation that breaks under Offscreen/useTransition.</sub>

---

#### Per-container log, inspect, and stats caches grow across selections with no eviction

`performance` · `defect` · effort: small

**Impact.** In a long session an operator browsing many containers retains ~75 KB of log lines plus ~9 KB of inspect per container ever selected. Single-digit megabytes on a busy host — a slow leak, not a crash risk.

**Evidence.**
- app/src/store/useAnchorageStore.ts:222-224 — `logsByContainer` bounded at 500 lines per container (:709, :1059) but with no cap on the number of keys.
- app/src/store/useAnchorageStore.ts:247-255 — `inspectByContainer`, `statsByContainer` and `detailErrors` have the same unbounded key growth.
- Entries are removed in exactly two places: `deleteContainer` (:865-879) and the blanket wipe on a container reconciliation event (:573). Selecting containers never evicts.
- Measured by verifier through core/bin/anchorage-core against this host: containers.inspect result = 9,250 bytes of which document = 6,850 bytes; containers.stats result = 2,543 bytes of which document = 1,815 bytes.

**Fix.** Bound these maps to the last N selected container ids (LRU, N ~= 5-10), evicting on selection change.

<sub>Verifier (CORRECTED): The unbounded key growth is CONFIRMED. The size estimate is corrected by measurement: I fetched a real containers.inspect through the core against this host and the raw `document` is 6,850 bytes, not '20-200 KB'; a stats sample is 2,543 bytes total. The dominant term is logs (500 lines x ~150 B ~= 75 KB per container), so 100 browsed containers is roughly 8 MB, not 'tens of megabytes'.</sub>

---

#### Vite dev server binds 0.0.0.0 and serves the desktop health token to the LAN

`security` · `defect` · effort: trivial

**Impact.** Anyone on the same network can fetch the developer's in-progress renderer source and read the dev-server health token. Development only; production is unaffected and the token's protective value is already backstopped by the loopback URL check.

**Evidence.**
- app/vite.config.mjs:47-54 — `server: { host: "0.0.0.0", allowedHosts: ["terminal.local"], warmup: {…} }`.
- app/vite.config.mjs:7-26 — the `anchorage-desktop-health` middleware answers any GET of DESKTOP_HEALTH_PATH with the 64-hex token in both the body and an `X-Anchorage-Dev-Server` header, with no origin or auth check.
- app/vite.config.mjs:28-39 — `developmentCspPlugin` carries `apply: "serve"`, and the health plugin only defines `configureServer`, so neither reaches the production build. Development-only.
- Mitigation found by verifier: app/electron/main.mjs:108-121 restricts the renderer URL to loopback via `validateLoopbackRendererUrl`, so the leaked token cannot be used to point the desktop at a LAN-hosted renderer.

**Fix.** Default `server.host` to 127.0.0.1 and make the all-interfaces bind opt-in via an env flag; require a matching `X-Anchorage-Dev-Server` request header or a loopback remote-address check before returning the token.

<sub>Verifier (CONFIRMED): Code confirmed exactly, including that the health plugin only registers `configureServer` so it never reaches the production build. Threat-model note: the attacker is anyone on the developer's LAN and they do NOT need Docker socket access, so this passes the threat test — but the gain is limited. The token only proves dev-server identity to app/electron/main.mjs:108-121, which independently restricts the renderer URL to loopback (`validateLoopbackRendererUrl`), so possessing the token does not let a LAN host substitute a renderer. The real gain is disclosure of the in-progress renderer source.</sub>

---

#### Electron main re-serializes every core event payload solely to measure its byte size

`performance` · `defect` · effort: trivial

**Impact.** A few percent of one main-process core under heavy session output, on the same thread that drains the core's stdout pipe. Real but small.

**Evidence.**
- app/electron/contracts.mjs:1074-1088 — `assertEventPayloadSize` does JSON.stringify(value) + Buffer.byteLength(serialized) and discards the string.
- app/electron/contracts.mjs:1611 — `validateCoreEventEnvelope` calls it for every core event, including every session.output.
- app/electron/main.mjs:778-788 — every core notification goes through that validator on the main process event loop.
- core/internal/core/session.go:24,443-450 — session.output events carry up to 16 KiB each.
- Bound: app/src/store/useAnchorageStore.ts:1111 requests a 64 KiB ack window with one ack RPC per event, so sustained chunk rates are in the hundreds per second at best.

**Fix.** Pass the byte length the RPC client already knows from the raw line into the validator rather than re-serializing the parsed object.

<sub>Verifier (CORRECTED): The code is CONFIRMED: assertEventPayloadSize JSON.stringifies and discards the string, and validateCoreEventEnvelope calls it for every core event including every session.output. But the magnitude does not support 'roughly doubling the per-chunk CPU' as a material concern: re-stringifying a 16 KiB string payload is tens of microseconds in V8, so even at 1,000 chunks/s this is a few percent of one core, and the ack window makes 1,000 chunks/s unreachable in practice. Severity medium -> low.</sub>

---

#### JSONL client does O(n) string slicing and a full Buffer.byteLength rescan per decoded line

`performance` · `defect` · effort: small

**Impact.** Repeated work on the main process event loop when many lines arrive in one pipe read. Harmless for single-line list responses.

**Evidence.**
- app/electron/jsonl-rpc.mjs:113 — `this.#buffer += this.#decoder.write(chunk)`.
- app/electron/jsonl-rpc.mjs:115-127 — per newline: `buffer.slice(0,i)`, `buffer.slice(i+1)` (copies the whole remainder) and `Buffer.byteLength(this.#buffer)` (full rescan of the remainder).

**Fix.** Buffer as Buffer objects and scan for 0x0A with indexOf, decoding only the completed line; track pending bytes arithmetically instead of recomputing byteLength on the residual.

<sub>Verifier (CONFIRMED): Confirmed as written and correctly self-scoped as immaterial. Worth noting the same code has a minor correctness wrinkle the surveyor did not mention: `#bufferBytes` is incremented by the raw chunk length but reset to `Buffer.byteLength(this.#buffer)` after each line, discarding any partial multi-byte sequence held inside the StringDecoder — harmless for the 8 MiB guard it feeds.</sub>

---

#### SIGKILL is sent to the session process group after the child has already been reaped (PID/PGID reuse race)

`correctness` · `defect` · effort: trivial

**Impact.** Once the leader is reaped its pid (and therefore the pgid) can be recycled; the unconditional SIGKILL can then land on an unrelated process group belonging to the same user. Very low probability, high blast radius if it happens.

**Evidence.**
- core/internal/core/session.go:314-322 — after `s.command.Wait()` returns (child reaped) the code calls `signalProcessGroup(s.pid, syscall.SIGKILL)` unconditionally.
- core/internal/core/pty_linux.go:89-94 — `signalProcessGroup` issues `syscall.Kill(-pid, signal)` against the group id equal to the reaped leader's pid.

**Fix.** Send the group SIGKILL before Wait() returns, or from the cancellation path only, and skip it once ProcessState is set; alternatively track the group with a pidfd so the signal cannot be misdirected.

<sub>Verifier (CONFIRMED): Confirmed as code: `waitErr := s.command.Wait()` at session.go:315 reaps the child, and the unconditional `signalProcessGroup(s.pid, syscall.SIGKILL)` at :321 follows. Genuinely a use-after-reap. Practically it requires pid-space wraparound plus a new process becoming a group leader on exactly that pid within the window between Wait() returning and the kill — unobservable in practice, but the consequence (SIGKILL to an unrelated process group owned by the same user) justifies fixing.</sub>

---

#### All Electron fuses left at insecure defaults: RunAsNode, NODE_OPTIONS and --inspect enabled; ASAR integrity and OnlyLoadAppFromAsar disabled

`security` · `absent` · effort: small

**Impact.** The shipped 220 MB `anchorage` binary doubles as a general-purpose Node interpreter, and neither of the two shipped executables is integrity-checked at load. All of this only matters to an attacker who already has user-level code execution — which on a Docker-socket-holding account is already game over — so the value is post-compromise hardening and reducing the binary's usefulness as a living-off-the-land tool.

**Evidence.**
- Decoded by verifier from both binaries using the sentinel dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX: schemaVersion=1, wire="101100011" — RunAsNode=ENABLED, EnableNodeOptionsEnvironmentVariable=ENABLED, EnableNodeCliInspectArguments=ENABLED, EnableEmbeddedAsarIntegrityValidation=DISABLED, OnlyLoadAppFromAsar=DISABLED.
- `grep -rn 'fuses\|RunAsNode\|OnlyLoadAppFromAsar\|asarIntegrity\|EnableEmbeddedAsarIntegrityValidation' app/scripts app/electron app/electron-builder.yml tools` returns zero matches — no afterPack hook flips any fuse.
- Correction: app/package-lock.json:584-586 does contain @electron/fuses 1.8.0 as a transitive electron-builder dependency; it is present but unused.
- app/electron-builder.yml:4 sets `asar: true` (archiving only, not integrity validation).
- app/scripts/package-evidence-policy.mjs:91-102 PACKAGED_PACKAGE_JSON_KEYS enumerates the required packaged package.json keys and ElectronAsarIntegrity is absent, so the policy codifies its absence.
- Threat-model note: EnableEmbeddedAsarIntegrityValidation is only enforced on macOS/Windows, so that specific fuse is not achievable on this Linux target; RunAsNode, NODE_OPTIONS, --inspect and OnlyLoadAppFromAsar are enforceable today.

**Fix.** Add @electron/fuses (already in the tree) and an electron-builder afterPack hook flipping RunAsNode=false, EnableNodeOptionsEnvironmentVariable=false, EnableNodeCliInspectArguments=false, OnlyLoadAppFromAsar=true, EnableCookieEncryption=true. Extend tools/generate-security-evidence.mjs to decode the fuse wire from the packaged binary and assert the expected state as a real check. Document that EnableEmbeddedAsarIntegrityValidation is macOS/Windows-only.

<sub>Verifier (CORRECTED): Facts fully reproduced: I decoded the fuse wire from both app/release/linux-unpacked/anchorage and app/node_modules/electron/dist/electron and got schemaVersion 1, wire "101100011" in both — RunAsNode ENABLED, EnableCookieEncryption disabled, EnableNodeOptionsEnvironmentVariable ENABLED, EnableNodeCliInspectArguments ENABLED, EnableEmbeddedAsarIntegrityValidation disabled, OnlyLoadAppFromAsar disabled. No fuse-flipping code exists anywhere. One evidence correction: `@electron/fuses@1.8.0` IS present in app/package-lock.json:584-586 as an electron-builder transitive dependency — it is simply ne</sub>

---

#### Core binary sha256 is pinned into manifest.json that ships beside the binary but is never read or verified at launch

`security` · `core-only-not-wired` · effort: small

**Impact.** The package advertises an integrity control it does not enforce. Not an escalation path (the attacker needs write access to the install tree, i.e. already user code execution), but the manifest sitting unread next to the binary makes the omission look like an oversight, and combined with OnlyLoadAppFromAsar=false neither shipped executable is verified at launch.

**Evidence.**
- app/build/core/manifest.json records core.sha256 f39a914f… and core.path core/anchorage-core; app/electron-builder.yml:23-28 ships it as extraResources into resources/core/manifest.json.
- `grep -rn manifest app/electron/ app/src/` returns only app/electron/security-policy.mjs:101 (`manifest-src 'self'`); the only readers are app/scripts/package-desktop.mjs at build time.
- app/electron/core-path.mjs:53-62 — packaged builds return `join(resourcesPath, "core", name)` with no hashing; `assertExecutableFile` (realpath/lstat/statSync/X_OK) is applied only to the dev override at :52.
- app/electron/main.mjs:761-770 — the resolved path is handed straight to `new CoreSupervisor({ binaryPath, … })`; app/electron/core-supervisor.mjs:164-178 spawns it with no integrity check.
- README.md:177 — packaging bundles "a freshly built, stripped, hash-verified Go core", which is accurate at build time and misleading as a runtime claim.

**Fix.** Read resources/core/manifest.json in main.mjs before constructing CoreSupervisor, sha256 the resolved binary, and refuse to start on mismatch; bind the manifest itself with an ASAR-embedded expected hash. Until then, reword README.md:177 to "hash-verified during packaging".

<sub>Verifier (CORRECTED): Facts CONFIRMED: `grep -rn manifest app/electron/ app/src/` returns only the CSP `manifest-src 'self'` string at security-policy.mjs:101; core-path.mjs:55-62 returns join(resourcesPath,'core',name) with no hashing, and assertExecutableFile is applied only to the dev ANCHORAGE_CORE_BINARY override (:52). Severity medium -> low on the threat-model test: replacing resources/core/anchorage-core requires write access to the installed tree, which is already user-level code execution and therefore already Docker socket access. What genuinely survives is the documentation-accuracy problem — README.md:</sub>

---

#### `allowScripts` allowlist in package.json is inert — no allow-scripts enforcer is installed and lifecycle scripts run unrestricted

`security` · `wired-but-gated` · effort: small

**Impact.** The field reads as a hardened supply-chain control and is enforced as a release requirement, but nothing consumes it: every dependency's install scripts run with full user privileges on `npm install`. A reviewer auditing this repo would reasonably conclude install scripts are allowlisted when they are not. False assurance, not a live exposure.

**Evidence.**
- app/package.json — `"allowScripts": { "esbuild@0.25.12": true }` (the @lavamoat/allow-scripts convention), verified present.
- `grep -c 'lavamoat\|allow-scripts' app/package-lock.json` = 0 and `ls app/node_modules/.bin \| grep -i 'allow-scripts\|lavamoat'` is empty — the enforcer is not installed.
- app/.npmrc contains only `fund=false` and `audit=false`; there is no `ignore-scripts=true`, which is what would make an allowlist meaningful.
- Verified by verifier: exactly three lockfile packages have hasInstallScript — electron-winstaller, esbuild, fsevents.
- app/scripts/package-evidence-policy.mjs:91-102 — PACKAGED_PACKAGE_JSON_KEYS requires `allowScripts` in the packaged package.json and canonicalPackagedPackageJson throws if absent, so the release gate mandates a field that does nothing.
- Mitigating context verified by verifier: all 513 lockfile entries carry integrity hashes and all resolved URLs are registry.npmjs.org.

**Fix.** Either make it real — add @lavamoat/allow-scripts, set `ignore-scripts=true` in app/.npmrc, run `allow-scripts` as a postinstall — or delete the field and remove it from PACKAGED_PACKAGE_JSON_KEYS. Separately, drop `audit=false` from app/.npmrc so install-time advisories are visible.

<sub>Verifier (CORRECTED): Every fact CONFIRMED: `grep -c 'lavamoat\|allow-scripts' app/package-lock.json` = 0, no such binary in node_modules/.bin, app/.npmrc contains only `fund=false` and `audit=false` with no ignore-scripts, and exactly three lockfile entries have hasInstallScript (electron-winstaller, esbuild, fsevents). Severity medium -> low: with all 513 lockfile entries carrying integrity hashes and every `resolved` URL on registry.npmjs.org (verified), there is no live exposure — this is a false-assurance artifact and a release gate that enshrines a no-op, not an exploitable condition.</sub>

---

#### Exact-pin policy covers only 3 of 18 devDependencies; Vite is two majors behind with no currency gate

`security` · `defect` · effort: small

**Impact.** Low today. The risk is directional: Vite 6 will fall out of security support, and Vite's historical CVEs (dev-server server.fs traversal, esbuild dev-server CORS) hit exactly the `npm run dev` workflow used daily on a machine that also runs Docker — which compounds with the 0.0.0.0 dev-server bind found separately.

**Evidence.**
- app/scripts/package-evidence-policy.mjs:5-9 — REQUIRED_EXACT_DEV_DEPENDENCIES pins exactly electron 43.2.0, electron-builder 26.15.3, lucide-react 1.28.0.
- app/scripts/package-evidence-policy.mjs:11-22 — validatePinnedDevDependencies iterates only that three-entry map; the other 15 direct devDependencies are unconstrained by policy.
- Verified: app/package.json declares 18 devDependencies, all exact strings, including vite 6.4.3 and jsdom 27.0.1.
- app/scripts/package-desktop.mjs:1511-1520 — the packaged asar contains no node_modules, so none of these are runtime-reachable.
- docs/release-report.md:149-150 accurately scopes the claim to those three packages.

**Fix.** Either extend REQUIRED_EXACT_DEV_DEPENDENCIES to cover every direct devDependency (the versions are already exact, so this only adds enforcement), or add a staleness gate that fails the release when any direct devDependency trails registry `latest` by a full major. Plan the Vite upgrade before the next release cycle.

<sub>Verifier (CONFIRMED): Verified: REQUIRED_EXACT_DEV_DEPENDENCIES contains exactly electron, electron-builder and lucide-react, validatePinnedDevDependencies iterates only that map, and app/package.json declares 18 devDependencies all as exact strings. The surveyor's own scoping is correct and I agree with it: nothing here is runtime-reachable (the packaged asar has no node_modules) and nothing has an open advisory today. This is a directional/process gap.</sub>

---

#### Prebuilt core and AppImage binaries present in the tree with no reproducibility verification

`security` · `defect` · effort: medium

**Impact.** The manifest presents a tight hash chain whose root is unanchored: a consumer can confirm every hash is self-consistent and still cannot confirm the binaries correspond to the source in this tree. The Go build flags make bit-for-bit reproduction plausible, so this is cheap to close.

**Evidence.**
- core/bin/anchorage-core (6,852,756 bytes) and app/release/Anchorage-0.1.0-x86_64.AppImage (93,329,326 bytes) exist on disk with hashes matching app/build/core/manifest.json and app/release/release-verification.json.
- /home/soya/dev/tools/docker-ui/.gitignore lines 1-6 ignore app/release/, core/bin/ and app/build/core/anchorage-core — verified; the binaries are untracked.
- app/scripts/package-desktop.mjs:1337-1350 builds the core with -trimpath -buildvcs=false '-ldflags=-s -w -buildid=' and CGO_ENABLED=0 — reproducibility-friendly flags (verified).
- No gate rebuilds and byte-compares; package-desktop.mjs:1471-1483 only verifies that the packaged core matches the staged core it just built — a same-run tautology.
- artifacts/host-candidate/host-candidate.json binds electronBinary sha256 84e1078c… computed locally from a downloaded prebuilt, not checked against an upstream-published checksum.

**Fix.** Add a release step that rebuilds the Go core into a temp dir with identical flags and asserts byte equality against the staged binary, recording a `coreReproducible` check in the manifest. Verify the downloaded Electron dist against upstream SHASUMS256.txt and record that comparison. Publish the release-verification.json receipt hash out of band.

<sub>Verifier (CORRECTED): All facts CONFIRMED: the build flags at package-desktop.mjs:1338-1345 are `-trimpath -buildvcs=false -ldflags=-s -w -buildid=` with CGO_ENABLED=0; .gitignore lines 1-6 exclude app/release/, core/bin/ and app/build/core/anchorage-core; and nothing rebuilds and byte-compares. Severity medium -> low: because the binaries are untracked they are never distributed through VCS, so the exposed population is 'whoever receives this working directory', and the unanchored root is a real but narrow evidence-quality gap rather than a distribution risk.</sub>

---

#### Evidence-bundle listing in the release-gates doc names files that do not exist

`process` · `defect` · effort: trivial

**Impact.** Anyone auditing the release against its own gate document will look for artifacts that were never produced and miss three that were. This document is the project's stated definition of releasability, so drift erodes the credibility of an evidence story that is otherwise verifiably accurate.

**Evidence.**
- docs/parity-and-release-gates.md:222 lists `command-tree.json` under artifacts/docker/; `ls artifacts/docker` shows capability-generation.json, capability-ledger.json, conformance-results.json, read-only-acceptance.json, read-only-results.json, system-capabilities.json — no command-tree.json.
- docs/parity-and-release-gates.md:233 lists `electron-security.json` under artifacts/security/; `ls artifacts/security` shows dependency-audit.json and electron-config.json only. The pipeline reads electron-config.json (app/scripts/package-desktop.mjs:126 ELECTRON_SECURITY_EVIDENCE, written by tools/generate-security-evidence.mjs:29).
- docs/parity-and-release-gates.md:221-225 omits capability-generation.json, system-capabilities.json and read-only-results.json, which the pipeline does require (app/scripts/package-desktop.mjs:542-543).

**Fix.** Regenerate the tree listing in docs/parity-and-release-gates.md:214-235 from the actual artifacts/ directory, or have the packaging script emit it so it cannot drift.

<sub>Verifier (CONFIRMED): Verified by listing the directories. artifacts/docker contains capability-generation.json, capability-ledger.json, conformance-results.json, read-only-acceptance.json, read-only-results.json, system-capabilities.json — no command-tree.json. artifacts/security contains dependency-audit.json and electron-config.json — no electron-security.json. Both mismatches are exactly as claimed, and three produced files are indeed omitted from the doc.</sub>

---

#### Evidence capture harness drives the live-Docker app over CDP with --remote-allow-origins=*

`security` · `defect` · effort: trivial

**Impact.** Hygiene only. For the duration of an evidence capture, a same-user local process could drive a live-Docker renderer — but such a process already has the Docker socket. Never ships.

**Evidence.**
- tools/capture-host-candidate.mjs:487-489 spawns Electron with `--remote-debugging-port=${debuggingPort}` and `--remote-allow-origins=*`.
- tools/capture-host-candidate.mjs:479-481 sets ANCHORAGE_CORE_BINARY in the child environment; artifacts/host-candidate/host-candidate.json records bridgeMode "host" with live checks including literal-cli-run.
- tools/capture-design-parity.mjs:410 uses the same pattern but against fixture data, so it is inert there.
- The port comes from freePort() and Chromium binds --remote-debugging-port to loopback by default — same-host only.
- Threat-model refutation by verifier: a browser page cannot read the DevTools /json endpoint (no CORS headers, opaque response), so it cannot discover the target UUID required to open the debugger WebSocket; and a same-user local process already has Docker socket access.

**Fix.** Drop `--remote-allow-origins=*` (the harness connects over a raw WebSocket from Node, which sends no Origin header) and optionally gate the harness behind an explicit env opt-in.

<sub>Verifier (CORRECTED): Code CONFIRMED at capture-host-candidate.mjs:487-489 and 479-481. But the finding does not survive the threat-model test as an exposure. The CDP port is loopback-bound, so the only attacker who can reach it is a same-user local process — which already has the user's Docker socket access and therefore gains nothing. The one attacker class that does NOT have socket access, a web page the developer visits during the capture, still cannot exploit it: `--remote-allow-origins=*` only relaxes the WebSocket Origin check, and a page cannot read http://127.0.0.1:PORT/json (opaque no-cors response) to le</sub>

---

#### A stalled stdout writer also blocks the session's stderr reader: both streams share one emitMu across the blocking wait

`performance` · `defect` · effort: small

**Impact.** Flow control is not per-stream. A consumer that stalls on stdout also stalls stderr, which means a session's error output — often the diagnostically important part — cannot get through while stdout is backed up, and it doubles the child-process blocking surface. It is also part of why the reproduced wedge holds three fds rather than one.

**Evidence.**
- core/internal/core/session.go:378-383 — `handleOutput` takes `s.emitMu` and holds it for the whole function, explicitly to serialise sequence numbers across stdout/stderr.
- core/internal/core/session.go:411-424 — still inside that lock, `emitOutput` blocks on `s.cond.Wait()` until the consumer acks. The mutex is therefore held across an unbounded wait.
- core/internal/core/session.go:305-312 — stdout and stderr are read by separate goroutines that both funnel through `handleOutput`.
- Consequence observed during the wedge reproduction: once the stdout writer is parked on cond.Wait, the stderr reader cannot make progress either, so its pipe fills and the child blocks writing to stderr.

**Fix.** Allocate the sequence number and reserve window budget under emitMu, then release it before waiting; or give each stream its own window accounting and keep only the sequence counter under the shared lock.

---

#### The Docker bridge is reconstructed on every render because useRef's initial value is evaluated eagerly

`performance` · `defect` · effort: trivial

**Impact.** Steady allocation of a discarded object graph proportional to the render rate — dozens of closures per render in host mode, a full fixture deep-clone per render in browser mode. Small in absolute terms but pure waste on the hottest path in the renderer, and trivially avoidable.

**Evidence.**
- app/src/store/useAnchorageStore.ts:204 — `const bridgeRef = useRef(createAnchorageBridge());` — the argument to useRef is evaluated on every render; React keeps the first value and discards the rest.
- app/src/services/anchorageBridge.ts:824-1105 — `createHostBridge` builds a ~280-line object literal containing roughly 40 closures (system, containers, images, volumes, cli, sessions, events, window namespaces), all thrown away on every render but the first.
- app/src/services/anchorageBridge.ts:469-479 — the fixture path is worse: `new FixtureBridge()` runs the field initializer `private state = cloneContainers(CONTAINER_FIXTURES)`, deep-cloning the fixture corpus (including 48-element cpu/memory history arrays) on every render.
- Combined with the no-memo architecture (App re-renders on every store change), this fires at the full render rate: ~2/s idle, and once per output chunk during log follow or an image pull.

**Fix.** Use the standard lazy-init pattern: `const bridgeRef = useRef<AnchorageBridge \| null>(null); if (bridgeRef.current === null) bridgeRef.current = createAnchorageBridge();` (or `useState(createAnchorageBridge)` with the function form).

---

