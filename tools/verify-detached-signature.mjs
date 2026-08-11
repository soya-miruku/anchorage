/**
 * What "this file carries a good signature from this identity" means, in one place.
 *
 * Two programs ask that question — tools/sign-release.mjs, which refuses to publish a release
 * that fails it, and app/scripts/package-desktop.mjs, which reports the state of a build. They
 * used to answer it separately, and the second one answered it wrongly: it matched gpg's prose
 * for `Good signature` and looked for the primary fingerprint as a substring of that prose. Both
 * halves are wrong for the layout this project actually uses. gpg prints the *signing key*
 * compactly and the primary spaced out in groups of four, so the substring test only ever
 * matched when the primary itself signed — and the whole point of the CI key is that it cannot
 * certify, so it signs with a subkey. `Good signature` is also translated: a runner with a
 * different locale would have failed a perfectly good signature.
 *
 * A second definition of a security check is a second chance to get it wrong, so there is now
 * one. This module decides; callers only run gpg and report.
 *
 * The decision reads gpg's --status-fd lines, which are machine-readable and never localised:
 *
 *   GOODSIG   the signature is cryptographically good.
 *   VALIDSIG  its first field is the key that signed and its last is that key's primary.
 *             Comparing the primary is what "signed by this identity" means in OpenPGP: it
 *             accepts the primary and any of its signing subkeys, and still rejects a different
 *             key entirely.
 *   exit 0    gpg must also have been satisfied overall. This is a conjunct, never a substitute:
 *             a detached signature file can hold more than one signature, and a file carrying a
 *             good one and a bad one prints GOODSIG and VALIDSIG for the good one, BADSIG for
 *             the other, and exits non-zero (measured, gpg 2.4.4). Status lines alone would
 *             report that file as verified on the strength of whichever signature came first.
 */

/**
 * The arguments both callers pass to gpg, so neither can drift from the other — in particular,
 * neither can drop --status-fd=1 and fall back to reading prose.
 */
export function detachedSignatureVerifyArguments(signaturePath, signedPath) {
  return ["--status-fd=1", "--verify", signaturePath, signedPath];
}

/**
 * Judges one verification. Takes what gpg produced rather than producing it, so the decision can
 * be tested against recorded output without a keyring, and so a caller's own process plumbing
 * cannot change the verdict.
 *
 * Returns `{ ok: true, signedByKey, signedByPrimary, viaSubkey }` or `{ ok: false, reason,
 * summary }`, plus `detail` — gpg's own account of what it saw, for the failure message.
 */
export function judgeDetachedSignature({
  stdout = "",
  stderr = "",
  status,
  expectedPrimaryFingerprint,
}) {
  const detail = `${stdout}${stderr}`.trim();
  const statusLines = String(stdout)
    .split("\n")
    .filter((line) => line.startsWith("[GNUPG:] "))
    .map((line) => line.slice("[GNUPG:] ".length).trim());

  if (!statusLines.some((line) => line.startsWith("GOODSIG "))) {
    return {
      ok: false,
      reason: "no-good-signature",
      summary: "The produced signature did not verify",
      detail,
    };
  }
  const validSig = statusLines.find((line) => line.startsWith("VALIDSIG "));
  if (!validSig) {
    return {
      ok: false,
      reason: "no-validsig",
      summary: "gpg reported no VALIDSIG for the signature",
      detail,
    };
  }
  const validSigFields = validSig.split(/\s+/u);
  const signedByKey = validSigFields[1];
  const signedByPrimary = validSigFields.at(-1);
  if (signedByPrimary !== expectedPrimaryFingerprint) {
    return {
      ok: false,
      reason: "primary-mismatch",
      summary:
        `The signature verified but its primary key is ${signedByPrimary}, ` +
        `not ${expectedPrimaryFingerprint}`,
      detail,
      signedByKey,
      signedByPrimary,
    };
  }
  if (status !== 0) {
    return {
      ok: false,
      reason: "gpg-exit",
      summary:
        `gpg exited ${status} verifying the signature, having also reported a good one`,
      detail,
      signedByKey,
      signedByPrimary,
    };
  }
  return {
    ok: true,
    signedByKey,
    signedByPrimary,
    viaSubkey: signedByKey !== signedByPrimary,
    detail,
  };
}
