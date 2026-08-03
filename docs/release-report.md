# Anchorage 0.1.0 release verification

Status: **passed** on 2026-08-03 for the Linux x86_64 AppImage.

## Certified artifact

| Item | Value |
| --- | --- |
| AppImage | `app/release/Anchorage-0.1.0-x86_64.AppImage` |
| Size | 93,329,326 bytes |
| SHA-256 | `2ba863ddb4b09a2caff337d2f2dacbf6c43e7cb79acde8be91a2cc31178ca3d6` |
| Release receipt | `app/release/release-verification.json` |
| Receipt SHA-256 | `fd28ac94b6c13451c6dad33149da8946009ff2bd9b95be5402b2f6e4a4734b21` |
| Core SHA-256 | `f39a914f33765d7a554f0109653d75810be61927651d35d555e8fd2f42c6dc5f` |
| Renderer SHA-256 | `48e7bf02a8a56dc4abd422ded94f6acef5c2cd12772b357a48e960d4bbb7afde` |
| Electron runtime closure | 13 files, 140,285 bytes, SHA-256 `18972d5b44dc48f7c36833000d3d2281e5568258676e2172c943e9ae325f00fb` |
| Signing | Unsigned |

The release pipeline rebuilt the core and renderer, built the AppImage,
smoke-tested the unpacked application, extracted the AppImage, verified its exact
payload against the staged candidate, smoke-tested the extracted AppImage, and
only then wrote the passing receipt.

## Theme and native-window result

- Appearance now offers Default, Docker, and GitHub themes in Dark and Light
  modes through one 72-token semantic contract.
- The versioned selection persists with strict validation and safe fallback.
  The canonical capture route remains immutable Default Dark.
- Docker uses the current Ocean Blue, Light Blue, and Deep Blue family; GitHub
  uses current Primer light/dark canvas, foreground, border, and accent values.
- Runtime content now fills the native viewport. The old 28 px blue capture
  canvas, rounded outer frame, and shadow exist only on the explicit
  `?capture` route.
- Linux uses a frameless Electron window, removing the GTK titlebar. The native
  Wayland/X11 shadow and extended resize boundary remain so edge resizing still
  works.
- Native background color follows the active theme before the window is
  revealed, preventing a Default-blue flash around light themes.
- Native and renderer geometry was verified at 1600 x 1000 initial,
  1080 x 700 minimum, 1800 x 1100 expanded, and 1600 x 1000 restored.
- A real X11 smoke race was found during release packaging. The verifier now
  requires a stable geometry interval and idempotently retries a dropped
  programmatic resize. The original loop failed 5/12 runs; the hardened loop
  passed 12/12, followed by passing unpacked and extracted-AppImage smokes.

## Installed Docker CLI coverage

- The host client/server used for discovery and read-only acceptance was Docker
  29.6.2 with API 1.55. Isolated mutation conformance used Docker 29 DinD server
  29.7.0.
- Recursive help discovery found 244 canonical advertised command nodes and 219
  canonical advertised leaves, including installed plugin subtrees.
- All 219 discovered leaves are transport-reachable through Docker Command
  Center; none are blocked.
- This is complete discovered-command inventory and transport coverage, not 219
  independent behavioral executions. The capability ledger intentionally records
  zero per-leaf command-conformance claims.
- Common container, image, volume, inspect, stats, logs, exec, pull, cleanup,
  and lifecycle workflows have first-class UI or structured bridge support. The
  discovered long tail is available through pinned or explicitly disclosed
  literal-target Command Center execution.
- Hidden commands and aliases are not separate inventory rows. Literal argv
  remains available to a user who knows the command.

## Correctness evidence

- Aggregate JavaScript tests: **223/223 passed**:
  136 renderer, 1 protocol, 3 security-evidence, 10 package-policy,
  69 Electron, and 4 Sites handoff tests.
- Strict renderer typecheck: passed with zero diagnostics.
- Go core race tests and Go vet: passed.
- Read-only host acceptance: **8/8 passed**, with cleanup passed.
- Disposable behavioral conformance: **18/18 passed**, covering image
  pull/removal/pruning, container lifecycle, PTY and pipes sessions, pinned and
  literal Docker targets, snapshot/list behavior, and exact volume cleanup
  semantics. Owned DinD resources were verified absent afterward.
