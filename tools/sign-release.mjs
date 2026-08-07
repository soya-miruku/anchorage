#!/usr/bin/env node
/**
 * Signs a built release and records a receipt that can be checked from outside the project.
 *
 * The AppImage reserves ELF sections for an embedded signature, but verifying one requires
 * the user to have appimagetool and to know about `--validate`. A detached OpenPGP signature
 * over a SHA256SUMS file is what people actually check, needs only stock `gpg` and
 * `sha256sum`, and works on any distribution. That is what this produces.
 *
 * The private key never leaves the operator's machine and is never read here: gpg is invoked
 * so that gpg-agent prompts for the passphrase directly. Nothing in this repository, and
 * nothing in the evidence bundle, ever contains key material.
 *
 * Usage:
 *   node tools/sign-release.mjs --key "Anchorage Release Signing"
 *   node tools/sign-release.mjs --key <fingerprint> --verify-only
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "..");
const releaseDirectory = resolve(workspaceRoot, "app/release");
const sumsPath = join(releaseDirectory, "SHA256SUMS");
const signaturePath = `${sumsPath}.asc`;
const receiptPath = join(releaseDirectory, "release-signature.json");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function gpg(args, { allowFailure = false } = {}) {
  try {
    return await run("gpg", args, { maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    if (allowFailure) return { stdout: "", stderr: String(error?.stderr ?? error) };
    throw error;
  }
}

/**
 * The signing identity, resolved to a full fingerprint.
 *
 * A short key id or a UID substring can match more than one key, and signing with a
 * different key than intended is not something the operator would notice. Resolving to the
 * fingerprint first makes the choice explicit and lets the receipt record exactly what signed.
 */
async function resolveSigningKey(selector) {
  // gpg exits non-zero when nothing matches, which is the most likely first run — the
  // operator has not generated the key yet. That deserves the instructions below, not a
  // stack trace.
  const { stdout } = await gpg(
    ["--list-secret-keys", "--with-colons", "--fingerprint", selector],
    { allowFailure: true },
  );
  const fingerprints = [];
  let sawSecretKey = false;
  for (const line of stdout.split("\n")) {
    const fields = line.split(":");
    if (fields[0] === "sec") sawSecretKey = true;
    if (fields[0] === "fpr" && sawSecretKey && fields[9]) {
      fingerprints.push(fields[9]);
      sawSecretKey = false;
    }
  }
  if (fingerprints.length === 0) {
    fail(
      `No secret key matches ${JSON.stringify(selector)}. Generate one with:\n` +
        `  gpg --quick-generate-key "Anchorage Release Signing <you@example.com>" ed25519 sign 3y`,
    );
  }
  if (fingerprints.length > 1) {
    fail(
      `${JSON.stringify(selector)} matches ${fingerprints.length} secret keys. ` +
        `Pass a full fingerprint instead:\n  ${fingerprints.join("\n  ")}`,
    );
  }
  return fingerprints[0];
}

/*
Everything a downloader receives, and therefore everything that must be covered.

Listed explicitly rather than by "any file in the directory", so that adding a target is a
deliberate decision to sign it rather than something that happens silently — and so that a
stray file in the release directory cannot end up inside a signature. The inverse mistake has
already happened once: the deb, rpm and pacman targets shipped while this filter still named
only the AppImage, which left three of the four downloads uncovered by SHA256SUMS.
*/
const SIGNED_INSTALLER_EXTENSIONS = Object.freeze([
  ".AppImage",
  ".deb",
  ".rpm",
  ".pacman",
]);

async function releaseArtifacts() {
  let entries;
  try {
    entries = await readdir(releaseDirectory, { withFileTypes: true });
  } catch {
    fail(
      `No release directory at ${relative(workspaceRoot, releaseDirectory)}. ` +
        `Build one first with: npm --prefix app run package:linux`,
    );
  }
  const artifacts = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        SIGNED_INSTALLER_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
        name === "release-verification.json" ||
        name === "latest-linux.yml",
    )
    .sort();
  if (!artifacts.some((name) => name.endsWith(".AppImage"))) {
    fail("No AppImage found to sign; build a release before signing it.");
  }
  return artifacts;
}

const verifyOnly = process.argv.includes("--verify-only");
const selector = argument("--key");
if (!selector) {
  fail('Pass the signing identity, for example: --key "Anchorage Release Signing"');
}

const fingerprint = await resolveSigningKey(selector);
const artifacts = await releaseArtifacts();

