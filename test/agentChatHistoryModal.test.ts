// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChatTranscript } from '../src/shared/ipc.js';
import { AgentChatHistoryModal } from '../src/renderer/editor/agentChatHistoryModal.js';

describe('Agent chat history modal', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value() { this.setAttribute('open', ''); },
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value() { this.removeAttribute('open'); },
    });
  });

  it('opens the saved transcript associated with a history edit', async () => {
    const transcript: AgentChatTranscript = {
      chatId: 'thread-1',
      accountLabel: 'slides@example.com',
      updatedAt: '2026-08-19T12:00:00Z',
      messages: [
        { id: 'u1', role: 'user', text: 'Make the opening clearer' },
        { id: 'a1', role: 'assistant', text: 'I revised slides 2 and 3.' },
      ],
    };
    const modal = new AgentChatHistoryModal({
      getAgentChatTranscript: vi.fn(async () => transcript),
    });
    await modal.open('thread-1');
    expect(modal.element.open).toBe(true);
    expect(modal.element.textContent).toContain('Make the opening clearer');
    expect(modal.element.textContent).toContain('I revised slides 2 and 3.');
  });
});
