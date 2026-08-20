import { describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { CollabBridge } from '../src/renderer/collab/collabBridge.js';

type Replacement = {
  label: string;
  options?: { coalesce?: boolean; description?: string; agentChatId?: string };
};

function harness() {
  const replacements: Replacement[] = [];
  const bridge = new CollabBridge('ws://unused', 'Host', {
    onDeckReplaced: (_deck, label, options) => replacements.push({ label, options }),
    onWelcome: vi.fn(),
    onPeerPresence: vi.fn(),
    onPeerCursor: vi.fn(),
    onPeerLeft: vi.fn(),
    onThemeCss: vi.fn(),
    onStatus: vi.fn(),
    onCleanChange: vi.fn(),
  });
  const handle = (message: unknown) => (
    bridge as unknown as { handle(message: unknown): void }
  ).handle(message);
  const deck = emptyDeck('Original');
  handle({
    kind: 'welcome',
    version: 1,
    clientId: 'client-self',
    self: { name: 'Host', color: '#fff' },
    seq: 0,
    deck,
    themeCss: '',
    peers: [],
  });
  return { bridge, deck, handle, replacements };
}

describe('collaboration history attribution', () => {
  it('keeps external deck changes distinct from proven Agent changes', () => {
    const { bridge, deck, handle, replacements } = harness();
    const local = structuredClone(deck);
    local.title = 'Pending local base';
    bridge.localEdit(deck, local, 'Local edit before reload');
    expect(bridge.canUndo()).toBe(true);
    const external = structuredClone(deck);
    external.title = 'External';
    handle({ kind: 'deck', seq: 1, deck: external, reason: 'external-edit' });
    expect(bridge.canUndo()).toBe(false);
    expect(bridge.canRedo()).toBe(false);
    const agent = structuredClone(external);
    agent.title = 'Agent';
    handle({
      kind: 'deck', seq: 2, deck: agent, reason: 'agent-edit',
      label: 'Agent changed the title.', agentChatId: 'thread-1',
    });
    handle({ kind: 'deck', seq: 3, deck: agent, reason: 'resync' });

    expect(replacements).toEqual([
      { label: 'External edit', options: { coalesce: false, history: false } },
      {
        label: 'Agent edit',
        options: {
          coalesce: false,
          description: 'Agent changed the title.',
          agentChatId: 'thread-1',
        },
      },
      { label: 'Server resync', options: { coalesce: false, history: false } },
    ]);
  });

  it('preserves a local user label on acknowledgement and marks peer edits remote', () => {
    const { bridge, deck, handle, replacements } = harness();
    const local = structuredClone(deck);
    local.title = 'Mine';
    bridge.localEdit(deck, local, 'Rename deck');
    const pending = (
      bridge as unknown as { pending: Array<{ txnId: string }> }
    ).pending[0];
    handle({
      kind: 'txn', seq: 1, txnId: pending.txnId, byClientId: 'client-self',
      label: 'Rename deck', ops: [{ op: 'updateDeck', title: 'Mine' }],
    });
    handle({
      kind: 'txn', seq: 2, txnId: 'peer-txn', byClientId: 'client-peer',
      label: 'Rename deck', ops: [{ op: 'updateDeck', title: 'Theirs' }],
    });

    expect(replacements.map((item) => item.label)).toEqual([
      'Rename deck', 'Rename deck (remote)',
    ]);
    expect(replacements.some((item) => item.label === 'Agent edit')).toBe(false);
  });

  it('uses Agent attribution only for the dedicated Agent HTTP client', () => {
    const { handle, replacements } = harness();
    handle({
      kind: 'txn', seq: 1, txnId: 'agent-txn', byClientId: 'agent-http',
      label: 'Agent: Refine title',
      ops: [{ op: 'updateDeck', title: 'Refined' }],
      agentChatId: 'thread-9',
    });

    expect(replacements).toEqual([{
      label: 'Agent edit',
      options: {
        coalesce: false,
        description: 'Refine title. Changed 1 updated deck setting.',
        agentChatId: 'thread-9',
      },
    }]);
  });
});