- Production HostBridge candidate: **12/12 checks passed** across nine live host
  screens. It covered containers, images, volumes, container detail, pinned and
  literal Command Center modes, outside-home Compose working-directory
  execution, unsupported host states, and clean shutdown.
- Production build: passed with 6,383 modules transformed.
- Unpacked Electron application smoke: passed.
- Extracted AppImage Electron smoke: passed.

## Design conformance

- All **24/24 canonical handoff states** were captured at 1656 x 1056 and
  passed the normalized mean absolute pixel-error review threshold of 0.02.
- The worst measured state was `container-detail-logs` at `0.0153812`.
- Every reference and implementation was reviewed in the same combined
  source-left/implementation-right input for geometry, typography, colour,
  borders, radii, spacing, iconography, layering, clipping, scrolling, and
  state-specific content.
- Renderer evidence is bound to SHA-256
  `48e7bf02a8a56dc4abd422ded94f6acef5c2cd12772b357a48e960d4bbb7afde`.
- The claim is complete canonical-state coverage with reviewed visual
  conformance; it is not a claim of zero differing pixels.

Evidence:

- `artifacts/design/design-ledger.json` — SHA-256
  `6d29374bfc42e33040672c8b92c8da9b1f41e16d3b257e873f1d430a2dea3390`
- `docs/design-qa/visual-review-attestation.json` — SHA-256
  `c99d7a84861b56b82f5d55654e170afa2392639679e22654edcdb43848830bf5`
- `docs/design-qa/final-actual/capture-provenance.json` — SHA-256
  `e431bd4cda423427ae58cbba40d4f0943893c78bf44c45e67ee6f195947bc4f6`
- `design-qa.md` — complete browser, responsive, paired-review, and finding
  record; final result passed.

## Performance evidence

The authoritative read-only release profile ran for 1,800.002 seconds against
the certified core. All **26/26** SLO checks passed.

| Metric | Result |
| --- | ---: |
| Cold health, including process spawn | 34.572 ms |
| Warm health p95 | 0.332 ms |
| Containers first / warm p95 | 41.984 / 37.796 ms |
| Images first / warm p95 | 946.990 / 932.650 ms |
| Volumes first / warm p95 | 1,242.375 / 1,891.895 ms |
| Four-way stats wall p95 | 26.311 ms |
| Individual stats p95 | 26.278 ms |
| Core RSS p95 / max | 13,598,720 / 14,397,440 bytes |
| Positive RSS growth | 0 bytes |
| Stream events / acknowledgements | 13,326 / 13,326 |
| Stream bytes / acknowledged bytes | 23,612,499 / 23,612,499 |
| Dropped bytes / truncated output | 0 / false |
| Cancel-to-exit | 4.362 ms |
| Core exit | 0 |

The current HostBridge candidate also passed all six UI-performance checks:
first contentful paint was 820 ms, navigation DOM content loaded was 172.7 ms,
the slowest scripted interaction settled in 2,960.15 ms, and the live
102-container screen remained within the DOM/row bounds.

## Security and packaging

- Six behavioral Electron security controls passed.
- The dependency audit reported zero known vulnerabilities at every severity.
- The renderer is sandboxed with Node integration disabled, context isolation
  and web security enabled, deny-by-default permissions/downloads/navigation/
  popups, and a production CSP.
- Both packaged smokes dynamically verified the complete preload bridge,
  absence of Node from the renderer main world and a real Web Worker, disabled
  packaged DevTools, the core handshake, native/renderer viewport convergence,
  and exact runtime sizing.
- Electron 43.2.0, electron-builder 26.15.3, and lucide-react 1.28.0 are exact
  release-critical pins enforced by package-policy tests.

## Explicit product boundaries

Docker Desktop-private surfaces are not falsely presented as Docker Engine
features. Live build history, Dev Environments, Extensions, Docker resource
settings, and container Files show explicit unsupported/unavailable states in
host mode unless an applicable installed CLI command is available through
Command Center. This checkout had no buildx plugin, so buildx-only data was not
discovered.

This release is an unsigned Linux x86_64 AppImage. It does not include a `.deb`,
macOS installer, or Windows installer.
