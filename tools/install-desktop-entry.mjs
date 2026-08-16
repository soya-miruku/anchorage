#!/usr/bin/env node
/**
 * Puts a built AppImage into the desktop's application list, so it appears in the dash with its
 * own icon and can be pinned to the dock.
 *
 * An AppImage is a single executable file, and running one is all it takes to use the app. What
 * running one does *not* do is tell the desktop that the app exists. GNOME builds the dash from
 * `.desktop` files under XDG data directories; a file nobody has told it about has no name, no
 * icon and nothing to pin. So a freshly built AppImage launches into a window with a generic
 * placeholder icon, and the dash entry disappears when it closes.
 *
 * The AppImage already carries everything needed to fix that — electron-builder puts a `.desktop`
 * file and a full `usr/share/icons/hicolor` tree inside it. This script takes what is already
 * there rather than inventing a second copy that could drift: it extracts the image, installs the
 * icons at the sizes they were built for, and writes the `.desktop` file with one line changed —
 * `Exec`, which has to name where the AppImage actually lives on this machine.
 *
 * `StartupWMClass` is what makes the running window match the launcher instead of appearing beside
 * it as a second, nameless entry. electron-builder.yml sets it to `anchorage` and Electron reports
 * the same class, so it is carried through unchanged and checked below rather than assumed.
 *
 * Usage:
 *   node tools/install-desktop-entry.mjs                       # newest AppImage in app/release
 *   node tools/install-desktop-entry.mjs --appimage <path>
 *   node tools/install-desktop-entry.mjs --remove
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "..");
const releaseDirectory = resolve(workspaceRoot, "app/release");

const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
const applicationsDirectory = join(dataHome, "applications");
const iconsRoot = join(dataHome, "icons/hicolor");
const entryName = "anchorage.desktop";
const entryPath = join(applicationsDirectory, entryName);

function fail(message) {
  process.stderr.write(`\nFAIL: ${message}\n`);
  process.exit(1);
}

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

/*
Refreshing the caches is best-effort on purpose. Both tools are optional on a modern desktop —
GNOME notices a new .desktop file on its own within a few seconds — so a missing binary should not
turn a successful install into a failure. It is still worth calling when present, because the
alternative is telling someone to log out.
*/
function refreshDesktopCaches() {
  const refreshed = [];
  for (const [command, args] of [
    ["update-desktop-database", [applicationsDirectory]],
    ["gtk-update-icon-cache", ["--force", "--quiet", iconsRoot]],
  ]) {
    const result = spawnSync(command, args, { stdio: "ignore" });
    if (result.status === 0) refreshed.push(command);
  }
  return refreshed;
}

if (process.argv.includes("--remove")) {
  const removed = [];
  if (existsSync(entryPath)) {
    rmSync(entryPath);
    removed.push(entryPath);
  }
  for (const size of existsSync(iconsRoot) ? readdirSync(iconsRoot) : []) {
    const icon = join(iconsRoot, size, "apps/anchorage.png");
    if (existsSync(icon)) {
      rmSync(icon);
      removed.push(icon);
    }
  }
  refreshDesktopCaches();
  console.log(
    removed.length === 0
      ? "Nothing to remove: no Anchorage desktop entry or icons were installed here."
      : `Removed:\n${removed.map((path) => `  ${path}`).join("\n")}\n\n` +
          "The AppImage itself is untouched — this only removes the desktop's record of it.",
  );
  process.exit(0);
}