if (!verifyOnly) {
  // SHA256SUMS is written in the format `sha256sum -c` expects, so a downloader can check
  // integrity with a tool they already have rather than one this project invented.
  const lines = [];
  for (const name of artifacts) {
    lines.push(`${await sha256File(join(releaseDirectory, name))}  ${name}`);
  }
  await writeFile(sumsPath, `${lines.join("\n")}\n`, { mode: 0o644 });
  console.log(`Wrote ${relative(workspaceRoot, sumsPath)} covering ${artifacts.length} artifacts`);

  // --yes so a re-sign overwrites cleanly; gpg-agent prompts for the passphrase, which is
  // never handled here.
  const signing = await gpg(
    [
      "--batch",
      "--yes",
      "--local-user",
      fingerprint,
      "--armor",
      "--detach-sign",
      "--output",
      signaturePath,
      sumsPath,
    ],
    { allowFailure: true },
  );
  if (!existsSync(signaturePath)) {
    // A half-written SHA256SUMS with no signature beside it reads as a finished release that
    // simply was not signed. Removing it makes the failure unambiguous.
    await rm(sumsPath, { force: true });
    const reason = `${signing.stdout ?? ""}${signing.stderr ?? ""}`.trim();
    if (/Timeout|No pinentry|Inappropriate ioctl|cannot open/iu.test(reason)) {
      fail(
        "gpg could not prompt for the passphrase.\n" +
          "  Signing needs an interactive terminal, because the private key is yours and is\n" +
          "  never handled by this project. Run the same command yourself:\n\n" +
          `    node tools/sign-release.mjs --key ${fingerprint}\n\n` +
          `  gpg said: ${reason}`,
      );
    }
    fail(`gpg did not produce a signature:\n${reason}`);
  }
  console.log(`Signed with ${fingerprint}`);
}

/*
Verify what was actually produced rather than trusting that signing succeeded. A signature that
does not verify is worse than none: it looks like protection and is not.

Read from --status-fd rather than from gpg's prose, for two reasons that both bit this check.

Prose is formatted for people: gpg prints the signing key compactly ("using EDDSA key <fpr>")
and the primary spaced out ("Primary key fingerprint: 6EC9 EBF7 …"). A substring test for the
compact fingerprint therefore only ever matched when the primary itself signed, and rejected a
perfectly good signature the moment a signing subkey existed — which is the layout a signing key
should have, and the one CI uses so that a runner never holds a key that can certify.

Prose is also translatable. `Good signature` is a localised string, so a runner with a different
locale would have failed a valid signature. VALIDSIG and GOODSIG are not localised.

VALIDSIG's first field is the key that signed, and its last is that key's primary. Comparing the
primary is what "signed by this identity" means in OpenPGP: it accepts the primary and any of its
signing subkeys, and still rejects a different key entirely.
*/
const verification = await gpg(
  ["--status-fd=1", "--verify", signaturePath, sumsPath],
  { allowFailure: true },
);
const verifyOutput = `${verification.stdout}${verification.stderr}`;
const statusLines = verification.stdout
  .split("\n")
  .filter((line) => line.startsWith("[GNUPG:] "))
  .map((line) => line.slice("[GNUPG:] ".length).trim());
if (!statusLines.some((line) => line.startsWith("GOODSIG "))) {
  fail(`The produced signature did not verify:\n${verifyOutput.trim()}`);
}
const validSig = statusLines.find((line) => line.startsWith("VALIDSIG "));
if (!validSig) {
  fail(`gpg reported no VALIDSIG for the signature:\n${verifyOutput.trim()}`);
}
const validSigFields = validSig.split(/\s+/u);
const signedByKey = validSigFields[1];
const signedByPrimary = validSigFields.at(-1);
if (signedByPrimary !== fingerprint) {
  fail(
    `The signature verified but its primary key is ${signedByPrimary}, not ${fingerprint}:\n` +
      verifyOutput.trim(),
  );
}
if (signedByKey !== fingerprint) {
  console.log(`Signed by subkey ${signedByKey} of ${fingerprint}`);
}

// Re-check every recorded digest against the file on disk, so the receipt cannot certify a
// SHA256SUMS that has drifted from the artifacts beside it.
const recorded = (await readFile(sumsPath, "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [digest, name] = line.split(/\s+/u);
    return { digest, name };
  });
for (const entry of recorded) {
  const actual = await sha256File(join(releaseDirectory, entry.name));
  if (actual !== entry.digest) {
    fail(`${entry.name} does not match its recorded digest`);
  }
}

const receipt = {
  schemaVersion: 1,
  status: "signed",
  completedAt: new Date().toISOString(),
  signingKeyFingerprint: fingerprint,
  checksumFile: basename(sumsPath),
  signatureFile: basename(signaturePath),
  artifacts: recorded,
};
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
  mode: 0o644,
});

console.log(
  `PASS: ${recorded.length} artifacts signed and verified against ${fingerprint}; ` +
    `receipt at ${relative(workspaceRoot, receiptPath)}`,
);
