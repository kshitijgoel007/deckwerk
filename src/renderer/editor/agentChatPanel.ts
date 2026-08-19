import type {
  AgentChatSendRequest,
  AgentChatSetFastModeRequest,
  AgentChatSetModelRequest,
  AgentChatSetReasoningEffortRequest,
  AgentChatState,
} from '@shared/ipc.js';

export interface AgentChatApi {
  getAgentChatState: () => Promise<AgentChatState>;
  sendAgentChatMessage: (request: AgentChatSendRequest) => Promise<AgentChatState>;
  loginAgentChat: () => Promise<AgentChatState>;
  switchAgentChatAccount: () => Promise<AgentChatState>;
  setAgentChatModel: (request: AgentChatSetModelRequest) => Promise<AgentChatState>;
  setAgentChatReasoningEffort: (request: AgentChatSetReasoningEffortRequest) => Promise<AgentChatState>;
  setAgentChatFastMode: (request: AgentChatSetFastModeRequest) => Promise<AgentChatState>;
  interruptAgentChat: () => Promise<AgentChatState>;
  resetAgentChat: () => Promise<AgentChatState>;
  selectAgentChat?: (request: { chatId: string }) => Promise<AgentChatState>;
  onAgentChatState: (fn: (state: AgentChatState) => void) => () => void;
}

export interface AgentChatPanelOptions {
  api: AgentChatApi;
  currentDeckPath: () => string | null;
  onClose?: () => void;
}

/** A persistent, non-modal chat surface anchored beneath the editor toolbar. */
export class AgentChatPanel {
  readonly element: HTMLElement;
  private readonly options: AgentChatPanelOptions;
  private readonly messages: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly status: HTMLElement;
  private readonly account: HTMLElement;
  private readonly error: HTMLElement;
  private readonly signIn: HTMLButtonElement;
  private readonly switchAccount: HTMLButtonElement;
  private readonly modelRow: HTMLElement;
  private readonly modelSelect: HTMLSelectElement;
  private readonly effortSelect: HTMLSelectElement;
  private readonly fastMode: HTMLButtonElement;
  private readonly scratchpadBar: HTMLElement;
  private readonly scratchpadLabel: HTMLElement;
  private readonly scratchpadPanel: HTMLElement;
  private readonly scratchpadFrame: HTMLIFrameElement;
  private readonly scratchpadSource: HTMLButtonElement;
  private readonly scratchpadImported: HTMLButtonElement;
  private readonly scratchpadSlides: HTMLButtonElement;
  private readonly scratchpadContact: HTMLButtonElement;
  private scratchpadView: 'source' | 'imported' = 'source';
  private scratchpadMode: 'slides' | 'contact' = 'slides';
  private lastScratchpadId: string | null = null;
  private readonly input: HTMLTextAreaElement;
  private readonly action: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  private readonly reset: HTMLButtonElement;
  private readonly conversationSelect: HTMLSelectElement;
  private state: AgentChatState | null = null;

  constructor(options: AgentChatPanelOptions) {
    this.options = options;
    const panel = document.createElement('aside');
    panel.id = 'agent-chat-panel';
    panel.className = 'agent-chat-panel';
    panel.hidden = true;
    panel.role = 'dialog';
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'agent-chat-title');

    const header = document.createElement('header');
    header.className = 'agent-chat-header';
    const titleWrap = document.createElement('div');
    const title = document.createElement('h2');
    title.id = 'agent-chat-title';
    title.textContent = 'Agent';
    this.status = document.createElement('span');
    this.status.className = 'agent-chat-status';
    this.status.textContent = 'Connecting…';
    titleWrap.append(title, this.status);

    const headerActions = document.createElement('div');
    headerActions.className = 'agent-chat-header-actions';
    this.conversationSelect = document.createElement('select');
    this.conversationSelect.className = 'agent-chat-conversation-select';
    this.conversationSelect.setAttribute('aria-label', 'Saved Agent chats');
    this.conversationSelect.title = 'Current and past chats saved with this deck';
    this.conversationSelect.addEventListener('change', () => void this.changeConversation());
    this.reset = smallButton('New chat', () => void this.newChat());
    const close = smallButton('Close', () => {
      if (options.onClose) options.onClose();
      else this.hide();
    });
    close.setAttribute('aria-label', 'Close agent chat');
    headerActions.append(this.conversationSelect, this.reset, close);
    header.append(titleWrap, headerActions);

