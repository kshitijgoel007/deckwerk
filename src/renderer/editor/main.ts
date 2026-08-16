import '../player/player.css';
import './editor.css';
import type { SlideElement } from '@shared/deck.js';
import { emptyDeck } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import { type ApplyOptions, THEMES, type ThemePreset, applyThemeToDeck, applyThemeToSlide, themeById, themeCss, withThemeBlock } from '@shared/themes.js';
import { deckProseMax } from '@shared/fontSets.js';
import { EditorCanvas } from './canvas.js';
import { CssEditor } from './cssEditor.js';
import { Inspector } from './inspector.js';
import { insertLine, insertShape, insertText } from './elementCreation.js';
import { SlideRail } from './slideRail.js';
import { EditorStore, copySelectionToClipboard, cutSelectionToClipboard, pasteFromClipboard } from './store.js';
import { TimelinePanel } from './timelinePanel.js';

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
const rail = new SlideRail(el('rail'), store);
const cssEditor = new CssEditor(el('theme'));

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
inspector.onToggleMask = (id) => canvas.toggleMaskMode(id);
inspector.maskingElement = () => canvas.maskingElement();
inspector.onSeekPreview = (id, t) => canvas.seekVideo(id, t);
inspector.videoDuration = (id) => canvas.videoDuration(id);
canvas.onMaskModeChange = () => inspector.render();

/* --- toolbar --- */

