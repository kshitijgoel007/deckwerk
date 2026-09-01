import type { EditorStore, HistoryItem } from './store.js';

export interface HistoryPanelOptions {
  onOpenAgentChat?: (chatId: string) => void;
}

/** Browsable deck snapshots. Selecting an older entry creates a new revert state. */
export class HistoryPanel {
  private stale = false;
  /** Groups the author has opened, by the identity of their newest entry. */
  private expanded = new Set<string>();

  constructor(
    private host: HTMLElement,
    private store: EditorStore,
    private options: HistoryPanelOptions = {},
  ) {
    store.subscribeHistory(() => {
      if (this.host.hidden) {
        this.stale = true;
        return;
      }
      this.render();
    });
    // Tabs toggle `hidden` directly. Catch up once the panel becomes visible
    // without making ordinary canvas selection and pointer events rebuild all
    // history rows while the panel is closed.
    new MutationObserver(() => {
      if (!this.host.hidden && this.stale) this.render();
    }).observe(this.host, { attributes: true, attributeFilter: ['hidden'] });
    this.render();
  }

  render(): void {
    this.stale = false;
    this.host.replaceChildren();
    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('h3');
    title.textContent = 'Edit history';
    header.appendChild(title);
    this.host.appendChild(header);

    const help = document.createElement('p');
    help.className = 'insp-hint';
    help.textContent = 'Choose any earlier state to restore it. Reverts are themselves undoable.';
    this.host.appendChild(help);

    const items = this.store.history();
    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'insp-hint history-empty';
      empty.textContent = 'No authored edits yet.';
      this.host.appendChild(empty);
    }
    for (const group of groupHistory(items)) {
      if (group.length === 1) {
        this.host.appendChild(this.entryRow(group[0]));
        continue;
      }
      this.host.appendChild(this.groupRow(group));
    }
  }

  /**
   * One row for a run of consecutive edits of the same kind on the same
   * element — a paragraph typed word by word is one line in the panel rather
   * than one per word. The run stays expandable, because every step in it is
   * still a state you can go back to.
   */
  private groupRow(group: HistoryItem[]): HTMLElement {
    const newest = group[0];
    const oldest = group[group.length - 1];
    const wrapper = document.createElement('div');
    wrapper.className = 'history-group';
    wrapper.dataset.historyGroup = newest.group ?? '';
    const holdsCurrent = group.some((item) => this.store.isHistoryCurrent(item.id));
    const expanded = this.expanded.has(groupKey(newest));
    wrapper.classList.toggle('is-expanded', expanded);

    const row = document.createElement('div');
    row.className = 'history-row';
    const button = document.createElement('button');
    button.className = 'history-item';
    button.dataset.historyId = String(newest.id);
    button.disabled = this.store.isHistoryCurrent(newest.id);
    const label = document.createElement('strong');
    label.textContent = holdsCurrent && button.disabled
      ? `Current · ${newest.label}`
      : newest.label;
    const meta = document.createElement('span');
    meta.textContent = `${group.length} edits · Slide ${newest.slideIndex + 1} · `
      + `${formatTime(oldest.at)}–${formatTime(newest.at)}`;
    button.append(label, meta);
    button.addEventListener('click', () => this.store.restoreHistory(newest.id));
    row.appendChild(button);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'history-group-toggle';
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute(
      'aria-label', expanded ? 'Hide the steps of this edit' : 'Show the steps of this edit',
    );
    toggle.textContent = expanded ? 'Hide steps' : `Show ${group.length} steps`;
    toggle.addEventListener('click', () => {
      const key = groupKey(newest);
      if (this.expanded.has(key)) this.expanded.delete(key);
      else this.expanded.add(key);
      this.render();
    });
    row.appendChild(toggle);
    wrapper.appendChild(row);

    if (expanded) {
      const steps = document.createElement('div');
      steps.className = 'history-group-steps';
      group.forEach((item) => steps.appendChild(this.entryRow(item, true)));
      wrapper.appendChild(steps);
    }
    return wrapper;
  }

  private entryRow(item: HistoryItem, inGroup = false): HTMLElement {
    const row = document.createElement('div');
    row.className = inGroup ? 'history-row history-step' : 'history-row';
    const button = document.createElement('button');
    button.className = 'history-item';
    button.dataset.historyId = String(item.id);
    const current = this.store.isHistoryCurrent(item.id);
    button.disabled = current;
    const label = document.createElement('strong');
    label.textContent = current ? `Current · ${item.label}` : item.label;
    const meta = document.createElement('span');
    meta.textContent = `Slide ${item.slideIndex + 1} · ${formatTime(item.at)}`;
    button.append(label);
    if (item.description) {
      const description = document.createElement('span');
      description.className = 'history-description';
      description.textContent = item.description;
      button.append(description);
    }
    button.append(meta);
    button.addEventListener('click', () => this.store.restoreHistory(item.id));
    row.appendChild(button);
    if (item.agentChatId && this.options.onOpenAgentChat) {
      const chat = document.createElement('button');
      chat.type = 'button';
      chat.className = 'history-chat-link';
      chat.textContent = 'Open Agent chat';
      chat.addEventListener('click', () => this.options.onOpenAgentChat?.(item.agentChatId!));
      row.appendChild(chat);
    }
    return row;
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/**
 * Consecutive entries that edited the same thing in the same way, newest
 * first. Only entries carrying a group take part: an edit with no group is
 * always its own row, even next to an identical label.
 */
function groupHistory(items: HistoryItem[]): HistoryItem[][] {
  const groups: HistoryItem[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    const previous = last?.[0];
    if (
      item.group && previous?.group === item.group
      && previous.label === item.label
      && !previous.description && !item.description
      && !previous.agentChatId && !item.agentChatId
    ) {
      last.push(item);
      continue;
    }
    groups.push([item]);
  }
  return groups;
}

/** Identity of a run, stable while the run keeps growing at its newest end. */
function groupKey(newest: HistoryItem): string {
  return `${newest.group}|${newest.label}`;
}
