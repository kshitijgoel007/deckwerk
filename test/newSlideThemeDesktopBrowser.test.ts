import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'electron-vite';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import { THEMES } from '../src/shared/themes.js';
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
 * A slide inserted with Return in the slide picker wears the theme the author
 * picked in the Theme tab — checked in the real desktop app, driven the way a
 * person drives it.
 *
 * The jsdom rail test for the same path dispatches a synthetic `keydown` at
 * the rail host and reads the store. That cannot see the whole route a real
 * keystroke takes: the Theme tab has to record the choice, the rail row has
 * to take focus from a genuine mouse press, the keystroke has to reach the
 * rail rather than the canvas or the theme panel, and the result has to be
 * painted on the canvas and written to deck.json. So nothing here calls
 * `.click()`, `.focus()`, or `dispatchEvent` on a node: every step is a real
 * mouse or keyboard event over the laid-out page, and the outcome is read
 * from the canvas, the rail thumbnail, and the file on disk.
 */

const NOIR = THEMES.find((theme) => theme.id === 'noir')!;
const CANVAS_SLIDE = '#canvas .slide-layer > .slide';
const THEME_TAB = '#side-tabs button[data-panel="themePanel"]';
const ACTIVE_CARD = '#themePanel .theme-active-host .theme-card';
const CHOOSER = '#themePanel .theme-chooser';
const NOIR_CARD = `${CHOOSER} .theme-card[data-theme-id="noir"]`;

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

