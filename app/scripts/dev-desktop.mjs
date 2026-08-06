import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

import {
  createDevServerProof,
  parseDevPort,
  verifyDevServerOwnership,
} from "../electron/dev-server-proof.mjs";

const APP_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const VITE_ENTRY = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const MAIN_ENTRY = fileURLToPath(new URL("../electron/main.mjs", import.meta.url));

let vite = null;
let electron = null;
let shuttingDown = false;

function terminate(child, signal = "SIGTERM") {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
}

async function waitForRenderer(child, proof, rendererUrl) {
  let startupError = null;
  child.once("error", (error) => {
    startupError = error;
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (startupError) {
      throw startupError;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Vite exited before the renderer became available");
    }
    try {
      if (await verifyDevServerOwnership(rendererUrl, proof)) {
        await delay(75);
        if (
          child.exitCode === null &&
          child.signalCode === null &&
          (await verifyDevServerOwnership(rendererUrl, proof))
        ) {
          return;
        }
      }
    } catch {
      // Vite is still starting.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the Vite renderer");
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  terminate(electron);
  terminate(vite);
  await delay(100);
  terminate(electron, "SIGKILL");
  terminate(vite, "SIGKILL");
  process.exitCode = exitCode;
}

/**
 * Whether something is already listening on the dev port.
 *
 * Vite runs with `--strictPort`, deliberately: a renderer that silently moves to 5174 while the
 * Electron main process is still told 5173 fails later and less clearly. But the failure it
 * produces is three lines long and the only one carrying this script's own prefix — the line
 * anyone actually reads — says "Vite exited before the renderer became available", which
 * describes a crash. Reported as "bun run dev:desktop is not showing the desktop app anymore",
 * and it was a session from twenty minutes earlier still holding the port.
 */
export function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

async function main() {
  const developmentPort = parseDevPort(process.env.ANCHORAGE_DEV_PORT);
  const rendererUrl = `http://127.0.0.1:${developmentPort}/`;
  const proof = createDevServerProof();

  if (await portInUse(developmentPort)) {
    throw new Error(
      `Port ${developmentPort} is already in use, which is almost always an earlier ` +
        `\`dev:desktop\` still running — its window may be on another workspace, or its ` +
        `Electron process may have outlived the window. Stop it and try again:\n` +
        `    pkill -f 'electron/dist/electron .*anchorage'\n` +
        `    pkill -f 'vite/bin/vite.js .*--port ${developmentPort}'\n` +
        `Or set ANCHORAGE_DEV_PORT to run a second one alongside it.`,
    );
  }

  vite = spawn(
    process.execPath,
    [
      VITE_ENTRY,
      "--host",
      "127.0.0.1",
      "--port",
      String(developmentPort),
      "--strictPort",
    ],
    {
      cwd: APP_DIRECTORY,
      env: {
        ...process.env,
        ANCHORAGE_DEV_PORT: String(developmentPort),
        ANCHORAGE_VITE_HEALTH_TOKEN: proof.token,
      },
      shell: false,
      stdio: "inherit",
    },
  );

  await waitForRenderer(vite, proof, rendererUrl);
  if (vite.exitCode !== null || vite.signalCode !== null) {
    throw new Error("The spawned Vite process exited before Electron launch");
  }

  electron = spawn(electronPath, [MAIN_ENTRY], {
    cwd: APP_DIRECTORY,
    env: {
      ...process.env,
      ANCHORAGE_DEV_PORT: String(developmentPort),
      ANCHORAGE_RENDERER_URL: rendererUrl,
    },
    shell: false,
    stdio: "inherit",
  });

  electron.once("exit", (code, signal) => {
    void shutdown(signal ? 1 : (code ?? 0));
  });
  electron.once("error", (error) => {
    console.error(`[anchorage] Could not start Electron: ${error.message}`);
    void shutdown(1);
  });
}

// Only when run, never when imported. `portInUse` is exported so it can be tested against a
// real listening socket, and a module that starts Vite as a side effect of being imported would
// make that test spawn a dev server.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void shutdown(0);
    });
  }

  main().catch((error) => {
    console.error(`[anchorage] Desktop development startup failed: ${error.message}`);
    void shutdown(1);
  });
}
