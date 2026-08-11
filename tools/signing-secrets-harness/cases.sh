#!/bin/bash
# The cases, run inside the container that run.sh builds. Do not run this directly: it generates
# keys and writes keyrings, and outside a container the nearest keyring is the operator's own.
set -uo pipefail

if [ ! -e /.dockerenv ] && [ ! -f /run/.containerenv ]; then
  echo "cases.sh only runs inside the harness container. Use: bash tools/signing-secrets-harness/run.sh" >&2
  exit 1
fi

export XDG_RUNTIME_DIR=/run/user/0
mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
export GNUPGHOME=/root/.gnupg
mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
export KEY_PASSPHRASE='correct horse battery staple'
export STUB_OUT=/out
mkdir -p "$STUB_OUT"
export PATH=/harness/bin:$PATH
SCRIPT=/work/tools/set-release-signing-secrets.mjs

echo "=================================================================="
echo "SETUP  a throwaway key shaped like the release key"
echo "=================================================================="
eval "$(node /harness/setup-key.mjs)"
echo "primary            $PRIMARY   (certify only)"
echo "signing subkey     $SIGN_SUBKEY"
echo "encryption subkey  $ENCR_SUBKEY"

leftovers() {
  echo "  --- leftovers after $1 ---"
  echo "    workspace directories:        $(ls -d /run/user/0/anchorage-signing.* /dev/shm/anchorage-signing.* /tmp/anchorage-signing.* 2>/dev/null | wc -l)  (expect 0)"
  echo "    stray agent socketdirs:       $(ls -d /run/user/0/gnupg/d.* 2>/dev/null | wc -l)  (expect 0)"
  echo "    disposable keyrings:          $(find /run/user/0 /dev/shm /tmp -name 'private-keys-v1.d' 2>/dev/null | wc -l)  (expect 0)"
  # Two different measurements. The script must leave none of its own agents behind, and must not
  # have stopped the operator's -- its keyring is the one the export reads, so killing that agent
  # would be an unasked-for side effect on their session.
  echo "    agents for a disposable home: $(pgrep -a gpg-agent 2>/dev/null | grep -c 'anchorage-signing' || true)  (expect 0)"
  echo "    the operator's own agent:     $(pgrep -a gpg-agent 2>/dev/null | grep -vc 'anchorage-signing' || true)  (expect 1, untouched)"
}
reset_stub() { rm -rf "$STUB_OUT"; mkdir -p "$STUB_OUT"; }
stub_report() {
  echo "  gh argv (every call, in order):"
  sed 's/^/    /' "$STUB_OUT/gh-argv.log" 2>/dev/null || echo "    (none)"
  echo "  gh secret set calls: $( [ -f "$STUB_OUT/gh-set.log" ] && wc -l < "$STUB_OUT/gh-set.log" || echo 0 )"
  echo "  secret values received: $(ls "$STUB_OUT" 2>/dev/null | grep -c '^secret\.' || true)"
}

# `script` gives the script a real pty, which is the only way to reach its /dev/tty prompt. The
# 1.5s delay is so the passphrase arrives *after* the prompt has put the terminal in raw mode --
# fed instantly it would land in a canonical-mode input queue and be echoed into this transcript,
# which would prove the opposite of what these cases are for.
feed() { sleep 1.5; printf '%s\n' "$1"; }

echo
echo "=================================================================="
echo "CASE 1  happy path: correct bundle + correct passphrase"
echo "=================================================================="
reset_stub
feed "$KEY_PASSPHRASE" | script -qec "node $SCRIPT --key $PRIMARY --repo example/example" /dev/null
echo "[exit $?  expect 0]"
echo
echo "--- what the stub gh received ---"
stub_report
echo
echo "--- the uploaded GPG_PRIVATE_KEY, imported into a keyring that has never seen it ---"
node /harness/inspect-bundle.mjs "$STUB_OUT/secret.GPG_PRIVATE_KEY" "$PRIMARY" "$SIGN_SUBKEY" "$ENCR_SUBKEY"
echo
echo "--- the uploaded GPG_PASSPHRASE ---"
if cmp -s <(printf '%s' "$KEY_PASSPHRASE") "$STUB_OUT/secret.GPG_PASSPHRASE"; then
  echo "  byte-identical to what was typed: yes ($(wc -c < "$STUB_OUT/secret.GPG_PASSPHRASE") bytes, no trailing newline)"
else
  echo "  byte-identical to what was typed: NO"
fi
if grep -qF "$KEY_PASSPHRASE" "$STUB_OUT/gh-argv.log"; then
  echo "  present in some gh argv: YES -- FAIL"
else
  echo "  present in some gh argv: no"
fi
leftovers "case 1"

echo
echo "=================================================================="
echo "CASE 1b --set-key-id, and the upload ORDER a partial failure depends on"
echo "=================================================================="
reset_stub
feed "$KEY_PASSPHRASE" | script -qec "node $SCRIPT --key $PRIMARY --repo example/example --set-key-id" /dev/null > /dev/null
echo "[exit $?  expect 0]"
echo "  order the secrets were written in (name, bytes):"
sed 's/^/    /' "$STUB_OUT/gh-set.log"
echo "  GPG_KEY_ID value is the primary: $( [ "$(cat "$STUB_OUT/secret.GPG_KEY_ID")" = "$PRIMARY" ] && echo yes || echo NO )"
leftovers "case 1b"

echo
echo "=================================================================="
echo "CASE 2  the trap: correct bundle + WRONG passphrase"
echo "=================================================================="
reset_stub
feed "definitely not the passphrase" | script -qec "node $SCRIPT --key $PRIMARY --repo example/example" /dev/null
echo "[exit $?  expect 1]"
echo
stub_report
leftovers "case 2"

