/**
 * The accept set for a CI signing bundle, pinned.
 *
 * Every listing below is what gpg 2.4.7 actually printed after importing a real export into a
 * keyring that had never seen it, in a container with no network and a throwaway key shaped like
 * the release key: a primary that can only certify, one signing subkey, one encryption subkey.
 * They are pasted rather than regenerated because the interesting shapes take deliberate effort
 * to produce — a full export, a missing "!", an export whose passphrase was wrong — and because
 * the imported keyring is what a runner would hold, which is not the same thing as the armour.
 *
 * A test that only proved good bundles are accepted would be worse than none: the way this check
 * fails is by accepting something. Most of what follows is the rejections.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseSigningSubkey,
  classifyPassphraseFailure,
  judgeExportedBundle,
  parseKeyListing,
} from "./signing-key-bundle.mjs";

const PRIMARY = "C793716FE094204793D1CCE6201C5C10B61693BD";
const SIGN_SUBKEY = "A5F046687E135BAAF56C2D08BC7CA58B3B94EACF";
const ENCRYPTION_SUBKEY = "3C18BF566DD2577338B5483739E5D4C5E1F190E7";

// `gpg --armor --export-secret-subkeys <sign-subkey>!` — the shape CI must be given. One secret
// key file; the primary is a stub, which is field 15's "#".
const SUBKEY_ONLY = `sec:-:255:22:201C5C10B61693BD:1786460825:1849532825::-:::cSC:::#::ed25519:::0:
fpr:::::::::C793716FE094204793D1CCE6201C5C10B61693BD:
grp:::::::::C4E33319222270B3299D9B6B6A09424D2C03C14C:
uid:-::::1786460825::6A3BF5D63782CEED2CA0483CE5A045B535A4865A::Harness Release Signing <harness@example.invalid>::::::::::0:
ssb:-:255:22:BC7CA58B3B94EACF:1786460827:1817996827:::::s:::+::ed25519::
fpr:::::::::A5F046687E135BAAF56C2D08BC7CA58B3B94EACF:
grp:::::::::BDFD8118166D978F743C1EA5F5E572F62853F734:
`;

// The same command with the "!" left off. Two secret key files: the signing subkey and the
// *encryption* subkey. Note the primary is still a stub — dropping the bang does not leak the
// primary, it leaks everything else, which is the part usually got backwards.
const MISSING_BANG = `sec:-:255:22:201C5C10B61693BD:1786460825:1849532825::-:::cESC:::#::ed25519:::0:
fpr:::::::::C793716FE094204793D1CCE6201C5C10B61693BD:
grp:::::::::C4E33319222270B3299D9B6B6A09424D2C03C14C:
uid:-::::1786460825::6A3BF5D63782CEED2CA0483CE5A045B535A4865A::Harness Release Signing <harness@example.invalid>::::::::::0:
ssb:-:255:22:BC7CA58B3B94EACF:1786460827:1817996827:::::s:::+::ed25519::
fpr:::::::::A5F046687E135BAAF56C2D08BC7CA58B3B94EACF:
grp:::::::::BDFD8118166D978F743C1EA5F5E572F62853F734:
ssb:-:255:18:39E5D4C5E1F190E7:1786460828:1817996828:::::e:::+::cv25519::
fpr:::::::::3C18BF566DD2577338B5483739E5D4C5E1F190E7:
grp:::::::::29F6CE2F2AAC5CE4E2200A94085CFC49B3CEF93F:
`;

// `gpg --armor --export-secret-keys <primary>` — one word different, three secret key files, and
// field 15 on the sec record is "+" instead of "#". This is the one that must never be uploaded.
const FULL_EXPORT = `sec:-:255:22:201C5C10B61693BD:1786460825:1849532825::-:::cESC:::+::ed25519:::0:
fpr:::::::::C793716FE094204793D1CCE6201C5C10B61693BD:
grp:::::::::C4E33319222270B3299D9B6B6A09424D2C03C14C:
uid:-::::1786460825::6A3BF5D63782CEED2CA0483CE5A045B535A4865A::Harness Release Signing <harness@example.invalid>::::::::::0:
ssb:-:255:22:BC7CA58B3B94EACF:1786460827:1817996827:::::s:::+::ed25519::
fpr:::::::::A5F046687E135BAAF56C2D08BC7CA58B3B94EACF:
grp:::::::::BDFD8118166D978F743C1EA5F5E572F62853F734:
ssb:-:255:18:39E5D4C5E1F190E7:1786460828:1817996828:::::e:::+::cv25519::
fpr:::::::::3C18BF566DD2577338B5483739E5D4C5E1F190E7:
grp:::::::::29F6CE2F2AAC5CE4E2200A94085CFC49B3CEF93F:
`;

test("accepts a subkey-only export of the expected key", () => {
  const verdict = judgeExportedBundle({
    records: parseKeyListing(SUBKEY_ONLY),
    secretKeyFileCount: 1,
    expectedPrimaryFingerprint: PRIMARY,
    expectedSubkeyFingerprint: SIGN_SUBKEY,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.primary.fingerprint, PRIMARY);
  assert.equal(verdict.subkey.fingerprint, SIGN_SUBKEY);
});

test("refuses an export carrying the primary's secret", () => {
  const verdict = judgeExportedBundle({
    records: parseKeyListing(FULL_EXPORT),
    secretKeyFileCount: 3,
    expectedPrimaryFingerprint: PRIMARY,
    expectedSubkeyFingerprint: SIGN_SUBKEY,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "primary-secret-present");
  // The message has to say what a compromised runner could then do, because "wrong shape" does
  // not tell the operator why this is the one failure worth stopping everything for.
  assert.match(verdict.summary, /certify/u);
});

test("refuses an export that dropped the ! and brought the encryption subkey along", () => {
  const verdict = judgeExportedBundle({
    records: parseKeyListing(MISSING_BANG),
    secretKeyFileCount: 2,
    expectedPrimaryFingerprint: PRIMARY,
    expectedSubkeyFingerprint: SIGN_SUBKEY,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "extra-secrets");
  assert.match(verdict.summary, new RegExp(ENCRYPTION_SUBKEY, "u"));
  assert.match(verdict.summary, /decrypt/u);
});

/*
An export whose passphrase was wrong still writes several hundred bytes of valid armour, exits 2,
and imports with `IMPORT_OK 16` — "contains private key". `gpg -K` then prints nothing at all:
measured, 439 bytes in, 0 files in private-keys-v1.d, an empty secret listing. A script that
checked only that the export produced output would upload that, which is why the empty listing has
to be a named rejection rather than an unhandled shape.
*/
test("refuses the armour a failed export leaves behind", () => {
  const verdict = judgeExportedBundle({
    records: parseKeyListing(""),
    secretKeyFileCount: 0,
    expectedPrimaryFingerprint: PRIMARY,
    expectedSubkeyFingerprint: SIGN_SUBKEY,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "no-secret-key");
});

test("refuses a bundle whose primary is a different key", () => {
  const verdict = judgeExportedBundle({
    records: parseKeyListing(SUBKEY_ONLY),
    secretKeyFileCount: 1,
    expectedPrimaryFingerprint: "E491C654A7D1D7E76A2128A2BA1996F938EEB49B",
    expectedSubkeyFingerprint: SIGN_SUBKEY,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "primary-mismatch");
});

/*
The listing and the keyring are two answers to the same question, and this is what happens when
they disagree. It is not a hypothetical: the release workflow prints this count for the same
reason, because "two keygrips, one key file" is the asymmetry that made presetting the first
keygrip cache nothing.
*/
test("refuses when gpg landed a different number of secrets than the listing shows", () => {
  const verdict = judgeExportedBundle({
    records: parseKeyListing(SUBKEY_ONLY),
    secretKeyFileCount: 2,
    expectedPrimaryFingerprint: PRIMARY,
    expectedSubkeyFingerprint: SIGN_SUBKEY,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "secret-file-count");
});

test("a uid line ends the run of records belonging to the key above it", () => {
  // Without that rule the fingerprint under the uid would be adopted by the primary, and every
  // fingerprint comparison in this module would be comparing the wrong pair.
  const records = parseKeyListing(SUBKEY_ONLY);
  assert.equal(records.find((record) => record.type === "sec").fingerprint, PRIMARY);
  assert.equal(records.find((record) => record.type === "ssb").fingerprint, SIGN_SUBKEY);
  assert.equal(records.find((record) => record.type === "sec").secret, "#");
  assert.equal(records.find((record) => record.type === "ssb").secret, "+");
});

test("picks the signing subkey and ignores the encryption one", () => {
  const chosen = chooseSigningSubkey(parseKeyListing(FULL_EXPORT));
  assert.equal(chosen.ok, true);
  assert.equal(chosen.fingerprint, SIGN_SUBKEY);
});

test("refuses to choose between two usable signing subkeys", () => {
  const second = "0E93FA86EADDDA31224B3254EFB090058EAA7780";
  const listing = `${SUBKEY_ONLY}ssb:-:255:22:224B3254EFB09005:1786460827:1817996827:::::s:::+::ed25519::
fpr:::::::::${second}:
`;
  const chosen = chooseSigningSubkey(parseKeyListing(listing));
  assert.equal(chosen.ok, false);
  assert.equal(chosen.reason, "ambiguous-signing-subkey");
  assert.match(chosen.summary, /--subkey/u);
});

test("does not offer an expired signing subkey", () => {
  const expired = SUBKEY_ONLY.replace(
    "ssb:-:255:22:BC7CA58B3B94EACF",
    "ssb:e:255:22:BC7CA58B3B94EACF",
  );
  const chosen = chooseSigningSubkey(parseKeyListing(expired));
  assert.equal(chosen.ok, false);
  assert.equal(chosen.reason, "no-signing-subkey");
  assert.match(chosen.summary, /expired or revoked/u);
});

/*
The classifier, against status output recorded from both operations. These are the lines that tell
"the passphrase is wrong" from "the bundle is wrong" — the distinction three CI runs were spent
failing to make, because on the runner's preset-then-sign path both produce the same sentence.
*/
test("names a wrong passphrase from the sign path", () => {
  const cause = classifyPassphraseFailure({
    statusText: `[GNUPG:] KEY_CONSIDERED ${PRIMARY} 0
[GNUPG:] BEGIN_SIGNING H10
[GNUPG:] FAILURE sign 67108875
`,
    stderr: "gpg: signing failed: Bad passphrase\n",
  });
  assert.equal(cause.reason, "wrong-passphrase");
  assert.equal(cause.half, "passphrase");
});

test("names a wrong passphrase from the export path, past the generic FAILURE beside it", () => {
  // The export emits a specific `ERROR export_keys.secret 67108875` *and* a generic
  // `FAILURE gpg-exit 33554433`. Taking the first FAILURE line would classify this as "other",
  // which is the answer that helps nobody.
  const cause = classifyPassphraseFailure({
    statusText: `[GNUPG:] EXPORTED ${PRIMARY}
[GNUPG:] KEY_CONSIDERED ${PRIMARY} 0
[GNUPG:] ERROR export_keys.secret 67108875
[GNUPG:] EXPORT_RES 1 1 1
[GNUPG:] FAILURE gpg-exit 33554433
`,
    stderr: "gpg: key BDFD8118166D978F743C1EA5F5E572F62853F734: error receiving key from agent: Bad passphrase - skipped\n",
  });
  assert.equal(cause.reason, "wrong-passphrase");
});

test("tells an empty passphrase from a wrong one", () => {
  const cause = classifyPassphraseFailure({
    statusText: `[GNUPG:] BEGIN_SIGNING H10
[GNUPG:] FAILURE sign 67109041
`,
    stderr: "gpg: signing failed: No passphrase given\n",
  });
  assert.equal(cause.reason, "empty-passphrase");
});

test("does not read a passphrase failure into an unrelated one", () => {
  const cause = classifyPassphraseFailure({
    statusText: "[GNUPG:] FAILURE gpg-exit 33554433\n",
    stderr: "gpg: no default secret key: No secret key\n",
  });
  assert.equal(cause.reason, "other");
  assert.equal(cause.half, "unknown");
});

test("says so when the passphrase never reached gpg at all", () => {
  // Distinguishing this from a wrong passphrase matters: it is a bug in the script's own
  // plumbing, and telling the operator to check their passphrase would send them somewhere there
  // is nothing to find.
  const cause = classifyPassphraseFailure({
    statusText: `[GNUPG:] NEED_PASSPHRASE 201C5C10B61693BD 201C5C10B61693BD 22 0
[GNUPG:] INQUIRE_MAXLEN 100
`,
    stderr: "gpg: Sorry, we are in batchmode - can't get input\n",
  });
  assert.equal(cause.reason, "passphrase-not-delivered");
  assert.equal(cause.half, "script");
});
