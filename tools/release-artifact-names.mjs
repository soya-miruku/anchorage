/**
 * What a release publishes, and what its checksum list therefore covers, decided in one place.
 *
 * A checksum line is a claim about a name as much as about a digest, and the two halves used to be
 * decided by different programs. tools/sign-release.mjs wrote SHA256SUMS covering
 * `release-verification.json`; the next step in the release workflow renamed that file to
 * `release-verification-<arch>.json`, which is the only name uploaded and the only name README.md
 * documents. Every published checksum list therefore ended in a line naming a file the release did
 * not contain. `sha256sum -c` answers that with "FAILED open or read" and a non-zero exit, so the
 * publish job's own verification failed on it and no release was ever created — and had that step
 * not been there, a downloader following the README would have met the same failure over a
 * perfectly good release.
 *
 * So the two halves are one decision now: the program that writes the list is the program that
 * names the files, and the workflow renames nothing afterwards. Everything below is a decision
 * about names, taking a directory listing rather than reading one, so it can be tested without a
 * release directory and so a caller's own plumbing cannot change the answer.
 */

/*
Everything a downloader receives, and therefore everything that must be covered.

Listed explicitly rather than by "any file in the directory", so that adding a target is a
deliberate decision to sign it rather than something that happens silently — and so that a stray
file in the release directory cannot end up inside a signature. The inverse mistake has already
happened once: the deb, rpm and pacman targets shipped while this filter still named only the
AppImage, which left three of the four downloads uncovered by SHA256SUMS.
*/
export const SIGNED_INSTALLER_EXTENSIONS = Object.freeze([
  ".AppImage",
  ".deb",
  ".rpm",
  ".pacman",
]);

/*
An architecture ends up in a file name a downloader types, so it has to be a plain token rather
than whatever happened to follow --arch on the command line: `--arch --key` would otherwise
publish a file called `SHA256SUMS---key` and cover it under that name.
*/
export const ARCHITECTURE_TOKEN = /^[a-z0-9_]+$/u;

/**
 * The names a release publishes for one architecture, or the names packaging wrote when there is
 * no architecture to name them for.
 *
 * Eight installers can share one release; two files called SHA256SUMS cannot. So each
 * architecture's metadata carries its own name, which is also the more honest arrangement: a
 * checksum file signed by a machine should cover what that machine actually built. The installers
 * already carry their architecture in the name electron-builder gave them and are left alone;
 * only these four collide.
 *
 * The architecture is omitted locally, where one machine builds one architecture and nothing
 * collides: the names stay as packaging wrote them, which is what the rest of the repository
 * documents for a local build.
 */
export function publishedNames(architecture) {
  const suffix = architecture ? `-${architecture}` : "";
  return {
    checksums: `SHA256SUMS${suffix}`,
    signature: `SHA256SUMS${suffix}.asc`,
    signingReceipt: `release-signature${suffix}.json`,
    verificationReport: `release-verification${suffix}.json`,
  };
}

/**
 * The renames that turn a freshly packaged release directory into the one that is published.
 *
 * Only packaging's verification report needs one: the other three files are written by
 * sign-release.mjs, which writes them under their published names to begin with. It happens
 * before anything hashes the report, because a digest recorded against one name and published
 * under another is the failure this module exists to prevent.
 *
 * Nothing to do when the report already carries the architecture — a second run over the same
 * directory, or `--verify-only` — so this is safe to repeat.
 */
export function publicationRenames(entryNames, architecture) {
  if (!architecture) return [];
  const published = publishedNames(architecture).verificationReport;
  const packaged = publishedNames(undefined).verificationReport;
  if (entryNames.includes(published)) return [];
  if (!entryNames.includes(packaged)) return [];
  return [{ from: packaged, to: published }];
}

/**
 * Which files in the release directory the checksum list covers, given the listing *after* the
 * renames above have been applied.
 *
 * Every name returned is both a name the release publishes and a file that is there. Those are
 * the same question and were answered separately once, which is the whole history at the top of
 * this file.
 *
 * Not the checksum file or its signature: a list cannot list itself, and a signature over the list
 * cannot be inside it.
 */
export function coverableArtifacts(entryNames, architecture) {
  const published = publishedNames(architecture);
  const covered = entryNames
    .filter(
      (name) =>
        SIGNED_INSTALLER_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
        name === published.verificationReport ||
        name === "latest-linux.yml",
    )
    .sort();
  if (!covered.some((name) => name.endsWith(".AppImage"))) {
    return {
      ok: false,
      reason: "no-appimage",
      summary: "No AppImage found to sign; build a release before signing it.",
    };
  }
  if (!covered.includes(published.verificationReport)) {
    return {
      ok: false,
      reason: "no-verification-report",
      summary:
        `No ${published.verificationReport} beside the installers. A packaged build is a ` +
        `release candidate only once packaging has written its verification report, and a ` +
        `checksum list that quietly omitted it would leave the release's own evidence ` +
        `uncovered. Build one with: npm --prefix app run package:linux`,
    };
  }
  return { ok: true, names: covered };
}
