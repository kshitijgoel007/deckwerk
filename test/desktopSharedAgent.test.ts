import { describe, expect, it, vi } from 'vitest';
import type { AgentChatController } from '../src/main/agentChat.js';
import {
  DESKTOP_AGENT_PARTICIPANT,
  DesktopSharedAgent,
} from '../src/main/desktopSharedAgent.js';
import type { AgentChatState } from '../src/shared/ipc.js';

function state(deckPath: string): AgentChatState {
  return {
    deckPath,
    chatId: 'chat-1',
    conversations: [],
    connection: 'ready',
    auth: 'signedIn',
    accountLabel: 'owner@example.com',
    models: [],
    selectedModel: null,
    selectedReasoningEffort: null,
    fastMode: false,
    scratchpad: null,
    busy: false,
    activity: null,
    messages: [],
    error: null,
  };
}

describe('desktop Agent collaboration adapter', () => {
  it('keeps the host on the native conversation and maps state updates back to the browser', async () => {
    const getState = vi.fn(async (deckPath: string, conversationKey: string) => {
      expect(conversationKey).toBe('');
      return state(deckPath);
    });
    const close = vi.fn();
    let emit: ((state: AgentChatState, conversationKey: string) => void) | null = null;
    const adapter = new DesktopSharedAgent({
      controller: { getState, close } as unknown as AgentChatController,
      subscribe: (listener) => {
        emit = listener;
        return () => { emit = null; };
      },
    });

    await expect(adapter.getState('/deck', DESKTOP_AGENT_PARTICIPANT))
      .resolves.toMatchObject({ deckPath: '/deck', chatId: 'chat-1' });

    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    const next = state('/deck');
    emit!(next, '');
    expect(listener).toHaveBeenCalledWith(next, DESKTOP_AGENT_PARTICIPANT);
    unsubscribe();

    adapter.close();
    expect(close).not.toHaveBeenCalled();
  });
});
