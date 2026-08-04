# Anchorage v2 design-parity audit

**Audited 4 August 2026.** Current build (`app/`, `core/`, `protocol/`) against the v2 design
handoff at `docs/design_handoff_anchorage/Anchorage v2.dc.html` (4281 lines, 21 screens in four
nav groups) and its source research at `docs/design_handoff_anchorage/docker-features.md`.

## How to read this document

Part 1 is the parity report. Part 2 corrects it. **Where the two disagree, Part 2 wins** — it was
produced by a second pass that re-derived every disputed claim from primary evidence after a
completeness critic found sixteen defects in the first. In particular Part 1's finding counts,
several of its at-parity claims, and four of its "divergences" are superseded. Part 3 is the
critic's original list, kept because it records what a parity audit of this kind tends to miss.

Corrected headline: **131 distinct findings** — 15 blocker, 25 high, 44 medium, 47 low — across
**5 shipped · 5 partial · 11 absent** of v2's 21 destinations.

---

# Part 1 — Parity report

# Anchorage Parity Report — build vs. v2 design handoff

*Source: seven verified cluster diffs, de-duplicated. Spec citations are `docs/design_handoff_anchorage/Anchorage v2.dc.html`; build citations are repo-relative.*

---

## 1. Verdict

The build is not a partial implementation of v2 — it is a well-executed implementation of a **different, smaller product**. Ten of v2's 21 destinations exist and eight of those are at or above spec fidelity down to the pixel (grid templates, 34px header rows, 2.4s pulse keyframe, verbatim copy); the other **eleven destinations do not exist as routes at all** — not as unavailable states, not as placeholder entries, not as `ViewId` members (`app/src/types.ts:1-11` closes the union at ten keys, so they are not even expressible). Two of v2's four nav groups (AI, SECURITY) are absent wholesale, and the product's single most load-bearing posture mechanism — the feature-maturity chip and lifecycle drawer — has no representation anywhere in the codebase. The gap is therefore **breadth, not depth**: where the build ships a screen it usually beats the prototype (live buildx history, a real container filesystem browser, sortable/multi-select tables, Scout SARIF projection, an honest capability-unavailable pattern), and where it does not ship a screen it ships nothing at all. Critically, roughly half the missing surface area is genuinely blocked on Docker capabilities absent from a plain Linux Engine install (`docker sbx`, `docker model`, Hardened Images, Cloud/Offload, Desktop file sharing/virtualisation, org governance) — so the correct closure for those is the build's own stated policy of an explicit unavailable state, not construction.

---

## 2. Screen-by-screen parity table

| Screen | Nav group | Build status | Headline gap |
|---|---|---|---|
| Dashboard | Workspace | **Partial** | Host mode replaces the aggregate CPU/MEM sparklines with a static Engine fact list and the Recent activity feed with "Snapshot limitations"; two of four headline tiles report capacity, not utilisation (`app/src/screens/DashboardScreen.tsx:192-261`) |
| Containers | Workspace | **Shipped** | At parity and beyond (sorting, multi-select, bulk bar, pause, delete confirmation). Paused/restarting render with the violet *pulling* chip (`app/src/utils/containerPresentation.ts:5-13`) |
| Compose | Workspace | **Partial** | Flat table with an expand caret instead of the 270px project rail + detail column; all five detail panels absent (start order, watch, lifecycle hooks, declared dependencies, includes/K8s bridge) — `app/src/screens/ComposeScreen.tsx:97-329` |
| Images | Workspace | **Shipped** | At parity; ships an entire mutation/detail surface v2 dropped. Host registry cards lose the avatar and pulls/updated meta (`docker search` exposes neither) |
| Volumes | Workspace | **Shipped** | At parity; create/prune/backup/restore/browse all exceed spec |
| Builds | Workspace | **Partial** | Cancelled/running builds painted red on a live engine (`app/src/screens/BuildsScreen.tsx:103-105`); per-step table unavailable (disclosed, buildx does not report steps) |
| Logs | Workspace | **Absent** | No `ViewId`, no nav row, no route, no unavailable state. Per-container Logs tab exists; the cross-source merged stream does not |
| Kubernetes | Workspace | **Absent** | Exists only as one Settings toggle (`app/src/screens/SettingsScreen.tsx:140-149`). No destination, no node table, no workloads browser, nothing in `core/` or `protocol/` |
| Bosun | AI | **Absent** | No assistant, no chat, and — critically — no tool-call approval pattern anywhere in the product |
| Models | AI | **Absent** | No local-inference screen, playground, engine picker or OpenAI-compatible endpoint surface |
| Agents | AI | **Absent** | No delegation tree, node inspector, `agent.yaml` render or session log |
| Tools | AI | **Absent** | No MCP catalog or gateway; loses the three-column CREDENTIALS / CONTAINER LIMITS / REAL-WORLD AUTHORITY grid that carries the product's central security argument |
| Sandboxes | AI | **Absent** | No screen; the microVM/hypervisor-boundary isolation model has zero representation |
| Scan | Security | **Partial** | Real Scout-SARIF CVE projection exists, but only as a section inside the Images drawer (`app/src/components/ImageDetailPanel.tsx:207-302`) — no destination, no cross-image rail, no policy grade, no VEX, no SBOM/attestation surface |
| Hardened images | Security | **Absent** | Zero hits repo-wide. Catalogue, comparison table, variant toggle, posture well all missing |
| Secrets | Security | **Absent** | No reference registry, backend selector, resolution example or known-gaps list. Argument redaction in Command Center is the only related code |
| Governance | Security | **Absent** | No enforcement chain, locked policy cards, replacement callout or audit table; Settings has no Enterprise pane either |
| Cloud | Platform | **Absent** | One grep hit repo-wide, and it is a Traefik image description. No nav row, state, protocol type or core service |
| Dev Environments | Platform | **Shipped** (host: unavailable-state) | At parity and interactive where the spec is inert; empty-state tile carries a 24px terminal glyph vs the spec's plain square |
| Extensions | Platform | **Shipped** (host: unavailable-state) | At parity. Tile colours are raw hex in the fixture, so they do not retheme |
| Settings | Platform | **Partial** | 6 of 10 panes (missing File sharing, Virtualisation, Builders, Enterprise); host mode collapses every pane but Appearance to an unavailable state |

**Totals: 5 Shipped · 5 Partial · 11 Absent.**

---

## 3. What is already at parity

This is substantial and should not be lost in the gap list.

**Shell chrome is pixel-faithful.** 46px titlebar with `0 12px 0 16px` padding and fixed gutters; 440×29 search field with a mono `⌘K` pill; 34px update banner with a 6px accent dot and an 18%-accent bottom border; 216px sidebar; 35px nav rows at 8px radius; 26px status bar with a self-ticking clock on its own interval (`app/src/styles/shell.css:52-448`, `app/src/components/Shell.tsx:167-399`, `app/src/components/StatusClock.tsx`). The engine card, scrollbars (10px, 6px thumb radius, 3px transparent border under `background-clip:padding-box`), range inputs and the `ancPulse` 2.4s keyframe all match exactly, and the pulse is correctly disabled under `prefers-reduced-motion` (`app/src/styles/global.css:92-122`).

**Token architecture is sound and in places better than spec.** Single-root `data-theme` + `data-color-mode` stamping with no transitions on token blocks; 144 `--anc-*` declarations in each of `default.css`, `docker.css`, `github.css`, each carrying both a dark and a light block; light mode re-derives status foregrounds so they stay legible. The build derives alpha tints from `-rgb` triples (`rgb(var(--anc-accent-rgb) / 12%)`) where the spec hardcodes `rgba(143,179,255,0.12)`.

**The four shipped workspace screens are essentially exact.** Containers table grid (`26px / 1.5fr / 1.5fr / 116px / 78px / 96px / 1.1fr`, 34px header, 56px rows), all four status-chip strings and their precedence, CPU tone thresholds, memory formatting, the verbatim empty state with curly quotes. Images' `minmax(0,1.6fr) 130px minmax(0,1fr) 110px 100px 96px` grid and all 8 fixture rows. Volumes' five rows including the unused `prom_metrics`. Builds' 420px rail, 3-up stat grid and the `34px minmax(0,1fr) 78px 90px` step table. Container detail ships all six v2 tabs at the spec's 35px tab height, with the Inspect document, bind-mount table and Exec command outputs reproduced verbatim.

**Settings is exact where it exists.** 214px rail, 33px rows, all four resource sliders with identical min/max/step/unit, `daemon.json` matching the spec constant key-for-key, all six toggle rows verbatim, and a 38×21/17px pill switch that is a token-for-token match (`app/src/styles/settings.css:210-238`).

**The honesty machinery the missing screens need is already built.** `app/src/components/UnsupportedSurface.tsx` ("Live Docker capability unavailable" / "No fixture or simulated data is shown in packaged host mode") with a Command Center escape hatch, plus per-capability probes in `core/internal/core/discovery.go:55,163`. Scout integration is genuinely live and genuinely careful: deterministic worst-first ordering locked by tests, a 500-finding/2 MiB cap with disclosed truncation, refusal of `fs://`/`sbom://` source schemes because scanning a host directory would inventory the operator's files, and a single-slot mutex with an honest busy message (`core/internal/core/scout.go`).

**Accessibility exceeds spec.** The Appearance controls are real radiogroups with roving tabindex and arrow/Home/End navigation (`app/src/screens/SettingsScreen.tsx:38-72`); the prototype's plain divs have no equivalent.

---

## 4. Gaps ranked

### Blocker

**B1 — The AI nav group and all five of its destinations (Bosun, Models, Agents, Tools, Sandboxes).**
*Spec:* `Anchorage v2.dc.html:173-196` declares the group; five full screen bodies at `:1003-1749`; `NAVDEF:2593`.
*Build:* `app/src/components/Shell.tsx:30-48` defines only `workspaceNav`/`developNav`; `app/src/types.ts:1-11` cannot express the ids; `app/src/App.tsx:24-51` has no arms; `app/src/screens/PlaceholderScreen.tsx:14-63` keys off the same ten-value union, so there is no fall-through either. `protocol/types.ts` has no `Sandbox*`/`Model*`/`Agent*`/`MCP*` type; `core/internal/core/` has no corresponding source.
*Effort:* XL (Sandboxes, Models, Tools) · L (Bosun, Agents).
*Docker dependency:* **Yes, heavily.** `docker sbx` — no binary in `~/.docker/cli-plugins`. `docker model` — `docker model version` returns "unknown command". `docker mcp` and `docker ai` — binaries present but **unadvertised**, and `docker mcp --help` falls through to root help, so they are non-functional on this host. `docker agent` — absent. Under `README.md:60-64` the required unconditional work is five nav destinations rendering `UnsupportedSurface` with the plugin named; the live surfaces are not honestly buildable here.
*Note:* Two pieces cost nothing and should ship regardless of plugin availability — Tools' three-column authority grid (`:1625-1642`), which is pure layout and copy arguing that a container limit does not bound granted authority, and Bosun's approval-card pattern, which is the only thing in the design that expresses "an agent proposed this; a human must approve it."

**B2 — The SECURITY nav group and its four destinations (Scan, Hardened, Secrets, Governance).**
*Spec:* `:198-217`, screens at `:1751-2067`, `NAVDEF:2594`.
*Build:* no group, no `ViewId` members; `grep -rni 'security' app/src` returns zero. Scan is the only one with real backing — `core/internal/core/scout.go` + `app/src/components/ImageDetailPanel.tsx:207-302` — but it lives inside a drawer reached by selecting one image.
*Effort:* L (Scan — promotion of existing capability) · L (Hardened) · XL (Secrets, Governance).
*Docker dependency:* Scan **no** (Scout is installed and already wired). Hardened **yes** — a subscription Hub catalogue with no Engine API or CLI verb. Secrets **yes** — `docker secret` is Swarm-only; `se://` reference resolution and keychain/vault backends are entirely Anchorage-side new capability. Governance **yes** — Docker Business admin-settings + SIEM, no CLI surface; and three of its four policy cards govern agent-sandbox surfaces that do not exist yet, so it is gated on B1 more than on Docker.

**B3 — Logs destination absent.** `Anchorage v2.dc.html:2196-2242`; nav row `:163-166`. Build: no `ViewId`, no route, no placeholder entry. The per-container tab (`app/src/screens/ContainerDetailScreen.tsx:34`) is a different surface. **Effort L. No Docker dependency** — `docker logs -f` and `docker buildx history logs` both exist on this machine. Note the build already has a real live-follow path (`app/src/store/useAnchorageStore.ts:1614-1770`, `--tail 0 --follow` with re-establishment on engine restart); what is missing is the cross-container fan-out and a build-output source to merge.

