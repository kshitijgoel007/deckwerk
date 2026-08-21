import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyDeck } from '../src/shared/deck.js';
import { pdfPageCount, pdfSteps } from '../src/shared/pdfExport.js';

describe('PDF build-state selection', () => {
  it('exports opening, final, or every distinct click state', () => {
    const deck = emptyDeck();
    const slide = deck.slides[0];
    slide.elements.push({
      id: 'text-1', type: 'text', x: 0, y: 0, w: 100, h: 100, rot: 0, z: 0,
      opacity: 1, class: [], style: {}, html: 'A', align: 'left', valign: 'top',
    });
    slide.timeline = [
      { id: 'a', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'appear', target: 'text-1', value: null } },
      { id: 'b', trigger: { on: 'afterPrev', ref: 'a', delay: 100 }, action: { type: 'addClass', target: 'text-1', value: 'hot' } },
      { id: 'c', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'disappear', target: 'text-1', value: null } },
    ];
    expect(pdfSteps(slide, 'initial')).toEqual([0]);
    expect(pdfSteps(slide, 'final')).toEqual([2]);
    expect(pdfSteps(slide, 'every')).toEqual([0, 1, 2]);
  });

  it('excludes hidden slides unless requested', () => {
    const deck = emptyDeck();
    deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'hidden', skipped: true });
    expect(pdfPageCount(deck.slides, 'initial')).toBe(1);
    expect(pdfPageCount(deck.slides, 'initial', true)).toBe(2);
  });

  it('prints in the Player canvas coordinate system without a Retina-sensitive transform', () => {
    // The page layout is shared by the desktop exporter and the collab client's
    // print tab, so this belongs to `pages.ts` rather than either entry point.
    const source = readFileSync(join(process.cwd(), 'src/renderer/print/pages.ts'), 'utf8');
    expect(source).toContain('size: ${deck.canvas.w}px ${deck.canvas.h}px');
    expect(source).not.toContain('stage.style.transform');
    expect(source).not.toContain('const pageWidthIn');
  });
});
