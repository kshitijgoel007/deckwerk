import type { Deck } from '@shared/deck.js';
import type { DeckSessionSnapshot } from '@shared/ipc.js';

export interface SessionPersistenceApi {
  saveDeck: (dir: string, deck: Deck) => Promise<void>;
  syncDeckSnapshot: (snapshot: DeckSessionSnapshot) => Promise<void>;
}

/**
 * Persist ordinary editor state, or mirror collaboration-owned state for
 * main-process presentation/export consumers without creating a second writer.
 *
 * Both routes name the deck they belong to. The main process rejects a write
 * whose folder is no longer the open one, so a save in flight when the author
 * opens or imports another deck cannot land on top of it.
 */
export function persistSessionDeck(
  api: SessionPersistenceApi,
  dir: string,
  deck: Deck,
  themeCss: string,
  collaborationOwnsDisk: boolean,
): Promise<void> {
  return collaborationOwnsDisk
    ? api.syncDeckSnapshot({ dir, deck, themeCss })
    : api.saveDeck(dir, deck);
}
