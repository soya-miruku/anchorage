/**
 * The accept set, pinned.
 *
 * Every fixture below is output gpg 2.4.4 actually produced — the runner's version — verifying a
 * detached signature over a SHA256SUMS in a container shaped like the release job: an ed25519
 * key whose primary can only certify, a signing subkey, a virgin keyring and no ownertrust.
 * They are pasted rather than generated so that the cases that need a keyring, a second
 * identity, or a deliberately corrupted signature can be asserted here, with no gpg to run.
 *
 * A test that only proved good signatures are accepted would be worse than none: the way this
 * check fails is by accepting something. Most of what follows is the rejections.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  detachedSignatureVerifyArguments,
  judgeDetachedSignature,
} from "./verify-detached-signature.mjs";

const RELEASE_PRIMARY = "E962987CB2DEDC501C649B5CBF1F569CEDD3C7A0";
const RELEASE_SUBKEY = "224B3254EFB090058EAA77800E93FA86EADDDA31";
const OTHER_PRIMARY = "E491C654A7D1D7E76A2128A2BA1996F938EEB49B";

// Signed by the subkey of a primary that cannot sign: the shape CI produces and the shape the
// old prose-matching check in package-desktop.mjs reported as SIGNATURE DID NOT VERIFY.
const GOOD_SUBKEY = {
  stdout: `[GNUPG:] NEWSIG
[GNUPG:] KEY_CONSIDERED ${RELEASE_PRIMARY} 0
[GNUPG:] SIG_ID T00sq4f8G7PykSi18rd7Lr0y2rM 2026-08-11 1786446059
[GNUPG:] GOODSIG 0E93FA86EADDDA31 Harness Release Signing <harness@example.invalid>
[GNUPG:] VALIDSIG ${RELEASE_SUBKEY} 2026-08-11 1786446059 0 4 0 22 10 00 ${RELEASE_PRIMARY}
[GNUPG:] KEY_CONSIDERED ${RELEASE_PRIMARY} 0
[GNUPG:] TRUST_UNDEFINED 0 pgp
`,
  stderr: `gpg: Signature made Tue Aug 11 11:00:59 2026 UTC
gpg:                using EDDSA key ${RELEASE_SUBKEY}
gpg: Good signature from "Harness Release Signing <harness@example.invalid>" [unknown]
Primary key fingerprint: E962 987C B2DE DC50 1C64  9B5C BF1F 569C EDD3 C7A0
     Subkey fingerprint: 224B 3254 EFB0 9005 8EAA  7780 0E93 FA86 EADD DA31
`,
  status: 0,
};

test("accepts a signature made by a signing subkey of the expected primary", () => {
  const verdict = judgeDetachedSignature({
    ...GOOD_SUBKEY,
    expectedPrimaryFingerprint: RELEASE_PRIMARY,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.signedByPrimary, RELEASE_PRIMARY);
  assert.equal(verdict.signedByKey, RELEASE_SUBKEY);
  assert.equal(verdict.viaSubkey, true);
});

test("accepts a signature made by the primary itself", () => {
  const primary = "C3AF979CD4750059ECCE303411D69A273BCD2C73";
  const verdict = judgeDetachedSignature({
    stdout: `[GNUPG:] NEWSIG
[GNUPG:] KEY_CONSIDERED ${primary} 0
[GNUPG:] GOODSIG 11D69A273BCD2C73 Primary Signer <primary@example.invalid>
[GNUPG:] VALIDSIG ${primary} 2026-08-11 1786446059 0 4 0 22 10 00 ${primary}
[GNUPG:] TRUST_UNDEFINED 0 pgp
`,
    stderr: `gpg: Good signature from "Primary Signer <primary@example.invalid>" [unknown]\n`,
    status: 0,
    expectedPrimaryFingerprint: primary,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.viaSubkey, false);
});

test("rejects a file edited after it was signed", () => {
  const verdict = judgeDetachedSignature({
    stdout: `[GNUPG:] NEWSIG
[GNUPG:] KEY_CONSIDERED ${RELEASE_PRIMARY} 0
[GNUPG:] BADSIG 0E93FA86EADDDA31 Harness Release Signing <harness@example.invalid>
[GNUPG:] FAILURE gpg-exit 33554433
`,
    stderr: `gpg: BAD signature from "Harness Release Signing <harness@example.invalid>" [unknown]\n`,
    status: 1,
    expectedPrimaryFingerprint: RELEASE_PRIMARY,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "no-good-signature");
});

test("rejects an empty signature file, which is what a failed signing run leaves behind", () => {
  const verdict = judgeDetachedSignature({
    stdout: "[GNUPG:] NODATA 2\n[GNUPG:] FAILURE verify 4294967295\n",
    stderr: "gpg: verify signatures failed: Unknown system error\n",
    status: 2,
    expectedPrimaryFingerprint: RELEASE_PRIMARY,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "no-good-signature");
  // The status lines name the cause; the prose alone did not, and that cost a release.
  assert.match(verdict.detail, /NODATA 2/u);
});

test("rejects a perfectly good signature made by a different identity", () => {
  const verdict = judgeDetachedSignature({
    stdout: `[GNUPG:] NEWSIG
[GNUPG:] GOODSIG A5EFD3870C03636C Unrelated Signer <unrelated@example.invalid>
[GNUPG:] VALIDSIG 86949E02FFB3B698C17CF396A5EFD3870C03636C 2026-08-11 1786446060 0 4 0 22 10 00 ${OTHER_PRIMARY}
[GNUPG:] TRUST_UNDEFINED 0 pgp
`,
    stderr: `gpg: Good signature from "Unrelated Signer <unrelated@example.invalid>" [unknown]\n`,
    status: 0,
    expectedPrimaryFingerprint: RELEASE_PRIMARY,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "primary-mismatch");
  assert.match(verdict.summary, new RegExp(OTHER_PRIMARY, "u"));
});

test("rejects a signature file holding a good signature and a bad one", () => {
  // The case that makes gpg's exit status load-bearing: GOODSIG and VALIDSIG are both present
  // and both name the right key, and gpg still exits non-zero because of the second signature.
  const verdict = judgeDetachedSignature({
    stdout: `${GOOD_SUBKEY.stdout}[GNUPG:] NEWSIG
[GNUPG:] BADSIG 0E93FA86EADDDA31 Harness Release Signing <harness@example.invalid>
[GNUPG:] FAILURE gpg-exit 33554433
`,
    stderr: "",
    status: 1,
    expectedPrimaryFingerprint: RELEASE_PRIMARY,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "gpg-exit");
});

test("rejects when the signature it reads first belongs to another identity", () => {
  const verdict = judgeDetachedSignature({
    stdout: `[GNUPG:] GOODSIG A5EFD3870C03636C Unrelated Signer <unrelated@example.invalid>
[GNUPG:] VALIDSIG 86949E02FFB3B698C17CF396A5EFD3870C03636C 2026-08-11 1786446061 0 4 0 22 10 00 ${OTHER_PRIMARY}
[GNUPG:] GOODSIG 0E93FA86EADDDA31 Harness Release Signing <harness@example.invalid>
[GNUPG:] VALIDSIG ${RELEASE_SUBKEY} 2026-08-11 1786446060 0 4 0 22 10 00 ${RELEASE_PRIMARY}
`,
    stderr: "",
    status: 0,
    expectedPrimaryFingerprint: RELEASE_PRIMARY,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "primary-mismatch");
});

test("rejects a good signature whose VALIDSIG gpg did not print", () => {
  const verdict = judgeDetachedSignature({
    stdout: "[GNUPG:] GOODSIG 0E93FA86EADDDA31 Harness Release Signing\n",
    stderr: "",
    status: 0,
    expectedPrimaryFingerprint: RELEASE_PRIMARY,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "no-validsig");
});

test("does not depend on the locale gpg is speaking", () => {
  // Same signature, same status lines, gpg's prose translated. `Good signature` is a gettext
  // string — measured: under de_DE with gpg's catalog it prints `Korrekte Signatur von`, which
  // is why a check that matched on it was a check on the runner's locale.
  const german = judgeDetachedSignature({
    stdout: GOOD_SUBKEY.stdout,
    stderr: `gpg: Signature made Di 11 Aug 2026 11:01:25 UTC
gpg:                using EDDSA key ${RELEASE_SUBKEY}
gpg: Korrekte Signatur von "Harness Release Signing <harness@example.invalid>" [ultimate]
`,
    status: 0,
    expectedPrimaryFingerprint: RELEASE_PRIMARY,
  });
  const english = judgeDetachedSignature({
    ...GOOD_SUBKEY,
    expectedPrimaryFingerprint: RELEASE_PRIMARY,
  });
  assert.equal(german.ok, true);
  assert.equal(german.ok, english.ok);
  assert.equal(german.signedByPrimary, english.signedByPrimary);
});

test("reads status lines only from the stream gpg writes them to", () => {
  // --status-fd=1 is stdout. A GOODSIG-shaped line arriving on stderr is prose, or worse, part
  // of a filename or a key's user id that someone chose; it decides nothing.
  const verdict = judgeDetachedSignature({
    stdout: "",
    stderr: `[GNUPG:] GOODSIG 0E93FA86EADDDA31 x
[GNUPG:] VALIDSIG ${RELEASE_SUBKEY} 2026-08-11 1786446059 0 4 0 22 10 00 ${RELEASE_PRIMARY}
`,
    status: 0,
    expectedPrimaryFingerprint: RELEASE_PRIMARY,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "no-good-signature");
});

test("a caller that forgets to pass gpg's exit status is refused, not trusted", () => {
  const verdict = judgeDetachedSignature({
    stdout: GOOD_SUBKEY.stdout,
    stderr: "",
    expectedPrimaryFingerprint: RELEASE_PRIMARY,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "gpg-exit");
});

test("asks gpg for machine-readable output, in the order gpg expects the operands", () => {
  assert.deepEqual(detachedSignatureVerifyArguments("/r/SHA256SUMS.asc", "/r/SHA256SUMS"), [
    "--status-fd=1",
    "--verify",
    "/r/SHA256SUMS.asc",
    "/r/SHA256SUMS",
  ]);
});
