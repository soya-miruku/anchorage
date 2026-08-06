#!/usr/bin/env node
/*
 * Lifts the handoff's per-family token block into `app/scripts/handoff-tokens.json`.
 *
 * The comp itself is not in version control — it is a full 21-screen design document and is kept
 * out of the published repository deliberately (see `.gitignore`). The theme fidelity gate still
 * has to compare against it, so the part of it the gate actually reads is extracted here and
 * committed: colour tokens, which are already public verbatim in `app/src/styles/themes/*.css`,
 * so the snapshot discloses nothing the stylesheets do not.
 *
 * This is not a substitute for the comp on a machine that has one.
 * `theme-surface-contrast.test.mjs` re-extracts and diffs whenever the comp is present, so the
 * snapshot cannot silently drift away from the document it claims to be a copy of; on a clean
 * checkout it is the best available source and says so.
 *
 * Run after any handoff change:  node tools/extract-handoff-tokens.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
export const HANDOFF_PATH = "docs/design_handoff_anchorage/v2.5/Anchorage v2.dc.html";
export const SNAPSHOT_PATH = "app/scripts/handoff-tokens.json";

/**
 * Only the families the app ships. Y2K is in the comp and was removed from the product; carrying
 * its palette here would put a retired theme back into the repository by the side door.
 */
export const SHIPPED_FAMILIES = ["nous", "docker", "github", "mono", "magnetic"];

export function extractHandoffTokens(html) {
  const families = {};
  for (const [, family, mode, body] of html.matchAll(
    /\.anc\[data-theme="([a-z0-9]+)"\]\[data-mode="(dark|light)"\]\s*\{([^}]*)\}/gu,
  )) {
    if (!SHIPPED_FAMILIES.includes(family)) continue;
    const tokens = {};
    for (const [, name, value] of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;}]+)/gu)) {
      tokens[name] = value.trim();
    }
    families[`${family}/${mode}`] = Object.fromEntries(
      Object.entries(tokens).sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return Object.fromEntries(
    Object.entries(families).sort(([left], [right]) => left.localeCompare(right)),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const html = readFileSync(fileURLToPath(new URL(HANDOFF_PATH, root)), "utf8");
  const tokens = extractHandoffTokens(html);
  const combinations = Object.keys(tokens);
  if (combinations.length !== SHIPPED_FAMILIES.length * 2) {
    throw new Error(
      `expected ${SHIPPED_FAMILIES.length * 2} combinations, extracted ${combinations.length}: ${combinations.join(", ")}`,
    );
  }
  writeFileSync(
    fileURLToPath(new URL(SNAPSHOT_PATH, root)),
    `${JSON.stringify(tokens, null, 2)}\n`,
  );
  console.log(`${SNAPSHOT_PATH}: ${combinations.length} combinations`);
}
