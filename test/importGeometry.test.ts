import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Deck, parseDeck } from '../src/shared/deck.js';

/**
 * Geometry sanity checks on an imported deck.
 *
 * "Every element is roughly inside the canvas" is not a proof of correct
 * layout, but it is a cheap and surprisingly sharp test: the ways geometry
 * import goes wrong — a wrong origin convention, an unapplied group offset, a
 * missing scale — almost always push objects off the slide, and they show up
 * here immediately.
 */

const DECK_DIR = join(process.cwd(), 'decks/test-presentation');
const ready = existsSync(join(DECK_DIR, 'deck.json'));

async function loadDeck(): Promise<Deck> {
  return parseDeck(JSON.parse(await readFile(join(DECK_DIR, 'deck.json'), 'utf8')));
}

/**
 * Fraction of an element that must overlap the canvas. Presenters do park
 * spare objects off-slide in Keynote, so this is not zero-tolerance — but an
 * element with almost no overlap is a geometry bug, not a parked object.
 */
const MIN_OVERLAP = 0.5;

function overlapFraction(
  el: { x: number; y: number; w: number; h: number },
  canvas: { w: number; h: number },
): number {
  const overlapW = Math.max(0, Math.min(el.x + el.w, canvas.w) - Math.max(el.x, 0));
  const overlapH = Math.max(0, Math.min(el.y + el.h, canvas.h) - Math.max(el.y, 0));
  return (overlapW * overlapH) / (el.w * el.h);
}

describe.skipIf(!ready)('imported geometry', () => {
  it('places images and video on the slide', async () => {
    const deck = await loadDeck();
    const offenders: string[] = [];

    for (const [index, slide] of deck.slides.entries()) {
      for (const el of slide.elements) {
        if (el.type !== 'image' && el.type !== 'video') continue;
        const overlap = overlapFraction(el, deck.canvas);
        if (overlap < MIN_OVERLAP) {
          offenders.push(
            `slide ${index + 1} ${el.type} ${el.id} at ${el.x},${el.y} ${el.w}x${el.h} — only ${(overlap * 100).toFixed(0)}% on slide`,
          );
        }
      }
    }

    expect(offenders, `${offenders.length} media elements land off-slide:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('does not import media at absurd scale', async () => {
    const deck = await loadDeck();
    const { w, h } = deck.canvas;
    const offenders: string[] = [];

    for (const [index, slide] of deck.slides.entries()) {
      for (const el of slide.elements) {
        // Shapes are exempt from the minimum: a rule or connector line is
        // legitimately zero-width, and its stroke supplies the visible size.
        const tooSmall = el.type !== 'shape' && (el.w < 4 || el.h < 4);
        if (el.w > w * 2 || el.h > h * 2 || tooSmall) {
          offenders.push(`slide ${index + 1} ${el.type} ${el.id} is ${el.w}x${el.h}`);
        }
      }
    }

    expect(offenders, offenders.slice(0, 20).join('\n')).toEqual([]);
  });

  it('gives text boxes a legible font size', async () => {
    const deck = await loadDeck();
    const offenders: string[] = [];

    for (const [index, slide] of deck.slides.entries()) {
      for (const el of slide.elements) {
        if (el.type !== 'text') continue;
        const size = Number.parseFloat(el.style['font-size'] ?? '0');
        // Display type runs large — a single "+" between two panels is
        // legitimately 200px — so this only catches runaway values.
        if (size && (size < 10 || size > 300)) {
          offenders.push(`slide ${index + 1} ${el.id} font-size ${size}px`);
        }
        // A text box narrower than a few characters renders one letter per
        // line, which is the "vertical text" failure mode.
        if (el.w < 60) {
          offenders.push(
            `slide ${index + 1} ${el.id} is only ${el.w}px wide (text would stack vertically)`,
          );
        }
        // A box far taller than its text can fill means the size estimate for
        // an auto-sizing box ran away.
        if (size && el.h > size * 30) {
          offenders.push(
            `slide ${index + 1} ${el.id} is ${el.h}px tall at ${size}px font`,
          );
        }
      }
    }

    expect(offenders, offenders.slice(0, 20).join('\n')).toEqual([]);
  });
});
