/**
 * The only grouped deck action in the classic toolbar. It deliberately uses
 * the existing Shape menu classes so it has the old toolbar's exact density,
 * borders, focus treatment, and placement.
 */
export function createExportPicker(options: Array<{ label: string; action: () => void }>): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'shape-menu-wrap deck-only';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'shape-menu-trigger';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = '<span>Export…</span>' +
    '<svg class="shape-menu-chevron" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">' +
    '<path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let menu: HTMLDivElement | null = null;
  const close = (): void => {
    menu?.remove();
    menu = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keys, true);
  };
  const outside = (event: PointerEvent): void => {
    if (!wrap.contains(event.target as Node)) close();
  };
  const keys = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  const open = (): void => {
    menu = document.createElement('div');
    menu.className = 'shape-menu';
    menu.setAttribute('role', 'menu');
    for (const option of options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'shape-menu-item';
      item.setAttribute('role', 'menuitem');
      item.textContent = option.label;
      item.addEventListener('click', () => {
        close();
        trigger.blur();
        option.action();
      });
      menu.appendChild(item);
    }
    wrap.appendChild(menu);
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keys, true);
    menu.querySelector<HTMLButtonElement>('button')?.focus();
  };
  trigger.addEventListener('click', () => (menu ? close() : open()));
  wrap.appendChild(trigger);
  return wrap;
}
