import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentChatMessage,
  AgentChatModel,
  AgentChatScratchpad,
  AgentChatConversationSummary,
  AgentChatSendRequest,
  AgentChatState,
  AgentChatTranscript,
} from '@shared/ipc.js';
import {
  CodexAppServerClient,
  type AppServerNotification,
  type DynamicToolCall,
  type DynamicToolResult,
} from './codexAppServer.js';

const BROWSER_OPEN_TOOL = {
  type: 'function',
  name: 'browser_open',
  description: 'Open an HTTP(S) page in DeckWerk\'s Chromium browser and return a screenshot plus page metadata. Use it for visual inspection when a live browser view is more useful than the presentation PNG endpoints.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http:// or https:// URL to open.' },
      width: { type: 'integer', minimum: 320, maximum: 2560, default: 1440 },
      height: { type: 'integer', minimum: 240, maximum: 1600, default: 900 },
      waitMs: { type: 'integer', minimum: 0, maximum: 5000, default: 250 },
    },
    required: ['url'],
    additionalProperties: false,
  },
} as const;

interface AccountReadResult {
  account: null | { type: 'apiKey' }
    | { type: 'chatgpt'; email: string | null; planType: string }
    | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean };
  requiresOpenaiAuth: boolean;
}

interface ThreadStartResult {
  thread: { id: string };
}

interface ThreadResumeResult {
  thread: { id: string };
}

interface TurnStartResult {
  turn: { id: string; status: string };
}

interface TurnSteerResult {
  turnId: string;
}

interface LoginResult {
  type: string;
  loginId?: string;
  authUrl?: string;
}

interface ModelListResult {
  data: Array<{
    model: string;
    displayName: string;
    description: string;
    hidden: boolean;
    isDefault: boolean;
    supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
    defaultReasoningEffort: string | null;
    serviceTiers: Array<{ id: string; name: string; description: string }>;
    defaultServiceTier: string | null;
  }>;
  nextCursor: string | null;
}

interface AppServerLike {
  start(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  close(): void;
}

interface AgentChatSession {
  deckPath: string;
  /** Optional in-memory conversation partition used by the shared server demo. */
  conversationKey: string;
  threadId: string | null;
  threadAttached: boolean;
  threadAccount: string | null;
  activeTurnId: string | null;
  agentPrompt: string | null;
  runtimeDir: string | null;
  model: string | null;
  reasoningEffort: string | null;
  fastMode: boolean;
  scratchpad: AgentChatScratchpad | null;
  queuedFollowUps: string[];
  messages: AgentChatMessage[];
  updatedAt: string;
  archivedChats: PersistedConversation[];
  busy: boolean;
  activity: string | null;
  error: string | null;
}

export interface AgentChatControllerOptions {
  clientFactory?: (callbacks: {
    onNotification: (notification: AppServerNotification) => void;
    onExit: (message: string) => void;
    onDynamicToolCall?: (call: DynamicToolCall) => Promise<DynamicToolResult>;
  }) => AppServerLike;
  openExternal?: (url: string) => Promise<unknown>;
  onState?: (state: AgentChatState, conversationKey: string) => void;
  onDynamicToolCall?: (call: DynamicToolCall) => Promise<DynamicToolResult>;
  /** Keep this embedded agent's login separate from other Codex clients. */
  codexHome?: string;
  /** Disable deck-side persistence in isolated tests. Enabled by default. */
  persistence?: boolean;
}

export const AGENT_CHAT_FILE = 'agent-chats.json';

interface PersistedConversation {
  threadId: string | null;
  threadAccount: string | null;
  model: string | null;
  reasoningEffort: string | null;
  fastMode: boolean;
  messages: AgentChatMessage[];
  updatedAt: string;
}

interface PersistedAgentChats {
  version: 2;
  active: PersistedConversation;
  archived: PersistedConversation[];
}

/** Owns deck-scoped Codex threads and exposes only normalized chat state to Electron. */
export class AgentChatController {
  private readonly options: AgentChatControllerOptions;
  private client: AppServerLike | null = null;
  private starting: Promise<void> | null = null;
  private connection: AgentChatState['connection'] = 'connecting';
  private auth: AgentChatState['auth'] = 'unknown';
  private accountLabel: string | null = null;
  private models: AgentChatModel[] = [];
  private activeLoginId: string | null = null;
  private loginError: string | null = null;
  private globalError: string | null = null;
  private sessions = new Map<string, AgentChatSession>();
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runtimeDir = join(tmpdir(), 'deckwerk-agent-runtime');

