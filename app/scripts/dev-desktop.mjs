import { spawn } from "node:child_process";
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

async function main() {
  const developmentPort = parseDevPort(process.env.ANCHORAGE_DEV_PORT);
  const rendererUrl = `http://127.0.0.1:${developmentPort}/`;
  const proof = createDevServerProof();
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

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(0);
  });
}

main().catch((error) => {
  console.error(`[anchorage] Desktop development startup failed: ${error.message}`);
  void shutdown(1);
});
