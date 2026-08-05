/**
 * Electron side of `tools/capture-design-reference.mjs`.
 *
 * Runs the comp in an offscreen window: the harness reloads the document 24 times, and a shown
 * window would put 24 GTK-decorated frames on the operator's desktop — which reads exactly like
 * the product regressing.
 */

const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const [, , COMP, OUTDIR, STATES_JSON] = process.argv;
const STATES = JSON.parse(STATES_JSON);

app.disableHardwareAcceleration();

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Clicks the outermost pointer-cursor element whose whole label is exactly `text`. */
const clickText = (text) => `(() => {
  const hits = [];
  for (const el of document.querySelectorAll('*')) {
    if (getComputedStyle(el).cursor !== 'pointer') continue;
    if ((el.innerText || '').trim().replace(/\\s+/g, ' ') === ${JSON.stringify(text)}) hits.push(el);
  }
  if (!hits.length) return 'MISS: ' + ${JSON.stringify(text)};
  // A nav row wraps its own label span; clicking the outer row is what a pointer would do.
  hits.reduce((a, b) => (a.contains(b) ? a : b)).click();
  return 'ok';
})()`;

/** Opens the first container row, which is what the build's capture harness also selects. */
const openFirstContainer = `(() => {
  const hits = [];
  for (const el of document.querySelectorAll('*')) {
    if (getComputedStyle(el).cursor !== 'pointer') continue;
    if ((el.innerText || '').trim().startsWith('api-gateway')) hits.push(el);
  }
  const outer = hits.filter((el, i) => !hits.some((o, j) => j !== i && o.contains(el)));
  if (!outer.length) return 'MISS: container row';
  outer[0].click();
  return 'ok';
})()`;

const typeSearch = (value) => `(() => {
  const input = document.querySelector('input[placeholder*="Search"]');
  if (!input) return 'MISS: search input';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`;

/**
 * Locates the first container row for a real mouseMove.
 *
 * Smallest match, not outermost: the table body also starts with `api-gateway` and contains
 * `node:20-alpine`, and its centre lands four rows down on a different container. And the move
 * has to be a real input event — CSS `:hover` ignores a synthetic MouseEvent, which captured an
 * unhovered row and labelled it hovered.
 */
const firstRowCentre = `(() => {
  const rows = [];
  for (const el of document.querySelectorAll('div')) {
    const t = (el.innerText || '').trim();
    if (t.startsWith('api-gateway') && t.includes('node:20-alpine')) rows.push(el);
  }
  if (!rows.length) return null;
  const row = rows.reduce((a, b) =>
    a.getBoundingClientRect().height <= b.getBoundingClientRect().height ? a : b);
  const r = row.getBoundingClientRect();
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    height: Math.round(r.height),
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1656,
    height: 1056,
    show: false,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });

  /**
   * Hold the appearance constant before capturing anything.
   *
   * The build's capture route locks Nous Dark, so the comp has to be pinned to the same thing or
   * the comparison measures a palette rather than a layout. v2.5 made this necessary: its
   * `pickTheme()` force-writes `anchorage.pack` and switches the stored theme to Y2K on first
   * run — the comp promoting its new family — so an unpinned capture came back in acid green on
   * near-black and every one of the 24 states measured ~0.21 against a build drawn in royal
   * blue. Seeding `pack` is what stops that promotion from running again on each load.
   */
  await win.loadFile(COMP);
  await sleep(1200);
  await win.webContents.executeJavaScript(`(() => {
    localStorage.setItem('anchorage.pack', 'y2k');
    localStorage.setItem('anchorage.theme', 'nous');
    localStorage.setItem('anchorage.mode', 'dark');
    localStorage.setItem('anchorage.corners', 'rounded');
    localStorage.setItem('anchorage.cornersSet', '1');
    return true;
  })()`);

  const report = [];
  for (const state of STATES) {
    await win.loadFile(COMP);
    await sleep(2600); // webfonts, first template pass, first tick

    const steps = [];
    if (state.openContainer) {
      steps.push(await win.webContents.executeJavaScript(openFirstContainer));
      await sleep(450);
    }
    for (const label of state.click ?? []) {
      steps.push(await win.webContents.executeJavaScript(clickText(label)));
      await sleep(450);
    }
    if (state.type !== undefined) {
      steps.push(await win.webContents.executeJavaScript(typeSearch(state.type)));
      await sleep(450);
    }
    if (state.hoverFirstContainerRow) {
      const at = await win.webContents.executeJavaScript(firstRowCentre);
      if (!at) {
        steps.push("MISS: hover target");
      } else {
        win.webContents.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y });
        steps.push(`hover ${at.x},${at.y} h=${at.height}`);
        await sleep(500);
      }
    }

    await sleep(700);
    const image = await win.webContents.capturePage();
    writeFileSync(resolve(OUTDIR, `${state.id}.png`), image.toPNG());
    report.push({ id: state.id, steps });
    process.stdout.write(`${state.id}\t${steps.join(", ") || "-"}\n`);
  }

  writeFileSync(
    resolve(OUTDIR, "capture-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  app.quit();
});
