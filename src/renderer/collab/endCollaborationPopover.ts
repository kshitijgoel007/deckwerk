let openPopover: HTMLElement | null = null;
let outsideListener: ((event: PointerEvent) => void) | null = null;
let keyListener: ((event: KeyboardEvent) => void) | null = null;

export function closeEndCollaborationPopover(focusAnchor = false): void {
  const anchorId = openPopover?.dataset.anchorId;
  openPopover?.remove();
  openPopover = null;
  if (outsideListener) document.removeEventListener('pointerdown', outsideListener, true);
  if (keyListener) document.removeEventListener('keydown', keyListener, true);
  outsideListener = null;
  keyListener = null;
  const anchor = anchorId ? document.getElementById(anchorId) : null;
  anchor?.setAttribute('aria-expanded', 'false');
  if (focusAnchor && anchor instanceof HTMLElement) anchor.focus();
}

/** A destructive, non-modal confirmation anchored directly below its trigger. */
export function openEndCollaborationPopover(
  anchor: HTMLButtonElement,
  onConfirm: () => void,
): void {
  if (openPopover) {
    closeEndCollaborationPopover(true);
    return;
  }

  if (!anchor.id) anchor.id = `end-collaboration-${Math.random().toString(36).slice(2)}`;
  anchor.setAttribute('aria-haspopup', 'dialog');
  anchor.setAttribute('aria-expanded', 'true');

  const popover = document.createElement('aside');
  popover.id = 'end-collaboration-popover';
  popover.dataset.anchorId = anchor.id;
  popover.setAttribute('role', 'alertdialog');
  popover.setAttribute('aria-modal', 'false');
  popover.setAttribute('aria-labelledby', 'end-collaboration-title');
  popover.setAttribute('aria-describedby', 'end-collaboration-description');

  const title = document.createElement('h2');
  title.id = 'end-collaboration-title';
  title.textContent = 'End collaboration?';
  const description = document.createElement('p');
  description.id = 'end-collaboration-description';
  description.textContent = 'Everyone will be disconnected. All edits are already saved.';

  const actions = document.createElement('div');
  actions.className = 'end-collaboration-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'end-collaboration-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => closeEndCollaborationPopover(true));
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'end-collaboration-confirm';
  confirm.textContent = 'End collaboration';
  confirm.addEventListener('click', () => {
    closeEndCollaborationPopover();
    onConfirm();
  });
  actions.append(cancel, confirm);
  popover.append(title, description, actions);
  document.body.appendChild(popover);
  openPopover = popover;

  // Align the panel's right edge with the toolbar button and keep it directly
  // below the trigger. The toolbar is at the top, so vertical flipping would
  // only make the relationship less clear.
  const anchorRect = anchor.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const left = Math.max(8, Math.min(
    anchorRect.right - popoverRect.width,
    window.innerWidth - popoverRect.width - 8,
  ));
  popover.style.left = `${left}px`;
  popover.style.top = `${anchorRect.bottom + 6}px`;
  const arrowLeft = Math.max(14, Math.min(
    popoverRect.width - 22,
    anchorRect.left + anchorRect.width / 2 - left - 4,
  ));
  popover.style.setProperty('--end-collaboration-arrow-left', `${arrowLeft}px`);

  popover.addEventListener('pointerdown', (event) => event.stopPropagation());
  outsideListener = (event) => {
    if (event.target instanceof Node && (popover.contains(event.target) || anchor.contains(event.target))) return;
    closeEndCollaborationPopover();
  };
  keyListener = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeEndCollaborationPopover(true);
  };
  setTimeout(() => {
    if (outsideListener) document.addEventListener('pointerdown', outsideListener, true);
  }, 0);
  document.addEventListener('keydown', keyListener, true);
  cancel.focus();
}
