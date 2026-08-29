import type { AgentChatController } from './agentChat.js';
import type {
  AgentChatSendRequest,
  AgentChatSetFastModeRequest,
  AgentChatSetModelRequest,
  AgentChatSetReasoningEffortRequest,
  AgentChatState,
} from '../shared/ipc.js';
import type { SharedAgentRuntimeLike } from '../server/sharedAgent.js';

export const DESKTOP_AGENT_PARTICIPANT = 'desktop-host';

export interface DesktopSharedAgentOptions {
  controller: AgentChatController;
  subscribe: (
    listener: (state: AgentChatState, conversationKey: string) => void,
  ) => () => void;
  name?: string;
}

/**
 * Browser transport adapter for the desktop's existing private Agent.
 *
 * The loopback collaboration client uses a stable participant id that maps to
 * the controller's ordinary (empty-key) conversation, so switching from the
 * native editor to collaboration preserves the same chat instead of creating
 * a second one. The collaboration server owns only this adapter; closing it
 * must not close the app-owned controller.
 */
export class DesktopSharedAgent implements SharedAgentRuntimeLike {
  readonly name: string;

  constructor(private readonly options: DesktopSharedAgentOptions) {
    this.name = options.name?.trim() || 'Agent';
  }

  getState(deckPath: string, participantId: string): Promise<AgentChatState> {
    return this.options.controller.getState(deckPath, this.conversationKey(participantId));
  }

  send(
    deckPath: string,
    participantId: string,
    request: AgentChatSendRequest,
    prepareAgentPrompt: () => Promise<string>,
  ): Promise<AgentChatState> {
    return this.options.controller.send(
      deckPath,
      request,
      prepareAgentPrompt,
      this.conversationKey(participantId),
    );
  }

  async login(deckPath: string, participantId: string) {
    const state = await this.options.controller.login(
      deckPath,
      this.conversationKey(participantId),
    );
    // The desktop controller opens the managed login in the system browser.
    return { state, authUrl: null };
  }

  async switchAccount(deckPath: string, participantId: string) {
    const state = await this.options.controller.switchAccount(
      deckPath,
      this.conversationKey(participantId),
    );
    return { state, authUrl: null };
  }

  setModel(
    deckPath: string,
    participantId: string,
    request: AgentChatSetModelRequest,
  ): Promise<AgentChatState> {
    return this.options.controller.setModel(
      deckPath,
      request.model,
      this.conversationKey(participantId),
    );
  }

  setReasoningEffort(
    deckPath: string,
    participantId: string,
    request: AgentChatSetReasoningEffortRequest,
  ): Promise<AgentChatState> {
    return this.options.controller.setReasoningEffort(
      deckPath,
      request.effort,
      this.conversationKey(participantId),
    );
  }

  setFastMode(
    deckPath: string,
    participantId: string,
    request: AgentChatSetFastModeRequest,
  ): Promise<AgentChatState> {
    return this.options.controller.setFastMode(
      deckPath,
      request.enabled,
      this.conversationKey(participantId),
    );
  }

  interrupt(deckPath: string, participantId: string): Promise<AgentChatState> {
    return this.options.controller.interrupt(deckPath, this.conversationKey(participantId));
  }

  reset(deckPath: string, participantId: string): Promise<AgentChatState> {
    return this.options.controller.reset(deckPath, this.conversationKey(participantId));
  }

  select(deckPath: string, participantId: string, chatId: string): Promise<AgentChatState> {
    return this.options.controller.select(
      deckPath,
      chatId,
      this.conversationKey(participantId),
    );
  }

  setScratchpad(
    deckPath: string,
    participantId: string,
    scratchpad: AgentChatState['scratchpad'],
  ): AgentChatState {
    return this.options.controller.setScratchpad(
      deckPath,
      scratchpad,
      this.conversationKey(participantId),
    );
  }

  chatId(deckPath: string, participantId: string): string | null {
    return this.options.controller.chatId(deckPath, this.conversationKey(participantId));
  }

  subscribe(listener: (state: AgentChatState, participantId: string) => void): () => void {
    return this.options.subscribe((state, conversationKey) => {
      listener(state, this.participantId(conversationKey));
    });
  }

  // AgentChatController belongs to the desktop app and remains reusable after
  // collaboration ends; the app lifecycle closes it.
  close(): void {}

  private conversationKey(participantId: string): string {
    return participantId === DESKTOP_AGENT_PARTICIPANT ? '' : participantId;
  }

  private participantId(conversationKey: string): string {
    return conversationKey || DESKTOP_AGENT_PARTICIPANT;
  }
}
