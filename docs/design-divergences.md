# Where the build differs from the handoff, and what to do about it

For the designer. Eight of the 24 canonical states ship over the pixel threshold on a recorded
budget. None is a defect: each is a difference somebody looked at and accepted. Each needs a
decision — the design absorbs the addition, or the build drops it — because a budget nobody ever
closes is how a threshold stops meaning anything.

Measured against `docs/design_handoff_anchorage/Anchorage v2.dc.html` (v2.5), both sides rendered
in Y2K Dark with square corners, which is what a fresh install ships. Threshold **0.02**, ceiling
**0.05**. Numbers are normalized mean absolute pixel error. Regenerate with
`node tools/measure-design-parity.mjs`; the live figures are in `artifacts/design/design-ledger.json`.

## The eight are really three questions

### 1. The Containers additions — five budgets, one decision

`containers`, `containers-current`, `containers-banner-dismissed`, `containers-only-running` and
`containers-row-hover` all inherit the same set of additions. `containers-current` is byte-identical
to `containers` — re-selecting the active destination is idempotent, which is the correct behaviour
and not a divergence at all. **One decision retires all five.**

| Measured | Budget | Headroom |
|---|---|---|
| 0.0260 / 0.0260 / 0.0248 / 0.0232 / 0.0279 | 0.028 / 0.028 / 0.028 / 0.026 / 0.029 | 0.0011 – 0.0032 |

What the build adds that the comp does not have:

- **The container-isolation posture paragraph.** Two lines, translating the table down about 35px.
  It states that a container is a process boundary rather than a security boundary between
  tenants, and that anything given the Docker socket has the same authority over the host as
  Anchorage does. *Recommendation: the design absorbs this.* It is the largest single contributor
  across five states, and it carries the product's stated position — say what a thing does not
  protect. Dropping it to satisfy a pixel threshold would be the threshold deciding the product.
- **A leading checkbox column** for multi-select.
- **Sort chevrons** on six column headers.
- **The `All projects` compose filter** and per-row compose badges.
- **A fourth row action**, where the comp has three.
- **A `Networks` destination** the comp's nav does not list, which shifts the sidebar from Builds
  down by one row. *Already decided, 2026-08-05: kept permanently.* Docker exposes networks, and a
  Docker manager that cannot show them is refusing a question the engine answers. This one is not
  expected to close.

Everything except Networks is an ordinary product addition. They are worth taking as a batch:
either the design adopts them, or the build drops them.

### 2. Live data on both sides — two budgets, nothing to decide

| State | Measured | Budget | Run-to-run noise |
|---|---|---|---|
| `dashboard` | 0.0237 | 0.033 | 0.0029 |
| `container-detail-logs` | 0.0230 | 0.031 | 0.0024 |

Both animate on both sides — the comp drives seven timers over randomised values and a per-second
clock, and the build streams real log lines. Two captures of the same state are never identical.
These budgets carry the largest headroom deliberately, and **they will never retire**. They are
not divergences; they are an honest accommodation of animation.

`dashboard` also carries one real change: the header action was widened from the fixture's
`Clean up images` to a `Prune system` that actually reclaims images, stopped containers and unused
volumes — matching what both handoffs specify. That was a defect fixed by widening the action
rather than narrowing the words.

### 3. Extensions — one budget, and the tightest

| Measured | Budget | Headroom |
|---|---|---|
| 0.0436 | 0.046 | **0.0024** |

Two causes:

- **An added privilege paragraph**, which translates the card grid down. The layout survives it:
  card height 184px on both sides, 14px gutters, the grid's right edge in the same place.
- **Tile marks reduced to a single theme token.** The comp assigns each extension its own colour,
  which no theme can retint — so on Monochrome a coloured tile sat on a greyscale surface. The
  single token is what lets all six families and both modes stay coherent.

This is the one to watch. 0.0024 of headroom means almost any further change to that screen trips
the gate. Not a problem today; it is the first one that will bite.

## What is not on this list

Two divergences are recorded but do not hold a budget, because they measure under the threshold:

- **The Containers row hover** is roughly twice the comp's strength — 0.0046 normalized MAE off
  its own base frame against the comp's 0.0022. Left deliberately and noted at
  `app/src/styles/containers.css`; either answer is defensible and nobody has chosen.
- **Status chip contrast in Nous dark** reproduces the handoff's own aliasing, which costs
  contrast — danger lands at 2.05:1. Pinned to the design's measured values rather than corrected,
  and asserted by `app/scripts/theme-integrity.test.mjs` so it cannot get worse.

## A caveat on the numbers

These budgets were derived when the measurement rig ran in Nous. It now runs in Y2K, following the
shipped default, and the budgets were not re-derived — every state still measures under, so they
hold, but the headroom figures are less considered than they look. Tightening them to the current
basis is a short pass and worth doing before treating any headroom figure as a margin.
