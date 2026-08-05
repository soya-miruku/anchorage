import { readFileSync } from "node:fs";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { DESKTOP_HEALTH_PATH } from "./electron/dev-server-proof.mjs";

// The titlebar states the running version. Reading it from the manifest is the only way
// it cannot drift from what was actually packaged.
const { version: anchorageVersion } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

const desktopHealthToken = process.env.ANCHORAGE_VITE_HEALTH_TOKEN;
const desktopHealthPlugin =
  desktopHealthToken && /^[a-f0-9]{64}$/u.test(desktopHealthToken)
    ? {
        name: "anchorage-desktop-health",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            const requestPath = request.url?.split("?", 1)[0];
            if (request.method !== "GET" || requestPath !== DESKTOP_HEALTH_PATH) {
              next();
              return;
            }
            response.statusCode = 200;
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Content-Type", "text/plain; charset=utf-8");
            response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
            response.setHeader("X-Anchorage-Dev-Server", desktopHealthToken);
            response.end(desktopHealthToken);
          });
        },
      }
    : null;
const developmentCspPlugin = {
  name: "anchorage-development-csp",
  apply: "serve",
  transformIndexHtml(html) {
    return html
      .replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
      .replace(
        "connect-src 'self';",
        "connect-src 'self' ws://127.0.0.1:* ws://localhost:*;",
      );
  },
};

export default defineConfig({
  base: "./",
  define: {
    __ANCHORAGE_VERSION__: JSON.stringify(anchorageVersion),
  },
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [desktopHealthPlugin, developmentCspPlugin, react()].filter(Boolean),
});
