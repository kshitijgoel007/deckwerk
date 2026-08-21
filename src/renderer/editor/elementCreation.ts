import type { ShapeEl, TextEl } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import type { EditorStore } from './store.js';

function nextZ(store: EditorStore): number {
  return (store.slide?.elements.reduce((max, el) => Math.max(max, el.z), 0) ?? 0) + 1;
}

/** Insert a text box and select it. Exported so creation has direct tests. */
export function insertText(store: EditorStore): TextEl {
  const { deck } = store.get();
  const created: TextEl = {
    type: 'text', id: makeId('text'),
    x: Math.round(deck.canvas.w * 0.1), y: Math.round(deck.canvas.h * 0.4),
    w: Math.round(deck.canvas.w * 0.8), h: 160, rot: 0, z: nextZ(store),
    opacity: 1, class: ['placeholder'], style: {}, html: 'New text', align: 'left', valign: 'middle',
  };
  store.commit((d) => d.slides[store.get().slideIndex].elements.push(created));
  store.select([created.id]);
  return created;
}

/** Insert a rectangle or ellipse and select it. Ellipses start as circles. */
export function insertShape(store: EditorStore, kind: 'rect' | 'ellipse'): ShapeEl {
  const { deck } = store.get();
  // Like Keynote, the ellipse tool drops a circle: a square box makes the
  // inscribed ellipse round, and Shift keeps it that way while resizing.
  const w = kind === 'ellipse' ? 320 : 400;
  const h = kind === 'ellipse' ? 320 : 240;
  const created: ShapeEl = {
    type: 'shape', id: makeId('shape'),
    x: Math.round(deck.canvas.w * 0.4), y: Math.round(deck.canvas.h * 0.4),
    w, h, rot: 0, z: nextZ(store), opacity: 1, class: [], style: {},
    shape: kind, fill: '#3b82f6', stroke: null, strokeWidth: 2, radius: 8,
    path: null, pathSize: null, arrowStart: false, arrowEnd: false,
  };
  store.commit((d) => d.slides[store.get().slideIndex].elements.push(created));
  store.select([created.id]);
  return created;
}

/** Insert a native line or arrow and select it. */
export function insertLine(
  store: EditorStore,
  kind: 'line' | 'arrow',
  curved = false,
): ShapeEl {
  const { deck } = store.get();
  const created: ShapeEl = {
    type: 'shape', id: makeId('shape'),
    x: Math.round(deck.canvas.w * 0.35), y: Math.round(deck.canvas.h * 0.5),
    w: 420, h: 2, rot: 0, z: nextZ(store), opacity: 1, class: [], style: {},
    shape: kind, fill: null, stroke: '#111827', strokeWidth: 4, radius: 0,
    path: null, pathSize: null, arrowStart: false, arrowEnd: kind === 'arrow',
    control: curved
      ? { x: Math.round(deck.canvas.w * 0.35) + 210, y: Math.round(deck.canvas.h * 0.5) - 140 }
      : null,
  };
  store.commit((d) => d.slides[store.get().slideIndex].elements.push(created));
  store.select([created.id]);
  return created;
}

type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow' | 'curved-arrow';

function shapeIcon(paths: string): string {
  return (
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" ' +
    'fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>'
  );
}

const SHAPE_OPTIONS: Array<{ kind: ShapeKind; label: string; icon: string }> = [
  { kind: 'rect', label: 'Rectangle',
    icon: shapeIcon('<rect x="2" y="3.5" width="12" height="9" rx="1.5"/>') },
  { kind: 'ellipse', label: 'Ellipse',
    icon: shapeIcon('<ellipse cx="8" cy="8" rx="6" ry="4.5"/>') },
  { kind: 'line', label: 'Line',
    icon: shapeIcon('<path d="M2.5 13.5 13.5 2.5"/>') },
  { kind: 'arrow', label: 'Arrow',
    icon: shapeIcon('<path d="M2.5 13.5 13.5 2.5M7.5 2.5h6v6"/>') },
  { kind: 'curved-arrow', label: 'Curved arrow',
    icon: shapeIcon('<path d="M2.5 13.5C3 7 7 3 13.5 2.7M8.6 2.5l5-.2.2 5"/>') },
];

/** Shape menu: a custom dropdown so each option carries an icon. */
export function createShapeInsertPicker(store: EditorStore): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'shape-menu-wrap';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'shape-menu-trigger';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML =
    '<svg class="bar-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<rect x="1.5" y="1.5" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<circle cx="10.5" cy="10.5" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' +
    '<span>Shape</span>' +
    '<svg class="shape-menu-chevron" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">' +
    '<path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let menu: HTMLDivElement | null = null;

  function close(): void {
    menu?.remove();
    menu = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onOutside(event: PointerEvent): void {
    if (!wrap.contains(event.target as Node)) close();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
  }

  function open(): void {
    menu = document.createElement('div');
    menu.className = 'shape-menu';
    menu.setAttribute('role', 'menu');
    for (const { kind, label, icon } of SHAPE_OPTIONS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'shape-menu-item';
      item.setAttribute('role', 'menuitem');
      item.innerHTML = `${icon}<span>${label}</span>`;
      item.addEventListener('click', () => {
        close();
        // A focused control suppresses the editor's Backspace/Delete
        // shortcuts; the newly created object is the active context.
        item.blur();
        trigger.blur();
        if (kind === 'curved-arrow') insertLine(store, 'arrow', true);
        else if (kind === 'line' || kind === 'arrow') insertLine(store, kind);
        else insertShape(store, kind);
      });
      menu.appendChild(item);
    }
    wrap.appendChild(menu);
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }

  trigger.addEventListener('click', () => (menu ? close() : open()));
  wrap.appendChild(trigger);
  return wrap;
}
