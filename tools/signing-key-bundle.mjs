/**
 * What a CI signing bundle must look like, and which half of the pair is wrong when it does not.
 *
 * `GPG_PRIVATE_KEY` is a signing-subkey-only export. The property that makes handing it to a
 * public runner acceptable is that it *cannot certify* — the primary travels as a stub with no
 * secret, so a compromised runner signs artifacts and cannot add a user id, cannot add a subkey
 * and cannot vouch for anyone as the release identity. That property is worth establishing rather
 * than assuming, because the one command that produces it and the one command that produces a
 * full export differ by a single word, both succeed, and both import cleanly.
 *
 * So the decisions live here, away from the process plumbing, for the same reason
 * tools/verify-detached-signature.mjs does: they can then be tested against gpg output that was
 * recorded rather than re-created, including the shapes it takes work to produce on purpose.
 *
 * Everything below reads gpg's `--with-colons` listing, never its human output and never the
 * armour. The armour is a base64 blob whose meaning is exactly "what gpg makes of it after
 * import", and the imported keyring is the thing the runner will actually hold. The field numbers
 * are gpg's own, documented in doc/DETAILS; the two that carry this module's weight are:
 *
 *   field 12  capabilities — lowercase for this key, uppercase for the whole key's aggregate.
 *             `s` means this key can sign, `e` encrypt, `c` certify.
 *   field 15  `#` when the record is a stub with no secret (GnuPG's internal protect mode 1001),
 *             `>` when the secret is on a token, `+` when a secret is present. `sec#` in the
 *             human listing is this field. It is the whole subkey-only test.
 */

/** libgpg-error packs a source in the top byte and a code in the low three. */
const GPG_ERR_CODE_MASK = 0xffffff;
const GPG_ERR_BAD_PASSPHRASE = 11;
const GPG_ERR_NO_PASSPHRASE = 177;

/**
 * gpg's colon listing, folded so that each key record carries the `fpr` and `grp` lines that
 * follow it.
 *
 * Those lines are separate records that belong to whatever key preceded them, which is the one
 * detail of the format that makes a naive line-by-line reader wrong: a listing with three keys
 * has three fingerprints in it, and taking "the first fpr" gives the primary's regardless of
 * which key was being examined.
 */
export function parseKeyListing(stdout) {
  const records = [];
  let current;
  for (const line of String(stdout).split("\n")) {
    const fields = line.split(":");
    const type = fields[0];
    if (type === "sec" || type === "pub" || type === "ssb" || type === "sub") {
      current = {
        type,
        validity: fields[1] ?? "",
        keyId: fields[4] ?? "",
        created: fields[5] ?? "",
        expires: fields[6] ?? "",
        capabilities: fields[11] ?? "",
        secret: fields[14] ?? "",
        fingerprint: undefined,
        keygrip: undefined,
      };
      records.push(current);
      continue;
    }
    if (!current) continue;
    if (type === "fpr" && !current.fingerprint) current.fingerprint = fields[9] ?? "";
    if (type === "grp" && !current.keygrip) current.keygrip = fields[9] ?? "";
    // A uid record ends the run of lines that belong to the key above it; anything after it
    // belongs to the next key record. Without this, a `fpr` under a uid would be adopted by the
    // primary.
    if (type === "uid" || type === "uat") current = undefined;
  }
  return records;
}

/** `e` expired, `r` revoked, `i` invalid, `d` disabled — none of which can make a signature. */
const UNUSABLE_VALIDITY = new Set(["e", "r", "i", "d"]);

/**
 * Which subkey CI should be given, derived from the primary rather than remembered.
 *
 * Remembering it is how a rotation ships the wrong key: the fingerprint in a runbook keeps
 * pointing at the subkey that expired last year, the export succeeds, and the mismatch only
 * surfaces as a signature nobody can verify. Deriving it means the answer changes when the key
 * does. Ambiguity is refused rather than resolved, because guessing which of two signing subkeys
 * a release will use reintroduces exactly the silent mismatch this avoids.
 */
export function chooseSigningSubkey(records) {
  const candidates = records.filter(
    (record) =>
      (record.type === "ssb" || record.type === "sub") &&
      record.capabilities.includes("s") &&
      !UNUSABLE_VALIDITY.has(record.validity),
  );
  if (candidates.length === 0) {
    const expired = records.filter(
      (record) =>
        (record.type === "ssb" || record.type === "sub") &&
        record.capabilities.includes("s"),
    );
    return {
      ok: false,
      reason: "no-signing-subkey",
      summary: expired.length
        ? `This key's only signing subkeys are unusable (expired or revoked): ` +
          `${expired.map((record) => record.fingerprint).join(", ")}. Add a fresh one with ` +
          `gpg --quick-add-key <primary> ed25519 sign 1y`
        : "This key has no signing subkey. CI must never hold the primary, so add one with " +
          "gpg --quick-add-key <primary> ed25519 sign 1y",
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: "ambiguous-signing-subkey",
      summary:
        `This key has ${candidates.length} usable signing subkeys, and which one a release ` +
        `signs with is gpg's choice rather than this script's. Name the one CI should hold ` +
        `with --subkey:\n  ${candidates.map((record) => record.fingerprint).join("\n  ")}`,
    };
  }
  return { ok: true, ...candidates[0] };
}

