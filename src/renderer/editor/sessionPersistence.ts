import type { Deck } from '@shared/deck.js';
import type { DeckSessionSnapshot } from '@shared/ipc.js';

export interface SessionPersistenceApi {
  saveDeck: (deck: Deck) => Promise<void>;
  syncDeckSnapshot: (snapshot: DeckSessionSnapshot) => Promise<void>;
}

/**
 * Persist ordinary editor state, or mirror collaboration-owned state for
 * main-process presentation/export consumers without creating a second writer.
 */
export function persistSessionDeck(
  api: SessionPersistenceApi,
  deck: Deck,
  themeCss: string,
  collaborationOwnsDisk: boolean,
): Promise<void> {
  return collaborationOwnsDisk
    ? api.syncDeckSnapshot({ deck, themeCss })
    : api.saveDeck(deck);
}
