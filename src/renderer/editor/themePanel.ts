import type { Deck, Slide, ThemeStyle } from '@shared/deck.js';
import {
  DEFAULT_DESIGN_ROLES,
  applyDesign,
  dryRunDesign,
  layoutName,
  summarizeDesignReport,
  type DesignApplyOptions,
  type DesignApplyReport,
} from '@shared/designApply.js';
import type { FixedLayout } from '@shared/layoutMasters.js';
import {
  THEMES,
  adoptThemeStyles,
  baseThemeId,
  chooseDeckTheme,
  deckTheme,
  deckThemes,
  installThemeStyle,
  presetFromStyle,
  previousThemeUsed,
  themeById,
  themeMode,
  themeStyleCss,
  themeStyleLabel,
  themeStyleOf,
  withThemeBlock,
  type ThemeMode,
  type ThemePreset,
  type ThemeTextRole,
} from '@shared/themes.js';
import { colorField } from './colorPicker.js';
import type { CssEditor } from './cssEditor.js';
import { fontFamilyField } from './fontPicker.js';
import { numberField } from './inspector.js';
import { FIXED_LAYOUTS, masterTile } from './layoutPreview.js';
import { barButton } from './shellWiring.js';
import type { EditorStore } from './store.js';
import {
  createThemeGallery,
  createThemePreviewCard,
  type ThemeGallery,
} from './themeGallery.js';

/**
 * Whether one of the stack's characterful leading families is installed.
 *
 * Only the first three families count: every stack ends in faces almost any
 * machine has plus a generic keyword, so checking the whole stack would call
 * everything available — while the point of filtering is to hide a theme
 * whose actual voice (Didot, Futura, Optima…) this machine cannot render.
 */
