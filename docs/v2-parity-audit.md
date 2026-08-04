# Anchorage v2 design-parity audit

**4 August 2026.** Build (`app/`, `core/`, `protocol/`) against `docs/design_handoff_anchorage/Anchorage v2.dc.html`
— 21 screens, four nav groups — and its source research `docker-features.md`.

**131 findings: 15 blocker · 25 high · 44 medium · 47 low.** Full evidence, per-finding citations and
the audit's own correction log are in [v2-parity-audit-evidence.md](v2-parity-audit-evidence.md).

---

## Verdict

The build is not a partial v2. It is a complete implementation of a **smaller product**. Ten of v2's
21 destinations exist and most are pixel-exact; the other eleven do not exist as routes at all —
`app/src/types.ts:1-11` closes the `ViewId` union at ten keys, so they are not expressible. Two of
four nav groups (AI, Security) are absent wholesale.

The gap is **breadth, not depth**. Where the build ships a screen it usually beats the prototype.
Where it does not, it ships nothing — not even the explicit unavailable state its own no-invention
policy calls for, which is the one thing that policy exists to produce.

Roughly half the missing surface is genuinely blocked on Docker capabilities absent from a plain
Linux Engine install. The correct closure for those is a stated unavailable state, not construction.

---

## Screen parity

| Screen | Group | Status | Headline gap |
|---|---|---|---|
| Dashboard | Workspace | Partial | Host mode drops the CPU/MEM sparklines and activity feed; two of four tiles report capacity, not utilisation — `DashboardScreen.tsx:192-261` |
| Containers | Workspace | Shipped | Beyond spec (sorting, multi-select, pause). Running is painted accent, not green |
| Compose | Workspace | Partial | Flat table instead of the 270px project rail; all five detail panels absent — `ComposeScreen.tsx:97-329` |
| Images | Workspace | Shipped | Ships a mutation/detail surface v2 dropped |
| Volumes | Workspace | Shipped | Exceeds spec; clone and empty missing under a GA label |
| Builds | Workspace | Partial | Cancelled and running builds paint red on a live engine — `BuildsScreen.tsx:103-105` |
| Logs | Workspace | **Absent** | Per-container tab exists; the merged cross-source stream does not |
| Kubernetes | Workspace | **Absent** | One Settings toggle. Zero hits in `core/` or `protocol/` |
| Bosun | AI | **Absent** | No assistant — and no tool-call approval pattern anywhere in the product |
| Models | AI | **Absent** | No local-inference surface |
| Agents | AI | **Absent** | No delegation tree, `agent.yaml` render or session log |
| Tools | AI | **Absent** | Loses the CREDENTIALS / CONTAINER LIMITS / REAL-WORLD AUTHORITY grid that carries the product's central argument |
| Sandboxes | AI | **Absent** | The microVM isolation model has zero representation |
| Scan | Security | Partial | Live Scout SARIF exists, but only inside the Images drawer — `ImageDetailPanel.tsx:207-302` |
| Hardened | Security | **Absent** | Zero hits repo-wide |
| Secrets | Security | **Absent** | No reference registry or backend selector |
| Governance | Security | **Absent** | No enforcement chain or audit table |
| Cloud | Platform | **Absent** | One grep hit repo-wide, and it is a Traefik description |
| Dev Environments | Platform | Shipped | At parity; interactive where the spec is inert |
| Extensions | Platform | Shipped | At parity — but Install has no privilege disclosure |
| Settings | Platform | Partial | 6 of 10 panes; host mode collapses all but Appearance |

**5 shipped · 5 partial · 11 absent.**

---

## Already at parity

Shell chrome is pixel-faithful — 46px titlebar, 216px sidebar, 35px nav rows, 26px status bar, the
2.4s `ancPulse` keyframe correctly suppressed under `prefers-reduced-motion`. Token architecture is
sound: single-root `data-theme` stamping, 144 `--anc-*` declarations per family with dark and light
blocks, tints composed from `-rgb` triples rather than hardcoded rgba. Typography and spacing are
exact. The four shipped workspace screens match down to grid templates and verbatim empty-state copy.

**Accessibility exceeds the spec, and must stay that way.** The prototype has zero `tabIndex`,
`role=`, `aria-*` or `:focus` rules in 4281 lines — every control is a bare `<div onClick>`. The
build has a global `:focus-visible` ring, four radiogroups with roving tabindex, `role=` 92 times.
**Standing rule: the spec is authoritative for visual and behavioural parity, never for semantics.**
A parity fix may add role/aria/tabindex/focus; it may never remove one.

