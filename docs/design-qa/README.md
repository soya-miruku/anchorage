# Design QA evidence

The release acceptance inputs are the 24 PNGs under `final-actual/`, their
`capture-provenance.json`, the hash-bound
`visual-review-attestation.json`, and
`artifacts/design/design-ledger.json`.
`tools/capture-design-parity.mjs` captures the exact production renderer build
through Electron/Chromium at the handoff's 1656 x 1056 outer viewport.
`tools/measure-design-parity.mjs` pairs those files with
`docs/design_handoff_anchorage/reference-captures/`, writes pixel diffs, and
requires an explicit paired visual review before promoting a row to `passed`.
The sidecar records an identified reviewer, the complete review criteria,
state-specific notes, and the exact reference and actual PNG fingerprints for
all 24 states. An environment flag or unbound checkbox is not review proof.

The ledger and package policy bind the exact renderer, PNG hashes and
dimensions, capture/comparison harnesses, handoff HTML/README/support files, and
reference capture set, and visual review sidecar. The canonical run uses
deterministic FixtureBridge data
so the same named states can be compared. Production HostBridge integration is
captured separately under `artifacts/host-candidate/` and is not represented as
fixed-data pixel parity.

`comparisons/` contains older manual contact sheets, and `invalid/` contains
discarded capture experiments. Neither is a release input.

Dynamic container metrics, status transitions, clocks, log contents, and chart
samples may differ. Only the two changing Stats history plots are masked;
geometry, design tokens, static copy, and interaction state are not.