  constructor(options: AgentChatControllerOptions = {}) {
    this.options = options;
  }

  async getState(deckPath: string, conversationKey = ''): Promise<AgentChatState> {
    const session = this.session(deckPath, conversationKey);
    this.emit(session);
    try {
      await this.ensureClient();
    } catch (error) {
      this.failConnection(error);
    }
    return this.snapshot(session);
  }

  async login(deckPath: string, conversationKey = ''): Promise<AgentChatState> {
    const session = this.session(deckPath, conversationKey);
    try {
      await this.ensureClient();
      const result = await this.client!.request<LoginResult>('account/login/start', {
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
        appBrand: 'chatgpt',
      });
      if (!result.authUrl) throw new Error('Codex did not return a sign-in URL');
      this.activeLoginId = result.loginId ?? null;
      this.loginError = null;
      session.activity = 'Finish signing in in your browser…';
      session.error = null;
      this.emit(session);
      await this.options.openExternal?.(result.authUrl);
    } catch (error) {
      // OAuth completion and request rejection can race. If the account is
      // already usable, a late "login cancelled" result is stale, not an error.
      await this.refreshAccountAndModels().catch(() => undefined);
      if (this.auth === 'signedIn') this.clearLoginStatus();
      else {
        this.loginError = message(error);
        session.activity = null;
      }
      this.emit(session);
    }
    return this.snapshot(session);
  }

  async switchAccount(deckPath: string, conversationKey = ''): Promise<AgentChatState> {
    const session = this.session(deckPath, conversationKey);
    try {
      await this.ensureClient();
      if ([...this.sessions.values()].some((candidate) => candidate.busy)) {
        throw new Error('Stop the active agent turn before switching accounts');
      }
      await this.client!.request('account/logout');
      this.auth = 'signedOut';
      this.accountLabel = null;
      this.models = [];
      this.activeLoginId = null;
      this.loginError = null;
      // Threads belong to the account that created them. Never resume one
      // after authentication changes, even when it targeted the same deck.
      for (const candidate of this.sessions.values()) {
        this.archiveActive(candidate);
        candidate.threadId = null;
        candidate.threadAttached = false;
        candidate.threadAccount = null;
        candidate.activeTurnId = null;
        candidate.agentPrompt = null;
        candidate.runtimeDir = null;
        candidate.model = null;
        candidate.reasoningEffort = null;
        candidate.fastMode = false;
        candidate.scratchpad = null;
        candidate.queuedFollowUps = [];
        candidate.activity = null;
        candidate.error = null;
      }
      this.emitAll();
      return this.login(deckPath, conversationKey);
    } catch (error) {
      session.error = message(error);
      session.activity = null;
      this.emit(session);
      return this.snapshot(session);
    }
  }