**B4 — Kubernetes destination absent.** `:2244-2321` (provisioner card, node table, posture note, workloads panel). Build: one toggle at `app/src/screens/SettingsScreen.tsx:140-149`; `grep -rniE 'kubernetes|k8s' core/ protocol/` returns **zero**. **Effort L. Docker dependency: partial** — provisioning is unavailable (`kind`/`kubeadm` not found, `docker desktop` unrecognised), but `kubectl` **is** installed at `/usr/local/bin/kubectl` and `docker buildx create` lists a `kubernetes` driver, so read-only node/workload state is honestly obtainable.

**B5 — Cloud destination absent.** `:2323-2417`, nav row `:220-223`. Build: one grep hit repo-wide and it is unrelated. **Effort L. Docker dependency: yes** — `docker offload` unrecognised; `docker buildx create` lists no `cloud` driver. Correct shape is an `UnsupportedSurface` naming the missing plugin, *not* a simulated session with a fake idle countdown. The `remote` buildx driver does give a non-invented path for the Cloud builders card.

### High

**H1 — Feature-maturity chip + lifecycle drawer + LIFE table.** Reported independently by all seven clusters; consolidated here as one deliverable in three parts.
*Spec:* `:100-102` (22px titlebar chip, `title="Feature maturity in this view"`, `'<n> pre-GA'` amber / `'all GA'` green); `:2424-2463` (388px drawer over a 34% scrim, header `Maturity · <VIEW>`, lede *"Not everything on this screen is production-ready. Anchorage labels each capability so you know what you can depend on."*, five-term legend, empty state *"Nothing tracked for this view yet."*); `:2599-2742` LIFE (21 keys, ~100 entries); `:2744-2750` LVLS colour map.
*Build:* `app/src/components/Shell.tsx:205-236` — the right cluster is a settings cog plus three window controls, nothing else. `Shell.tsx:401-445` mounts no drawer. `grep -rniE 'maturity|pre-GA|Early Access' app/src protocol core` returns only unrelated `experimental` booleans (`app/src/types.ts:136`, `core/internal/core/discovery.go:773-797`). No `ancFade` keyframe exists — `app/src/styles/global.css:113` and `app/src/styles/states.css:83` are the only `@keyframes` in the build.
*Effort:* M (chip S, drawer M, LIFE content S).
*Docker dependency:* **None.** Pure authored content plus one overlay.
*Why it matters here:* `docs/design_handoff_anchorage/README.md:52` names this as a product posture. The build's `UnsupportedSurface` answers *"can this build do it at all"*; maturity answers *"how much should you depend on it"* — orthogonal axes, and the build has an advantage the prototype lacks: it already knows real runtime capability status (`protocol/types.ts:932`), so chips could be honest rather than hardcoded.

**H2 — Settings: File sharing, Virtualisation and Enterprise panes absent.**
*Spec:* `:853-886`, `:887-923`, `:951-980`; `setNavDefs:3382` lists ten panes.
*Build:* `app/src/types.ts:34-40` and `app/src/screens/SettingsScreen.tsx:16-23` carry six. No `UnsupportedSurface` stands in.
*Effort:* L / L / M.
*Docker dependency:* **Yes, all three.** VirtioFS-vs-gRPC-FUSE selection, VMM-vs-Apple-Virtualization, Resource Saver, and admin-managed policy are Docker Desktop concepts with no Linux Engine equivalent. Correct closure is three rail rows rendering explicit unavailable states — but the concepts must be *visible*, and today they are invisible. Two things are salvageable as real read-only data: the containerd image store is observable via `docker info`, and Enterprise overlaps Governance (B2) — whichever lands first should own the data.

**H3 — Dashboard Recent activity feed does not exist in host mode.** Spec `:302-316` (7-row feed, 6px dot + 12px text + 10.5px mono relative time). Build `app/src/screens/DashboardScreen.tsx:242-261` renders *"Snapshot limitations"* in that slot. **Effort M. No Docker dependency** — `/events` and `docker events` stream exactly this content, but `grep -rn 'events' core/internal/core/*.go protocol/types.ts` (non-test) returns nothing, so both the wire contract and the core need the stream added.

**H4 — No VEX exception control; nothing in the build can mark a finding as not-affecting.** Spec `:1839-1844` — the toggle is load-bearing: `liveCounts` at `:3405` recomputes every severity count, rail chip, stat tile and grade pill from it. Build: `app/src/types.ts:1475-1485` and `core/internal/core/types.go:1240-1251` have no exception field, so the contract cannot express it; `ImageDetailPanel.tsx:248-281` renders read-only `<li>`s. **Effort L. Docker dependency: partial** — `docker scout vex` exists locally and the read side (honouring an existing VEX doc) works today; authoring and attaching is a write against the image/registry, heavier than anything the build currently performs. **The spec's own implementation is client-side state (`state.vex`) and must not be copied** — the copy at `:1844` promises the exception travels with the image.

**H5 — Monochrome theme family absent; house theme named and tinted differently.** See §5.

### Medium

| # | Gap | Spec | Build | Effort | Docker dep. |
|---|---|---|---|---|---|
| M1 | Compose master/detail IA — 270px project rail + detail column, compose file path, `'N projects · M up'` subtitle | `:2069-2101` | `app/src/screens/ComposeScreen.tsx:126-267` flat 5-column table; `configFiles` carried end-to-end (`protocol/types.ts:1523`) but never rendered | L | No |
| M2 | Compose **Start order** panel (ordinals, INIT/SERVICE chip, `service_healthy`/`service_completed_successfully` conditions) | `:2103-2120` | absent; `ComposeService` (`protocol/types.ts:1537-1547`) has no `depends_on` | L | `compose config --format json` — plugin ≥2.x, available, unwired |
| M3 | Compose **Watch** toggle, rule rows, live log | `:2121-2139` | absent; `ComposeAction` fixed to 5 verbs (`protocol/types.ts:1570`, `core/internal/core/compose.go:18`). Runnable as a raw Command Center leaf only | L | Compose ≥2.22 |
| M4 | Compose **Lifecycle hooks** (`post_start`/`pre_stop`, amber when `user root`) | `:2140-2155` | absent | M | Compose ≥2.30 |
| M5 | Compose **Declared dependencies** (model/provider/secret/volume kinds) | `:2156-2169` | absent; `ComposeProject` (`protocol/types.ts:1517-1527`) carries no dependency kind | M | Provider/model need Compose ≥2.35/2.38 + Model Runner; volume/secret readable today |
| M6 | Compose **Includes & K8s bridge** (remote-include amber warning; manifest generation) | `:2170-2194` | absent, and not disclosed as unavailable either | M | Bridge is Desktop-only → state it; includes readable from `compose config` |
| M7 | Dashboard aggregate CPU/MEM sparklines unwired in host mode | `:280-300` | `DashboardScreen.tsx:227-241`; the `Bars` component, `−60s/now` axis and `.dashboard-bars--cpu/--memory` CSS all exist and are used only in the fixture branch (`:419-425`) | M | Engine exposes per-container `/stats` only; an aggregate must be fanned out and accumulated client-side, with no daemon-side history to backfill |
| M8 | Dashboard host tiles 2 and 3 report capacity, not utilisation; rails divide by literals 64 and 128 | `:3465-3470` | `DashboardScreen.tsx:192-207` | M | Same as M7 |
| M9 | **Builds: cancelled/running/unknown painted red on a live engine** | `:3352` maps non-success/non-failed to neutral | `BuildsScreen.tsx:103-105` and `:137-139` use `status === "success" ? "success" : "failed"`, while `core/internal/core/builds.go:79-91` emits five statuses and `app/src/styles/builds.css:63-65,134-137` already define the neutral `--cancelled` style | **XS** | No — a real misreport of state with the fix already written |
| M10 | Settings **Builders** pane absent | `:925-949` (5-column selectable table, ACTIVE chip) | Data fully plumbed and unused: `protocol/types.ts:1789-1802` + `core/internal/core/builds.go:228-268` carry driver/status/platforms; `BuildsScreen.tsx:65-80` renders name + dot with driver in a `title` attribute | M | Read side available now; `buildx use` write path has no backend verb yet |
| M11 | Settings host mode collapses every pane but Appearance | `:768-1002` renders unconditionally | `SettingsScreen.tsx:466-479` | L | Deliberate and correct, but `docker info` already supplies CPU count, memory total, storage driver, registry mirrors and insecure registries — Resources and Engine could be honest **read-only** panes instead of blank |
| M12 | Appearance theme cards are 42×42 three-bar swatches, not 74px app miniatures that re-render in the selected mode | `:788-820`, `:3439` | `SettingsScreen.tsx:248-263`, `app/src/styles/settings.css:303-331`; source is a static 3-hex tuple (`SettingsScreen.tsx:25-29`) that never reads `store.colorMode`. Grid is `repeat(3,1fr)` vs `1fr 1fr` | M | No |
| M13 | Scan cross-image aggregate (rail, per-severity chips, `'N images analysed'`) | `:1754-1772`, `:3903-3911` | `scoutByReference` (`app/src/store/useAnchorageStore.ts:484-487`) is already keyed per reference and each result carries a full summary — the derivation simply does not exist | M | No |
| M14 | Scan policy checklist (6 rules) and derived grade pill | `:1795-1805`, `:3916-3938` | `core/internal/core/scout.go:210-211` calls exactly one verb, `scout cves --format sarif` | M | `docker scout policy` is installed but experimental and requires org enrolment → real evaluation when enrolled, explicit unavailable otherwise. **Do not invent a local six-rule grader.** |
| M15 | Kubernetes node/workload/namespace domain absent from `protocol/` and `core/` | `:2993-3002`, `:4150-4155` | zero hits | M | `kubectl` installed; Docker CLI exposes no cluster browser |
| M16 | Nav IA: two groups vs four; WORKSPACE ordering | `:136-236` | `Shell.tsx:30-48,344-351` | S | No — see §5 |

### Low

- **Copy drift, all `xs`:** titlebar version `4.31.2` vs `4.84.0` (`Shell.tsx:178`) — **fix to the real version from `app/package.json`, not to the prototype's number**; `docs/review-2026-08-03-findings.md:2082` already flags 4.31.2 as a false statement against a 0.1.0 release. Update-banner copy (`Shell.tsx:248-250`). Fixture status-bar `engine v27.1.2` (`Shell.tsx:355-362`) — the installed engine is in fact 29.7.1, matching the spec. Appearance subtitle and three theme descriptions. Compose's four inline posture statements (`:2106`, `:2151`, `:2167`, `:2181`) — dependent on M2–M6 landing first.
- **Dashboard `Clean up` should read `Prune system`** (`DashboardScreen.tsx:169`); the dialog behind it is already the correct full system prune. Separately, the *fixture-only* button at `:355-358` is labelled "Prune system" but calls `cleanUpImages` (images only) — a false statement about scope in the design-QA surface.
- **Paused/restarting/removing containers use the violet `pulling` kind** (`app/src/utils/containerPresentation.ts:5-13`) — text says "Paused", colour says "in flight". Needs a distinct kind and token. `xs`.
- **Registry avatar and extension tile colours are raw hex** (`app/src/data/fixtures.ts:298-342`, `:591-644`) applied inline, bypassing the token layer; sampled from dark-default, so they read as foreign objects in github-light. `xs`.
- **Brand mark is a 19px PNG** (`Shell.tsx:170-176`) rather than the spec's theme-tinted SVG cube; a vector source already sits in the handoff directory (`docs/design_handoff_anchorage/anchorage-mark.svg`). `s`.
- **No light/dark toggle in the titlebar** (`:103-110`); mode is reachable only from Settings. `store.setColorMode` and `applyAppearancePreference` already exist, so this is a button plus two glyphs. `s`.
- **Engine card memory divides by a literal 16 GB** (`Shell.tsx:304-307`; CPU by a literal 8 at `useAnchorageStore.ts:2104-2112`). Confined to fixture mode — host mode correctly reads "Stats tab"/"on demand" — and the real figures are in `docker info`. `s`.
- **Status-bar and engine-card health dots use accent where v2 specifies green** (`app/src/styles/shell.css:367-373`, `:439-444`); geometry and the 2.4s pulse match exactly. `xs`.
- **Active nav row is accent-tinted** where v2 specifies neutral `--muted` with a foreground lift (`shell.css:334-337`); the build also adds a hover the spec does not declare. `xs`.
- **Nav/titlebar icons come from Phosphor + Lucide** rather than the hand-drawn 16px inline SVG set (`app/src/components/AnchorageIcon.tsx`). Sizes are right; shapes are third-party, and two libraries in one set is a coherence risk. The registry is the right seam. `m`.
- **Builds host row meta shows `date · cache`** vs the spec's `branch · shortSHA · platform` (`BuildsScreen.tsx:112-115`); `VCSRevision` is already populated at `core/internal/core/builds.go:329` and would close most of it. Platform and branch are not in the `history inspect` payload. `s`.
- **No Export on the log surface**, and the build's `Clear` discards buffered data while the spec's resets the view predicate (`useAnchorageStore.ts:2137-2147`) — same label, opposite meaning. `s`.
- **Scan drawer is a card list, not a 6-column table**, and lacks SBOM/attestation projection and the base-image panel. `docker scout sbom` and `attestation list` are already discovered as runnable Command Center leaves — the gap is the projection, not the transport. Signature verification (`cosign`) has no Docker equivalent at all and must be dropped or stated. `s`–`m`.
- **Dev Environments empty-state tile** holds a 24px terminal glyph where the spec has a plain 16px rounded square (`DevEnvironmentsScreen.tsx:149-151`). `xs`.
- **Missing 3-segment segmented control and the amber "ON is risky" switch variant.** Both base components exist and match spec — `.appearance-mode-control` (`settings.css:373-411`) and the 38×21 `role="switch"` (`SettingsScreen.tsx:413-424`) — only the 3-way instance, the 34×19 rail size and the amber track are missing. `s`.
- **No `type="range"` control outside Settings**, so Models' context-length slider has no primitive; the interesting half is its one-value-drives-three-readouts binding. `xs`.

