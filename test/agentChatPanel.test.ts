import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChatState } from '../src/shared/ipc.js';
import { AgentChatPanel, type AgentChatApi } from '../src/renderer/editor/agentChatPanel.js';

const ready = (over: Partial<AgentChatState> = {}): AgentChatState => ({
  deckPath: '/tmp/talk',
  connection: 'ready',
  auth: 'signedIn',
  accountLabel: 'slides@example.com',
  busy: false,
  activity: null,
  messages: [],
  error: null,
  ...over,
});

describe('agent chat panel', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      HTMLButtonElement: dom.window.HTMLButtonElement,
      HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
      Node: dom.window.Node,
      KeyboardEvent: dom.window.KeyboardEvent,
    });
  });

  it('opens focused and sends on Enter after flushing editor state', async () => {
    let listener: (state: AgentChatState) => void = () => undefined;
    const sent: string[] = [];
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async (request) => {
        sent.push(request.text);
        return ready({ messages: [{ id: 'u1', role: 'user', text: request.text }], busy: true });
      },
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: async () => ready(),
      interruptAgentChat: async () => ready(),
      resetAgentChat: async () => ready(),
      onAgentChatState: (fn) => { listener = fn; return () => undefined; },
    };
    const panel = new AgentChatPanel({
      api,
      currentDeckPath: () => '/tmp/talk',
    });

    panel.show();
    await Promise.resolve();
    listener(ready());
    const input = panel.element.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(panel.element.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    input.value = 'Make the title stronger';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual(['Make the title stronger']);
    expect(input.value).toBe('');
  });

  it('switches the send action to Stop while a turn is active', async () => {
    let listener: (state: AgentChatState) => void = () => undefined;
    const interrupt = vi.fn(async () => ready());
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async () => ready(),
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: async () => ready(),
      interruptAgentChat: interrupt,
      resetAgentChat: async () => ready(),
      onAgentChatState: (fn) => { listener = fn; return () => undefined; },
    };
    const panel = new AgentChatPanel({
      api,
      currentDeckPath: () => '/tmp/talk',
    });
    listener(ready({ busy: true, activity: 'Editing slides…' }));
    const action = panel.element.querySelector<HTMLButtonElement>('.agent-chat-action')!;
    expect(action.textContent).toBe('Stop');
    action.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('uses the explicit close callback while Escape only tucks the panel away', () => {
    const onClose = vi.fn();
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async () => ready(),
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: async () => ready(),
      interruptAgentChat: async () => ready(),
      resetAgentChat: async () => ready(),
      onAgentChatState: () => () => undefined,
    };
    const panel = new AgentChatPanel({
      api,
      currentDeckPath: () => '/tmp/talk',
      onClose,
    });
    panel.show();
    panel.element.querySelector<HTMLTextAreaElement>('textarea')!.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(panel.element.hidden).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    panel.show();
    [...panel.element.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Close')!
      .click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('offers account switching beside the signed-in identity', async () => {
    let listener: (state: AgentChatState) => void = () => undefined;
    const switchAccount = vi.fn(async () => ready({ accountLabel: 'vsitzmann@rhoda.ai' }));
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async () => ready(),
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: switchAccount,
      interruptAgentChat: async () => ready(),
      resetAgentChat: async () => ready(),
      onAgentChatState: (fn) => { listener = fn; return () => undefined; },
    };
    const panel = new AgentChatPanel({ api, currentDeckPath: () => '/tmp/talk' });
    listener(ready());
    const button = panel.element.querySelector<HTMLButtonElement>('.agent-chat-switch-account')!;
    expect(button.textContent).toBe('Switch account');
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switchAccount).toHaveBeenCalledOnce();
    expect(panel.element.querySelector('.agent-chat-account')?.textContent)
      .toContain('vsitzmann@rhoda.ai');
  });
});
