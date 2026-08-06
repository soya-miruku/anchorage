import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Where a project lives on disk, opened in the operator's own file manager.
 *
 * This is the first thing in Anchorage that hands a filesystem path to the OS, so what it will
 * *not* do matters more than what it will. It reveals — `shell.showItemInFolder`, which opens a
 * file manager with the item selected — and never opens. `shell.openPath` would launch whatever
 * handler the desktop has registered for that file type, which for a compose file is usually an
 * editor and for anything else is arbitrary program execution driven by a string that originally
 * came from a Docker daemon.
 *
 * The path is checked rather than trusted. Compose reports config file paths, and a daemon on a
 * remote or untrusted context reports paths this machine never chose.
 */
export function validateRevealPath(candidate, { stat = lstatSync } = {}) {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    const error = new Error("A path is required");
    error.code = "REVEAL_PATH_REQUIRED";
    throw error;
  }
  const target = candidate.trim();
  if (target.includes("\0")) {
    const error = new Error("A path may not contain a null byte");
    error.code = "REVEAL_PATH_INVALID";
    throw error;
  }
  if (!isAbsolute(target)) {
    // A relative path would resolve against whatever the main process's cwd happens to be,
    // which is not a location the operator asked about.
    const error = new Error("Only an absolute path can be revealed");
    error.code = "REVEAL_PATH_NOT_ABSOLUTE";
    throw error;
  }
  const normalised = resolve(target);
  /*
   * lstat, not stat: the decision is about the path the operator named rather than wherever it
   * points. Following the link refused the one case this is most needed for — a plugin entry
   * that is a symlink whose target a package manager deleted reported "That path does not exist
   * on this machine" while sitting plainly in the directory the operator was trying to open.
   *
   * It is also the safer of the two. Deciding on the link itself means a symlink cannot lead the
   * type check somewhere else; and revealing selects an item in a file manager rather than
   * opening it, so a link to a device is shown, never followed.
   */
  let info;
  try {
    info = stat(normalised);
  } catch {
    const error = new Error("That path does not exist on this machine");
    error.code = "REVEAL_PATH_MISSING";
    throw error;
  }
  if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) {
    // A socket, device or FIFO is not something a file manager can usefully show, and asking
    // the desktop to open one is a good way to find out what it does instead.
    const error = new Error("Only a file or directory can be revealed");
    error.code = "REVEAL_PATH_UNSUPPORTED";
    throw error;
  }
  return normalised;
}