---

## 5. Design-system divergences

**Theme families — 3 shipped against v2's 4, and the flagship is a different palette, not a rename.** `app/src/theme/appearance.ts:1` ships `["default","docker","github"]`; the spec (`:2572-2586`) declares `nous`/`github`/`docker`/`mono` with a DESK map covering all eight theme×mode pairs. The house theme is not "nous renamed": spec `nous` dark is royal blue `--app:#0d2f86` with a warm psyche-cream primary `#f2dbc5`, while `app/src/styles/themes/default.css:5-20` is indigo `--anc-app:#16224a` with a cool `--anc-accent:#8ba8f0` and no cream primary. So this is **one missing family plus a rename plus a re-tint**. Monochrome is the one worth prioritising: it is the accessibility harness that surfaces every place status is carried by hue with no shape, label or lightness backup — and the build's accent-tinted active nav row (`shell.css:334-337`) and accent health dots are exactly what it would catch. Rename cost is near zero: `isThemeFamily` (`appearance.ts:69-74`) already rejects unknown persisted values and falls back cleanly. **Decide all four names before Mono lands.**

**Token naming — different vocabulary, equivalent coverage. Not a gap.** The spec derives `--red-bg`, `--green-ring`, `--amber-fade` once in `.anc` via `color-mix` (`:20-32`), with per-family blocks declaring base colours only. The build declares base + `-rgb` channel per family and composes tints at the usage site (`rgb(var(--anc-warning-rgb) / 40%)`, `app/src/styles/development.css:1830`). Same reach, different mechanism; no token is unreachable. The text ramp is named (`--anc-text-primary…-mono`) rather than numbered (`--fg-0…--fg-7`). The only decision is whether to add a semantic alias layer so ported screens can be written against triad names.

**Typography — at parity.** IBM Plex Sans 400/500/600/700 and IBM Plex Mono 400/500/600, self-hosted at exactly the spec's weights, declared once on `body`, exposed as `--anc-font-sans`/`--anc-font-mono` (`app/src/styles/tokens.css:2-3`). Mono is correctly the face for every identifier, digest, size, duration, port and path across all shipped screens. Screen titles are 21px/600 at `-0.2px` over 12.5px muted subtitles throughout.

**Spacing and fixed-height rhythm — at parity.** Window 1600×1000, desk padding 28px, titlebar 46px, banner 34px, sidebar 216px, status bar 26px, all centralised in `app/src/styles/tokens.css:5-11`. One deliberate deviation: titlebar brand/action gutters are 216px against the spec's 240px, aligned to the sidebar instead — arguably better, but it is a divergence.

**Desk backdrop is capture-only, and correctly so.** The radial gradient, 13px radius and `0 40px 90px` shadow exist only under `?capture` (`app/src/styles/shell.css:13-25,42-50`). The shipped product is a frameless native window, so a simulated desktop would be wrong. **Do not "fix" this.**

**Nav IA — the one cross-cutting item that can land ahead of any new screen.** v2 has four groups (`:136`, `:173`, `:198`, `:218`); the build has two, and even within the shared set the order differs — v2 puts Compose third, immediately after Containers; the build puts it sixth after Networks (`Shell.tsx:30-38`). `DEVELOP` is not a v2 group; those rows belong under `PLATFORM`. Bring the ten existing screens to v2's grouping and ordering **before** the eleven new destinations land, or the reshuffle happens twice.

**Chip system — the largest missing primitive.** v2 has a five-level maturity chip (LVLS `:2744-2750`: GA green / Early Access accent / Beta violet / Experimental amber / Deprecated red), an `EXPERIMENTAL` per-control chip (`:1957`), the titlebar `'n pre-GA'` pill, `SIGNED`/`UNSIGNED` chips on Tools, `INIT`/`SERVICE` on Compose, `LARGE REPOS` and `BETA` in Settings, and kind chips on Governance and Declared dependencies. The build has status pills and severity tags but **no level-chip concept at all**. Building it once (level → token pair, one component) unblocks maturity, Tools, Compose start-order, Settings virtualisation and Secrets simultaneously.

**Nav counters.** The mechanism is generic and correct — `Shell.tsx:290-292` + `shell.css:339-348` — but Containers is the only call site. v2 has exactly two counters; the second is Sandboxes.

---

## 6. Findings in the other direction

| What the build has | Spec position | Call |
|---|---|---|
| **Networks** — nav row (`Shell.tsx:35`), route (`App.tsx:37-38`), 391-line screen with a prune dialog, and full protocol backing (`protocol/types.ts:590-683`) | Not in `NAVDEF` at all; zero occurrences | **Keep.** `docker network` is core Engine surface and `docs/parity-and-release-gates.md:20-22` commits to covering it. Treat as a v2 omission; give it a home in the four-group nav and a LIFE entry |
| **Command Center** (`Ctrl/Cmd+Shift+P`, 1434 lines + model + 633-line CSS) | v2 explicitly has **no** command palette and **no** keyboard shortcuts; the `⌘K` badge is decoration | **Keep — it is load-bearing.** It is the release-gate coverage path for every discovered advertised CLI leaf. One parity action: make the `⌘K` hint honest, since the build wires it to search focus while the palette is on a different chord |
| **Global search filters in place** instead of hijacking navigation to Containers on every keystroke (`useAnchorageStore.ts:985-991`, rationale in-comment), and matches name/id/image/ports rather than name+image | `:3456` forces `view:'containers'` per keystroke | **Keep; amend the spec.** The prototype loses the user's place mid-type, and the wider match set makes the placeholder copy honest |
| **Containers table extras** — sorting, multi-select, bulk bar, compose-project filter, Pause, delete confirmation | Spec explicitly has none of these | **Keep.** Pause closes something the v2 drawer itself over-promises. Only visual consequence is a checkbox sharing the 26px lead column with the status dot |
| **Container detail: Processes and Changes tabs** (`docker top`, filesystem diff), with explicit capability states in preview | v2 `tabDefs` is exactly six | **Keep.** Both map to real Docker verbs v2 has no surface for |
| **Host Files tab is a real navigable browser** walking tar headers from the archive endpoint (so it works on scratch/distroless), with upload | v2 is 9 flat inert path strings, no transfer control, despite the drawer claiming "Browse, edit and transfer files" | **Keep and reflect back into the spec** |
| **Images/Volumes management surfaces** — detail panel, scoped clean-up with reclaim preview, save/load/push/tag, backup/restore/browse | v2's controls are inert; Content browser is a drawer entry only | **Keep.** The build has already shipped the spec's GA "Content browser" as real UI |
| **`UNSPECIFIED` fifth severity bucket** (`core/internal/core/scout.go:43`) — Scout has no CVSS v3 vector, *not* that the CVE is harmless | Spec's `SEV` map has four and merges medium+low into one tile | **Keep; spec adopts the fifth.** Folding it into "low" would understate a real image |
| **Scanner attribution, finding-cap truncation disclosure, "no fix available"** (`scout.go:20-30,228-234`; `ImageDetailPanel.tsx:18-20,236-278`) | No slot for any of them | **Keep — and the new Scan layout must reserve a limitations band**, or honest data gets dropped on the way into the design |
| **`Analyze` is explicitly opt-in with latency copy** ("the first analysis of an image indexes it, which can take a few minutes") and a one-at-a-time mutex | `Rescan` is a decorative button with no handler | **Keep.** When the Scan screen lands, `Rescan` inherits this behaviour, not the prototype's silence |
| **Separate `Update now` / `Dismiss` handlers** | `:126` puts one dismiss handler on the whole banner, so "Update now" also dismisses | **Keep** |
| **`betaChannel` and `telemetry` are separate flags** | `:3372`/`:3375` bind both to the `telemetry` key, so opting into pre-release builds silently enables telemetry | **Keep. Report the prototype defect back to design** |
| **Wired `Apply & restart` / `Reset to defaults`** with a pending/applied split and a `role=status` notice | Both decorative; sliders mutate state directly despite a subtitle promising a restart | **Keep.** Consider marking sliders dirty when pending ≠ applied — neither side does today |
| **Single versioned appearance key** `anchorage.appearance.v1`, validated on read, with a session-only fallback surfaced to the user | Two keys, silent try/catch on failure | **Keep.** The persistence-failure copy is better posture than the spec and has no v2 counterpart |
| **Real window controls** wired through the bridge; **real engine state** in the engine card and status bar ("Connecting to engine" / "Permission required" / "Engine unavailable") | Prototype's traffic lights are decorative; its engine is always running | **Keep** |

---

## 7. Suggested sequencing

**Tranche 1 — Nav IA + the level-chip primitive.** *(S–M, no Docker dependency, no new screens.)*
Restructure the sidebar to v2's four groups and ordering with the ten existing destinations (`WORKSPACE` = dashboard/containers/compose/images/volumes/builds; `PLATFORM` = devenv/extensions/settings, plus Networks placed deliberately). Build the level chip once against LVLS's five token pairs.
*Unlocks:* every later tranche drops into a stable nav without a second reshuffle, and five separate surfaces (maturity, Tools, Compose start-order, Settings virtualisation, Secrets) get their chip for free.

**Tranche 2 — Maturity chip + lifecycle drawer + LIFE catalogue.** *(M, no Docker dependency.)*
Titlebar chip, 388px drawer with legend and empty state, and the ~100-entry LIFE table authored from the handoff plus `docs/design_handoff_anchorage/docker-features.md`. Seed maturity for the ten existing screens and pre-declare entries for the eleven that do not exist yet.
*Unlocks:* the product's stated posture, and the honest labelling for everything shipped in tranches 4–6. It is also the last cheap moment to do it — every screen added afterwards adds LIFE rows.

**Tranche 3 — Correctness and copy sweep.** *(All `xs`–`s`, no Docker dependency.)*
Builds status collapse (M9 — the only genuine misreport in the shipped product, and its CSS is already written); paused/restarting chip kind; `Clean up` → `Prune system` and the fixture button's scope lie; version strings sourced from `app/package.json`; hardcoded engine-card denominators sourced from `docker info`; tokenise registry/extension tile hex; port the SVG brand mark; add the titlebar mode toggle.
*Unlocks:* the shipped ten screens stop making false statements, and the theme layer becomes safe for Mono.

**Tranche 4 — Monochrome theme + Appearance card miniature.** *(M, no Docker dependency.)*
Add `mono.css`, settle the four canonical family names, and replace the three-bar swatch with the 74px app miniature that re-renders in the selected mode.
*Unlocks:* the accessibility harness that proves no status in the product is carried by hue alone — and it will surface residual hue-only signals from tranche 3.

