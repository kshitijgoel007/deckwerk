import { describe, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import type { AgentChatSendRequest } from '../src/shared/ipc.js';
import {
  AgentChatController,
  type AgentChatControllerOptions,
} from '../src/main/agentChat.js';
import type { AppServerNotification } from '../src/main/codexAppServer.js';
import { agentClipboardPrompt } from '../src/server/agentBrief.js';

class FakeAppServer {
  readonly requests: Array<{ method: string; params: any }> = [];
  account: any = { type: 'chatgpt', email: 'slides@example.com', planType: 'plus' };
  nextThreadId = 'thread-1';
  async start(): Promise<void> {}
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === 'account/read') return {
      account: this.account, requiresOpenaiAuth: true,
    } as T;
    if (method === 'model/list') return {
      data: [
        {
          model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Frontier',
          hidden: false, isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Lighter reasoning' },
            { reasoningEffort: 'medium', description: 'Balanced reasoning' },
          ],
          defaultReasoningEffort: 'medium',
          serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster responses' }],
          defaultServiceTier: 'priority',
        },
        {
          model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: 'Balanced',
          hidden: false, isDefault: false,
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Lighter reasoning' },
            { reasoningEffort: 'medium', description: 'Balanced reasoning' },
          ],
          defaultReasoningEffort: 'medium',
          serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster responses' }],
          defaultServiceTier: null,
        },
      ],
      nextCursor: null,
    } as T;
    if (method === 'thread/start') return { thread: { id: this.nextThreadId } } as T;
    if (method === 'thread/resume') return { thread: { id: (params as any).threadId } } as T;
    if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } } as T;
    if (method === 'turn/steer') return { turnId: 'turn-1' } as T;
    if (method === 'account/login/start') return {
      type: 'chatgpt', loginId: 'login-1', authUrl: 'https://chatgpt.com/auth',
    } as T;
    if (method === 'account/logout') {
      this.account = null;
      return {} as T;
    }
    return {} as T;
  }
  close(): void {}
}

function fixture(account?: any) {
  const server = new FakeAppServer();
  if (account !== undefined) server.account = account;
  let notify: (event: AppServerNotification) => void = () => undefined;
  const states: any[] = [];
  const opened: string[] = [];
  const options: AgentChatControllerOptions = {
    clientFactory: (callbacks) => {
      notify = callbacks.onNotification;
      return server;
    },
    openExternal: async (url) => { opened.push(url); },
    onState: (state) => states.push(state),
    persistence: false,
  };
  return { controller: new AgentChatController(options), server, states, opened, notify: (event: AppServerNotification) => notify(event) };
}

const request: AgentChatSendRequest = {
  text: 'Polish this slide',
};