function stackAvailable(stack: string): boolean {
  if (typeof document === 'undefined' || !document.fonts?.check) return true;
  const leading = stack.split(',').slice(0, 3)
    .map((family) => family.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  for (const family of leading) {
    if (/^(system-ui|ui-monospace|ui-serif|ui-sans-serif|sans-serif|serif|monospace)$/i
      .test(family)) return true;
    try {
      if (document.fonts.check(`16px "${family}"`)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** The preset the deck is wearing: what was chosen, else what is installed. */
function chosenPresetId(deck: Deck): string | null {
  return deck.themeSelection?.preset ?? deck.themePreset;
}

/**
 * Themes whose display and body voices this machine can actually show.
 *
 * The deck's own presets are offered alongside the built-ins and filtered by
 * the same test: a deck theme naming a typeface this laptop lacks is as
 * unusable here as a shipped one.
 */
function availableThemes(deck: Deck, currentPresetId: string | null): ThemePreset[] {
  const pool = deckThemes(deck);
  const currentBase = baseThemeId(currentPresetId, pool);
  return pool.filter((theme) =>
    theme.id === currentBase
    || (stackAvailable(theme.fonts.title.family) && stackAvailable(theme.fonts.body.family)));
}

/**
 * The Design sidebar tab. Extracted from the Electron shell so the browser
 * collab shell shows the identical panel.
 *
 * Everything on it is a deck default until Apply: choosing a theme, its
 * Light/Dark default, editing the theme, the fixed layouts. One Apply block
 * pulls those defaults onto existing slides along two explicit axes — theme
 * (typography, type scale, colour) and layout (position and size) — through
 * the same `applyDesign` the Props tab uses, and it says beforehand what it
 * will change.
 */

export type DesignScope = 'deck' | 'slides' | 'selection';

export interface ThemePanelDeps {
  store: EditorStore;
  cssEditor: CssEditor;
  save: () => Promise<void> | void;
  setStatusMessage: (text: string) => void;
  /** Persist theme.css; the shells route this to disk or the collab server. */
  saveThemeCss: (css: string) => void;
  /**
   * Drive the read-only central Theme × Layout preview. `null` ends the
   * session and returns the canvas to the deck itself.
   */
  onThemePreview?: (theme: ThemePreset | null) => void;
  /** Enter the explicit editor for the fixed layout masters. */
  onEditLayouts?: (layout: FixedLayout) => void;
  /** Show a dry-run slide on the canvas in place of the real one; `null` clears it. */
  onPreviewSlide?: (slide: Slide | null, label: string) => void;
  /** Lay a theme draft's stylesheet over the editor; `null` removes it. */
  onPreviewThemeDraft?: (theme: ThemePreset | null) => void;
}

export interface ThemePanel {
  element: HTMLElement;
  currentTheme(): ThemePreset | null;
  refreshSwatches(): void;
  /** Reflect a freshly opened deck's installed preset in the gallery. */
  noteDeckOpened(deck: Deck): void;
  /** Keep scope controls consistent with the rail selection. */
  syncScope(slideSelectionCount: number): void;
  applyButtonLabel(): string;
  /** Close the theme chooser/editor and end its central preview session. */
  dismiss(): boolean;
}

interface ApplyGroups {
  typography: boolean;
  typeScale: boolean;
  colour: boolean;
  layout: boolean;
  detectRoles: boolean;
}

export function createThemePanel(deps: ThemePanelDeps): ThemePanel {
  const { store, cssEditor, save, setStatusMessage } = deps;

  let scope: DesignScope = 'slides';
  const groups: ApplyGroups = {
    typography: true,
    typeScale: false,
    colour: false,
    layout: false,
    detectRoles: true,
  };
  let roles: ThemeTextRole[] = [...DEFAULT_DESIGN_ROLES];
  /**
   * The master Apply puts slides on. Always explicit -- never "whatever the
   * slide is on now" -- so predicting an Apply needs no knowledge of per-slide
   * state.
   */
  let targetLayout: FixedLayout = 'standard';

  /** The gallery selection can lead the installed deck theme until Apply/Install. */
  let selectedThemeId: string | null = null;
  let themeGallery: ThemeGallery | null = null;
  let themeScopeSelect: HTMLSelectElement | null = null;
  let themeApplyButton: HTMLButtonElement | null = null;
  let layoutSelect: HTMLSelectElement | null = null;
  let layoutRow: HTMLElement | null = null;
  let readoutHost: HTMLElement | null = null;
  let mastersHost: HTMLElement | null = null;
  let mastersKey = '';
  let modeButtons = new Map<ThemeMode, HTMLButtonElement>();
  let modeLine: HTMLElement | null = null;
  let activeThemeHost: HTMLElement | null = null;
  let chooser: HTMLElement | null = null;
  let themeEditor: HTMLElement | null = null;
  let themePreviewOpen = false;
  let hadMultipleSlidesSelected = false;
  /** A theme edit in progress; nothing lands on the deck until Done. */
  let draft: { style: ThemeStyle; base: ThemePreset } | null = null;

  function currentTheme(): ThemePreset | null {
    const deck = store.get().deck;
    if (draft) return presetFromStyle(draft.style, draft.base);
    const preset = themeById(selectedThemeId, deckThemes(deck));
    if (!preset) return deckTheme(deck);
    if (preset.id === deck.themePreset && deck.themeStyle) {
      return presetFromStyle(deck.themeStyle, preset);
    }
    return preset;
  }

  function renderActiveTheme(): void {
    if (!activeThemeHost) return;
    const theme = currentTheme();
    activeThemeHost.replaceChildren();
    if (!theme) return;
    const card = createThemePreviewCard(theme, () => {
      if (draft) return;
      if (chooser && !chooser.hidden) {
        endPreview();
        return;
      }
      themePreviewOpen = true;
      deps.onThemePreview?.(theme);
      if (chooser) chooser.hidden = false;
      refreshPreviousBadge();
      renderActiveTheme();
    });
    const installed = selectedThemeId === store.get().deck.themePreset;
    card.badge.hidden = !installed && !draft;
    card.badge.textContent = draft ? 'Draft' : installed ? 'Current' : 'Preview';
    card.element.classList.add('selected', 'theme-active-card');
    card.element.setAttribute('aria-expanded', String(chooser ? !chooser.hidden : false));
    activeThemeHost.appendChild(card.element);
    for (const [mode, button] of modeButtons) {
      const on = themeMode(theme) === mode;
      button.classList.toggle('selected', on);
      button.setAttribute('aria-pressed', String(on));
    }
    if (modeLine) {
      modeLine.textContent = `New slides are born ${themeMode(theme)}. Existing slides change only through Apply.`;
    }
  }

  /**
   * Leave the chooser and its preview: the central Theme × Layout preview is
   * scaffolding for choosing, and closing the picker means "show me the deck".
   */
  function endPreview(): void {
    if (chooser) chooser.hidden = true;
    if (themePreviewOpen) deps.onThemePreview?.(null);
    themePreviewOpen = false;
    renderActiveTheme();
  }

  /** Point the gallery at the theme the deck wore before this one. */
  function refreshPreviousBadge(): void {
    const deck = store.get().deck;
    themeGallery?.setPrevious(previousThemeUsed(deck, chosenPresetId(deck)));
  }

  function notifyThemePreview(): void {
    const theme = currentTheme();
    renderActiveTheme();
    refreshSwatches();
    renderMasters(true);
    renderReadout();
    if (themePreviewOpen) deps.onThemePreview?.(theme);
  }

  function refreshThemeCss(): void {
    const deck = store.get().deck;
    if (!deck.themeStyle) return;
    const css = withThemeBlock(cssEditor.getValue(), themeStyleCss(deck.themeStyle, themeStyleLabel(deck)));
    if (css === cssEditor.getValue()) return;
    cssEditor.setValue(css);
    deps.saveThemeCss(css);
  }

  /**
   * Record the chosen theme as the deck's current one. Existing slides are
   * left exactly as they are — restyling them is what Apply is for — but
   * slides created from here on are born wearing this theme.
   */
  function chooseTheme(theme: ThemePreset): void {
    const deck = store.get().deck;
    if (deck.themeSelection?.preset === theme.id && deck.themePreset === theme.id) return;
    store.commit((target) => chooseDeckTheme(target, theme), { label: `Choose ${theme.name}` });
    refreshThemeCss();
    themeGallery?.setInstalled(theme.id);
    void save();
    setStatusMessage(
      `New slides will use “${theme.name}”. Existing slides keep their current `
      + 'styling — use Apply below to restyle them.',
    );
  }

  /** The swatch row shown in every colour picker, fed by the installed theme. */
  function refreshSwatches(): void {
    const theme = currentTheme();
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

  function optionBox(
    text: string,
    checked: boolean,
    sub = '',
  ): { label: HTMLElement; input: HTMLInputElement } {
    const label = document.createElement('label');
    label.className = 'field field-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    const span = document.createElement('span');
    span.textContent = text;
    if (sub) {
      const small = document.createElement('small');
      small.className = 'field-check-sub';
      small.textContent = ` · ${sub}`;
      span.appendChild(small);
    }
    label.append(input, span);
    return { label, input };
  }

  /* --- scope and the apply operation --- */

  function scopeSlideIds(): Set<string> {
    const { deck, slideIndex, slideSelection } = store.get();
    if (scope === 'deck') return new Set(deck.slides.map((slide) => slide.id));
    if (scope === 'slides' && slideSelection.size > 0) return new Set(slideSelection);
    const current = deck.slides[slideIndex];
    return new Set(current ? [current.id] : []);
  }

  function effectiveTarget(): FixedLayout {
    return targetLayout;
  }

  function applyOptions(): DesignApplyOptions {
    return {
      typography: groups.typography,
      typeScale: groups.typeScale,
      colour: groups.colour,
      layout: groups.layout && scope !== 'selection' ? effectiveTarget() : null,
      detectRoles: groups.detectRoles,
      roles: [...roles],
    };
  }

  function scopeName(count: number): string {
    return scope === 'deck'
      ? 'the deck'
      : scope === 'selection'
        ? 'the selected objects'
        : `${count} slide${count === 1 ? '' : 's'}`;
  }

  function applyButtonLabel(): string {
    const count = scopeSlideIds().size;
    return scope === 'deck'
      ? 'Apply to deck'
      : scope === 'selection'
        ? 'Apply to selected objects'
        : `Apply to ${count} slide${count === 1 ? '' : 's'}`;
  }

  interface ReadoutRow {
    count: number;
    text: string;
    warn?: boolean;
  }

  function readoutRows(report: DesignApplyReport, options: DesignApplyOptions, slideCount: number): ReadoutRow[] {
    const rows: ReadoutRow[] = [];
    const theme = currentTheme();
    if (options.typography || options.typeScale || options.colour) {
      const what = [
        options.typography && 'type',
        options.typeScale && 'scale',
        options.colour && 'colour',
      ].filter(Boolean).join(', ');
      rows.push({ count: report.followed.length, text: `text boxes follow ${theme?.name ?? 'the theme'} ${what}` });
      rows.push({ count: report.overridesCleared.length, text: 'of them lose local overrides' });
    }
    if (options.colour) {
      rows.push({ count: report.backgroundsReset.length, text: 'own backgrounds go back to the theme' });
    }
    if (options.layout) {
      if (options.layout === 'freeform') {
        rows.push({ count: report.released.length, text: 'boxes released from their slots (they stay where they are)' });
      } else {
        rows.push({ count: report.assigned.length, text: `slides put on ${layoutName(options.layout)}` });
        rows.push({ count: report.moved.length, text: `boxes move to ${layoutName(options.layout)} positions` });
        if (report.created.length) rows.push({ count: report.created.length, text: 'prompts created on empty slides' });
        if (report.unplaced.length) {
          rows.push({ count: report.unplaced.length, text: 'slots with no matching box · nothing is created', warn: true });
        }
        if (report.undetected.length) {
          rows.push({ count: report.undetected.length, text: 'slides have untagged text that cannot be placed · turn on Detect roles', warn: true });
        }
      }
    }
    if (options.detectRoles) rows.push({ count: report.retagged.length, text: 'untagged boxes get a role' });
    if (slideCount === 0) rows.length = 0;
    return rows;
  }

  function renderReadout(): void {
    if (!readoutHost || !themeApplyButton) return;
    readoutHost.replaceChildren();
    if (scope === 'selection') {
      const { selection } = store.get();
      const row = document.createElement('div');
      row.className = `design-readout-row${selection.size === 0 ? ' zero' : ''}`;
      row.innerHTML = `<b>${selection.size}</b><span>selected objects follow the theme for the ticked properties</span>`;
      readoutHost.appendChild(row);
      themeApplyButton.textContent = applyButtonLabel();
      themeApplyButton.disabled = selection.size === 0
        || !(groups.typography || groups.typeScale || groups.colour);
      return;
    }
    const ids = scopeSlideIds();
    const deck = store.get().deck;
    const options = applyOptions();
    const { report } = dryRunDesign(deck, currentTheme(), options, ids);
    const rows = readoutRows(report, options, ids.size);
    if (ids.size === 0) {
      const row = document.createElement('div');
      row.className = 'design-readout-row zero';
      row.innerHTML = '<b>–</b><span>no slides selected</span>';
      readoutHost.appendChild(row);
    }
    for (const entry of rows) {
      const row = document.createElement('div');
      row.className = `design-readout-row${entry.count === 0 ? ' zero' : ''}${entry.warn ? ' warn' : ''}`;
      const count = document.createElement('b');
      count.textContent = String(entry.count);
      const text = document.createElement('span');
      text.textContent = entry.text;
      row.append(count, text);
      readoutHost.appendChild(row);
    }
    const total = rows.filter((row) => !row.warn).reduce((sum, row) => sum + row.count, 0);
    themeApplyButton.disabled = ids.size === 0 || total === 0;
    themeApplyButton.textContent = ids.size === 0
      ? 'Apply'
      : total === 0
        ? `Nothing to change on ${scopeName(ids.size)}`
        : applyButtonLabel();
  }

  /** The current slide, as the batch Apply would leave it, on the canvas. */
  function previewApply(label = 'Apply'): void {
    if (!deps.onPreviewSlide || scope === 'selection') return;
    const ids = scopeSlideIds();
    const { deck, slideIndex } = store.get();
    const current = deck.slides[slideIndex];
    if (!current || !ids.has(current.id)) return;
    const { deck: previewDeck, report } = dryRunDesign(deck, currentTheme(), applyOptions(), ids);
    const shown = previewDeck.slides.find((slide) => slide.id === current.id) ?? null;
    deps.onPreviewSlide(shown, `${label} · slide ${slideIndex + 1} · ${summarizeDesignReport(report)}`);
  }

  function clearPreview(): void {
    deps.onPreviewSlide?.(null, '');
  }

  function applyNow(): void {
    const theme = currentTheme();
    clearPreview();
    if (scope === 'selection') {
      if (!theme) return;
      const { slideIndex, selection, slideSelection } = store.get();
      store.commit((deck) => adoptThemeStyles(deck, theme, {
        scope: 'selection',
        roles: [...roles],
        fontFamily: groups.typography,
        fontWeight: groups.typography,
        typeScale: groups.typeScale,
        textColor: groups.colour,
        background: false,
        objectColors: groups.colour,
        replaceOverrides: true,
        detectRoles: groups.detectRoles,
      }, slideIndex, new Set(selection), new Set(slideSelection)), { label: 'Apply theme to objects' });
      afterApply(`Used “${theme.name}” styles for the selected objects.`);
      return;
    }
    const ids = scopeSlideIds();
    if (ids.size === 0) return;
    let summary = '';
    store.commit((deck) => {
      const report = applyDesign(deck, theme, applyOptions(), ids);
      summary = summarizeDesignReport(report);
    }, { label: `Apply design to ${scopeName(ids.size)}` });
    afterApply(`Applied to ${scopeName(ids.size)}: ${summary}.`);
  }

  function afterApply(message: string): void {
    // Every apply installs what it adopted (see adoptThemeStyles), so the
    // stylesheet the slides load has to follow the deck's defaults each time.
    if (store.get().deck.themeStyle) refreshThemeCss();
    refreshSwatches();
    themeGallery?.setInstalled(store.get().deck.themePreset);
    selectedThemeId = store.get().deck.themePreset;
    void save();
    refreshPreviousBadge();
    notifyThemePreview();
    setStatusMessage(message);
  }

  /* --- masters strip --- */

  function renderMasters(force = false): void {
    if (!mastersHost) return;
    const deck = store.get().deck;
    const theme = currentTheme();
    const key = JSON.stringify([deck.layoutMasters, theme?.id, theme?.colors, effectiveTarget()]);
    if (!force && key === mastersKey) return;
    mastersKey = key;
    mastersHost.replaceChildren();
    for (const layout of FIXED_LAYOUTS) {
      const item = document.createElement('button');
      item.type = 'button';
      const selected = effectiveTarget() === layout;
      item.className = `layout-popover-item design-master${selected ? ' selected' : ''}`;
      item.setAttribute('aria-label', `Apply puts slides on ${layoutName(layout)}`);
      item.setAttribute('aria-pressed', String(selected));
      const { frame } = masterTile(layout, deck.layoutMasters, theme, { caption: false });
      const caption = document.createElement('em');
      caption.textContent = layoutName(layout);
      item.append(frame, caption);
      item.addEventListener('mouseenter', () => {
        if (scope === 'selection') return;
        const ids = scopeSlideIds();
        const { deck: liveDeck, slideIndex } = store.get();
        const current = liveDeck.slides[slideIndex];
        if (!current || !ids.has(current.id) || !deps.onPreviewSlide) return;
        const options = { ...applyOptions(), layout };
        const { deck: previewDeck, report } = dryRunDesign(liveDeck, theme, options, ids);
        const shown = previewDeck.slides.find((slide) => slide.id === current.id) ?? null;
        deps.onPreviewSlide(shown, `${layoutName(layout)} · slide ${slideIndex + 1} · ${summarizeDesignReport(report)}`);
      });
      item.addEventListener('mouseleave', clearPreview);
      item.addEventListener('click', () => {
        targetLayout = layout;
        groups.layout = true;
        if (layoutSelect) layoutSelect.value = layout;
        syncLayoutRow();
        renderMasters(true);
        renderReadout();
      });
      mastersHost.appendChild(item);
    }
  }

  function syncLayoutRow(): void {
    if (layoutRow) layoutRow.hidden = !groups.layout;
    const box = layoutRow?.parentElement?.querySelector<HTMLInputElement>('input[data-group="layout"]');
    if (box) box.checked = groups.layout;
  }

  /**
   * The Props tab's section: a ruled block under an `insp-subtitle` heading.
   * Built here rather than imported so the two panels stay independent, but
   * the markup and classes are deliberately identical.
   */
  function panelSection(title: string, extraClass = ''): HTMLElement {
    const section = document.createElement('section');
    section.className = `insp-option-section ${extraClass}`.trim();
    const heading = document.createElement('h4');
    heading.className = 'insp-subtitle';
    heading.textContent = title;
    section.appendChild(heading);
    return section;
  }

  /** A label naming a cluster of controls inside a section — a field label. */
  function groupLabel(text: string): HTMLElement {
    const label = document.createElement('div');
    label.className = 'theme-option-title';
    label.textContent = text;
    return label;
  }

  function hintLine(text = '', extraClass = ''): HTMLElement {
    const line = document.createElement('p');
    line.className = `insp-hint design-readout ${extraClass}`.trim();
    line.textContent = text;
    return line;
  }

  /** The ids the gallery currently offers, to tell when a deck needs a new one. */
  let offeredThemeIds = '';

  /**
   * A gallery for this deck's menu of themes. The menu is per deck, not per
   * session (see `noteDeckOpened`).
   */
  function buildGallery(deck: Deck): ThemeGallery {
    const preset = chosenPresetId(deck);
    const themes = availableThemes(deck, preset);
    offeredThemeIds = themes.map((theme) => theme.id).join('\n');
    return createThemeGallery(themes, preset, (theme, source) => {
      selectedThemeId = theme.id;
      chooseTheme(theme);
      // Picking a card is a decision and closes the picker; flipping the
      // Light/Dark switch is still browsing, so the gallery stays open.
      if (source === 'card') endPreview();
      else refreshPreviousBadge();
      notifyThemePreview();
    });
  }

  function build(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'theme-browser';

    themeGallery = buildGallery(store.get().deck);
    selectedThemeId = themeGallery.selectedId();

    const intro = document.createElement('div');
    intro.className = 'theme-browser-intro';
    const title = document.createElement('h2');
    title.className = 'insp-title';
    title.textContent = 'Design';
    intro.append(title);

    /* --- this deck wears --- */
    activeThemeHost = document.createElement('div');
    activeThemeHost.className = 'theme-active-host';

    chooser = document.createElement('section');
    chooser.className = 'theme-chooser';
    chooser.hidden = true;
    const chooserHeader = document.createElement('div');
    chooserHeader.className = 'theme-chooser-header';
    const chooserTitle = document.createElement('strong');
    chooserTitle.textContent = 'Choose a theme';
    const chooserClose = barButton('Close', () => endPreview());
    chooserHeader.append(chooserTitle, chooserClose);
    chooser.append(chooserHeader, themeGallery.element);

    const modeRow = document.createElement('div');
    modeRow.className = 'theme-default-row';
    const modeLabel = document.createElement('span');
    modeLabel.className = 'theme-default-label';
    modeLabel.textContent = 'Default';
    const modeToggle = document.createElement('div');
    modeToggle.className = 'theme-mode-toggle theme-default-mode';
    modeToggle.setAttribute('role', 'group');
    modeToggle.setAttribute('aria-label', 'Deck default appearance');
    modeButtons = new Map();
    for (const [value, label] of [['light', 'Light'], ['dark', 'Dark']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'theme-mode-option';
      button.textContent = label;
      button.addEventListener('click', () => {
        if (draft) return;
        themeGallery?.setMode(value);
      });
      modeButtons.set(value, button);
      modeToggle.appendChild(button);
    }
    const editTheme = barButton('Edit…', () => (draft ? cancelDraft() : openDraft()));
    editTheme.classList.add('theme-edit-button');
    modeRow.append(modeLabel, modeToggle, editTheme);
    modeLine = hintLine('', 'theme-mode-line');

    themeEditor = document.createElement('section');
    themeEditor.className = 'theme-inline-editor';
    themeEditor.hidden = true;

    mastersHost = document.createElement('div');
    mastersHost.className = 'layout-popover-grid design-masters';
    const mastersRow = document.createElement('div');
    mastersRow.className = 'theme-default-row design-masters-row';
    const mastersNote = hintLine('Changes here affect new slides only.');
    mastersNote.style.margin = '0';
    const editLayouts = barButton('Edit layouts…', () => deps.onEditLayouts?.(effectiveTarget()));
    mastersRow.append(mastersNote, editLayouts);

    const wearsSection = panelSection('This deck wears', 'theme-current-section');
    wearsSection.append(activeThemeHost, chooser, modeRow, modeLine, themeEditor, mastersHost, mastersRow);

    /* --- apply to existing slides --- */
    const controls = document.createElement('div');
    controls.className = 'theme-adoption-controls design-apply-controls';

    const scopeLabel = document.createElement('label');
    scopeLabel.className = 'field';
    const scopeTitle = document.createElement('span');
    scopeTitle.textContent = 'Scope';
    const scopeSelect = document.createElement('select');
    themeScopeSelect = scopeSelect;
    for (const [value, label] of [
      ['slides', 'Selected slides'],
      ['deck', 'Whole deck'],
      ['selection', 'Selected objects only'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      scopeSelect.appendChild(option);
    }
    scopeSelect.value = scope;
    scopeSelect.addEventListener('change', () => {
      scope = scopeSelect.value as DesignScope;
      syncScope(store.get().slideSelection.size);
    });
    scopeLabel.append(scopeTitle, scopeSelect);

    const groupBoxes: Array<[keyof ApplyGroups, string, string]> = [
      ['typography', 'Typography', 'family, weight'],
      ['typeScale', 'Type scale', 'size, spacing'],
      ['colour', 'Colour', 'text, shapes, background'],
      ['layout', 'Position and size', 'put slides on'],
    ];
    const groupEls: HTMLElement[] = [];
    for (const [key, label, sub] of groupBoxes) {
      const box = optionBox(label, groups[key], sub);
      box.input.dataset.group = key;
      box.input.addEventListener('change', () => {
        groups[key] = box.input.checked;
        syncLayoutRow();
        renderMasters(true);
        renderReadout();
      });
      groupEls.push(box.label);
      if (key === 'layout') {
        layoutRow = document.createElement('div');
        layoutRow.className = 'field design-layout-target';
        layoutSelect = document.createElement('select');
        layoutSelect.setAttribute('aria-label', 'Layout to put slides on');
        for (const layout of FIXED_LAYOUTS) {
          const option = document.createElement('option');
          option.value = layout;
          option.textContent = layout === 'freeform' ? 'Freeform (release boxes)' : layoutName(layout);
          layoutSelect.appendChild(option);
        }
        layoutSelect.value = effectiveTarget();
        layoutSelect.addEventListener('change', () => {
          targetLayout = layoutSelect!.value as FixedLayout;
          renderMasters(true);
          renderReadout();
        });
        layoutRow.appendChild(layoutSelect);
        layoutRow.hidden = !groups.layout;
        groupEls.push(layoutRow);
      }
    }
    const detect = optionBox('Detect roles for untagged text', groups.detectRoles, 'needed to place imports');
    detect.input.dataset.group = 'detectRoles';
    detect.input.addEventListener('change', () => {
      groups.detectRoles = detect.input.checked;
      renderReadout();
    });
    groupEls.push(detect.label);

    // Heading rides along with Title: headings are what imports and agents tag,
    // not a role authors pick, so it gets no box of its own.
    const optionsRow = document.createElement('div');
    optionsRow.className = 'theme-default-row design-options-row';
    const rolesLine = hintLine('', 'design-roles-line');
    rolesLine.style.margin = '0';
    const syncRolesLine = (): void => {
      const shown = (['title', 'body', 'caption'] as const).filter((role) => roles.includes(role));
      rolesLine.textContent = `Roles: ${shown.length ? shown.join(', ') : 'none'}`;
    };
    syncRolesLine();
    const moreOptions = document.createElement('div');
    moreOptions.className = 'design-more-options';
    moreOptions.hidden = true;
    moreOptions.appendChild(groupLabel('Text roles'));
    for (const role of ['title', 'body', 'caption'] as const) {
      const box = optionBox(role[0].toUpperCase() + role.slice(1), roles.includes(role));
      box.input.addEventListener('change', () => {
        const covered: ThemeTextRole[] = role === 'title' ? ['title', 'heading'] : [role];
        roles = box.input.checked
          ? [...new Set([...roles, ...covered])]
          : roles.filter((candidate) => !covered.includes(candidate));
        syncRolesLine();
        renderReadout();
      });
      moreOptions.appendChild(box.label);
    }
    const toggleOptions = barButton('Options…', () => {
      moreOptions.hidden = !moreOptions.hidden;
      toggleOptions.textContent = moreOptions.hidden ? 'Options…' : 'Fewer options';
    });
    optionsRow.append(rolesLine, toggleOptions);

    controls.append(scopeLabel, ...groupEls);

    readoutHost = document.createElement('div');
    readoutHost.className = 'design-readout-list';

    const applyAction = document.createElement('div');
    applyAction.className = 'theme-apply-action';
    themeApplyButton = barButton('Apply', applyNow);
    themeApplyButton.className = 'primary panel-action design-apply-button';
    themeApplyButton.addEventListener('mouseenter', () => previewApply());
    themeApplyButton.addEventListener('mouseleave', clearPreview);
    applyAction.append(themeApplyButton);
    const applyHint = hintLine('Hover Apply to preview on the current slide.', 'design-apply-hint');

    const applySection = panelSection('Apply to existing slides', 'theme-apply-section');
    applySection.append(controls, optionsRow, moreOptions, readoutHost, applyAction, applyHint);

    wrap.append(intro, wearsSection, applySection);
    refreshPreviousBadge();
    renderActiveTheme();
    renderMasters(true);
    renderReadout();
    return wrap;
  }

  /* --- staged theme editor --- */

  function openDraft(): void {
    if (!themeEditor) return;
    const deck = store.get().deck;
    const pool = deckThemes(deck);
    const base = themeById(selectedThemeId, pool) ?? themeById(deck.themePreset, pool) ?? THEMES[0];
    draft = {
      style: structuredClone(deck.themeStyle ?? themeStyleOf(base)),
      base,
    };
    endPreview();
    renderDraftEditor();
    themeEditor.hidden = false;
    previewDraft();
  }

  function previewDraft(): void {
    deps.onPreviewThemeDraft?.(draft ? presetFromStyle(draft.style, draft.base) : null);
    renderActiveTheme();
    renderMasters(true);
  }

  function cancelDraft(): void {
    draft = null;
    if (themeEditor) themeEditor.hidden = true;
    deps.onPreviewThemeDraft?.(null);
    notifyThemePreview();
  }

  function finishDraft(): void {
    if (!draft) return;
    const { style, base } = draft;
    const deck = store.get().deck;
    const changed = JSON.stringify(style) !== JSON.stringify(deck.themeStyle ?? themeStyleOf(base));
    draft = null;
    if (themeEditor) themeEditor.hidden = true;
    deps.onPreviewThemeDraft?.(null);
    if (changed) {
      store.commit((target) => {
        // A default changes for new slides and the next Apply; slides already
        // on the stylesheet are pinned where they are (installThemeStyle).
        installThemeStyle(target, style, base.id, { slides: new Set(), elements: new Set() });
        selectedThemeId = base.id;
      }, { label: `Edit theme ${base.name}` });
      refreshThemeCss();
      themeGallery?.setSelected(store.get().deck.themePreset);
      themeGallery?.setInstalled(store.get().deck.themePreset);
      void save();
      setStatusMessage(`Edited “${base.name}”. New slides use it; existing slides follow after Apply.`);
    }
    notifyThemePreview();
  }

  function renderDraftEditor(): void {
    if (!themeEditor || !draft) return;
    const { style, base } = draft;
    const mutate = (change: (style: ThemeStyle) => void): void => {
      if (!draft) return;
      change(draft.style);
      previewDraft();
    };
    themeEditor.replaceChildren();
    themeEditor.appendChild(groupLabel(`Editing ${base.name.replace(' · Modified', '')}`));
    themeEditor.appendChild(hintLine(
      'Edits change deck defaults and new slides. Existing slides follow after Apply. The canvas previews the draft.',
    ));

    const ROLE_LABELS: Record<'title' | 'body' | 'caption', string> = {
      title: 'Title', body: 'Body', caption: 'Caption',
    };
    themeEditor.appendChild(groupLabel('Typefaces'));
    for (const role of ['title', 'body', 'caption'] as const) {
      themeEditor.appendChild(fontFamilyField(
        `${ROLE_LABELS[role]} typeface`,
        style.fonts[role].family,
        (family) => {
          if (family) mutate((target) => { target.fonts[role].family = family; });
        },
      ));
    }
    themeEditor.appendChild(groupLabel('Type scale'));
    for (const role of ['title', 'body', 'caption'] as const) {
      const sizeField = numberField(
        `${ROLE_LABELS[role]} size`,
        style.fonts[role].size,
        (value) => {
          const size = Math.round(Math.max(6, Math.min(400, value)) * 10) / 10;
          mutate((target) => { target.fonts[role].size = size; });
        },
      );
      sizeField.classList.add('theme-role-size');
      sizeField.querySelector('input')!.title = 'Value in px';
      themeEditor.appendChild(sizeField);
    }

    themeEditor.appendChild(groupLabel('Semantic colours'));
    for (const [key, label] of [
      ['background', 'Background'],
      ['text', 'Text'],
      ['muted', 'Muted text'],
      ['accent', 'Accent'],
    ] as const) {
      themeEditor.appendChild(colorField(label, style.colors[key], (value) => {
        if (value) mutate((target) => { target.colors[key] = value; });
      }));
    }

    themeEditor.appendChild(groupLabel('Palette swatches'));
    style.palette.forEach((color, index) => {
      themeEditor!.appendChild(colorField(`Swatch ${index + 1}`, color, (value) => {
        if (value) mutate((target) => { target.palette[index] = value; });
      }));
    });

    const resetRow = document.createElement('div');
    resetRow.className = 'theme-editor-actions';
    resetRow.append(barButton(`Reset to ${base.name.replace(' · Modified', '')}`, () => {
      if (!draft) return;
      draft.style = themeStyleOf(base);
      renderDraftEditor();
      previewDraft();
    }));
    const actions = document.createElement('div');
    actions.className = 'theme-editor-actions';
    actions.append(
      barButton('Cancel', cancelDraft),
      barButton('Done', finishDraft, 'primary'),
    );
    themeEditor.append(resetRow, actions);
  }

  function syncScope(slideSelectionCount: number): void {
    const multiple = slideSelectionCount > 1;
    const objectScope = themeScopeSelect?.querySelector<HTMLOptionElement>('option[value="selection"]');
    if (objectScope) objectScope.disabled = multiple;
    if (multiple && !hadMultipleSlidesSelected) {
      scope = 'slides';
      if (themeScopeSelect) themeScopeSelect.value = 'slides';
    }
    hadMultipleSlidesSelected = multiple;
    renderMasters();
    renderReadout();
  }

  const element = build();
  // The readout is a dry run over live deck state, so it follows the deck.
  store.subscribe(() => {
    if (draft) return;
    renderMasters();
    renderReadout();
  });
  return {
    element,
    currentTheme,
    refreshSwatches,
    syncScope,
    applyButtonLabel,
    dismiss: () => {
      const wasOpen = themePreviewOpen
        || Boolean(chooser && !chooser.hidden)
        || Boolean(draft);
      if (draft) cancelDraft();
      endPreview();
      return wasOpen;
    },
    noteDeckOpened: (deck) => {
      if (draft) cancelDraft();
      // A deck with presets of its own (or a different current theme, which
      // can unhide a card) gets a gallery listing them.
      const offered = availableThemes(deck, chosenPresetId(deck)).map((theme) => theme.id).join('\n');
      if (themeGallery && offered !== offeredThemeIds) {
        const stale = themeGallery.element;
        themeGallery = buildGallery(deck);
        stale.replaceWith(themeGallery.element);
      }
      // The chosen theme decides which card is selected; only an installed one
      // wears the "Current" badge, and a deck can have the first without the second.
      themeGallery?.setSelected(chosenPresetId(deck));
      themeGallery?.setInstalled(deck.themePreset);
      themeGallery?.setPrevious(previousThemeUsed(deck, chosenPresetId(deck)));
      selectedThemeId = chosenPresetId(deck) ?? themeGallery?.selectedId() ?? null;
      targetLayout = 'standard';
      if (layoutSelect) layoutSelect.value = targetLayout;
      refreshSwatches();
      renderActiveTheme();
      renderMasters(true);
      renderReadout();
    },
  };
}
