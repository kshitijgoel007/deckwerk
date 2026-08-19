import type { DisplayInfo, PresentOptions } from '@shared/ipc.js';
import { button, closePopover } from './ui.js';

/** Choose audience and presenter displays before opening fullscreen windows. */
export async function presenterPreflight(): Promise<PresentOptions | null> {
  closePopover();
  const displays = await window.api.listDisplays();
  if (displays.length === 0) return {};
  const primary = displays.find((display) => display.primary) ?? displays[0];
  const external = displays.find((display) => !display.primary) ?? primary;

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'ui-dialog-backdrop';
    const dialog = document.createElement('section');
    dialog.className = 'ui-dialog presenter-preflight';
    dialog.role = 'dialog';
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'presenter-preflight-title');
    const title = document.createElement('h2');
    title.id = 'presenter-preflight-title';
    title.textContent = 'Choose presentation displays';
    const intro = document.createElement('p');
    intro.textContent = displays.length === 1
      ? 'Only one display is connected. Both views will open on it so you can arrange them safely.'
      : 'The audience sees the full-screen slide. You keep the speaker view.';

    const audience = displayField('Audience display', displays, external.id);
    const presenter = displayField('Speaker view', displays, primary.id);
    const swap = button('Swap', () => {
      const value = audience.select.value;
      audience.select.value = presenter.select.value;
      presenter.select.value = value;
    }, { variant: 'quiet' });
    swap.classList.add('presenter-swap');

    const rememberLabel = document.createElement('label');
    rememberLabel.className = 'field-check presenter-remember';
    const remember = document.createElement('input');
    remember.type = 'checkbox';
    const rememberText = document.createElement('span');
    rememberText.textContent = 'Remember this arrangement';
    rememberLabel.append(remember, rememberText);

    const actions = document.createElement('footer');
    actions.className = 'ui-dialog-actions';
    const finish = (value: PresentOptions | null) => {
      backdrop.remove();
      resolve(value);
    };
    actions.append(
      button('Cancel', () => finish(null), { variant: 'quiet' }),
      button('Start presentation', () => finish({
        audienceDisplayId: Number(audience.select.value),
        presenterDisplayId: Number(presenter.select.value),
        remember: remember.checked,
      }), { variant: 'primary' }),
    );
    dialog.append(title, intro, audience.label, swap, presenter.label, rememberLabel, actions);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    dialog.querySelector<HTMLSelectElement>('select')?.focus();
    backdrop.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') finish(null);
    });
  });
}

function displayField(labelText: string, displays: DisplayInfo[], selected: number): {
  label: HTMLLabelElement;
  select: HTMLSelectElement;
} {
  const label = document.createElement('label');
  label.className = 'field';
  const text = document.createElement('span');
  text.textContent = labelText;
  const select = document.createElement('select');
  for (const display of displays) {
    const option = document.createElement('option');
    option.value = String(display.id);
    option.textContent = `${display.label}${display.primary ? ' · Primary' : ''} · ${display.width}×${display.height}`;
    select.appendChild(option);
  }
  select.value = String(selected);
  label.append(text, select);
  return { label, select };
}
