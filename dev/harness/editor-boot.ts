import '../../src/renderer/player/player.css';
import '../../src/renderer/editor/editor.css';
import { emptyDeck } from '../../src/shared/deck.js';
import { EditorCanvas } from '../../src/renderer/editor/canvas.js';
import { SlideRail } from '../../src/renderer/editor/slideRail.js';
import { EditorStore } from '../../src/renderer/editor/store.js';

/**
 * Mounts the real editing canvas with a stubbed preload bridge, so the
 * double-click, drag and inline-edit behaviour can be exercised with genuine
 * browser pointer events rather than synthesised jsdom ones.
 */

(window as unknown as { api: unknown }).api = {
  assetUrl: (src: string) => `/${src.replace(/^\/+/, '')}`,
  pathForFile: () => '',
  importAssets: async () => [],
  saveDeck: async () => {},
  loadTheme: async () => '',
  saveTheme: async () => {},
};

const deck = emptyDeck('Harness');
deck.slides[0].elements = [
  {
    id: 'text-1',
    type: 'text',
    x: 160,
    y: 160,
    w: 900,
    h: 160,
    rot: 0,
    z: 1,
    opacity: 1,
    class: [],
    style: { 'font-size': '64px' },
    html: 'Double-click me',
    align: 'left',
    valign: 'middle',
  },
  {
    id: 'video-1',
    type: 'video',
    x: 160,
    y: 420,
    w: 640,
    h: 360,
    rot: 0,
    z: 2,
    opacity: 1,
    class: [],
    style: {},
    src: 'decks/demo-deck/assets/testclip.mp4',
    fit: 'contain',
    autoplay: true,
    loop: true,
    muted: true,
    controls: false,
    start: 0,
    end: null,
    poster: null,
    sourceBox: null,
  },
];

// A second slide so rail commands with direction (hide, delete, reorder) have
// something to act on.
deck.slides.push({
  ...structuredClone(deck.slides[0]),
  id: 'slide-2',
  name: 'Second',
  elements: [],
});

const store = new EditorStore(deck, '/tmp/harness');
const rail = new SlideRail(document.getElementById('rail')!, store);
const canvas = new EditorCanvas(document.getElementById('canvas')!, store);

// Exposed so the harness can be driven and asserted on from the console.
Object.assign(window, { store, rail, canvas });