**Tranche 5 — Promote what already has live backing.** *(M–L, Docker capabilities already installed.)*
Three promotions of existing data: **Security > Scan** as a destination with a cross-image rail derived from `scoutByReference` (M13); **Settings > Builders** rendering the driver/platform/status data already decoded at `core/internal/core/builds.go:228-268` (M10); **Compose** master/detail rail plus a `compose config` core method feeding start order, hooks, declared dependencies and includes (M1–M6, minus the Desktop-only K8s bridge).
*Unlocks:* two of v2's missing groups get their first real destination, and Compose goes from a table to the screen the spec designed — all without a single new Docker dependency.

**Tranche 6 — The eleven absent destinations, capability-triaged.** *(L–XL.)*
Land as routes in one pass, each resolving to either a real surface or an explicit `UnsupportedSurface` naming the missing capability. **Buildable now:** Logs (fan-out `docker logs -f` + `buildx history logs`), Kubernetes read-only via `kubectl`, Cloud builders via the `remote` buildx driver, Tools' authority grid and Agents' `agent.yaml` renderer as static/file-backed surfaces, plus all the posture copy on every one of them. **State as unavailable:** Sandboxes, Models, Bosun's runtime, Hardened images, Secrets backends, Governance policy, Cloud sessions, Settings File sharing/Virtualisation/Enterprise. Add a third capability state the current host demonstrates and the code does not model — *binary present but unadvertised* (`docker mcp`, `docker ai`) — which is materially different from "not installed" and should be reported as such.
*Unlocks:* nav completeness. After this the user can see that Anchorage knows about every v2 destination and why each one does or does not work here — which is the whole point of the build's no-invention policy, currently undermined by eleven silent absences.

---

# Part 2 — Corrections and addendum

*Supersedes Part 1 wherever the two conflict.*

## Corrections to the audit

### Fabricated sources: nothing named `crossCutting` exists

`grep -ci crosscutting` over `docs/design_handoff_anchorage/Anchorage v2.dc.html` returns **0**. It is a field name from the first audit's extraction schema, quoted back as if it were a section of the 4281-line spec. Eleven findings cite it and eight more appeal to "the extraction", "the purpose note", "the cluster brief" or "the task brief" the same way. One finding — `ai/theme-token-triads-missing` — carried **no line citation at all**, the only one in the file.

Every one of those nineteen was re-derived against the file. The substance survives in seventeen; two were materially wrong (below). Re-derived facts, now citable:

- Icons: 47 `<svg>` in the spec, 42 on `viewBox="0 0 16 16"`; stroke-widths 1.4×50, 1.5×17, 1.6×16, 1.3×3, with one 1.8 and one 0.9 (inside the 32×32 logo). Nav glyphs render at 15px, `Anchorage v2.dc.html:139-233`.
- No command palette: `:96` is a bare `<div>` holding ⌘K with no handler; `:95` carries `onChange` only; exactly three `onKeyDown` in the file (`:487`, `:1256`, `:1413`), all `if (e.key === 'Enter')` at `:3516`, `:3705`, `:3751`; **zero** `metaKey|ctrlKey|keyCode` and zero `palette|command center` in 4281 lines.
- No table affordances: zero `type="checkbox"`, zero sort handlers, zero bulk bar across the **whole file**, not merely `:252-540` as claimed. The only `.sort()` is log ordering at `:3424`; the list header at `:348-350` is eight static text cells with no `onClick`.
- Global search is a navigator: `:3456` states it outright — `onSearch: (e) => this.setState({ search: e.target.value, view: 'containers', selected: null })`. No note needed; delete the quoted one.
- `ai/simulation-tick-model-absent`: `:3063-3071` is real and exact. Strike only the `crossCutting /` prefix.

### Two findings that were flatly wrong — both produced by name-greps, not shape

**`ai/toggle-switch-component-absent`** claimed the switch "does not exist", evidenced by `grep -rn 'role="switch"' app/src --include='*.tsx' -> empty`. `--include=*.tsx` is not a valid fish glob; it errors with "no matches found" and the shell error was read as an empty result. The switch exists at the spec's exact geometry: `app/src/screens/SettingsScreen.tsx:413-424` renders `<button role="switch" aria-checked>` with a knob span, and `app/src/styles/settings.css:210-238` gives 38×21 track, 2px pad, 11px radius, 17px knob translating 17px — byte-for-byte spec `:917`. Rewritten as partial coverage. Residual absences: the 34×19/15px rail variant (`:1448`, `:1730`, `:1739`, `:2034`, `:2391`), the amber ON-is-risky track (computed at `:3644`, `:3895`, `:4196` — three occurrences, not the two claimed), the ON track using `--anc-accent` where the spec uses `C.primary` at 15 val sites, and the fact that the one switch is bound to `store.featureFlags` and is not shared. The finding also understated the spec: toggles appear at 10 sites across Settings, AI, Governance and Cloud, not "Sandboxes, Bosun, Tools".

**`ai/segmented-control-absent`** claimed the control "does not exist in the build", evidenced by `grep -rniE "segmented"`. It exists under a different name: `app/src/styles/settings.css:373-411` `.appearance-mode-control` — 3px padding, 3px gap, 1px `--anc-line-border`, `repeat(2, minmax(0,1fr))`, 7px inner radius — the spec's construction exactly (`:775`, `:1101`, `:1119`, `:1274`, `:1710`, `:2259`). Real divergences: selected segment is a 13% accent tint (`settings.css:405-411`) against the spec's solid `--primary` with `--primary-fg`, and the build stacks a bold label over a description at auto height against the spec's single centred label at 27-28px. Also: the spec has **six** segmented controls, not four, and all four cited line numbers point at the enclosing panel rather than the control.

Both drop **medium → low**. Pass 3 argued medium on the grounds that the ON track uses accent where the spec uses primary; that defect is now carved out into `token-primary-collapsed-into-accent` (high), so the residue here is low. No double count.

### At-parity claims that concealed defects

These are the worst class: a surface certified as having no divergence, which does.

1. **`workspace-core` atParity: "All four spec status chip strings and their precedence"** (`utils/containerPresentation.ts:27-50`). True only in fixture mode. `containerPresentation.ts:33` short-circuits on `if (container.status.trim()) return container.status;` before any vocabulary branch, and host mode passes Docker's string through untouched (`core/internal/core/engine.go:367`, `:425`). The build's own test pins it: `containerPresentation.test.ts:109-120` asserts `"Up 3 minutes (healthy)"` and `"Exited (137) 12 seconds ago"`. **Second defect in the same entry:** Running is painted accent, not green. Spec `:3287` returns `fg: C.greenFg, bg: 'var(--green-bg)', dot: C.green, ring: 'var(--green-ring)'`; `app/src/styles/containers.css:103-106` and `:186-189` use `--anc-accent`. Green never appears on the Containers screen. Split into `behaviour-host-status-chip-vocabulary` (medium) and `token-running-status-uses-accent` (high).

2. **`shell` atParity: "Status bar is exact … CPU/MEM, and a right-aligned clock — Shell.tsx:354-399"** (and the identical claims in `workspace-ops` and `workspace-core`). On a real engine `Shell.tsx:391-394` replaces the whole segment with the sentence "live metrics on container Stats", and the engine card above degrades to "Stats tab" / "on demand" with both meters pinned to `width: 0` (`Shell.tsx:326-338`). Verified in fixture mode only. → `behaviour-host-engine-telemetry-dropped` (medium).

3. **`shell` atParity: "Titlebar geometry … (gutters are 216px against the spec's 240px, matching the sidebar instead)"** — the parenthetical states a 24px divergence on both flanks and files it as parity. Spec sets both gutters to 240px (`:80`, `:99`) against a 216px sidebar (`:135`); the build sets both to 216px (`shell.css:73-79`, `:157-164`) to match `--anc-sidebar-width` (`tokens.css:10`). Promoted to a low finding — recording it as parity means a later geometry pass will not find it.

4. **`workspace-core` atParity: "Preview stat tile content verbatim"** (`DashboardScreen.tsx:370-401`). The text matches only because the build's literals happen to equal the spec's default resource values. Spec `:3467`/`:3468` bind the units and the memory fill percentage to `s.res`; the build hardcodes them at `DashboardScreen.tsx:381`, `:389`, `:339`. The tiles stop matching the moment a Resources slider moves. → `behaviour-resources-binding-dead` (medium).

5. **Extensions, certified at parity six times** (card anatomy, summary format, install-button styling, seeded installs, "correctly a flat catalogue with no search"). `docker-features.md:2218-2220` states an extension can carry backend containers, Docker socket access and host executables. `ExtensionsScreen.tsx:48-59` is a bare button calling `store.toggleExtension(...)` with no confirmation and no permission list; `rg -in 'privileg|socket|host executable|backend container|permission' app/src/screens/ExtensionsScreen.tsx` returns nothing. Parity with a spec that omits a safety truth is the failure mode a completeness critic exists to catch.

### Citations that do not resolve

- `security/security-cluster-tokens-named-differently` cites `app/src/styles/themes/default.css:102-186`. The file is **166 lines**: dark `:1-83`, light `:85-166`. The specEvidence was also a fabricated quotation; the underlying fact checks out — `sed -n '1751,2068p' | grep -oE '#[0-9a-fA-F]{3,8}'` returns nothing, zero literal hex across all four security screens — sourced to `:8-33`, `:42-48`, the `C` table at `:2477`, the SEV map at `:2924-2929` and the tag map at `:2747-2749`.
- `workspace-core/detail-debug-toolbox-absent` cites `ContainerDetailScreen.tsx:1069-1071`. Wrong by ~240 lines: the comment is `:828-829`, `const [shell, setShell] = useState("/bin/sh")` is `:830`, the four-option picker is `:974-980`. There is no exec code at `:1069-1071`.
- `workspace-core/containers-table-extras` cites `:3306` for unconfirmed deletion. `:3306` is the row-level binding `remove: (e) => { e.stopPropagation(); this.remove(c.id); }`; the actual unconfirmed delete is `remove(id)` at `:3121`.
- `shell/iconography-library-vs-inline` cites nav glyphs at 144/157/161. Each is one line late: Containers `:143`, Volumes `:156`, Builds `:160`. Its build citation "registry 75-203" overruns; the last entry ends at `:200` in a 252-line file.
- `logs-regex-and-saved-filters-absent` notes cite `ContainerDetailScreen.tsx:565` for `— no log output —`; it is `:552`.

### Corrections that change a conclusion

