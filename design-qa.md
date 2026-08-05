# Anchorage design QA

## Comparison target

- Source visual truth: `docs/design_handoff_anchorage/Anchorage v2.dc.html`,
  `docs/design_handoff_anchorage/README.md`, and
  `docs/design_handoff_anchorage/support.js`.
- Measured baseline: the 24 renders in `docs/design-qa/reference/`, produced from
  that comp by `tools/capture-design-reference.mjs` and bound by
  `docs/design-qa/reference/reference-provenance.json`.
- Rendered implementation: the 24 production-renderer captures in
  `docs/design-qa/final-actual/`, bound by
  `docs/design-qa/final-actual/capture-provenance.json`.
- States: Containers default/current/only-running/search-empty/row-hover/banner
  dismissed; all six Container Detail tabs; Dashboard; Images local/registry;
  Volumes; Builds; Dev Environments; Extensions; and all five handoff Settings
  sections.
- Source and implementation dimensions: 1656 x 1056 CSS and physical pixels at
  device scale factor 1. Both contain the 1600 x 1000 handoff frame inside the
  same 28 px capture canvas. No image resizing or density normalization was
  applied.
- Capture runtime: deterministic FixtureBridge data rendered from the exact
  production build through Electron/Chromium. The capture-only route locks
  Nous Dark, hides the added Appearance row, and suppresses the maturity chip so
  the original handoff states remain structurally comparable.

## The baseline moved, and that is the headline

The baseline used until now was `docs/design_handoff_anchorage/reference-captures/`
— 24 renders of **`Anchorage.dc.html`**, the v1 comp, committed in the initial
commit. The build has since been migrated to the v2 handoff. Measured against v1,
all 24 states scored **0.098 – 0.123** normalized MAE on a 0.02 threshold,
uniformly, including states nobody had touched.

That uniformity was the tell. The v1 captures sit **0.098** away from the v2 comp
itself, which is very nearly the 0.110 they sit from the build. The build and the
v2 comp agree with each other far more closely than either agrees with v1: the
ruler had moved, not the thing being measured.

Two further properties of the retired baseline are worth recording, because both
were invisible until looked for:

- Every one of its 24 files is **quality-80 JPEG data carrying a `.png` extension**.
  Re-encoding an exact render at that quality costs ~0.004 normalized MAE on its
  own, roughly a fifth of the threshold, permanently and for nothing.
- It was never documented. `docs/design_handoff_anchorage/README.md` does not
  mention the captures, their viewport, or the state list, so nothing recorded
  which comp they came from.

The baseline is now **generated rather than pasted**, from whichever comp is the
current source of record, by a checked-in harness. Its provenance carries the
comp's own SHA-256, so the next handoff revision leaves a detectable mismatch
instead of a silent one. The v1 set is kept exactly as shipped and is no longer
measured against.

### Reproducing the baseline

```
node tools/capture-design-reference.mjs            # renders Anchorage v2.dc.html
node tools/capture-design-reference.mjs --comp "docs/design_handoff_anchorage/Anchorage.dc.html"
```

The comp carries no test ids — it is an `<sc-for>`/`<sc-if>` template document
rendered by `support.js` — so each state is driven against what the design puts on
screen, and any step that fails to resolve aborts the run by name rather than
capturing a wrong screen silently. Pointing it at the v1 comp does exactly that:
it stops on `settings-engine`, because v1 calls that section "Docker Engine" and
v2 calls it "Engine".

Two properties of the comp constrain what a pixel metric can mean here:

- It animates. Seven `setInterval` timers drive values through `Math.random()`,
  plus a per-second clock, so no two captures of one state are byte-identical.
  Measured self-disagreement is **~0.0002** normalized MAE — two orders of
  magnitude under the threshold, which is what makes a live comp usable as a
  baseline at all.
- It exposes only three authored knobs (`showUpdateBanner`, `simSpeed`,
  `emptyDevEnvs`). The other 21 states are reached by driving the prototype, and
  `containers-row-hover` requires a real `sendInputEvent` — CSS `:hover` ignores a
  synthetic `MouseEvent`, and the first attempt captured an unhovered row while
  reporting success.

