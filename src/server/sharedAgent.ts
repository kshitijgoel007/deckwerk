import type {
  AgentChatSendRequest,
  AgentChatSetFastModeRequest,
  AgentChatSetModelRequest,
  AgentChatSetReasoningEffortRequest,
  AgentChatState,
} from '../shared/ipc.js';
import { AgentChatController } from '../main/agentChat.js';

export interface SharedAgentRuntimeLike {
  readonly name: string;
  getState(deckPath: string, participantId: string): Promise<AgentChatState>;
  send(
    deckPath: string,
    participantId: string,
    request: AgentChatSendRequest,
    prepareAgentPrompt: () => Promise<string>,
  ): Promise<AgentChatState>;
  login(deckPath: string, participantId: string): Promise<{ state: AgentChatState; authUrl: string | null }>;
  switchAccount(deckPath: string, participantId: string): Promise<{ state: AgentChatState; authUrl: string | null }>;
  setModel(deckPath: string, participantId: string, request: AgentChatSetModelRequest): Promise<AgentChatState>;
  setReasoningEffort(
    deckPath: string,
    participantId: string,
    request: AgentChatSetReasoningEffortRequest,
  ): Promise<AgentChatState>;
  setFastMode(deckPath: string, participantId: string, request: AgentChatSetFastModeRequest): Promise<AgentChatState>;
  interrupt(deckPath: string, participantId: string): Promise<AgentChatState>;
  reset(deckPath: string, participantId: string): Promise<AgentChatState>;
  select(deckPath: string, participantId: string, chatId: string): Promise<AgentChatState>;
  setScratchpad(deckPath: string, participantId: string, scratchpad: AgentChatState['scratchpad']): AgentChatState;
  chatId(deckPath: string, participantId: string): string | null;
  subscribe(listener: (state: AgentChatState, participantId: string) => void): () => void;
  close(): void;
}

export interface SharedAgentRuntimeOptions {
  codexHome: string;
  name?: string;
}

/**
 * One intentionally shared Codex identity for headless-server demos.
 *
 * Account credentials stay in the server's isolated CODEX_HOME. Browser
 * participants receive normalized chat state and can submit prompts, but the
 * collaboration server keeps account login/switching loopback-only.
 */
export class SharedAgentRuntime implements SharedAgentRuntimeLike {
  readonly name: string;
  private readonly controller: AgentChatController;
  private readonly listeners = new Set<(state: AgentChatState, participantId: string) => void>();
  private pendingAuthUrl: string | null = null;

  constructor(options: SharedAgentRuntimeOptions) {
    this.name = options.name?.trim() || 'Shared Agent';
    this.controller = new AgentChatController({
      codexHome: options.codexHome,
      openExternal: async (url) => {
        // The headless process cannot open a browser on behalf of its owner.
        // The loopback-only HTTP login endpoint returns this URL to the local
        // collaboration client, which opens it in the owner's browser.
        this.pendingAuthUrl = url;
      },
      onState: (state, participantId) => {
        for (const listener of this.listeners) listener(state, participantId);
      },
    });
  }

  getState(deckPath: string, participantId: string): Promise<AgentChatState> {
    return this.controller.getState(deckPath, participantId);
  }

  send(
    deckPath: string,
    participantId: string,
    request: AgentChatSendRequest,
    prepareAgentPrompt: () => Promise<string>,
  ): Promise<AgentChatState> {
    return this.controller.send(deckPath, request, prepareAgentPrompt, participantId);
  }

  async login(deckPath: string, participantId: string): Promise<{ state: AgentChatState; authUrl: string | null }> {
    this.pendingAuthUrl = null;
    const state = await this.controller.login(deckPath, participantId);
    return { state, authUrl: this.takeAuthUrl() };
  }

  async switchAccount(deckPath: string, participantId: string): Promise<{ state: AgentChatState; authUrl: string | null }> {
    this.pendingAuthUrl = null;
    const state = await this.controller.switchAccount(deckPath, participantId);
    return { state, authUrl: this.takeAuthUrl() };
  }

  setModel(deckPath: string, participantId: string, request: AgentChatSetModelRequest): Promise<AgentChatState> {
    return this.controller.setModel(deckPath, request.model, participantId);
  }

  setReasoningEffort(
    deckPath: string,
    participantId: string,
    request: AgentChatSetReasoningEffortRequest,
  ): Promise<AgentChatState> {
    return this.controller.setReasoningEffort(deckPath, request.effort, participantId);
  }

  setFastMode(deckPath: string, participantId: string, request: AgentChatSetFastModeRequest): Promise<AgentChatState> {
    return this.controller.setFastMode(deckPath, request.enabled, participantId);
  }

  interrupt(deckPath: string, participantId: string): Promise<AgentChatState> {
    return this.controller.interrupt(deckPath, participantId);
  }

  reset(deckPath: string, participantId: string): Promise<AgentChatState> {
    return this.controller.reset(deckPath, participantId);
  }

  select(deckPath: string, participantId: string, chatId: string): Promise<AgentChatState> {
    return this.controller.select(deckPath, chatId, participantId);
  }

  setScratchpad(
    deckPath: string,
    participantId: string,
    scratchpad: AgentChatState['scratchpad'],
  ): AgentChatState {
    return this.controller.setScratchpad(deckPath, scratchpad, participantId);
  }

  chatId(deckPath: string, participantId: string): string | null {
    return this.controller.chatId(deckPath, participantId);
  }

  subscribe(listener: (state: AgentChatState, participantId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.controller.close();
    this.listeners.clear();
  }

  private takeAuthUrl(): string | null {
    const url = this.pendingAuthUrl;
    this.pendingAuthUrl = null;
    return url;
  }
}
