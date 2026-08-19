import type {
  AgentChatSendRequest,
  AgentChatSetModelRequest,
  AgentChatState,
} from '@shared/ipc.js';

export interface AgentChatApi {
  getAgentChatState: () => Promise<AgentChatState>;
  sendAgentChatMessage: (request: AgentChatSendRequest) => Promise<AgentChatState>;
  loginAgentChat: () => Promise<AgentChatState>;
  switchAgentChatAccount: () => Promise<AgentChatState>;
  setAgentChatModel: (request: AgentChatSetModelRequest) => Promise<AgentChatState>;
  interruptAgentChat: () => Promise<AgentChatState>;
  resetAgentChat: () => Promise<AgentChatState>;
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
  private readonly input: HTMLTextAreaElement;
  private readonly action: HTMLButtonElement;
  private readonly reset: HTMLButtonElement;
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
    this.reset = smallButton('New chat', () => void this.newChat());
    const close = smallButton('Close', () => {
      if (options.onClose) options.onClose();
      else this.hide();
    });
    close.setAttribute('aria-label', 'Close agent chat');
    headerActions.append(this.reset, close);
    header.append(titleWrap, headerActions);

    this.account = document.createElement('div');
    this.account.className = 'agent-chat-account';
    this.account.hidden = true;
    this.signIn = smallButton('Sign in with ChatGPT', () => void this.login());
    this.signIn.classList.add('agent-chat-sign-in');
    this.switchAccount = smallButton('Switch account', () => void this.changeAccount());
    this.switchAccount.classList.add('agent-chat-switch-account');
    this.account.append(this.signIn);

    this.modelRow = document.createElement('label');
    this.modelRow.className = 'agent-chat-model';
    this.modelRow.hidden = true;
    const modelLabel = document.createElement('span');
    modelLabel.textContent = 'Model';
    this.modelSelect = document.createElement('select');
    this.modelSelect.setAttribute('aria-label', 'Agent model');
    this.modelSelect.addEventListener('change', () => void this.changeModel());
    this.modelRow.append(modelLabel, this.modelSelect);

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
    const hint = document.createElement('span');
    hint.className = 'agent-chat-hint';
    hint.textContent = 'Enter to send · Shift+Enter for a new line';
    const composeRow = document.createElement('div');
    composeRow.className = 'agent-chat-compose-row';
    composeRow.append(hint, this.action);
    composer.append(this.input, composeRow);

    panel.append(header, this.account, this.modelRow, this.messages, this.error, composer);
    document.body.appendChild(panel);
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
    this.input.focus();
    void this.options.api.getAgentChatState()
      .then((state) => this.applyState(state))
      .catch((error) => this.showLocalError(error));
  }

  hide(): void {
    this.element.hidden = true;
  }

  private async submit(): Promise<void> {
    if (this.state?.busy) {
      this.action.disabled = true;
      try {
        this.applyState(await this.options.api.interruptAgentChat());
      } catch (error) {
        this.showLocalError(error);
      }
      return;
    }
    const text = this.input.value.trim();
    if (!text || this.state?.auth !== 'signedIn') return;
    this.action.disabled = true;
    try {
      this.applyState(await this.options.api.sendAgentChatMessage({ text }));
      this.input.value = '';
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

    this.error.hidden = !state.error;
    this.error.textContent = state.error ?? '';
    this.renderMessages(state);
    this.syncControls();
  }

  private renderModels(state: AgentChatState): void {
    this.modelRow.hidden = state.auth !== 'signedIn' || state.models.length === 0;
    const signature = state.models.map((model) => [
      model.model, model.displayName, model.description, model.isDefault,
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
    this.action.textContent = state?.busy ? 'Stop' : 'Send';
    this.action.classList.toggle('ui-button-primary', !state?.busy);
    this.action.classList.toggle('ui-button-danger', state?.busy === true);
    this.action.disabled = state?.busy
      ? false
      : !this.input.value.trim()
        || state?.connection !== 'ready'
        || state.auth !== 'signedIn';
    this.input.disabled = state?.busy === true || state?.connection === 'unavailable';
    this.reset.disabled = state?.busy === true;
    this.switchAccount.disabled = state?.busy === true;
    this.modelSelect.disabled = state?.busy === true || state?.auth !== 'signedIn';
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
