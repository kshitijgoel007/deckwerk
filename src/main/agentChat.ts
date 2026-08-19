import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentChatMessage,
  AgentChatModel,
  AgentChatSendRequest,
  AgentChatState,
} from '@shared/ipc.js';
import {
  CodexAppServerClient,
  type AppServerNotification,
} from './codexAppServer.js';

interface AccountReadResult {
  account: null | { type: 'apiKey' }
    | { type: 'chatgpt'; email: string | null; planType: string }
    | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean };
  requiresOpenaiAuth: boolean;
}

interface ThreadStartResult {
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
  threadId: string | null;
  activeTurnId: string | null;
  agentPrompt: string | null;
  model: string | null;
  fastMode: boolean;
  queuedFollowUps: string[];
  messages: AgentChatMessage[];
  busy: boolean;
  activity: string | null;
  error: string | null;
}

export interface AgentChatControllerOptions {
  clientFactory?: (callbacks: {
    onNotification: (notification: AppServerNotification) => void;
    onExit: (message: string) => void;
  }) => AppServerLike;
  openExternal?: (url: string) => Promise<unknown>;
  onState?: (state: AgentChatState) => void;
  /** Keep this embedded agent's login separate from other Codex clients. */
  codexHome?: string;
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
  private readonly runtimeDir = join(tmpdir(), 'deckwerk-agent-runtime');

  constructor(options: AgentChatControllerOptions = {}) {
    this.options = options;
  }

  async getState(deckPath: string): Promise<AgentChatState> {
    const session = this.session(deckPath);
    this.emit(session);
    try {
      await this.ensureClient();
    } catch (error) {
      this.failConnection(error);
    }
    return this.snapshot(session);
  }

  async login(deckPath: string): Promise<AgentChatState> {
    const session = this.session(deckPath);
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

  async switchAccount(deckPath: string): Promise<AgentChatState> {
    const session = this.session(deckPath);
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
        candidate.threadId = null;
        candidate.activeTurnId = null;
        candidate.agentPrompt = null;
        candidate.model = null;
        candidate.fastMode = false;
        candidate.queuedFollowUps = [];
        candidate.messages = [];
        candidate.activity = null;
        candidate.error = null;
      }
      this.emitAll();
      return this.login(deckPath);
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
  ): Promise<AgentChatState> {
    const session = this.session(deckPath);
    const text = request.text.trim();
    if (!text) return this.snapshot(session);

    try {
      await this.ensureClient();
      if (this.auth !== 'signedIn') throw new Error('Sign in with ChatGPT before sending a message');
      if (session.busy) return await this.steer(session, text);

      session.messages.push({ id: randomUUID(), role: 'user', text });
      session.busy = true;
      session.activity = 'Starting the deck API session…';
      session.error = null;
      this.emit(session);

      if (!session.threadId) {
        await mkdir(this.runtimeDir, { recursive: true });
        session.agentPrompt = await prepareAgentPrompt();
        const started = await this.client!.request<ThreadStartResult>('thread/start', {
          ...(session.model ? { model: session.model } : {}),
          serviceTier: this.serviceTierFor(session),
          // A neutral cwd keeps the dynamically wrapped HTTP brief as the
          // thread's sole DeckWerk-specific instruction source.
          cwd: this.runtimeDir,
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          serviceName: 'deckwerk',
          // This is the same complete, dynamically wrapped HTTP contract the
          // Agent button historically copied to the user's clipboard.
          developerInstructions: session.agentPrompt,
          personality: 'friendly',
        });
        session.threadId = started.thread.id;
      }

      session.activity = 'Thinking…';
      this.emit(session);
      const turn = await this.client!.request<TurnStartResult>('turn/start', {
        threadId: session.threadId,
        ...(session.model ? { model: session.model } : {}),
        serviceTier: this.serviceTierFor(session),
        input: [{ type: 'text', text, text_elements: [] }],
        cwd: this.runtimeDir,
        approvalPolicy: 'never',
        sandboxPolicy: {
          // Only neutral scratch space is writable; the deck itself is not in
          // the sandbox. Loopback networking is the editing capability.
          type: 'workspaceWrite',
          writableRoots: [this.runtimeDir],
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

  async setModel(deckPath: string, model: string): Promise<AgentChatState> {
    const session = this.session(deckPath);
    try {
      await this.ensureClient();
      if (session.busy) throw new Error('Stop the active agent turn before changing models');
      if (!this.models.some((candidate) => candidate.model === model)) {
        throw new Error('That model is not available for this account');
      }
      session.model = model;
      session.fastMode = defaultFastMode(this.models.find((candidate) => candidate.model === model));
      session.error = null;
    } catch (error) {
      session.error = message(error);
    }
    this.emit(session);
    return this.snapshot(session);
  }

  async setFastMode(deckPath: string, enabled: boolean): Promise<AgentChatState> {
    const session = this.session(deckPath);
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

  async interrupt(deckPath: string): Promise<AgentChatState> {
    const session = this.session(deckPath);
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

  async reset(deckPath: string): Promise<AgentChatState> {
    const session = this.session(deckPath);
    if (session.busy) await this.interrupt(deckPath);
    session.threadId = null;
    session.activeTurnId = null;
    session.agentPrompt = null;
    session.queuedFollowUps = [];
    session.messages = [];
    session.busy = false;
    session.activity = null;
    session.error = null;
    this.emit(session);
    return this.snapshot(session);
  }

  close(): void {
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
        session.fastMode = defaultFastMode(
          models.find((candidate) => candidate.model === fallback),
        );
      } else if (!fastTier(selected)) {
        session.fastMode = false;
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
    }
    this.emitAll();
  }

  private failConnection(error: unknown): void {
    this.connection = 'unavailable';
    this.globalError = message(error);
    this.client = null;
    this.emitAll();
  }

  private session(deckPath: string): AgentChatSession {
    let session = this.sessions.get(deckPath);
    if (!session) {
      session = {
        deckPath,
        threadId: null,
        activeTurnId: null,
        agentPrompt: null,
        model: this.models.find((candidate) => candidate.isDefault)?.model
          ?? this.models[0]?.model
          ?? null,
        fastMode: defaultFastMode(
          this.models.find((candidate) => candidate.isDefault) ?? this.models[0],
        ),
        queuedFollowUps: [],
        messages: [],
        busy: false,
        activity: null,
        error: null,
      };
      this.sessions.set(deckPath, session);
    }
    return session;
  }

  private snapshot(session: AgentChatSession): AgentChatState {
    return {
      deckPath: session.deckPath,
      connection: this.connection,
      auth: this.auth,
      accountLabel: this.accountLabel,
      models: this.models.map((model) => ({ ...model })),
      selectedModel: session.model,
      fastMode: session.fastMode,
      busy: session.busy,
      activity: session.activity,
      messages: session.messages.map((item) => ({ ...item })),
      error: session.error ?? this.loginError ?? this.globalError,
    };
  }

  private emit(session: AgentChatSession): void {
    this.options.onState?.(this.snapshot(session));
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
