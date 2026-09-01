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
 * Three canvas bugs that only exist once a real engine lays the slide out, and
 * that no jsdom test can see because jsdom neither paints nor stacks:
 *
 *  - a media border painting over the elements in front of it;
 *  - content past the slide edge being clipped away, so anything pasted or
 *    dragged outside the slide became invisible and unfindable;
 *  - text that outgrew its box not being clickable where it is visible.
 *
 * The first two are checked against actual pixels: the page decodes a
 * screenshot of itself and reports the colour at a computed slide coordinate.
 */

const DECK_ID = 'visibility';
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

/** Slide-space -> viewport-space, read from the stage the editor actually laid out. */
const VIEWPORT = `(() => {
  const stage = document.querySelector('#canvas .stage');
  const r = stage.getBoundingClientRect();
  const scale = r.width / window.store.get().deck.canvas.w;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, scale };
})()`;

interface Viewport { left: number; top: number; right: number; bottom: number; scale: number }

describe.skipIf(!electronBinary)('canvas visibility and hit-testing', () => {
  it('stacks borders per element, paints past the slide edge, and hits spilled text', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'canvas-visibility-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await copyFile(PNG, join(deckDir, 'assets', 'swatch.png'));

    const deck: Deck = parseDeck({
      ...emptyDeck('Visibility'),
      slides: [{
        id: 's1',
        name: 'One',
        elements: [
          // A thick red border, and an opaque blue rectangle in front of it.
          // The blue must win everywhere the two overlap.
          {
            id: 'bordered', type: 'image', src: 'assets/swatch.png', fit: 'cover',
            x: 200, y: 200, w: 400, h: 400, z: 1,
            borderWidth: 40, borderColor: '#ff0000',
          },
          {
            id: 'front', type: 'shape', shape: 'rect', fill: '#0000ff',
            stroke: null, strokeWidth: 0, radius: 0,
            x: 500, y: 300, w: 400, h: 200, z: 2,
          },
          // Straddles the right edge of the 1920-wide slide.
          {
            id: 'spill', type: 'shape', shape: 'rect', fill: '#00ff00',
            stroke: null, strokeWidth: 0, radius: 0,
            x: 1700, y: 400, w: 500, h: 200, z: 3,
          },
          // Far more text than 40px of box can hold, and no auto-fit to
          // shrink it, so it paints well below its own bottom edge.
          {
            id: 'spilltext', type: 'text', x: 200, y: 800, w: 300, h: 40, z: 4,
            valign: 'top', align: 'left', autoFit: false,
            html: 'This sentence is far too long to fit inside the small box it was given.',
          },
        ],
      }],
    });
    await saveDeck(deckDir, deck);
    await writeFile(
      join(deckDir, 'theme.css'),
      '.slide { background: #ffffff; }\n.element-text { font-size: 48px; color: #000; }\n',
      'utf8',
    );

    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Pixel%20Browser`,
      profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (t) => t.url.includes(`deck=${DECK_ID}`) && !t.url.includes('present.html'),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);

    await eventually(async () => editor!.evaluate<boolean>(`(() => Boolean(
      document.querySelector('#canvas .slide')
      && document.querySelector('[data-element-id="bordered"] img')?.complete
      && document.querySelector('[data-element-id="spilltext"]')
    ))()`), 'the browser editor never finished painting the slide');

    const view = await editor.evaluate<Viewport>(VIEWPORT);

    /** The colour actually on screen at a point, decoded by the page itself. */
    const colourAt = async (x: number, y: number): Promise<[number, number, number]> => {
      const shot = await editor!.call('Page.captureScreenshot', {
        format: 'png',
        clip: { x: x - 1, y: y - 1, width: 3, height: 3, scale: 1 },
        captureBeyondViewport: false,
      });
      return editor!.evaluate<[number, number, number]>(`(async () => {
        const image = new Image();
        image.src = 'data:image/png;base64,${shot.data}';
        await image.decode();
        const surface = document.createElement('canvas');
        surface.width = image.width;
        surface.height = image.height;
        const ctx = surface.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const px = ctx.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data;
        return [px[0], px[1], px[2]];
      })()`);
    };
    const toScreen = (x: number, y: number) => ({
      x: view.left + x * view.scale,
      y: view.top + y * view.scale,
    });

    // --- the border must not paint over the element in front of it ---------
    // Slide (580, 400) is inside the red border band (x 560..600) and inside
    // the blue rectangle (x 500..900, y 300..500). Blue is in front.
    const overlap = toScreen(580, 400);
    const [r1, g1, b1] = await colourAt(overlap.x, overlap.y);
    expect(b1).toBeGreaterThan(200);
    expect(r1).toBeLessThan(80);
    expect(g1).toBeLessThan(80);
    // The border is still painted where nothing covers it.
    const bareBorder = toScreen(580, 250);
    const [r2, g2, b2] = await colourAt(bareBorder.x, bareBorder.y);
    expect(r2).toBeGreaterThan(200);
    expect(g2).toBeLessThan(80);
    expect(b2).toBeLessThan(80);

    // --- content past the slide edge must stay visible ---------------------
    // 12 CSS px to the right of the slide's right edge, which the editor's
    // 32px fit margin guarantees is still inside the canvas viewport.
    const past = { x: view.right + 12, y: toScreen(0, 500).y };
    expect(past.x).toBeLessThan(await editor.evaluate<number>(
      "document.getElementById('canvas').getBoundingClientRect().right",
    ));
    const [r3, g3, b3] = await colourAt(past.x, past.y);
    expect(g3).toBeGreaterThan(200);
    expect(r3).toBeLessThan(80);
    expect(b3).toBeLessThan(80);

    // --- clicking spilled text selects the box it belongs to ---------------
    const painted = await editor.evaluate<{ boxBottom: number; contentBottom: number }>(`(() => {
      const node = document.querySelector('[data-element-id="spilltext"]');
      const content = node.querySelector(':scope > .text-body > .text-content');
      return { boxBottom: node.offsetHeight, contentBottom: content.offsetTop + content.offsetHeight };
    })()`);
    // The premise: the text really does paint outside its own box.
    expect(painted.contentBottom).toBeGreaterThan(painted.boxBottom + 20);

    const click = toScreen(300, 800 + painted.boxBottom + 20);
    await editor.clickAt(click.x, click.y);
    const selected = await editor.evaluate<string[]>(
      `[...window.store.get().selection]`);
    expect(selected).toEqual(['spilltext']);
  }, 180_000);
});
