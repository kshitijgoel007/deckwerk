import '../player/player.css';
import '../editor/editor.css';
import './collab.css';
import { emptyDeck } from '@shared/deck.js';
import { setIdSuffix } from '@shared/geometry.js';
import { EditorCanvas } from '../editor/canvas.js';
import { CssEditor } from '../editor/cssEditor.js';
import { createShapeInsertPicker, insertText } from '../editor/elementCreation.js';
import { HistoryPanel } from '../editor/historyPanel.js';
import { Inspector } from '../editor/inspector.js';
import {
  barButton,
  bindEditorKeys,
  createClipboardActions,
  makeContextActions,
  wireCanvasInspector,
  type ShellDeps,
} from '../editor/shellWiring.js';
import { SlideRail } from '../editor/slideRail.js';
import { EditorStore } from '../editor/store.js';
import { createThemePanel } from '../editor/themePanel.js';
import { TimelinePanel } from '../editor/timelinePanel.js';
import { CollabBridge } from './collabBridge.js';
import { createDeckOnServer, importKeynoteToServer, showDeckPicker } from './deckPicker.js';
import { installNetApi } from './netApi.js';
import { PresenceOverlay } from './presenceOverlay.js';

/**
 * Browser collaboration shell: the same canvas, rail, inspector, theme
 * gallery, timeline and history panels as the desktop app, wired to a collab
 * server over WebSocket instead of an Electron preload. Persistence, asset
 * storage, ffprobe, and Keynote import live on the server; edits leave here
 * as element-level transactions and arrive from everyone else the same way.
 */

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

/* --- identity ------------------------------------------------------------ */

function userName(): string {
  const fromQuery = new URLSearchParams(location.search).get('name');
  if (fromQuery) {
    localStorage.setItem('collab-name', fromQuery);
    return fromQuery;
  }
  const stored = localStorage.getItem('collab-name');
  if (stored) return stored;
  try {
    const answer = (prompt('Your name for this session?') ?? '').trim();
    if (answer) localStorage.setItem('collab-name', answer);
    return answer;
  } catch {
    return ''; // Embedded browsers may block prompt(); the server assigns Guest N.
  }
}

/* --- deck selection -------------------------------------------------------- */

const deckId = new URLSearchParams(location.search).get('deck');

let statusMessage = '';
function setStatusMessage(text: string): void {
  statusMessage = text;
  renderStatus();
}

if (!deckId) {
  // No deck chosen: the picker is the whole page.
  el('status').textContent = 'Choose a presentation to start.';
  showDeckPicker({ dismissable: false, onStatus: setStatusMessage });
  throw new Error('no deck selected — showing picker');
}

/* --- boot ----------------------------------------------------------------- */

installNetApi({ deckId, saveTheme: (css) => bridge.sendTheme(css) });

const store = new EditorStore(emptyDeck('Connecting…'));
const canvas = new EditorCanvas(el('canvas'), store);
// Peers should watch each other type, not just see the result on blur.
canvas.liveTextSync = true;
const inspector = new Inspector(el('inspector'), store);
new TimelinePanel(el('timeline'), store);
new HistoryPanel(el('history'), store);
const rail = new SlideRail(el('rail'), store);
// The CSS buffer backs the Theme panel and live theme sync. Like the desktop
// app it has no sidebar tab of its own — theme.css is edited on disk or
// through theme adoption, not in this UI.
const cssHost = document.createElement('div');
cssHost.hidden = true;
document.body.appendChild(cssHost);
const cssEditor = new CssEditor(cssHost);
cssEditor.onChange = () => canvas.refitAutoText();
const presence = new PresenceOverlay(canvas, store);
rail.presenceForSlide = (slideId) => presence.peersOnSlide(slideId);

wireCanvasInspector(canvas, inspector);

const themePanel = createThemePanel({
  store,
  cssEditor,
  save: async () => {},
  setStatusMessage,
  saveThemeCss: (css) => bridge.sendTheme(css),
});
el('themePanel').appendChild(themePanel.element);
el('themePanel').classList.add('theme-panel');

