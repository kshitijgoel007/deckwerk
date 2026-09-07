import '../../src/renderer/player/player.css';
import '../../src/renderer/editor/editor.css';
import { emptyDeck, type SlideElement } from '../../src/shared/deck.js';
import { EditorCanvas } from '../../src/renderer/editor/canvas.js';
import { EditorStore } from '../../src/renderer/editor/store.js';
import { Inspector } from '../../src/renderer/editor/inspector.js';
import { TimelinePanel } from '../../src/renderer/editor/timelinePanel.js';
import { wireCanvasInspector } from '../../src/renderer/editor/shellWiring.js';

/**
 * Mounts the real Inspector and Build panel next to the canvas, with one
 * element of every type and a few animations, so the side panels can be
 * reviewed in a plain browser. `window.pick(ids)` selects; `window.tab(id)`
 * switches panels.
 */

(window as unknown as { api: unknown }).api = {
  assetUrl: (src: string) => `/${src.replace(/^\/+/, '')}`,
  pathForFile: () => '',
  importAssets: async () => [],
  saveDeck: async () => {},
  loadTheme: async () => '',
  saveTheme: async () => {},
  probeAsset: async () => ({ width: 640, height: 360, duration: 6 }),
};

const base = { rot: 0, opacity: 1, class: [] as string[], style: {} as Record<string, string> };
const deck = emptyDeck('Harness');
deck.slides[0].elements = [
  { ...base, id: 'title', type: 'text', x: 120, y: 80, w: 1000, h: 140, z: 1,
    class: ['role-title'], style: { 'font-size': '64px' },
    html: 'Quarterly review', align: 'left', valign: 'middle' },
  { ...base, id: 'body', type: 'text', x: 120, y: 260, w: 700, h: 300, z: 2,
    class: ['role-body'], style: {},
    html: '<ul><li>Revenue up</li><li>Costs flat</li><li>Hiring paused</li></ul>', align: 'left', valign: 'top' },
  { ...base, id: 'table', type: 'text', x: 120, y: 620, w: 700, h: 200, z: 3, style: {},
    html: '<table><tbody><tr><td>Q1</td><td>Q2</td></tr><tr><td>12</td><td>15</td></tr></tbody></table>',
    align: 'left', valign: 'top' },
  { ...base, id: 'image', type: 'image', x: 1000, y: 260, w: 400, h: 300, z: 4,
    src: 'decks/demo-deck/assets/swatch.png', fit: 'contain', alt: '', sourceBox: null },
  { ...base, id: 'video', type: 'video', x: 1000, y: 620, w: 480, h: 270, z: 5,
    src: 'decks/demo-deck/assets/testclip.mp4', fit: 'contain', autoplay: false, loop: false,
    muted: true, controls: false, start: 0, end: null, poster: null, sourceBox: null },
  { ...base, id: 'shape', type: 'shape', x: 1500, y: 260, w: 300, h: 300, z: 6, shape: 'rect',
    fill: '#3b82f6', stroke: '#ffffff', strokeWidth: 2, radius: 12, path: null, pathSize: null,
    arrowStart: false, arrowEnd: false },
  { ...base, id: 'arrow', type: 'shape', x: 1500, y: 640, w: 300, h: 40, z: 7, shape: 'arrow',
    fill: null, stroke: '#ffffff', strokeWidth: 4, radius: 0, path: null, pathSize: null,
    arrowStart: false, arrowEnd: true },
  { ...base, id: 'html', type: 'html', x: 1500, y: 760, w: 300, h: 200, z: 8,
    html: '<div style="color:white">Custom <b>markup</b></div>' },
] as SlideElement[];
deck.slides[0].timeline = [
  { id: 'a1', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'appear', target: 'body', value: null } },
  { id: 'a2', trigger: { on: 'afterPrev', ref: null, delay: 300 }, action: { type: 'appear', target: 'image', value: null } },
  { id: 'a3', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'play', target: 'video', value: null } },
];

const store = new EditorStore(deck, '/tmp/harness');
const canvas = new EditorCanvas(document.getElementById('canvas')!, store);
const inspector = new Inspector(document.getElementById('inspector')!, store);
new TimelinePanel(document.getElementById('timeline')!, store);
wireCanvasInspector(canvas, inspector);

const PANELS = [['inspector', 'Props'], ['timeline', 'Build']] as const;
const tabs = document.getElementById('side-tabs')!;
function tab(id: string): void {
  for (const [panel] of PANELS) document.getElementById(panel)!.hidden = panel !== id;
  for (const b of tabs.querySelectorAll('button')) b.classList.toggle('active', b.dataset.panel === id);
  if (id === 'inspector') inspector.render();
  canvas.setBuildBadgesVisible(id === 'timeline');
}
for (const [id, label] of PANELS) {
  const b = document.createElement('button');
  b.textContent = label;
  b.dataset.panel = id;
  b.addEventListener('click', () => tab(id));
  tabs.appendChild(b);
}
tab('inspector');

const pick = (ids: string[]) => store.select(ids);
Object.assign(window, { store, canvas, inspector, pick, tab });
