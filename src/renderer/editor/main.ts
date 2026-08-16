import '../player/player.css';
import './editor.css';
import type { SlideElement } from '@shared/deck.js';
import { emptyDeck } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import {
  THEMES,
  type ThemeAdoption,
  type ThemePreset,
  adoptThemeStyles,
  themeById,
  themeCss,
  themeStyleCss,
  withThemeBlock,
} from '@shared/themes.js';
import { EditorCanvas } from './canvas.js';
import { CssEditor } from './cssEditor.js';
import { Inspector } from './inspector.js';
import { HistoryPanel } from './historyPanel.js';
import { createShapeInsertPicker, insertText } from './elementCreation.js';
import { createThemeGallery, type ThemeGallery } from './themeGallery.js';
import { SlideRail } from './slideRail.js';
import { EditorStore, copySelectionToClipboard, cutSelectionToClipboard, pasteFromClipboard } from './store.js';
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
canvas.onTrimRequest = openTrim;
inspector.onTrimRequest = openTrim;
inspector.onTogglePlay = (id) => canvas.toggleVideo(id);
inspector.onEditText = (id) => canvas.beginTextEdit(id);
inspector.editingText = () => canvas.isEditing();
inspector.onApplyTextSelectionWeight = (weight) => canvas.applyTextSelectionWeight(weight);
inspector.onToggleMask = (id) => canvas.toggleMaskMode(id);
inspector.maskingElement = () => canvas.maskingElement();
inspector.onSeekPreview = (id, t) => canvas.seekVideo(id, t);
inspector.videoDuration = (id) => canvas.videoDuration(id);
canvas.onMaskModeChange = () => inspector.render();
canvas.onTextEditModeChange = () => inspector.render();

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

/**
 * Theme presets are immutable style sources. One explicit operation chooses
 * scope, semantic roles and independent properties; selecting a card alone is
 * always side-effect-free.
 */
const themeAdoption: ThemeAdoption = {
  scope: 'deck',
  roles: ['title', 'heading', 'body', 'caption', 'base'],
  fontFamily: true,
  fontWeight: false,
  typeScale: false,
  textColor: false,
  background: false,
  objectColors: false,
  replaceOverrides: true,
  detectRoles: false,
};

/** The gallery selection can lead the installed deck theme until Apply/Install. */
let selectedThemeId: string | null = null;
let themeGallery: ThemeGallery | null = null;

function currentTheme(): ThemePreset | null {
  return themeById(selectedThemeId) ?? themeById(store.get().deck.themePreset) ?? null;
}