let connectionState = 'connecting…';

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?deck=${encodeURIComponent(deckId)}`;
const bridge = new CollabBridge(wsUrl, userName() || undefined, {
  onWelcome: (welcome) => {
    setIdSuffix(welcome.clientId.slice(0, 4));
    connectionState = `connected as ${welcome.self.name}`;
    store.load(welcome.deck, `(collab) ${deckId}`, { keepView: true });
    cssEditor.setValue(welcome.themeCss);
    themePanel.noteDeckOpened(welcome.deck);
    for (const peer of welcome.peers) presence.upsert(peer);
    rail.refreshPresence();
    renderStatus();
  },
  onDeckReplaced: (deck, label) => {
    store.applyRemote(deck, label);
  },
  onPeerPresence: (state) => {
    presence.upsert(state);
    rail.refreshPresence();
  },
  onPeerCursor: (clientId, cursor) => presence.moveCursor(clientId, cursor),
  onPeerLeft: (clientId) => {
    presence.remove(clientId);
    rail.refreshPresence();
  },
  onThemeCss: (css) => {
    // Never yank the CodeMirror buffer out from under someone typing in it.
    if (!cssEditor.hasFocus() && css !== cssEditor.getValue()) cssEditor.setValue(css);
  },
  onStatus: (text) => {
    connectionState = text;
    renderStatus();
  },
  onCleanChange: (clean) => {
    if (clean) store.markClean();
  },
});

store.onLocalEdit = bridge.localEdit;

/* --- shared shell wiring --------------------------------------------------- */

const shellDeps: ShellDeps = {
  store,
  canvas,
  rail,
  // Persistence is the server's job; Cmd+S just confirms that.
  save: async () => setStatusMessage('Saved automatically — every edit syncs live.'),
  setStatusMessage,
  undo: () => bridge.undo(store.get().deck),
  redo: () => bridge.redo(store.get().deck),
};
const clipboard = createClipboardActions(shellDeps);
bindEditorKeys(shellDeps, clipboard);
canvas.contextActions = makeContextActions(shellDeps, clipboard);

/* --- presence sending ------------------------------------------------------ */

// Cursor: rAF-throttled with a 30Hz floor, skipping unmoved samples.
let pendingCursor: { x: number; y: number } | null | undefined;
let lastCursorSent = 0;
let lastCursorKey = '';
let cursorFrame = 0;
canvas.onPointerSample = (point) => {
  pendingCursor = point;
  if (cursorFrame) return;
  cursorFrame = requestAnimationFrame(() => {
    cursorFrame = 0;
    const now = performance.now();
    if (now - lastCursorSent < 33) return;
    const slide = store.slide;
    const cursor = pendingCursor && slide
      ? { slideId: slide.id, x: Math.round(pendingCursor.x), y: Math.round(pendingCursor.y) }
      : null;
    const key = JSON.stringify(cursor);
    if (key === lastCursorKey) return;
    lastCursorKey = key;
    lastCursorSent = now;
    bridge.sendCursor(cursor);
  });
};
el('canvas').addEventListener('pointerleave', () => {
  lastCursorKey = 'null';
  bridge.sendCursor(null);
});

// Selection, active slide, editing element: edge-triggered from store changes.
let lastPresenceKey = '';
function publishPresence(): void {
  const { deck, slideIndex, slideSelection, selection } = store.get();
  const state = {
    activeSlideId: deck.slides[slideIndex]?.id ?? null,
    selectedSlideIds: [...slideSelection],
    selectedElementIds: [...selection],
    editingElementId: canvas.editingElementId(),
  };
  const key = JSON.stringify(state);
  if (key === lastPresenceKey) return;
  lastPresenceKey = key;
  bridge.sendPresence(state);
}
store.subscribe(() => {
  publishPresence();
  syncSlideSelectionContext();
  renderStatus();
});
const inspectorRefresh = canvas.onTextEditModeChange;
canvas.onTextEditModeChange = (elementId) => {
  inspectorRefresh?.(elementId);
  publishPresence();
};

/* --- toolbar, tabs, status -------------------------------------------------- */

function buildToolbar(): void {
  const bar = el('toolbar');
  bar.replaceChildren();

  const left = document.createElement('div');
  left.className = 'bar-group';
  left.append(
    barButton('New', () => {
      void createDeckOnServer().catch((error) =>
        setStatusMessage(`Create failed: ${error instanceof Error ? error.message : error}`));
    }),
    barButton('Open', () => showDeckPicker({ dismissable: true, onStatus: setStatusMessage })),
    barButton('Import Keynote…', () => importKeynoteToServer(setStatusMessage)),
  );

  const mid = document.createElement('div');
  mid.className = 'bar-group';
  mid.append(barButton('+ Text', () => insertText(store)), createShapeInsertPicker(store));

  const right = document.createElement('div');
  right.className = 'bar-group bar-right';
  right.append(
    barButton('Present', () => {
      const slideIndex = store.get().slideIndex;
      window.open(
        `present.html?deck=${encodeURIComponent(deckId!)}&slide=${slideIndex + 1}`,
        '_blank',
      );
    }, 'primary'),
  );

  bar.append(left, mid, right);
}

const PANELS = [
  { id: 'inspector', label: 'Props' },
  { id: 'themePanel', label: 'Theme' },
  { id: 'timeline', label: 'Build' },
  { id: 'history', label: 'History' },
] as const;

let activePanelId = 'inspector';

function buildTabs(): void {
  const tabs = el('side-tabs');
  tabs.replaceChildren();
  for (const panel of PANELS) {
    const b = document.createElement('button');
    b.textContent = panel.label;
    b.dataset.panel = panel.id;
    b.addEventListener('click', () => showPanel(panel.id));
    tabs.appendChild(b);
  }
  showPanel('inspector');
}

function showPanel(id: string): void {
  if (store.get().slideSelection.size > 1 && id !== 'themePanel' && id !== 'inspector') return;
  activePanelId = id;
  for (const panel of PANELS) el(panel.id).hidden = panel.id !== id;
  for (const b of el('side-tabs').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.panel === id);
  }
  if (id === 'inspector') inspector.render();
  canvas.setBuildBadgesVisible(id === 'timeline');
}

/** Multi-slide selection is a deck-level editing context: Theme and Props apply. */
function syncSlideSelectionContext(): void {
  const count = store.get().slideSelection.size;
  const multiple = count > 1;
  for (const button of el('side-tabs').querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = multiple
      && button.dataset.panel !== 'themePanel'
      && button.dataset.panel !== 'inspector';
  }
  if (multiple && activePanelId !== 'themePanel' && activePanelId !== 'inspector') {
    showPanel('themePanel');
  }
  themePanel.syncScope(count);
}

function renderStatus(): void {
  const { deck, slideIndex, slideSelection, selection, dirty } = store.get();
  const bits = [
    connectionState,
    deck.title,
    `slide ${slideIndex + 1}/${deck.slides.length}`,
  ];
  if (slideSelection.size > 1) bits.push(`${slideSelection.size} slides selected`);
  if (selection.size > 0) bits.push(`${selection.size} selected`);
  if (dirty) bits.push('syncing…');
  if (statusMessage) bits.push(statusMessage);
  el('status').textContent = bits.join('  ·  ');
}

buildToolbar();
buildTabs();
syncSlideSelectionContext();
renderStatus();
bridge.connect();

// Console access for debugging and driving a session from devtools.
Object.assign(window, { store, canvas, rail, bridge });