echo
echo "=================================================================="
echo "CASE 2b the same trap, caught by the VALIDATOR rather than the export"
echo "=================================================================="
echo "  (a gpg shim feeds the export the correct passphrase whatever was typed,"
echo "   so the validator is handed a sound bundle and a passphrase for a"
echo "   different one -- which is what GitHub is holding today)"
reset_stub
printf '%s\n' "$KEY_PASSPHRASE" > /tmp/shim-pass
OLD_PATH=$PATH
export PATH=/harness/shims/passphrase-mismatch:$PATH
export SHIM_PASSPHRASE_FILE=/tmp/shim-pass
feed "the passphrase this key had last month" | script -qec "node $SCRIPT --key $PRIMARY --repo example/example" /dev/null
echo "[exit $?  expect 1]"
export PATH=$OLD_PATH
unset SHIM_PASSPHRASE_FILE
rm -f /tmp/shim-pass
echo
stub_report
leftovers "case 2b"

echo
echo "=================================================================="
echo "CASE 3  an export that included the primary is refused"
echo "=================================================================="
echo "  (a gpg shim turns --export-secret-subkeys into --export-secret-keys:"
echo "   the one-word mistake this check exists to catch)"
reset_stub
OLD_PATH=$PATH
export PATH=/harness/shims/export-includes-primary:$PATH
feed "$KEY_PASSPHRASE" | script -qec "node $SCRIPT --key $PRIMARY --repo example/example" /dev/null
echo "[exit $?  expect 1]"
export PATH=$OLD_PATH
echo
stub_report
leftovers "case 3"

echo
echo "=================================================================="
echo "CASE 4a interrupt: Ctrl-C at the passphrase prompt"
echo "=================================================================="
reset_stub
{ sleep 2; printf '\003'; sleep 1; } | script -qec "node $SCRIPT --key $PRIMARY --repo example/example" /dev/null
echo "[exit $?  expect 130]"
stub_report
leftovers "case 4a"

echo
echo "=================================================================="
echo "CASE 4b interrupt: SIGTERM while the disposable workspace exists"
echo "=================================================================="
reset_stub
sleep 30 | script -qec "node $SCRIPT --key $PRIMARY --repo example/example" /dev/null &
runner=$!
for _ in $(seq 1 60); do
  ls -d /run/user/0/anchorage-signing.* >/dev/null 2>&1 && break
  sleep 0.1
done
echo "  workspace directories before the signal: $(ls -d /run/user/0/anchorage-signing.* 2>/dev/null | wc -l)  (expect 1)"
# Node 24 names its main thread "MainThread", so pkill and pgrep by process name never find it.
# Matching argv and taking only the process whose command IS node is what actually reaches it --
# getting this wrong made an earlier run of this harness report a script bug that was entirely
# the harness's, because no signal was ever sent.
node_pid=$(ps -eo pid,args --no-headers | awk '$2=="node" && $0 ~ /set-release-signing-secrets/ {print $1}')
kill -TERM "$node_pid"
wait $runner
echo "[exit $?  expect 143 = terminated by SIGTERM]"
pkill -x sleep 2>/dev/null
sleep 0.5
stub_report
leftovers "case 4b"

echo
echo "=================================================================="
echo "CASE 5  --dry-run proves the pair and uploads nothing"
echo "=================================================================="
reset_stub
feed "$KEY_PASSPHRASE" | script -qec "node $SCRIPT --key $PRIMARY --repo example/example --dry-run" /dev/null
echo "[exit $?  expect 0]"
echo
stub_report
leftovers "case 5"

echo
echo "=================================================================="
echo "CASE 6  the release job's own guard, run as the runner would run it"
echo "=================================================================="
echo "  (the real signing step, lifted out of .github/workflows/release.yml,"
echo "   with bun stubbed so it can be run without a built release)"
reset_stub
export ARCH=x64
export GPG_KEY_ID=$PRIMARY
GPG_PRIVATE_KEY=$(gpg --batch --no-tty --pinentry-mode loopback --passphrase-fd 3 --armor \
  --export-secret-subkeys "$SIGN_SUBKEY!" 3<<<"$KEY_PASSPHRASE")
export GPG_PRIVATE_KEY
mkdir -p /tmp/release-run/release
cd /tmp/release-run || exit 1

# GNUPGHOME is unset for these: a runner has none, the step's whole agent setup is written against
# $HOME/.gnupg, and leaving the harness's own GNUPGHOME in the environment would test a keyring
# the runner never has.
echo "--- GPG_PRIVATE_KEY set, GPG_PASSPHRASE NOT set (the repository's state today) ---"
env -u GPG_PASSPHRASE -u GNUPGHOME HOME=/tmp/rh1 bash /harness/signing-step.sh 2>&1 | sed 's/^/  /'
echo "  [exit ${PIPESTATUS[0]}  expect 1]"
echo "  did it reach release:sign? $( grep -c 'release:sign' "$STUB_OUT/bun.log" 2>/dev/null || echo 0 ) (expect 0)"

echo
echo "--- the same step with the matching GPG_PASSPHRASE set ---"
reset_stub
env -u GNUPGHOME HOME=/tmp/rh2 GPG_PASSPHRASE="$KEY_PASSPHRASE" bash /harness/signing-step.sh 2>&1 | tail -14 | sed 's/^/  /'
echo "  did it reach release:sign? $( grep -c 'release:sign' "$STUB_OUT/bun.log" 2>/dev/null || echo 0 ) (expect 1)"
cd / || exit 1

echo
echo "=================================================================="
echo "UNIT TESTS  node --test tools/signing-key-bundle.test.mjs"
echo "=================================================================="
node --test /work/tools/signing-key-bundle.test.mjs 2>&1 | tail -10
