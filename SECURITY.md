# Security

## What Anchorage is, in security terms

Anchorage talks to your Docker daemon through the socket your user can already reach, and it runs
the `docker` CLI you already have. **Access to the Docker socket is equivalent to root on the
host.** A container can be started with the host filesystem mounted, or with `--privileged`, and
nothing in Docker prevents that — so any process that can reach the socket can take over the
machine.

This is true of Docker itself, not something Anchorage adds. It is stated here because it sets the
bar for what counts as a vulnerability: Anchorage's job is to never widen that access, never carry
input from somewhere less trusted into a command, and never claim a safety property it has not
established.

Concretely, the app is built so that:

- The renderer is sandboxed, context-isolated, and has no Node integration. `--no-sandbox` is
  refused at startup rather than tolerated, and packaging fails if a build tries to disable it.
- Commands are constructed as argument arrays, never assembled into a shell string.
- Secrets — Swarm secret values, registry credentials, command arguments and environment variables
  that look like secrets — are masked in the UI, excluded from copy and history, and sent to the
  Engine API rather than passed on a command line.
- The core has no runtime dependencies, and the app declares none.

## Reporting a vulnerability

**Please report privately, not in a public issue.**

Use GitHub's private vulnerability reporting on this repository — the **Security** tab, then
*Report a vulnerability*. That opens a channel only the maintainer can see.

If that is unavailable to you, email **soya@aelysia.io**. If you want the reply encrypted, the
release signing key doubles as a contact key: `anchorage-signing-key.asc` in this repository,
fingerprint `6EC9 EBF7 5C48 EA12 D1C5 4A7E 22E6 9E9D C856 20D3`.

Please include what you did, what happened, and what you expected — and a way to reproduce it if
you have one. A rough report you are unsure about is far more useful than silence; deciding whether
something is a real issue is the maintainer's job, not yours.

### What to expect

Anchorage is maintained by one person. That means:

- An acknowledgement within **7 days**. If you have not heard back in that time, assume the message
  was missed and send it again.
- An assessment — whether it is in scope, and how serious — within **30 days** of that.
- No bounty programme, and no promise of a fixed timeline for a fix. What you will get is a
  straight answer about whether it is being worked on.

Deliberately conservative numbers. A project that promises 24 hours and takes three weeks has told
its reporters something untrue, which is worse than promising less.

### Disclosure

Report privately, and please give a fix a reasonable chance to ship before publishing. If a fix is
taking too long, say so and set a date rather than waiting indefinitely — an unfixed issue that
users do not know about is not safer than a disclosed one.

Credit in the release notes is yours if you want it, and omitted if you would rather not be named.

## Scope

**In scope**

- Anything that lets Anchorage run a command, reach a path, or contact a host that the user did not
  ask for — especially where data from a container, image, registry or Compose file reaches a
  command.
- A secret appearing anywhere it should not: logs, the command history, the clipboard, an evidence
  artifact, a crash report, or the process table.
- Renderer isolation being escapable, or the OS sandbox being disabled without packaging failing.
- The release pipeline producing artifacts that do not match what the checksums or signature say
  they are.
- Anything in the app claiming a safety property it has not established.

**Out of scope**

- Docker socket access being root-equivalent. That is Docker's model, described above.
- Anchorage doing something destructive that you asked it to do. Prune removes things; that is the
  feature.
- Vulnerabilities in Docker Engine, the Docker CLI, or CLI plugins. Report those to their projects
   — though if Anchorage's use of them makes an issue reachable that otherwise would not be, that
  part is in scope here.
- Findings from an automated scanner with no demonstrated impact on this project. A report that
  names a dependency and a CVE number, with no path to exploiting it here, is a starting point for
  a conversation rather than a vulnerability report.

## Supported versions

Only the latest release. Anchorage is pre-1.0 and there are no maintenance branches — a fix ships
in the next release rather than being backported.

## Verifying what you downloaded

Every release publishes per-architecture checksums, and signs them when a signing key is available.
The README's *Verifying a download* section has the exact commands, including importing the signing
key and checking its fingerprint. A signature that does not verify means the download is not the
release that was published, whatever the file is called.
