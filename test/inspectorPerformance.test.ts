// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import * as storeModule from '../src/renderer/editor/store.js';
import { EditorStore } from '../src/renderer/editor/store.js';

function setup(): { store: EditorStore; host: HTMLElement; inspector: Inspector } {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/["\\]/g, '\\$&') });
  window.api = { assetUrl: (src: string) => src } as never;
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

  const deck = emptyDeck('Inspector performance');
  deck.slides[0].elements = [{
    id: 'text-1', type: 'text', x: 100, y: 100, w: 600, h: 120, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, html: 'Title', align: 'left', valign: 'middle',
  }];
  deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'slide-2', elements: [] });
  const store = new EditorStore(deck, '/tmp/inspector-performance');
  store.select(['text-1']);
  const host = document.createElement('aside');
  document.body.replaceChildren(host);
  const inspector = new Inspector(host, store);
  return { store, host, inspector };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('inspector update work', () => {
  it('skips hidden deck comparisons and catches up when Props explicitly renders', () => {
    const { store, host, inspector } = setup();
    const compare = vi.spyOn(storeModule, 'sameDeckIgnoringNotes');
    const originalSlider = host.querySelector<HTMLInputElement>('[aria-label="Opacity"]')!;
    host.hidden = true;

    // Notes retain the rendered picture but replace the deck. Comparing it
    // against the hidden panel's stale deck would walk all slides per event.
    for (let i = 0; i < 10; i++) {
      store.commit((deck) => { deck.slides[1].notes = `Note ${i}`; });
      store.markClean();
    }
    store.updateSelected((element) => { element.opacity = 0.65; });

    expect(compare).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Opacity"]')).toBe(originalSlider);
    expect(originalSlider.value).toBe('100');

    // Both desktop and collab showPanel('inspector') use this reopening path.
    host.hidden = false;
    inspector.render();
    const reopenedSlider = host.querySelector<HTMLInputElement>('[aria-label="Opacity"]')!;
    expect(reopenedSlider).not.toBe(originalSlider);
    expect(reopenedSlider.value).toBe('65');

    store.commit((deck) => { deck.slides[1].notes = 'Visible note edit'; });
    expect(compare).toHaveBeenCalledOnce();
    expect(host.querySelector('[aria-label="Opacity"]')).toBe(reopenedSlider);
  });

  it.each([
    ['element selection', (store: EditorStore) => store.select(['text-1'])],
    ['active slide', (store: EditorStore) => store.selectSlide(1)],
    ['slide selection', (store: EditorStore) => store.selectAllSlides()],
  ] as const)('skips deck comparison when %s already requires a render', (_label, change) => {
    const { store, host } = setup();
    store.select([]);
    store.commit((deck) => { deck.slides[1].notes = 'A fresh deck with the same picture'; });
    const before = host.firstElementChild;
    const compare = vi.spyOn(storeModule, 'sameDeckIgnoringNotes');

    change(store);

    expect(compare).not.toHaveBeenCalled();
    expect(host.firstElementChild).not.toBe(before);
  });

  it('still closes an opacity transaction when selection changes while hidden', () => {
    const { store, host, inspector } = setup();
    const slider = host.querySelector<HTMLInputElement>('[aria-label="Opacity"]')!;
    slider.value = '42';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(store.selectedElements()[0].opacity).toBe(0.42);
    expect(store.canUndo()).toBe(false);
    host.hidden = true;

    // There is no pointerup/blur here: selection cleanup must close the drag
    // before the hidden-panel guard so later edits get their own undo entry.
    store.select([]);
    expect(store.canUndo()).toBe(true);
    store.commit((deck) => { deck.slides[0].notes = 'A separate edit'; });
    store.undo();
    expect(store.slide!.notes).toBe('');
    expect(store.slide!.elements[0].opacity).toBe(0.42);
    store.undo();
    expect(store.slide!.elements[0].opacity).toBe(1);

    host.hidden = false;
    inspector.render();
    expect(host.querySelector('.insp-title')?.textContent).toBe('slide');
  });
});