function themePicker(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'theme-browser';

  const preset = store.get().deck.themePreset;
  themeGallery = createThemeGallery(THEMES, preset, (theme) => {
    selectedThemeId = theme.id;
  });
  selectedThemeId = themeGallery.selectedId();

  const intro = document.createElement('div');
  intro.className = 'theme-browser-intro';
  const title = document.createElement('h2');
  title.textContent = 'Themes';
  const help = document.createElement('p');
  help.textContent = 'Select a style source, then choose exactly where and which properties to use. Selection alone changes nothing.';
  intro.append(title, help);

  const controls = document.createElement('div');
  controls.className = 'theme-adoption-controls';

  const scopeLabel = document.createElement('label');
  scopeLabel.className = 'field';
  const scopeTitle = document.createElement('span');
  scopeTitle.textContent = 'Apply to';
  const scope = document.createElement('select');
  for (const [value, label] of [
    ['deck', 'Deck defaults + all slides'],
    ['slide', 'Current slide only'],
    ['selection', 'Selected objects only'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    scope.appendChild(option);
  }
  scope.value = themeAdoption.scope;
  scope.addEventListener('change', () => {
    themeAdoption.scope = scope.value as ThemeAdoption['scope'];
  });
  scopeLabel.append(scopeTitle, scope);

  const roleTitle = document.createElement('div');
  roleTitle.className = 'theme-option-title';
  roleTitle.textContent = 'Text roles';
  const roleBoxes = (['title', 'heading', 'body', 'caption', 'base'] as const).map((role) => {
    const box = optionBox(role, themeAdoption.roles.includes(role));
    box.input.addEventListener('change', () => {
      themeAdoption.roles = box.input.checked
        ? [...new Set([...themeAdoption.roles, role])]
        : themeAdoption.roles.filter((candidate) => candidate !== role);
    });
    return box.label;
  });

  const propertyTitle = document.createElement('div');
  propertyTitle.className = 'theme-option-title';
  propertyTitle.textContent = 'Properties from theme';
  const boxes: Array<[keyof ThemeAdoption, string]> = [
    ['fontFamily', 'Font family'],
    ['fontWeight', 'Font weight'],
    ['typeScale', 'Size + spacing'],
    ['textColor', 'Text colour'],
    ['background', 'Slide background'],
    ['objectColors', 'Shape colours'],
    ['replaceOverrides', 'Replace matching overrides'],
    ['detectRoles', 'Detect roles for untagged text'],
  ];
  const boxEls = boxes.map(([key, label]) => {
    const o = optionBox(label, themeAdoption[key] as boolean);
    o.input.addEventListener('change', () => {
      (themeAdoption[key] as boolean) = o.input.checked;
    });
    return o.label;
  });
  controls.append(scopeLabel, roleTitle, ...roleBoxes, propertyTitle, ...boxEls);

  const actions = document.createElement('div');
  actions.className = 'theme-actions';
  actions.append(
    barButton('Use selected styles', () => {
      const theme = currentTheme();
      if (!theme) return;
      const { slideIndex, selection } = store.get();
      store.commit((deck) => adoptThemeStyles(
        deck,
        theme,
        { ...themeAdoption, roles: [...themeAdoption.roles] },
        slideIndex,
        new Set(selection),
      ));
      if (themeAdoption.scope === 'deck') refreshThemeCss(theme.name);
      refreshSwatches(theme);
      themeGallery?.setInstalled(theme.id);
      void save();
      const scopeName = themeAdoption.scope === 'deck'
        ? 'deck defaults and existing slides'
        : themeAdoption.scope === 'slide' ? 'current slide' : 'selection';
      setStatusMessage(`Used selected “${theme.name}” styles for ${scopeName}.`);
    }),
  );
  wrap.append(intro, themeGallery.element, controls, actions);
  return wrap;
}

function refreshThemeCss(label: string): void {
  const style = store.get().deck.themeStyle;
  if (!style) return;
  const css = withThemeBlock(cssEditor.getValue(), themeStyleCss(style, label));
  cssEditor.setValue(css);
  void window.api.saveTheme(css);
}

/** The swatch row shown in every colour picker, fed by the installed theme. */
function refreshSwatches(theme: ThemePreset | null): void {
  let list = document.getElementById('theme-swatches') as HTMLDataListElement | null;
  if (!list) {
    list = document.createElement('datalist');
    list.id = 'theme-swatches';
    document.body.appendChild(list);
  }
  list.replaceChildren(
    ...(theme?.palette ?? []).map((c) => {
      const o = document.createElement('option');
      o.value = c;
      return o;
    }),
  );
}

function optionBox(text: string, checked: boolean): { label: HTMLElement; input: HTMLInputElement } {
  const label = document.createElement('label');
  label.className = 'bar-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  const span = document.createElement('span');
  span.textContent = text;
  label.append(input, span);
  return { label, input };
}

function barButton(label: string, onClick: () => void, variant = ''): HTMLElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (variant) b.className = variant;
  b.addEventListener('click', onClick);
  return b;
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

function showPanel(id: string): void {
  for (const panel of PANELS) {
    el(panel.id).hidden = panel.id !== id;
  }
  for (const b of el('side-tabs').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.panel === id);
  }
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
  themeGallery?.setSelected(deck.themePreset);
  themeGallery?.setInstalled(deck.themePreset);
  selectedThemeId = themeGallery?.selectedId() ?? deck.themePreset;
  refreshSwatches(currentTheme());
}

/* --- keyboard --- */

function bindKeys(): void {
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    const typing =
      t &&
      (t.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) ||
        t.closest('.cm-editor') !== null);
    // Also bail while a canvas text edit is live, so Delete edits the text
    // rather than deleting the element being typed into.
    if (typing || canvas.isEditing()) return;

    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
      return;
    }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateSelection();
      return;
    }
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      const n = copySelectionToClipboard(store);
      if (n) setStatusMessage(`Copied ${n} element${n > 1 ? 's' : ''}.`);
      return;
    }
    if (mod && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      const n = cutSelectionToClipboard(store);
      if (n) setStatusMessage(`Cut ${n} element${n > 1 ? 's' : ''}.`);
      return;
    }
    if (mod && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      pasteFromClipboard(store);
      return;
    }

    switch (e.key) {
      case 'Backspace':
      case 'Delete': {
        e.preventDefault();
        deleteSelection();
        break;
      }
      case 'Escape':
        store.clearSelection();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        // Shift for a coarse nudge; plain arrows for pixel-accurate placement.
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        store.updateSelected((el) => {
          el.x += dx;
          el.y += dy;
          if (el.type === 'shape' && el.control) {
            el.control.x += dx;
            el.control.y += dy;
          }
        });
        break;
      }
      case 'n':
        if (!mod) rail.addSlide();
        break;
    }
  });
}

