import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import {
  nextLeavesPresentationRange,
  prevLeavesPresentationRange,
  rangeForSlideSelection,
} from '../src/shared/presentationRange.js';

function slides(count = 5) {
  const base = emptyDeck().slides[0];
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(base),
    id: `slide-${index + 1}`,
  }));
}

describe('presenting a slide selection', () => {
  it('uses the first and last selected slides in deck order for a multi-selection', () => {
    const deckSlides = slides();
    expect(rangeForSlideSelection(deckSlides, new Set(['slide-4', 'slide-2', 'slide-3'])))
      .toEqual({ start: 1, end: 3 });
  });

  it('keeps the normal start-here behaviour for a single selected slide', () => {
    expect(rangeForSlideSelection(slides(), new Set(['slide-3']))).toBeNull();
  });

  it('ends after the last build of the last selected slide', () => {
    const deckSlides = slides();
    const range = { start: 1, end: 3 };
    deckSlides[3].elements.push({
      id: 'reveal', type: 'text', x: 0, y: 0, w: 100, h: 100,
      rot: 0, z: 0, opacity: 1, class: [], style: {}, html: 'Reveal',
      align: 'left', valign: 'top',
    });
    deckSlides[3].timeline.push({
      id: 'build',
      trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: 'reveal', value: null },
    });
    expect(nextLeavesPresentationRange(deckSlides, { slide: 2, step: 0 }, range)).toBe(false);
    expect(nextLeavesPresentationRange(deckSlides, { slide: 3, step: 0 }, range)).toBe(false);
    expect(nextLeavesPresentationRange(deckSlides, { slide: 3, step: 1 }, range)).toBe(true);
  });

  it('does not navigate backward before the first selected slide', () => {
    const deckSlides = slides();
    const range = { start: 1, end: 3 };
    expect(prevLeavesPresentationRange(deckSlides, { slide: 2, step: 0 }, range)).toBe(false);
    expect(prevLeavesPresentationRange(deckSlides, { slide: 1, step: 0 }, range)).toBe(true);
  });

  it('ends without flashing an unselected slide when the range ends in skipped slides', () => {
    const deckSlides = slides();
    deckSlides[3].skipped = true;
    expect(nextLeavesPresentationRange(
      deckSlides,
      { slide: 2, step: 0 },
      { start: 1, end: 3 },
    )).toBe(true);
  });
});
