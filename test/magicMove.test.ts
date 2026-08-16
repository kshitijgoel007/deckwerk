// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { matchMagicMoveElements } from '../src/renderer/player/player.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore } from '../src/renderer/editor/store.js';

describe('Magic Move matching', () => {
  it('matches duplicated elements after slide duplication changes their ids', () => {
    const deck = emptyDeck();
    const first = {
      id: 'old', type: 'text' as const, x: 10, y: 20, w: 400, h: 100,
      rot: 0, z: 1, opacity: 1, class: ['role-title'], style: {}, html: 'Same title',
      align: 'left' as const, valign: 'top' as const,
    };
    const second = { ...first, id: 'new', x: 500, y: 300 };
    deck.slides[0].elements = [first];
    expect(matchMagicMoveElements([first], [second])).toEqual([[first, second]]);
  });

  it('does not pair unrelated content merely because its type matches', () => {
    const a = emptyDeck().slides[0];
    const b = emptyDeck().slides[0];
    a.elements.push({
      id: 'a', type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, html: 'One', align: 'left', valign: 'top',
    });
    const original = a.elements[0];
    if (original.type !== 'text') throw new Error('expected text');
    b.elements.push({ ...original, id: 'b', html: 'Two' });
    expect(matchMagicMoveElements(a.elements, b.elements)).toEqual([]);
  });

  it('gives an explicit manual match priority over content heuristics', () => {
    const first = {
      id: 'first', type: 'text' as const, x: 0, y: 0, w: 100, h: 50, rot: 0,
      z: 1, opacity: 1, class: [], style: {}, html: 'Old', align: 'left' as const,
      valign: 'top' as const, magicMoveId: 'manual-1',
    };
    const second = { ...first, id: 'second', html: 'Completely changed' };
    expect(matchMagicMoveElements([first], [second])).toEqual([[first, second]]);
  });

  it('pairs a selected element through the manual match inspector', () => {
    const deck = emptyDeck();
    deck.slides[0].elements = [{
      id: 'source', type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, html: 'Source', align: 'left', valign: 'top',
    }];
    deck.slides.push({
      id: 'slide-2', name: '', background: { color: null, image: null }, notes: '',
      transition: { type: 'magicMove', duration: 700 }, timeline: [], elements: [{
        id: 'target', type: 'text', x: 200, y: 100, w: 100, h: 50, rot: 0, z: 1,
        opacity: 1, class: [], style: {}, html: 'Target', align: 'left', valign: 'top',
      }],
    });
    const store = new EditorStore(deck, '/tmp/magic');
    store.selectSlide(1);
    store.select(['target']);
    const host = document.createElement('div');
    new Inspector(host, store);
    const select = [...host.querySelectorAll('select')].find((candidate) =>
      [...candidate.options].some((option) => option.value === 'source'))!;
    select.value = 'source';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const source = store.get().deck.slides[0].elements[0];
    const target = store.get().deck.slides[1].elements[0];
    expect(source.magicMoveId).toBeTruthy();
    expect(target.magicMoveId).toBe(source.magicMoveId);
  });

  it('removes the old source identity when an element is rematched', () => {
    const deck = emptyDeck();
    deck.slides[0].elements = [
      {
        id: 'source-a', type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1,
        opacity: 1, class: [], style: {}, html: 'A', align: 'left', valign: 'top',
      },
      {
        id: 'source-b', type: 'text', x: 150, y: 0, w: 100, h: 50, rot: 0, z: 2,
        opacity: 1, class: [], style: {}, html: 'B', align: 'left', valign: 'top',
      },
    ];
    deck.slides.push({
      id: 'slide-2', name: '', background: { color: null, image: null }, notes: '',
      transition: { type: 'magicMove', duration: 700 }, timeline: [], elements: [{
        id: 'target', type: 'text', x: 200, y: 100, w: 100, h: 50, rot: 0, z: 1,
        opacity: 1, class: [], style: {}, html: 'Target', align: 'left', valign: 'top',
      }],
    });
    const store = new EditorStore(deck, '/tmp/magic');
    store.selectSlide(1);
    store.select(['target']);
    const host = document.createElement('div');
    new Inspector(host, store);
    const select = [...host.querySelectorAll('select')].find((candidate) =>
      [...candidate.options].some((option) => option.value === 'source-a'))!;

    select.value = 'source-a';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.value = 'source-b';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const [sourceA, sourceB] = store.get().deck.slides[0].elements;
    const target = store.get().deck.slides[1].elements[0];
    expect(sourceA.magicMoveId).toBeNull();
    expect(sourceB.magicMoveId).toBe(target.magicMoveId);
  });
});
