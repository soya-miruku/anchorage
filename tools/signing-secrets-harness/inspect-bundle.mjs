// Imports whatever the stub gh was given as GPG_PRIVATE_KEY into a keyring that has never seen
// it, and reports what a runner holding it could do. This is the end-to-end form of the claim the
// script makes locally: subkey-only, and the encryption subkey left behind.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , bundlePath, primary, signSubkey, encrSubkey] = process.argv;
if (!existsSync(bundlePath)) {
  console.log(`  ${bundlePath} does not exist -- nothing was uploaded`);
  process.exit(0);
}

function gpg(args, { home, stdin, passphrase } = {}) {
  return new Promise((res) => {
    const c = spawn("gpg", ["--batch", "--no-tty", "--pinentry-mode", "loopback", ...(passphrase !== undefined ? ["--passphrase-fd", "3"] : []), ...args], {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: { ...process.env, GNUPGHOME: home },
    });
    const o = [], e = [];
    c.stdout.on("data", (d) => o.push(d));
    c.stderr.on("data", (d) => e.push(d));
    if (passphrase !== undefined) c.stdio[3].end(passphrase); else c.stdio[3].end();
    if (stdin !== undefined) c.stdin.end(stdin); else c.stdin.end();
    c.on("close", (code) => res({ code, stdout: Buffer.concat(o).toString(), stderr: Buffer.concat(e).toString() }));
  });
}

const home = mkdtempSync("/run/user/0/inspect.");
writeFileSync(join(home, "gpg-agent.conf"), "allow-loopback-pinentry\n");
const bundle = readFileSync(bundlePath);
const imported = await gpg(["--import"], { home, stdin: bundle });
console.log(`  import exit ${imported.code}`);

const listing = await gpg(["--with-colons", "--with-secret", "--list-secret-keys"], { home });
let owner = null;
for (const line of listing.stdout.split("\n")) {
  const f = line.split(":");
  if (f[0] === "sec" || f[0] === "ssb") owner = { type: f[0], caps: f[11], secret: f[14] };
  else if (f[0] === "fpr" && owner) {
    const which =
      f[9] === primary ? "PRIMARY" : f[9] === signSubkey ? "SIGN SUBKEY" : f[9] === encrSubkey ? "ENCRYPTION SUBKEY" : "?";
    console.log(
      `  ${owner.type}  field15=${JSON.stringify(owner.secret)}  caps=${owner.caps}  ${which}  ${f[9]}`,
    );
    owner = null;
  } else if (f[0] === "uid") owner = null;
}
console.log(`  files in private-keys-v1.d: ${readdirSync(join(home, "private-keys-v1.d")).length}`);

const pass = readFileSync(join(process.env.STUB_OUT ?? "/out", "secret.GPG_PASSPHRASE"));
writeFileSync(join(home, "f.txt"), "x\n");
const signed = await gpg(["--yes", "--local-user", primary, "--armor", "--detach-sign", "--output", join(home, "f.asc"), join(home, "f.txt")], { home, passphrase: pass });
console.log(`  can it sign with the uploaded passphrase?      exit ${signed.code} ${signed.code === 0 ? "(yes)" : "(no)"}`);

/*
Certification is tested against a genuinely foreign key, not against the identity itself.
`--quick-lsign-key <own primary>` exits 0 with "Key not changed so no update needed" — a no-op,
not a certification — and reading that exit status as "it could certify" is how this harness
first mis-measured the one property the whole layout exists for.
*/
const victim = mkdtempSync("/run/user/0/victim.");
writeFileSync(join(victim, "gpg-agent.conf"), "allow-loopback-pinentry\n");
await gpg(["--quick-generate-key", "Third Party <third@example.invalid>", "ed25519", "default", "1y"], { home: victim, passphrase: "x" });
const victimList = await gpg(["--with-colons", "--list-keys"], { home: victim });
const victimFpr = victimList.stdout.split("\n").find((l) => l.startsWith("fpr:")).split(":")[9];
const victimPub = await gpg(["--armor", "--export", victimFpr], { home: victim });
await gpg(["--import"], { home, stdin: victimPub.stdout });

for (const [label, args] of [
  ["vouch for a third party (exportable)  ", ["--quick-sign-key", victimFpr]],
  ["vouch for a third party (local)       ", ["--quick-lsign-key", victimFpr]],
  ["add a user id to the release identity ", ["--quick-add-uid", primary, "Impostor <i@example.invalid>"]],
  ["add another subkey                    ", ["--quick-add-key", primary, "ed25519", "sign", "1y"]],
  ["change the identity's expiry          ", ["--quick-set-expire", primary, "5y"]],
]) {
  const r = await gpg(["--yes", ...args], { home, passphrase: pass });
  console.log(`  can it ${label}  exit ${r.code}  ${r.code === 0 ? "" : "(no) "}${r.stderr.trim().split("\n").pop() ?? ""}`);
}
const checked = await gpg(["--with-colons", "--check-signatures", victimFpr], { home });
const certifications = checked.stdout.split("\n").filter((l) => l.startsWith("sig:") && !l.includes(victimFpr.slice(-16)));
console.log(`  certifications it managed to place on that key: ${certifications.length} (expect 0)`);
const uids = (await gpg(["--with-colons", "--list-keys", primary], { home })).stdout
  .split("\n").filter((l) => l.startsWith("uid:")).length;
console.log(`  user ids now on the release identity:          ${uids} (expect 1, unchanged)`);

const hasEncr = listing.stdout.split("\n").some((l) => l.startsWith("ssb") && l.split(":")[11]?.includes("e"));
console.log(`  does it carry the encryption subkey?           ${hasEncr ? "YES -- BAD" : "no"}`);

// The harness must leave nothing behind either, or the leftover check that follows it measures
// this file rather than the script. Same order the script itself uses and for the same reason:
// gpgconf resolves the agent through GNUPGHOME, so killing has to come before removing.
for (const disposable of [home, victim]) {
  spawnSync("gpgconf", ["--kill", "all"], {
    env: { ...process.env, GNUPGHOME: disposable },
    stdio: "ignore",
  });
  rmSync(disposable, { recursive: true, force: true });
}
const sockets = join(process.env.XDG_RUNTIME_DIR ?? "/run/user/0", "gnupg");
for (const entry of existsSync(sockets) ? readdirSync(sockets) : []) {
  if (entry.startsWith("d.")) rmSync(join(sockets, entry), { recursive: true, force: true });
}
