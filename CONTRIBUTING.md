# Contributing

Anchorage is maintained by one person, and the thing it is most protective of is not its code but
its claim: **the app never invents an answer**. When a capability is missing, unreachable, or
impossible on your machine, the screen says which of those it is. A change that makes a screen
plausible rather than true is the one kind of contribution that will not be accepted, however good
the code is.

Everything below follows from that.

## Before you write anything

**Open an issue first for anything beyond a bug fix.** Several features have been deliberately
*removed* from this project rather than faked — Kubernetes, Ask Gordon, Sandboxes, Extensions,
Dev Environments and others — each for a stated reason in the README's *What it deliberately does
not do*. A pull request that adds one back will be judged against that reasoning, and it is much
better to have that conversation before you have written it than after.

Bug fixes and documentation corrections need no ceremony. Send them.

## Getting set up

```bash
git clone git@github.com:soya-miruku/anchorage.git
cd anchorage
cd app && bun install
```

You need Bun, Node 24, Go 1.25, and a working Docker daemon your user can reach. Then:

```bash
cd app && bun run dev:desktop     # the app, against your real daemon
cd app && bun run test            # the whole suite
```

## What the tests expect

The suite runs on every push and must be green. Beyond that, two habits matter more here than the
line count:

**Tests assert behaviour, not shape.** A test that checks a function returned an object with three
keys, without checking what is in them, passes while the feature is broken. This project has been
bitten by exactly that: a test named *"teardown is idempotent, because the signal path and the
finally block both call it"* passed for weeks while guarding a function nothing called.

**Evidence beats assertion.** If a change claims something about the world — that a container was
removed, that a signature verifies, that a file is gone — the test should establish it by looking,
not by trusting the code that was supposed to do it.

## What a good change looks like

**Comments explain why, not what.** Read a few in `tools/run-core-acceptance.mjs` or
`app/scripts/package-desktop.mjs` before writing yours. The register is: what was measured, what
was tried and rejected, and what a future reader would otherwise get wrong. `// increment the
counter` is noise; `// counted before the sweep, because the sweep can remove the thing being
counted` is the house style.

**Corrections are recorded, not silently overwritten.** Several comments in this codebase say "an
earlier version of this did X, and here is the measurement that showed it was wrong". That history
is load-bearing — it stops the same mistake being reintroduced by someone who finds the simpler
form obvious.

**No new runtime dependencies.** `app/package.json` declares no `dependencies` and the Go core has
no `require` block. Both are deliberate. Build-time tooling is a different question, but it still
needs a reason.

**Never weaken a gate to make it pass.** If a check cannot hold, say so in the pull request rather
than loosening it. A gate that was relaxed to go green is worse than no gate, because it still
looks like protection.

## Commits and pull requests

Write commit messages that say what changed and why it needed to. The history here is used as
documentation, and several bugs have been diagnosed by reading it.

In the pull request, say what you did, and — more usefully — **what you verified and how**. "Ran
the suite" is fine. "Interrupted a run with a real SIGTERM and confirmed the container was gone"
is what earns trust in a change to the harness.

If you could not verify something, say that too. An honest gap is easy to work with; a claim that
turns out to be untested is not.

## Reporting bugs

Open an issue with what you did, what happened, and what you expected. Include your distribution,
`docker version`, and whether Docker is rootless — most surprises trace to one of those.

If Anchorage displayed something that was not true, please say so explicitly. That is the highest
severity of bug this project has, higher than a crash, and it will be treated that way.

**Security issues do not go in the issue tracker** — see [SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under the [MIT Licence](LICENSE), the same terms as the project.
