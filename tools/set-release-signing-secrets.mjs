#!/usr/bin/env node
/**
 * Gives the release workflow a signing key it can actually use: re-exports the signing subkey,
 * and sets it together with the passphrase that opens it as two repository secrets — but only
 * after proving, locally, that the pair signs and that the signature verifies.
 *
 * The two halves have to move together, and that is the whole design. An exported bundle is
 * protected with the passphrase the key held *at export time*, so a bundle and a passphrase set
 * on different days are two independent guesses about the same secret. This repository has been
 * living in exactly that state: GPG_PRIVATE_KEY was exported on 2026-08-07, GPG_PASSPHRASE was
 * never set at all, and the key's passphrase has changed since.
 *
 * Both of those configurations fail in CI, and on the release job's preset-then-sign path they
 * fail the same way. Measured in a container shaped like that job, on gpg 2.4.7:
 *
 *   no passphrase set  preset block skipped; sign fails "Sorry, we are in batchmode - can't get
 *                      input", exit 2, zero-byte signature.
 *   wrong passphrase   gpg-preset-passphrase accepts it and exits 0, `keyinfo --list` reports the
 *                      keygrip cached; sign then fails with the same line, the same exit 2 and the
 *                      same zero-byte signature.
 *
 * So `keyinfo --list` can say whether a preset happened, and cannot say whether it was right —
 * and gpg's own output cannot say either. Once GPG_PASSPHRASE exists at all, nothing in the log
 * separates a correct passphrase from a wrong one but the presence of a signature, which is how
 * three release runs were spent on the same failure wearing two faces.
 *
 * So this script does the one thing that separates them, and does it before anything is uploaded:
 * it imports the bundle it just made into a keyring that exists for the next few seconds, unlocks
 * it with the passphrase that was just typed, signs a throwaway file, and verifies the result. If
 * that fails, nothing is uploaded and the message names which half is wrong.
 *
 * Written in Node rather than as a shell script, to sit beside tools/sign-release.mjs and share
 * its definition of a verified signature — and because the passphrase never touches a shell here.
 * `spawn` with no shell puts nothing in argv, expands nothing, logs nothing to history, and the
 * two bash footguns that would matter most for a validator (`set -e` silently disabled by
 * `local`, and `set -x` printing the passphrase) do not exist.
 *
 * Usage:
 *   node tools/set-release-signing-secrets.mjs                       # the default key and repo
 *   node tools/set-release-signing-secrets.mjs --dry-run             # prove the pair, upload nothing
 *   node tools/set-release-signing-secrets.mjs --key <primary-fpr> --repo owner/name
 *   node tools/set-release-signing-secrets.mjs --subkey <fpr>        # when the key has several
 *   node tools/set-release-signing-secrets.mjs --env release         # environment, not repository
 *   node tools/set-release-signing-secrets.mjs --set-key-id          # also refresh GPG_KEY_ID
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isatty, ReadStream } from "node:tty";

import {
  chooseSigningSubkey,
  classifyPassphraseFailure,
  judgeExportedBundle,
  parseKeyListing,
} from "./signing-key-bundle.mjs";
import {
  detachedSignatureVerifyArguments,
  judgeDetachedSignature,
} from "./verify-detached-signature.mjs";

/*
Re-exec with core dumps disabled, before anything secret exists.

A handler can only cover the signals it is allowed to catch. SIGQUIT is handled below, but
SIGSEGV, SIGABRT (which is how V8 reports a fatal error or OOM), SIGBUS, SIGILL and SIGFPE all
terminate with a dump and cannot be usefully caught with secrets resident — and this machine pipes
`core_pattern` to systemd-coredump with `ulimit -c` unlimited and three-day retention readable by
the owner. A review recovered a canary string from a dump here to establish that, and separately
measured the passphrase and the armoured key sitting in writable memory at the same instant.

`ulimit -c 0` closes the entire class in one move rather than one signal at a time. Measured: with
RLIMIT_CORE at 0 the kernel still invokes systemd-coredump, which records `Storage: none` and
writes no bytes. Node cannot set its own rlimit, so this re-execs through `sh` once, guarded by an
environment variable so it cannot loop. Doing it here, before the passphrase prompt and before any
export, means the process that holds a secret never had dumps enabled at all.

If the re-exec fails the script continues rather than refusing: a missing `sh` should not stop
someone setting up signing, and the handled-signal path still covers the interactive case.
*/
let relaunchWarned = false;
if (!process.env.ANCHORAGE_SIGNING_NO_CORE) {
  const child = spawn(
    "sh",
    [
      "-c",
      'ulimit -c 0 2>/dev/null; exec "$@"',
      "sh",
      process.execPath,
      ...process.execArgv,
      ...process.argv.slice(1),
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        ANCHORAGE_SIGNING_NO_CORE: "1",
        // The relaunched process refuses to upload if this stops being its parent — see the
        // check beside setSecret. kill -9 is the case: the relay cannot forward it, so without
        // this the wrapper dies and the orphan finishes the upload after the shell has already
        // returned the prompt.
        ANCHORAGE_SIGNING_PARENT: String(process.pid),
      },
    },
  );

  /*
  The wrapper must be transparent, and the first version of it was not. It used spawnSync, so it
  had no handlers of its own — which meant a `kill` aimed at the pid the operator can see killed
  the wrapper instantly while the relaunched process carried on and uploaded both secrets anyway.
  Measured: the shell printed "Terminated", returned 143, gave the prompt back, and then
  "Set GPG_PRIVATE_KEY" appeared over it. Before the re-exec existed that same kill reached the
  only process, which cleaned up and uploaded nothing. Losing the ability to abort is a worse
  trade than the crash-dump case the re-exec buys, so the wrapper forwards instead.

  Terminal signals already reach both processes through the foreground group; forwarding covers
  the case a group signal does not — `kill <pid>`, or a supervisor. Double delivery is harmless:
  cleanup is idempotent, and the second signal arrives after the child has removed its listener.
  */
  let relayed = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
    process.on(signal, () => {
      relayed = true;
      // SIGQUIT would dump the wrapper otherwise. It holds no secret bytes — measured 0 of each —
      // but a 1.7 MB dump per Ctrl-\ is exactly the artifact the re-exec exists to stop producing.
      try {
        child.kill(signal);
      } catch {
        // The child is already gone; its own handler did the work.
      }
    });
  }

  /*
  Park here rather than falling through: everything below this block is the real work, and the
  wrapper must not also do it. The only ways out are the child exiting — which ends this process
  with the child's own status — or `sh` being unavailable, which resolves and runs the work here.
  */
  await new Promise((runHere) => {
    child.on("error", () => {
      // No `sh`, or it is not executable. Say so rather than silently downgrading: the difference
      // is whether a crash can write the key to disk, and an operator who cannot see which mode
      // they are in cannot judge that.
      process.stderr.write(
        "Could not re-exec with core dumps disabled; continuing in this process.\n" +
          "  A crash could then write the key and passphrase to a core file. To avoid that:\n" +
          "    ulimit -c 0; node tools/set-release-signing-secrets.mjs\n",
      );
      // One condition, one warning. The limits check below reports the same fact, and its advice
      // ("unset ANCHORAGE_SIGNING_NO_CORE") does not apply here, where the variable is not set.
      relaunchWarned = true;
      runHere();
    });

    child.on("exit", (code, signal) => {
      /*
      Report what actually happened to the child rather than collapsing it to 128. A supervisor
      that signals the relaunched process — the one holding the secrets — needs 130/143/129/131,
      not a number that says only "something signal-shaped occurred". That is the same
      quiet-rather-than-loud failure the child's own handlers exist to avoid.

      An `sh` that runs and then fails on its own account (no exec, non-zero exit) surfaces as
      that exit code, which is the honest thing to report: the work did not happen, and saying 0
      would claim it had.
      */
      if (signal) {
        /*
        Re-raise only the signals whose default action is a plain termination. Re-raising a
        dumping one — SIGSEGV, SIGABRT and friends, which is how the child dies if V8 aborts —
        would kill the wrapper by *its* default action, and the wrapper is the one process the
        re-exec never lowered the core limit on. Measured: two coredumpctl events per crash, the
        child `Storage: none` and the wrapper with a path allocated. It holds no secret bytes, so
        this is a junk file in a three-day store rather than an exposure, but it is still a file
        nobody wants and 128+n reports the same thing without it.
        */
        /*
        Named the safe ones rather than the dangerous ones. The first version listed the dumping
        signals and re-raised everything else, which left SIGXCPU and SIGXFSZ off the list — both
        dump by default, and `kill -XCPU` on the child duly produced two coredump events where
        the point of this branch was to produce none. Inverting it closes the class: only the
        signals the relay forwards, whose default action is a plain termination, are re-raised.
        */
        const plainTermination = new Set(["SIGINT", "SIGTERM", "SIGHUP"]);
        if (!plainTermination.has(signal)) {
          process.exit(128 + (constants.signals[signal] ?? 0));
        }
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? (relayed ? 130 : 1));
    });
  });
}

