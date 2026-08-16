// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { type Deck, parseDeck } from '../src/shared/deck.js';
import { renderSlide } from '../src/renderer/player/render.js';

/**
 * Cropping and trimming are done in CSS, not by re-encoding: instant,
 * reversible, and editable later. These tests pin the two properties that make
 * that work — a crop is a window onto a larger picture, and a trim is honoured
 * by the player rather than by the `loop` attribute.
 */

function deckWith(element: Record<string, unknown>): Deck {
  return parseDeck({
    version: 1,
    slides: [{ id: 's1', elements: [element] }],
  });
}

const render = (deck: Deck) =>
  renderSlide(deck.slides[0], { resolveSrc: (src) => src });

const VIDEO = {
  id: 'v1',
  type: 'video',
  x: 0,
  y: 0,
  w: 400,
  h: 300,
  src: 'assets/clip.mp4',
};

describe('CSS crop', () => {
  it('renders an uncropped image as a plain fitted picture', () => {
    const dom = render(
      deckWith({ id: 'i1', type: 'image', x: 0, y: 0, w: 400, h: 300, src: 'a.png' }),
    );
    const img = dom.querySelector('img')!;
    expect(img.style.width).toBe('100%');
    expect(img.parentElement?.style.overflow).not.toBe('hidden');
  });

  it('renders a cropped image as a window onto the full picture', () => {
    const dom = render(
      deckWith({
        id: 'i1',
        type: 'image',
        x: 0,
        y: 0,
        w: 400,
        h: 300,
        src: 'a.png',
        sourceBox: { x: -100, y: -50, w: 1600, h: 1200 },
      }),
    );
    const img = dom.querySelector('img')!;
    // The element box clips; the image keeps its full size behind it.
    expect(img.parentElement!.style.overflow).toBe('hidden');
    expect(img.style.left).toBe('-100px');
    expect(img.style.top).toBe('-50px');
    expect(img.style.width).toBe('1600px');
    expect(img.style.height).toBe('1200px');
  });

  it('crops video exactly as it crops images', () => {
    const dom = render(
      deckWith({ ...VIDEO, sourceBox: { x: -20, y: -10, w: 1280, h: 720 } }),
    );
    const video = dom.querySelector('video')!;
    expect(video.parentElement!.style.overflow).toBe('hidden');
    expect(video.style.left).toBe('-20px');
    expect(video.style.width).toBe('1280px');
  });
});

describe('trim', () => {
  it('uses the native loop attribute when there is no trim', () => {
    const dom = render(deckWith({ ...VIDEO, loop: true }));
    expect(dom.querySelector('video')!.loop).toBe(true);
  });

  it('disables native looping once an in-point is set', () => {
    // `loop` always restarts at zero, which would replay exactly the material
    // the trim removed. The player loops start -> end instead.
    const dom = render(deckWith({ ...VIDEO, loop: true, start: 2 }));
    expect(dom.querySelector('video')!.loop).toBe(false);
  });

  it('disables native looping once an out-point is set', () => {
    const dom = render(deckWith({ ...VIDEO, loop: true, end: 5 }));
    expect(dom.querySelector('video')!.loop).toBe(false);
  });

  it('keeps the trim points on the element for the player to honour', () => {
    const deck = deckWith({ ...VIDEO, start: 1.5, end: 4 });
    const el = deck.slides[0].elements[0];
    if (el.type !== 'video') throw new Error('expected video');
    expect(el.start).toBe(1.5);
    expect(el.end).toBe(4);
  });

  it('treats a null out-point as "to the end of the file"', () => {
    const deck = deckWith({ ...VIDEO, start: 1 });
    const el = deck.slides[0].elements[0];
    if (el.type !== 'video') throw new Error('expected video');
    expect(el.end).toBeNull();
  });
});