    this.account = document.createElement('div');
    this.account.className = 'agent-chat-account';
    this.account.hidden = true;
    this.signIn = smallButton('Sign in with ChatGPT', () => void this.login());
    this.signIn.classList.add('agent-chat-sign-in');
    this.switchAccount = smallButton('Switch account', () => void this.changeAccount());
    this.switchAccount.classList.add('agent-chat-switch-account');
    this.account.append(this.signIn);

    this.modelRow = document.createElement('div');
    this.modelRow.className = 'agent-chat-model';
    this.modelRow.hidden = true;
    const modelLabel = document.createElement('label');
    modelLabel.textContent = 'Model';
    modelLabel.htmlFor = 'agent-chat-model-select';
    this.modelSelect = document.createElement('select');
    this.modelSelect.id = 'agent-chat-model-select';
    this.modelSelect.setAttribute('aria-label', 'Agent model');
    this.modelSelect.addEventListener('change', () => void this.changeModel());
    const effortLabel = document.createElement('label');
    effortLabel.textContent = 'Effort';
    effortLabel.htmlFor = 'agent-chat-effort-select';
    this.effortSelect = document.createElement('select');
    this.effortSelect.id = 'agent-chat-effort-select';
    this.effortSelect.className = 'agent-chat-effort-select';
    this.effortSelect.setAttribute('aria-label', 'Agent reasoning effort');
    this.effortSelect.addEventListener('change', () => void this.changeReasoningEffort());
    this.fastMode = smallButton('⚡', () => void this.changeFastMode());
    this.fastMode.classList.add('agent-chat-fast-mode');
    this.fastMode.setAttribute('aria-label', 'Enable fast mode');
    this.fastMode.setAttribute('aria-pressed', 'false');
    this.modelRow.append(
      modelLabel,
      this.modelSelect,
      effortLabel,
      this.effortSelect,
      this.fastMode,
    );

    this.scratchpadBar = document.createElement('div');
    this.scratchpadBar.className = 'agent-chat-scratchpad-bar';
    this.scratchpadBar.hidden = true;
    this.scratchpadLabel = document.createElement('span');
    this.scratchpadLabel.textContent = 'Scratchpad';
    const showScratchpad = smallButton('Show draft', () => this.showScratchpad('source'));
    this.scratchpadBar.append(this.scratchpadLabel, showScratchpad);

    this.scratchpadPanel = document.createElement('aside');
    this.scratchpadPanel.className = 'agent-scratchpad-panel';
    this.scratchpadPanel.hidden = true;
    const scratchHeader = document.createElement('header');
    const scratchTitle = document.createElement('strong');
    scratchTitle.textContent = 'Agent scratchpad';
    const scratchActions = document.createElement('div');
    this.scratchpadSource = smallButton('Source', () => this.showScratchpad('source'));
    this.scratchpadImported = smallButton('Imported', () => this.showScratchpad('imported'));
    this.scratchpadSlides = smallButton('Slides', () => this.showScratchpad(undefined, 'slides'));
    this.scratchpadContact = smallButton(
      'Contact sheet',
      () => this.showScratchpad(undefined, 'contact'),
    );
    const hideScratchpad = smallButton('Hide', () => { this.scratchpadPanel.hidden = true; });
    scratchActions.append(
      this.scratchpadSource,
      this.scratchpadImported,
      this.scratchpadSlides,
      this.scratchpadContact,
      hideScratchpad,
    );
    scratchHeader.append(scratchTitle, scratchActions);
    this.scratchpadFrame = document.createElement('iframe');
    this.scratchpadFrame.title = 'Agent HTML scratchpad';
    // Agent-authored scripts are removed during preview. Scripts are enabled
    // here only for DeckWerk's own fitted slide navigator and contact sheet.
    this.scratchpadFrame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    this.scratchpadPanel.append(scratchHeader, this.scratchpadFrame);

    this.messages = document.createElement('div');
    this.messages.className = 'agent-chat-messages';
    this.messages.setAttribute('aria-live', 'polite');
    this.messages.dataset.nativeCopy = '';
    this.empty = document.createElement('div');
    this.empty.className = 'agent-chat-empty';
    this.empty.textContent = 'Ask for a slide edit, inspection, or design review through the live deck API.';
    this.messages.append(this.empty);

    this.error = document.createElement('div');
    this.error.className = 'agent-chat-error';
    this.error.hidden = true;

