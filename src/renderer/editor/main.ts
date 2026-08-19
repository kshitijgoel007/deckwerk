import '../player/player.css';
import './editor.css';
import '../collab/collab.css';
import { applyAgentTransaction } from '@shared/agent.js';
import type { SlideElement } from '@shared/deck.js';
import { emptyDeck } from '@shared/deck.js';
import type { AgentSessionConnection, AuthoredHtmlFile } from '@shared/ipc.js';
import { captureEditorView, decodeEditorView, restoreEditorView } from '@shared/editorView.js';
import { setIdSuffix } from '@shared/geometry.js';
import { adoptAuthoredIds } from '@shared/htmlSlides.js';
import { rangeForSlideSelection } from '@shared/presentationRange.js';
import {
  themeById,
  themeCss,
  themeStyleCss,
  withThemeBlock,
} from '@shared/themes.js';
import { AgentBridge } from './agentBridge.js';
import { AgentChatPanel } from './agentChatPanel.js';
import { AgentChatHistoryModal } from './agentChatHistoryModal.js';
import { createDeckWerkButton } from './aboutDialog.js';
import { EditorCanvas } from './canvas.js';
import { CssEditor } from './cssEditor.js';
import { Inspector } from './inspector.js';
import { HistoryPanel } from './historyPanel.js';
import { authoredHtmlSync, fileName } from './htmlCompile.js';
import { createShapeInsertPicker, insertText } from './elementCreation.js';
import { createToolbarPicker, createToolbarSplitButton } from './exportPicker.js';
import { showPdfExportDialog } from './pdfExportDialog.js';
import { makePanelResizable } from './panelResize.js';
import { createThemePanel } from './themePanel.js';
import {
  barButton,
  barIconButton,
  TEXT_ICON,
  bindEditorKeys,
  createClipboardActions,
  makeContextActions,
  wireCanvasInspector,
  type ShellDeps,
} from './shellWiring.js';
import { SlideRail } from './slideRail.js';
import { EditorStore } from './store.js';
import { statusBarText } from './statusBar.js';
import { TimelinePanel } from './timelinePanel.js';
import { WelcomeScreen } from './welcomeScreen.js';
import { CollabBridge } from '../collab/collabBridge.js';
import { PresenceOverlay } from '../collab/presenceOverlay.js';

/**
 * Editor shell: wires the panels to one store, owns the toolbar, the keyboard
 * map and autosave.
 */

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const store = new EditorStore(emptyDeck());
let currentAgentChatId: string | null = null;
window.api.onAgentChatState?.((state) => { currentAgentChatId = state.chatId; });
const initialView = decodeEditorView(new URLSearchParams(location.search).get('view'));
let initialViewPending = initialView !== null;
const canvas = new EditorCanvas(el('canvas'), store);
const inspector = new Inspector(el('inspector'), store);
new TimelinePanel(el('timeline'), store);
const agentChatHistoryModal = new AgentChatHistoryModal(window.api);
new HistoryPanel(el('history'), store, {
  onOpenAgentChat: (chatId) => void agentChatHistoryModal.open(chatId),
});
const rail = new SlideRail(el('rail'), store);
const editorBody = el('body');
const railDivider = document.createElement('div');
railDivider.className = 'panel-resize-divider panel-resize-rail';
const sideDivider = document.createElement('div');
sideDivider.className = 'panel-resize-divider panel-resize-side';
editorBody.append(railDivider, sideDivider);
makePanelResizable(railDivider, {
  storageKey: 'deckwerk.editor.rail-size',
  sizeTarget: editorBody,
  width: {
    property: '--rail-width',
    initial: 220,
    min: 150,
    max: () => Math.min(420, window.innerWidth - 560),
    edge: 'right',
  },
});
makePanelResizable(sideDivider, {
  storageKey: 'deckwerk.editor.sidebar-size',
  sizeTarget: editorBody,
  width: {
    property: '--sidebar-width',
    initial: 320,
    min: 240,
    max: () => Math.min(560, window.innerWidth - 500),
    edge: 'left',
  },
});
let agentSessionBridge: CollabBridge | null = null;
let agentSessionReady = false;
let agentSessionWsUrl: string | null = null;
let agentPresence: PresenceOverlay | null = null;
const persistThemeCss = (css: string): Promise<void> | void => {
  if (agentSessionReady && agentSessionBridge) {
    agentSessionBridge.sendTheme(css);
    return;
  }
  return window.api.saveTheme(css);
};
const cssEditor = new CssEditor(el('theme'), persistThemeCss);
cssEditor.onChange = () => canvas.refitAutoText();
const welcome = new WelcomeScreen(el('canvas'), {
  newPresentation,
  openPresentation,
  importKeynote: importKeynotePresentation,
});
const agentChatPanel = new AgentChatPanel({
  api: window.api,
  currentDeckPath: () => store.get().dir,
  onClose: () => void endAgentChat(),
});