---

## Gaps ranked

### Blocker (15)

**The AI group and its five destinations.** Spec `:173-196`, screens `:1003-1749`. No group, no
`ViewId` members, no protocol types, no core source. *Docker-blocked:* `docker sbx`, `docker model`
and `docker agent` are absent; `docker mcp` and `docker ai` are present but **unadvertised** — a
third capability state the code does not model, distinct from "not installed". Two pieces cost
nothing regardless: Tools' authority grid (`:1625-1642`, pure layout and copy) and Bosun's approval
card, the only thing in the design expressing "an agent proposed this; a human must approve it".

**The Security group and its four destinations.** Spec `:198-217`, screens `:1751-2067`. Scan is the
exception — `core/internal/core/scout.go` is live and careful, just buried in a drawer.

**Logs, Kubernetes and Cloud.** Logs is buildable now (`docker logs -f` + `buildx history logs`);
Kubernetes is read-only-buildable (`kubectl` is installed); Cloud shrinks to two rows once the
unshipped LIFE entries are removed.

**Maturity chip + lifecycle drawer + LIFE catalogue.** Filed independently by all seven review
clusters. Spec `:100-102`, `:2424-2463`, `:2599-2743`. Zero representation in the codebase. No
Docker dependency — and the catalogue is a *transcription* of `docker-features.md:44-70`, not
authored content.

### High (25) — the five that are cheap and unblocked

| Gap | Evidence | Effort |
|---|---|---|
| **Light-mode `-fg` derivation absent.** Every chip uses its fill as its own text colour. Nine theme/hue combinations measure 3.88–4.34:1 — below WCAG AA. The spec's `color-mix(… 70/70/66/72/80%, black)` at `:42-48` lifts all to 5.46–7.93 | `grep -rn 'success-fg\|danger-fg\|warning-fg\|violet-fg\|accent-fg' app/src/styles app/src/theme` → **0** | s |
| **Running status painted accent, not green.** Green never appears on the Containers screen. The build already uses `--anc-success` correctly for compose and builds — internally inconsistent, not merely different | `containers.css:103-106`, `:186-189`; `shell.css:364-372`, `:439-444` vs spec `:3287` | **xs** |
| **`--primary` collapsed into `--accent`.** The spec keeps them distinct hues in every family — github's primary is *green* `#238636` against a blue accent, stated in the theme's own copy at `:2576`. Every primary action in the product is painted accent | `themes/default.css:17-21` sets both to the same hex; 4 rules use it against 101 `--anc-accent*` references | m |
| **Network fetch errors render as an empty state.** `refreshNetworks` catches, sets an error and returns `[]` without touching `setNetworks`, so the screen says "No networks match / Clear the filter". Docker always reports bridge/host/none, so this empty state is almost always a mislabelled error | `useAnchorageStore.ts:678-693`, `NetworksScreen.tsx:183-188`. Images, Volumes and Containers are all protected | s |
| **Four LIFE entries label unshipped capabilities as shipped.** GPU instances "Early Access", bring-your-own-cloud "Beta", CI integration "Beta", semantic interception "Experimental" — all four are filed by `docker-features.md` §25 under *"What is genuinely upcoming"*, none appears in its maturity table | spec `:2732-2734`, `:2675` vs `docker-features.md:2255-2300` | **xs** |

Also high: **Extensions Install has no privilege disclosure** (an extension can carry backend
containers, socket access and host executables — `ExtensionsScreen.tsx:48-59` is a bare toggle);
Settings' three missing panes; the Dashboard activity feed; VEX exception control; and the missing
Monochrome theme (see below).

### Medium (44) / Low (47)

The bulk is Compose's five detail panels, Scan's promotion to a destination, Settings > Builders
(data already decoded at `core/internal/core/builds.go:228-268` and unused), and a copy/correctness
sweep. Two that matter more than their severity:

- **Settings → Resources drives nothing.** `store.resources` has one reader — the slider that
  writes it. Dashboard hardcodes `"of 8 cores"` / `"GB / 16 GB"` (`DashboardScreen.tsx:381,389`),
  Shell divides by a literal 16. `appliedResources` has **zero** readers: `Apply & restart` is a
  dead write (`useAnchorageStore.ts:537-539`, `:3452-3455`). Four one-line rebinds.
- **Builds misreports live state.** `BuildsScreen.tsx:103-105` collapses five statuses to
  `success ? success : failed`, so cancelled *and running* builds paint red — while
  `builds.css:63-65` already defines the neutral style it should use. **xs.**

---

## Design system

