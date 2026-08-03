import {
  accessSync,
  constants,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, parse, resolve } from "node:path";

function invalidPolicy(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "INVALID_CORE_LAUNCH_POLICY";
  return error;
}

export function resolveCoreLaunchPolicy({
  platform = process.platform,
  environment = process.env,
} = {}) {
  const variable = platform === "win32" ? "USERPROFILE" : "HOME";
  const raw = environment?.[variable];
  if (typeof raw !== "string" || raw.length === 0) {
    throw invalidPolicy(`${variable} must identify the current user's home directory`);
  }
  if (raw.includes("\u0000") || raw !== raw.trim() || !isAbsolute(raw)) {
    throw invalidPolicy(`${variable} must be a clean absolute path`);
  }

  let canonical;
  let info;
  try {
    canonical = realpathSync(resolve(raw));
    info = statSync(canonical);
    accessSync(canonical, constants.R_OK | constants.X_OK);
  } catch (error) {
    throw invalidPolicy(`${variable} must identify an accessible existing directory`, error);
  }
  if (!info.isDirectory()) {
    throw invalidPolicy(`${variable} must identify a directory`);
  }
  if (canonical === parse(canonical).root) {
    throw invalidPolicy(`${variable} must not resolve to a filesystem root`);
  }

  const filesystemRoot = parse(canonical).root;
  try {
    const rootInfo = statSync(filesystemRoot);
    accessSync(filesystemRoot, constants.X_OK);
    if (!rootInfo.isDirectory()) {
      throw new Error("filesystem root is not a directory");
    }
  } catch (error) {
    throw invalidPolicy(
      "The current user's filesystem root must be an accessible directory",
      error,
    );
  }

  return Object.freeze({
    allowedCwdRoot: filesystemRoot,
    cwd: canonical,
    args: Object.freeze(["--allow-cwd", filesystemRoot]),
  });
}