/**
 * Remember which element asked for a trim: the trim window reports back only
 * the new file, and this is what relinks it to the right element.
 */
let pendingTrimElementId: string | null = null;

const openTrim = (element: Extract<SlideElement, { type: 'video' }>) => {
  pendingTrimElementId = element.id;
  void window.api.openTrim({ src: element.src, elementId: element.id });
};
const openRaster = (element: Extract<SlideElement, { type: 'image' }>) => {
  void window.api.openRaster({ src: element.src, elementId: element.id });
};
wireCanvasInspector(canvas, inspector, openTrim, openRaster);

/**
 * The agent's window into this editor: it publishes the computed selection to
 * the runtime sidecar and applies inbound transactions here, in the live
 * document, so each one becomes a single named undo entry rather than a file
 * that lands underneath the user.
 */
const agent = new AgentBridge(store, {
  publish: (context) => window.api.publishAgentContext(context),
  respond: (response) => window.api.respondAgentRequest(response),
  save,
  resolveSrc: (src) => window.api.assetUrl(src),
});
window.api.onAgentRequest?.((request) => void agent.handle(request));

/**
 * Saving a file in the deck's `edit/` folder is the agent's everyday edit.
 *
 * It is compiled here rather than in a spawned browser: this window already is
 * one, it holds the live deck, and applying the result in place is what makes
 * the change a single labelled undo entry instead of a file landing underneath
 * the user. The theme comes from the editor rather than from disk, so slides
 * are measured against the typography currently on screen.
 */
window.api.onHtmlEdit?.((file) => void applyHtmlEdit(file));

let htmlEditQueue: Promise<void> = Promise.resolve();

function applyHtmlEdit(file: AuthoredHtmlFile): Promise<void> {
  // Serialised: two saves in flight would compile against the same deck and
  // the second would apply operations built from a deck that no longer exists.
  htmlEditQueue = htmlEditQueue.then(async () => {
    const name = fileName(file.path);
    try {
      // Compiling takes a moment, and the user may edit during it. The
      // operations address slides by id in a deck that has since been replaced,
      // so compile again rather than apply them to a document that moved.
      for (let attempt = 0; attempt < 3; attempt++) {
        const deck = store.get().deck;
        const { transaction, slides, warnings } = await authoredHtmlSync(deck, file, cssEditor.getValue());
        if (store.get().deck !== deck) continue;
        // Inline style the browser's parser dropped would otherwise vanish
        // silently: the page measured without it, yet the apply reads as clean.
        const warned = warnings.length === 0 ? ''
          : ` — ${warnings.length} style warning${warnings.length === 1 ? '' : 's'}: ${warnings[0]}`;
        if (!transaction) {
          setStatusMessage(`${name} asks for no change${warned}`);
          return;
        }
        store.replaceWithHistory(applyAgentTransaction(deck, transaction), transaction.label);
        await save();
        // Stamp the ids this compile assigned back into the file, so saving it
        // again replaces these slides rather than inserting them a second time.
        const adopted = adoptAuthoredIds(file.contents, slides);
        if (adopted) await window.api.htmlAdopt?.(file.path, adopted, file.contents);
        setStatusMessage(`Applied ${name}${warned}`);
        return;
      }
      setStatusMessage(`${name}: the deck kept changing while it compiled — save it again`);
    } catch (err) {
      setStatusMessage(`${name}: ${err instanceof Error ? err.message : err}`);
    }
  });
  return htmlEditQueue;
}

