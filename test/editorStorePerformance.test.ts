import { describe, expect, it, vi } from 'vitest';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { EditorStore } from '../src/renderer/editor/store.js';

function setup() {
  const deck = parseDeck({
    ...emptyDeck(),
    slides: Array.from({ length: 3 }, (_, i) => ({
      id: `s${i}`,
      elements: ['a', 'b'].map((suffix) => ({
        id: `e${i}${suffix}`, type: 'text', x: 0, y: 0, w: 100, h: 50, html: suffix,
      })),
    })),
  });
  const store = new EditorStore(deck);
  store.selectSlide(1);
  store.select(['e1b', 'e1a']);
  return { deck, store };
}

describe('selection validation during edits', () => {
  it('does not visit unrelated slide objects during a drag', () => {
    const { deck, store } = setup();
    const selection = store.get().selection;
    const readUnrelatedId = vi.fn();
    for (const slide of [deck.slides[0], deck.slides[2]]) {
      for (const element of slide.elements) {
        const id = element.id;
        Object.defineProperty(element, 'id', {
          enumerable: true,
          get() { readUnrelatedId(); return id; },
        });
      }
    }
    store.beginTransaction();
    store.updateSelected((element) => { element.x += 20; });
    store.updateSelected((element) => { element.x += 20; });

    expect(readUnrelatedId).not.toHaveBeenCalled();
    expect(store.get().selection).toBe(selection);
    expect(store.selectedElements().map((element) => element.x)).toEqual([40, 40]);
    expect(deck.slides[1].elements.map((element) => element.x)).toEqual([0, 0]);

    store.endTransaction();
    store.undo();
    expect(store.selectedElements().map((element) => element.x)).toEqual([0, 0]);
    store.redo();
    expect(store.selectedElements().map((element) => element.x)).toEqual([40, 40]);
  });

  it('keeps selected ids and their order when objects move to other slides', () => {
    const { store } = setup();
    const selection = store.get().selection;
    store.commit((deck) => {
      deck.slides[2].elements.push(deck.slides[1].elements.pop()!);
      deck.slides[0].elements.push(deck.slides[1].elements.pop()!);
    });
    expect(store.get().selection).toBe(selection);
    expect([...store.get().selection]).toEqual(['e1b', 'e1a']);
  });

  it('removes deleted ids while retaining objects moved off the active slide', () => {
    const { store } = setup();
    store.commit((deck) => {
      deck.slides[2].elements.push(deck.slides[1].elements.pop()!);
      deck.slides[1].elements = [];
    });
    expect([...store.get().selection]).toEqual(['e1b']);
    store.commit((deck) => { deck.slides[2].elements = []; });
    expect(store.get().selection.size).toBe(0);
  });

  it('retains selected objects when a commit reorders their slide', () => {
    const { store } = setup();
    const selection = store.get().selection;
    store.commit((deck) => { deck.slides.unshift(deck.slides.splice(1, 1)[0]); });
    expect(store.get().selection).toBe(selection);
  });
});