**Themes — one family missing, plus a rename and a re-tint.** Build ships `default/docker/github`;
spec declares `nous/github/docker/mono`. The house theme is not "nous renamed" — spec nous is royal
blue `#0d2f86` with a warm cream primary `#f2dbc5`; `themes/default.css:5-20` is indigo with a cool
accent and no cream. **Effort is s, not m:** both complete mono token rows are written out verbatim
at spec `:40` and `:41`, ready to paste.

Monochrome is the priority, because it is the accessibility harness — it surfaces every place status
is carried by hue with no shape, label or lightness backup. It is also **unbuildable until the token
fixes land**: in mono, accent `#d0d0d0` and green `#cfcfcf` sit in the same lightness band, so
Running and healthy would be visually identical.

**Nav IA** — four groups vs two, and Compose sits third in v2 against sixth in the build
(`Shell.tsx:30-48`). An edit to two arrays. Do it before the eleven new destinations land, or the
reshuffle happens twice.

**Chip system** — the largest missing primitive. Five-level maturity chips, `EXPERIMENTAL`,
`SIGNED`/`UNSIGNED`, `INIT`/`SERVICE`, kind chips. The build has status pills and severity tags but
no level-chip concept. Building it once unblocks five surfaces.

**Hover and active states are backwards in both directions.** The spec tints *hover* with accent at
10% across 13 row sites and leaves the *active* nav row neutral `--muted`; the build does the
opposite. One token decision fixes both.

**Iconography — take the decision now.** 19 files import Phosphor and Lucide directly; 18 bypass
`AnchorageIcon.tsx` entirely. A swap to the spec's inline 16px set is ~37 glyphs across 19 files,
not "contained to one file". Every screen added later grows that number.

---

## Keep from the build, against the spec

Command Center (the release-gate coverage path for every discovered CLI leaf) · Networks (core
Engine surface the spec omits) · search that filters in place instead of hijacking navigation on
every keystroke · container table sorting, multi-select and pause · Processes and Changes tabs · the
real tar-walking Files browser that works on distroless · the `UNSPECIFIED` fifth severity bucket ·
scanner attribution and truncation disclosure · opt-in `Analyze` with latency copy · separate
`betaChannel` and `telemetry` flags (the prototype binds both to one key, so opting into pre-release
builds silently enables telemetry) · real window controls and real engine state.

`WorkspaceStateScreen.tsx` — loading / disconnected / permission / error — has no spec counterpart
at all; the prototype's `ancSpin` keyframe is declared and never used. Record it as an intentional
extra so a later "make it match the spec" pass cannot read the silence as licence to delete it.

---

## Sequencing

1. **Nav IA + level-chip primitive.** *(s–m, no Docker dependency.)* Restructure to four groups with
   the ten existing destinations; build the chip once. Add: drop `aria-current` when the engine is
   not ready — the nav currently announces pages that are not rendered.
2. **Maturity chip + drawer + LIFE.** *(m.)* Transcribe from `docker-features.md:44-70`, then
   reconcile: 2 outright level disagreements, 2 missing rows, 4 roadmap entries to delete. Shipping
   a drawer that launders unannounced availability into "Early Access" is worse than shipping none —
   the drawer *is* the honesty posture.
3. **Correctness and copy sweep.** *(all xs–s.)* Builds status collapse, Resources rebinds, empty
   states on Images/Volumes, the Networks error case, three posture-copy items, version strings.
4. **Token semantics.** ← **new, and it must precede Monochrome.** `-fg` derivations → Running green
   → primary/accent separation → the warm foreground ramp, plus the hover/active swap. Justified by
   the nine sub-AA combinations, which outrank every cosmetic item above.
5. **Monochrome + Appearance card miniature.** *(s.)* Paste both token rows; settle the four
   canonical family names.
6. **Promote what already has live backing.** *(m–l, no new Docker dependency.)* Scan as a
   destination, Settings > Builders, Compose master/detail via `compose config`, volume clone/empty
   over the existing helper-container mechanism.
7. **The eleven absent destinations, capability-triaged.** Land as routes in one pass, each resolving
   to a real surface or an explicit `UnsupportedSurface` naming the missing capability. Logs must
   include a per-container "this logging driver does not support read-back" state. Model the third
   capability state this host demonstrates: **binary present but unadvertised**.

**Scheduled separately:** responsive behaviour (one breakpoint against a window that resizes to
1080px — nothing overflows, so the degradation is silent) and the fixture-mode simulation clock
(every recurring timer is host-gated, so preview containers sit frozen).
