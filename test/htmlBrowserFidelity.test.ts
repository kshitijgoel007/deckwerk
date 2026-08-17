import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Deck, Slide } from '../src/shared/deck.js';
import { slidesFromMeasured, type MeasuredSlide } from '../src/shared/htmlSlides.js';
import { measureSavedPage } from '../src/cli/compileHtml.js';
import { loadDeck } from '../src/main/deckStore.js';
import { writeHtmlScope } from '../src/main/htmlAuthoring.js';

/**
 * What the author opens *is* what the editor compiles.
 *
 * The whole premise of HTML authoring is that a person and an agent edit a file
 * together, looking at it in a browser, and the editor bakes back what that
 * browser laid out. If opening the file shows something other than the slide,
 * the surface is a lie: the author is editing markup whose appearance they can
 * only discover by saving it.
 *
 * This is deliberately the *unhelped* path. The file is loaded from where it
 * was written, by its own URL, with nothing assembled around it and no base
 * rewritten — exactly what a double-click does. Every other test here goes
 * through the compiler's page assembly, which is what let an export that was a
 * bare fragment — no doctype, no canvas box, no theme, assets resolving one
 * folder too deep — pass a full round trip: the compiler quietly supplied
 * everything the browser was missing, so the two pages were never compared.
 */

const electronPath = (): string | null => {
  try {
    const path = createRequire(import.meta.url)('electron') as unknown as string;
    return typeof path === 'string' && existsSync(path) ? path : null;
  } catch {
    return null;
  }
};

const FIXTURE = join(process.cwd(), 'examples', 'reference');
const runnable = electronPath() !== null && existsSync(join(FIXTURE, 'deck.json'));

/** Every asset the page asked for, and whether the browser actually got it. */
const ASSET_REPORT = `(() => ([...document.images].map((image) => ({
  src: image.getAttribute('src'),
  loaded: image.complete && image.naturalWidth > 0,
}))))()`;

/** What the page believes about itself, once the browser has parsed it. */
const PAGE_REPORT = `(() => {
  const slide = document.querySelector('section.slide');
  const box = slide.getBoundingClientRect();
  const title = document.querySelector('.role-title, .title, h1');
  return {
    mode: document.compatMode,
    slideWidth: box.width,
    slideHeight: box.height,
    slidePosition: getComputedStyle(slide).position,
    stylesheets: document.styleSheets.length,
    background: getComputedStyle(slide).backgroundColor,
    titleFontSize: title ? getComputedStyle(title).fontSize : null,
    titleFontFamily: title ? getComputedStyle(title).fontFamily : null,
  };
})()`;

describe.skipIf(!runnable)('the exported file, opened as a file', () => {
  let dir: string;
  let deck: Deck;
  let htmlPath: string;
  let rebuilt: Slide[];
  let page: Record<string, unknown>;
  let assets: Array<{ src: string; loaded: boolean }>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'html-browser-'));
    await cp(FIXTURE, dir, { recursive: true });
    deck = await loadDeck(dir);

    // The export the toolbar writes, in the folder it writes it to. Where the
    // file sits is part of what is under test: its assets and its stylesheet
    // are resolved relative to it.
    const written = await writeHtmlScope(dir, deck, deck.slides.map((slide) => slide.id));
    htmlPath = written.path;

    const measured = await measureSavedPage(htmlPath, deck.canvas) as MeasuredSlide[];
    rebuilt = slidesFromMeasured(deck, measured);
    page = await measureSavedPage(htmlPath, deck.canvas, PAGE_REPORT) as Record<string, unknown>;
    assets = await measureSavedPage(htmlPath, deck.canvas, ASSET_REPORT) as typeof assets;
  }, 180_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('is a standards-mode page with the deck\'s stylesheet attached', async () => {
    // Quirks mode alone changes box sizing, and it is one missing doctype away.
    expect(page.mode).toBe('CSS1Compat');
    expect(page.stylesheets as number).toBeGreaterThanOrEqual(3);
    expect(await readFile(htmlPath, 'utf8')).toContain(`href="${deck.theme}"`);
  });

  it('shows a slide-shaped slide rather than a run of loose markup', () => {
    // Without the canvas box every absolutely positioned object in the file
    // positions against the viewport instead of the slide.
    expect(page.slideWidth).toBe(deck.canvas.w);
    expect(page.slideHeight).toBe(deck.canvas.h);
    expect(page.slidePosition).toBe('relative');
    expect(page.background).not.toBe('rgba(0, 0, 0, 0)');
  });

  it('applies the deck\'s typography, not the browser\'s defaults', () => {
    // 16px Times is what an unthemed page looks like, and it is what the
    // compiler would then bake into every text box on the slide.
    expect(page.titleFontSize).not.toBe('16px');
    expect(Number.parseFloat(String(page.titleFontSize))).toBeGreaterThan(40);
    expect(String(page.titleFontFamily)).not.toMatch(/^Times/);
  });

  it('resolves every asset from where the file actually lives', () => {
    // An image with an explicit width still *measures* right when its src is
    // broken, so geometry cannot catch this one — only the browser can.
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.filter((asset) => !asset.loaded)).toEqual([]);
  });

  it('lays out every slide exactly as the deck says it should', () => {
    // The payoff: what the browser shows the author, measured, is the deck.
    expect(rebuilt.length).toBe(deck.slides.length);
    expect(rebuilt.flatMap((slide) => slide.elements).length).toBeGreaterThan(40);
    expect(geometryDifferences(deck, rebuilt)).toEqual([]);
  });
});

/** Every element's box as the browser laid it out, against the deck's own. */
function geometryDifferences(deck: Deck, rendered: Slide[]): string[] {
  const problems: string[] = [];
  deck.slides.forEach((original, index) => {
    const after = rendered[index];
    if (!after) {
      problems.push(`slide ${original.id} did not render`);
      return;
    }
    const boxes = new Map(after.elements.map((element) => [element.id, element]));
    for (const element of original.elements) {
      const box = boxes.get(element.id);
      if (!box) {
        problems.push(`${original.id}: lost ${element.id}`);
        continue;
      }
      for (const key of ['x', 'y', 'w', 'h'] as const) {
        // A pixel of slack: the browser measures in fractions and the deck
        // stores what a previous browser measured.
        if (Math.abs(element[key] - box[key]) > 1) {
          problems.push(`${element.id}.${key}: ${element[key]} -> ${box[key]}`);
        }
      }
    }
  });
  return problems;
}

describe.skipIf(runnable)('the exported file, opened as a file (skipped)', () => {
  it('needs Electron and the reference deck', () => {
    expect(runnable).toBe(false);
  });
});