## Result

- **14 of 24 states are within the 0.02 review threshold.** Worst passing state:
  0.0197.
- **10 states exceed it**, every one attributable to an enumerated, deliberate
  build addition rather than to drift:

  | State | MAE | What accounts for it |
  |---|---|---|
  | `extensions` | 0.0439 | Added privilege paragraph; single-token tile marks |
  | `containers-row-hover` | 0.0265 | Containers additions, plus a hover fill measuring 0.0046 off base where the comp's measures 0.0022 |
  | `containers` | 0.0257 | Container-isolation posture paragraph (~35px translation), checkbox column, sort chevrons, `All projects` compose filter, compose badges, fourth row action, and a `Networks` destination the v2 comp's nav does not list |
  | `containers-current` | 0.0257 | As `containers`; byte-identical to it, which is the correct idempotent outcome |
  | `containers-banner-dismissed` | 0.0252 | As `containers`, reflowed |
  | `container-detail-logs` | 0.0237 | As `containers`, plus a live log stream holding a different tail on each side |
  | `dashboard` | 0.0237 | Live chart samples; `Prune system` action widened to match the handoff wording |
  | `containers-only-running` | 0.0234 | As `containers`, less three rows |
  | `settings-resources` | 0.0224 | `Builders` rail row inserted; v2 type ramp runs the slider stack at 91px pitch against the comp's 94px |
  | `containers-search-empty` | 0.0205 | As `containers` |

- `container-detail-stats` passes with its two history bands masked; the mask
  covers sample values only and leaves panel, label, and chart geometry measured.

**The gate now accepts these as budgeted divergences.** A state over the pixel
threshold ships only while its measured error stays at or under a budget recorded
in the attestation, alongside an enumeration of what accounts for it. Budgets are
`measured + max(3x that state's comp noise, 0.002)`, rounded up — the comp
animates, and its three live-data states move 0.0024–0.0033 between runs where the
static screens move 0.00002. Nothing may be budgeted above
`DESIGN_VISUAL_DIVERGENCE_CEILING` (0.05).

The mechanism is a ratchet, not a waiver, and was mutation-tested to prove it:
a budget below its own measurement, a budget above the ceiling, an empty reasons
list, and a deleted divergence record are each rejected, while the unmutated
control stays budgeted. Six equivalent cases are locked into
`scripts/package-evidence-policy.test.mjs`. A state that earns its way back under
the threshold is reported `retirable`, so the exception gets deleted rather than
left to authorise future drift.

## Evidence

- Renderer build:
  `2a371bf01901c1404a798fe091ceadd291d759574c0ff8b70f9326aec2be48ae`
  (19 files, 1,357,835 bytes).
- Design handoff source (comp + README + support.js + baseline):
  `d4838915012ebe3993668d989b0ab4e7c633b3b86b48dbf35ab74af77ecca4bd`.
- `Anchorage v2.dc.html`:
  `309dd687aaf8cf311db0f874281eae0771f9447a2c9dabd4c198fb583544052c`
  (365,700 bytes).
- Capture provenance SHA-256:
  `852624976326e286c5ad0f0049020f8db7679f07748f2d14a297f6672b87d5f7`.
- Paired-review attestation SHA-256:
  `b5e4a4c2bc6069754ad3ba555266c1851afb9806a87c4cba2c77ae652036f9f8`.
- Design ledger SHA-256:
  `42c0c22730a641befbc9773cb0dcaa9317036e4c9d29c3171efaa3131fea0ab1`.
- Per-state diffs and masked comparisons: `artifacts/design/`.

The attestation carries a distinct note per state — what was compared, what was
found, what was fixed before the record, and which criteria a still frame cannot
speak to. It is bound by SHA-256 to both images it describes, so re-rendering
either side invalidates it rather than letting an approval outlive what it
approved. The previous attestation is a worked example of why that matters: it
carried one boilerplate sentence across six states, still describing "a Networks
entry that postdates the handoff" from the two-group sidebar era.

## Defects found and fixed during this review