/*
Default to the newest AppImage in app/release rather than requiring a path, because immediately
after a build that is the one the operator means. Newest by mtime, not by name: version strings do
not sort the way people expect, and a rebuild of the same version keeps its filename.
*/
let appImagePath = argument("--appimage");
if (!appImagePath) {
  const candidates = existsSync(releaseDirectory)
    ? readdirSync(releaseDirectory)
        .filter((name) => name.endsWith(".AppImage"))
        .map((name) => join(releaseDirectory, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  if (candidates.length === 0) {
    fail(
      `No .AppImage in ${releaseDirectory}.\n\n` +
        "  Build one first:  npm --prefix app run package:linux\n" +
        "  Or name one:      node tools/install-desktop-entry.mjs --appimage <path>",
    );
  }
  appImagePath = candidates[0];
}
appImagePath = resolve(appImagePath);
if (!existsSync(appImagePath)) fail(`No such file: ${appImagePath}`);

/*
An AppImage that is not executable cannot be launched by the desktop, and the failure is silent —
clicking the icon does nothing at all, with no error anywhere the user will see it. Fixing it here
is safe and saves a confusing half hour.
*/
const mode = statSync(appImagePath).mode;
if ((mode & 0o111) === 0) {
  chmodSync(appImagePath, mode | 0o755);
  console.log(`Made ${appImagePath} executable — the desktop cannot launch it otherwise.`);
}

const workspace = mkdtempSync(join(tmpdir(), "anchorage-desktop-"));
process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));

/*
`--appimage-extract` unpacks without mounting, so this works on machines with no FUSE — which is
most containers and an increasing number of desktops. Extracting a couple of paths rather than the
whole 120 MB image keeps it quick.
*/
const extract = spawnSync(appImagePath, ["--appimage-extract"], {
  cwd: workspace,
  encoding: "utf8",
  env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
});
if (extract.status !== 0) {
  fail(
    `Could not unpack ${appImagePath}.\n\n  ${(extract.stderr || extract.stdout || "").trim()}`,
  );
}

const unpacked = join(workspace, "squashfs-root");
if (!existsSync(unpacked)) fail(`${appImagePath} unpacked without producing squashfs-root.`);

const sourceEntryName = readdirSync(unpacked).find((name) => name.endsWith(".desktop"));
if (!sourceEntryName) {
  fail(
    `${appImagePath} carries no .desktop file, so there is nothing to install.\n\n` +
      "  That is a packaging problem rather than a problem here: electron-builder writes one from\n" +
      "  the `linux.desktop` block in app/electron-builder.yml.",
  );
}
const sourceEntry = readFileSync(join(unpacked, sourceEntryName), "utf8");

/*
Rewrite Exec, and only Exec. Everything else in the entry — the name, the categories that decide
where it files itself, the keywords the dash searches, StartupWMClass — was decided in
electron-builder.yml and reviewed there. Rewriting them here would fork that decision into a second
place, and the copy would be the one nobody remembers to update.

The %U is kept: it is how a file manager passes a path to the app, and dropping it silently breaks
"open with" for anyone who sets it up.
*/
const execLine = sourceEntry.split("\n").find((line) => line.startsWith("Exec="));
const execArguments = execLine?.includes("%U") ? " %U" : "";
const installedEntry = sourceEntry
  .split("\n")
  .map((line) => (line.startsWith("Exec=") ? `Exec="${appImagePath}"${execArguments}` : line))
  .join("\n");

mkdirSync(applicationsDirectory, { recursive: true });
writeFileSync(entryPath, installedEntry, { mode: 0o644 });

/*
Install into the sizes the icon theme actually indexes, which is not the same as the sizes the
image happens to ship.

The icon theme spec resolves a name by walking the directories listed in hicolor's `index.theme`,
and that list stops at 512x512 (plus scalable and symbolic). electron-builder writes the icon at
whatever resolution the source art was — here `1254x1254`, because `build/icon.png` is 1254px —
and a `1254x1254` directory appears in no index, so every lookup skips it. The first version of
this script copied the tree across faithfully and produced exactly that: a correct-looking install
whose icon nothing could find.

So the shipped sizes are used where they match a standard bucket, and the rest are rendered from
the largest available source. The dash, the dock, the window switcher and the notification tray
each ask for a different size; filling the range is what stops one of them scaling a 1254px PNG
down to 24px and looking soft while the others look fine.
*/
const STANDARD_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

/** Width from a PNG's IHDR, which is at a fixed offset — no decoder needed to size an icon. */
function pngWidth(path) {
  const header = readFileSync(path).subarray(0, 24);
  if (header.length < 24 || header.readUInt32BE(0) !== 0x89504e47) return 0;
  return header.readUInt32BE(16);
}

