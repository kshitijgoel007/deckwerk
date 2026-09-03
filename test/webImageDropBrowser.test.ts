import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck } from '../src/shared/deck.js';
import {
  Cdp,
  collectProcessOutput,
  electronBinary,
  eventually,
  findTarget,
  freePort,
  stopBrowser,
} from './support/browserSession.js';

/**
 * Dragging an image out of a web page onto a slide, in the desktop app.
 *
 * The bug: nothing happened. The canvas drop handler only read
 * `dataTransfer.files`, and a cross-application drag out of a browser puts no
 * file on the pasteboard at all — only the page's `<img>` markup and the
 * image's URL. This drives the whole desktop chain the fix added: the drag
 * payload, the placeholder, the preload bridge, and the main process fetching
 * the bytes into the deck folder.
 *
 * The drag quotes an inline `data:` image, so the test needs no network; the
 * renderer, IPC and importer halves are the same for a remote URL, and
 * `test/webImageImport.test.ts` covers the fetch itself.
 */

const PNG = join(process.cwd(), 'decks', 'demo-deck', 'assets', 'swatch.png');
const requiredBuildOutputs = [
  'out/main/index.js',
  'out/preload/index.mjs',
  'out/renderer/editor/index.html',
];
const runnable = Boolean(electronBinary)
  && existsSync(PNG)
  && requiredBuildOutputs.every((path) => existsSync(join(process.cwd(), path)));

let workDir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(appProcess);
  appProcess = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!runnable)('dropping a web image into the desktop app', () => {
  it('imports an image dragged out of a browser, which carries no file', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-web-image-drop-'));
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, emptyDeck('Web image drop'));
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');

    const debugPort = await freePort();
    appProcess = spawn(electronBinary, [
      '.',
      `--remote-debugging-port=${debugPort}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      deckDir,
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    const appLog = collectProcessOutput(appProcess);

    const target = await findTarget(
      debugPort,
      (candidate) => candidate.title === 'DeckWerk' || candidate.url.includes('/editor/index.html'),
      appLog,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`window.api.getDeck().then(
      (session) => session?.dir === ${JSON.stringify(deckDir)}
        && Boolean(document.querySelector('#canvas .slide'))
    )`), 'desktop editor did not open the drop test deck');

    // The main process watches deck.json and broadcasts what it reads back;
    // that startup broadcast replaces the renderer's deck, so an edit made in
    // the first moments after opening is discarded. Let it pass before
    // dropping, the way a person reaching for a browser window would.
    await new Promise((settle) => { setTimeout(settle, 4000); });

    const png = (await readFile(PNG)).toString('base64');
    const dropped = await editor.evaluate<{ files: number }>(`(() => {
      const transfer = new DataTransfer();
      // What a browser writes for an image drag: markup, the image's own URL
      // in text/uri-list, and the *page's* URL as plain text.
      transfer.setData('text/html', "<meta charset='utf-8'><img src=\\"data:image/png;base64,${png}\\" alt=\\"Swatch\\">");
      transfer.setData('text/uri-list', 'data:image/png;base64,${png}');
      transfer.setData('text/plain', 'https://example.test/gallery');

      const host = document.getElementById('canvas');
      const box = host.querySelector('.slide').getBoundingClientRect();
      host.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: Math.round(box.left + box.width / 2),
        clientY: Math.round(box.top + box.height / 2)
      }));
      return { files: transfer.files.length };
    })()`);
    // The premise of the bug: the drag carried no file to import.
    expect(dropped.files).toBe(0);

    const painted = await eventually(async () => editor!.evaluate<{
      src: string | null;
      complete: boolean;
      naturalWidth: number;
      selected: boolean;
    }>(`(() => {
      const image = document.querySelector('#canvas [data-element-id] img');
      return {
        src: image?.getAttribute('src') ?? null,
        complete: image?.complete === true,
        naturalWidth: image?.naturalWidth ?? 0,
        selected: document.querySelectorAll('#canvas .sel-box').length === 1
      };
    })()`), 'the dragged web image never rendered on the slide',
      (value) => value.complete && value.naturalWidth === 800, 30_000);

    expect(painted.src).toMatch(/^deck:\/\/asset\/assets\/.+\.png$/);
    // Dropped media is left selected, ready to be moved.
    expect(painted.selected).toBe(true);

    // The bytes are really in the deck folder, as a PNG.
    const assets = await readdir(join(deckDir, 'assets'));
    expect(assets).toHaveLength(1);
    const imported = await readFile(join(deckDir, 'assets', assets[0]));
    expect([...imported.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    // The element it left behind is a resolved image, not a placeholder, and
    // it is sized from the 800x600 image the browser decoded off the drag.
    const box = await editor.evaluate<{ pending: boolean; ratio: number; src: string }>(`(() => {
      const node = document.querySelector('#canvas [data-element-id]');
      const rect = node.getBoundingClientRect();
      return {
        pending: node.querySelector('.pending-asset') !== null,
        ratio: rect.width / rect.height,
        src: node.querySelector('img').getAttribute('src')
      };
    })()`);
    expect(box.pending).toBe(false);
    expect(box.src).toBe(`deck://asset/assets/${assets[0]}`);
    expect(box.ratio).toBeCloseTo(800 / 600, 1);
  }, 60_000);
});

describe.skipIf(runnable)('dropping a web image into the desktop app (skipped)', () => {
  it('needs Electron and current desktop build outputs', () => {
    expect(runnable).toBe(false);
  });
});
