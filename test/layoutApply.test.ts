// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { emptyDeck, type Deck, type TextEl } from '../src/shared/deck.js';
import {
  defaultLayoutMasters,
  elementFollowsLayout,
  layoutGeometryFor,
  realignElementToLayout,
  realignSlideToLayout,
} from '../src/shared/layoutMasters.js';
import { Inspector } from '../src/renderer/editor/inspector.js';

/**
 * Putting text boxes back where their layout places them changes nothing else
 * -- not styling, not content, not which layout a slide is on. The per-slide
 * form backs the agent surface; the per-box form is the Props button.
 */

function slot(deck: Deck, index: number, name: 'title' | 'body'): TextEl {
  return deck.slides[index].elements.find((el): el is TextEl => (
    el.type === 'text' && el.layoutPlaceholder === name
  ))!;
}

function nudgedDeck(): Deck {
  const deck = emptyDeck('Apply layout');
  deck.layoutMasters = defaultLayoutMasters();
  deck.slides.push(structuredClone({ ...deck.slides[0], id: 's2', name: 's2' }));
  deck.slides.push(structuredClone({ ...deck.slides[0], id: 's3', name: 's3' }));
  applySlideLayout(deck.slides[0], 'standard', deck.layoutMasters);
  applySlideLayout(deck.slides[1], 'standard', deck.layoutMasters);
  applySlideLayout(deck.slides[2], 'freeform', deck.layoutMasters);
  for (const index of [0, 1]) {
    const title = slot(deck, index, 'title');
    title.x = 400; title.y = 500; title.w = 300; title.h = 60; title.align = 'right';
    title.style = { color: '#ff0000', 'font-size': '200px' };
    title.html = 'Moved title';
    title.class = title.class.filter((name) => name !== 'placeholder');
  }
  return deck;
}

describe('realignSlideToLayout', () => {
  it('moves the slot boxes back to the master geometry and touches nothing else', () => {
    const deck = nudgedDeck();
    const before = structuredClone(deck.slides[0]);
    expect(realignSlideToLayout(deck.slides[0], deck.layoutMasters)).toBe(2);
    const title = slot(deck, 0, 'title');
    expect({ x: title.x, y: title.y, w: title.w, h: title.h, align: title.align })
      .toEqual({ x: 120, y: 58, w: 1680, h: 142, align: 'left' });
    expect(title.style).toEqual({ color: '#ff0000', 'font-size': '200px' });
    expect(title.html).toBe('Moved title');
    expect(title.class).not.toContain('placeholder');
    expect(deck.slides[0].layout).toBe('standard');
    expect(deck.slides[0].elements.map((el) => el.id)).toEqual(before.elements.map((el) => el.id));
  });

  it('has nothing to align on a freeform slide and never invents boxes', () => {
    const deck = nudgedDeck();
    const snapshot = JSON.stringify(deck.slides[2]);
    expect(realignSlideToLayout(deck.slides[2], deck.layoutMasters)).toBe(0);
    expect(JSON.stringify(deck.slides[2])).toBe(snapshot);

    const titleOnly = emptyDeck().slides[0];
    applySlideLayout(titleOnly, 'standard');
    titleOnly.elements = titleOnly.elements.filter((el) => el.type !== 'text' || el.layoutPlaceholder !== 'body');
    expect(realignSlideToLayout(titleOnly)).toBe(1);
    expect(titleOnly.elements.filter((el) => el.type === 'text')).toHaveLength(1);
  });
});

