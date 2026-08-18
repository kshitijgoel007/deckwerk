import '../player/player.css';
import './editor.css';
import { applyAgentTransaction } from '@shared/agent.js';
import type { SlideElement } from '@shared/deck.js';
import { emptyDeck } from '@shared/deck.js';
import type { AuthoredHtmlFile, WorkflowKind } from '@shared/ipc.js';
import { adoptAuthoredIds } from '@shared/htmlSlides.js';
import {
  themeById,
  themeCss,
  themeStyleCss,
  withThemeBlock,
} from '@shared/themes.js';
import { AgentBridge } from './agentBridge.js';
import { EditorCanvas } from './canvas.js';
import { CssEditor } from './cssEditor.js';
import { Inspector } from './inspector.js';
import { HistoryPanel } from './historyPanel.js';
import { authoredHtmlSync, fileName } from './htmlCompile.js';
import { createShapeInsertPicker, insertText } from './elementCreation.js';
import { createThemePanel } from './themePanel.js';
import {
  barButton,
  bindEditorKeys,
  createClipboardActions,
  makeContextActions,
  wireCanvasInspector,
  type ShellDeps,
} from './shellWiring.js';
import { SlideRail } from './slideRail.js';
import { EditorStore } from './store.js';
import { TimelinePanel } from './timelinePanel.js';
import { WelcomeScreen } from './welcomeScreen.js';

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
const canvas = new EditorCanvas(el('canvas'), store);
const inspector = new Inspector(el('inspector'), store);
new TimelinePanel(el('timeline'), store);
new HistoryPanel(el('history'), store);
const rail = new SlideRail(el('rail'), store);
const cssEditor = new CssEditor(el('theme'));
cssEditor.onChange = () => canvas.refitAutoText();
const welcome = new WelcomeScreen(el('canvas'), {
  newPresentation,
  openPresentation,
  importKeynote: importKeynotePresentation,
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
wireCanvasInspector(canvas, inspector, openTrim);

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
    barButton('New', newPresentation),
    barButton('Open', openPresentation),
    barButton('Import Keynote…', importKeynotePresentation),
    barButton('Export web…', async () => {
      await cssEditor.flush();
      await save();
      try {
        const dir = await window.api.exportBundle();
        if (dir) setStatusMessage(`Exported to ${dir}`);
      } catch (err) {
        setStatusMessage(`Export failed: ${err instanceof Error ? err.message : err}`);
      }
    }, 'deck-only'),
  );

  const mid = document.createElement('div');
  mid.className = 'bar-group deck-only';
  mid.append(barButton('+ Text', () => addText()), createShapeInsertPicker(store));

  const right = document.createElement('div');
  right.className = 'bar-group bar-right deck-only';
  right.append(
    barButton('Edit HTML', async () => {
      try {
        const ids = store.get().deck.slides
          .filter((slide) => store.get().slideSelection.has(slide.id))
          .map((slide) => slide.id);
        const path = await window.api.exportHtml(ids);
        setStatusMessage(`HTML ready at ${path}`);
      } catch (err) {
        setStatusMessage(`HTML export failed: ${err instanceof Error ? err.message : err}`);
      }
    }),
    barButton('Agent…', openWorkflowDialog),
    barButton('Present', async () => {
      // Flush before presenting: the projector must not show a stale theme.
      await cssEditor.flush();
      await save();
      await window.api.present(store.get().slideIndex);
    }, 'primary'),
  );

  bar.append(left, mid, right);
}

async function newPresentation(): Promise<void> {
  const session = await window.api.newDeck();
  if (session) await adopt(session.dir, session.deck);
}

async function openPresentation(): Promise<void> {
  const session = await window.api.openDeck();
  if (session) await adopt(session.dir, session.deck);
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
  saveThemeCss: (css) => void window.api.saveTheme(css),
});

/**
 * The "Agent…" dialog: pick a workflow, type instructions, hand the deck over.
 *
 * The heavy lifting — rendering the slides in scope, assembling the prompt
 * from workflows/<kind>.md, opening the terminal running the agent — happens
 * in the main process; this is only the ask. The user keeps working in the
 * editor and watches the agent's saves land live.
 */