/*
Say so if the protection is not actually in force.

The guard above is an environment variable, so anything that already exports it — a stale
`set -x ANCHORAGE_SIGNING_NO_CORE 1`, a direnv, a previous run's shell — skips the re-exec
silently and runs the whole thing with dumps enabled. That is the quiet-rather-than-loud failure
this file argues against everywhere else, so it is checked rather than assumed: read the limit
that was actually applied instead of trusting that asking for it worked.

A warning rather than a refusal, matching the missing-`sh` path: someone with a good reason to
run without the re-exec should be able to, and someone without one should be told.
*/
try {
  const limits = readFileSync("/proc/self/limits", "utf8");
  const core = limits.split("\n").find((line) => /max core file size/iu.test(line));
  /*
  Only the soft limit decides whether a dump is written, so only the soft limit is read. Testing
  both columns warned about `ulimit -S -c 0` — soft 0, hard unlimited — which writes no dump at
  all. A warning that fires when the thing it warns about cannot happen teaches its reader to
  ignore it.
  */
  const soft = core?.trim().split(/\s{2,}/u)[1];
  if (soft !== undefined && soft !== "0" && !relaunchWarned) {
    process.stderr.write(
      `Core dumps are not disabled for this process (soft limit ${soft}).\n` +
        "  A crash while the key and passphrase are in memory could write them to a core file.\n" +
        (process.env.ANCHORAGE_SIGNING_NO_CORE
          ? "  Unset ANCHORAGE_SIGNING_NO_CORE, or run: ulimit -c 0; node tools/set-release-signing-secrets.mjs\n"
          : "  Run: ulimit -c 0; node tools/set-release-signing-secrets.mjs\n"),
    );
  }
} catch {
  // No procfs. Nothing to report rather than something invented.
}

/** Secrets this run has actually set, so a later refusal can describe the repository truthfully. */
const uploaded = [];

/*
The launcher to watch for, resolved once and only while the answer is still trustworthy.

`ANCHORAGE_SIGNING_PARENT` is an inherited environment variable, so it can arrive stale from an
earlier shell, and `sh` might wrap rather than exec, leaving a process in between. Both make it
point at something that is not our launcher. At this instant — before any await, before any
secret — our real parent is known for certain, so the variable is trusted only if it agrees with
it, and ignored entirely otherwise. Ignoring is the safe direction: it costs the kill -9 guard,
which is a narrow case, rather than refusing a run nobody killed, which is not.
*/
const declaredLauncher = Number(process.env.ANCHORAGE_SIGNING_PARENT);
const launcherWatch =
  Number.isInteger(declaredLauncher) && declaredLauncher > 0 && process.ppid === declaredLauncher
    ? declaredLauncher
    : null;

/*
The key and the repository this project actually releases from, so the common case is no
arguments at all. Both are public facts — a fingerprint is not a secret and neither is a
repository name — and both are printed back before anything is done with them, because a script
that uploads secrets should never leave you guessing which repository it chose.
*/
const DEFAULT_PRIMARY = "6EC9EBF75C48EA12D1C54A7E22E69E9DC85620D3";
const DEFAULT_REPOSITORY = "soya-miruku/anchorage";

const PRIVATE_KEY_SECRET = "GPG_PRIVATE_KEY";
const PASSPHRASE_SECRET = "GPG_PASSPHRASE";
const KEY_ID_SECRET = "GPG_KEY_ID";

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

/**
 * A flag's value, refusing a flag that was given without one.
 *
 * tools/sign-release.mjs takes the shorter form of this and can afford to: the worst a missing
 * value does there is fail to find a key. Here `--repo` with nothing after it would fall through
 * to the default and upload secrets to the real repository, which is not a failure the operator
 * would see until afterwards.
 */