const candidates = [];
const iconSourceRoot = join(unpacked, "usr/share/icons/hicolor");
if (existsSync(iconSourceRoot)) {
  for (const size of readdirSync(iconSourceRoot)) {
    const source = join(iconSourceRoot, size, "apps");
    if (!existsSync(source)) continue;
    for (const iconName of readdirSync(source)) {
      const path = join(source, iconName);
      candidates.push({ path, width: pngWidth(path) });
    }
  }
}
// .DirIcon is the AppImage's own thumbnail and is always present, so there is always something to
// fall back to rather than leaving the entry iconless.
const dirIcon = join(unpacked, ".DirIcon");
if (candidates.length === 0 && existsSync(dirIcon)) {
  candidates.push({ path: dirIcon, width: pngWidth(dirIcon) });
}
if (candidates.length === 0) fail(`${appImagePath} carries no icon to install.`);

const largest = candidates.reduce((best, one) => (one.width > best.width ? one : best));
const resizer = ["magick", "convert"].find(
  (command) => spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0,
);

const installedIcons = [];
const missingSizes = [];
for (const size of STANDARD_ICON_SIZES) {
  const destination = join(iconsRoot, `${size}x${size}/apps`);
  mkdirSync(destination, { recursive: true });
  const target = join(destination, "anchorage.png");
  const exact = candidates.find((one) => one.width === size);
  if (exact) {
    copyFileSync(exact.path, target);
    installedIcons.push(`${size}x${size} (shipped)`);
    continue;
  }
  if (!resizer) {
    missingSizes.push(size);
    continue;
  }
  const rendered = spawnSync(
    resizer,
    [largest.path, "-resize", `${size}x${size}`, "-strip", target],
    { stdio: "ignore" },
  );
  if (rendered.status === 0) installedIcons.push(`${size}x${size} (from ${largest.width}px)`);
  else missingSizes.push(size);
}

/*
Without a resizer there is still a working install to be had: a PNG larger than the bucket it sits
in is scaled down by the toolkit at lookup time. It is softer than a properly rendered icon, which
is why it is the fallback rather than the plan, and why it says so.
*/
if (installedIcons.length === 0) {
  const destination = join(iconsRoot, "512x512/apps");
  mkdirSync(destination, { recursive: true });
  copyFileSync(largest.path, join(destination, "anchorage.png"));
  installedIcons.push(`512x512 (unresized ${largest.width}px — install imagemagick for sharp icons)`);
}

const refreshed = refreshDesktopCaches();

/*
Read back what is on disk rather than reporting what was intended. The whole point of this script
is that the desktop can find the app afterwards, and the cheapest way to be wrong about that is to
print a success message next to a file that was never written.
*/
const installed = readFileSync(entryPath, "utf8");
const installedExec = installed.split("\n").find((line) => line.startsWith("Exec="));
const windowClass = installed.split("\n").find((line) => line.startsWith("StartupWMClass="));
if (!installedExec?.includes(appImagePath)) {
  fail(`${entryPath} was written but its Exec line does not name ${appImagePath}.`);
}

console.log(
  [
    "",
    `Installed:  ${entryPath}`,
    `  ${installedExec}`,
    `  ${windowClass ?? "StartupWMClass= (absent — the running window may not match the launcher)"}`,
    `Icons:      ${installedIcons.length} installed under ${iconsRoot}`,
    ...installedIcons.map((icon) => `  ${icon}`),
    refreshed.length > 0
      ? `Refreshed:  ${refreshed.join(", ")}`
      : "Refreshed:  nothing — neither update-desktop-database nor gtk-update-icon-cache is installed.",
    "",
    "Anchorage should now appear in your applications list, with its icon. Search for it, launch",
    "it once, then right-click its dock entry and pin it.",
    "",
    `The entry points at ${appImagePath}, so moving or deleting that file breaks the launcher.`,
    "Re-run this after a rebuild that puts the AppImage somewhere else.",
    "",
  ].join("\n"),
);
