import type { EditorStore } from './store.js';

/** Browsable deck snapshots. Selecting an older entry creates a new revert state. */
export class HistoryPanel {
  constructor(
    private host: HTMLElement,
    private store: EditorStore,
  ) {
    store.subscribe(() => this.render());
    this.render();
  }

  render(): void {
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
    items.forEach((item, index) => {
      const button = document.createElement('button');
      button.className = 'history-item';
      button.dataset.historyId = String(item.id);
      button.disabled = index === 0;
      const label = document.createElement('strong');
      label.textContent = index === 0 ? `Current · ${item.label}` : item.label;
      const meta = document.createElement('span');
      meta.textContent = `Slide ${item.slideIndex + 1} · ${formatTime(item.at)}`;
      button.append(label, meta);
      button.addEventListener('click', () => this.store.restoreHistory(item.id));
      this.host.appendChild(button);
    });
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}
