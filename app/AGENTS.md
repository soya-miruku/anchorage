# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Durable appearance decisions

- Keep the original Anchorage palette as the `Default` theme.
- Offer `Default`, `Docker`, and `GitHub` theme families, each with explicit `Light` and `Dark` modes, from Settings.
- Treat theme colors as semantic tokens and persist the selected family and mode locally.
- In the real browser/Electron surface, the application fills and resizes with the viewport; the blue presentation desk is not part of the native app window.
- Preserve the fixed 1656 × 1056 presentation desk only for deterministic `?capture=...` design-parity fixtures.
