import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import {
  captureEditorView,
  decodeEditorView,
  encodeEditorView,
  restoreEditorView,
  type EditorViewSnapshot,
} from '../src/shared/editorView.js';
import { EditorStore } from '../src/renderer/editor/store.js';

function storeWithThreeSlides(): EditorStore {
  const deck = emptyDeck('Continuity');
  const base = deck.slides[0];
  deck.slides = ['slide-1', 'slide-2', 'slide-3'].map((id, index) => ({
    ...structuredClone(base),
    id,
    name: `Slide ${index + 1}`,
    elements: index === 1
      ? [{
          id: 'element-2', type: 'text' as const, x: 0, y: 0, w: 100, h: 100,
          rot: 0, z: 0, opacity: 1, class: [], style: {}, html: 'Selected',
          align: 'left' as const, valign: 'top' as const,
        }]
      : [],
  }));
  return new EditorStore(deck);
}

describe('editor view continuity', () => {
  it('round-trips a view snapshot through a URL parameter value', () => {
    const snapshot: EditorViewSnapshot = {
      activeSlideId: 'slide-2',
      selectedSlideIds: ['slide-2'],
      selectedElementIds: ['element-2'],
    };
    expect(decodeEditorView(encodeEditorView(snapshot))).toEqual(snapshot);
    expect(decodeEditorView('%not-json')).toBeNull();
  });

  it('restores the active slide and selected element by stable id', () => {
    const store = storeWithThreeSlides();
    restoreEditorView(store, {
      activeSlideId: 'slide-2',
      selectedSlideIds: ['slide-2'],
      selectedElementIds: ['element-2'],
    });
    expect(captureEditorView(store)).toEqual({
      activeSlideId: 'slide-2',
      selectedSlideIds: ['slide-2'],
      selectedElementIds: ['element-2'],
    });
  });

  it('restores a rail range without changing its active endpoint', () => {
    const store = storeWithThreeSlides();
    restoreEditorView(store, {
      activeSlideId: 'slide-1',
      selectedSlideIds: ['slide-1', 'slide-2', 'slide-3'],
      selectedElementIds: [],
    });
    expect(store.get().slideIndex).toBe(0);
    expect([...store.get().slideSelection]).toEqual(['slide-1', 'slide-2', 'slide-3']);
  });

  it('ignores ids removed while collaboration was active', () => {
    const store = storeWithThreeSlides();
    restoreEditorView(store, {
      activeSlideId: 'deleted-slide',
      selectedSlideIds: ['deleted-slide'],
      selectedElementIds: ['deleted-element'],
    });
    expect(store.get().slideIndex).toBe(0);
    expect([...store.get().selection]).toEqual([]);
  });
});