/**
 * Judges an exported bundle by what it becomes once imported: is the primary's secret absent, is
 * exactly the intended signing subkey present, and is nothing else along for the ride.
 *
 * The third question is the one that is easy to leave out, and it is the honest reason
 * `--export-secret-subkeys <fpr>!` is written with the `!`. The bang does not keep the primary
 * out — `--export-secret-subkeys` never exports the primary secret, with or without it. What the
 * bang keeps out is *every other subkey*, and for this key that means the encryption subkey.
 * Measured on gpg 2.4.7 with a primary plus one signing and one encryption subkey: with the bang,
 * one file in private-keys-v1.d; without it, two, the second being the key that decrypts
 * everything ever encrypted to the operator. A bundle that signs correctly and quietly carries
 * that as well would pass every other check here.
 *
 * `secretKeyFileCount` is `private-keys-v1.d`'s entry count, which is the same fact counted a
 * second way — gpg's own on-disk answer to "how many secrets did that import actually land",
 * independent of how the listing is parsed. It is also the count the release workflow prints, so
 * a disagreement between the two is legible.
 */
export function judgeExportedBundle({
  records,
  secretKeyFileCount,
  expectedPrimaryFingerprint,
  expectedSubkeyFingerprint,
}) {
  const primaries = records.filter((record) => record.type === "sec");
  if (primaries.length === 0) {
    return {
      ok: false,
      reason: "no-secret-key",
      summary:
        "The bundle carries no secret key at all — gpg imported it and found only public " +
        "material. A gpg export that fails on a bad passphrase still writes a few hundred bytes " +
        "of valid armour containing just the stub, so this is what a mistyped passphrase " +
        "produces if the export's exit status went unchecked.",
    };
  }
  if (primaries.length > 1) {
    return {
      ok: false,
      reason: "multiple-primaries",
      summary:
        `The bundle carries ${primaries.length} primary keys. CI is given one signing identity; ` +
        `a bundle with several means the export selected more than was asked for.`,
    };
  }
  const [primary] = primaries;
  if (primary.secret !== "#") {
    return {
      ok: false,
      reason: "primary-secret-present",
      summary:
        `The bundle carries the PRIMARY key's secret (field 15 is ${JSON.stringify(primary.secret)}, ` +
        `and a stub is "#"). Uploading it would let anything that reads this repository's secrets ` +
        `certify keys as ${primary.fingerprint} — add user ids, vouch for other keys, revoke. ` +
        `Nothing was uploaded. Export with --export-secret-subkeys, not --export-secret-keys.`,
    };
  }
  if (expectedPrimaryFingerprint && primary.fingerprint !== expectedPrimaryFingerprint) {
    return {
      ok: false,
      reason: "primary-mismatch",
      summary:
        `The bundle's primary is ${primary.fingerprint}, not the requested ` +
        `${expectedPrimaryFingerprint}.`,
    };
  }

  const withSecret = records.filter(
    (record) => record.type === "ssb" && record.secret !== "#" && record.secret !== "",
  );
  const signing = withSecret.filter((record) => record.capabilities.includes("s"));
  if (signing.length === 0) {
    return {
      ok: false,
      reason: "no-signing-secret",
      summary:
        "The bundle's primary is a stub, as it should be, but no signing subkey secret came " +
        "with it. There is nothing here that can sign a release.",
    };
  }
  const extras = withSecret.filter((record) => !signing.includes(record));
  if (extras.length > 0) {
    return {
      ok: false,
      reason: "extra-secrets",
      summary:
        `The bundle carries ${extras.length} subkey secret(s) beyond the signing key: ` +
        `${extras.map((record) => `${record.fingerprint} (${record.capabilities})`).join(", ")}. ` +
        `An encryption subkey here would let a compromised runner decrypt everything ever ` +
        `encrypted to this identity. Export the one subkey with a trailing "!": ` +
        `--export-secret-subkeys <fpr>!`,
    };
  }
  if (signing.length > 1) {
    return {
      ok: false,
      reason: "multiple-signing-secrets",
      summary:
        `The bundle carries ${signing.length} signing subkey secrets: ` +
        `${signing.map((record) => record.fingerprint).join(", ")}. Which one signs would be ` +
        `gpg's choice on the runner rather than this script's.`,
    };
  }
  const [subkey] = signing;
  if (expectedSubkeyFingerprint && subkey.fingerprint !== expectedSubkeyFingerprint) {
    return {
      ok: false,
      reason: "subkey-mismatch",
      summary:
        `The bundle's signing subkey is ${subkey.fingerprint}, not the ` +
        `${expectedSubkeyFingerprint} that was exported.`,
    };
  }
  if (typeof secretKeyFileCount === "number" && secretKeyFileCount !== 1) {
    return {
      ok: false,
      reason: "secret-file-count",
      summary:
        `gpg landed ${secretKeyFileCount} secret key files for this bundle, not the one a ` +
        `subkey-only export produces. The listing and the keyring disagree about what was ` +
        `imported, and the keyring is what the runner would hold.`,
    };
  }
  return { ok: true, primary, subkey };
}

