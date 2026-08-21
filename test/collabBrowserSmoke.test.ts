import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';

/**
 * Production-browser smoke test for the standalone collaboration edition.
 *
 * Server-only tests prove the HTTP and WebSocket protocol, while editor unit
 * tests prove the shared canvas and controls. This closes the seam between
 * them: Vite builds the real browser client, the real server hosts it, and a
 * hidden Electron browser drives one editing session from its actual toolbar.
 * No desktop preload, mocked socket, or source-only dev server participates.
 *
 * `test/collabTextFormattingBrowser.test.ts` takes the same harness further,
 * driving the typography controls with real mouse and key events.
 */

const DECK_ID = 'browser-smoke';
const TEXT_MARKER = 'BROWSER COLLAB SMOKE';
const THEME_MARKER = 'rgb(12, 34, 56)';
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;
let presentation: Cdp | null = null;

afterEach(async () => {
  presentation?.close();
  presentation = null;
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!electronBinary)('standalone collaboration browser', () => {
  it('opens, edits, syncs, uploads media, themes, presents, and downloads the live deck', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'collab-browser-smoke-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = join(workDir, 'client');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const deck = emptyDeck('Browser collaboration smoke');
    deck.slides[0].elements.push({
      id: 'initial-title', type: 'text', x: 160, y: 100, w: 1600, h: 140,
      rot: 0, z: 1, opacity: 1, class: ['role-title'], style: {},
      html: 'Initial collaborative slide', align: 'center', valign: 'middle',
    });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #ffffff; color: #111827; }',
      '.role-title { font: 700 72px/1.1 sans-serif; }',
      '',
    ].join('\n'), 'utf8');

    // Build into the disposable fixture so this test always exercises current
    // production output and never relies on an old or missing dist/collab.
    await build({
      configFile: join(process.cwd(), 'vite.collab.config.ts'),
      logLevel: 'silent',
      build: { outDir: clientDir, emptyOutDir: true },
    });

    server = await startCollabServer({
      rootDir: decksRoot,
      clientDir,
      host: '127.0.0.1',
      port: 0,
    });

    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Smoke%20Browser`,
      profileDir,
    );
    const editorTarget = await findTarget(
      browser.debugPort,
      (target) => target.url.includes(`deck=${DECK_ID}`) && !target.url.includes('present.html'),
      browser.log,
    );
    editor = await Cdp.connect(editorTarget.webSocketDebuggerUrl!);

    const opened = await eventually(async () => editor!.evaluate<{
      title: string;
      connected: boolean;
      controls: string[];
      panels: string[];
    }>(`(() => ({
      title: window.store?.get().deck.title ?? '',
      connected: document.getElementById('status')?.textContent?.includes('connected as Smoke Browser') === true,
      controls: [...document.querySelectorAll('#toolbar button')].map((button) => button.textContent?.trim() ?? ''),
      panels: [...document.querySelectorAll('#side-tabs button')].map((button) => button.textContent?.trim() ?? '')
    }))()`), 'browser editor did not finish connecting', (value) => value.connected);
    expect(opened.title).toBe('Browser collaboration smoke');
    expect(opened.controls).toEqual(expect.arrayContaining(['Text', 'Present', 'Save As…']));
    expect(opened.panels).toEqual(['Props', 'Theme', 'Build', 'History']);

    // Use the real toolbar to create the object, then finish the same edit
    // through the exposed store just as canvas/inspector controls do.
    const textId = await editor.evaluate<string>(`(() => {
      const textButton = [...document.querySelectorAll('#toolbar button')]
        .find((button) => button.textContent?.trim() === 'Text');
      if (!textButton) throw new Error('Text toolbar button is missing');
      textButton.click();
      const id = [...window.store.get().selection][0];
      window.store.updateSelected((element) => {
        if (element.type !== 'text') throw new Error('Text button did not select text');
        element.html = ${JSON.stringify(TEXT_MARKER)};
        element.class = ['role-title'];
        element.align = 'center';
      }, { label: 'Smoke: edit text' });
      return id;
    })()`);

    await eventually(async () => {
      const live = await fetchDeck(server!.port);
      return live.slides[0].elements.some((element) =>
        element.id === textId && element.type === 'text' && element.html === TEXT_MARKER);
    }, 'toolbar text edit did not reach the server');

    // Exercise the browser-only File -> XHR -> server importer bridge, then
    // insert the returned asset into the live deck through the shared store.
    const importedSrc = await editor.evaluate<string>(`(async () => {
      const binary = atob(${JSON.stringify(PNG_BASE64)});
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const [asset] = await window.api.importAssetFiles([
        new File([bytes], 'smoke.png', { type: 'image/png' })
      ], 'browser-smoke-upload');
      window.store.commit((deck) => {
        deck.slides[0].elements.push({
          id: 'browser-smoke-image', type: 'image', src: asset.src,
          x: 820, y: 650, w: 280, h: 220, rot: 0, z: 3, opacity: 1,
          class: [], style: {}, fit: 'contain', alt: 'Browser smoke upload', sourceBox: null
        });
      }, { label: 'Smoke: add uploaded image' });
      return asset.src;
    })()`);
    expect(importedSrc).toMatch(/^assets\/smoke\.[0-9a-f]+\.png$/);

    await eventually(async () => editor!.evaluate<boolean>(`(() => {
      const image = document.querySelector('[data-element-id="browser-smoke-image"] img');
      return image?.complete === true && image.naturalWidth > 0;
    })()`), 'uploaded media did not render in the browser editor');
    await eventually(async () => {
      const live = await fetchDeck(server!.port);
      return live.slides[0].elements.some((element) =>
        element.type === 'image' && element.src === importedSrc);
    }, 'uploaded media edit did not reach the server');

    const themeCss = [
      `.slide { background: ${THEME_MARKER}; color: #ffffff; }`,
      '.role-title { font: 700 72px/1.1 sans-serif; }',
      '',
    ].join('\n');
    await editor.evaluate(`window.api.saveTheme(${JSON.stringify(themeCss)})`);
    await eventually(async () => (
      await fetch(`http://127.0.0.1:${server!.port}/api/theme?deck=${DECK_ID}`)
    ).text(), 'theme edit did not reach the server', (css) => css.includes(THEME_MARKER));

    const presentClicked = await editor.evaluate<boolean>(`(() => {
      const button = [...document.querySelectorAll('#toolbar button')]
        .find((candidate) => candidate.textContent?.trim() === 'Present');
      button?.click();
      return Boolean(button);
    })()`);
    expect(presentClicked).toBe(true);

    const presentationTarget = await findTarget(
      browser.debugPort,
      (target) => target.url.includes('/present.html') && target.url.includes(`deck=${DECK_ID}`),
      browser.log,
    );
    presentation = await Cdp.connect(presentationTarget.webSocketDebuggerUrl!);
    const presented = await eventually(async () => presentation!.evaluate<{
      marker: boolean;
      imageLoaded: boolean;
      background: string;
    }>(`(() => {
      const image = document.querySelector('[data-element-id="browser-smoke-image"] img');
      return {
        marker: document.body.textContent?.includes(${JSON.stringify(TEXT_MARKER)}) === true,
        imageLoaded: image?.complete === true && image.naturalWidth > 0,
        background: getComputedStyle(document.querySelector('.slide')).backgroundColor
      };
    })()`), 'live presentation did not paint the synchronized deck', (value) => (
      value.marker && value.imageLoaded && value.background === THEME_MARKER
    ));
    expect(presented).toEqual({ marker: true, imageLoaded: true, background: THEME_MARKER });

    const archiveResponse = await fetch(
      `http://127.0.0.1:${server.port}/api/download?deck=${DECK_ID}`,
    );
    expect(archiveResponse.status).toBe(200);
    expect(archiveResponse.headers.get('content-type')).toBe('application/zip');
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    const archiveText = archive.toString('utf8');
    expect(archiveText).toContain('deck.json');
    expect(archiveText).toContain('theme.css');
    expect(archiveText).toContain(TEXT_MARKER);
    expect(archiveText).toContain(importedSrc);
    expect(archiveText).toContain(THEME_MARKER);
  }, 60_000);
});

describe.skipIf(electronBinary)('standalone collaboration browser (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBe('');
  });
});

async function fetchDeck(port: number): Promise<Deck> {
  const response = await fetch(`http://127.0.0.1:${port}/api/deck?deck=${DECK_ID}`);
  if (!response.ok) throw new Error(`deck request failed (${response.status})`);
  return response.json() as Promise<Deck>;
}