describe.skipIf(!electronBinary)('new slide from Return in the slide picker (desktop app)', () => {
  it('wears the theme chosen in the Theme tab, on the canvas and on disk', {
    retry: 2,
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-new-slide-theme-'));
    const checkout = process.cwd();
    const appDir = join(workDir, 'app');
    const outDir = join(appDir, 'out');
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    await build({
      root: checkout,
      configFile: join(checkout, 'electron.vite.config.ts'),
      logLevel: 'silent',
      build: { outDir },
    });
    await writeFile(join(appDir, 'package.json'), JSON.stringify({
      name: 'deckwerk-new-slide-theme-test',
      private: true,
      type: 'module',
      main: 'out/main/index.js',
    }), 'utf8');
    await symlink(join(checkout, 'node_modules'), join(appDir, 'node_modules'), 'dir');

    // Two plain slides on the stylesheet alone: no theme chosen, no theme
    // applied. The first carries an unstyled title so the test can prove the
    // existing slides are left exactly as they were.
    const base = emptyDeck('New slide theme');
    const deck: Deck = parseDeck({
      ...base,
      slides: [
        {
          ...base.slides[0],
          id: 's1',
          name: 'First',
          elements: [{
            id: 'existing-title', type: 'text', x: 140, y: 150, w: 1640, h: 200, rot: 0, z: 1,
            opacity: 1, class: ['role-title'], style: {}, html: 'Existing title',
            align: 'left', valign: 'top',
          }],
        },
        { ...base.slides[0], id: 's2', name: 'Second' },
      ],
    });
    await saveDeck(deckDir, deck);

    const debugPort = await freePort();
    appProcess = spawn(electronBinary, [
      appDir,
      `--remote-debugging-port=${debugPort}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      deckDir,
    ], {
      cwd: checkout,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    const appLog = collectProcessOutput(appProcess);
    const target = await findTarget(
      debugPort,
      (candidate) => candidate.title === 'DeckWerk' || candidate.url.includes('/editor/index.html'),
      appLog,
      20_000,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`window.api.getDeck().then(
      (session) => session?.dir === ${JSON.stringify(deckDir)}
        && Boolean(document.querySelector(${JSON.stringify(CANVAS_SLIDE)}))
        && !document.body.classList.contains('welcome-mode')
        && document.querySelector('#rail .rail-item[data-slide-id="s2"]')?.getBoundingClientRect().width > 0
    )`), 'desktop editor did not open the fixture deck');
    await editor.call('Page.bringToFront');
    await editor.evaluate('window.focus()');

    const untouchedFirst = JSON.stringify(deck.slides[0]);
    const groundBefore = await canvasBackground(editor);
    expect(groundBefore).not.toBe(rgb(NOIR.colors.background));

    // 1. Choose a theme in the Theme tab: open the tab, expand the current
    //    card into the chooser, flip to Dark so the Noir card shows Noir
    //    itself (not its light counterpart), and pick it.
    await editor.click(THEME_TAB, 'Theme tab');
    await eventually(
      () => editor!.evaluate<boolean>(`!document.getElementById('themePanel').hidden
        && document.querySelector(${JSON.stringify(ACTIVE_CARD)})?.getBoundingClientRect().width > 0`),
      'Theme tab did not open',
    );
    await editor.click(ACTIVE_CARD, 'current theme card');
    await eventually(
      () => editor!.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(CHOOSER)})).display`),
      'theme chooser did not open',
      (display) => display !== 'none',
    );
    await editor.clickByText(`${CHOOSER} .theme-mode-option`, 'Dark', 'Dark appearance');
    await eventually(
      () => editor!.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(NOIR_CARD)}))`),
      'gallery did not offer the Noir card in Dark mode',
    );
    await editor.click(NOIR_CARD, 'Noir theme card');
    // Picking a card closes the chooser and records the choice on the deck.
    await eventually(
      () => editor!.evaluate<boolean>(`document.querySelector(${JSON.stringify(CHOOSER)}).hidden`),
      'picking a theme card did not close the chooser',
    );
    await eventually(
      () => readDeck(deckDir),
      'chosen theme did not reach deck.json',
      (saved) => saved.themeSelection?.preset === 'noir',
    );
    // Choosing restyles nothing that already exists.
    expect(await canvasBackground(editor)).toBe(groundBefore);

    // 2. Select the first slide in the picker with a real mouse press, then
    //    press Return. The keystroke must land on the rail, not on the canvas
    //    or the theme panel that was just in use.
    await editor.click('#rail .rail-item[data-slide-id="s1"]', 'first slide in the picker');
    await eventually(
      () => editor!.evaluate<boolean>(`(() => {
        const row = document.querySelector('#rail .rail-item[data-slide-id="s1"]');
        return Boolean(row && row.classList.contains('active')
          && document.getElementById('rail').contains(document.activeElement));
      })()`),
      'clicking a slide did not select it and hand the rail focus',
    );
    await editor.key('Enter', 13);

    // 3. One new slide, right after the first, and it wears Noir.
    const saved = await eventually(
      () => readDeck(deckDir),
      'Return did not insert a slide after the selected one',
      (candidate) => candidate.slides.length === 3
        && candidate.slides[0].id === 's1' && candidate.slides[2].id === 's2',
    );
    const added = saved.slides[1];
    expect(added.background.color).toBe(NOIR.colors.background);
    const title = added.elements.find((el) => el.type === 'text' && el.class.includes('role-title'));
    expect(title, 'the standard layout gives the new slide a title').toBeTruthy();
    expect(title!.style['font-family']).toBe(NOIR.fonts.title.family);
    expect(title!.style['font-size']).toBe(`${NOIR.fonts.title.size}px`);
    expect(title!.style.color).toBe(NOIR.fonts.title.color ?? NOIR.colors.text);
    const body = added.elements.find((el) => el.type === 'text' && el.class.includes('role-body'));
    expect(body!.style['font-family']).toBe(NOIR.fonts.body.family);
    expect(body!.style.color).toBe(NOIR.fonts.body.color ?? NOIR.colors.text);
    // The slides that were already there are exactly as they were.
    expect(JSON.stringify(saved.slides[0])).toBe(untouchedFirst);
    expect(saved.slides[2].background.color).toBeNull();

    // 4. What the author actually sees: the canvas shows the new slide on
    //    Noir's ground with Noir's title, and its rail thumbnail agrees.
    await eventually(
      () => editor!.evaluate<string>(
        `document.querySelector(${JSON.stringify(CANVAS_SLIDE)})?.dataset.slideId
          ?? document.querySelector('#rail .rail-item.active')?.dataset.slideId`,
      ),
      'the editor did not move to the new slide',
      (id) => id === added.id,
    );
    await eventually(
      () => canvasBackground(editor!),
      'canvas did not paint the new slide on the chosen theme background',
      (color) => color === rgb(NOIR.colors.background),
    );
    const titleOnCanvas = await editor.evaluate<{ color: string; family: string; size: string }>(`(() => {
      const node = document.querySelector(
        ${JSON.stringify(`${CANVAS_SLIDE} [data-element-id="${title!.id}"]`)},
      );
      if (!node) return { color: '', family: '', size: '' };
      const cs = getComputedStyle(node);
      return { color: cs.color, family: cs.fontFamily, size: cs.fontSize };
    })()`);
    expect(titleOnCanvas.color).toBe(rgb(NOIR.fonts.title.color ?? NOIR.colors.text));
    expect(titleOnCanvas.size).toBe(`${NOIR.fonts.title.size}px`);
    expect(normalizeFamily(titleOnCanvas.family)).toBe(normalizeFamily(NOIR.fonts.title.family));

    await eventually(
      () => editor!.evaluate<string>(`(() => {
        const thumb = document.querySelector(
          ${JSON.stringify(`#rail .rail-item[data-slide-id="${added.id}"] .rail-thumb-inner`)},
        );
        return thumb ? getComputedStyle(thumb).backgroundColor : '';
      })()`),
      'rail thumbnail of the new slide is not on the chosen theme background',
      (color) => color === rgb(NOIR.colors.background),
    );
  });
});

async function readDeck(deckDir: string): Promise<Deck> {
  return JSON.parse(await readFile(join(deckDir, 'deck.json'), 'utf8')) as Deck;
}

async function canvasBackground(cdp: Cdp): Promise<string> {
  return cdp.evaluate<string>(
    `getComputedStyle(document.querySelector(${JSON.stringify(CANVAS_SLIDE)})).backgroundColor`,
  );
}

/** `#rrggbb` as Chromium reports a computed colour. */
function rgb(hex: string): string {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

/** Computed font-family drops quotes where it can; compare family lists loosely. */
function normalizeFamily(list: string): string {
  return list.split(',').map((f) => f.trim().replace(/^["']|["']$/g, '').toLowerCase()).join(',');
}