function openWorkflowDialog(): void {
  const overlay = document.createElement('div');
  overlay.className = 'workflow-overlay';

  const box = document.createElement('div');
  box.className = 'workflow-dialog';

  const title = document.createElement('h2');
  title.textContent = 'Hand this deck to an agent';

  const picker = document.createElement('select');
  const selectionCount = store.get().slideSelection.size;
  const kinds: Array<{ kind: WorkflowKind; label: string; disabled?: boolean }> = [
    { kind: 'rework-selected-slides',
      label: selectionCount > 0
        ? `Rework the ${selectionCount} selected slide${selectionCount === 1 ? '' : 's'}`
        : 'Rework selected slides (select slides first)',
      disabled: selectionCount === 0 },
    { kind: 'beautify-deck', label: 'Beautify the whole deck' },
    { kind: 'draft-new-slides', label: 'Draft new slides after the current one' },
  ];
  for (const entry of kinds) {
    const option = document.createElement('option');
    option.value = entry.kind;
    option.textContent = entry.label;
    option.disabled = entry.disabled ?? false;
    picker.append(option);
  }
  picker.value = selectionCount > 0 ? 'rework-selected-slides' : 'beautify-deck';

  const instructions = document.createElement('textarea');
  instructions.placeholder = 'Instructions for the agent — what should change, what must not…';
  instructions.rows = 5;

  const actions = document.createElement('div');
  actions.className = 'workflow-actions';
  const cancel = barButton('Cancel', () => overlay.remove());
  const start = barButton('Start agent', () => void launch(), 'primary');
  actions.append(cancel, start);

  async function launch(): Promise<void> {
    start.disabled = true;
    start.textContent = 'Preparing…';
    try {
      // Flush so the agent's renders show what the user sees right now.
      await cssEditor.flush();
      await save();
      const state = store.get();
      const result = await window.api.startWorkflow?.({
        kind: picker.value as WorkflowKind,
        instructions: instructions.value,
        selectedSlideIds: state.deck.slides
          .filter((slide) => state.slideSelection.has(slide.id))
          .map((slide) => slide.id),
        activeSlideId: state.deck.slides[state.slideIndex]?.id ?? null,
      });
      overlay.remove();
      setStatusMessage(result?.launched
        ? 'Agent started in a terminal — its changes will land here live.'
        : `Prompt ready at ${result?.promptPath} — run: ${result?.command}`);
    } catch (err) {
      overlay.remove();
      setStatusMessage(`Could not start the agent: ${err instanceof Error ? err.message : err}`);
    }
  }

  box.append(title, picker, instructions, actions);
  overlay.append(box);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove();
  });
  document.body.append(overlay);
  instructions.focus();
}

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
  await window.api.saveDeck(store.get().deck);
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
  if (refreshedCss !== loadedCss) void window.api.saveTheme(refreshedCss);
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
  const { dir, deck, slideIndex, slideSelection, selection, dirty } = store.get();
  const bits = [
    dir ? dir.split('/').pop() : 'No deck open — use New, Open or Import Keynote',
    `slide ${slideIndex + 1}/${deck.slides.length}`,
  ];
  if (slideSelection.size > 1) bits.push(`${slideSelection.size} slides selected`);
  if (selection.size > 0) bits.push(`${selection.size} selected`);
  if (dirty) bits.push('unsaved');
  if (statusMessage) bits.push(statusMessage);
  el('status').textContent = bits.join('  ·  ');
}

/* --- boot --- */

buildToolbar();
buildTabs();
// The theme gallery lives in its own sidebar tab, not the toolbar.
el('themePanel').appendChild(themePanel.element);
el('themePanel').classList.add('theme-panel');
bindEditorKeys(shellDeps, clipboard);
store.subscribe(() => {
  syncSlideSelectionContext();
  renderStatus();
  scheduleSave();
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
  else store.replaceExternal(session.deck, session.dir);
  welcome.setVisible(false);
  themePanel.refreshSwatches();
  setStatusMessage('Deck reloaded from disk.');
});
window.api.onThemeCss?.((css) => {
  if (css !== cssEditor.getValue()) cssEditor.setValue(css);
});

// Reopen the deck the main process already has, if any.
void (async () => {
  const session = await window.api.getDeck();
  if (session) await adopt(session.dir, session.deck);
  themePanel.refreshSwatches();
})();
