import {
  accessSync,
  constants,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ELECTRON_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(ELECTRON_DIRECTORY, "..", "..");

function executableName(platform) {
  return platform === "win32" ? "anchorage-core.exe" : "anchorage-core";
}

function assertExecutableFile(candidate) {
  const resolved = realpathSync(candidate);
  const linkStats = lstatSync(candidate);
  const stats = statSync(resolved);

  if (linkStats.isSymbolicLink()) {
    throw new Error("ANCHORAGE_CORE_BINARY must not be a symbolic link");
  }
  if (!stats.isFile()) {
    throw new Error("ANCHORAGE_CORE_BINARY must reference a regular file");
  }
  accessSync(resolved, constants.X_OK);
  return resolved;
}

export function resolveCoreBinaryPath({
  isPackaged,
  resourcesPath,
  platform = process.platform,
  environment = process.env,
  repositoryRoot = REPOSITORY_ROOT,
  verifyOverride = true,
} = {}) {
  const name = executableName(platform);
  const override = environment.ANCHORAGE_CORE_BINARY?.trim();

  if (override && isPackaged) {
    throw new Error("ANCHORAGE_CORE_BINARY is disabled in packaged builds");
  }

  if (override) {
    if (override.includes("\u0000") || !isAbsolute(override)) {
      throw new Error("ANCHORAGE_CORE_BINARY must be an absolute path");
    }
    return verifyOverride ? assertExecutableFile(override) : resolve(override);
  }

  if (isPackaged) {
    if (!resourcesPath || !isAbsolute(resourcesPath)) {
      throw new Error("Electron resourcesPath must be absolute in packaged builds");
    }
    return join(resourcesPath, "core", name);
  }

  return join(repositoryRoot, "core", "bin", name);
}
