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
    if (method === 'thread/start') return { thread: { id: 'thread-1' } } as T;
    if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } } as T;
    if (method === 'account/login/start') return {
      type: 'chatgpt', loginId: 'login-1', authUrl: 'https://chatgpt.com/auth',
    } as T;
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
    expect(initial).toMatchObject({ connection: 'ready', auth: 'signedIn', accountLabel: 'slides@example.com' });

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
    });
    expect(thread.params.developerInstructions).toBe(completePrompt);
    const turn = server.requests.find((entry) => entry.method === 'turn/start')!;
    expect(turn.params.sandboxPolicy).toMatchObject({
      type: 'workspaceWrite',
      writableRoots: [expect.stringContaining('deckwerk-agent-runtime')],
      networkAccess: true,
    });
    expect(turn.params.input[0].text).toBe('Polish this slide');

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

  it('opens managed ChatGPT sign-in when no account is available', async () => {
    const { controller, opened } = fixture(null);
    expect(await controller.getState('/tmp/talk')).toMatchObject({ auth: 'signedOut' });
    await controller.login('/tmp/talk');
    expect(opened).toEqual(['https://chatgpt.com/auth']);
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