  async send(
    deckPath: string,
    request: AgentChatSendRequest,
    prepareAgentPrompt: () => Promise<string>,
    conversationKey = '',
  ): Promise<AgentChatState> {
    const session = this.session(deckPath, conversationKey);
    const text = request.text.trim();
    if (!text) return this.snapshot(session);

    try {
      await this.ensureClient();
      if (this.auth !== 'signedIn') throw new Error('Sign in with ChatGPT before sending a message');
      if (session.busy) return await this.steer(session, text);

      session.messages.push({ id: randomUUID(), role: 'user', text });
      session.updatedAt = new Date().toISOString();
      session.busy = true;
      session.activity = 'Starting the deck API session…';
      session.error = null;
      this.emit(session);

      if (!session.threadAttached) {
        const previousMessages = session.messages.slice(0, -1);
        await this.attachThread(session, prepareAgentPrompt, previousMessages);
      }

      session.activity = 'Thinking…';
      this.emit(session);
      const turn = await this.client!.request<TurnStartResult>('turn/start', {
        threadId: session.threadId,
        ...(session.model ? { model: session.model } : {}),
        ...(session.reasoningEffort ? { effort: session.reasoningEffort } : {}),
        serviceTier: this.serviceTierFor(session),
        input: [{ type: 'text', text, text_elements: [] }],
        cwd: session.runtimeDir,
        approvalPolicy: 'never',
        sandboxPolicy: {
          // Only neutral scratch space is writable; the deck itself is not in
          // the sandbox. Loopback networking is the editing capability.
          type: 'workspaceWrite',
          writableRoots: [session.runtimeDir],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        summary: 'concise',
        personality: 'friendly',
      });
      session.activeTurnId = turn.turn.id;
      this.emit(session);
      for (const followUp of session.queuedFollowUps.splice(0)) {
        await this.dispatchSteer(session, followUp);
      }
    } catch (error) {
      session.busy = false;
      session.queuedFollowUps = [];
      session.activity = null;
      session.error = message(error);
      session.messages.push({
        id: randomUUID(), role: 'system', text: session.error, error: true,
      });
      this.emit(session);
    }
    return this.snapshot(session);
  }

  private async steer(session: AgentChatSession, text: string): Promise<AgentChatState> {
    session.messages.push({ id: randomUUID(), role: 'user', text });
    session.updatedAt = new Date().toISOString();
    if (!session.threadId || !session.activeTurnId) {
      session.queuedFollowUps.push(text);
      session.activity = 'Queueing follow-up…';
      session.error = null;
      this.emit(session);
      return this.snapshot(session);
    }
    await this.dispatchSteer(session, text);
    return this.snapshot(session);
  }

  private async dispatchSteer(session: AgentChatSession, text: string): Promise<void> {
    session.activity = 'Sending follow-up…';
    session.error = null;
    this.emit(session);
    try {
      await this.client!.request<TurnSteerResult>('turn/steer', {
        threadId: session.threadId,
        expectedTurnId: session.activeTurnId,
        input: [{ type: 'text', text, text_elements: [] }],
      });
      session.activity = 'Thinking…';
    } catch (error) {
      const text = `Could not send follow-up: ${message(error)}`;
      session.error = text;
      session.messages.push({ id: randomUUID(), role: 'system', text, error: true });
    }
    this.emit(session);
  }

  async setModel(deckPath: string, model: string, conversationKey = ''): Promise<AgentChatState> {
    const session = this.session(deckPath, conversationKey);
    try {
      await this.ensureClient();
      if (session.busy) throw new Error('Stop the active agent turn before changing models');
      if (!this.models.some((candidate) => candidate.model === model)) {
        throw new Error('That model is not available for this account');
      }
      session.model = model;
      const selected = this.models.find((candidate) => candidate.model === model);
      session.reasoningEffort = selected?.defaultReasoningEffort
        ?? selected?.reasoningEfforts[0]?.effort
        ?? null;
      session.fastMode = defaultFastMode(selected);
      session.error = null;
    } catch (error) {
      session.error = message(error);
    }
    this.emit(session);
    return this.snapshot(session);
  }

  async setReasoningEffort(
    deckPath: string,
    effort: string,
    conversationKey = '',
  ): Promise<AgentChatState> {
    const session = this.session(deckPath, conversationKey);
    try {
      await this.ensureClient();
      if (session.busy) throw new Error('Reasoning effort can be changed after the active turn finishes');
      const selected = this.selectedModel(session);
      if (!selected?.reasoningEfforts.some((candidate) => candidate.effort === effort)) {
        throw new Error('That reasoning effort is not available for the selected model');
      }
      session.reasoningEffort = effort;
      session.error = null;
    } catch (error) {
      session.error = message(error);
    }
    this.emit(session);
    return this.snapshot(session);
  }

  async setFastMode(deckPath: string, enabled: boolean, conversationKey = ''): Promise<AgentChatState> {
    const session = this.session(deckPath, conversationKey);
    try {
      await this.ensureClient();
      if (session.busy) throw new Error('Fast mode can be changed after the active turn finishes');
      if (enabled && !fastTier(this.selectedModel(session))) {
        throw new Error('Fast mode is not available for the selected model');
      }
      session.fastMode = enabled;
      session.error = null;
    } catch (error) {
      session.error = message(error);
    }
    this.emit(session);
    return this.snapshot(session);
  }

  setScratchpad(
    deckPath: string,
    scratchpad: AgentChatScratchpad | null,
    conversationKey = '',
  ): AgentChatState {
    const session = this.session(deckPath, conversationKey);
    session.scratchpad = scratchpad;
    this.emit(session);
    return this.snapshot(session);
  }

  /** Current conversation id for history attribution; does not start Codex. */
  chatId(deckPath: string, conversationKey = ''): string | null {
    return this.session(deckPath, conversationKey).threadId;
  }

  getTranscript(deckPath: string, chatId: string, conversationKey = ''): AgentChatTranscript | null {
    const session = this.session(deckPath, conversationKey);
    const conversation = session.threadId === chatId
      ? conversationFromSession(session)
      : session.archivedChats.find((candidate) => candidate.threadId === chatId);
    if (!conversation) return null;
    return {
      chatId,
      accountLabel: conversation.threadAccount,
      updatedAt: conversation.updatedAt,
      messages: conversation.messages.map((item) => ({ ...item })),
    };
  }

  async select(deckPath: string, chatId: string, conversationKey = ''): Promise<AgentChatState> {
    const session = this.session(deckPath, conversationKey);
    if (session.busy) throw new Error('Stop the active agent turn before switching chats');
    if (session.threadId === chatId) return this.snapshot(session);
    const conversation = session.archivedChats.find((candidate) => candidate.threadId === chatId);
    if (!conversation) throw new Error('That Agent chat is no longer available in this deck');
    this.archiveActive(session);
    session.archivedChats = session.archivedChats.filter((candidate) => candidate.threadId !== chatId);
    loadConversation(session, conversation);
    this.emit(session);
    return this.snapshot(session);
  }

  async interrupt(deckPath: string, conversationKey = ''): Promise<AgentChatState> {
    const session = this.session(deckPath, conversationKey);
    if (!session.threadId || !session.activeTurnId || !session.busy) return this.snapshot(session);
    try {
      await this.client?.request('turn/interrupt', {
        threadId: session.threadId,
        turnId: session.activeTurnId,
      });
      session.activity = 'Stopping…';
    } catch (error) {
      session.error = message(error);
    }
    this.emit(session);
    return this.snapshot(session);
  }

  async reset(deckPath: string, conversationKey = ''): Promise<AgentChatState> {
    const session = this.session(deckPath, conversationKey);
    if (session.busy) await this.interrupt(deckPath, conversationKey);
    this.archiveActive(session);
    session.threadId = null;
    session.threadAttached = false;
    session.threadAccount = null;
    session.activeTurnId = null;
    session.agentPrompt = null;
    session.runtimeDir = null;
    session.scratchpad = null;
    session.queuedFollowUps = [];
    session.messages = [];
    session.updatedAt = new Date().toISOString();
    session.busy = false;
    session.activity = null;
    session.error = null;
    this.emit(session);
    return this.snapshot(session);
  }

  /** Stop live work without erasing the deck's saved conversation. */
  async suspend(deckPath: string, conversationKey = ''): Promise<AgentChatState> {
    const session = this.session(deckPath, conversationKey);
    if (session.busy) await this.interrupt(deckPath, conversationKey);
    session.activeTurnId = null;
    session.queuedFollowUps = [];
    session.busy = false;
    session.activity = null;
    // These URLs belong to the collaboration server that is about to close.
    session.scratchpad = null;
    this.persistNow(session);
    this.emit(session);
    return this.snapshot(session);
  }

  close(): void {
    for (const timer of this.persistTimers.values()) clearTimeout(timer);
    this.persistTimers.clear();
    for (const session of this.sessions.values()) this.persistNow(session);
    this.client?.close();
    this.client = null;
    this.starting = null;
  }

  private async ensureClient(): Promise<void> {
    if (this.client && this.connection === 'ready') return;
    if (this.starting) return this.starting;

    this.connection = 'connecting';
    this.globalError = null;
    this.emitAll();
    this.starting = (async () => {
      if (this.options.codexHome) {
        await mkdir(this.options.codexHome, { recursive: true });
      }
      const callbacks = {
        onNotification: (notification: AppServerNotification) => this.onNotification(notification),
        onExit: (exitMessage: string) => this.onExit(exitMessage),
        onDynamicToolCall: this.options.onDynamicToolCall,
      };
      this.client = this.options.clientFactory?.(callbacks)
        ?? new CodexAppServerClient({ ...callbacks, codexHome: this.options.codexHome });
      await this.client.start();
      this.connection = 'ready';
      await this.refreshAccountAndModels();
      this.emitAll();
    })().catch((error) => {
      this.client?.close();
      this.client = null;
      this.connection = 'unavailable';
      this.globalError = message(error);
      this.emitAll();
      throw error;
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async refreshAccount(): Promise<void> {
    const result = await this.client!.request<AccountReadResult>('account/read', {
      refreshToken: false,
    });
    if (!result.account) {
      this.auth = 'signedOut';
      this.accountLabel = null;
      return;
    }
    this.auth = 'signedIn';
    if (result.account.type === 'chatgpt') {
      this.accountLabel = result.account.email
        ?? `ChatGPT ${result.account.planType}`;
    } else if (result.account.type === 'apiKey') {
      this.accountLabel = 'OpenAI API';
    } else {
      this.accountLabel = 'Amazon Bedrock';
    }
  }

  private async refreshAccountAndModels(): Promise<void> {
    await this.refreshAccount();
    if (this.auth !== 'signedIn') {
      this.models = [];
      for (const session of this.sessions.values()) {
        session.model = null;
        session.reasoningEffort = null;
        session.fastMode = false;
      }
      return;
    }
    await this.refreshModels();
  }

  private async refreshModels(): Promise<void> {
    const models: AgentChatModel[] = [];
    let cursor: string | null = null;
    do {
      const result: ModelListResult = await this.client!.request<ModelListResult>('model/list', {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      for (const candidate of result.data) {
        if (candidate.hidden || models.some((item) => item.model === candidate.model)) continue;
        models.push({
          model: candidate.model,
          displayName: candidate.displayName,
          description: candidate.description,
          isDefault: candidate.isDefault,
          reasoningEfforts: (candidate.supportedReasoningEfforts ?? []).map((effort) => ({
            effort: effort.reasoningEffort,
            description: effort.description,
          })),
          defaultReasoningEffort: candidate.defaultReasoningEffort ?? null,
          serviceTiers: candidate.serviceTiers.map((tier) => ({ ...tier })),
          defaultServiceTier: candidate.defaultServiceTier,
        });
      }
      cursor = result.nextCursor;
    } while (cursor);
    this.models = models;
    const fallback = models.find((candidate) => candidate.isDefault)?.model
      ?? models[0]?.model
      ?? null;
    for (const session of this.sessions.values()) {
      const selected = models.find((candidate) => candidate.model === session.model);
      if (!selected) {
        session.model = fallback;
        const replacement = models.find((candidate) => candidate.model === fallback);
        session.reasoningEffort = replacement?.defaultReasoningEffort
          ?? replacement?.reasoningEfforts[0]?.effort
          ?? null;
        session.fastMode = defaultFastMode(
          replacement,
        );
      } else {
        if (!selected.reasoningEfforts.some((effort) => effort.effort === session.reasoningEffort)) {
          session.reasoningEffort = selected.defaultReasoningEffort
            ?? selected.reasoningEfforts[0]?.effort
            ?? null;
        }
        if (!fastTier(selected)) session.fastMode = false;
      }
    }
  }

  private onNotification(notification: AppServerNotification): void {
    const params = record(notification.params);
    if (notification.method === 'account/login/completed') {
      const loginId = typeof params.loginId === 'string' ? params.loginId : null;
      if (this.activeLoginId && loginId && loginId !== this.activeLoginId) return;
      void this.finishLogin(params.success === true, typeof params.error === 'string' ? params.error : null);
      return;
    }
    if (notification.method === 'account/updated') {
      void this.refreshAccountAndModels().then(() => {
        if (this.auth === 'signedIn') this.clearLoginStatus();
        this.emitAll();
      }).catch(() => undefined);
      return;
    }

    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const session = threadId
      ? [...this.sessions.values()].find((candidate) => candidate.threadId === threadId)
      : null;
    if (!session) return;

    if (notification.method === 'item/agentMessage/delta') {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      const itemId = typeof params.itemId === 'string' ? params.itemId : randomUUID();
      let assistant = session.messages.find((item) => item.id === itemId);
      if (!assistant) {
        assistant = { id: itemId, role: 'assistant', text: '' };
        session.messages.push(assistant);
      }
      assistant.text += delta;
      session.updatedAt = new Date().toISOString();
      session.activity = 'Responding…';
      this.emit(session);
      return;
    }

    if (notification.method === 'item/started') {
      const item = record(params.item);
      session.activity = activityForItem(item);
      this.emit(session);
      return;
    }

    if (notification.method === 'turn/completed') {
      const turn = record(params.turn);
      session.busy = false;
      session.activeTurnId = null;
      session.queuedFollowUps = [];
      session.activity = null;
      if (turn.status === 'failed') {
        const error = record(turn.error);
        const text = typeof error.message === 'string' ? error.message : 'The agent turn failed';
        session.error = text;
        session.messages.push({ id: randomUUID(), role: 'system', text, error: true });
      }
      this.emit(session);
      return;
    }

    if (notification.method === 'warning' && typeof params.message === 'string') {
      session.error = params.message;
      this.emit(session);
    }
  }

  private async finishLogin(success: boolean, error: string | null): Promise<void> {
    try {
      await this.refreshAccountAndModels();
      // Treat the account as authoritative. Some app-server/browser races
      // report cancellation after credentials have already been installed.
      if (success || this.auth === 'signedIn') {
        this.clearLoginStatus();
      } else {
        this.activeLoginId = null;
        this.loginError = error ?? 'ChatGPT sign-in did not complete';
        for (const session of this.sessions.values()) session.activity = null;
      }
    } catch (refreshError) {
      this.loginError = message(refreshError);
    }
    this.emitAll();
  }

  private clearLoginStatus(): void {
    this.activeLoginId = null;
    this.loginError = null;
    for (const session of this.sessions.values()) session.activity = null;
  }

  private onExit(exitMessage: string): void {
    this.client = null;
    this.connection = 'unavailable';
    this.globalError = exitMessage;
    for (const session of this.sessions.values()) {
      session.busy = false;
      session.activity = null;
      session.activeTurnId = null;
      session.threadAttached = false;
    }
    this.emitAll();
  }

  private failConnection(error: unknown): void {
    this.connection = 'unavailable';
    this.globalError = message(error);
    this.client = null;
    for (const session of this.sessions.values()) session.threadAttached = false;
    this.emitAll();
  }

  private session(deckPath: string, conversationKey = ''): AgentChatSession {
    const key = conversationKey ? `${deckPath}\u0000${conversationKey}` : deckPath;
    let session = this.sessions.get(key);
    if (!session) {
      const selected = this.models.find((candidate) => candidate.isDefault) ?? this.models[0];
      // Shared demo conversations are partitioned by an ephemeral browser id
      // and deliberately stay in memory. The ordinary desktop conversation
      // keeps its existing deck-side persistence unchanged.
      const persisted = conversationKey ? null : this.loadPersisted(deckPath);
      const active = persisted?.active;
      session = {
        deckPath,
        conversationKey,
        threadId: active?.threadId ?? null,
        threadAttached: false,
        threadAccount: active?.threadAccount ?? null,
        activeTurnId: null,
        agentPrompt: null,
        runtimeDir: null,
        model: active?.model ?? selected?.model ?? null,
        reasoningEffort: active?.reasoningEffort ?? selected?.defaultReasoningEffort
          ?? selected?.reasoningEfforts[0]?.effort
          ?? null,
        fastMode: active?.fastMode ?? defaultFastMode(selected),
        scratchpad: null,
        queuedFollowUps: [],
        messages: active?.messages.map((item) => ({ ...item })) ?? [],
        updatedAt: active?.updatedAt ?? new Date().toISOString(),
        archivedChats: persisted?.archived.map(cloneConversation) ?? [],
        busy: false,
        activity: null,
        error: null,
      };
      this.sessions.set(key, session);
    }
    return session;
  }

  private snapshot(session: AgentChatSession): AgentChatState {
    return {
      deckPath: session.deckPath,
      chatId: session.threadId,
      conversations: conversationSummaries(session),
      connection: this.connection,
      auth: this.auth,
      accountLabel: this.accountLabel,
      models: this.models.map((model) => ({ ...model })),
      selectedModel: session.model,
      selectedReasoningEffort: session.reasoningEffort,
      fastMode: session.fastMode,
      scratchpad: session.scratchpad ? { ...session.scratchpad } : null,
      busy: session.busy,
      activity: session.activity,
      messages: session.messages.map((item) => ({ ...item })),
      error: session.error ?? this.loginError ?? this.globalError,
    };
  }

  private emit(session: AgentChatSession): void {
    this.schedulePersist(session);
    this.options.onState?.(this.snapshot(session), session.conversationKey);
  }

  private emitAll(): void {
    for (const session of this.sessions.values()) this.emit(session);
  }

  private selectedModel(session: AgentChatSession): AgentChatModel | undefined {
    return this.models.find((candidate) => candidate.model === session.model);
  }

  private serviceTierFor(session: AgentChatSession): string {
    return session.fastMode ? fastTier(this.selectedModel(session))?.id ?? 'default' : 'default';
  }

  private async attachThread(
    session: AgentChatSession,
    prepareAgentPrompt: () => Promise<string>,
    previousMessages: AgentChatMessage[],
  ): Promise<void> {
    session.runtimeDir = join(this.runtimeDir, randomUUID());
    await mkdir(session.runtimeDir, { recursive: true });
    const livePrompt = await prepareAgentPrompt();
    session.agentPrompt = livePrompt;

    const accountChanged = Boolean(
      session.threadId
      && session.threadAccount
      && this.accountLabel
      && session.threadAccount !== this.accountLabel,
    );
    if (accountChanged) session.threadId = null;

    if (session.threadId) {
      try {
        const resumed = await this.client!.request<ThreadResumeResult>('thread/resume', {
          threadId: session.threadId,
          ...(session.model ? { model: session.model } : {}),
          serviceTier: this.serviceTierFor(session),
          cwd: session.runtimeDir,
          runtimeWorkspaceRoots: [session.runtimeDir],
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          developerInstructions: livePrompt,
          personality: 'friendly',
          excludeTurns: true,
        });
        session.threadId = resumed.thread.id;
        session.threadAttached = true;
        session.threadAccount = this.accountLabel;
        return;
      } catch {
        // The saved transcript still provides continuity when the backing
        // Codex thread was deleted, belongs to another account, or expired.
        session.threadId = null;
      }
    }

    const started = await this.client!.request<ThreadStartResult>('thread/start', {
      ...(session.model ? { model: session.model } : {}),
      serviceTier: this.serviceTierFor(session),
      // A neutral cwd keeps the dynamically wrapped HTTP brief as the
      // thread's sole DeckWerk-specific instruction source.
      cwd: session.runtimeDir,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      serviceName: 'deckwerk',
      // This is the same complete, dynamically wrapped HTTP contract the
      // Agent button historically copied to the user's clipboard.
      developerInstructions: promptWithTranscript(livePrompt, previousMessages),
      personality: 'friendly',
      ...(this.options.onDynamicToolCall ? { dynamicTools: [BROWSER_OPEN_TOOL] } : {}),
    });
    session.threadId = started.thread.id;
    session.threadAttached = true;
    session.threadAccount = this.accountLabel;
  }

  private archiveActive(session: AgentChatSession): void {
    const conversation = conversationFromSession(session);
    if (!conversation.threadId || conversation.messages.length === 0) return;
    session.archivedChats = session.archivedChats
      .filter((candidate) => candidate.threadId !== conversation.threadId);
    session.archivedChats.push(conversation);
    session.archivedChats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private loadPersisted(deckPath: string): PersistedAgentChats | null {
    if (this.options.persistence === false) return null;
    try {
      return parsePersistedChat(JSON.parse(readFileSync(join(deckPath, AGENT_CHAT_FILE), 'utf8')));
    } catch {
      return null;
    }
  }

  private schedulePersist(session: AgentChatSession): void {
    if (this.options.persistence === false || session.conversationKey) return;
    const current = this.persistTimers.get(session.deckPath);
    if (current) clearTimeout(current);
    this.persistTimers.set(session.deckPath, setTimeout(() => {
      this.persistTimers.delete(session.deckPath);
      this.persistNow(session);
    }, 150));
  }

  private persistNow(session: AgentChatSession): void {
    if (this.options.persistence === false || session.conversationKey) return;
    const payload: PersistedAgentChats = {
      version: 2,
      active: conversationFromSession(session),
      archived: session.archivedChats.map(cloneConversation),
    };
    const target = join(session.deckPath, AGENT_CHAT_FILE);
    const temporary = join(session.deckPath, `.${AGENT_CHAT_FILE}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      renameSync(temporary, target);
    } catch (error) {
      console.error(`Could not save Agent chat for ${session.deckPath}:`, error);
    }
  }
}

function parsePersistedChat(value: unknown): PersistedAgentChats | null {
  const input = record(value);
  if (input.version === 1) {
    const active = parseConversation(input);
    return active ? { version: 2, active, archived: [] } : null;
  }
  if (input.version !== 2) return null;
  const active = parseConversation(input.active);
  if (!active) return null;
  const archived = Array.isArray(input.archived)
    ? input.archived.flatMap((candidate: unknown) => {
      const parsed = parseConversation(candidate);
      return parsed?.threadId ? [parsed] : [];
    })
    : [];
  return { version: 2, active, archived };
}

function parseConversation(value: unknown): PersistedConversation | null {
  const input = record(value);
  if (!Array.isArray(input.messages)) return null;
  const messages = input.messages.flatMap((candidate: unknown): AgentChatMessage[] => {
    const item = record(candidate);
    if (
      typeof item.id !== 'string'
      || !['user', 'assistant', 'system'].includes(item.role)
      || typeof item.text !== 'string'
    ) return [];
    return [{
      id: item.id,
      role: item.role,
      text: item.text,
      ...(item.error === true ? { error: true } : {}),
    } as AgentChatMessage];
  });
  return {
    threadId: typeof input.threadId === 'string' ? input.threadId : null,
    threadAccount: typeof input.threadAccount === 'string' ? input.threadAccount : null,
    model: typeof input.model === 'string' ? input.model : null,
    reasoningEffort: typeof input.reasoningEffort === 'string' ? input.reasoningEffort : null,
    fastMode: input.fastMode === true,
    messages,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date(0).toISOString(),
  };
}

function conversationFromSession(session: AgentChatSession): PersistedConversation {
  return {
    threadId: session.threadId,
    threadAccount: session.threadAccount,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    fastMode: session.fastMode,
    messages: session.messages.map((item) => ({ ...item })),
    updatedAt: session.updatedAt,
  };
}

function cloneConversation(conversation: PersistedConversation): PersistedConversation {
  return {
    ...conversation,
    messages: conversation.messages.map((item) => ({ ...item })),
  };
}

function loadConversation(session: AgentChatSession, conversation: PersistedConversation): void {
  session.threadId = conversation.threadId;
  session.threadAttached = false;
  session.threadAccount = conversation.threadAccount;
  session.activeTurnId = null;
  session.agentPrompt = null;
  session.runtimeDir = null;
  session.model = conversation.model;
  session.reasoningEffort = conversation.reasoningEffort;
  session.fastMode = conversation.fastMode;
  session.scratchpad = null;
  session.queuedFollowUps = [];
  session.messages = conversation.messages.map((item) => ({ ...item }));
  session.updatedAt = conversation.updatedAt;
  session.busy = false;
  session.activity = null;
  session.error = null;
}

function conversationSummaries(session: AgentChatSession): AgentChatConversationSummary[] {
  const conversations = [conversationFromSession(session), ...session.archivedChats]
    .filter((conversation): conversation is PersistedConversation & { threadId: string } =>
      Boolean(conversation.threadId && conversation.messages.length));
  return conversations
    .map((conversation) => ({
      chatId: conversation.threadId,
      title: conversationTitle(conversation.messages),
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
      active: conversation.threadId === session.threadId,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function conversationTitle(messages: AgentChatMessage[]): string {
  const first = messages.find((item) => item.role === 'user' && item.text.trim());
  return first ? shorten(first.text.replace(/\s+/g, ' ').trim(), 54) : 'Untitled chat';
}

function promptWithTranscript(prompt: string, messages: AgentChatMessage[]): string {
  if (!messages.length) return prompt;
  const transcript = messages
    .filter((item) => !item.error)
    .map((item) => `${item.role.toUpperCase()}: ${item.text}`)
    .join('\n\n');
  if (!transcript) return prompt;
  return `${prompt}\n\n## Restored deck chat\n\nThe backing Codex thread could not be resumed, so continue from this saved transcript:\n\n${transcript}`;
}

function fastTier(model: AgentChatModel | undefined): AgentChatModel['serviceTiers'][number] | undefined {
  return model?.serviceTiers.find((tier) => {
    const id = tier.id.toLowerCase();
    return id === 'priority' || id === 'fast' || tier.name.toLowerCase() === 'fast';
  });
}

function defaultFastMode(model: AgentChatModel | undefined): boolean {
  const tier = fastTier(model);
  return Boolean(tier && tier.id === model?.defaultServiceTier);
}

function activityForItem(item: Record<string, unknown>): string {
  if (item.type === 'commandExecution') {
    const command = typeof item.command === 'string' ? item.command.trim() : '';
    return command ? `Running ${shorten(command, 54)}…` : 'Running a deck command…';
  }
  if (item.type === 'fileChange') return 'Editing slides…';
  if (item.type === 'webSearch') return 'Searching…';
  if (item.type === 'reasoning' || item.type === 'plan') return 'Thinking…';
  return 'Working…';
}

function shorten(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