describe('realignElementToLayout', () => {
  it('moves one role box to its slot and leaves the other slot box where it was', () => {
    const deck = nudgedDeck();
    const title = slot(deck, 0, 'title');
    const body = slot(deck, 0, 'body');
    body.x = 900; body.y = 900;
    expect(elementFollowsLayout(deck.slides[0], title, deck.layoutMasters)).toBe(false);

    expect(realignElementToLayout(deck.slides[0], title.id, deck.layoutMasters)).toBe(true);
    expect({ x: title.x, y: title.y, w: title.w, h: title.h, align: title.align })
      .toEqual({ x: 120, y: 58, w: 1680, h: 142, align: 'left' });
    expect(title.style).toEqual({ color: '#ff0000', 'font-size': '200px' });
    expect(title.html).toBe('Moved title');
    // Per box, never per slide: the body is exactly where the author left it.
    expect({ x: body.x, y: body.y }).toEqual({ x: 900, y: 900 });
    expect(elementFollowsLayout(deck.slides[0], title, deck.layoutMasters)).toBe(true);
    expect(realignElementToLayout(deck.slides[0], title.id, deck.layoutMasters)).toBe(false);
  });

  it('is a function of the role: any title-class box snaps to the title slot', () => {
    const deck = nudgedDeck();
    const extra: TextEl = {
      id: 'second-title', type: 'text', x: 10, y: 10, w: 50, h: 20, rot: 0, z: 9, opacity: 1,
      class: ['role-title'], style: {}, html: 'Another title', align: 'center', valign: 'middle',
    };
    deck.slides[0].elements.push(extra);
    expect(layoutGeometryFor(deck.slides[0], extra, deck.layoutMasters)).toMatchObject({ x: 120, y: 58 });
    expect(realignElementToLayout(deck.slides[0], extra.id, deck.layoutMasters)).toBe(true);
    expect({ x: extra.x, y: extra.y, w: extra.w }).toEqual({ x: 120, y: 58, w: 1680 });
  });

  it('falls back to the standard layout on a freeform slide and refuses boxes with no role', () => {
    const deck = nudgedDeck();
    const freeform = deck.slides[2];
    const body: TextEl = {
      id: 'free-body', type: 'text', x: 5, y: 5, w: 50, h: 20, rot: 0, z: 1, opacity: 1,
      class: ['role-body'], style: {}, html: 'Body', align: 'left', valign: 'top',
    };
    const plain: TextEl = { ...body, id: 'plain', class: [] };
    freeform.elements.push(body, plain);
    const standardBody = deck.layoutMasters!.standard.elements
      .find((el): el is TextEl => el.type === 'text' && el.layoutPlaceholder === 'body')!;
    expect(realignElementToLayout(freeform, body.id, deck.layoutMasters)).toBe(true);
    expect({ x: body.x, y: body.y, w: body.w, h: body.h })
      .toEqual({ x: standardBody.x, y: standardBody.y, w: standardBody.w, h: standardBody.h });
    expect(layoutGeometryFor(freeform, plain, deck.layoutMasters)).toBeNull();
    expect(realignElementToLayout(freeform, plain.id, deck.layoutMasters)).toBe(false);
    expect(freeform.layout).toBe('freeform');
  });
});

describe('Reset to layout position button', () => {
  beforeEach(() => document.body.replaceChildren());

  it('appears for a drifted role box, moves only that box as one undo step, then goes idle', () => {
    const deck = nudgedDeck();
    const store = new EditorStore(deck, '/tmp/reset-layout');
    const host = document.createElement('aside');
    document.body.appendChild(host);
    new Inspector(host, store);
    const title = slot(store.get().deck, 0, 'title');
    const body = slot(store.get().deck, 0, 'body');
    store.select([title.id]);

    const button = host.querySelector<HTMLButtonElement>('.layout-reset-button');
    expect(button, 'a drifted title offers the reset').not.toBeNull();
    expect(button!.disabled).toBe(false);
    button!.click();

    const moved = slot(store.get().deck, 0, 'title');
    expect({ x: moved.x, y: moved.y, w: moved.w, h: moved.h }).toEqual({ x: 120, y: 58, w: 1680, h: 142 });
    expect(moved.style).toEqual({ color: '#ff0000', 'font-size': '200px' });
    const bodyAfter = slot(store.get().deck, 0, 'body');
    expect({ x: bodyAfter.x, y: bodyAfter.y }).toEqual({ x: body.x, y: body.y });
    expect(host.querySelector<HTMLButtonElement>('.layout-reset-button')?.disabled).toBe(true);

    store.undo();
    const back = slot(store.get().deck, 0, 'title');
    expect({ x: back.x, y: back.y }).toEqual({ x: 400, y: 500 });
  });

  it('previews the box at its layout position on the canvas while hovered, and clears on leave', () => {
    const deck = nudgedDeck();
    const store = new EditorStore(deck, '/tmp/reset-layout');
    const host = document.createElement('aside');
    document.body.appendChild(host);
    const inspector = new Inspector(host, store);
    const onPreviewSlide = vi.fn();
    inspector.onPreviewSlide = onPreviewSlide;
    const title = slot(store.get().deck, 0, 'title');
    store.select([title.id]);

    const button = host.querySelector<HTMLButtonElement>('.layout-reset-button')!;
    button.dispatchEvent(new Event('mouseenter'));
    expect(onPreviewSlide).toHaveBeenCalledTimes(1);
    const [shown, label] = onPreviewSlide.mock.calls[0] as [Deck['slides'][number], string];
    expect(label).toBe('Reset to layout position');
    const previewed = shown.elements.find((el) => el.id === title.id)!;
    expect({ x: previewed.x, y: previewed.y }).toEqual({ x: 120, y: 58 });
    // A preview, not an edit: the deck is untouched.
    expect(slot(store.get().deck, 0, 'title').x).toBe(400);

    button.dispatchEvent(new Event('mouseleave'));
    expect(onPreviewSlide).toHaveBeenLastCalledWith(null, '');
  });

  it('is not offered for a box with no role', () => {
    const deck = nudgedDeck();
    const plain: TextEl = {
      id: 'plain', type: 'text', x: 5, y: 5, w: 50, h: 20, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, html: 'Plain', align: 'left', valign: 'top',
    };
    deck.slides[0].elements.push(plain);
    const store = new EditorStore(deck, '/tmp/reset-layout');
    const host = document.createElement('aside');
    document.body.appendChild(host);
    new Inspector(host, store);
    store.select(['plain']);
    expect(host.querySelector('.layout-reset-button')).toBeNull();
  });
});
