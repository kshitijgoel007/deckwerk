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
    opacity: 1, class: [], style: {}, html: 'New text', align: 'left', valign: 'middle',
  };
  store.commit((d) => d.slides[store.get().slideIndex].elements.push(created));
  store.select([created.id]);
  return created;
}

/** Insert a rectangle or ellipse and select it. */
export function insertShape(store: EditorStore, kind: 'rect' | 'ellipse'): ShapeEl {
  const { deck } = store.get();
  const created: ShapeEl = {
    type: 'shape', id: makeId('shape'),
    x: Math.round(deck.canvas.w * 0.4), y: Math.round(deck.canvas.h * 0.4),
    w: 400, h: 240, rot: 0, z: nextZ(store), opacity: 1, class: [], style: {},
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

/** Shape menu. Releasing focus after insertion lets object shortcuts work immediately. */
export function createShapeInsertPicker(store: EditorStore): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'bar-select';
  const options: Array<[string, string]> = [
    ['', '+ Shape'],
    ['rect', 'Rectangle'],
    ['ellipse', 'Ellipse'],
    ['line', 'Line'],
    ['arrow', 'Arrow'],
    ['curved-arrow', 'Curved arrow'],
  ];
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    const kind = select.value as 'rect' | 'ellipse' | 'line' | 'arrow' | 'curved-arrow' | '';
    select.value = '';
    // A focused <select> suppresses the editor's Backspace/Delete shortcuts.
    // The newly created object is the active context, so return focus to it.
    select.blur();
    if (kind === 'curved-arrow') insertLine(store, 'arrow', true);
    else if (kind === 'line' || kind === 'arrow') insertLine(store, kind);
    else if (kind === 'rect' || kind === 'ellipse') insertShape(store, kind);
  });
  return select;
}
