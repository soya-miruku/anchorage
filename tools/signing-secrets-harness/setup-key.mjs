// Builds a throwaway key shaped exactly like the real release key: a primary that can only
// certify, one signing subkey, one encryption subkey. The encryption subkey is what makes the
// missing-"!" case a real leak rather than a hypothetical one.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const HOME = process.env.GNUPGHOME;
const PASS = process.env.KEY_PASSPHRASE;

function gpg(args, passphrase) {
  return new Promise((res) => {
    const c = spawn("gpg", ["--batch", "--no-tty", "--pinentry-mode", "loopback", ...(passphrase !== undefined ? ["--passphrase-fd", "3"] : []), ...args], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: process.env,
    });
    const o = [], e = [];
    c.stdout.on("data", (d) => o.push(d));
    c.stderr.on("data", (d) => e.push(d));
    if (passphrase !== undefined) c.stdio[3].end(passphrase); else c.stdio[3].end();
    c.on("close", (code) => res({ code, stdout: Buffer.concat(o).toString(), stderr: Buffer.concat(e).toString() }));
  });
}

writeFileSync(`${HOME}/gpg-agent.conf`, "allow-loopback-pinentry\n");

let r = await gpg(["--quick-generate-key", "Harness Release Signing <harness@example.invalid>", "ed25519", "cert", "2y"], PASS);
if (r.code !== 0) { console.error(r.stderr); process.exit(1); }

const first = await gpg(["--with-colons", "--list-secret-keys"]);
const primary = first.stdout.split("\n").find((l) => l.startsWith("fpr:")).split(":")[9];

r = await gpg(["--quick-add-key", primary, "ed25519", "sign", "1y"], PASS);
if (r.code !== 0) { console.error(r.stderr); process.exit(1); }
r = await gpg(["--quick-add-key", primary, "cv25519", "encr", "1y"], PASS);
if (r.code !== 0) { console.error(r.stderr); process.exit(1); }

const listing = await gpg(["--with-colons", "--with-secret", "--list-secret-keys", primary]);
let caps = null, sign = null, encr = null;
for (const line of listing.stdout.split("\n")) {
  const f = line.split(":");
  if (f[0] === "ssb") caps = f[11];
  else if (f[0] === "fpr" && caps !== null) {
    if (caps.includes("s")) sign = f[9];
    if (caps.includes("e")) encr = f[9];
    caps = null;
  } else if (f[0] === "uid") caps = null;
}
console.log(`PRIMARY=${primary}`);
console.log(`SIGN_SUBKEY=${sign}`);
console.log(`ENCR_SUBKEY=${encr}`);
