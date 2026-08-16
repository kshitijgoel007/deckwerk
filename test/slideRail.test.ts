// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { SlideRail } from '../src/renderer/editor/slideRail.js';
import { EditorStore } from '../src/renderer/editor/store.js';

function setup() {
  (globalThis as unknown as { window: Window }).window.api = {
    assetUrl: (src: string) => src,
  } as never;
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {};
  }
  const deck = emptyDeck('Rail');
  deck.slides.push({
    id: 'slide-2', name: 'Second', background: { color: null, image: null },
    notes: '', elements: [], timeline: [],
  });
  const store = new EditorStore(deck, '/tmp/deck');
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  new SlideRail(host, store);
  return { store, host };
}

describe('slide rail keyboard insertion', () => {
  beforeEach(() => document.body.replaceChildren());

  it('inserts one empty slide after the selected slide on Return', () => {
    const { store, host } = setup();
    store.selectSlide(0);
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(store.get().deck.slides).toHaveLength(3);
    expect(store.get().slideIndex).toBe(1);
    expect(store.slide).toMatchObject({ name: '', elements: [], timeline: [] });
    expect(store.get().deck.slides[2].id).toBe('slide-2');
  });

  it('also works when the active thumbnail owns focus', () => {
    const { store, host } = setup();
    const active = host.querySelector<HTMLButtonElement>('.rail-item.active')!;
    active.focus();
    active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(store.get().deck.slides).toHaveLength(3);
    expect(store.get().slideIndex).toBe(1);
  });
});
