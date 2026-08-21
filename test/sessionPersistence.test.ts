import { describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { persistSessionDeck } from '../src/renderer/editor/sessionPersistence.js';

describe('editor session persistence', () => {
  it('mirrors Agent-session state for main-process presentation without writing deck.json', async () => {
    const deck = emptyDeck('Agent deck');
    deck.slides[0].elements.push({
      id: 'agent-title',
      type: 'text',
      x: 100,
      y: 100,
      w: 800,
      h: 120,
      rot: 0,
      z: 1,
      opacity: 1,
      class: ['role-title'],
      style: {},
      html: 'Visible when presenting',
      align: 'left',
      valign: 'top',
    });
    const api = {
      saveDeck: vi.fn(async () => {}),
      syncDeckSnapshot: vi.fn(async () => {}),
    };

    await persistSessionDeck(api, deck, '.slide { color: #123; }', true);

    expect(api.saveDeck).not.toHaveBeenCalled();
    expect(api.syncDeckSnapshot).toHaveBeenCalledWith({
      deck,
      themeCss: '.slide { color: #123; }',
    });
  });

  it('keeps ordinary editor saves on the persistent deck writer', async () => {
    const deck = emptyDeck('Local deck');
    const api = {
      saveDeck: vi.fn(async () => {}),
      syncDeckSnapshot: vi.fn(async () => {}),
    };

    await persistSessionDeck(api, deck, '', false);

    expect(api.saveDeck).toHaveBeenCalledWith(deck);
    expect(api.syncDeckSnapshot).not.toHaveBeenCalled();
  });
});
