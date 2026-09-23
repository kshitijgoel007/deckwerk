/**
 * Where a context menu opens so that all of it is on screen.
 *
 * The menu is laid out at the pointer, then measured. When it would run off
 * the bottom of the window it is flipped to open upwards from the pointer,
 * and when it is taller than the window it is pinned to the top and scrolls
 * (see `#ctx-menu` in editor.css). The same goes for the right edge. Opened
 * near the bottom of a small laptop screen, the menu's last rows used to be
 * off screen and unreachable.
 */
export const CONTEXT_MENU_MARGIN = 4;

export interface ContextMenuPlacement {
  left: number;
  top: number;
}

export function contextMenuPlacement(
  pointer: { x: number; y: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = CONTEXT_MENU_MARGIN,
): ContextMenuPlacement {
  const maxLeft = Math.max(margin, viewport.width - menu.width - margin);
  const maxTop = Math.max(margin, viewport.height - menu.height - margin);
  let left = pointer.x;
  if (left + menu.width + margin > viewport.width) {
    // Flip to the left of the pointer when there is room there, else pin.
    left = pointer.x - menu.width >= margin ? pointer.x - menu.width : maxLeft;
  }
  let top = pointer.y;
  if (top + menu.height + margin > viewport.height) {
    top = pointer.y - menu.height >= margin ? pointer.y - menu.height : maxTop;
  }
  return { left: Math.max(margin, Math.min(left, maxLeft)), top: Math.max(margin, Math.min(top, maxTop)) };
}

/** Attach a freshly built `#ctx-menu` to the document at the pointer, on screen. */
export function openContextMenu(menu: HTMLElement, pointer: { x: number; y: number }): void {
  menu.style.left = `${pointer.x}px`;
  menu.style.top = `${pointer.y}px`;
  document.body.appendChild(menu);
  const box = menu.getBoundingClientRect();
  const placed = contextMenuPlacement(
    pointer,
    { width: box.width, height: box.height },
    { width: window.innerWidth, height: window.innerHeight },
  );
  menu.style.left = `${placed.left}px`;
  menu.style.top = `${placed.top}px`;
}
