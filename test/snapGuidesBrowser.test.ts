import { mkdir, mkdtemp, copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * Spacing and sizing guides, driven the way an author drives them: a real
 * pointer pressed on a real handle, walked across the slide, and inspected
 * *while the button is still down*.
 *
 * The unit tests prove the geometry and the jsdom tests prove the overlay
 * nodes; neither would notice the thing an author actually complains about —
 * that dragging a picture in the running app shows no guide at all, because
 * the aspect-ratio constraint, the element's own hit box, or the live drag
 * loop got in the way before the guides could be drawn.
 */

const DECK_ID = 'snap-guides';
const PNG = join(process.cwd(), 'decks', 'demo-deck', 'assets', 'swatch.png');

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

/** Slide-space -> viewport-space, read from the stage the editor laid out. */
const VIEWPORT = `(() => {
  const stage = document.querySelector('#canvas .stage');
  const r = stage.getBoundingClientRect();
  const scale = r.width / window.store.get().deck.canvas.w;
  return { left: r.left, top: r.top, scale };
})()`;

interface Viewport { left: number; top: number; scale: number }

/** Every guide label currently painted, by kind. */
const GUIDES = `(() => ({
  spacing: [...document.querySelectorAll('#canvas .measure-spacing')].map((n) => n.textContent),
  sizes: [...document.querySelectorAll('#canvas .measure-size')].map((n) => n.textContent),
}))()`;

interface Guides { spacing: string[]; sizes: string[] }

const picture = (id: string, x: number, w: number, h: number) => ({
  id,
  type: 'image' as const,
  src: 'assets/swatch.png',
  fit: 'cover' as const,
  x,
  y: 400,
  w,
  h,
  z: 1,
});

/** Open a deck of `elements` in a real editor and return the pointer helpers. */
async function openEditor(elements: unknown[]): Promise<{
  cdp: Cdp;
  toScreen: (x: number, y: number) => { x: number; y: number };
  boxOf: (id: string) => Promise<{ x: number; y: number; w: number; h: number }>;
  guides: () => Promise<Guides>;
}> {
  workDir = await mkdtemp(join(tmpdir(), 'snap-guides-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, DECK_ID);
  const clientDir = await collabClientDir();
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(join(deckDir, 'assets'), { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await copyFile(PNG, join(deckDir, 'assets', 'swatch.png'));

  const deck: Deck = parseDeck({
    ...emptyDeck('Snap guides'),
    slides: [{ id: 's1', name: 'One', elements }],
  });
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');

  server = await startCollabServer({
    rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
  });
  browser = await launchBrowser(
    `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Guides%20Browser`,
    profileDir,
  );
  const target = await findTarget(
    browser.debugPort,
    (t) => t.url.includes(`deck=${DECK_ID}`) && !t.url.includes('present.html'),
    browser.log,
  );
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
  editor = cdp;

  await eventually(async () => cdp.evaluate<boolean>(`(() => {
    const images = [...document.querySelectorAll('#canvas .slide img')];
    return Boolean(document.querySelector('#canvas .slide'))
      && images.length > 0 && images.every((img) => img.complete);
  })()`), 'the editor never finished painting the slide');

  const view = await cdp.evaluate<Viewport>(VIEWPORT);
  return {
    cdp,
    toScreen: (x: number, y: number) => ({
      x: view.left + x * view.scale,
      y: view.top + y * view.scale,
    }),
    boxOf: (id: string) => cdp.evaluate(
      `(() => { const e = window.store.slide.elements.find((el) => el.id === ${JSON.stringify(id)});
        return { x: e.x, y: e.y, w: e.w, h: e.h }; })()`,
    ),
    guides: () => cdp.evaluate<Guides>(GUIDES),
  };
}

describe.skipIf(!electronBinary)('spacing and sizing guides in the running editor', () => {
  it('guides a picture to its neighbours\' size and to an even distribution', async () => {
    // Two 300x200 pictures 200 apart, and a third that is neither their size
    // nor in step with their rhythm — the state an author is trying to fix.
    const { cdp, toScreen, boxOf, guides } = await openEditor([
      picture('a', 200, 300, 200),
      picture('b', 700, 300, 200),
      picture('c', 1300, 240, 160),
    ]);

    // --- sizing: drag 'c' wider until it matches its neighbours ------------
    // Select it first; handles only exist on a selected object.
    const centre = toScreen(1300 + 240 / 2, 400 + 160 / 2);
    await cdp.clickAt(centre.x, centre.y);
    expect(await cdp.evaluate<string[]>('[...window.store.get().selection]')).toEqual(['c']);

    const handle = toScreen(1300 + 240, 400 + 160 / 2);
    const resize = await cdp.beginDrag(handle.x, handle.y);
    // Out past the target first — a drag has to clear the click threshold.
    await resize.moveTo(toScreen(1300 + 340, 400 + 160 / 2).x, handle.y);
    // Nothing is claimed while it is nowhere near the neighbours' width.
    expect((await guides()).sizes).not.toContain('300');

    // Back to 294 wide, six slide pixels short of the neighbours' 300.
    await resize.moveTo(toScreen(1300 + 294, 400 + 160 / 2).x, handle.y);
    const whileResizing = await guides();
    // The picture and both neighbours are marked, not just the dragged one.
    expect(whileResizing.sizes.filter((label) => label === '300').length).toBe(3);

    await resize.drop();
    expect(await boxOf('c')).toMatchObject({ w: 300, h: 200 });
    expect(await guides()).toEqual({ spacing: [], sizes: [] });

    // --- spacing: drag it into the rhythm the other two already keep -------
    const from = toScreen(1300 + 150, 500);
    const drag = await cdp.beginDrag(from.x, from.y);
    await drag.moveTo(toScreen(1300 + 150 - 200, 500).x, from.y);
    // Land at x = 1194: six pixels short of the 200px gap 'a' and 'b' keep.
    await drag.moveTo(toScreen(1194 + 150, 500).x, from.y);

    expect((await guides()).spacing).toEqual(['200', '200']);

    await drag.drop();
    expect(await boxOf('c')).toMatchObject({ x: 1200, y: 400 });
    expect(await guides()).toEqual({ spacing: [], sizes: [] });
  }, 180_000);

  it('sizes the middle of three pictures on a slide that is already tidy', async () => {
    // Slide 3 of a real talk: three screenshots with a caption under each, and
    // a title across the top. Nothing here is far from something else, so the
    // first cut of this feature — alignment first, size matching only on an
    // axis alignment left free — showed no size guide at all. The middle
    // picture's right edge is 3px from its caption's and its bottom edge sits
    // exactly on the left picture's, while the width it should match is 2px
    // away. The nearer cue has to win.
    const caption = (id: string, x: number) => ({
      id, type: 'text' as const, x, y: 818, w: 495, h: 73, z: 2,
      html: 'Caption', align: 'center' as const, valign: 'top' as const,
    });
    const { cdp, toScreen, boxOf, guides } = await openEditor([
      { id: 'title', type: 'text', x: 120, y: 58, w: 1680, h: 142, z: 1,
        html: 'Three screenshots', align: 'left', valign: 'middle' },
      { ...picture('left', 99, 495, 495), y: 306 },
      { ...picture('middle', 708, 503, 503), y: 304 },
      { ...picture('right', 1325, 493, 493), y: 307 },
      caption('cap-left', 99),
      caption('cap-middle', 713),
      caption('cap-right', 1324),
    ]);

    const centre = toScreen(708 + 503 / 2, 304 + 503 / 2);
    await cdp.clickAt(centre.x, centre.y);
    expect(await cdp.evaluate<string[]>('[...window.store.get().selection]')).toEqual(['middle']);

    // Drag the south-east corner in, past the match and back to 497 square.
    const corner = toScreen(708 + 503, 304 + 503);
    const resize = await cdp.beginDrag(corner.x, corner.y);
    const at = (size: number) => toScreen(708 + size, 304 + size);
    await resize.moveTo(at(460).x, at(460).y);
    expect((await guides()).sizes).not.toContain('495');

    await resize.moveTo(at(497).x, at(497).y);
    const whileResizing = await guides();
    // Its own bar plus the left picture's and all three captions', which are
    // 495 wide too — every box the author has just matched.
    expect(whileResizing.sizes.filter((label) => label === '495').length).toBeGreaterThanOrEqual(2);

    await resize.drop();
    expect(await boxOf('middle')).toMatchObject({ w: 495, h: 495 });
  }, 180_000);
});

describe.skipIf(Boolean(electronBinary))('spacing and sizing guides (skipped)', () => {
  it('needs a downloaded Electron binary to drive real pointer input', () => {
    expect(electronBinary).toBe('');
  });
});