- **`shell/iconography-library-vs-inline`: "the AnchorageIcon registry is the right seam — swapping to inline SVG is contained to one file" is false.** `grep -rln '@phosphor-icons/react|lucide-react' app/src` returns 19 files; 18 bypass `AnchorageIcon.tsx` entirely with 17 distinct icon components, and 4 of the 9 registry consumers also import directly. A full swap is ~37 glyphs across 19 files plus two dependency removals. **low → medium, effort m → l.**
- **`ai/theme-token-triads-missing` was scored medium on the note "not as bad as it reads — the `-rgb` channel pattern already produces the tint variants".** It produces the background half; the foreground half is where the work is, and it is an accessibility defect. Measured against each chip's own 13% fill over that theme's panel: default light success 3.99, danger 4.32, violet 4.34; docker light accent 3.88; github light warning 3.88, violet 3.99, success 4.02, accent 4.07, danger 4.10 — **nine combinations below WCAG AA**. Applying the spec's `:42-48` ratios to the same base colours yields 5.46–7.93 throughout. The `-fg` half is carved into `token-light-mode-foreground-derivation-absent` (high); the residue here (four families vs three, no `-bg`/`-ring`/`-fade` alias layer) stays medium. The finding also overstated the ramp gap: the spec ramp `--fg`/`--fg-strong`/`--fg-body`/`--fg-mono`/`--fg-2..--fg-7` maps 1:1 onto the build's ten named text tokens (`themes/default.css:42-53`).
- **`security/security-cluster-tokens-named-differently`: "the mapping is mechanical" is false. low → medium, effort s → m.** Two named tokens have no build counterpart: the `-fg` family (a mechanical rename silently drops the light-mode darkening and ships the sub-AA contrasts above) and `--green-ring` at 20% distinct from `--green-bg` at 16% (`:25-26`), which the ENFORCED cards at `:4018-4019` consume as a border over a fill. `grep -rn ring app/src/styles/themes/` returns 0.
- **`ai/posture-copy-system-absent` was a blocker built on an invented framing sentence.** All seven quotes resolve verbatim (`:1642`, `:1463`, `:1437`, `:3636`, `:3687`, `:1716`, `:1267-1268`) and the "visually distinct box" characterisation is verifiable from the enclosing callouts (`:1641` `--well`/`--bd-soft`, `:1436` `--red-bg` with solid `--red`, `:1266` `--amber-bg`/`--amber-fade`). The build grep was not empty: "advisory" hits at `ImageDetailPanel.tsx:238` and `:290`, both meaning Docker Scout's advisory database. Every citation sits on a screen already filed as wholly absent, so blocker triple-counts. **Resolved against the de-duplication pass: dropped, folded into the five AI missing-screen blockers as acceptance criteria ("includes the screen's not-a-boundary posture box"), with the one independently actionable residue re-filed as `unsupported-surface-has-no-posture-statement` (low, `UnsupportedSurface.tsx:30`).**
- **`settings/settings-resource-actions-wired-in-build`: "both actions are functional" is half true.** Reset works. Apply & restart copies `resources` into `appliedResources` and sets a notice; `appliedResources` has **zero readers** — its only occurrences are its declaration (`useAnchorageStore.ts:537-539`), its write (`:3452-3455`) and its inclusion in the return object (`:3562`). It is a dead write.
- **`workspace-ops/logs-unified-multi-source-stream-absent`: "single-shot" is wrong.** With Follow on, `useAnchorageStore.ts:1615-1660` opens a live session with partial-line reassembly, level inference and a de-duplicating sequence counter. The substance (no merged multi-source stream, no BuildKit lines, one container at a time) is unaffected; stays high.
- **`settings-nav-order-labels-and-default-tab` / `settings-section-nav-short`: "lands on Appearance rather than Resources" is wrong in the mode the spec describes.** `useAnchorageStore.ts:531-533` is `isHost && !captureAppearance ? "appearance" : "resources"` — fixture mode matches spec `:3022`. Appearance is the default only in host mode, where every other pane renders unavailable anyway. The rest of both findings stands.
- **`shell/engine-card-memory-denominator` is misattributed on both ends.** In host mode the meter is not rendered (0% width, "on demand", `Shell.tsx:335-338`); in fixture mode the spec binds the denominator to `s.res.mem` (`:3463`), the slider — not host memory. Dropped as a duplicate of `behaviour-resources-binding-dead`.
- **`workspace-core/detail-extra-tabs-processes-changes`: Changes is not a build extra.** The spec commits to it in its own catalogue — `:2608` "File browser — GA — Browse, edit and transfer files, with changes marked against the image", transcribed from `docker-features.md:476`. The build honours a promise the spec's own Files tab (`:493-500`) drops. The residual gap runs the other way: source and spec both put change state *inside* the browser, while the build splits it into a separate tab (`ContainerDetailScreen.tsx:40`, `:1305-1330`) and `ContainerFilesPanel.tsx:134` renders only `modifiedAt`. Data is already in `store.changes` (`protocol/types.ts:242`), so merging is a rendering job.
- **`workspace-artifacts/volumes-management-surface-extra`: "Scheduled exports is the only volumes capability with no build counterpart" is false.** Spec `:2619` puts clone and empty inside a **GA** claim; `rg -in 'clone|empty volume' app/src protocol core` returns only `bytes.Clone`, `cloneJSON`, `structuredClone`, `emptyState`. Three capabilities lack counterparts, two under GA. The "extra" framing is also inverted — `docker-features.md:491-503` shows create/delete/inspect/browse/export/import are baseline Volumes-view behaviour; the spec dropped them, the build did not invent them.
- **`shell/global-search-navigator-divergence` + `workspace-core/containers-search-scope-and-navigation`: "the build wins" is half right.** `docker-features.md:550-557` (6.7) defines global search as cross-resource. The build's search is per-view — `filteredContainers` (`useAnchorageStore.ts:2075-2091`), `filteredImages` (`:2449-2461`), `filteredVolumes` (`:2463-2472`) all consume the same string but only the mounted screen renders, so a query matching two images while you sit on Containers produces silence. The placeholder "Search containers, images, volumes…" (`Shell.tsx:197`) is no more honest in the build than in the spec. Keep the no-force-navigate rule (spec `:3456` is a real defect); reject the claim that the build satisfies 6.7.
- **The maturity findings say "author the LIFE catalogue"; the correct instruction is "transcribe, then reconcile".** LIFE is a derivation of `docker-features.md:44-70`, a 25-row table (the brief's "28" is wrong) with per-row Docker Documentation citations, whose five status labels at `:9-13` reappear verbatim as LVLS (`Anchorage v2.dc.html:2744-2750`). Reconciliation: 14 clean agreements, **2 outright disagreements** (Docker Debug "GA, paid plans" at `:51` vs Beta at `:2609`; Sandboxes "Current; several subfeatures still experimental or EA" at `:60` vs GA at `:2638`), 3 non-lifecycle status words silently resolved to GA, 2 rows with no LIFE entry (ECI, Windows on Arm), 4 dropped plan entitlements. Effort on the data-model half **s → xs**; the reconciliation is the finding.

### Four alleged divergences that dissolve

- Default view: build is `"containers"` (`useAnchorageStore.ts:348`), spec `:3018`. Parity.
- Restart: the fixture bridge is stop → `wait(600)` → start (`anchorageBridge.ts:702-721`), matching spec `:3120`; host mode calls the daemon's restart endpoint (`engine.go:523-524`). Parity.
- Log buffer 260 vs 500: invisible. Both filter then `.slice(-200)` (`useAnchorageStore.ts:2134` vs spec `:3327`).
- `useAnchorageStore.ts:2110`'s literal `/ 8`: matches the spec's own literal `/ 8` at `:3103`. `s.res.cpus` is display text only (`:3467`). Parity, not a broken binding.

---

## Corrected counts

**131 distinct findings** (raw 134; **−37 collapsed or dropped, +34 added** — a −3 net that conceals near-total churn).

| | blocker | high | medium | low | total |
|---|---|---|---|---|---|
| raw audit | 22 | 28 | 36 | 48 | 134 |
| after de-duplication | 15 | 19 | 28 | 36 | 98 |
| after severity corrections | 15 | 19 | 28 | 35 | 97 |
| **+ addendum findings** | 0 | +6 | +16 | +12 | **+34** |
| **corrected** | **15** | **25** | **44** | **47** | **131** |

By kind: missing-feature 30, visual-divergence 18, missing-screen 16, data-model-gap 14, copy-divergence 13, missing-interaction 12, theme-gap 12, extra-in-build 10, ia-divergence 5, convention-rule 1.

**Duplicate groups that collapsed (36 records → 14 deliverables):**

- **Feature maturity — 11 records → 1 blocker `maturity-chip-and-lifecycle-drawer-absent`.** Filed in all seven clusters: `settings-maturity-chip-and-lifecycle-drawer-absent`, three more under the same or near-identical id (security, workspace-ops, workspace-artifacts), `maturity-chip-titlebar-absent` ×2 (ai, shell), `maturity-drawer-absent`, `life-data-model-absent`, `lifecycle-drawer-absent`, `devenv-deprecation-unsignalled`. Chip and drawer are not separable — spec `:3448` makes the chip's `onClick toggleLife` the drawer's only entry point. LIFE is the data half, and it is 21 view keys / 101 entries at `:2599-2743`, not "31 AI entries". `devenv-deprecation-unsignalled` has no independent basis: `awk 'NR>=685 && NR<=730' | grep -inE 'deprecat|supersed'` over the spec returns nothing.
- **Nav IA — 4 records → `nav-groups-ia-divergence`** (`workspace-nav-order-diverges`, `nav-groups-diverge-from-v2-ia`, `nav-groups-differ`, `settings-status-bar-and-nav-group-divergence`). **high → medium**: once the AI group, SECURITY group, Logs/Kubernetes/Cloud rows and the Networks extra are counted separately, the residue is an edit to two arrays in `Shell.tsx:30-48` that blocks no capability.
- **Nav group blockers — 2 records dropped** (`nav-ai-group-absent`, `nav-security-group-absent`, both filed effort **xl**, double-counting the nine screens behind them; the canonical ai/security records are xs). `nav-logs-kubernetes-cloud-absent` folds into the three screen findings that already assert nav absence. `security-screens-have-no-unavailable-state` folds into `security-nav-group-absent` and misstates the failure mode besides — `PlaceholderScreen.tsx:14-17` types viewMeta as `Record<Exclude<ViewId,'containers'>,…>`, so the route it describes is a TypeScript compile error, not a shippable crash.
- **Theme families — 5 records → `themes-nous-and-mono-absent`**, **medium → high**. Monochrome is the "status read by lightness alone" accessibility guarantee (spec `:2582`), not a fourth palette. Effort **m → s**: both complete token rows are written out verbatim at spec `:40` and `:41` and can be pasted into a new `themes/mono.css`. The persistence-key claim leaves this finding's scope and stays with `settings-appearance-persistence-key-divergence`.
- **Networks extra — 4 records → `networks-screen-extra`** (low; the workspace-ops copy at medium was overstated — an extra working destination the spec omits is a scope question).
- **Chrome copy — 5 records → `chrome-version-and-banner-copy`** (three literal strings: `Shell.tsx:178`, `:248-249`, `:359`).
- Plus: `settings-enterprise-pane-absent` → `settings-enterprise-tab-absent`; `settings-section-nav-short` → `settings-nav-order-labels-and-default-tab`; `appearance-card-preview-divergence` and `appearance-card-copy-divergence` → their settings-cluster canonicals (carry forward the 3-vs-2 column grid and the Mode-before-Theme ordering); `titlebar-mode-toggle-absent` → `mode-toggle-titlebar-absent`; `containers-search-scope-and-navigation` → `global-search-navigator-divergence`; `posture-copy-system-absent` → the five AI screen blockers; `engine-card-memory-denominator` → `behaviour-resources-binding-dead`.

No duplicate ids remain. Note for the reader: the 15 blockers include `ai-nav-group-absent` and `security-nav-group-absent`, which are prerequisites of the nine missing-screen blockers behind them, not independent scope.

---

## Gaps the audit missed

34 new findings. **No Docker dependency** unless stated.

### High (6)

**`token-light-mode-foreground-derivation-absent`** — effort s, no Docker dependency. Spec `:31-32` aliases the five `-fg` tokens to their base in dark and `:42-48` re-derives them in light via `color-mix(… 70/70/66/72/80%, black)`; ~60 val-layer `-Fg` references consume them. Build: `grep -rn 'success-fg|danger-fg|warning-fg|violet-fg|accent-fg' app/src/styles app/src/theme` → **0**. Every chip uses its fill colour as its own text colour (`containers.css:191-193`, `:201-203`; `development.css:1293-1305`, `:1502-1505`; `builds.css:125-126`; `command-center.css:598-601`). Nine theme/hue combinations measure 3.88–4.34:1; the spec's ratios lift all to 5.46–7.93. Ten declarations per theme file plus repointing `color:` — a no-op in dark. **Highest leverage change in the addendum.**

**`token-primary-collapsed-into-accent`** — effort m, no Docker dependency. Spec keeps `--primary` a distinct hue in every family: nous `--accent:#8fb3ff` vs `--primary:#f2dbc5` on `--primary-fg:#0d2f86` (`:34`); github `--accent:#4493f8` vs `--primary:#238636` green (`:36`, `:37`), stated in the theme's own copy at `:2576` "blue links, green primary actions". Blast radius: 39 `var(--primary)` + 18 `var(--primary-fg)` + 5 `var(--primary-hi)` in markup plus ~25 val sites. Build: `themes/default.css:17-21` sets `--anc-accent` and `--anc-action-primary` to the **same hex**; `themes/github.css:16-20` makes primary blue. `grep -rn 'anc-action-primary' app/src` outside the theme files returns four rules (`shell.css:491,498`; `detail.css:79,85`; `command-center.css:504-510`; `development.css:417-426`) against 101 `--anc-accent*` references. Only `docker.css` is structurally right.

**`token-running-status-uses-accent`** — effort **xs**, no Docker dependency. Four rules in two files (`containers.css:103-106`, `:186-189`; `shell.css:364-372`, `:439-444`) against spec `:3287`, `:240`, `:2466`. The same build already uses `--anc-success` correctly for compose (`development.css:1502-1505`) and builds (`builds.css:55-57`), so it is internally inconsistent, not merely different. Consequence: one hue means both "healthy" and "selected"; unhealthy `#e07a72` desaturates to grey 143 against running `#8ba8f0`'s grey 167 — 24 levels on a 9px dot.

**`networks-error-renders-as-empty-state`** — effort s, Docker-adjacent (uses data already fetched). `refreshNetworks` (`useAnchorageStore.ts:678-693`) catches, calls `setError` and returns `[]` without touching `setNetworks`, so `networks` stays at its initial `[]` (`:428`) and `NetworksScreen.tsx:183-188` renders "No networks match / Clear the filter". `hostDomainState` (`:388-397`) is typed `Record<"snapshot"|"images"|"volumes", …>` — networks is absent. Docker always reports bridge/host/none, so a genuinely empty list is near-impossible: this empty state is almost always a mislabelled error. Images (`ImagesScreen.tsx:388-395`), Volumes (`VolumesScreen.tsx:82-89`) and Containers (`useAnchorageStore.ts:911-917`) are all protected. Spec cannot flag this class at all — it has zero loading/error/disconnected vocabulary in 4281 lines.

**`life-cloud-and-semantic-interception-label-unshipped-roadmap`** — effort **xs**, no Docker dependency. Four LIFE entries assign shipped maturity levels to items `docker-features.md` files under section 25, "What is genuinely upcoming": GPU instances `:2732` Early Access vs `:2255-2261` "availability is not clearly documented"; bring-your-own-cloud `:2733` Beta vs `:2263-2275` "no public general-availability date found"; CI integration `:2734` Beta vs `:2277-2287`; semantic interception `:2675` Experimental vs `:2289-2300` "I did not find definitive current documentation proving … has shipped". None appears in the source maturity table. This inverts the product's stated posture (`README.md:52-53`, "Maturity is labelled honestly … so nothing pre-release reads as settled") and **shrinks the Cloud blocker** to two corroborated GA rows (`:2730`, `:2731`). Fix: a sixth LVLS token ("Roadmap") or delete the four entries.

**`extensions-install-has-no-privilege-disclosure`** — effort **xs**, no Docker dependency. `docker-features.md:2218-2220` vs `ExtensionsScreen.tsx:48-59`. Static copy in a register the build already uses (`CommandCenter.tsx:938-940`). The screen is `UnsupportedSurface` in host mode (`ExtensionsScreen.tsx:6-15`), which makes an unqualified Install button in preview mode a demo of an action the product does not perform.

### Medium (16)

**`behaviour-no-simulation-clock-in-fixture-mode`** — effort l. Spec `:3064-3070` declares six intervals; the main tick at `:3084-3107` advances pulling containers by rnd(3,9)%, drifts CPU/MEM, appends a log line at p=0.6 and advances two 48-slot ring buffers. Every recurring timer in the build is host-gated (`useAnchorageStore.ts:900`, `:934`, `:1882`, `:1505-1519`); the only fixture-mode interval in the app is `StatusClock.tsx:41`. So the "Pulling" row sits at 12% forever (`fixtures.ts:161-179` → `ContainersScreen.tsx:196-197`), CPU/MEM hold their seed values, and the 36 fixture log lines never accrete — leaving the Follow pill and its scroll pin (`ContainerDetailScreen.tsx:497-501`) with nothing to react to.

**`behaviour-resources-binding-dead`** — effort **s**, no Docker dependency. Four one-line rebinds: `DashboardScreen.tsx:381`, `:389`, `:339` and `Shell.tsx:304-307` to `store.resources.*`. `resources` has exactly one reader (`SettingsScreen.tsx:323`, the slider that writes it); `appliedResources` has none. Retires `shell/engine-card-memory-denominator`.

**`behaviour-host-engine-telemetry-dropped`** — effort m, Docker-dependent (data already fetched). The aggregates exist (`useAnchorageStore.ts:2104-2120`) but the sampler that feeds them is gated on `view !== "containers"` (`:1882`), so leaving the Containers screen freezes them. Widening the sampler makes all three readouts computable.

**`behaviour-host-status-chip-vocabulary`** — effort s. Two-sided: the spec's literal `'Exited (0)'` for every stopped container is a simulation shortcut, so the real exit code is worth keeping; the regression is a relative-time sentence flowing into a chip designed for one or two words. Move the raw-status short-circuit below the vocabulary branches and use it as the tooltip.

**`row-hover-tint-neutral-where-spec-is-accent`** — effort s. Spec `:21` `--hover: color-mix(in srgb, var(--accent) 10%, transparent)`, applied at 13 row sites (`:354`, `:498`, `:565`, `:624`, `:645`, `:934`, `:1014`, `:1202`, `:1479`, `:1760`, `:1933`, `:2078`, `:2306`) — the most-used hover declaration in the file. Build: neutral `rgb(var(--anc-overlay-rgb) / 3.5%)` at `containers.css:85-87`, `resources.css:46-49`, `development.css:596`, `builds.css:40`; no `--anc-hover` token exists. This is the exact mirror of `nav-active-style-divergence`, which accent-tints the nav *active* row where the spec uses neutral `--muted` (`:3274`) — accent for persistent state, neutral for transient feedback, both backwards. Fix together as one token decision. Also: `.compose-row` (`development.css:1444-1446`) has no hover at all, against spec `:2078`.

**`responsive-single-breakpoint-vs-resizable-window`** — effort l. `window-geometry.mjs:1-5` allows 1080px against a 1600px design canvas; `grep -rn '@media' app/src/styles/` returns three hits, two of them `prefers-reduced-motion` and one width breakpoint (`settings.css:447`) collapsing one grid. At 1080px the containers table's flexible tracks get 263px → Name 96px, Image 96px, Ports 71px (vs Name 286px at 1600px). Nothing overflows — every flexible track is `minmax(0, …)` and `global.css:4-12` is `overflow: hidden` — so the degradation is silent, which is why `main.mjs:527-534` did not catch it. Also `.image-detail` (`development.css:955-965`) covers 49% of the pane at 1080px vs 30% at 1600px.

**`images-volumes-tables-have-no-empty-state`** — effort s, no Docker dependency. `VolumesScreen.tsx:130-131` and `ImagesScreen.tsx:44-47` map rows with no length guard; both lists are narrowed by the always-present titlebar search (`useAnchorageStore.ts:2448-2460`, `:2462-2471`). Any non-matching query silently blanks both tables under a live header. `ContainersScreen.tsx:437-450` and `NetworksScreen.tsx:183-188` both do it right. Reuse `.empty-state` (`containers.css:273-307`).

**`workspace-state-screen-is-unspecced-and-unrecorded`** — effort xs. The 13th screen (`WorkspaceStateScreen.tsx`, 72 lines, `states.css`, 138 lines) appears in **zero** of the 134 findings and zero atParity entries. Nothing in it diverges: the tile reuses the devenv empty-state geometry exactly and its `anc-state-spin` keyframe (`states.css:83-87`) is byte-identical to the spec's `ancSpin` at `:57` — which the spec declares and never references, the clearest signal that runtime states were out of the prototype's scope. Record it explicitly as an intentional extra, as `command-center-extra` already is, so a later "make it match the spec" pass cannot read the silence as licence to delete it.

**`navigation-stays-live-and-lies-during-a-non-ready-engine`** — effort s. `App.tsx:20-23` short-circuits the router, but `Shell.tsx:278-293` renders every nav button unconditionally with `aria-current={active ? "page" : undefined}` still tracking `store.view`; `grep -n disabled app/src/components/Shell.tsx` returns nothing. Clicking a nav item while disconnected repaints the active row and announces a page that is not rendered. The statusbar is honest (`Shell.tsx:355-362`); only the nav contradicts it.

**`token-warm-foreground-ramp-flattened-to-cool`** — effort s. Spec `:34` splits the ramp by temperature: four warm emphasis steps (`--fg:#f2dbc5` … `--fg-mono:#dccbb5`, hue ~29°) over six cool recessive steps (hue ~222°), with `C.warm` named at `:2477` and used as the active lift at `:3274`, `:3552`, `:3556`. Build `themes/default.css:42-54` puts all eleven steps at hue ~222°; grepping for "warm" or "cream" returns 0. Four hex values. Contrast is unaffected (11.4:1 vs 11.9:1 on `--anc-app`). Ship with `token-primary-collapsed-into-accent` — same design intent in two token slots.

**`containers-and-settings-carry-no-socket-or-shared-kernel-posture`** — effort **xs**, no Docker dependency. `docker-features.md:2173-2186` (daemon access is host-equivalent authority) and `:2188-2192` (containers share one guest kernel). `rg -in 'docker\.sock|shared kernel|privileged|isolation' app/src protocol core` returns only a fixture value and two test strings. The build has a sharper reason to say this than Docker Desktop does: `CommandCenter.tsx:944-950` already tells the user that `DOCKER_CONFIG` and `DOCKER_*` decide where commands land, but never that landing there is host-equivalent authority.

**`life-eci-and-windows-arm-have-no-surface`** — effort s. `docker-features.md:64` and `:69` have no LIFE entry. ECI appears once in the spec, at `:4267`, as a read-only Enterprise policy row with no explanation — and `SettingsScreen.tsx:16-23` has no Enterprise pane. ECI is load-bearing: `docker-features.md:2192` makes it the mitigation for the shared-kernel truth and `:1744-1770` explains why microVM Sandboxes are a different product, which is the conceptual spine of the spec's Sandboxes screen.

**`maturity-model-has-no-plan-entitlement-axis`** — effort s. Six source rows carry a plan qualifier (`docker-features.md:51`, `:64`, `:65`, `:66`, `:68`); LVLS (`:2744-2750`) is five tokens with a colour pair and nothing else. Consequence: a free-plan user sees "Cloud builders — GA", "Remote engine session — GA" and "Debug toolbox" with no indication all three are unreachable, and `preGA` (`:3384-3385`) counts only non-GA entries, so a screen made entirely of paid-plan GA capabilities reads "all GA" in green. `protocol/types.ts` `CapabilityStatus` → `UnsupportedSurface.tsx` is the natural place to hang it.

**`container-logs-assume-a-readable-logging-driver`** — effort s, **Docker-dependent and it changes a Docker-dependency call**. `docker-features.md:284-296` enumerates the configurable drivers; only json-file, local and journald support read-back. `anchorageBridge.ts:1526-1530` issues `["logs","--timestamps","--tail","200",id]` unconditionally and `useAnchorageStore.ts:1037-1047` feeds the rejection message verbatim into the log pane, so a fluentd container renders the daemon's raw error. `rg -in 'LogConfig|logging driver|json-file' app/src protocol core` returns nothing, though the full inspect document is already fetched and cached (`:1009-1016`). **This rescopes `workspace-ops/logs-screen-absent`**, which is a blocker filed on the premise that container output is uniformly fetchable.

**`proxies-settings-pane-omitted-from-both-spec-and-build`** — effort m, partial Docker dependency. `docker-features.md:691-707` (7.4); spec `setNavDefs` at `:3382` has ten panes and no proxies; `SettingsScreen.tsx:16-23` has six. `service.go:663-675` scrubs PATH/LD_*/DYLD_*/SSH_ASKPASS and the DOCKER_* target vars from spawned CLI processes but **not** HTTP_PROXY/HTTPS_PROXY/NO_PROXY, so ambient proxy env silently determines where Anchorage's own docker invocations route with nothing reporting it. The CLI-applied half lives in `~/.docker/config.json` under `proxies` — an ordinary file, no Desktop dependency. Daemon-level proxying is a systemd drop-in the API does not expose: stated-unavailable. PAC/SOCKS5/Kerberos/NTLM are Desktop-proprietary, out of scope.

**`volume-clone-and-empty-absent-under-a-GA-label`** — effort m, **no Docker dependency**. There is no `docker volume clone` or `docker volume empty`; Desktop implements both with helper containers, which is exactly what `core/internal/core/volumes_browse.go:141-185` `withVolumeHelper` already does for Browse/Back up/Restore. Two new call sites over existing infrastructure. Also record: `docker-features.md:503` (attached containers may need stopping) is the one 6.3 caveat the build already honours (`VolumeFilesPanel.tsx:121-124`, `VolumesScreen.tsx:245-251`) and both the spec and the audit missed; clone and empty need the same guard.

### Low (12)

- **`shell/toggle-readonly-locked-state-absent`** — xs. Spec `:971-972` (opacity 0.5, no onClick, padlock at `:966`), `:2034-2035` (0.55), `:2391-2392` (computed at `:4196`) against seven interactive tracks that all carry `cursor:pointer` plus an onClick — a deliberate third state. Build: one switch (`SettingsScreen.tsx:418`), no `disabled` prop, three CSS rules and no `--readonly`/`--locked`/`:disabled` variant. This is the state a host-mode build needs wherever Docker exposes a value it cannot change. **Carved out of the rewritten toggle finding so the two do not double-count.**
- **`titlebar-gutter-width-divergence`** — xs. 240px both flanks (spec `:80`, `:99`) vs 216px (`shell.css:73-79`, `:157-164`).
- **`empty-state-tile-border-bypasses-the-border-token-family`** — xs. Three components hardcode `1px dashed rgb(var(--anc-overlay-rgb) / 18%)` (`containers.css:282-291`, `development.css:212-221`, `states.css:11-21`) against spec `:394`/`:697` `var(--bd-strong)`. The literal matches `--anc-line-control` in exactly one of six theme/mode combinations (Default Light); Default Dark is 0.10 so it renders 80% stronger, and GitHub's border tokens are opaque hexes an overlay cannot track. This also narrows `devenv-empty-state-icon-divergence`, which claimed the tile "matches the spec exactly". `design-qa.md:81-83` asserts theme-dependent literals were removed; this is the counterexample.
- **`hover-overlay-scale-is-unnamed-and-drifting`** — xs. Five distinct opacities (3.5% ×9, 6% ×8, 8% ×2, 7%, 5%), none named, against the spec's 12 named values across 54 sites with zero raw literals.
- **`control-hover-uses-overlays-where-spec-uses-surfaces`** — xs. Ghost/icon/destructive tier only; the primary-button hover is at parity (`shell.css:497-499`). The destructive tint is 14% (`containers.css:268-271`) against the spec's 16% (`:29`) — a straight numeric miss.
- **`transform-transitions-escape-reduced-motion`** — xs. `development.css:709`, `:719`, `:1471` are not in the `states.css:89` block. WCAG 2.3.3. Three selectors.
- **`workspace-state-screen-has-no-live-region`** — xs. `WorkspaceStateScreen.tsx:44-70` is a plain `<section>`; the build uses `role="status"` 32 times elsewhere. `status` for loading, `alert` for disconnected/permission/error.
- **`spec-controls-would-regress-accessibility-if-ported`** — xs, and it is a **rule, not a defect**. The spec has zero `tabIndex`, `role=`, `aria-*` and `:focus` in 4281 lines; every control is a bare `<div onClick>`. The build has a global `:focus-visible` ring (`global.css:59-68`), four radiogroups with roving tabindex, `role=` 92 times and `aria-label` 78 times. **Record once and apply to every cluster: the spec is authoritative for visual and behavioural parity and never for semantics — a parity fix may add role/aria/tabindex/focus, never remove or weaken one.** Without this written down, a literal reading of the toggle and segmented-control findings imports 22 screens' worth of unfocusable divs.
- **`filter-empty-state-has-no-invalid-input-branch`** — s. Spec `:4125-4126` plus the red input border at `:4098`, driven by the try/catch at `:3412-3415` — the only error affordance in the whole file. Filed because `logs-regex-and-saved-filters-absent` scopes it to the absent Logs screen, leaving the general pattern unrecorded: if regex lands in any filter, the invalid branch must land with it.
- **`unsupported-surface-has-no-posture-statement`** — xs. The residue of the dropped `posture-copy-system-absent`. `UnsupportedSurface.tsx:30`.
- **`volume-contents-disclosure-not-stated`** — xs. `VolumeFilesPanel.tsx:69-70` explains the mechanism honestly and `:121-124` guards in-use writes, but nothing states what reading discloses. Back up (`VolumesScreen.tsx:148-157` → `ArchivePathDialog.tsx`) writes volume contents to an operator-chosen host path: a database volume archived to `~/Downloads` is a plaintext copy of everything the workload was trusted with. The spec's equivalent copy exists only on the absent Secrets screen (`:1971`).
- **`copy-generated-run-command-absent`** — s, no Docker dependency. `docker-features.md:470`. Pure client-side derivation from the inspect document already cached at `useAnchorageStore.ts:1009-1016`; `commandCenterModel.ts:56-90` `secretArgumentIndices` already knows how to mask `-e DB_PASSWORD=…`.

### Cheap, no Docker dependency, sequencing-relevant

`token-running-status-uses-accent` (4 rules), `token-light-mode-foreground-derivation-absent` (10 declarations/theme), `behaviour-resources-binding-dead` (4 rebinds), `extensions-install-has-no-privilege-disclosure` (one paragraph), `life-cloud-and-semantic-interception-label-unshipped-roadmap` (delete 4 rows), `containers-and-settings-carry-no-socket-or-shared-kernel-posture` (two sentences), `images-volumes-tables-have-no-empty-state`, `transform-transitions-escape-reduced-motion`, `empty-state-tile-border-bypasses-the-border-token-family`, `workspace-state-screen-has-no-live-region`, `shell/toggle-readonly-locked-state-absent`, `titlebar-gutter-width-divergence`. Together: three WCAG defects, two honesty defects and a broken binding, none needing a Docker capability.

---

## Changes to the sequencing plan

**Tranche 1 — Nav IA restructure + level-chip primitive.** *Loses urgency, gains nothing.* `nav-groups-ia-divergence` drops high → medium once the AI/SECURITY groups and the Logs/Kubernetes/Cloud rows are counted separately; the residue is an edit to two arrays in `Shell.tsx:30-48`. It stays first only because tranche 2 depends on it. **Add:** dropping `aria-current` when `engineStatus !== "ready"` (`navigation-stays-live-and-lies-during-a-non-ready-engine`) — same file, same pass, and it is the one nav defect that mis-announces.

**Tranche 2 — Maturity chip + drawer + LIFE catalogue.** *Loses effort, gains a source and a correctness obligation.* The catalogue is a transcription of `docker-features.md:46-70`, not authored content: the data-model half drops s → xs. But it gains three items that must land with it, not after:
- Reconcile the 2 outright level disagreements, the 3 silently-resolved status words and the 2 missing rows (`life-eci-and-windows-arm-have-no-surface`).
- Delete or relabel the 4 roadmap entries (`life-cloud-and-semantic-interception-label-unshipped-roadmap`). Shipping a drawer that launders unannounced availability into "Early Access" is worse than shipping no drawer — the drawer *is* the honesty posture.
- Add the plan-entitlement axis (`maturity-model-has-no-plan-entitlement-axis`), because `preGA` at `:3384-3385` will otherwise render an all-paid-plan screen as "all GA" in green.

**Tranche 3 — Correctness and copy sweep.** *Gains the most work, and it is the right home for all of it.* Add: `behaviour-resources-binding-dead` (4 rebinds, retires `engine-card-memory-denominator`), `behaviour-host-status-chip-vocabulary`, `images-volumes-tables-have-no-empty-state`, `networks-error-renders-as-empty-state`, `transform-transitions-escape-reduced-motion`, `workspace-state-screen-has-no-live-region`, `empty-state-tile-border-bypasses-the-border-token-family`, `titlebar-gutter-width-divergence`, `shell/toggle-readonly-locked-state-absent`, `control-hover-uses-overlays-where-spec-uses-surfaces` (the 14%→16% tint), `unsupported-surface-has-no-posture-statement`, and the three posture-copy items (`extensions-install-has-no-privilege-disclosure`, `containers-and-settings-carry-no-socket-or-shared-kernel-posture`, `volume-contents-disclosure-not-stated`). Also record `spec-controls-would-regress-accessibility-if-ported` as a standing rule at the head of this tranche — it constrains every later tranche and costs nothing.

**NEW tranche 3.5 — Token semantics. Insert before tranche 4; it is a hard dependency of it.** Four changes in order: `token-light-mode-foreground-derivation-absent` → `token-running-status-uses-accent` → `token-primary-collapsed-into-accent` → `token-warm-foreground-ramp-flattened-to-cool`, plus `row-hover-tint-neutral-where-spec-is-accent` and `nav-active-style-divergence` fixed together as one decision (they are the same swap in both directions, and `nav-active-style-divergence` also occurs in `settings.css:43-46`, a file it does not cite). **Justification for moving it earlier than everything else visual:** nine theme/hue combinations are below WCAG AA today, which outranks every cosmetic item in tranches 3 and 4; and Monochrome is unbuildable until Running reads green and primary is separated from accent — in mono, accent `#d0d0d0` and green `#cfcfcf` are the same lightness band, so Running and healthy would be visually identical, and `--primary #f0f0f0` vs `--accent #d0d0d0` is the only thing separating a primary button from a selected chip in greyscale.

**Tranche 4 — Monochrome + Appearance card miniature.** *Gains a dependency, loses effort.* Now blocked on tranche 3.5. Effort m → s: both mono token rows are verbatim in the spec at `:40` and `:41`, with the card swatch tuple at `:2582-2584` and the desk backdrops at `:2586` — a ~165-line paste, an import in `themes/index.css`, a `THEME_FAMILIES` entry and a `THEME_OPTIONS` row. Carry forward from the collapsed duplicates: the theme grid is 3 columns where the spec is 2 (`settings.css:263-267`), and the spec orders Mode before Theme (`:774`, `:786`) where `SettingsScreen.tsx:218-304` reverses it.

**Tranche 5 — Promote what already has live backing.** *Unchanged in scope; gains two candidates that also have live backing.* Add `volume-clone-and-empty-absent-under-a-GA-label` — `volumes_browse.go:141-185` already provides the helper-container mechanism, so this is two call sites, not a capability — and `behaviour-host-engine-telemetry-dropped`, which is one gate widened on a sampler the build already runs. Both are "promote existing backing", which is exactly this tranche's premise.

**Tranche 6 — The eleven absent destinations.** *Shrinks, and two members change shape.*
- **Cloud shrinks materially:** three of five LIFE.cloud rows describe capabilities Docker has not shipped, so the correct scope is Remote engine session and Cloud builders plus a roadmap note — not a full screen.
- **Logs grows:** it must include a per-source "this container's logging driver does not support read-back" state, using the existing `UnsupportedSurface`/`DetailCapabilityState` pattern. `HostConfig.LogConfig.Type` is already in the cached inspect document.
- **Every AI and Security screen gains an acceptance criterion:** "includes the screen's not-a-boundary posture box", inherited from the dropped `posture-copy-system-absent`.
- **Effort corrections:** the two nav-group blockers are **xs**, not xl — the xl figures double-counted the nine screens behind them.

**Two items that belong to no tranche and should be scheduled separately:** `responsive-single-breakpoint-vs-resizable-window` (effort l, a token/grid architecture change — express the table grids in a shared token that swaps to a reduced column set below ~1240px and make the 420px panels `min(420px, 45%)`) and `behaviour-no-simulation-clock-in-fixture-mode` (effort l, only affects the preview mode the design captures were taken in — real, but it competes with host-mode work for no host-mode benefit).

**One item to move earlier out of order:** `shell/iconography-library-vs-inline` was low/effort-m and would have been swept up in tranche 3. It is medium/effort-l — 19 files, ~37 glyphs, 2 dependencies dropped. Take the decision *now* whether inline SVG is wanted at all, before tranches 4-6 add more screens that import Phosphor and Lucide directly and grow the 19 files further.

---

# Part 3 — What the first audit missed

*The completeness critic's original findings. Part 2 closes these; this section is retained as a
checklist for future parity passes.*

## Gaps in the audit itself

### 1. Six findings cite a spec section that does not exist
`grep -ci crosscutting` returns **0** across `Anchorage v2.dc.html`, `support.js`, `README.md` and `docker-features.md`. Yet these findings quote "Anchorage v2.dc.html crossCutting" as primary spec evidence:
- shell/`command-center-extra` ("NO GLOBAL COMMAND PALETTE…"), shell/`iconography-library-vs-inline`
- workspace-core/`containers-table-extras` ("there is no column sorting…")
- ai/`toggle-switch-component-absent`, ai/`segmented-control-absent`, ai/`theme-token-triads-missing`
- security/`security-cluster-tokens-named-differently`

The AI verifier caught exactly one instance (`posture-copy-system-absent`) and stopped there. Every other crossCutting-sourced claim is unfalsifiable against the handoff as delivered. **Where to look:** re-derive each from file evidence (some are true — 42 of 47 SVGs are `viewBox="0 0 16 16"`, stroke-widths 1.3–1.6; and there really are zero sort/multi-select handlers in 252–540) or drop them.

### 2. `--primary` vs `--accent` is a token collapse nobody named
The spec carries `--primary`/`--primary-fg`/`--primary-hi` as a **separate hue from `--accent`**. In nous, primary is warm cream `#f2dbc5` on `--primary-fg:#0d2f86` while accent is blue `#8fb3ff`; in docker, primary `#1d63ed` vs accent `#4a9bff`; in github, primary is *green* `#238636` vs accent blue `#4493f8` (spec lines 19, 36–41).

The build has `--anc-action-primary`, but it is set **equal to `--anc-accent`** in `themes/default.css:16,19`, and it is referenced in only 5 CSS files / 10 declarations (`grep -rc anc-action-primary app/src/styles/*.css`) — `settings.css`, `dashboard.css`, `containers.css`, `resources.css`, `builds.css`, `workspace.css` all use **zero**. Only two findings brushed this (settings/`…mode-control-not-segmented`, appearance card) as local cosmetics. It is systemic: every primary action in the product is painted accent.

### 3. `Running` status is accent, not green — across the most-repeated element in the app
`app/src/styles/containers.css:103-106` — `.status-dot--running { background: var(--anc-accent); box-shadow: 0 0 0 3px rgb(var(--anc-accent-rgb)/15%) }` and `:186-189` `.status-pill--running` = accent tint + accent text. Spec `statusOf` (line 3286) returns `C.greenFg` on `var(--green-bg)` with `var(--green-ring)`.

workspace-core listed "All four spec status chip strings and their precedence" as **at parity** (it checked strings only). shell/`statusbar-engine-dot-hue` caught the same accent-for-green substitution but scoped it to two dots in the chrome. Nobody checked the containers table. `--anc-success` exists and is used in builds/settings/development but never for container running state.

### 4. Settings → Resources drives nothing; the spec binds it to three other surfaces
Spec `s.res` is read by `statCards[2].unit = 'of ' + s.res.cpus + ' cores'`, `statCards[3].unit = 'GB / ' + s.res.mem + ' GB'` (3466–3468), `engineMemW = clamp((memUsedGB / s.res.mem)*100, …)` (3464), and `tick()`'s memHist normalisation (3106).

In the build `grep -rn "store.resources" app/src --include=*.tsx` returns **one** consumer — the slider that writes it (`SettingsScreen.tsx:323`). `DashboardScreen.tsx:381,389` hardcode `unit="of 8 cores"` and `unit="GB / 16 GB"`; `Shell.tsx:304-307` divides by literal `16`; `useAnchorageStore.ts:2110` divides by literal `8`. workspace-core listed the hardcoded units under **"Preview stat tile content verbatim"** in its at-parity list, so the at-parity claim actively conceals the broken binding. shell/`engine-card-memory-denominator` found the `16` but framed it as "should come from the host" and missed that the spec's source is the slider.

### 5. Loading / error / disconnected states: zero findings, and a whole build screen unmentioned
`app/src/screens/WorkspaceStateScreen.tsx` is a 13th screen with four engine states (`loading` / `disconnected` / `permission` / `error`), its own icon-tile design language and `app/src/styles/states.css` (138 lines, its own `anc-state-spin` keyframe). It appears in **none** of the ~120 findings.

The spec has no loading, error or disconnected state anywhere (`grep -ci "loading\|skeleton\|retry\|spinner\|disconnect"` = 4, all incidental) — its `ancSpin` keyframe (line 57) is **declared and never used**. So the parity target is silent on the shipped product's most common runtime condition, and nobody said so. **Where to look:** `states.css`, `WorkspaceStateScreen.tsx`, and the fact that `Shell.tsx:308-321` already derives per-status engine-card headings the spec has no vocabulary for.

### 6. Empty states were never inventoried as a class
Spec carries 8 inline dash-states (`— no log output —` 447, `— none —` 1132, `— sandbox stopped —` 1184, `— no active session —` 1581, `— watch is off —` 2135, `— nothing matches —` / `— invalid regular expression —` 4126) plus 5 heading-style ones (393, 601, 699, 1342, 2448 `Nothing tracked for this view yet.`). The audit covers four of these and only where a screen owner happened to trip over one. Nobody checked the build's *own* empty states on Networks, Compose, Builds, Volumes against the spec's voice, and nobody noticed the build has no counterpart to the spec's two-branch filter empty state (`nothing matches` vs `invalid regular expression`).

### 7. Hover/focus/selection: 54 declared hover states in the spec, never diffed
`grep -c style-hover` = **54**. My earlier assumption and several findings ("no hover style is declared on nav rows at all" — shell/`nav-active-style-divergence`) happen to be right for nav specifically, but no cluster enumerated the other 53. Separately: the spec has **zero** `tabIndex`, `role=`, `aria-*` or `:focus` rules in 4281 lines — it is inaccessible by construction. Several findings treat the build's real a11y (radiogroup, roving tabindex, `role="switch"`) as a bonus; none flags the systemic risk that "parity" here means regressing. **Where to look:** decide once, in writing, that a11y is a one-way ratchet before anyone ports a spec control literally.

### 8. Motion and responsive behaviour: no findings at all
Spec: `grep -c transition` = **0**; three keyframes, one unused; no `@media` anywhere; fixed 1600×1000. Build: 10 `transition` declarations across 5 files, and exactly **one** breakpoint in the entire product (`settings.css:447`, `max-width: 1180px`). The shipped app is a resizable native window with a fixed 216px sidebar, a fixed 440px search field and fixed-track table grids (`tokens.css:12-18`). Nobody assessed what happens below ~1180px, and the spec provides no guidance because it cannot resize.

### 9. The audit's own remediation advice on iconography is wrong
shell/`iconography-library-vs-inline` says "The AnchorageIcon registry is the right seam — swapping the definitions to inline SVG is contained to one file." `grep -rln "@phosphor-icons/react\|lucide-react" app/src` returns **19 files** — 12 components and 6 screens import icon components directly, bypassing the registry (`ImagesScreen.tsx`, `NetworksScreen.tsx`, `VolumesScreen.tsx`, `DevEnvironmentsScreen.tsx`, `PlaceholderScreen.tsx`, `WorkspaceStateScreen.tsx`, all seven dialogs, `SortableHeader.tsx`, `UnsupportedSurface.tsx`, both file panels). 26 distinct icon components are imported outside the union. Sizing and seam analysis both need redoing.

### 10. Host-mode status bar is not at parity, but three clusters said it was
shell ("Status bar is exact"), workspace-artifacts and workspace-ops all certify the status bar. `Shell.tsx:371-387` inserts a `<select data-testid="context-picker">` between the engine label and the counts whenever `store.isHost && availableContexts.length > 0`, and `:391-395` replaces the spec's `{{ engineCpu }} CPU · {{ engineMem }} MEM` segment with the literal string `"live metrics on container Stats"`. Two divergences in the element three clusters called exact. (workspace-ops did use the context picker to *refute* `cloud-ephemerality-posture-absent` — so it was seen, and still not recorded as a status-bar divergence.)

### 11. The mono theme's token values are sitting in the spec, unread
shell/`theme-mono-absent` was downgraded on the reasoning that "the spec states no global 'status never encoded by hue alone' constraint." The constraint is encoded in the **palette itself** — spec lines 40–41: mono-dark `--green:#cfcfcf --amber:#9a9a9a --red:#ededed --violet:#7e7e7e --blue:#b5b5b5`; mono-light `--green:#4a4a4a --amber:#6a6a6a --red:#1a1a1a`. Status separates by lightness, deliberately. Two full token rows (all 36 vars × 2 modes) are ready to port and no finding quotes a single one. Read against §3: `--anc-success` and `--anc-danger` in `default.css` sit at near-identical lightness, so mono would immediately expose the containers table.

### 12. Light-mode foreground derivation ratios never checked
Spec lines 42–48 re-derive `--green-fg`/`--red-fg`/`--amber-fg`/`--violet-fg`/`--accent-fg` in light mode via `color-mix(… N%, black)` at **70/70/66/72/80%** respectively. shell lists "Light mode re-derives status foregrounds" as at-parity by pointing at two hex values in `default.css`. Nobody compared the resulting contrast, and nobody noted that the build has no `--anc-violet-fg` derivation at all in light mode.

### 13. Design-QA state knobs: the spec declares them, the build's capture surface was never checked against them
`data-props` at line 2476 declares exactly three: `showUpdateBanner` (bool), `simSpeed` (0.25–4), `emptyDevEnvs` (bool, section **"States"**). `emptyDevEnvs` is the only declared state variant in the whole handoff (consumed at 3548 as `devEmpty`/`devHas`). The build has `?capture=<state>` (`docs/parity-and-release-gates.md:199-202`, cited by the settings verifier) but no finding asks whether the capture harness can reach the spec's one declared state, or whether the gate captures the empty Dev Environments frame at all.

### 14. The constants/timer region 2476–4281 was mined for screens, not for behaviour
Screen-shaped constants (SEED, IMAGES, HUB, VOLUMES, BUILDS, STEPS, DEVENVS, EXTS, LIFE) are well covered. The behavioural half is not:
- **Six timers with distinct cadences** (3064–3070): main tick `1100/speed`, clock `1000`, sbx `1700/speed`, agent `2600/speed`, gateway `2100/speed`, compose-watch `3000/speed`, each with a floor. Only the 1s clock was compared. The build's polling intervals (`useAnchorageStore.ts:921, 958, 1921`) were never diffed against the 1.1s main tick.
- **`logs[n.id] = arr.slice(-260)`** (3096) — a 260-entry per-container buffer. Build caps at 500 and renders the last 200 (`useAnchorageStore.ts:2123-2135`). Never compared.
- **`restart(id)`** (3305) is stop-then-start with a **600ms** gap, not a `docker restart`. Never compared to `store` semantics.
- **`statusOf` returns the literal `'Exited (0)'`** for every stopped container (3287); workspace-core's at-parity entry says the build reproduces "Exited (n)". The spec has no `n`.
- **`view` initialises to `'containers'`, not `'dashboard'`** (3016) — the settings cluster diffed `setTab`'s default but nobody diffed the app's default view.
- `componentDidUpdate` (3077–3082) declares four independent scroll-pinning behaviours (play, chat, logs-when-following, terminal). Only the logs one was checked.

### 15. `docker-features.md` is effectively unread
Two passing mentions in ~120 findings. Concretely unused:
- **§2 (lines 42–71)** is a 28-row authoritative maturity table — GA / Beta / Early Access / Experimental / Deprecated per capability, with sources. It is plainly the source for `LIFE`/`LVLS`. Every maturity finding says "the LIFE catalogue is static content that needs authoring" without pointing at the table that already contains it, and nobody cross-checked spec `LIFE` levels against §2 (e.g. §2 says MCP Toolkit **Beta**, MCP profiles **Early Access**, Dynamic MCP **Experimental**, Wasm **Deprecated**).
- **§24, "The most significant security truths" (2171–2247)**, is 12 numbered items that map one-to-one onto the spec's "does not protect" copy (§24.3 Gordon is an operator not a sandbox → spec 1437; §24.7 MCP tools inherit real-world authority → spec 1641; §24.5 clone mode discloses ignored files → spec 3636; §24.8 Model Runner unauthenticated → spec 1267). The AI cluster's `posture-copy-system-absent` was downgraded partly for lacking a spec anchor — the anchor is here, and it also gives the four *shipped* screens posture obligations (§24.1 socket access, §24.2 containers are not mutually isolated, §24.9 extensions are highly privileged, §24.10 secrets are visible to the workload) that no cluster assigned to Containers, Volumes or Extensions.
- **§6.10 Docker Debug** (589–600) — a real Desktop capability for distroless/slim containers. Mentioned once in passing ("the missing Debug toolbox") and never made a finding, despite `ContainerFilesPanel.tsx:28-35` explicitly solving the same distroless problem.
- **§7.4 Proxies** (691–707) — a Settings surface present in neither the spec's ten panes nor the build's six; nobody flagged the handoff's own omission.
- **§6.7 Quick Search** (550–561) — the actual Docker Desktop behaviour behind the spec's "search is a navigator" decision. The build deliberately diverges (`useAnchorageStore.ts:985-991`) and two clusters recommend the spec adopt the build; neither checked what Docker itself does.

### 16. Duplicate-finding accounting is unmanaged
The maturity chip/drawer/LIFE gap is filed **seven times** across six clusters (`lifecycle-drawer-absent`, `maturity-chip-titlebar-absent`, `maturity-chip-and-lifecycle-drawer-absent` ×3 under identical ids, `maturity-drawer-absent`, `life-data-model-absent`, `settings-maturity-chip-and-lifecycle-drawer-absent`), at severities ranging high→blocker→medium. Nav-group divergence is filed **five** times; the Networks-extra observation **four** times; theme-family naming **five** times; the update-banner/version copy **four** times. Nothing in the output reconciles them, so any severity roll-up double- to seven-fold-counts. **Where to look:** collapse on `id` and on spec line ranges before ranking.
