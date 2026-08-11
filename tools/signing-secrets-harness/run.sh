#!/bin/bash
# Runs tools/set-release-signing-secrets.mjs end to end, against a throwaway key and a stubbed
# `gh`, inside a container with no network.
#
# This exists because the interesting claims that script makes cannot be established by a unit
# test. "The bundle it uploads cannot certify as you", "a wrong passphrase uploads nothing", "an
# interrupt leaves no keyring and no agent behind" are all facts about what really happened to a
# real keyring and a real process, and asserting them in a comment is not the same as measuring
# them. tools/signing-key-bundle.test.mjs covers the judgements; this covers the behaviour.
#
# It is the host-side wrapper on purpose, and it does nothing but build an image and start a
# container. The work inside generates keys and writes keyrings, and a script that could do that
# on a developer's machine would be one mistake away from writing into their real ~/.gnupg. The
# only way to run cases.sh is therefore through a container, and cases.sh refuses to start
# anywhere else.
#
#   bash tools/signing-secrets-harness/run.sh
#
# Nothing here can reach the real signing key or the real repository: the keys are generated
# inside the container, `gh` is a stub on PATH that records what it was given and talks to
# nothing, and the container has --network none.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tools=$(cd -- "$here/.." && pwd)
workflow=$(cd -- "$tools/.." && pwd)/.github/workflows/release.yml

if ! command -v docker >/dev/null; then
  echo "This harness needs docker; everything it does must happen in a container." >&2
  exit 1
fi

# The release job's own signing step, lifted out of the workflow so the harness tests what the
# runner will actually execute rather than a copy of it that can drift.
node "$here/extract-workflow-step.mjs" "$workflow" > "$here/signing-step.sh"
trap 'rm -f "$here/signing-step.sh"' EXIT

docker build -q -t anchorage-signing-secrets-harness "$here" >/dev/null
# Not `exec`: exec replaces this shell, so the EXIT trap above never runs and the generated step
# is left in the tree. It is gitignored, so the only symptom is a stale file that the next run
# silently overwrites — which is exactly the kind of thing this harness exists to not do.
status=0
docker run --rm --network none \
  -v "$here:/harness:ro" \
  -v "$tools:/work/tools:ro" \
  -e HOME=/root \
  anchorage-signing-secrets-harness bash /harness/cases.sh || status=$?
exit "$status"
