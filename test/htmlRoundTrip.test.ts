import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Deck, type Slide, parseDeck } from '../src/shared/deck.js';
import { slideToHtml } from '../src/shared/htmlSlides.js';
import { compileHtmlToSlides } from '../src/cli/compileHtml.js';
import { loadDeck } from '../src/main/deckStore.js';

/**
 * The acid test for HTML authoring: export a deck to HTML, compile it straight
 * back, and demand the deck be unchanged.
 *
 * Every fidelity bug in this path has been silent — a rotated rule measured as
 * a different shape, theme colours frozen onto elements, `#000000` rewritten as
 * `rgb(0, 0, 0)` on every save. None of them throws; all of them corrupt a real
 * deck. Only a full round trip over a real, messy, imported deck catches them,
 * which is also why this doubles as the harness for improving the importer:
 * author slides, import them, and diff what came back.
 *
 * Needs a real browser, so it runs where Electron is installed and skips
 * politely where it is not.
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

/** Geometry within a pixel; everything else exact. */
function differences(before: Deck, after: Slide[]): string[] {
  const problems: string[] = [];
  if (before.slides.length !== after.length) {
    return [`slide count ${before.slides.length} -> ${after.length}`];
  }

  before.slides.forEach((original, index) => {
    const rebuilt = after[index];
    if (original.id !== rebuilt.id) problems.push(`slide ${index}: id ${original.id} -> ${rebuilt.id}`);
    if (JSON.stringify(original.background) !== JSON.stringify(rebuilt.background)) {
      problems.push(`${original.id}: background changed`);
    }
    const originalElements = new Map(original.elements.map((element) => [element.id, element]));
    const rebuiltElements = new Map(rebuilt.elements.map((element) => [element.id, element]));
    for (const id of originalElements.keys()) {
      if (!rebuiltElements.has(id)) problems.push(`${original.id}: lost element ${id}`);
    }
    for (const id of rebuiltElements.keys()) {
      if (!originalElements.has(id)) problems.push(`${original.id}: invented element ${id}`);
    }

    for (const [id, element] of originalElements) {
      const rebuiltElement = rebuiltElements.get(id);
      if (!rebuiltElement) continue;
      for (const [key, value] of Object.entries(element)) {
        // Paint order is renumbered densely; what matters is that it is
        // preserved, which is asserted separately below.
        if (key === 'z') continue;
        const other = (rebuiltElement as Record<string, unknown>)[key];
        if (typeof value === 'number' && typeof other === 'number') {
          if (Math.abs(value - other) > 1) problems.push(`${id}.${key}: ${value} -> ${other}`);
        } else if (JSON.stringify(value) !== JSON.stringify(other)) {
          problems.push(`${id}.${key}: ${JSON.stringify(value)} -> ${JSON.stringify(other)}`);
        }
      }
    }
  });
  return problems;
}

describe.skipIf(!runnable)('HTML round trip', () => {
  let dir: string;
  let before: Deck;
  let rebuilt: Slide[];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'html-round-trip-'));
    await cp(FIXTURE, dir, { recursive: true });
    before = await loadDeck(dir);

    const html = before.slides
      .map((slide) => slideToHtml(slide, before.canvas))
      .join('\n\n');
    const htmlPath = join(dir, 'slides.html');
    await import('node:fs/promises').then((fs) => fs.writeFile(htmlPath, html, 'utf8'));

    rebuilt = (await compileHtmlToSlides({ deckDir: dir, deck: before, htmlPath })).slides;
  }, 180_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('actually round-tripped a real, non-trivial deck', () => {
    // Guards the guard: a silently empty compile would make every other
    // assertion here vacuously true.
    expect(before.slides.length).toBeGreaterThan(15);
    expect(rebuilt.length).toBe(before.slides.length);
    expect(rebuilt.flatMap((slide) => slide.elements).length).toBeGreaterThan(40);
  });

  it('returns every slide unchanged', () => {
    expect(differences(before, rebuilt)).toEqual([]);
  });

  it('preserves paint order even though z is renumbered', () => {
    before.slides.forEach((original, index) => {
      const order = (slide: Slide) => [...slide.elements]
        .sort((a, b) => a.z - b.z)
        .map((element) => element.id);
      expect(order(rebuilt[index]), `slide ${original.id}`).toEqual(order(original));
    });
  });

  it('keeps rotated objects the shape they were', () => {
    // A bounding rect is axis-aligned: without care a 543x1 rule at 90 degrees
    // measures 1x543 and silently becomes a different object.
    const rotated = before.slides.flatMap((slide, index) => slide.elements
      .filter((element) => element.rot !== 0)
      .map((element) => ({ element, rebuilt: rebuilt[index].elements.find((e) => e.id === element.id) })));

    expect(rotated.length).toBeGreaterThan(0);
    for (const { element, rebuilt: after } of rotated) {
      expect(after, element.id).toBeDefined();
      expect(Math.abs(after!.w - element.w), `${element.id} width`).toBeLessThanOrEqual(1);
      expect(Math.abs(after!.h - element.h), `${element.id} height`).toBeLessThanOrEqual(1);
      expect(Math.abs(after!.rot - element.rot), `${element.id} rotation`).toBeLessThanOrEqual(1);
    }
  });

  it('does not freeze theme values onto elements', async () => {
    // Elements must only carry styles their author wrote inline; anything
    // inherited has to keep coming from theme.css, or editing the theme later
    // stops working.
    const authored = new Set(before.slides.flatMap((slide) =>
      slide.elements.flatMap((element) => Object.keys(element.style))));
    const produced = new Set(rebuilt.flatMap((slide) =>
      slide.elements.flatMap((element) => Object.keys(element.style))));

    for (const property of produced) expect([...authored]).toContain(property);
    // And the deck's own stylesheet is untouched by a round trip.
    expect(await readFile(join(dir, 'theme.css'), 'utf8'))
      .toBe(await readFile(join(FIXTURE, 'theme.css'), 'utf8'));
  });
});

describe.skipIf(runnable)('HTML round trip (skipped)', () => {
  it('needs Electron and the reference deck', () => {
    expect(runnable).toBe(false);
  });
});

// Re-parsing guards against a slide that only validates by accident.
export const _ = parseDeck;