    const composer = document.createElement('div');
    composer.className = 'agent-chat-composer';
    this.input = document.createElement('textarea');
    this.input.rows = 3;
    this.input.placeholder = 'Message the agent…';
    this.input.setAttribute('aria-label', 'Message the agent');
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.submit();
      } else if (event.key === 'Escape') {
        this.hide();
      }
    });
    this.input.addEventListener('input', () => this.syncControls());
    this.action = document.createElement('button');
    this.action.type = 'button';
    this.action.className = 'ui-button ui-button-primary agent-chat-action';
    this.action.textContent = 'Send';
    this.action.addEventListener('click', () => void this.submit());
    this.stop = document.createElement('button');
    this.stop.type = 'button';
    this.stop.className = 'ui-button ui-button-danger agent-chat-stop';
    this.stop.textContent = 'Stop';
    this.stop.hidden = true;
    this.stop.addEventListener('click', () => void this.stopTurn());
    const hint = document.createElement('span');
    hint.className = 'agent-chat-hint';
    hint.textContent = 'Enter to send · Shift+Enter for a new line';
    const composeRow = document.createElement('div');
    composeRow.className = 'agent-chat-compose-row';
    const composerActions = document.createElement('div');
    composerActions.className = 'agent-chat-composer-actions';
    composerActions.append(this.stop, this.action);
    composeRow.append(hint, composerActions);
    composer.append(this.input, composeRow);

    panel.append(
      header,
      this.account,
      this.modelRow,
      this.scratchpadBar,
      this.messages,
      this.error,
      composer,
    );
    document.body.append(panel, this.scratchpadPanel);
    this.element = panel;
    options.api.onAgentChatState((state) => this.applyState(state));
    this.syncControls();
  }

  toggle(): void {
    if (this.element.hidden) this.show();
    else this.hide();
  }

  show(): void {
    this.element.hidden = false;
    if (this.state?.scratchpad) this.scratchpadPanel.hidden = false;
    this.input.focus();
    void this.options.api.getAgentChatState()
      .then((state) => this.applyState(state))
      .catch((error) => this.showLocalError(error));
  }

  hide(): void {
    this.element.hidden = true;
    this.scratchpadPanel.hidden = true;
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.state?.auth !== 'signedIn') return;
    this.input.value = '';
    this.action.disabled = true;
    try {
      this.applyState(await this.options.api.sendAgentChatMessage({ text }));
    } catch (error) {
      // Restore the failed message only if the user has not already started
      // composing the next one while the request was in flight.
      if (!this.input.value) this.input.value = text;
      this.showLocalError(error);
    } finally {
      this.syncControls();
    }
  }

  private async stopTurn(): Promise<void> {
    this.stop.disabled = true;
    try {
      this.applyState(await this.options.api.interruptAgentChat());
    } catch (error) {
      this.showLocalError(error);
    } finally {
      this.syncControls();
    }
  }

  private async login(): Promise<void> {
    this.signIn.disabled = true;
    try {
      this.applyState(await this.options.api.loginAgentChat());
    } catch (error) {
      this.showLocalError(error);
    } finally {
      this.signIn.disabled = false;
    }
  }

  private async changeAccount(): Promise<void> {
    this.switchAccount.disabled = true;
    try {
      this.applyState(await this.options.api.switchAgentChatAccount());
    } catch (error) {
      this.showLocalError(error);
    } finally {
      this.switchAccount.disabled = false;
    }
  }

  private async changeModel(): Promise<void> {
    const previous = this.state?.selectedModel ?? '';
    this.modelSelect.disabled = true;
    try {
      this.applyState(await this.options.api.setAgentChatModel({ model: this.modelSelect.value }));
    } catch (error) {
      this.modelSelect.value = previous;
      this.showLocalError(error);
    } finally {
      this.syncControls();
    }
  }

  private async changeFastMode(): Promise<void> {
    this.fastMode.disabled = true;
    try {
      this.applyState(await this.options.api.setAgentChatFastMode({
        enabled: !this.state?.fastMode,
      }));
    } catch (error) {
      this.showLocalError(error);
    } finally {
      this.syncControls();
    }
  }

  private async changeReasoningEffort(): Promise<void> {
    const previous = this.state?.selectedReasoningEffort ?? '';
    this.effortSelect.disabled = true;
    try {
      this.applyState(await this.options.api.setAgentChatReasoningEffort({
        effort: this.effortSelect.value,
      }));
    } catch (error) {
      this.effortSelect.value = previous;
      this.showLocalError(error);
    } finally {
      this.syncControls();
    }
  }

  private async newChat(): Promise<void> {
    this.reset.disabled = true;
    try {
      this.applyState(await this.options.api.resetAgentChat());
      this.input.focus();
    } catch (error) {
      this.showLocalError(error);
    } finally {
      this.reset.disabled = false;
    }
  }

  private async changeConversation(): Promise<void> {
    const chatId = this.conversationSelect.value;
    if (!chatId || !this.options.api.selectAgentChat) return;
    this.conversationSelect.disabled = true;
    try {
      this.applyState(await this.options.api.selectAgentChat({ chatId }));
      this.input.focus();
    } catch (error) {
      this.showLocalError(error);
    } finally {
      this.syncControls();
    }
  }

  private applyState(state: AgentChatState): void {
    const currentDeck = this.options.currentDeckPath();
    if (currentDeck && state.deckPath !== currentDeck) return;
    this.state = state;
    this.status.textContent = statusText(state);
    this.status.dataset.state = state.connection === 'unavailable'
      ? 'error'
      : state.busy ? 'busy' : state.auth === 'signedIn' ? 'ready' : 'idle';

    this.account.hidden = state.connection !== 'ready' || state.auth !== 'signedOut';
    if (state.auth === 'signedIn' && state.accountLabel) {
      this.account.hidden = false;
      this.account.replaceChildren();
      const label = document.createElement('span');
      label.textContent = state.accountLabel;
      this.account.append(label, this.switchAccount);
    } else if (state.auth === 'signedOut') {
      this.account.replaceChildren(this.signIn);
    }

    this.renderModels(state);
    this.renderConversations(state);
    this.renderScratchpad(state);

    this.error.hidden = !state.error;
    this.error.textContent = state.error ?? '';
    this.renderMessages(state);
    this.syncControls();
  }

  private renderScratchpad(state: AgentChatState): void {
    const scratchpad = state.scratchpad;
    this.scratchpadBar.hidden = !scratchpad;
    this.scratchpadLabel.textContent = scratchpad
      ? `Scratchpad · ${scratchpad.slideCount} slide${scratchpad.slideCount === 1 ? '' : 's'}`
      : 'Scratchpad';
    if (!scratchpad) {
      this.lastScratchpadId = null;
      this.scratchpadPanel.hidden = true;
      this.scratchpadFrame.removeAttribute('src');
      return;
    }
    if (scratchpad.draftId !== this.lastScratchpadId) {
      this.lastScratchpadId = scratchpad.draftId;
      this.scratchpadView = 'source';
      this.scratchpadMode = 'slides';
      this.showScratchpad();
    }
  }

  private renderConversations(state: AgentChatState): void {
    const signature = state.conversations
      .map((chat) => [chat.chatId, chat.title, chat.updatedAt, chat.messageCount].join('\u0000'))
      .join('\u0001');
    if (this.conversationSelect.dataset.signature !== signature) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = state.conversations.length ? 'Saved chats…' : 'No past chats';
      empty.disabled = state.conversations.length > 0;
      this.conversationSelect.replaceChildren(
        empty,
        ...state.conversations.map((chat) => {
          const option = document.createElement('option');
          option.value = chat.chatId;
          option.textContent = `${chat.title} · ${chat.messageCount}`;
          option.title = new Date(chat.updatedAt).toLocaleString();
          return option;
        }),
      );
      this.conversationSelect.dataset.signature = signature;
    }
    this.conversationSelect.value = state.chatId ?? '';
    this.conversationSelect.hidden = state.conversations.length === 0;
  }

  private showScratchpad(
    view?: 'source' | 'imported',
    mode?: 'slides' | 'contact',
  ): void {
    const scratchpad = this.state?.scratchpad;
    if (!scratchpad) return;
    if (view) this.scratchpadView = view;
    if (mode) this.scratchpadMode = mode;
    const raw = this.scratchpadView === 'source' ? scratchpad.sourceUrl : scratchpad.importedUrl;
    const url = new URL(raw, window.location.href);
    url.searchParams.set('scratchpad', this.scratchpadMode);
    if (this.scratchpadFrame.src !== url.href) this.scratchpadFrame.src = url.href;
    this.scratchpadSource.classList.toggle('active', this.scratchpadView === 'source');
    this.scratchpadImported.classList.toggle('active', this.scratchpadView === 'imported');
    this.scratchpadSlides.classList.toggle('active', this.scratchpadMode === 'slides');
    this.scratchpadContact.classList.toggle('active', this.scratchpadMode === 'contact');
    this.scratchpadPanel.hidden = false;
  }

  private renderModels(state: AgentChatState): void {
    this.modelRow.hidden = state.auth !== 'signedIn' || state.models.length === 0;
    const signature = state.models.map((model) => [
      model.model, model.displayName, model.description, model.isDefault,
      model.defaultReasoningEffort,
      ...model.reasoningEfforts.flatMap((effort) => [effort.effort, effort.description]),
      model.defaultServiceTier,
      ...model.serviceTiers.flatMap((tier) => [tier.id, tier.name, tier.description]),
    ].join('\u0000')).join('\u0001');
    if (this.modelSelect.dataset.signature !== signature) {
      this.modelSelect.replaceChildren(...state.models.map((model) => {
        const option = document.createElement('option');
        option.value = model.model;
        option.textContent = `${model.displayName}${model.isDefault ? ' (default)' : ''}`;
        option.title = model.description;
        return option;
      }));
      this.modelSelect.dataset.signature = signature;
    }
    if (state.selectedModel) this.modelSelect.value = state.selectedModel;
    const selected = state.models.find((model) => model.model === state.selectedModel);
    const effortSignature = selected?.reasoningEfforts
      .flatMap((effort) => [effort.effort, effort.description]).join('\u0000') ?? '';
    if (this.effortSelect.dataset.signature !== effortSignature) {
      this.effortSelect.replaceChildren(...(selected?.reasoningEfforts ?? []).map((effort) => {
        const option = document.createElement('option');
        option.value = effort.effort;
        option.textContent = effort.effort;
        option.title = effort.description;
        return option;
      }));
      this.effortSelect.dataset.signature = effortSignature;
    }
    this.effortSelect.hidden = !selected?.reasoningEfforts.length;
    if (state.selectedReasoningEffort) this.effortSelect.value = state.selectedReasoningEffort;
    const tier = selected?.serviceTiers.find((candidate) => {
      const id = candidate.id.toLowerCase();
      return id === 'priority' || id === 'fast' || candidate.name.toLowerCase() === 'fast';
    });
    this.fastMode.hidden = !tier;
    this.fastMode.classList.toggle('active', state.fastMode);
    this.fastMode.setAttribute('aria-pressed', String(state.fastMode));
    this.fastMode.setAttribute(
      'aria-label',
      state.fastMode ? 'Disable fast mode' : 'Enable fast mode',
    );
    this.fastMode.title = tier
      ? `${state.fastMode ? 'Disable' : 'Enable'} ${tier.name}: ${tier.description}`
      : 'Fast mode is unavailable for this model';
  }

  private renderMessages(state: AgentChatState): void {
    this.empty.hidden = state.messages.length > 0;
    const liveIds = new Set(state.messages.map((message) => message.id));
    for (const node of this.messages.querySelectorAll<HTMLElement>('.agent-chat-message')) {
      if (!liveIds.has(node.dataset.messageId ?? '')) node.remove();
    }
    for (const message of state.messages) {
      let node = this.messages.querySelector<HTMLElement>(
        `.agent-chat-message[data-message-id="${cssEscape(message.id)}"]`,
      );
      if (!node) {
        node = document.createElement('div');
        node.className = `agent-chat-message agent-chat-message-${message.role}`;
        node.dataset.messageId = message.id;
        const role = document.createElement('strong');
        role.textContent = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Agent' : 'DeckWerk';
        const body = document.createElement('div');
        body.className = 'agent-chat-message-body';
        node.append(role, body);
        this.messages.append(node);
      }
      node.classList.toggle('error', message.error === true);
      node.querySelector<HTMLElement>('.agent-chat-message-body')!.textContent = message.text;
    }
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  private syncControls(): void {
    const state = this.state;
    this.action.textContent = 'Send';
    this.action.classList.add('ui-button-primary');
    this.action.classList.remove('ui-button-danger');
    this.action.disabled = !this.input.value.trim()
      || state?.connection !== 'ready'
      || state?.auth !== 'signedIn';
    this.input.disabled = state?.connection === 'unavailable';
    this.stop.hidden = state?.busy !== true;
    this.stop.disabled = state?.busy !== true;
    this.reset.disabled = state?.busy === true;
    this.conversationSelect.disabled = state?.busy === true;
    this.switchAccount.disabled = state?.busy === true;
    this.modelSelect.disabled = state?.busy === true || state?.auth !== 'signedIn';
    this.effortSelect.disabled = state?.busy === true || state?.auth !== 'signedIn';
    this.fastMode.disabled = state?.busy === true || state?.auth !== 'signedIn';
  }

  private showLocalError(error: unknown): void {
    this.error.hidden = false;
    this.error.textContent = error instanceof Error ? error.message : String(error);
    this.syncControls();
  }
}

function smallButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ui-button ui-button-quiet';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function statusText(state: AgentChatState): string {
  if (state.connection === 'connecting') return 'Connecting…';
  if (state.connection === 'unavailable') return 'Unavailable';
  if (state.auth === 'signedOut') return 'Sign in required';
  if (state.busy) return state.activity ?? 'Working…';
  return 'Ready';
}

function cssEscape(value: string): string {
  return globalThis.CSS?.escape?.(value) ?? value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