function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`${name} was given without a value.`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Disposable state, and getting rid of it
// ---------------------------------------------------------------------------------------------

/*
Everything this script creates lives in one directory on a tmpfs, and the choice of filesystem is
not incidental: for a few seconds that directory holds a real, passphrase-protected private key in
gpg's private-keys-v1.d. On this machine /var/tmp is btrfs on NVMe, where the data survives a
reboot, copy-on-write means `rm` does not overwrite anything, and `discard=async` makes recovery a
question of timing rather than impossibility. $XDG_RUNTIME_DIR is tmpfs, mode 700, owned by the
user and cleared at logout; /dev/shm is tmpfs without the ownership; os.tmpdir() is the fallback
and is tmpfs on this host too. A SIGKILL is the one signal that cannot be cleaned up after, and
putting the directory in RAM is what bounds that exposure to the current boot.

Short paths matter for a second reason: gpg-agent's socket is a unix socket, whose path is capped
at 108 bytes by sun_path, and a home deep enough to exceed it fails in a way that reads like a
broken bundle — the public key imports and the *secret* one does not.
*/
function chooseWorkspaceBase() {
  const candidates = [process.env.XDG_RUNTIME_DIR, "/dev/shm", tmpdir()].filter(Boolean);
  for (const base of candidates) {
    try {
      const directory = mkdtempSync(join(base, "anchorage-signing."));
      // 108 bytes total for the socket path, and gpg appends names of up to ~16 bytes.
      if (join(directory, "S.gpg-agent.extra").length < 100) {
        return { base, directory };
      }
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // An unwritable or absent candidate is not an error; the next one is tried.
    }
  }
  fail(
    `No writable temporary directory among ${candidates.join(", ")}. This script needs somewhere ` +
      `private to hold a keyring for a few seconds.`,
  );
  return undefined;
}

const workspace = chooseWorkspaceBase();
/** Disposable GNUPGHOMEs, remembered so cleanup can kill their agents before removing them. */
const disposableHomes = [];
/** The tty in raw mode, if the passphrase prompt is open — an interrupt must hand it back. */
let rawTerminal;
/** The passphrase, held as bytes so it is never interned as an immutable JavaScript string. */
let passphrase;

/*
The exported armour, held at module scope for the same reason the passphrase is: so `cleanup` can
overwrite the one copy this process owns. It began as a local, on the reasoning that only the
typed secret needs scrubbing — wrong twice over. The bundle *is* the signing key, and a review
measured both of them sitting in writable memory at the same instant, so whatever catches one
catches the other.
*/
let exportedArmour;

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;

  if (rawTerminal) {
    try {
      rawTerminal.setRawMode(false);
    } catch {
      // Nothing useful to do if the terminal has already gone.
    }
    rawTerminal = undefined;
  }

  /*
  Zeroing our copy of the passphrase is worth doing and worth not overstating. It removes the one
  buffer this process controls; it does not scrub whatever the kernel, the terminal driver or V8's
  allocator may still hold, and a core dump or a ptrace by this same user during the run would
  expose it regardless. The reason to keep it in a Buffer at all is that a JavaScript string could
  not even be overwritten.
  */
  if (passphrase) {
    passphrase.fill(0);
    passphrase = undefined;
  }
  if (exportedArmour) {
    exportedArmour.fill(0);
    exportedArmour = undefined;
  }

  /*
  Kill the agent, then remove the home — in that order, and never the other way round.

  gpgconf resolves which agent to talk to *from* GNUPGHOME, so once the directory is gone it can
  no longer find the agent it started and the agent outlives the script (measured: alive before
  the rm, alive after). And `--kill all` rather than `--kill gpg-agent`, because gpg 2.4 may also
  have started keyboxd.

  This cannot reach the operator's own agent: since 2.1 the socket directory is
  $XDG_RUNTIME_DIR/gnupg/d.<hash-of-homedir>, so a different home is a different agent by
  construction. The GNUPGHOME guard below is belt-and-braces on the one thing that must never
  happen — a gpgconf --kill that inherited the ambient environment would stop the agent the user
  is using.
  */
  for (const home of disposableHomes) {
    if (!home || !home.startsWith(workspace.directory)) continue;
    const environment = { ...process.env, GNUPGHOME: home };
    const sockets = spawnSync("gpgconf", ["--list-dirs", "socketdir"], {
      env: environment,
      encoding: "utf8",
    });
    spawnSync("gpgconf", ["--kill", "all"], { env: environment, stdio: "ignore" });
    const socketDirectory = String(sockets.stdout ?? "").trim();
    // gpg puts the sockets outside the home whenever $XDG_RUNTIME_DIR exists, so removing the
    // home alone leaves a d.<hash> directory behind on every run. Seven of them accumulated
    // during the research for this script.
    if (socketDirectory && socketDirectory !== home && basename(socketDirectory).startsWith("d.")) {
      rmSync(socketDirectory, { recursive: true, force: true });
    }
  }
  rmSync(workspace.directory, { recursive: true, force: true });
}

process.on("exit", cleanup);

