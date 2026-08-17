<!--
Security fixes should not arrive as a public pull request — see SECURITY.md.
-->

## What this changes

<!-- And why it needed to. -->

## What you verified, and how

<!--
The most useful section, and the one this project weighs most heavily.

"Ran the suite" is fine and often enough. But if the change touches something the tests cannot
reach — the release pipeline, the acceptance harness, packaging, signing, anything that talks to a
real daemon — say what you actually observed. "Interrupted a run with a real SIGTERM and confirmed
the container was gone" is worth more than any description of the code.

If you could not verify part of it, say so here. An honest gap is easy to work with. A claim that
turns out to be untested is not, and it is the one thing that makes a change hard to trust.
-->

## Checklist

- [ ] `cd app && bun run test` passes
- [ ] No new runtime dependencies (`app/package.json` declares none, and the Go core has no `require` block)
- [ ] No gate was weakened to make this pass — if a check could not hold, it is explained above
- [ ] Nothing in the UI claims something the app has not established
- [ ] Comments explain *why*, in the register of the code around them