1. `.logs-filter input` was unscoped and overrode Container Detail's deliberate
   `border: 0` by source order, drawing two nested borders 11px apart. Scoped to
   `.logs-screen`.
2. The header action cluster had no `flex-shrink: 0`, wrapping "Run new" onto two
   lines inside a 32px control.
3. Registry and Extensions tile marks paired `--anc-accent-deep` with an ink
   designed for `--anc-accent`, measuring 1.62–1.66:1. Both rebuilt as the chip
   construction the theme layer guarantees; `scripts/theme-integrity.test.mjs`
   now measures that pair per family.
4. The active nav row could sit below the sidebar fold with no active row rendered
   anywhere. Fixed with `scrollIntoView` plus an overflow affordance.
5. A 12px outlined pause-circle merged into a smudge at capture density.
6. The Dashboard fixture action read "Clean up images" where both handoffs specify
   "Prune system"; widened the action rather than narrowing the words.
7. `containers-row-hover` in the reference harness captured an unhovered row and
   reported success, because CSS `:hover` does not respond to synthetic events.

## Required fidelity surfaces

- Fonts and typography: IBM Plex Sans and IBM Plex Mono, weights, hierarchy,
  wrapping, truncation, and monospaced density align across all paired states.
- Spacing and geometry: capture frame, title bar, sidebar, banner, cards,
  tables, tabs, empty states, borders, radii, and vertical rhythm retain the
  handoff geometry except where the build adds a surface, and every such addition
  is enumerated above. Runtime mode removes the capture canvas and fills the
  native content viewport exactly.
- Colors and tokens: Nous Dark reproduces the handoff palette, including the
  places where the handoff's own aliasing costs contrast — nous dark status chips
  land at 2.05–3.87:1, held to the design's measured values by
  `scripts/theme-integrity.test.mjs` rather than quietly corrected. All four
  families in both modes are driven from semantic tokens.
- Assets and icons: the Anchorage mark is vector and correctly placed. Icons use
  exact-pinned, tree-shaken Lucide and existing Phosphor components; no emoji,
  text-symbol, CSS-art, or custom inline-SVG substitute was added.
- Copy and content: headings, controls, table labels, tabs, empty-state copy,
  status content, and fixture state are checked across all 24 canonical states.
- Interaction and accessibility: navigation, filters, search, hover, tabs,
  toggles, settings radios, and window controls have semantic labels and working
  keyboard behavior. `aria-current` is dropped while the engine is not ready.
- Window behavior: Linux uses `frame: false`, removing the GTK titlebar while
  retaining the native Wayland/X11 resize boundary. Initial, minimum, expanded,
  and restored native content sizes converge exactly with the renderer.
- Viewport resilience: runtime is verified at 1080 x 700 minimum, 1600 x 1000
  initial, and 1800 x 1100 expanded sizes. The fixed 1656 x 1056 route is only
  the canonical design-capture surface.

## Decisions

1. **The `Networks` destination stays** (decided 2026-08-05). The v2 comp's nav does
   not list it; Docker exposes networks, and a Docker manager that cannot show them
   is answering a question the engine can answer. This is a permanent, accepted
   divergence rather than an open item: it is enumerated in the `containers`
   divergence record and inherited by all six Containers states, and it is the one
   budgeted difference that is not expected to be closed by a future design
   revision absorbing it. It shifts the sidebar from `Builds` down by one row,
   which is most of what those states' residual error is.

## Open questions

1. **Is the Containers hover fill correct at roughly twice the comp's strength?**
   Measured 0.0046 against the design's 0.0022. Either the build should match the
   design or the design should adopt the stronger fill; nothing depends on it
   staying as it is.
2. **Nine of the ten budgets are meant to be temporary.** A budget is a recorded
   licence for one state to differ from the design by a stated amount — see the
   Result section for the list and what accounts for each. Every one except the
   `Networks` row above should end by the design absorbing the addition or the
   build dropping it. They are not a backlog of defects: each is a difference
   somebody looked at and accepted. Leaving them indefinitely is how a threshold
   quietly stops meaning anything, which is the failure this whole baseline
   exercise was cleaning up after.
