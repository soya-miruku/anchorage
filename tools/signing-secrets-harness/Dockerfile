# Debian trixie for GnuPG 2.4.7 — close to the 2.4.x the runners carry, and to the 2.4.9 a
# current Arch host has. util-linux is for `script`, which is the only way to give the script a
# real pty and so exercise its /dev/tty passphrase prompt; procps is for the leftover checks.
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends gnupg util-linux procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Node comes from the official image rather than from apt, so the harness runs the script on a
# Node close to the one a developer has rather than whatever the distribution pinned.
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
RUN node --version && gpg --version | head -1