/* --- toolbar --- */

function buildToolbar(): void {
  const bar = el('toolbar');
  bar.replaceChildren();

  const left = document.createElement('div');
  left.className = 'bar-group';
  left.append(
    createDeckWerkButton(),
    barButton('New', newPresentation),
    barButton('Open', openPresentation),
    createToolbarPicker('Import…', [
      { label: 'Keynote…', action: () => void importKeynotePresentation() },
    ]),
    createToolbarPicker('Save As…', [
      { label: 'Deck…', action: () => void saveAsPresentation() },
      {
        label: 'Lossy export',
        options: [
          { label: 'PDF…', action: () => void exportPdf() },
          { label: 'Web…', action: () => void exportWeb() },
        ],
      },
    ], { deckOnly: true }),
  );

  const mid = document.createElement('div');
  mid.className = 'bar-group deck-only bar-center';
  mid.append(
    barIconButton('Text', TEXT_ICON, () => addText()),
    createShapeInsertPicker(store),
  );

  const right = document.createElement('div');
  right.className = 'bar-group bar-right deck-only';
  right.append(
    barButton('Agent…', () => void toggleAgentChat()),
    barButton('Collaborate', () => void startSharing()),
    createToolbarSplitButton(
      'Present',
      () => void startPresentation(),
      [{ label: 'Present in Speaker View', action: () => void startPresentation(true) }],
      { variant: 'primary', menuLabel: 'Presentation options' },
    ),
  );

  bar.append(left, mid, right);
}

async function startPresentation(speakerView = false): Promise<void> {
  // Flush before presenting: the projector must not show a stale theme.
  await cssEditor.flush();
  await save();
  const { deck, slideIndex, slideSelection } = store.get();
  const range = rangeForSlideSelection(deck.slides, slideSelection);
  await window.api.present(range?.start ?? slideIndex, {
    speakerView,
    endSlideIndex: range?.end,
  });
}

