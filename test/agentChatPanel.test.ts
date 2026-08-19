import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChatState } from '../src/shared/ipc.js';
import { AgentChatPanel, type AgentChatApi } from '../src/renderer/editor/agentChatPanel.js';

const ready = (over: Partial<AgentChatState> = {}): AgentChatState => ({
  deckPath: '/tmp/talk',
  connection: 'ready',
  auth: 'signedIn',
  accountLabel: 'slides@example.com',
  models: [
    {
      model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Frontier', isDefault: true,
      reasoningEfforts: [
        { effort: 'low', description: 'Lighter reasoning' },
        { effort: 'medium', description: 'Balanced reasoning' },
      ],
      defaultReasoningEffort: 'medium',
      serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster responses' }],
      defaultServiceTier: 'priority',
    },
    {
      model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: 'Balanced', isDefault: false,
      reasoningEfforts: [
        { effort: 'low', description: 'Lighter reasoning' },
        { effort: 'medium', description: 'Balanced reasoning' },
      ],
      defaultReasoningEffort: 'medium',
      serviceTiers: [], defaultServiceTier: null,
    },
  ],
  selectedModel: 'gpt-5.6-sol',
  selectedReasoningEffort: 'medium',
  fastMode: true,
  scratchpad: null,
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
      setAgentChatModel: async ({ model }) => ready({ selectedModel: model }),
      setAgentChatReasoningEffort: async ({ effort }) => ready({ selectedReasoningEffort: effort }),
      setAgentChatFastMode: async ({ enabled }) => ready({ fastMode: enabled }),
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

  it('keeps follow-up sending available and exposes a separate Stop action', async () => {
    let listener: (state: AgentChatState) => void = () => undefined;
    const interrupt = vi.fn(async () => ready());
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async () => ready(),
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: async () => ready(),
      setAgentChatModel: async ({ model }) => ready({ selectedModel: model }),
      setAgentChatReasoningEffort: async ({ effort }) => ready({ selectedReasoningEffort: effort }),
      setAgentChatFastMode: async ({ enabled }) => ready({ fastMode: enabled }),
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
    const input = panel.element.querySelector<HTMLTextAreaElement>('textarea')!;
    const stop = panel.element.querySelector<HTMLButtonElement>('.agent-chat-stop')!;
    expect(action.textContent).toBe('Send');
    expect(input.disabled).toBe(false);
    expect(stop.hidden).toBe(false);
    stop.click();
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
      setAgentChatModel: async ({ model }) => ready({ selectedModel: model }),
      setAgentChatReasoningEffort: async ({ effort }) => ready({ selectedReasoningEffort: effort }),
      setAgentChatFastMode: async ({ enabled }) => ready({ fastMode: enabled }),
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
      setAgentChatModel: async ({ model }) => ready({ selectedModel: model }),
      setAgentChatReasoningEffort: async ({ effort }) => ready({ selectedReasoningEffort: effort }),
      setAgentChatFastMode: async ({ enabled }) => ready({ fastMode: enabled }),
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

  it('shows the account model catalog and applies a selection', async () => {
    let listener: (state: AgentChatState) => void = () => undefined;
    const setModel = vi.fn(async ({ model }: { model: string }) => ready({ selectedModel: model }));
    const setReasoningEffort = vi.fn(async ({ effort }: { effort: string }) =>
      ready({ selectedReasoningEffort: effort }));
    const setFastMode = vi.fn(async ({ enabled }: { enabled: boolean }) => ready({ fastMode: enabled }));
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async () => ready(),
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: async () => ready(),
      setAgentChatModel: setModel,
      setAgentChatReasoningEffort: setReasoningEffort,
      setAgentChatFastMode: setFastMode,
      interruptAgentChat: async () => ready(),
      resetAgentChat: async () => ready(),
      onAgentChatState: (fn) => { listener = fn; return () => undefined; },
    };
    const panel = new AgentChatPanel({ api, currentDeckPath: () => '/tmp/talk' });
    listener(ready());
    const select = panel.element.querySelector<HTMLSelectElement>('.agent-chat-model select')!;
    expect([...select.options].map((option) => option.textContent))
      .toEqual(['GPT-5.6 Sol (default)', 'GPT-5.6 Terra']);
    select.value = 'gpt-5.6-terra';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setModel).toHaveBeenCalledWith({ model: 'gpt-5.6-terra' });
    expect(select.value).toBe('gpt-5.6-terra');

    listener(ready());
    const effort = panel.element.querySelector<HTMLSelectElement>('.agent-chat-effort-select')!;
    expect([...effort.options].map((option) => option.textContent))
      .toEqual(['low', 'medium']);
    effort.value = 'low';
    effort.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setReasoningEffort).toHaveBeenCalledWith({ effort: 'low' });

    const fast = panel.element.querySelector<HTMLButtonElement>('.agent-chat-fast-mode')!;
    expect(fast.hidden).toBe(false);
    expect(fast.getAttribute('aria-pressed')).toBe('true');
    fast.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setFastMode).toHaveBeenCalledWith({ enabled: false });
  });

  it('automatically opens the newest HTML draft as an agent scratchpad', () => {
    let listener: (state: AgentChatState) => void = () => undefined;
    const api: AgentChatApi = {
      getAgentChatState: async () => ready(),
      sendAgentChatMessage: async () => ready(),
      loginAgentChat: async () => ready(),
      switchAgentChatAccount: async () => ready(),
      setAgentChatModel: async ({ model }) => ready({ selectedModel: model }),
      setAgentChatReasoningEffort: async ({ effort }) => ready({ selectedReasoningEffort: effort }),
      setAgentChatFastMode: async ({ enabled }) => ready({ fastMode: enabled }),
      interruptAgentChat: async () => ready(),
      resetAgentChat: async () => ready(),
      onAgentChatState: (fn) => { listener = fn; return () => undefined; },
    };
    const panel = new AgentChatPanel({ api, currentDeckPath: () => '/tmp/talk' });
    listener(ready({
      scratchpad: {
        draftId: 'draft-1',
        slideCount: 8,
        sourceUrl: 'http://127.0.0.1:5800/api/html-drafts/draft-1/source?deck=talk',
        importedUrl: 'http://127.0.0.1:5800/api/html-drafts/draft-1/imported?deck=talk',
        sourceContactSheetUrl: 'http://127.0.0.1:5800/source.png',
        importedContactSheetUrl: 'http://127.0.0.1:5800/imported.png',
      },
    }));
    expect(panel.element.querySelector('.agent-chat-scratchpad-bar')?.textContent)
      .toContain('8 slides');
    const scratchpad = document.querySelector<HTMLElement>('.agent-scratchpad-panel')!;
    expect(scratchpad.hidden).toBe(false);
    const frame = scratchpad.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toContain('/source?deck=talk&scratchpad=slides');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');

    [...scratchpad.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Contact sheet')!.click();
    expect(frame.getAttribute('src')).toContain('scratchpad=contact');
    [...scratchpad.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Imported')!.click();
    expect(frame.getAttribute('src')).toContain('/imported?deck=talk&scratchpad=contact');
  });
});
