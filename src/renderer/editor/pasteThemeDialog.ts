import type { SlidePasteThemeChoice } from './store.js';

/** Ask how semantic type roles should behave when slides cross deck themes. */
export function showPasteThemeDialog(count: number): Promise<SlidePasteThemeChoice | null> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const overlay = document.createElement('div');
    overlay.className = 'workflow-overlay';

    const dialog = document.createElement('section');
    dialog.className = 'workflow-dialog paste-theme-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'paste-theme-title');
    dialog.setAttribute('aria-describedby', 'paste-theme-description');

    const title = document.createElement('h2');
    title.id = 'paste-theme-title';
    title.textContent = 'Paste slides with a different theme?';

    const description = document.createElement('p');
    description.id = 'paste-theme-description';
    description.className = 'paste-theme-description';
    description.textContent = `${count} copied slide${count === 1 ? '' : 's'} use different theme typography.`;

    const explanation = document.createElement('p');
    explanation.className = 'paste-theme-detail';
    explanation.textContent = 'Keep source appearance pins the current fonts, sizes, colors, and background. '
      + 'Match destination leaves semantic title and body roles connected to this presentation’s theme.';

    const actions = document.createElement('div');
    actions.className = 'workflow-actions paste-theme-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const destination = document.createElement('button');
    destination.type = 'button';
    destination.textContent = 'Match destination';
    const source = document.createElement('button');
    source.type = 'button';
    source.className = 'primary';
    source.textContent = 'Keep source appearance';
    actions.append(cancel, destination, source);

    let finished = false;
    const finish = (choice: SlidePasteThemeChoice | null): void => {
      if (finished) return;
      finished = true;
      overlay.remove();
      previousFocus?.focus();
      resolve(choice);
    };
    cancel.addEventListener('click', () => finish(null));
    destination.addEventListener('click', () => finish('destination'));
    source.addEventListener('click', () => finish('source'));
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) finish(null);
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') finish(null);
    });

    dialog.append(title, description, explanation, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    source.focus();
  });
}