function deleteSelection(): void {
  store.deleteSelection();
}

function duplicateSelection(): void {
  const ids = store.get().selection;
  if (ids.size === 0) return;
  const created: string[] = [];
  store.commit((deck) => {
    const slide = deck.slides[store.get().slideIndex];
    for (const el of slide.elements.filter((e) => ids.has(e.id))) {
      const copy = structuredClone(el);
      copy.id = makeId(el.type);
      copy.x += 24;
      copy.y += 24;
      if (copy.type === 'shape' && copy.control) {
        copy.control.x += 24;
        copy.control.y += 24;
      }
      created.push(copy.id);
      slide.elements.push(copy);
    }
  });
  store.select(created);
}

/* --- status bar --- */

/** A transient message (import result, export path, error) shown until the next edit. */
let statusMessage = '';

function setStatusMessage(text: string): void {
  statusMessage = text;
  renderStatus();
}

function renderStatus(): void {
  const { dir, deck, slideIndex, selection, dirty } = store.get();
  const bits = [
    dir ? dir.split('/').pop() : 'No deck open — use New, Open or Import Keynote',
    `slide ${slideIndex + 1}/${deck.slides.length}`,
  ];
  if (selection.size > 0) bits.push(`${selection.size} selected`);
  if (dirty) bits.push('unsaved');
  if (statusMessage) bits.push(statusMessage);
  el('status').textContent = bits.join('  ·  ');
}

/* --- boot --- */

buildToolbar();
buildTabs();
// The theme gallery lives in its own sidebar tab, not the toolbar.
el('themePanel').appendChild(themePicker());
el('themePanel').classList.add('theme-panel');
bindKeys();
store.subscribe(() => {
  renderStatus();
  scheduleSave();
});
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


canvas.contextActions = (el) => {
  const sel = store.get().selection.size;
  const items: Array<{ label: string; action: () => void } | 'separator'> = [];
  if (el) {
    items.push(
      { label: 'Cut', action: () => void cutSelectionToClipboard(store) },
      { label: 'Copy', action: () => void copySelectionToClipboard(store) },
    );
  }
  items.push({ label: 'Paste', action: () => void pasteFromClipboard(store) });
  if (el) {
    items.push(
      { label: 'Duplicate', action: () => duplicateSelection() },
      { label: 'Delete', action: () => deleteSelection() },
      'separator',
      { label: 'Bring to front', action: () => store.updateSelected((e) => (e.z += 1000)) },
      { label: 'Send to back', action: () => store.updateSelected((e) => (e.z -= 1000)) },
    );
    if (el.type === 'image' || el.type === 'video') {
      items.push('separator', {
        label: canvas.maskingElement() === el.id ? 'Done editing mask' : 'Edit mask (crop)',
        action: () => canvas.toggleMaskMode(el.id),
      });
    }
    if (el.type === 'video') {
      items.push(
        { label: canvas.isPlaying(el.id) ? 'Pause' : 'Play', action: () => void canvas.toggleVideo(el.id) },
        { label: 'Edit w/ ffmpeg…', action: () => openTrim(el) },
      );
    }
    if (el.type === 'text' && sel === 1) {
      items.unshift({ label: 'Edit text', action: () => canvas.beginTextEdit(el.id) }, 'separator');
    }
  }
  return items;
};

// Watch mode: the main process reloads the deck when deck.json changes on
// disk (an agent, a git checkout, hand editing) and broadcasts it here. Our
// own saves echo back identical content and are ignored by comparison.
window.api.onDeckState((session) => {
  if (
    session.dir === store.get().dir &&
    JSON.stringify(session.deck) === JSON.stringify(store.get().deck)
  ) return;
  store.load(session.deck, session.dir, { keepView: true });
  welcome.setVisible(false);
  refreshSwatches(currentTheme());
  setStatusMessage('Deck reloaded from disk.');
});
window.api.onThemeCss?.((css) => {
  if (css !== cssEditor.getValue()) cssEditor.setValue(css);
});

// Reopen the deck the main process already has, if any.
void (async () => {
  const session = await window.api.getDeck();
  if (session) await adopt(session.dir, session.deck);
  refreshSwatches(currentTheme());
})();