/**
 * Whether gpg refused because of the passphrase, read from its numeric status rather than its
 * sentence — and if so, which way.
 *
 * This is the whole point of the script. In the release job's arrangement — a passphrase preset
 * into gpg-agent, then a `--batch` signature — a *wrong* passphrase and a *missing* passphrase
 * produce the same single line ("Sorry, we are in batchmode - can't get input"), the same exit 2
 * and the same zero-byte signature. `keyinfo --list` separates "a preset happened" from "none
 * did", and nothing available on that path separates a right preset from a wrong one, because
 * gpg-preset-passphrase caches whatever it is handed and exits 0. Three release runs were spent
 * on failures that were indistinguishable from each other in the log.
 *
 * Supplying the passphrase through `--passphrase-fd` instead of the agent cache is what separates
 * them, because gpg then reports the cause as a number. libgpg-error packs the source in the top
 * byte and the code in the low three, so 67108875 is (GPG_ERR_SOURCE_GPGAGENT << 24) | 11, and 11
 * is GPG_ERR_BAD_PASSPHRASE; 67109041 is the same source with 177, GPG_ERR_NO_PASSPHRASE. The
 * integers are stable; "Bad passphrase" is prose and is translated, which this repository has
 * already been bitten by once — see the locale note in tools/verify-detached-signature.mjs.
 *
 * Both of the operations this script performs report through this shape, measured on gpg 2.4.7:
 *
 *   sign    exit 2, `[GNUPG:] FAILURE sign 67108875`
 *   export  exit 2, `[GNUPG:] ERROR export_keys.secret 67108875`, followed by a generic
 *           `FAILURE gpg-exit 33554433` — which is why the specific line is preferred over the
 *           first `FAILURE` on the stream, rather than simply taking whichever came last.
 *
 * Deliberately not keyed off a `BAD_PASSPHRASE` status line: gpg 2.4.7 emits that on decryption
 * paths and not on either of these, so a check written against it reports the trap as "some other
 * failure" — which is the one answer that helps nobody.
 *
 * The parameter is `statusText`, not `status`, and the difference is not cosmetic: everywhere
 * else in this repository `status` is gpg's exit code — see tools/sign-release.mjs and
 * judgeDetachedSignature. Naming the --status-fd stream `status` too meant a caller could hand
 * this function the exit code, get "other" for every failure, and see nothing wrong. That is not
 * hypothetical; it happened on the first run of the test below, and the symptom was the script
 * refusing to upload a perfectly good pair because its own negative control looked inexplicable.
 */
export function classifyPassphraseFailure({ statusText = "", stderr = "" }) {
  const detail = `${statusText}${stderr}`.trim();
  const codes = String(statusText)
    .split("\n")
    .filter((line) => line.startsWith("[GNUPG:] "))
    .map((line) => line.slice("[GNUPG:] ".length).trim().split(/\s+/u))
    .filter((fields) => fields[0] === "ERROR" || fields[0] === "FAILURE")
    .map((fields) => Number.parseInt(fields[2] ?? "", 10))
    .filter((code) => Number.isFinite(code))
    .map((code) => code & GPG_ERR_CODE_MASK);

  if (codes.includes(GPG_ERR_BAD_PASSPHRASE)) {
    return {
      reason: "wrong-passphrase",
      half: "passphrase",
      summary:
        "The PASSPHRASE is wrong for this key. gpg-agent could not unlock it with what was " +
        "typed.\n\n" +
        "  Worth knowing, because it is the trap this script exists for: an exported bundle " +
        "keeps the passphrase the key held at export time. If the key's passphrase was changed " +
        "after the bundle currently in GitHub was made, that stored bundle still wants the OLD " +
        "one — and setting the new passphrase beside it fails in CI in a way that is " +
        "indistinguishable from setting no passphrase at all. Re-exporting and setting the " +
        "passphrase as one operation is what makes the pair provable, so what is wrong here is " +
        "the passphrase just typed, measured against the key as it is today.",
      detail,
    };
  }
  if (codes.includes(GPG_ERR_NO_PASSPHRASE)) {
    return {
      reason: "empty-passphrase",
      half: "passphrase",
      summary:
        "gpg was handed an empty passphrase. An empty value uploads to GitHub perfectly happily " +
        "and looks identical to a correct one in `gh secret list`, so it is refused here rather " +
        "than discovered there.",
      detail,
    };
  }
  if (String(statusText).includes("[GNUPG:] NEED_PASSPHRASE")) {
    return {
      reason: "passphrase-not-delivered",
      half: "script",
      summary:
        "gpg asked for a passphrase rather than being given one, so the passphrase never " +
        "reached it. That is a bug in this script's plumbing, not a wrong passphrase.",
      detail,
    };
  }
  return {
    reason: "other",
    half: "unknown",
    summary: "gpg refused, for a reason it did not attribute to the passphrase.",
    detail,
  };
}
