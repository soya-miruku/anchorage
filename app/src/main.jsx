import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import { App } from "./App.tsx";
import {
  applyDesignCaptureMode,
  initializeAppearance,
} from "./theme/appearance.ts";
import "./styles/tokens.css";
import "./styles/themes/index.css";
import "./styles/global.css";
import "./styles/shell.css";
import "./styles/containers.css";
import "./styles/detail.css";
import "./styles/workspace.css";
import "./styles/dashboard.css";
import "./styles/resources.css";
import "./styles/builds.css";
import "./styles/scan.css";
import "./styles/development.css";
import "./styles/models.css";
import "./styles/settings.css";
import "./styles/states.css";
import "./styles/command-center.css";

initializeAppearance();
// Must run before first paint so no frame is ever captured mid-animation.
applyDesignCaptureMode(window.location.search);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