async function exportWeb(): Promise<void> {
  await cssEditor.flush();
  await save();
  try {
    const dir = await window.api.exportBundle();
    if (dir) setStatusMessage(`Exported to ${dir}`);
  } catch (err) {
    setStatusMessage(`Export failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function exportPdf(): Promise<void> {
  const choice = await showPdfExportDialog();
  if (!choice) return;
  setStatusMessage('Preparing PDF export…');
  await cssEditor.flush();
  await save();
  try {
    const result = await window.api.exportPdf({
      mode: choice.includeEachBuildStage ? 'every' : 'final',
    });
    if (result) setStatusMessage(`PDF saved to ${result}`);
  } catch (err) {
    setStatusMessage(`PDF export failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function toggleAgentChat(): Promise<void> {
  if (!agentChatPanel.element.hidden) {
    agentChatPanel.hide();
    return;
  }
  setStatusMessage('Starting embedded agent session…');
  try {
    await cssEditor.flush();
    await save();
    if (!agentSessionBridge) {
      const connection = await window.api.startAgentSession({
        agent: true,
        ...captureEditorView(store),
      });
      connectAgentSession(connection);
    }
    agentChatPanel.show();
    setStatusMessage('Agent chat opened; HTTP API brief copied to clipboard.');
  } catch (err) {
    setStatusMessage(`Agent session failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function endAgentChat(): Promise<void> {
  agentChatPanel.hide();
  if (!agentSessionBridge) return;
  setStatusMessage('Closing agent session…');
  try {
    await window.api.endAgentSession();
  } catch (err) {
    setStatusMessage(`Could not close agent session: ${err instanceof Error ? err.message : err}`);
  }
}

async function startSharing(): Promise<void> {
  setStatusMessage('Starting collaboration…');
  try {
    await cssEditor.flush();
    await save();
    await window.api.startCollab({ agent: false, ...captureEditorView(store) });
    setStatusMessage('Collaboration link copied to clipboard.');
  } catch (err) {
    setStatusMessage(`Collaboration failed: ${err instanceof Error ? err.message : err}`);
  }
}

let lastAgentPresenceKey = '';

function publishAgentPresence(): void {
  if (!agentSessionReady || !agentSessionBridge) return;
  const { deck, slideIndex, slideSelection, selection } = store.get();
  const state = {
    activeSlideId: deck.slides[slideIndex]?.id ?? null,
    selectedSlideIds: [...slideSelection],
    selectedElementIds: [...selection],
    editingElementId: canvas.editingElementId(),
  };
  const key = JSON.stringify(state);
  if (key === lastAgentPresenceKey) return;
  lastAgentPresenceKey = key;
  agentSessionBridge.sendPresence(state);
}

/** Join the background HTTP session as an ordinary collaboration peer. */
function connectAgentSession(connection: AgentSessionConnection): void {
  if (agentSessionWsUrl === connection.wsUrl && agentSessionBridge) return;
  disconnectAgentSession();
  agentSessionWsUrl = connection.wsUrl;
  agentPresence = new PresenceOverlay(canvas, store);
  rail.presenceForSlide = (slideId) => agentPresence?.peersOnSlide(slideId) ?? [];

  const bridge = new CollabBridge(connection.wsUrl, connection.name, {
    onWelcome: (welcome) => {
      if (agentSessionBridge !== bridge) return;
      setIdSuffix(welcome.clientId.slice(0, 4));
      agentSessionReady = true;
      if (JSON.stringify(store.get().deck) !== JSON.stringify(welcome.deck)) {
        store.applyRemote(welcome.deck, 'Agent session synchronized', { coalesce: false });
      }
      store.markClean();
      store.onLocalEdit = bridge.localEdit;
      cssEditor.setValue(welcome.themeCss);
      themePanel.noteDeckOpened(welcome.deck);
      for (const peer of welcome.peers) agentPresence?.upsert(peer);
      rail.refreshPresence();
      lastAgentPresenceKey = '';
      publishAgentPresence();
      setStatusMessage('Agent chat connected — edits sync live.');
    },
    onDeckReplaced: (deck, label, options) => store.applyRemote(deck, label, options),
    onPeerPresence: (state) => {
      agentPresence?.upsert(state);
      rail.refreshPresence();
    },
    onPeerCursor: (clientId, cursor) => agentPresence?.moveCursor(clientId, cursor),
    onPeerLeft: (clientId) => {
      agentPresence?.remove(clientId);
      rail.refreshPresence();
    },
    onThemeCss: (css) => {
      if (!cssEditor.hasFocus() && css !== cssEditor.getValue()) cssEditor.setValue(css);
    },
    onStatus: (text) => setStatusMessage(`Agent session: ${text}`),
    onCleanChange: (clean) => {
      if (clean) store.markClean();
    },
    onEnded: () => {
      if (agentSessionBridge === bridge) {
        disconnectAgentSession();
        setStatusMessage('Agent session ended.');
      }
    },
  });
  agentSessionBridge = bridge;
  bridge.connect();
}

function disconnectAgentSession(): void {
  const bridge = agentSessionBridge;
  agentSessionBridge = null;
  agentSessionReady = false;
  agentSessionWsUrl = null;
  lastAgentPresenceKey = '';
  if (store.onLocalEdit === bridge?.localEdit) store.onLocalEdit = null;
  bridge?.close();
  agentPresence?.destroy();
  agentPresence = null;
  rail.presenceForSlide = undefined;
  rail.refreshPresence();
}

async function newPresentation(): Promise<void> {
  const session = await window.api.newDeck();
  if (session) await adopt(session.dir, session.deck);
}

async function openPresentation(): Promise<void> {
  const session = await window.api.openDeck();
  if (session) await adopt(session.dir, session.deck);
}

async function saveAsPresentation(): Promise<void> {
  await cssEditor.flush();
  await save();
  try {
    const session = await window.api.saveDeckAs();
    if (!session) return;
    await adopt(session.dir, session.deck);
    setStatusMessage(`Saved as ${session.dir}`);
  } catch (err) {
    setStatusMessage(`Save As failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function importKeynotePresentation(): Promise<void> {
  setStatusMessage('Importing… this can take a minute for a large deck.');
  try {
    const result = await window.api.importKeynote();
    if (!result) {
      setStatusMessage('');
      return;
    }
    await adopt(result.dir, result.deck);
    const skipped = Object.values(result.report.unsupported).reduce(
      (a, b) => a + b,
      0,
    );
    setStatusMessage(
      `Imported ${result.report.slides} slides, ${result.report.elements} elements` +
        (skipped > 0 ? ` — ${skipped} objects became placeholders` : ''),
    );
  } catch (err) {
    setStatusMessage(`Import failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** The Theme sidebar tab, shared with the browser collab shell. */
const themePanel = createThemePanel({
  store,
  cssEditor,
  save,
  setStatusMessage,
  saveThemeCss: (css) => void persistThemeCss(css),
});
/* --- side panel tabs --- */

const PANELS = [
  { id: 'inspector', label: 'Props' },
  { id: 'themePanel', label: 'Theme' },
  { id: 'timeline', label: 'Build' },
  { id: 'history', label: 'History' },
] as const;

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

let activePanelId = 'inspector';

function showPanel(id: string): void {
  if (store.get().slideSelection.size > 1 && id !== 'themePanel' && id !== 'inspector') return;
  activePanelId = id;
  for (const panel of PANELS) {
    el(panel.id).hidden = panel.id !== id;
  }
  for (const b of el('side-tabs').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.panel === id);
  }
  if (id === 'inspector') inspector.render();
  canvas.setBuildBadgesVisible(id === 'timeline');
}

/** Multi-slide selection is a deck-level editing context: Theme and Props (Magic Move) apply. */
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

/* --- element creation --- */

function addText(): void {
  insertText(store);
}

/* --- persistence --- */

let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function save(): Promise<void> {
  if (!store.get().dir) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!agentSessionReady) await window.api.saveDeck(store.get().deck);
  store.markClean();
}

function scheduleSave(): void {
  if (!store.get().dir || !store.get().dirty) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void save();
  }, 800);
}

async function adopt(dir: string, deck: Parameters<typeof store.load>[0]): Promise<void> {
  store.load(deck, dir);
  if (initialViewPending) {
    restoreEditorView(store, initialView);
    initialViewPending = false;
  }
  welcome.setVisible(false);
  const loadedCss = await window.api.loadTheme();
  const installedTheme = themeById(deck.themePreset);
  // The marked block belongs to the app. Refresh it when preset definitions
  // evolve, while preserving every hand-written rule outside that block.
  const refreshedCss = deck.themeStyle
    ? withThemeBlock(loadedCss, themeStyleCss(deck.themeStyle))
    : installedTheme
      ? withThemeBlock(loadedCss, themeCss(installedTheme))
    : loadedCss;
  cssEditor.setValue(refreshedCss);
  if (refreshedCss !== loadedCss) void persistThemeCss(refreshedCss);
  themePanel.noteDeckOpened(deck);
}

/* --- keyboard, clipboard, context menu: shared shell wiring --- */

const shellDeps: ShellDeps = {
  store,
  canvas,
  rail,
  save,
  setStatusMessage,
  openTrim,
  openRaster,
  undo: () => {
    if (agentSessionReady && agentSessionBridge) agentSessionBridge.undo(store.get().deck);
    else store.undo();
  },
  redo: () => {
    if (agentSessionReady && agentSessionBridge) agentSessionBridge.redo(store.get().deck);
    else store.redo();
  },
};
const clipboard = createClipboardActions(shellDeps);

/* --- status bar --- */

/** A transient message (import result, export path, error) shown until the next edit. */
let statusMessage = '';

function setStatusMessage(text: string): void {
  statusMessage = text;
  renderStatus();
}

function renderStatus(): void {
  el('status').textContent = statusBarText(store.get(), statusMessage);
}

/* --- boot --- */

buildToolbar();
buildTabs();
el('themePanel').appendChild(themePanel.element);
el('themePanel').classList.add('theme-panel');
bindEditorKeys(shellDeps, clipboard);
const refreshInspectorForTextMode = canvas.onTextEditModeChange;
canvas.onTextEditModeChange = (elementId) => {
  refreshInspectorForTextMode?.(elementId);
  publishAgentPresence();
};
store.subscribe(() => {
  syncSlideSelectionContext();
  renderStatus();
  scheduleSave();
  publishAgentPresence();
});
syncSlideSelectionContext();
renderStatus();

// A trimmed file comes back from the trim window; relink the element that
// requested it so the new clip lands in the deck with no manual step.
window.api.onTrimDone((result) => {
  if (!pendingTrimElementId) return;
  const targetId = pendingTrimElementId;
  pendingTrimElementId = null;

  store.commit((deck) => {
    for (const slide of deck.slides) {
      const element = slide.elements.find((e) => e.id === targetId);
      if (!element || element.type !== 'video') continue;
      element.src = result.src;
      // The trim is baked into the file, so the non-destructive in/out points
      // must reset or they'd clip the already-clipped result.
      element.start = 0;
      element.end = null;
      if (result.width && result.height) {
        // Keep the on-slide width and adopt the crop's new aspect ratio.
        element.h = Math.round((element.w * result.height) / result.width);
      }
    }
  });
  void save();
});

// Raster paint writes a new PNG and reports the exact element that launched
// it, so a later selection change cannot relink the wrong image.
window.api.onRasterDone((result) => {
  const targetExists = store.get().deck.slides.some((slide) =>
    slide.elements.some((element) => element.id === result.elementId && element.type === 'image'));
  if (!targetExists) {
    setStatusMessage(`Painted PNG saved as ${result.src}, but its image element no longer exists.`);
    return;
  }
  store.commit((deck) => {
    for (const slide of deck.slides) {
      const element = slide.elements.find((candidate) => candidate.id === result.elementId);
      if (element?.type === 'image') element.src = result.src;
    }
  }, { label: 'Apply raster paint' });
  void save();
  setStatusMessage(`Painted image saved as ${result.src}`);
});


canvas.contextActions = makeContextActions(shellDeps, clipboard);

// Watch mode: the main process reloads the deck when deck.json changes on
// disk (an agent, a git checkout, hand editing) and broadcasts it here. Our
// own saves echo back identical content and are ignored by comparison.
window.api.onDeckState((session) => {
  const state = store.get();
  if (
    session.dir === state.dir &&
    JSON.stringify(session.deck) === JSON.stringify(state.deck)
  ) return;
  // A different deck is a genuine open; the same deck rewritten underneath us
  // is an edit, and an edit should be undoable rather than a history wipe.
  if (session.dir !== state.dir) store.load(session.deck, session.dir, { keepView: true });
  else store.replaceExternal(session.deck, session.dir, 'Agent edit', {
    description: 'The Agent updated the presentation through the deck’s file-based authoring workflow.',
    agentChatId: currentAgentChatId ?? undefined,
  });
  welcome.setVisible(false);
  themePanel.refreshSwatches();
  setStatusMessage('Deck reloaded from disk.');
});
window.api.onThemeCss?.((css) => {
  if (css !== cssEditor.getValue()) cssEditor.setValue(css);
});
window.api.onAgentSessionState?.((state) => {
  if (state.active) connectAgentSession(state);
  else {
    agentChatPanel.hide();
    disconnectAgentSession();
    setStatusMessage('Agent chat closed; presentation saved.');
  }
});

// Reopen the deck the main process already has, if any.
void (async () => {
  const session = await window.api.getDeck();
  if (session) await adopt(session.dir, session.deck);
  themePanel.refreshSwatches();
})();