describe('embedded agent chat controller', () => {
  it('creates a deck-scoped sandboxed thread and streams the assistant reply', async () => {
    const { controller, server, notify } = fixture();
    const initial = await controller.getState('/tmp/talk');
    expect(initial).toMatchObject({
      connection: 'ready',
      auth: 'signedIn',
      accountLabel: 'slides@example.com',
      selectedModel: 'gpt-5.6-sol',
      selectedReasoningEffort: 'medium',
      fastMode: true,
    });

    const completePrompt = agentClipboardPrompt(
      'http://127.0.0.1:5800/?deck=talk&agent=1',
      'talk',
    );
    const prepare = vi.fn(async () => completePrompt);
    const working = await controller.send('/tmp/talk', request, prepare);
    expect(working.busy).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
    const thread = server.requests.find((entry) => entry.method === 'thread/start')!;
    expect(thread.params).toMatchObject({
      cwd: expect.stringContaining('deckwerk-agent-runtime'),
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      model: 'gpt-5.6-sol',
      serviceTier: 'priority',
    });
    expect(thread.params.developerInstructions).toBe(completePrompt);
    const turn = server.requests.find((entry) => entry.method === 'turn/start')!;
    expect(turn.params.sandboxPolicy).toMatchObject({
      type: 'workspaceWrite',
      writableRoots: [expect.stringContaining('deckwerk-agent-runtime')],
      networkAccess: true,
    });
    expect(turn.params.input[0].text).toBe('Polish this slide');
    expect(turn.params.model).toBe('gpt-5.6-sol');
    expect(turn.params.effort).toBe('medium');
    expect(turn.params.serviceTier).toBe('priority');

    notify({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer-1', delta: 'Done' },
    });
    notify({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    const complete = await controller.getState('/tmp/talk');
    expect(complete.busy).toBe(false);
    expect(complete.messages.map((message) => [message.role, message.text]))
      .toEqual([['user', 'Polish this slide'], ['assistant', 'Done']]);
  });

  it('steers an active turn when the user sends a follow-up', async () => {
    const { controller, server } = fixture();
    const prepare = vi.fn(async () => 'HTTP session');
    await controller.getState('/tmp/talk');
    await controller.send('/tmp/talk', request, prepare);
    const steered = await controller.send(
      '/tmp/talk',
      { text: 'Also tighten the body copy' },
      prepare,
    );
    expect(steered.busy).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
    expect(server.requests.find((entry) => entry.method === 'turn/steer')?.params)
      .toMatchObject({
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'Also tighten the body copy', text_elements: [] }],
      });
    expect(steered.messages.filter((message) => message.role === 'user').map((message) => message.text))
      .toEqual(['Polish this slide', 'Also tighten the body copy']);
  });

  it('suspends a live session without clearing its transcript or thread', async () => {
    const { controller, server } = fixture();
    await controller.getState('/tmp/talk');
    await controller.send('/tmp/talk', request, async () => 'HTTP session');
    const suspended = await controller.suspend('/tmp/talk');
    expect(suspended).toMatchObject({
      busy: false,
      messages: [expect.objectContaining({ role: 'user', text: 'Polish this slide' })],
    });
    expect(server.requests.find((entry) => entry.method === 'turn/interrupt')?.params)
      .toMatchObject({ threadId: 'thread-1', turnId: 'turn-1' });
    await controller.send('/tmp/talk', { text: 'Continue later' }, async () => 'unused');
    expect(server.requests.filter((entry) => entry.method === 'thread/start')).toHaveLength(1);
  });

  it('uses the standard service tier when fast mode is disabled', async () => {
    const { controller, server } = fixture();
    await controller.getState('/tmp/talk');
    expect((await controller.setFastMode('/tmp/talk', false)).fastMode).toBe(false);
    await controller.send('/tmp/talk', request, async () => 'HTTP session');
    expect(server.requests.find((entry) => entry.method === 'thread/start')?.params.serviceTier)
      .toBe('default');
    expect(server.requests.find((entry) => entry.method === 'turn/start')?.params.serviceTier)
      .toBe('default');
  });

  it('uses the selected reasoning effort for the turn', async () => {
    const { controller, server } = fixture();
    await controller.getState('/tmp/talk');
    expect((await controller.setReasoningEffort('/tmp/talk', 'low')).selectedReasoningEffort)
      .toBe('low');
    await controller.send('/tmp/talk', request, async () => 'HTTP session');
    expect(server.requests.find((entry) => entry.method === 'turn/start')?.params.effort)
      .toBe('low');
  });

  it('advertises the host browser when a dynamic-tool handler is available', async () => {
    const server = new FakeAppServer();
    const controller = new AgentChatController({
      clientFactory: () => server,
      onDynamicToolCall: async () => ({ success: true, contentItems: [] }),
    });
    await controller.getState('/tmp/talk');
    await controller.send('/tmp/talk', request, async () => 'HTTP session');
    expect(server.requests.find((entry) => entry.method === 'thread/start')?.params.dynamicTools)
      .toEqual([expect.objectContaining({ type: 'function', name: 'browser_open' })]);
  });

  it('opens managed ChatGPT sign-in when no account is available', async () => {
    const { controller, opened } = fixture(null);
    expect(await controller.getState('/tmp/talk')).toMatchObject({ auth: 'signedOut' });
    await controller.login('/tmp/talk');
    expect(opened).toEqual(['https://chatgpt.com/auth']);
  });

  it('uses an available model selected for the deck conversation', async () => {
    const { controller, server, notify } = fixture();
    await controller.getState('/tmp/talk');
    await controller.send('/tmp/talk', request, async () => 'HTTP session');
    notify({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    const selected = await controller.setModel('/tmp/talk', 'gpt-5.6-terra');
    expect(selected.selectedModel).toBe('gpt-5.6-terra');
    await controller.send('/tmp/talk', { text: 'Now use the balanced model' }, async () => 'unused');
    expect(server.requests.filter((entry) => entry.method === 'thread/start')).toHaveLength(1);
    expect(server.requests.filter((entry) => entry.method === 'turn/start').map((entry) => entry.params.model))
      .toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  it('ignores a stale login cancellation after the account is signed in', async () => {
    const { controller, server, notify } = fixture(null);
    await controller.getState('/tmp/talk');
    await controller.login('/tmp/talk');
    server.account = { type: 'chatgpt', email: 'slides@example.com', planType: 'plus' };
    notify({
      method: 'account/login/completed',
      params: { loginId: 'login-1', success: false, error: 'Login server error: login cancelled' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await controller.getState('/tmp/talk')).toMatchObject({
      auth: 'signedIn',
      accountLabel: 'slides@example.com',
      error: null,
    });
  });

  it('logs out before a fresh login, drops the old thread, and preserves the deck transcript', async () => {
    const { controller, server, opened, notify } = fixture();
    await controller.getState('/tmp/talk');
    await controller.send('/tmp/talk', request, async () => 'old account prompt');
    notify({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
    await controller.switchAccount('/tmp/talk');
    expect(server.requests.map((entry) => entry.method)).toContain('account/logout');
    expect(server.requests.findIndex((entry) => entry.method === 'account/logout'))
      .toBeLessThan(server.requests.findIndex((entry) => entry.method === 'account/login/start'));
    expect(opened).toEqual(['https://chatgpt.com/auth']);

    server.account = { type: 'chatgpt', email: 'vsitzmann@rhoda.ai', planType: 'team' };
    notify({ method: 'account/login/completed', params: { success: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await controller.getState('/tmp/talk')).toMatchObject({
      auth: 'signedIn',
      accountLabel: 'vsitzmann@rhoda.ai',
      messages: [expect.objectContaining({ role: 'user', text: 'Polish this slide' })],
    });
  });

  it('requests a fresh live-session prompt after the chat is reset', async () => {
    const { controller, server } = fixture();
    await controller.getState('/tmp/talk');
    await controller.send('/tmp/talk', request, async () => 'first HTTP session');
    await controller.reset('/tmp/talk');
    await controller.send('/tmp/talk', request, async () => 'second HTTP session');
    const starts = server.requests.filter((entry) => entry.method === 'thread/start');
    expect(starts.map((entry) => entry.params.developerInstructions))
      .toEqual(['first HTTP session', 'second HTTP session']);
  });

  it('saves chat with the deck and resumes its Codex thread after restart', async () => {
    const deckPath = await mkdtemp(join(tmpdir(), 'deckwerk-agent-chat-'));
    try {
      const firstServer = new FakeAppServer();
      let firstNotify: (event: AppServerNotification) => void = () => undefined;
      const first = new AgentChatController({
        clientFactory: (callbacks) => {
          firstNotify = callbacks.onNotification;
          return firstServer;
        },
      });
      await first.getState(deckPath);
      await first.send(deckPath, request, async () => 'first live HTTP session');
      firstNotify({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer-1', delta: 'Saved reply' },
      });
      firstNotify({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      });
      first.close();

      const saved = JSON.parse(await readFile(join(deckPath, 'agent-chats.json'), 'utf8'));
      expect(saved).toMatchObject({
        version: 2,
        active: {
          threadId: 'thread-1',
          threadAccount: 'slides@example.com',
        },
      });
      expect(saved.active.messages.map((message: any) => [message.role, message.text]))
        .toEqual([['user', 'Polish this slide'], ['assistant', 'Saved reply']]);

      const secondServer = new FakeAppServer();
      const second = new AgentChatController({ clientFactory: () => secondServer });
      const restored = await second.getState(deckPath);
      expect(restored.messages.map((message) => [message.role, message.text]))
        .toEqual([['user', 'Polish this slide'], ['assistant', 'Saved reply']]);
      await second.send(deckPath, { text: 'Continue' }, async () => 'fresh live HTTP session');
      expect(secondServer.requests.find((entry) => entry.method === 'thread/resume')?.params)
        .toMatchObject({
          threadId: 'thread-1',
          developerInstructions: 'fresh live HTTP session',
          runtimeWorkspaceRoots: [expect.stringContaining('deckwerk-agent-runtime')],
        });
      expect(secondServer.requests.filter((entry) => entry.method === 'thread/start')).toHaveLength(0);
      second.close();
    } finally {
      await rm(deckPath, { recursive: true, force: true });
    }
  });

  it('migrates the original single-chat deck file into conversation history', async () => {
    const deckPath = await mkdtemp(join(tmpdir(), 'deckwerk-agent-chat-v1-'));
    try {
      await writeFile(join(deckPath, 'agent-chats.json'), JSON.stringify({
        version: 1,
        threadId: 'legacy-thread',
        threadAccount: 'slides@example.com',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'low',
        fastMode: false,
        messages: [{ id: 'legacy-user', role: 'user', text: 'Legacy deck request' }],
        updatedAt: '2026-08-18T12:00:00Z',
      }));
      const controller = new AgentChatController({ clientFactory: () => new FakeAppServer() });
      const restored = await controller.getState(deckPath);
      expect(restored.chatId).toBe('legacy-thread');
      expect(restored.conversations[0]).toMatchObject({
        chatId: 'legacy-thread', title: 'Legacy deck request', active: true,
      });
      controller.close();
    } finally {
      await rm(deckPath, { recursive: true, force: true });
    }
  });

  it('archives chats with the deck and can reopen an earlier conversation', async () => {
    const deckPath = await mkdtemp(join(tmpdir(), 'deckwerk-agent-chat-history-'));
    try {
      const server = new FakeAppServer();
      let notify: (event: AppServerNotification) => void = () => undefined;
      const controller = new AgentChatController({
        clientFactory: (callbacks) => {
          notify = callbacks.onNotification;
          return server;
        },
      });
      await controller.getState(deckPath);
      await controller.send(deckPath, request, async () => 'first session');
      notify({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      });
      await controller.reset(deckPath);
      server.nextThreadId = 'thread-2';
      await controller.send(deckPath, { text: 'Second conversation' }, async () => 'second session');
      notify({
        method: 'turn/completed',
        params: { threadId: 'thread-2', turn: { id: 'turn-1', status: 'completed' } },
      });

      const current = await controller.getState(deckPath);
      expect(current.conversations.map((chat) => chat.chatId))
        .toEqual(['thread-2', 'thread-1']);
      expect(controller.getTranscript(deckPath, 'thread-1')?.messages[0]?.text)
        .toBe('Polish this slide');
      const reopened = await controller.select(deckPath, 'thread-1');
      expect(reopened.chatId).toBe('thread-1');
      expect(reopened.messages[0]?.text).toBe('Polish this slide');
      controller.close();
    } finally {
      await rm(deckPath, { recursive: true, force: true });
    }
  });
});
