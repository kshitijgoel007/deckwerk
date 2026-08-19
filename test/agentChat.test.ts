import { describe, expect, it, vi } from 'vitest';
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
          serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster responses' }],
          defaultServiceTier: 'priority',
        },
        {
          model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: 'Balanced',
          hidden: false, isDefault: false,
          serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster responses' }],
          defaultServiceTier: null,
        },
      ],
      nextCursor: null,
    } as T;
    if (method === 'thread/start') return { thread: { id: 'thread-1' } } as T;
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

  it('logs out before starting a fresh account login and drops old-account threads', async () => {
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
      messages: [],
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
});
