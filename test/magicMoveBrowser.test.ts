import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck, type Slide, type SlideElement } from '../src/shared/deck.js';
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
 * Magic Move, measured on real slides in a real browser.
 *
 * `test/magicMoveTransform.test.ts` proves the arithmetic against described
 * layouts. This proves the layouts: the deck below is a spread of the things
 * that actually break a transition — an alignment change, boxes that resize
 * without their text moving, auto-fit and condensed no-wrap lines, rotated
 * type, KaTeX, hairline rules, flipped shapes, images — paired through Magic
 * Move and played by the production Player in the production Present view.
 *
 * The assertion is the one that matters: freeze every transition at offset 0
 * and each paired object must be sitting exactly where its source object was
 * sitting on the slide before. Anything else is a fly-in.
 */

const DECK_ID = 'magic-move-geometry';
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Every paired object's rendered geometry, keyed by element id. */
interface Frame {
  slideId: string;
  boxes: Record<string, { left: number; top: number; right: number; bottom: number }>;
  inks: Record<string, { left: number; top: number; right: number; bottom: number }>;
}

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let presentation: Cdp | null = null;

afterEach(async () => {
  presentation?.close();
  presentation = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

const base = {
  rot: 0, z: 1, opacity: 1, class: [] as string[], style: {} as Record<string, string>,
};

function textElement(
  over: Partial<Extract<SlideElement, { type: 'text' }>> & { id: string; magicMoveId?: string },
): SlideElement {
  return {
    type: 'text', x: 0, y: 0, w: 800, h: 200, ...base, class: ['role-title'],
    html: 'Placeholder', align: 'left', valign: 'top', ...over,
  } as SlideElement;
}

function shapeElement(
  over: Partial<Extract<SlideElement, { type: 'shape' }>> & { id: string },
): SlideElement {
  return {
    type: 'shape', shape: 'rect', x: 0, y: 0, w: 200, h: 200, ...base,
    fill: '#2563eb', stroke: null, strokeWidth: 0, radius: 0, path: null,
    pathSize: null, arrowStart: false, arrowEnd: false, ...over,
  } as SlideElement;
}

function slide(id: string, elements: SlideElement[], magicMove: boolean): Slide {
  return {
    id, name: id, background: { color: null, image: null }, notes: '', timeline: [],
    elements,
    ...(magicMove ? { magicMoveFromPrevious: true, magicMoveDuration: 5000 } : {}),
  } as Slide;
}

/**
 * A deck whose every transition is a different way of moving the same objects.
 * Text is kept to a single line on both sides of a pair wherever the box
 * changes, so a pair's ink boxes are genuinely the same shape up to its font
 * scale and can be compared edge for edge; the one deliberate re-wrap is
 * checked more loosely, by where the block starts.
 */
function fixtureDeck(imageSrc: string): Deck {
  const deck = emptyDeck('Magic Move geometry');
  const warmUp = slide('warm-up', [
    textElement({ id: 'warm', html: 'Warm up', x: 200, y: 400, w: 900, h: 200 }),
  ], false);

  const first = slide('first', [
    // A centred hero title in a full-bleed box.
    textElement({
      id: 'title-1', magicMoveId: 'title', html: 'Magic Move',
      x: 0, y: 380, w: 1920, h: 300, align: 'center', valign: 'middle',
      style: { 'font-size': '128px' },
    }),
    // A body box that will grow without its text moving.
    textElement({
      id: 'body-1', magicMoveId: 'body', class: ['role-body'], html: 'Body copy stays put',
      x: 160, y: 760, w: 700, h: 120, style: { 'font-size': '40px' },
    }),
    // An auto-fitting no-wrap line that has to shrink into a smaller box.
    textElement({
      id: 'fit-1', magicMoveId: 'fit', html: 'Auto-fitted single line',
      x: 160, y: 120, w: 1100, h: 120, noWrap: true, autoFit: true,
      style: { 'font-size': '72px' },
    }),
    // A condensed no-wrap line: same font size, squeezed horizontally.
    textElement({
      id: 'condense-1', magicMoveId: 'condense',
      html: 'A deliberately overlong condensed line of type',
      x: 1300, y: 120, w: 480, h: 100, noWrap: true, noWrapMode: 'condense',
      style: { 'font-size': '48px' },
    }),
    // Rotated type.
    textElement({
      id: 'rot-1', magicMoveId: 'rot', html: 'Tilted', rot: 15,
      x: 1400, y: 700, w: 400, h: 120, align: 'center', style: { 'font-size': '56px' },
    }),
    // Math, which lays out as boxes rather than plain glyphs.
    textElement({
      id: 'math-1', magicMoveId: 'math', html: 'Energy $E = mc^2$ today',
      x: 200, y: 950, w: 800, h: 100, align: 'center', style: { 'font-size': '44px' },
    }),
    shapeElement({ id: 'rect-1', magicMoveId: 'rect', x: 1500, y: 900, w: 300, h: 140 }),
    shapeElement({
      id: 'arrow-1', magicMoveId: 'arrow', shape: 'arrow', rot: 90, arrowEnd: true,
      x: 1000, y: 600, w: 300, h: 2, fill: null, stroke: '#111827', strokeWidth: 6,
    }),
    shapeElement({
      id: 'rule-1', magicMoveId: 'rule', shape: 'line', x: 900, y: 200, w: 240, h: 2,
      fill: null, stroke: '#111827', strokeWidth: 4,
    }),
    {
      id: 'image-1', magicMoveId: 'image', type: 'image', src: imageSrc, ...base,
      x: 1200, y: 300, w: 200, h: 200, fit: 'fill', alt: '', sourceBox: null,
    } as SlideElement,
    // Unpaired: leaves as a ghost, so the pairs share the stage with fades.
    shapeElement({ id: 'leaving', x: 40, y: 40, w: 120, h: 120, fill: '#dc2626' }),
  ], true);

  const second = slide('second', [
    // Same title, now small, left-aligned and top-anchored: the alignment
    // change is what used to start it half a title-width off.
    textElement({
      id: 'title-2', magicMoveId: 'title', html: 'Magic Move',
      x: 120, y: 80, w: 1400, h: 160, align: 'left', valign: 'top',
      style: { 'font-size': '64px' },
    }),
    textElement({
      id: 'body-2', magicMoveId: 'body', class: ['role-body'], html: 'Body copy stays put',
      x: 160, y: 760, w: 1500, h: 120, style: { 'font-size': '40px' },
    }),
    textElement({
      id: 'fit-2', magicMoveId: 'fit', html: 'Auto-fitted single line',
      x: 900, y: 400, w: 520, h: 80, noWrap: true, autoFit: true,
      style: { 'font-size': '72px' },
    }),
    textElement({
      id: 'condense-2', magicMoveId: 'condense',
      html: 'A deliberately overlong condensed line of type',
      x: 200, y: 560, w: 900, h: 100, noWrap: true, noWrapMode: 'condense',
      style: { 'font-size': '48px' },
    }),
    textElement({
      id: 'rot-2', magicMoveId: 'rot', html: 'Tilted', rot: -12,
      x: 300, y: 300, w: 400, h: 120, align: 'center', style: { 'font-size': '56px' },
    }),
    textElement({
      id: 'math-2', magicMoveId: 'math', html: 'Energy $E = mc^2$ today',
      x: 1000, y: 980, w: 800, h: 100, align: 'right', style: { 'font-size': '44px' },
    }),
    // Flipped on this slide, plain on the next: the authored transform has to
    // survive both directions.
    shapeElement({
      id: 'rect-2', magicMoveId: 'rect', x: 300, y: 900, w: 500, h: 100,
      style: { transform: 'scaleX(-1)' },
    }),
    shapeElement({
      id: 'arrow-2', magicMoveId: 'arrow', shape: 'arrow', rot: 24, arrowEnd: true,
      x: 1400, y: 500, w: 420, h: 2, fill: null, stroke: '#111827', strokeWidth: 6,
    }),
    // A hairline rule: dividing by its box width is how a transform ends up
    // scaled into the thousands.
    shapeElement({
      id: 'rule-2', magicMoveId: 'rule', shape: 'line', x: 400, y: 460, w: 0.01, h: 200,
      fill: null, stroke: '#111827', strokeWidth: 4,
    }),
    {
      id: 'image-2', magicMoveId: 'image', type: 'image', src: imageSrc, ...base,
      x: 60, y: 620, w: 420, h: 120, fit: 'fill', alt: '', sourceBox: null,
    } as SlideElement,
    // Arriving unpaired: fades in, and must not disturb the movers.
    shapeElement({ id: 'arriving', x: 1760, y: 40, w: 120, h: 120, fill: '#16a34a' }),
  ], true);

  const third = slide('third', [
    // Right/bottom aligned in a huge box: the third distinct alignment for
    // the same object.
    textElement({
      id: 'title-3', magicMoveId: 'title', html: 'Magic Move',
      x: 200, y: 200, w: 1500, h: 700, align: 'right', valign: 'bottom',
      style: { 'font-size': '96px' },
    }),
    // The deliberate re-wrap: one line becomes two, so only the start of the
    // block can be compared.
    textElement({
      id: 'body-3', magicMoveId: 'body', class: ['role-body'], html: 'Body copy stays put',
      x: 160, y: 40, w: 320, h: 200, style: { 'font-size': '40px' },
    }),
    textElement({
      id: 'rot-3', magicMoveId: 'rot', html: 'Tilted', rot: 0,
      x: 1500, y: 120, w: 400, h: 120, align: 'center', style: { 'font-size': '56px' },
    }),
    shapeElement({ id: 'rect-3', magicMoveId: 'rect', x: 1400, y: 960, w: 400, h: 80 }),
    {
      id: 'image-3', magicMoveId: 'image', type: 'image', src: imageSrc, ...base,
      x: 900, y: 700, w: 260, h: 260, fit: 'fill', alt: '', sourceBox: null,
    } as SlideElement,
  ], true);

  deck.slides = [warmUp, first, second, third];
  return deck;
}

/** Read every element's rendered box, and every text's rendered ink box. */
const CAPTURE = `(() => {
  const slide = document.querySelector('.slide');
  const round = (rect) => ({
    left: Math.round(rect.left * 100) / 100,
    top: Math.round(rect.top * 100) / 100,
    right: Math.round(rect.right * 100) / 100,
    bottom: Math.round(rect.bottom * 100) / 100,
  });
  const boxes = {};
  const inks = {};
  for (const node of slide.querySelectorAll('[data-element-id]')) {
    const id = node.dataset.elementId;
    boxes[id] = round(node.getBoundingClientRect());
    const content = node.querySelector('.text-content');
    if (content) {
      const range = document.createRange();
      range.selectNodeContents(content);
      inks[id] = round(range.getBoundingClientRect());
    }
  }
  return { slideId: slide.dataset.slideId, boxes, inks };
})()`;

/**
 * Advance one slide and freeze every animation at its first frame, then report
 * the geometry before and after. Both happen in one page turn so no frame of
 * the transition can elapse between them.
 */
const ADVANCE_AND_FREEZE = `(() => {
  const capture = () => ${CAPTURE};
  const before = capture();
  window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  for (const animation of document.getAnimations()) {
    animation.pause();
    animation.currentTime = 0;
  }
  const after = capture();
  // Hand the slide back to CSS so the next transition starts from the settled
  // render rather than from this frozen first frame.
  for (const animation of document.getAnimations()) animation.cancel();
  return { before, after };
})()`;

/**
 * The point an object is pinned to, as a fraction of its rendered box: the
 * corner or edge its alignment anchors the text to, and the centre for
 * everything else.
 */
function anchorFraction(element: SlideElement): { x: number; y: number } {
  if (element.type !== 'text') return { x: 0.5, y: 0.5 };
  return {
    x: { left: 0, center: 0.5, right: 1, justify: 0 }[element.align] ?? 0,
    y: { top: 0, middle: 0.5, bottom: 1 }[element.valign] ?? 0,
  };
}

describe.skipIf(!electronBinary)('Magic Move geometry in the browser', () => {
  it('starts every paired object exactly where its source object was', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'magic-move-browser-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = join(workDir, 'client');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(deckDir, 'assets', 'dot.png'),
      Buffer.from(PNG_BASE64, 'base64'),
    );
    await saveDeck(deckDir, fixtureDeck('assets/dot.png'));
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #ffffff; color: #111827; }',
      '.role-title { font: 700 96px/1.1 sans-serif; }',
      '.role-body { font: 400 40px/1.3 sans-serif; }',
      '',
    ].join('\n'), 'utf8');

    await build({
      configFile: join(process.cwd(), 'vite.collab.config.ts'),
      logLevel: 'silent',
      build: { outDir: clientDir, emptyOutDir: true },
    });
    server = await startCollabServer({
      rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
    });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/present.html?deck=${DECK_ID}`,
      profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.includes('/present.html'),
      browser.log,
    );
    presentation = await Cdp.connect(target.webSocketDebuggerUrl!);

    // Wait for the deck, its web fonts and its image: every measurement below
    // is a layout measurement, and an unloaded font re-lays-out the text.
    await eventually(async () => presentation!.evaluate<string>(`(async () => {
      await document.fonts.ready;
      const image = document.querySelector('img');
      return (document.querySelector('.slide')?.dataset.slideId ?? '') +
        (image && !image.complete ? ':loading' : '');
    })()`), 'the presentation never painted the warm-up slide',
    (value) => value === 'warm-up');

    // The first click may be spent on the fullscreen gesture the Present view
    // owes the browser, so click until the deck actually moves.
    await eventually(async () => presentation!.evaluate<string>(`(() => {
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return document.querySelector('.slide')?.dataset.slideId ?? '';
    })()`), 'clicking never advanced past the warm-up slide',
    (value) => value === 'first');

    const deck = fixtureDeck('assets/dot.png');
    // Text whose line count changes cannot be compared edge for edge; only
    // where its block starts is meaningful.
    const rewrapped = new Set(['body-3']);
    // A hairline box cannot be scaled onto a 240px one without a scale in the
    // thousands, so the degenerate ratio is deliberately clamped: the rule
    // stays where its source was, at its own size.
    const unscalable = new Set(['rule-2', 'rule-3']);

    for (const step of [1, 2]) {
      const previous = deck.slides[step];
      const next = deck.slides[step + 1];
      const { before, after } = await presentation.evaluate<{
        before: Frame; after: Frame;
      }>(ADVANCE_AND_FREEZE);
      expect(before.slideId).toBe(previous.id);
      expect(after.slideId).toBe(next.id);

      const pairs = next.elements.flatMap((target) => {
        const source = previous.elements
          .find((candidate) => candidate.magicMoveId
            && candidate.magicMoveId === target.magicMoveId);
        return source ? [{ source, target }] : [];
      });
      // The fixture is only worth anything if it really is pairing objects.
      expect(pairs.length).toBeGreaterThanOrEqual(5);

      for (const { source, target } of pairs) {
        const isText = source.type === 'text' && target.type === 'text';
        const from = (isText ? before.inks : before.boxes)[source.id];
        const to = (isText ? after.inks : after.boxes)[target.id];
        expect(from, `${source.id} was never measured`).toBeTruthy();
        expect(to, `${target.id} was never measured`).toBeTruthy();
        const label = `${previous.id} -> ${next.id}: ${source.id} -> ${target.id}`;

        // The no-fly-in assertion: the point the object is anchored on has
        // to be the point its source was anchored on, to within a device
        // pixel or two of layout rounding.
        const anchor = anchorFraction(target);
        const at = (rect: typeof from, fraction: { x: number; y: number }) => ({
          x: rect.left + fraction.x * (rect.right - rect.left),
          y: rect.top + fraction.y * (rect.bottom - rect.top),
        });
        const started = at(to, anchor);
        const wanted = at(from, anchor);
        expect(Math.hypot(started.x - wanted.x, started.y - wanted.y), `${label} anchor`)
          .toBeLessThan(3);

        // And it has to be the same size, which for re-wrapped text it cannot
        // be. Text carries a few tenths of a percent of slack: tracking does
        // not scale with an auto-fitted font size (`letter-spacing: -0.02em`
        // resolves against the wrapper and inherits as pixels), so a shrunk
        // line is marginally narrower than its font ratio predicts. That is a
        // size difference the transition interpolates away, not a jump.
        if (rewrapped.has(target.id) || unscalable.has(target.id)) continue;
        const slack = source.type === 'text' ? 0.03 : 0.005;
        expect(
          Math.abs((to.right - to.left) - (from.right - from.left)),
          `${label} width: ${to.right - to.left} vs ${from.right - from.left}`,
        ).toBeLessThan(Math.max(2, slack * (from.right - from.left)));
        expect(
          Math.abs((to.bottom - to.top) - (from.bottom - from.top)),
          `${label} height: ${to.bottom - to.top} vs ${from.bottom - from.top}`,
        ).toBeLessThan(Math.max(2, slack * (from.bottom - from.top)));
      }
    }
  }, 240_000);
});