/*
SIGQUIT is handled apart from the others because re-raising it is exactly the wrong move.

Its default action is terminate-and-dump-core, and a dump of this process is the worst possible
artifact: a review froze the real script mid-run and found the passphrase in one writable region
and the armoured signing key in another. On this machine `/proc/sys/kernel/core_pattern` pipes to
systemd-coredump, `ulimit -c` is unlimited, and dumps are kept for three days readable by their
owner — confirmed with a canary process, whose string came back out of `coredumpctl dump`. So one
keystroke would write both halves of the release identity to persistent storage in cleartext.

And it is a keystroke, not a hypothetical: Ctrl-\ reaches this process for the whole window
between the export and the second upload — seconds, longer if the network stalls. Only the
passphrase prompt is immune, because raw mode disables ISIG.

Cleaning up and re-raising, as the other signals do, would clean up and then still dump. Exiting
with 128+3 reports the same wait status to the caller without producing the file.

SIGKILL remains outside this and always will be: it cannot be caught, which is why the workspace
lives on a tmpfs that the next reboot clears rather than relying on a handler alone.
*/
process.on("SIGQUIT", () => {
  cleanup();
  process.exit(131);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  /*
  An exit handler alone is not enough, and the failure is quiet rather than loud: a script that
  traps only EXIT swallows the signal, carries on past the point it was interrupted, and reports
  success. Cleaning up and then re-raising the signal with the handler removed gives the caller an
  honest wait status (130 for SIGINT) as well as an empty temporary directory.
  */
  process.on(signal, () => {
    cleanup();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

// ---------------------------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------------------------

/**
 * Runs gpg, handing it the passphrase on a file descriptor and reading its machine-readable
 * status back on another.
 *
 * `--passphrase-fd` rather than `--passphrase`, because argv is world-readable: /proc is mounted
 * without hidepid on this machine, so any local process can read another's command line while it
 * runs. GnuPG's own manual says the same about the option — "of very questionable security on a
 * multi-user system. Don't use this option if you can avoid it."
 *
 * fd 3 in and fd 4 out rather than stdin and stdout, so both remain free for the actual data: the
 * armoured export comes back on stdout, and a bundle to import goes in on stdin. Node hands the
 * parent end of each extra descriptor back as a stream, and nothing about the value ever becomes
 * an argument, an environment variable or a file.
 *
 * `--pinentry-mode loopback` on every invocation, which looks like it contradicts the note in
 * tools/sign-release.mjs about not making loopback global — it does not. That note is about
 * gpg.conf, where the setting would apply to gpg calls the script does not own, verification
 * included. Here every call *is* this script's, and the reason is absolute: the operator's own
 * keyring is read to make the export, and a gpg that falls back to asking gpg-agent for a
 * passphrase will put a pinentry dialog on their desktop. Loopback means gpg answers the agent
 * itself, from fd 3, and no pinentry can appear. It needs no agent configuration — allow is the
 * default since 2.1.12; the advice to write `allow-loopback-pinentry` into gpg-agent.conf is
 * obsolete and is only kept below for the disposable home, where it arrives with three other
 * settings that do matter.
 */
function gpg(args, { passphrase: secret, stdin, home, statusOnStdout = false } = {}) {
  const base = ["--batch", "--no-tty", "--pinentry-mode", "loopback"];
  if (!statusOnStdout) base.push("--status-fd", "4");
  if (secret !== undefined) base.push("--passphrase-fd", "3");
  return new Promise((resolveRun) => {
    const child = spawn("gpg", [...base, ...args], {
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      env: home ? { ...process.env, GNUPGHOME: home } : process.env,
    });
    const stdout = [];
    const stderr = [];
    const statusText = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdio[4].on("data", (chunk) => statusText.push(chunk));
    child.stdio[4].on("error", () => {});
    child.stdio[3].on("error", () => {});
    if (secret !== undefined) child.stdio[3].end(secret);
    else child.stdio[3].end();
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
    child.on("error", (error) => fail(`Could not run gpg: ${error.message}`));
    child.on("close", (status) => {
      /*
      Zero the stream's own chunks, not just the joined copy.

      `Buffer.concat` allocates: measured, it returns a new buffer even for a single chunk. So the
      armoured secret key existed twice — once in the chunk the stream pushed here, once in the
      result — and scrubbing only the result left a complete copy behind. A review counted them:
      three copies before any zeroing, two after the result was scrubbed, and only the probe's own
      needles once the chunks went too.

      That second copy is not academic on this host. Any dump vector other than the signals the
      script handles — a V8 OOM abort, SIGSEGV, a same-uid `gcore` — writes whatever is resident,
      and `core_pattern` here pipes to systemd-coredump with three-day retention.
      */
      const joined = Buffer.concat(stdout);
      for (const chunk of stdout) chunk.fill(0);
      resolveRun({
        status,
        stdout: joined,
        stderr: Buffer.concat(stderr).toString("utf8"),
        statusText: Buffer.concat(statusText).toString("utf8"),
      });
    });
  });
}

/**
 * Runs gh, with any value it needs delivered on stdin.
 *
 * `gh secret set` reads the value from stdin whenever `--body` is absent, and `--body` puts it in
 * argv — which is why gh's own documented example is not the one to copy. Found by PATH rather
 * than by absolute path, so the tests can put a stub in front of it and assert that nothing
 * reaches a real repository.
 *
 * GH_PROMPT_DISABLED because gh prompts for the secret interactively when stdin *and* stdout are
 * both terminals; this script is normally run from one, and a hang at that prompt would look like
 * the upload having stalled.
 */
function gh(args, { stdin } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn("gh", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.on("error", () => {});
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
    child.on("error", (error) =>
      fail(`Could not run gh: ${error.message}. Install the GitHub CLI, or put a gh on PATH.`),
    );
    child.on("close", (status) =>
      resolveRun({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// The passphrase
// ---------------------------------------------------------------------------------------------

/**
 * Reads the passphrase from the terminal with the echo off, and from nowhere else.
 *
 * /dev/tty rather than stdin, for two reasons that are both about what else is on stdin: stdin
 * may be a pipe, and anything sharing this process's stdin can be consumed by a child that reads
 * it. There is no fallback to an environment variable or an argument if /dev/tty cannot be opened
 * — a script that quietly accepts the passphrase somewhere less safe when the safe route is
 * unavailable has no safe route.
 *
 * Raw mode is what suppresses the echo, and it also means Ctrl-C arrives as a byte rather than as
 * SIGINT, so it is handled here; the terminal is handed back in every exit path including the
 * signal one.
 */
async function readPassphrase(prompt) {
  let descriptor;
  try {
    descriptor = openSync("/dev/tty", "r+");
  } catch (error) {
    fail(
      `Cannot open /dev/tty (${error.code ?? error.message}), so there is no way to ask for the ` +
        `passphrase without it passing through somewhere it should not. Run this from a ` +
        `terminal.\n\n  There is deliberately no --passphrase flag and no environment variable ` +
        `to fall back to.`,
    );
  }
  if (!isatty(descriptor)) {
    fail("/dev/tty is not a terminal here. Run this from a terminal.");
  }
  writeSync(descriptor, prompt);

  const input = new ReadStream(descriptor);
  input.setRawMode(true);
  rawTerminal = input;

  const bytes = [];
  const outcome = await new Promise((resolveRead) => {
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 0x0d || byte === 0x0a) return finish("done");
        if (byte === 0x03) return finish("interrupt");
        if (byte === 0x04 && bytes.length === 0) return finish("eof");
        if (byte === 0x7f || byte === 0x08) {
          bytes.pop();
          continue;
        }
        if (byte === 0x15) {
          bytes.length = 0;
          continue;
        }
        bytes.push(byte);
      }
      return undefined;
    };
    const finish = (result) => {
      input.off("data", onData);
      resolveRead(result);
    };
    input.on("data", onData);
  });

  input.setRawMode(false);
  rawTerminal = undefined;
  writeSync(descriptor, "\n");
  input.destroy();

  if (outcome === "interrupt") {
    cleanup();
    process.exit(130);
  }
  if (outcome === "eof") fail("No passphrase given.");

  const value = Buffer.from(bytes);
  // The array the bytes were accumulated in is a second copy, and cleanup only knows about the
  // Buffer. Same caveat as there: this clears the copy this code holds, not every copy that
  // exists.
  bytes.fill(0);
  if (value.length === 0) {
    fail(
      "The passphrase was empty. gh would store an empty secret quite happily, and an empty " +
        "GPG_PASSPHRASE is indistinguishable from a missing one in `gh secret list` — which is " +
        "the failure this script exists to end, not to repeat.",
    );
  }
  // A newline cannot survive the round trip: gh strips trailing \r and \n from a value read on
  // stdin, and gpg reads only the first line from --passphrase-fd. Reading a line at a time makes
  // this unreachable, so it is here as an assertion rather than as handling.
  if (value.includes(0x0a) || value.includes(0x0d)) {
    fail("The passphrase contains a line break, which cannot be carried through to CI intact.");
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Arguments and preflight
// ---------------------------------------------------------------------------------------------

const primarySelector = argument("--key") ?? DEFAULT_PRIMARY;
const requestedSubkey = argument("--subkey");
const repository = argument("--repo") ?? DEFAULT_REPOSITORY;
const environmentName = argument("--env");
const dryRun = process.argv.includes("--dry-run");
const alsoSetKeyId = process.argv.includes("--set-key-id");

if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
  fail(`--repo takes owner/name, not ${JSON.stringify(repository)}.`);
}

console.log(`Repository: ${repository}${environmentName ? ` (environment ${environmentName})` : ""}`);
console.log(`Signing key: ${primarySelector}`);
if (dryRun) console.log("Mode: --dry-run — everything is proven, nothing is uploaded.");

/*
Everything that can fail for a boring reason is checked before the passphrase is read, so an
expired gh token or a typo in --repo never happens while a secret is sitting in this process's
memory. The read is also the only irreversible thing here from the operator's point of view: they
have to type it again.
*/
const version = await gpg(["--version"], { statusOnStdout: true });
if (version.status !== 0) fail("gpg is not runnable here.");
console.log(`gpg: ${version.stdout.toString("utf8").split("\n")[0]}`);

const auth = await gh(["auth", "status"]);
if (auth.status !== 0) {
  fail(`gh is not authenticated:\n${`${auth.stdout}${auth.stderr}`.trim()}\n\n  Run: gh auth login`);
}

/*
Reading the secret list is the cheapest proof that this token may write to this repository's
secrets, and it doubles as the "before" half of the receipt printed at the end. It is a read, so a
--dry-run still makes it: rehearsing the upload path without ever checking the target would leave
the one likely failure untested.
*/
const listArguments = [
  "secret",
  "list",
  "--repo",
  repository,
  "--app",
  "actions",
  "--json",
  "name,updatedAt",
  ...(environmentName ? ["--env", environmentName] : []),
];
async function secretTimestamps() {
  const listed = await gh(listArguments);
  if (listed.status !== 0) {
    fail(
      `Cannot read the secrets of ${repository}:\n${`${listed.stdout}${listed.stderr}`.trim()}\n\n` +
        `  The token needs the "repo" scope and collaborator access.`,
    );
  }
  try {
    return new Map(JSON.parse(listed.stdout).map((entry) => [entry.name, entry.updatedAt]));
  } catch {
    fail(`gh secret list returned something that is not JSON:\n${listed.stdout.trim()}`);
  }
  return new Map();
}
const before = await secretTimestamps();
console.log(
  `Secrets on ${repository} now: ${
    before.size ? [...before.keys()].sort().join(", ") : "(none)"
  }`,
);

// ---------------------------------------------------------------------------------------------
// Which subkey
// ---------------------------------------------------------------------------------------------

/*
The signing subkey is derived from the primary rather than passed in, so that a rotation cannot
silently ship the previous one — the fingerprint in a runbook keeps pointing at whatever was
current when the runbook was written, and the resulting mismatch surfaces only as a published
signature nobody can verify. --subkey overrides it for the one case that cannot be derived: a key
carrying more than one usable signing subkey, where choosing is not this script's to do.
*/
const localListing = await gpg([
  "--with-colons",
  "--with-secret",
  "--list-secret-keys",
  primarySelector,
]);
if (localListing.status !== 0) {
  fail(
    `No secret key matching ${JSON.stringify(primarySelector)} in this keyring:\n` +
      `${localListing.stderr.trim()}`,
  );
}
const localRecords = parseKeyListing(localListing.stdout.toString("utf8"));
const localPrimaries = localRecords.filter((record) => record.type === "sec");
if (localPrimaries.length !== 1) {
  fail(
    `${JSON.stringify(primarySelector)} matches ${localPrimaries.length} secret keys. Pass a full ` +
      `fingerprint:\n  ${localPrimaries.map((record) => record.fingerprint).join("\n  ")}`,
  );
}
const primaryFingerprint = localPrimaries[0].fingerprint;

let signingSubkey;
if (requestedSubkey) {
  signingSubkey = localRecords.find(
    (record) => record.type === "ssb" && record.fingerprint === requestedSubkey,
  );
  if (!signingSubkey) {
    fail(`${requestedSubkey} is not a subkey of ${primaryFingerprint}.`);
  }
  if (!signingSubkey.capabilities.includes("s")) {
    fail(`${requestedSubkey} cannot sign (capabilities ${signingSubkey.capabilities || "none"}).`);
  }
} else {
  const chosen = chooseSigningSubkey(localRecords);
  if (!chosen.ok) fail(chosen.summary);
  signingSubkey = chosen;
}

/*
The expiry is printed rather than enforced, and printed at the moment the operator is already
thinking about this key. An expired signing subkey cannot sign at all, so the next re-export has a
date on it; this is the cheapest way to make that date something they have seen. It is also worth
knowing for a reason this script cannot fix — see the note at the end of the report.
*/
const expiresAt = signingSubkey.expires
  ? new Date(Number(signingSubkey.expires) * 1000).toISOString().slice(0, 10)
  : "never";
console.log(
  `Signing subkey: ${signingSubkey.fingerprint} (of ${primaryFingerprint}), expires ${expiresAt}`,
);

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

passphrase = await readPassphrase(
  `\nPassphrase for ${primaryFingerprint} (not echoed, never written anywhere): `,
);

/*
--export-secret-subkeys, and the trailing "!" on the fingerprint. Both matter and they matter for
different reasons, which the release workflow's own comment used to conflate:

  --export-secret-subkeys is what keeps the PRIMARY's secret out. It never exports it, with or
  without the bang; --export-secret-keys is the command that would hand CI the ability to certify
  keys as the operator.

  The "!" is what keeps every OTHER subkey out. Measured on gpg 2.4.7 against a key with a signing
  and an encryption subkey: with it, one secret in the bundle; without it, two — the second being
  the key that decrypts everything ever encrypted to this identity. That is the leak the bang
  prevents, and it is not the one it is usually credited with.

Neither is trusted here. What the bundle actually contains is established after the fact, by
importing it and asking gpg, because a wrong bundle is the one outcome worse than an unsigned
release.

The export also settles the passphrase, which is what makes "re-export" and "set the passphrase"
one operation rather than two that must agree. gpg-agent will not serve a key export from its
cache: measured with the subkey's passphrase already cached and `keyinfo --list` showing it, an
export supplying a *different* passphrase on fd 3 still failed with Bad passphrase. So reaching
this line with bytes on stdout means the passphrase just typed unlocked the key as it is today.
*/
const exported = await gpg(
  ["--armor", "--export-secret-subkeys", `${signingSubkey.fingerprint}!`],
  { passphrase },
);
// Same buffer, not a copy, so zeroing it in cleanup zeroes the bytes gpg handed back rather than
// a duplicate that leaves the original behind.
exportedArmour = exported.stdout;
if (exported.status !== 0) {
  const cause = classifyPassphraseFailure(exported);
  fail(
    `gpg exited ${exported.status} exporting the subkey.\n\n  ${cause.summary}\n\n` +
      `  gpg said:\n${exported.stderr.trim() || exported.statusText.trim()}`,
  );
}
/*
A byte count, not an existence test, because a failed export is not empty. A gpg export that
cannot unlock the key writes ~400 bytes of perfectly valid armour containing the stub primary and
its user id and no secret at all, and exits 2. A script that checked only for output would upload
that, and it imports cleanly with `IMPORT_OK 16` — "contains private key" — while landing nothing
in private-keys-v1.d. The exit status above is the first guard against it and the shape check
below is the second.
*/
if (exported.stdout.length === 0) {
  fail("gpg exited 0 but exported nothing.");
}
console.log(`Exported ${exported.stdout.length} bytes of armour.`);

// ---------------------------------------------------------------------------------------------
// Validation: the part that has to happen before either secret moves
// ---------------------------------------------------------------------------------------------

/**
 * Proves the bundle and the passphrase are a working pair, in a keyring that has never seen
 * either before and will not exist afterwards.
 *
 * A validator that shares an agent with anything else proves nothing, and does so convincingly.
 * Once gpg-agent has cached a passphrase for a key, a later `--passphrase <anything>` is simply
 * ignored and the signature succeeds: measured on a default agent, sign correctly, then sign with
 * a deliberately wrong passphrase, and the second one produces a signature too. So this home is
 * fresh, its gpg-agent.conf is written before the first gpg call reaches it, and the run ends with
 * a negative control that must fail.
 *
 * The four agent settings, and why each is there:
 *   allow-loopback-pinentry   the default since 2.1.12, written for the older gpg a CI image or
 *                             an LTS distribution may still be carrying.
 *   default-cache-ttl 0
 *   max-cache-ttl 0           nothing is remembered between invocations.
 *   ignore-cache-for-signing  the one that closes the hole above — without it, the cache from the
 *                             first successful unlock answers the second attempt.
 */
async function validate(bundle, secret) {
  const home = mkdtempSync(join(workspace.directory, "keyring."));
  disposableHomes.push(home);
  writeFileSync(
    join(home, "gpg-agent.conf"),
    "allow-loopback-pinentry\ndefault-cache-ttl 0\nmax-cache-ttl 0\nignore-cache-for-signing\n",
    { mode: 0o600 },
  );

  // No passphrase is offered to the import, because an import never needs one. That makes a
  // failure here unambiguously a fact about the bundle: it cannot be a passphrase problem when no
  // passphrase has been supplied yet.
  const imported = await gpg(["--import"], { home, stdin: bundle });
  if (imported.status !== 0) {
    fail(
      `The exported bundle would not import, so ${PRIVATE_KEY_SECRET} is what is wrong. Nothing ` +
        `was uploaded.\n\n${imported.stderr.trim()}`,
    );
  }

  const listing = await gpg(["--with-colons", "--with-secret", "--list-secret-keys"], { home });
  let secretKeyFileCount = 0;
  try {
    secretKeyFileCount = readdirSync(join(home, "private-keys-v1.d")).length;
  } catch {
    secretKeyFileCount = 0;
  }
  const shape = judgeExportedBundle({
    records: parseKeyListing(listing.stdout.toString("utf8")),
    secretKeyFileCount,
    expectedPrimaryFingerprint: primaryFingerprint,
    expectedSubkeyFingerprint: signingSubkey.fingerprint,
  });
  if (!shape.ok) {
    fail(`The export is not the shape CI must be given. Nothing was uploaded.\n\n  ${shape.summary}`);
  }
  console.log(
    `  bundle: primary ${shape.primary.fingerprint} present as a stub (sec#), signing subkey ` +
      `${shape.subkey.fingerprint} present, ${secretKeyFileCount} secret key file, nothing else.`,
  );

  const probePath = join(home, "probe.txt");
  const signaturePath = join(home, "probe.asc");
  writeFileSync(probePath, `anchorage signing-secret probe\n`, { mode: 0o600 });

  /*
  Signed with the PRIMARY fingerprint as --local-user, which is what tools/sign-release.mjs is
  given on the runner. Pinning the subkey with a trailing "!" would test a friendlier path than
  the one CI takes; passing the primary makes gpg resolve through the stub and choose a signing
  subkey exactly as it will there, and the assertion below then checks that what it chose is the
  key that was exported. That is strictly more than pinning would establish.
  */
  const signed = await gpg(
    [
      "--yes",
      "--local-user",
      primaryFingerprint,
      "--armor",
      "--detach-sign",
      "--output",
      signaturePath,
      probePath,
    ],
    { home, passphrase: secret },
  );
  if (signed.status !== 0) {
    const cause = classifyPassphraseFailure(signed);
    fail(
      `The bundle imported cleanly and has the right shape, but it could not be unlocked. ` +
        `Nothing was uploaded.\n\n  ${cause.summary}\n\n  gpg said:\n${
          signed.stderr.trim() || signed.statusText.trim()
        }`,
    );
  }

  /*
  Verified against the definition tools/sign-release.mjs uses, rather than a second one written
  here. That module exists because this repository once had two answers to "is this signature
  good" and the second was wrong; adding a third would be the same mistake with better intentions.
  It requires GOODSIG, a VALIDSIG whose last field is the expected *primary*, and gpg's exit
  status as a conjunct — which is also the check a downloader's `gpg --verify` will make.
  */
  const verification = await gpg(
    detachedSignatureVerifyArguments(signaturePath, probePath),
    { home, statusOnStdout: true },
  );
  const verdict = judgeDetachedSignature({
    stdout: verification.stdout.toString("utf8"),
    stderr: verification.stderr,
    status: verification.status,
    expectedPrimaryFingerprint: primaryFingerprint,
  });
  if (!verdict.ok) {
    fail(
      `The bundle signed, but the signature does not verify back to ${primaryFingerprint}. ` +
        `Nothing was uploaded.\n\n  ${verdict.summary}\n${verdict.detail}`,
    );
  }
  if (verdict.signedByKey !== signingSubkey.fingerprint) {
    fail(
      `gpg chose ${verdict.signedByKey} to sign with, not the ${signingSubkey.fingerprint} that ` +
        `was exported. Nothing was uploaded.`,
    );
  }
  console.log(`  signed and verified: ${verdict.signedByKey} chains to ${verdict.signedByPrimary}.`);

  /*
  The negative control, and it runs *after* the successful signature on purpose.

  Before it, it would prove almost nothing — a fresh keyring rejects a wrong passphrase whatever
  the agent is configured to do. After a success is where a naive validator gives a false pass:
  with a default agent, the cache from the first unlock answers the second attempt and gpg signs
  happily with a passphrase that is definitely wrong. That is this script's own failure mode
  reproduced one layer up, so it is measured rather than assumed, on every run.
  */
  /*
  The decoy is a fixed string rather than the real passphrase with a suffix. Deriving it from the
  secret copied the live value into a second buffer and handed it to a second gpg process and a
  second agent connection — for no gain, since what this control needs is only "a passphrase that
  is not the right one", and a constant is that. Fewer copies of a secret is strictly better, and
  a decoy that cannot contain it is easier to be sure about than one that is zeroed afterwards.
  */
  const decoy = Buffer.from("not-the-passphrase-for-this-key");
  const control = await gpg(
    [
      "--yes",
      "--local-user",
      primaryFingerprint,
      "--armor",
      "--detach-sign",
      "--output",
      join(home, "control.asc"),
      probePath,
    ],
    { home, passphrase: decoy },
  );
  decoy.fill(0);
  if (control.status === 0) {
    fail(
      `The validation keyring is not isolated: a deliberately wrong passphrase also produced a ` +
        `signature, which means the check above would have passed for any passphrase at all. ` +
        `Nothing was uploaded, and nothing here has been proven.`,
    );
  }
  const controlCause = classifyPassphraseFailure(control);
  if (controlCause.reason !== "wrong-passphrase") {
    fail(
      `The negative control failed for the wrong reason (${controlCause.reason}), so it does not ` +
        `establish that the passphrase is what is being tested. Nothing was uploaded.\n\n${
          control.stderr.trim()
        }`,
    );
  }
  console.log("  negative control: a wrong passphrase is rejected, so the check above is real.");
}

console.log("\nValidating the pair before anything is uploaded:");
await validate(exported.stdout, passphrase);
console.log("PASS: the exported bundle and the passphrase are a working pair.");

// ---------------------------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------------------------

/**
 * Sets one secret, with the value on stdin.
 *
 * Not --body, which puts the value in argv; not --env-file, which puts it on disk and cannot
 * carry a multi-line value anyway. gh trims trailing \r and \n from a stdin value and nothing
 * else, so the armour arrives one byte shorter and imports and signs identically — measured — and
 * no base64 wrapping is needed. Avoiding base64 is deliberate as well as unnecessary: GitHub's
 * runner masks a secret line by line, so an armoured block is redacted in logs as itself, while a
 * re-encoding of it would be a value the masker has never seen.
 */
async function setSecret(name, value) {
  /*
  Refuse to upload if the process that launched this one has gone.

  The relay in the wrapper forwards the four signals it can catch, and SIGKILL is not one of them.
  Measured before this check: `kill -9` on the pid the operator can see killed the wrapper, the
  shell printed 137 and returned the prompt, and this process — now orphaned — went on to set both
  secrets over the top of it. An operator who kills harder because a run looks stuck should not
  find the repository changed anyway.

  `process.ppid` is the cheap, exact signal: `sh` execs into node, so the parent is the wrapper
  itself, and an orphan is reparented to init or a subreaper. Checked here rather than once at
  start-up because the kill can land at any point before the upload, and this is the last moment
  where refusing still means nothing has changed.
  */
  if (launcherWatch !== null) {
    /*
    "Is my launcher dead", not "is that pid still my parent". The stronger question refuses runs
    nobody killed: a `/bin/sh` that wraps rather than execs leaves node's parent as `sh`, and an
    `ANCHORAGE_SIGNING_PARENT` inherited from an earlier shell is stale by construction. Both were
    reproduced, and both burned a typed passphrase and a full validation before blaming the
    operator for a kill that never happened. Refusing a good run is a worse outcome than the case
    the check exists for.

    EPERM means the pid exists and belongs to someone else — alive, so not our case. Only ESRCH is
    "gone".
    */
    let launcherGone = false;
    try {
      process.kill(launcherWatch, 0);
    } catch (error) {
      launcherGone = error.code === "ESRCH";
    }
    if (launcherGone) {
      fail(
        uploaded.length === 0
          ? `The process that launched this one is gone, so it was probably killed deliberately.\n` +
              `  Nothing has been uploaded, and ${name} was the next thing that would have been.\n\n` +
              `  Run it again when you mean to.`
          : `The process that launched this one is gone, so it was probably killed deliberately.\n` +
              `  ${name} was not uploaded — but ${uploaded.join(" and ")} already was, so the\n` +
              `  repository is now half-updated. Re-run this script to finish the job.`,
      );
    }
  }
  const result = await gh(
    [
      "secret",
      "set",
      name,
      "--repo",
      repository,
      "--app",
      "actions",
      ...(environmentName ? ["--env", environmentName] : []),
    ],
    { stdin: value },
  );
  if (result.status !== 0) {
    return { ok: false, detail: `${result.stdout}${result.stderr}`.trim() };
  }
  // Recorded so a later refusal can say what the repository actually holds. A message that says
  // "nothing has been uploaded" while one secret has been is the one failure this file cannot
  // afford, since every other guarantee here rests on its reports being true.
  uploaded.push(name);
  return { ok: true };
}

if (dryRun) {
  console.log(
    `\n--dry-run: ${PRIVATE_KEY_SECRET} and ${PASSPHRASE_SECRET} were NOT uploaded. Everything ` +
      `up to the upload was real, including reading ${repository}'s secret list.`,
  );
} else {
  /*
  GPG_PRIVATE_KEY first, then GPG_PASSPHRASE. The two cannot be written atomically — they are two
  API calls — so the order is chosen by what a failure between them leaves behind, and one of the
  two orders leaves the repository in the exact state this script exists to end.

    key first, then the passphrase fails  -> new bundle, no passphrase. The workflow's preflight
                                             says so by name, and even without it the failure is
                                             today's, which is understood.
    passphrase first, then the key fails  -> OLD bundle, NEW passphrase. That is the trap: the
                                             preset succeeds, the agent reports the grip cached,
                                             and signing dies with the same batchmode line as a
                                             missing secret. Indistinguishable in the log.

  So a partial run must land on the first row. GPG_KEY_ID, when asked for, goes before both: it is
  not secret, and a stale key id fails loudly and by name ("Imported no secret key matching …").
  */
  if (alsoSetKeyId) {
    const keyIdResult = await setSecret(KEY_ID_SECRET, Buffer.from(primaryFingerprint));
    if (!keyIdResult.ok) fail(`Could not set ${KEY_ID_SECRET}:\n${keyIdResult.detail}`);
    console.log(`Set ${KEY_ID_SECRET}`);
  }

  const keyResult = await setSecret(PRIVATE_KEY_SECRET, exported.stdout);
  if (!keyResult.ok) {
    fail(
      `Could not set ${PRIVATE_KEY_SECRET}:\n${keyResult.detail}\n\n  Nothing was changed; the ` +
        `repository is as it was.`,
    );
  }
  console.log(`Set ${PRIVATE_KEY_SECRET} (${exported.stdout.length} bytes)`);

  const passphraseResult = await setSecret(PASSPHRASE_SECRET, passphrase);
  if (!passphraseResult.ok) {
    fail(
      `${PRIVATE_KEY_SECRET} was updated but ${PASSPHRASE_SECRET} was not:\n` +
        `${passphraseResult.detail}\n\n  The repository is now half-updated. It holds a bundle ` +
        `whose passphrase it does not have, which is the state releases have been failing in — ` +
        `re-run this script to finish the job.`,
    );
  }
  console.log(`Set ${PASSPHRASE_SECRET}`);
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const after = dryRun ? before : await secretTimestamps();

console.log(`\n${"-".repeat(78)}`);
console.log(dryRun ? "REHEARSED (nothing uploaded)" : "DONE");
console.log(`${"-".repeat(78)}`);
console.log(`  release identity   ${primaryFingerprint}`);
console.log(`  signing subkey     ${signingSubkey.fingerprint}`);
console.log(`  subkey expires     ${expiresAt}  — re-run this script before then`);
console.log(`  repository         ${repository}${environmentName ? ` / ${environmentName}` : ""}`);
console.log("");
console.log("  proven locally, before anything was uploaded:");
console.log("    - the bundle carries no primary secret, so a runner holding it cannot certify");
console.log("    - it carries exactly one signing subkey secret and nothing else");
console.log("    - the passphrase unlocks it, first try, in a keyring with no cache");
console.log("    - the signature it makes verifies back to the release identity");
console.log("    - a wrong passphrase is rejected by that same keyring");
console.log("");
for (const name of [KEY_ID_SECRET, PRIVATE_KEY_SECRET, PASSPHRASE_SECRET]) {
  const timestamp = after.get(name);
  const changed = timestamp && timestamp !== before.get(name);
  console.log(
    `  ${name.padEnd(18)} ${timestamp ?? "(not set)"}${changed ? "  <- updated now" : ""}`,
  );
}

/*
The next step is a CI run, not another local check, and it is worth saying why rather than leaving
it implied. `gh secret list` proves existence and recency; it cannot prove correctness, because
GitHub never gives a secret value back and gh will store an empty one without complaint. The pair
was proven above against this machine's gpg — the runner has its own build and its own agent, and
a workflow_dispatch is a far cheaper way to confirm that than a release tag. Four have been spent
already.
*/
console.log("");
console.log("  next, in fish:");
console.log(`    gh secret list --repo ${repository}`);
console.log(`    gh workflow run release.yml --repo ${repository} --ref main`);
console.log(`    gh run watch --repo ${repository}`);
console.log("");
console.log(
  "  Two things this does not buy, stated rather than implied. Both secrets live in the same\n" +
    "  store and are handed to the same job, so the passphrase is not a second factor against\n" +
    "  anyone who can read repository secrets or add a step to the release job — what it\n" +
    "  protects against is the bundle leaking on its own, in a log, an artifact or a cache. And\n" +
    "  the subkey layout, not the passphrase, is what keeps a compromised runner from certifying\n" +
    "  keys as you. Generate the subkey's revocation certificate now, while the primary is to\n" +
    "  hand, because the runner cannot produce one and neither can this script.",
);
if (dryRun) {
  console.log("\n  Re-run without --dry-run to upload.");
}
console.log(
  `\nPASS: ${dryRun ? "the pair was proven; nothing was uploaded" : `both secrets set on ${repository}`}.`,
);
