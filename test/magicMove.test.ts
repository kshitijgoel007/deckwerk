import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { matchMagicMoveElements } from '../src/renderer/player/player.js';

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
});
