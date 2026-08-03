# Anchorage design QA

## Comparison target

- Source visual truth: `docs/design_handoff_anchorage/Anchorage.dc.html`,
  `docs/design_handoff_anchorage/README.md`, `docs/design_handoff_anchorage/support.js`,
  and the 24 images in `docs/design_handoff_anchorage/reference-captures/`.
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
  Default Dark and hides the added Appearance row so the original handoff states
  remain structurally unchanged.

## Combined visual evidence

- Full-view source/implementation comparisons:
  `artifacts/design/contact-sheets/theme-window-final/final-reviewed-1.png`
  through `final-reviewed-4.png`.
- Per-state source-left/implementation-right pairs:
  `artifacts/design/contact-sheets/pairs/<state>.png`.
- Focused evidence:
  `artifacts/design/contact-sheets/icons-focused-final.png`,
  `actions-focused-final.png`, `topbar-focused-final.png`,
  `empty-focused-final.png`, and `worker-status-focused-final.png`.
- Every reference and implementation was judged from a combined pair, at the
  same viewport and state. Screenshots were not reviewed in isolation.
- Renderer build:
  `48e7bf02a8a56dc4abd422ded94f6acef5c2cd12772b357a48e960d4bbb7afde`
  (21 files, 1,112,029 bytes).
- Capture provenance SHA-256:
  `e431bd4cda423427ae58cbba40d4f0943893c78bf44c45e67ee6f195947bc4f6`.
- Paired-review attestation SHA-256:
  `c99d7a84861b56b82f5d55654e170afa2392639679e22654edcdb43848830bf5`.
- Design ledger SHA-256:
  `6d29374bfc42e33040672c8b92c8da9b1f41e16d3b257e873f1d430a2dea3390`.
- Result: 24 of 24 states passed the 0.02 normalized-MAE review threshold.
  The worst state was Container Detail Logs at 0.0153812. Only the changing
  CPU and memory history samples in Container Detail Stats were masked; the
  surrounding chart geometry and labels remained visible.

## Browser-rendered interaction evidence

- Preview: `http://127.0.0.1:4180/`, kept open in the user's selected in-app
  browser.
- Final reload produced zero console errors and zero warnings.
- All six Appearance combinations were exercised: Default, Docker, and GitHub,
  each in Dark and Light mode. The selected theme/mode, root color scheme,
  semantic app background, and native-safe background token all agreed.
- Theme radio groups were checked with pointer selection, Arrow keys, Home/End,
  selected-state semantics, and roving `tabIndex`.
- Persistence was verified by selecting Docker Light, observing `Saved`,
  reloading, and confirming Docker Light restored. The preview was then returned
  to Default Dark with Settings > Appearance open.
- Layout was checked at 1080 x 700, 1600 x 1000, and 1800 x 1100. At each size,
  the desk, shell, document root, body, and scrolling element matched the
  viewport with no blue surround, document overflow, or clipped settings cards.
- The in-app browser screenshot backend tiled frames at its 0.75 device scale
  factor, so it was not used as normalized image evidence. Canonical Electron
  captures provide the screenshot comparison; the in-app browser provides the
  independent DOM, console, interaction, persistence, and responsive evidence.

## Required fidelity surfaces

- Fonts and typography: IBM Plex Sans and IBM Plex Mono, weights, hierarchy,
  wrapping, truncation, and monospaced density align across all paired states.
- Spacing and geometry: capture frame, title bar, sidebar, banner, cards,
  tables, tabs, empty states, borders, radii, and vertical rhythm retain the
  handoff geometry. Runtime mode removes the capture canvas and fills the native
  content viewport exactly.
- Colors and tokens: Default Dark preserves the handoff palette. Modular
  semantic tokens drive all six theme/mode combinations; theme-dependent literal
  colors were removed from feature styles.
- Assets and icons: the source Anchorage logo remains sharp and correctly
  placed. Icons use exact-pinned, tree-shaken Lucide and existing Phosphor
  components; no emoji, text-symbol, CSS-art, or custom inline-SVG substitute
  was added.
- Copy and content: headings, controls, table labels, tabs, empty-state copy,
  status content, and fixture state are checked across all 24 canonical states.
- Interaction and accessibility: navigation, filters, search, hover, tabs,
  toggles, settings radios, and window controls have semantic labels and working
  keyboard behavior. Runtime window controls expose 24 x 24 hit targets while
  capture mode preserves the source's 13 px dots.
- Window behavior: Linux uses `frame: false`, removing the GTK titlebar while
  retaining the native Wayland/X11 resize boundary. Initial, minimum, expanded,
  and restored native content sizes converge exactly with the renderer.
- Viewport resilience: runtime is verified at 1080 x 700 minimum, 1600 x 1000
  initial, and 1800 x 1100 expanded sizes. The fixed 1656 x 1056 route is only
  the canonical design-capture surface.

## Findings and comparison history

1. Earlier paired review corrected P1 shell-icon silhouettes and a health-first
   status defect where `worker-queue` rendered Running instead of Unhealthy.
2. Focused follow-up corrected P2 container-row, volume-cylinder, empty-state,
   and Extensions silhouette/size residuals with measured closest-library icons.
3. Theme/window hardening review found and fixed a capture-only Appearance-row
   parity regression, incomplete radio keyboard behavior, GitHub Dark danger
   contrast, stale maximize labels, inaccurate persistence status, host Settings
   defaulting to an unavailable section, native blue background flash, and small
   runtime window-control targets.
4. Final recapture and combined-pair review found no remaining actionable P0,
   P1, or P2 issue.

Non-blocking P3 closest-library residuals remain: one extra AppWindow title-bar
dot, minor RadioButton/Copy interior geometry differences, a joined stroke in
rotated Lucide Blocks, and a smaller filled-square corner radius in the
search-empty glyph.

## Verification

- Renderer typecheck: passed with zero diagnostics.
- Renderer tests: 136/136.
- Electron tests: 69/69, including stable geometry and dropped-resize retry
  regression coverage.
- Aggregate JavaScript tests: 223/223.
- Production build: passed, 6,383 modules transformed.
- Repeated native geometry smoke: 12/12 after hardening, versus 5/12 failures in
  the original high-reproduction loop.
- Packaged runtime: unpacked application smoke and extracted AppImage smoke both
  passed.

## Open questions

- None for the requested theme, window, and canonical design-parity scope.

final result: passed
