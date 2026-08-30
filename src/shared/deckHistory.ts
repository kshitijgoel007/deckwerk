import { z } from 'zod';
import { AgentOperationSchema } from './agent.js';
import { DeckSchema } from './deck.js';

/**
 * Restorable revision metadata plus the operations from the preceding entry.
 *
 * The first entry has no predecessor and therefore carries an empty operation
 * list; `base` is its materialized deck. Later entries are cheap deltas. This
 * keeps IPC and the sidecar proportional to edits rather than deck size times
 * history length. Runtime ids remain renderer-local and are minted on load.
 */
export const PersistedDeckHistoryEntrySchema = z.object({
  label: z.string().min(1).max(500),
  description: z.string().max(10_000).optional(),
  agentChatId: z.string().min(1).max(1_000).optional(),
  at: z.number().finite().nonnegative(),
  slideIndex: z.number().int().nonnegative(),
  operations: z.array(AgentOperationSchema),
});

export const DeckHistoryDocumentSchema = z.object({
  version: z.literal(2),
  /** Materialized state represented by entries[0], null for an empty log. */
  base: DeckSchema.nullable(),
  entries: z.array(PersistedDeckHistoryEntrySchema).max(200),
}).superRefine((history, ctx) => {
  if (history.entries.length === 0 && history.base !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['base'], message: 'empty history has no base' });
  }
  if (history.entries.length > 0 && history.base === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['base'], message: 'history entries need a base' });
  }
  if (history.entries[0]?.operations.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['entries', 0, 'operations'],
      message: 'the base revision cannot have preceding operations',
    });
  }
});

export type PersistedDeckHistoryEntry = z.infer<typeof PersistedDeckHistoryEntrySchema>;
export type DeckHistoryDocument = z.infer<typeof DeckHistoryDocumentSchema>;

export const emptyDeckHistory = (): DeckHistoryDocument => ({
  version: 2,
  base: null,
  entries: [],
});
