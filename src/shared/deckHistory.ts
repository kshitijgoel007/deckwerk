import { z } from 'zod';
import { DeckSchema } from './deck.js';

/**
 * Restorable deck snapshots persisted beside a presentation.
 *
 * History ids are deliberately absent: they only address buttons in one
 * renderer lifetime and are minted again when the document is opened.
 */
export const PersistedDeckHistoryEntrySchema = z.object({
  label: z.string().min(1).max(500),
  description: z.string().max(10_000).optional(),
  agentChatId: z.string().min(1).max(1_000).optional(),
  at: z.number().finite().nonnegative(),
  slideIndex: z.number().int().nonnegative(),
  deck: DeckSchema,
});

export const DeckHistoryDocumentSchema = z.object({
  version: z.literal(1),
  entries: z.array(PersistedDeckHistoryEntrySchema).max(200),
});

export type PersistedDeckHistoryEntry = z.infer<typeof PersistedDeckHistoryEntrySchema>;
export type DeckHistoryDocument = z.infer<typeof DeckHistoryDocumentSchema>;

export const emptyDeckHistory = (): DeckHistoryDocument => ({ version: 1, entries: [] });
