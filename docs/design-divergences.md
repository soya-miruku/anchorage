# Where the build differs from the handoff, and what to do about it

**Nothing is outstanding.** All 21 canonical states measure under the review threshold, none is on
a budget, and there is no decision waiting on the designer. This file used to say the opposite and
had been saying it for eleven days after it stopped being true — see *What changed* at the bottom,
which is the part worth reading if you acted on the old version.

Measured against `docs/design_handoff_anchorage/Anchorage v2.dc.html` (v2.5), both sides rendered
in the same appearance — whatever a fresh install ships, which the rig reads from the renderer's
own source rather than naming. Threshold **0.02**, ceiling **0.05**. Numbers are normalized mean
absolute pixel error. Regenerate with `node tools/measure-design-parity.mjs`; the live figures are
in `artifacts/design/design-ledger.json`, which is what the release gate actually reads.

## Every state, as measured

| State | Divergence | Headroom to threshold |
|---|---|---|
| `container-detail-logs` | 0.0196 | 0.0004 |
| `containers-row-hover` | 0.0188 | 0.0012 |
| `containers` | 0.0184 | 0.0016 |
| `containers-current` | 0.0184 | 0.0016 |
| `containers-banner-dismissed` | 0.0173 | 0.0027 |
| `dashboard` | 0.0158 | 0.0042 |
| `containers-only-running` | 0.0156 | 0.0044 |
| `container-detail-inspect` | 0.0121 | 0.0079 |
| `containers-search-empty` | 0.0115 | 0.0085 |
| `container-detail-files` | 0.0105 | 0.0095 |
| `builds` | 0.0103 | 0.0097 |
| `images-registry` | 0.0092 | 0.0108 |
| `settings-resources` | 0.0090 | 0.0110 |
| `container-detail-mounts` | 0.0088 | 0.0112 |
| `container-detail-exec` | 0.0086 | 0.0114 |
| `images-local` | 0.0072 | 0.0128 |
| `container-detail-stats` | 0.0071 | 0.0129 |
| `volumes` | 0.0068 | 0.0132 |
| `settings-engine` | 0.0067 | 0.0133 |
| `settings-advanced` | 0.0053 | 0.0147 |
| `settings-updates` | 0.0051 | 0.0149 |

`containers` and `containers-current` are byte-identical: re-selecting the destination you are
already on is idempotent, which is correct behaviour rather than a divergence.

## The one worth watching

`container-detail-logs` sits **0.0004** under the threshold. That is close enough that an
unrelated change to the log viewport — a row height, a gutter, a font fallback — could push it over
without anyone intending to touch it. It is not a defect and needs no decision now; it is the state
most likely to be the next one to ask for one.

## What "passed" means here, and what it does not

The ledger's claim is `reviewed-visual-conformance-not-pixel-identity`. A row reaches `passed`
because a named reviewer compared the reference and the actual render and recorded a judgement
against stated criteria, with both PNG fingerprints bound into
`docs/design-qa/visual-review-attestation.json`. The pixel number is the trigger for that review,
not a substitute for it — `docs/design-qa/README.md` puts it plainly: *an environment flag or
unbound checkbox is not review proof*.

So "0 over threshold" does not mean the build is pixel-identical to the comp. It means every
difference that exists was looked at by a person and accepted.

## What changed, and why this file was wrong

The previous version of this document reported **eight of 24 states over the threshold on
per-state budgets** — `containers` at 0.0260 against a 0.028 budget, `containers-row-hover` at
0.0279 against 0.029, and so on — and asked the designer for three decisions.

Every one of those numbers was superseded on 8 August by `c80f681` (*"Recapture the design
evidence, and un-invert two states"*) and `e0f4b7b`, which regenerated the ledger. The five
`containers` states now measure 0.0156–0.0188 against a flat 0.02, the per-state budget mechanism
no longer exists, and the state count moved from 24 to 21 when the unshipped destinations were
removed. The file was never updated, so it spent eleven days asking for decisions about
divergences that had already gone.

If you read the old version and were weighing whether the design should absorb the container
isolation paragraph or the build should drop it: that question is closed. The paragraph is in, the
states are under threshold with it, and nothing needs to move.

## Re-measuring after a toolchain change

The ledger binds to one exact renderer build, so upgrading React, vite, Electron or anything else
that changes the bundle will fail packaging with *"canonical handoff visual conformance ledger must
identify the exact freshly built renderer"* — even when nothing visible has changed. That is the
gate working: it cannot know the pixels are unmoved until someone measures.

The August 2026 toolchain upgrade is the worked example. React 19.2.0 → 19.2.8, vite 6 → 7 and
lucide-react 1.28 → 1.31 all changed the bundle and **moved nothing**: all 21 captures came back
byte-identical to the images the signed review already covered, so the attestation still bound and
no re-review was owed. The sequence, if you need it again:

```bash
bun run build                                # the renderer the ledger will describe
node tools/capture-design-parity.mjs         # 21 states through Electron at 1656x1056
node tools/measure-design-parity.mjs         # pairs them with reference/, writes the ledger
```

Both `docs/design_handoff_anchorage/` and `docs/design-qa/reference/` are untracked and live on the
machines that do design work, so this runs there and not in CI. If any capture comes back with a
different fingerprint, the attestation no longer covers it and that state genuinely needs looking
at again.
