import type { AgentChatTranscript } from '@shared/ipc.js';

export interface AgentChatHistoryApi {
  getAgentChatTranscript: (request: { chatId: string }) => Promise<AgentChatTranscript | null>;
}

/** Read-only conversation viewer opened from an Agent-authored history item. */
export class AgentChatHistoryModal {
  readonly element: HTMLDialogElement;
  private readonly title: HTMLElement;
  private readonly status: HTMLElement;
  private readonly messages: HTMLElement;

  constructor(private readonly api: AgentChatHistoryApi) {
    const dialog = document.createElement('dialog');
    dialog.className = 'agent-history-dialog';
    const header = document.createElement('header');
    const heading = document.createElement('div');
    this.title = document.createElement('h2');
    this.title.textContent = 'Agent chat';
    this.status = document.createElement('p');
    this.status.textContent = 'Loading saved conversation…';
    heading.append(this.title, this.status);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'agent-history-close';
    close.setAttribute('aria-label', 'Close Agent chat');
    close.textContent = '×';
    close.addEventListener('click', () => dialog.close());
    header.append(heading, close);
    this.messages = document.createElement('div');
    this.messages.className = 'agent-history-messages';
    dialog.append(header, this.messages);
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    document.body.appendChild(dialog);
    this.element = dialog;
  }

  async open(chatId: string): Promise<void> {
    this.title.textContent = 'Agent chat for this edit';
    this.status.textContent = 'Loading saved conversation…';
    this.messages.replaceChildren();
    if (!this.element.open) this.element.showModal();
    try {
      const transcript = await this.api.getAgentChatTranscript({ chatId });
      if (!transcript) {
        this.status.textContent = 'This saved Agent chat is no longer available in the deck.';
        return;
      }
      this.status.textContent = `${transcript.accountLabel ?? 'Agent'} · ${transcript.messages.length} messages`;
      for (const message of transcript.messages) {
        const item = document.createElement('article');
        item.className = `agent-history-message agent-history-message-${message.role}`;
        const role = document.createElement('strong');
        role.textContent = message.role === 'assistant' ? 'Agent' : message.role === 'user' ? 'You' : 'System';
        const body = document.createElement('div');
        body.textContent = message.text;
        item.append(role, body);
        this.messages.appendChild(item);
      }
    } catch (error) {
      this.status.textContent = `Could not load the saved Agent chat: ${error instanceof Error ? error.message : error}`;
    }
  }
}
