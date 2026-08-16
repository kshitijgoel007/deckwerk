// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
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

  it('inserts one title-and-body slide after the selected slide on Return', () => {
    const { store, host } = setup();
    store.selectSlide(0);
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(store.get().deck.slides).toHaveLength(3);
    expect(store.get().slideIndex).toBe(1);
    expect(store.slide).toMatchObject({ name: '', layout: 'standard', timeline: [] });
    expect(store.slide?.elements.map((element) => element.class[0])).toEqual([
      'role-title', 'role-body',
    ]);
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

  it('deletes the selected slide on Backspace', () => {
    const { store, host } = setup();
    store.selectSlide(1);
    const active = host.querySelector<HTMLButtonElement>('.rail-item.active')!;
    active.focus();
    active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));

    expect(store.get().deck.slides).toHaveLength(1);
    expect(store.get().deck.slides[0].id).toBe('slide-1');
    expect(store.get().slideIndex).toBe(0);
  });

  it('does not delete the deck\'s only slide', () => {
    const { store, host } = setup();
    store.selectSlide(1);
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(store.get().deck.slides).toHaveLength(1);

    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(store.get().deck.slides).toHaveLength(1);
    expect(store.get().slideIndex).toBe(0);
  });

  it('edits a large imported-style deck without rebuilding unchanged media', () => {
    let assetResolutions = 0;
    (globalThis as unknown as { window: Window }).window.api = {
      assetUrl: (src: string) => {
        assetResolutions += 1;
        return src;
      },
    } as never;
    if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};

    const deck = emptyDeck('Large import');
    deck.slides = Array.from({ length: 140 }, (_, index) => ({
      id: `imported-${index}`,
      name: `Imported ${index + 1}`,
      background: { color: '#ffffff', image: null },
      notes: '',
      elements: [{
        id: `image-${index}`, type: 'image' as const, src: `assets/frame-${index}.png`,
        x: 0, y: 0, w: 1920, h: 1080, rot: 0, z: 0, opacity: 1,
        class: [], style: {}, fit: 'contain' as const, alt: '', sourceBox: null,
      }],
      timeline: [],
    }));
    const store = new EditorStore(deck, '/tmp/large-import');
    const railHost = document.createElement('div');
    const inspectorHost = document.createElement('div');
    document.body.replaceChildren(railHost, inspectorHost);
    new SlideRail(railHost, store);
    new Inspector(inspectorHost, store);
    const firstThumb = railHost.querySelector('.rail-thumb');
    expect(assetResolutions).toBe(140);

    store.selectSlide(69);
    railHost.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const layout = [...inspectorHost.querySelectorAll<HTMLSelectElement>('select')].find((select) =>
      [...select.options].some((option) => option.value === 'standard'))!;
    layout.value = 'standard';
    layout.dispatchEvent(new Event('change', { bubbles: true }));

    expect(store.slide?.layout).toBe('standard');
    expect(store.slide?.elements.map((element) => element.class[0])).toEqual([
      'role-title', 'role-body',
    ]);
    expect(railHost.querySelector('.rail-thumb')).toBe(firstThumb);
    expect(assetResolutions).toBe(140);
    expect(() => parseDeck(store.get().deck)).not.toThrow();
  });
});
