import { z } from 'zod';
import { DeckSchema } from './deck.js';
import { AgentOperationSchema } from './agent.js';

/**
 * Wire protocol for collaborative editing.
 *
 * The server holds the authoritative deck and assigns each accepted
 * transaction a monotonically increasing sequence number. Transactions are
 * applied with lenient element-level last-write-wins semantics (see
 * collabApply.ts) and broadcast to every client including the sender, in
 * sequence order; the sender recognizes its own txnId to confirm pending
 * transactions. Presence (cursor, selection, active slide) is a separate
 * high-frequency message class that is never persisted.
 */
export const COLLAB_PROTOCOL_VERSION = 1 as const;

export const CursorPositionSchema = z.object({
  slideId: z.string(),
  /** Slide-space pixels on the deck canvas. */
  x: z.number(),
  y: z.number(),
});

export const PresenceStateSchema = z.object({
  clientId: z.string(),
  name: z.string(),
  color: z.string(),
  activeSlideId: z.string().nullable(),
  selectedSlideIds: z.array(z.string()),
  selectedElementIds: z.array(z.string()),
  editingElementId: z.string().nullable(),
  cursor: CursorPositionSchema.nullable(),
});

export type CursorPosition = z.infer<typeof CursorPositionSchema>;
export type PresenceState = z.infer<typeof PresenceStateSchema>;

// ---------------------------------------------------------------- client → server

export const ClientHelloSchema = z.object({
  kind: z.literal('hello'),
  version: z.literal(COLLAB_PROTOCOL_VERSION),
  name: z.string().min(1).max(80).optional(),
});

export const ClientTxnSchema = z.object({
  kind: z.literal('txn'),
  txnId: z.string().min(1),
  /** The server seq the client had applied when it produced these ops. Informational. */
  baseSeq: z.number().int().nonnegative(),
  label: z.string().min(1).max(200),
  ops: z.array(AgentOperationSchema).min(1),
});

export const ClientPresenceSchema = z.object({
  kind: z.literal('presence'),
  activeSlideId: z.string().nullable(),
  selectedSlideIds: z.array(z.string()),
  selectedElementIds: z.array(z.string()),
  editingElementId: z.string().nullable(),
});

export const ClientCursorSchema = z.object({
  kind: z.literal('cursor'),
  cursor: CursorPositionSchema.nullable(),
});

export const ClientThemeSchema = z.object({
  kind: z.literal('theme'),
  css: z.string(),
});

export const ClientMessageSchema = z.discriminatedUnion('kind', [
  ClientHelloSchema,
  ClientTxnSchema,
  ClientPresenceSchema,
  ClientCursorSchema,
  ClientThemeSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientTxnMessage = z.infer<typeof ClientTxnSchema>;

// ---------------------------------------------------------------- server → client

export const ServerWelcomeSchema = z.object({
  kind: z.literal('welcome'),
  version: z.literal(COLLAB_PROTOCOL_VERSION),
  clientId: z.string(),
  self: z.object({ name: z.string(), color: z.string() }),
  seq: z.number().int().nonnegative(),
  deck: DeckSchema,
  themeCss: z.string(),
  peers: z.array(PresenceStateSchema),
});

export const ServerTxnSchema = z.object({
  kind: z.literal('txn'),
  seq: z.number().int().positive(),
  txnId: z.string(),
  byClientId: z.string(),
  label: z.string(),
  ops: z.array(AgentOperationSchema).min(1),
  /** Embedded Agent conversation that produced this transaction. */
  agentChatId: z.string().optional(),
});

export const ServerDeckSchema = z.object({
  kind: z.literal('deck'),
  seq: z.number().int().nonnegative(),
  deck: DeckSchema,
  reason: z.enum(['agent-edit', 'external-edit', 'resync']),
  label: z.string().optional(),
  agentChatId: z.string().optional(),
});

export const ServerPresenceSchema = z.object({
  kind: z.literal('presence'),
  state: PresenceStateSchema,
});

export const ServerCursorSchema = z.object({
  kind: z.literal('cursor'),
  clientId: z.string(),
  cursor: CursorPositionSchema.nullable(),
});

export const ServerPeerLeftSchema = z.object({
  kind: z.literal('peerLeft'),
  clientId: z.string(),
});

export const ServerThemeSchema = z.object({
  kind: z.literal('theme'),
  css: z.string(),
  byClientId: z.string(),
});

/** Hosted session torn down on purpose (host clicked End collaboration). */
export const ServerEndedSchema = z.object({
  kind: z.literal('ended'),
});

export const ServerMessageSchema = z.discriminatedUnion('kind', [
  ServerWelcomeSchema,
  ServerTxnSchema,
  ServerDeckSchema,
  ServerPresenceSchema,
  ServerCursorSchema,
  ServerPeerLeftSchema,
  ServerThemeSchema,
  ServerEndedSchema,
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerTxnMessage = z.infer<typeof ServerTxnSchema>;
export type ServerWelcomeMessage = z.infer<typeof ServerWelcomeSchema>;
