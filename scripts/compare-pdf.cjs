/** Run by Electron: generate the real PDF, raster it, and compare every page with the Player. */
const { spawnSync } = require('node:child_process');
const { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { Readable } = require('node:stream');
const { app, BrowserWindow, nativeImage, protocol, screen } = require('electron');

const jobPath = process.argv[2];
const job = JSON.parse(readFileSync(jobPath, 'utf8'));
const CHANNEL_TOLERANCE = job.channelTolerance ?? 24;
let activeDeckDir = '';

app.commandLine.appendSwitch('force-device-scale-factor', '1');
protocol.registerSchemesAsPrivileged([{ scheme: 'deck', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  protocol.handle('deck', (request) => serveAsset(request));
  const results = [];
  try {
    for (let deckIndex = 0; deckIndex < job.decks.length; deckIndex++) {
      const item = job.decks[deckIndex];
      activeDeckDir = item.deckDir;
      mkdirSync(item.outDir, { recursive: true });
      const pdfPath = join(item.outDir, 'export.pdf');
      const pageDir = join(item.outDir, 'pages');
      mkdirSync(pageDir, { recursive: true });

      const print = new BrowserWindow({ show: false, webPreferences: {
        offscreen: true,
        sandbox: false,
        preload: job.preload,
        additionalArguments: [`--pdf-fidelity-job=${jobPath}`, `--deck-index=${deckIndex}`],
      } });
      await print.loadFile(job.printPage, { query: { job: 'test', mode: item.mode, includeHidden: '0' } });
      await waitUntilReady(print);
      const pdf = await print.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
      writeFileSync(pdfPath, pdf);
      print.destroy();

      const scale = screen.getPrimaryDisplay().scaleFactor;
      const raster = spawnSync(job.python, ['-c', RASTER_PDF, pdfPath, pageDir,
        String(Math.round(item.canvas.w * scale)), String(Math.round(item.canvas.h * scale))],
      { encoding: 'utf8' });
      if (raster.status !== 0) throw new Error(raster.stderr || 'Could not raster PDF');

      const player = new BrowserWindow({
        width: item.canvas.w, height: item.canvas.h, show: false, useContentSize: true,
        webPreferences: { offscreen: true, backgroundThrottling: false },
      });
      await player.loadFile(join(item.bundleDir, 'index.html'));
      for (let pageIndex = 0; pageIndex < item.pages.length; pageIndex++) {
        const expected = item.pages[pageIndex];
        await player.webContents.executeJavaScript(
          `window.__SLIDE_PLAYER__.goTo(${JSON.stringify({ slide: expected.slide, step: expected.step })})`,
        );
        await settlePlayer(player, expected.videoTimes);
        const reference = await stableCapture(player);
        const actual = nativeImage.createFromPath(join(pageDir, `${pageIndex}.png`));
        const comparison = compare(reference, actual);
        if (comparison.fraction > (job.reportAbove ?? 0)) {
          const name = `${expected.id}-step-${expected.step}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
          writeFileSync(join(item.outDir, `${name}-player.png`), reference.toPNG());
          writeFileSync(join(item.outDir, `${name}-pdf.png`), actual.toPNG());
          writeFileSync(join(item.outDir, `${name}-diff.png`), comparison.diff.toPNG());
        }
        results.push({ deck: item.name, id: expected.id, step: expected.step,
          fraction: comparison.fraction, differing: comparison.differing,
          total: comparison.total, size: comparison.size });
      }
      player.destroy();
    }
    writeFileSync(job.outPath, JSON.stringify({ results }), 'utf8');
    process.stdout.write(JSON.stringify({ ok: true, pages: results.length }));
    app.quit();
  } catch (error) {
    process.stderr.write(String(error?.stack || error));
    process.exitCode = 1;
    app.quit();
  }
});

async function waitUntilReady(win) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript(`({
      ready: document.documentElement.dataset.ready || '',
      error: document.documentElement.dataset.error || ''
    })`);
    if (state.error) throw new Error(state.error);
    if (state.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('PDF renderer timed out');
}

async function settlePlayer(win, videoTimes) {
  await win.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode?.().catch(() => {})));
    const times = ${JSON.stringify([])}.concat(${JSON.stringify(videoTimes || [])});
    await Promise.all([...document.querySelectorAll('video')].map((video, index) => new Promise((done) => {
      video.pause(); video.autoplay = false;
      const seek = () => {
        const at = Math.max(0, Math.min(times[index] ?? 0, Math.max(0, video.duration - .03)));
        if (Math.abs(video.currentTime - at) <= .02) return done();
        video.addEventListener('seeked', done, { once: true });
        video.currentTime = at;
      };
      if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek, { once: true });
      setTimeout(done, 5000);
    })));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  })()`);
}

async function stableCapture(win) {
  let previous = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const image = await win.webContents.capturePage();
    const bitmap = image.getBitmap();
    if (previous && bitmap.equals(previous.bitmap)) return previous.image;
    previous = { image, bitmap };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return previous.image;
}

function compare(reference, actual) {
  const aSize = reference.getSize();
  const bSize = actual.getSize();
  if (aSize.width !== bSize.width || aSize.height !== bSize.height) {
    return { fraction: 1, differing: -1, total: -1,
      size: `${aSize.width}x${aSize.height} vs ${bSize.width}x${bSize.height}`, diff: reference };
  }
  const a = reference.getBitmap();
  const b = actual.getBitmap();
  const out = Buffer.alloc(a.length);
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    const off = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    const bad = off > CHANNEL_TOLERANCE;
    if (bad) differing++;
    out[i] = bad ? 255 : a[i] >> 1;
    out[i + 1] = bad ? 0 : a[i + 1] >> 1;
    out[i + 2] = bad ? 255 : a[i + 2] >> 1;
    out[i + 3] = 255;
  }
  const total = a.length / 4;
  return { fraction: differing / total, differing, total,
    size: `${aSize.width}x${aSize.height}`, diff: nativeImage.createFromBitmap(out, aSize) };
}

function serveAsset(request) {
  try {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const absolute = resolve(activeDeckDir, relative);
    if (!absolute.startsWith(resolve(activeDeckDir) + require('node:path').sep)) return new Response('Forbidden', { status: 403 });
    const size = statSync(absolute).size;
    const range = request.headers.get('Range');
    const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    const headers = { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
    if (match) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    const stream = Readable.toWeb(createReadStream(absolute, { start, end }));
    return new Response(stream, { status: match ? 206 : 200, headers });
  } catch (error) { return new Response(String(error), { status: 404 }); }
}

const RASTER_PDF = `
import sys, pymupdf
doc = pymupdf.open(sys.argv[1])
out, width, height = sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
for index, page in enumerate(doc):
    matrix = pymupdf.Matrix(width / page.rect.width, height / page.rect.height)
    pix = page.get_pixmap(matrix=matrix, alpha=False)
    pix.save(f'{out}/{index}.png')
`;