function buildToolbar(): void {
  const bar = el('toolbar');
  bar.replaceChildren();

  const left = document.createElement('div');
  left.className = 'bar-group';
  left.append(
    barButton('New', async () => {
      const session = await window.api.newDeck();
      if (session) await adopt(session.dir, session.deck);
    }),
    barButton('Open', async () => {
      const session = await window.api.openDeck();
      if (session) await adopt(session.dir, session.deck);
    }),
    barButton('Import Keynote…', async () => {
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
    }),
    barButton('Export web…', async () => {
      await cssEditor.flush();
      await save();
      try {
        const dir = await window.api.exportBundle();
        if (dir) setStatusMessage(`Exported to ${dir}`);
      } catch (err) {
        setStatusMessage(`Export failed: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );

  const mid = document.createElement('div');
  mid.className = 'bar-group';
  mid.append(barButton('+ Text', () => addText()), shapeInsertPicker());

  const right = document.createElement('div');
  right.className = 'bar-group bar-right';
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

/**
 * The theme gallery, omarchy-style.
 *
 * INSTALL changes what is available — role styles in theme.css, the swatch row
 * in every colour picker — and touches no existing content. APPLY, governed by
 * the checkboxes, is the separate act of conforming existing slides to the
 * theme; with everything unchecked it does nothing at all, and the per-slide
 * button in the sidebar applies the same options to one slide at a time.
 */
const applyOpts: ApplyOptions = {
  textColors: false,
  objectColors: false,
  fontSizes: false,
  backgrounds: false,
};

/** The gallery selection can lead the installed deck theme until Apply/Install. */
let selectedThemeId: string | null = null;
let themeSelect: HTMLSelectElement | null = null;

function currentTheme(): ThemePreset | null {
  return themeById(selectedThemeId) ?? themeById(store.get().deck.themePreset) ?? null;
}

function themePicker(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'bar-group';

  const select = document.createElement('select');
  select.className = 'bar-select';
  for (const t of THEMES) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    opt.title = t.description;
    select.appendChild(opt);
  }
  const preset = store.get().deck.themePreset;
  if (preset) select.value = preset;
  selectedThemeId = select.value;
  themeSelect = select;
  select.addEventListener('change', () => {
    selectedThemeId = select.value;
  });

  const boxes: Array<[keyof ApplyOptions, string]> = [
    ['fontSizes', 'sizes'],
    ['textColors', 'text col'],
    ['objectColors', 'obj col'],
    ['backgrounds', 'bg'],
  ];
  const boxEls = boxes.map(([key, label]) => {
    const o = optionBox(label, applyOpts[key]);
    o.input.addEventListener('change', () => (applyOpts[key] = o.input.checked));
    return o.label;
  });

  wrap.append(
    select,
    barButton('Install', () => {
      const theme = THEMES.find((t) => t.id === select.value);
      if (theme) installTheme(theme);
    }),
    ...boxEls,
    barButton('Apply to deck', () => {
      // The dropdown wins, and applying installs first: the visual result of
      // "sizes" or "text col" comes from the stylesheet, so applying a theme
      // that was never installed would look like nothing happened — which is
      // exactly how "apply works only once" presented.
      const theme = THEMES.find((t) => t.id === select.value) ?? null;
      if (!theme) return;
      const newlyInstalled = store.get().deck.themePreset !== theme.id;
      // Always refresh the generated block: preset definitions can improve
      // across app versions even when the stored theme id is unchanged.
      installTheme(theme);
      applyTheme(theme, newlyInstalled, true);
    }),
  );
  return wrap;
}

/** Install: stylesheet + swatches only. Zero pixels of the deck change. */
function installTheme(theme: ThemePreset): void {
  store.commit((d) => {
    d.themePreset = theme.id;
  });
  const css = withThemeBlock(cssEditor.getValue(), themeCss(theme));
  cssEditor.setValue(css);
  void window.api.saveTheme(css);
  refreshSwatches(theme);
  void save();
  setStatusMessage(`Installed “${theme.name}” — pickers updated, slides untouched.`);
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

function applyTheme(theme: ThemePreset, newlyInstalled = false, refreshed = false): void {
  const any = Object.values(applyOpts).some(Boolean);
  if (!any) {
    setStatusMessage(
      newlyInstalled
        ? `Installed “${theme.name}” — role-styled text updated.`
        : refreshed
          ? `Refreshed “${theme.name}” — role-styled text updated.`
          : 'Theme already installed; tick sizes / colours / bg for additional changes.',
    );
    return;
  }
  store.commit((d) => applyThemeToDeck(d, theme, { ...applyOpts }));
  setStatusMessage(`Applied “${theme.name}” to the whole deck.`);
}

/** Per-slide application, same options, invoked from the sidebar. */
function applyThemeToCurrentSlide(): void {
  const theme = currentTheme();
  if (!theme) {
    setStatusMessage('Install a theme first.');
    return;
  }
  // Applying from the slide panel uses the currently visible gallery choice,
  // even if Install was not clicked first. Installing supplies the role CSS;
  // that alone visibly updates explicitly tagged Title/Body elements.
  const newlyInstalled = store.get().deck.themePreset !== theme.id;
  installTheme(theme);
  const any = Object.values(applyOpts).some(Boolean);
  if (!any) {
    setStatusMessage(
      newlyInstalled
        ? `Installed “${theme.name}” — role-styled text updated.`
        : `Refreshed “${theme.name}” — role-styled text updated.`,
    );
    return;
  }
  const { deck, slideIndex } = store.get();
  const maxProse = deckProseMax(
    deck.slides.flatMap((sl) =>
      sl.elements
        .filter((e) => e.type === 'text')
        .map((e) => ({
          html: (e as { html: string }).html,
          size: Number.parseFloat(e.style['font-size'] ?? '0') || 0,
        })),
    ),
  );
  store.commit((d) => applyThemeToSlide(d.slides[slideIndex], theme, { ...applyOpts }, maxProse));
  setStatusMessage(`Applied “${theme.name}” to slide ${slideIndex + 1}.`);
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
  { id: 'theme', label: 'CSS' },
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

function addShape(kind: 'rect' | 'ellipse' = 'rect'): void {
  insertShape(store, kind);
}

/** "+ Shape" dropdown: rect, ellipse, line, arrow. Inserts on choice. */
function shapeInsertPicker(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'bar-select';
  const opts: Array<[string, string]> = [
    ['', '+ Shape'],
    ['rect', 'Rectangle'],
    ['ellipse', 'Ellipse'],
    ['line', 'Line'],
    ['arrow', 'Arrow'],
    ['curved-arrow', 'Curved arrow'],
  ];
  for (const [v, label] of opts) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    select.appendChild(o);
  }
  select.addEventListener('change', () => {
    const kind = select.value as 'rect' | 'ellipse' | 'line' | 'arrow' | 'curved-arrow' | '';
    select.value = '';
    if (!kind) return;
    if (kind === 'curved-arrow') insertLine(store, 'arrow', true);
    else if (kind === 'line' || kind === 'arrow') addLine(kind);
    else addShape(kind);
  });
  return select;
}

function addLine(kind: 'line' | 'arrow'): void {
  insertLine(store, kind);
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
  cssEditor.setValue(await window.api.loadTheme());
  selectedThemeId = deck.themePreset;
  if (themeSelect && deck.themePreset) themeSelect.value = deck.themePreset;
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

inspector.onApplyTheme = () => applyThemeToCurrentSlide();

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
  if (JSON.stringify(session.deck) === JSON.stringify(store.get().deck)) return;
  store.load(session.deck, session.dir, { keepView: true });
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
