// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { suggestMagicMovePairs } from '../src/shared/magicMove.js';
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

  it('Shift-click selects an inclusive slide range and a plain click collapses it', () => {
    const { store, host } = setup();
    store.commit((deck) => {
      deck.slides.push(
        { id: 'slide-3', name: 'Third', background: { color: null, image: null }, notes: '', elements: [], timeline: [] },
        { id: 'slide-4', name: 'Fourth', background: { color: null, image: null }, notes: '', elements: [], timeline: [] },
      );
    }, { history: false });

    host.querySelectorAll<HTMLButtonElement>('.rail-item')[1].click();
    host.querySelectorAll<HTMLButtonElement>('.rail-item')[3].dispatchEvent(
      new MouseEvent('click', { bubbles: true, shiftKey: true }),
    );

    expect(store.get().slideIndex).toBe(3);
    expect([...store.get().slideSelection]).toEqual(['slide-2', 'slide-3', 'slide-4']);
    expect(host.querySelectorAll('.rail-item.selected')).toHaveLength(3);
    expect(host.querySelectorAll('.rail-item.active')).toHaveLength(1);

    host.querySelectorAll<HTMLButtonElement>('.rail-item')[2].click();
    expect([...store.get().slideSelection]).toEqual(['slide-3']);
    expect(host.querySelectorAll('.rail-item.selected')).toHaveLength(1);
  });

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

  it('does not implicitly Magic Move every object on a duplicated slide', () => {
    const { store, host } = setup();
    store.get().deck.slides[0].elements.push({
      id: 'source', type: 'text', x: 20, y: 20, w: 300, h: 80, rot: 0, z: 1,
      opacity: 1, class: ['role-title'], style: {}, html: 'Keep me', align: 'left',
      valign: 'top', magicMoveId: 'existing-chain',
    });
    const rail = new SlideRail(host, store);

    rail.duplicateSlide();

    expect(store.get().deck.slides[0].elements[0].magicMoveId).toBe('existing-chain');
    expect(store.get().deck.slides[1].elements[0].magicMoveId).toBeNull();
    expect(store.get().deck.slides[1].elements[0].lineageId).toBe('source');
    const copy = store.get().deck.slides[1].elements[0];
    if (copy.type !== 'text') throw new Error('expected duplicated text');
    copy.html = 'Edited after duplication';
    expect(suggestMagicMovePairs(
      store.get().deck.slides[0].elements,
      store.get().deck.slides[1].elements,
    ).map(([source, target]) => [source.id, target.id])).toEqual([['source', copy.id]]);
  });

  it('edits a large imported-style deck without rebuilding unchanged media', () => {
    let assetResolutions = 0;
    const resolutionsByAsset = new Map<string, number>();
    (globalThis as unknown as { window: Window }).window.api = {
      assetUrl: (src: string) => {
        assetResolutions += 1;
        resolutionsByAsset.set(src, (resolutionsByAsset.get(src) ?? 0) + 1);
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
    // Props renders the selected and following slide once for its two compact
    // read-only Magic Move previews.
    expect(assetResolutions).toBe(142);

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
    // An untouched rail thumbnail far away from the edit is not resolved again.
    expect(resolutionsByAsset.get('assets/frame-139.png')).toBe(1);
    expect(() => parseDeck(store.get().deck)).not.toThrow();
  });
});
