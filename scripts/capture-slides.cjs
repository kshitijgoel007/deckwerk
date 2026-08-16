/**
 * Screenshot slides with the real presentation renderer.
 *
 * Run *by Electron*, not by node: `electron scripts/capture-slides.cjs <job.json>`.
 * The job file names an exported bundle (the same one "Export web…" produces,
 * running the same Player) and the slides to capture, so what lands in the PNG
 * is exactly what the projector shows rather than a second, drifting renderer.
 *
 * Plain CommonJS on purpose: Electron runs it directly, with no build step.
 */
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { app, BrowserWindow } = require('electron');

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { bundleDir, outDir, slides, canvas, annotate, selectedElementIds } = job;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: canvas.w,
    height: canvas.h,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });

  const written = [];
  try {
    for (const slide of slides) {
      await win.loadFile(join(bundleDir, 'index.html'), { hash: String(slide.number) });
      // Fonts, images and the first video frame all need a beat to settle;
      // a screenshot taken before them shows a half-painted slide.
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      await new Promise((wait) => setTimeout(wait, job.settleMs ?? 400));
      if (job.built) await win.webContents.executeJavaScript(REVEAL_BUILDS);
      if (annotate) {
        const marked = await win.webContents.executeJavaScript(annotationScript(selectedElementIds ?? []));
        if (job.debug) process.stderr.write(`annotated ${marked} nodes on ${slide.id}\n`);
      }
      // Offscreen rendering paints on its own schedule, so a capture taken
      // straight after a DOM change returns the *previous* frame. Wait for two
      // animation frames — one to commit the change, one to paint it.
      await win.webContents.executeJavaScript(NEXT_PAINT);
      const image = await win.webContents.capturePage();
      const file = join(outDir, `${slide.id}.png`);
      writeFileSync(file, image.toPNG());
      written.push({ slideId: slide.id, number: slide.number, path: file });
    }
    process.stdout.write(JSON.stringify({ images: written }));
    app.exit(0);
  } catch (error) {
    process.stderr.write(String((error && error.stack) || error));
    app.exit(1);
  }
});

/**
 * Show every build step at once.
 *
 * By default a capture is the slide as it first appears, builds unfired —
 * which for a results slide is often an empty box. This reveals the finished
 * state instead, which is usually what "show me this slide" means.
 */
const REVEAL_BUILDS = `(() => {
  for (const node of document.querySelectorAll('.slide [data-element-id]')) {
    node.style.visibility = 'visible';
  }
  return true;
})()`;

const NEXT_PAINT =
  'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))';

/** Outline every object, label it with its element id, and mark the selection. */
function annotationScript(selectedElementIds) {
  return `(() => {
    const selected = new Set(${JSON.stringify(selectedElementIds)});
    // Every mounted slide, not just the first: the player keeps neighbouring
    // slides in the DOM, and the visible one is not always the first.
    const nodes = document.querySelectorAll('.slide [data-element-id]');
    if (nodes.length === 0) return 0;
    for (const node of nodes) {
      const id = node.getAttribute('data-element-id');
      const on = selected.has(id);
      node.style.outline = (on ? '4px solid #ff2d55' : '2px dashed rgba(0,120,255,.75)');
      node.style.outlineOffset = '0px';
      const tag = document.createElement('div');
      tag.textContent = id + (on ? ' (selected)' : '');
      Object.assign(tag.style, {
        position: 'absolute', left: '0', top: '-26px', zIndex: '99999',
        font: '600 18px ui-monospace, Menlo, monospace', whiteSpace: 'nowrap',
        color: '#fff', background: on ? '#ff2d55' : 'rgba(0,120,255,.85)',
        padding: '2px 6px', borderRadius: '4px', pointerEvents: 'none',
      });
      node.appendChild(tag);
    }
    return nodes.length;
  })()`;
}
