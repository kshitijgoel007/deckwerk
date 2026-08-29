import type { Deck, ThemeStyle } from '@shared/deck.js';
import {
  THEMES,
  type ThemeAdoption,
  type ThemePreset,
  adoptThemeStyles,
  themeById,
  themeStyleOf,
  themeStyleCss,
  withThemeBlock,
} from '@shared/themes.js';
import type { CssEditor } from './cssEditor.js';
import { barButton } from './shellWiring.js';
import type { EditorStore } from './store.js';
import {
  createThemeGallery,
  createThemePreviewCard,
  type ThemeGallery,
} from './themeGallery.js';
import { fontFamilyField } from './fontPicker.js';
import { colorField } from './colorPicker.js';

/**
 * The Theme sidebar tab: preset gallery plus the adoption controls. Extracted
 * from the Electron shell so the browser collab shell shows the identical
 * panel. Theme presets are immutable style sources — one explicit operation
 * chooses scope, semantic roles and independent properties; selecting a card
 * alone is always side-effect-free.
 */

export interface ThemePanelDeps {
  store: EditorStore;
  cssEditor: CssEditor;
  save: () => Promise<void> | void;
  setStatusMessage: (text: string) => void;
  /** Persist theme.css; the shells route this to disk or the collab server. */
  saveThemeCss: (css: string) => void;
  /** Drive the read-only central Theme × Layout preview. */
  onThemePreview?: (theme: ThemePreset | null) => void;
  /** Enter the explicit editor for the fixed layout masters. */
  onEditLayouts?: () => void;
  /** Render the compact Title + Body master entry for the Layouts section. */
  createLayoutPreview?: (theme: ThemePreset | null, onActivate: () => void) => HTMLElement;
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

export function createThemePanel(deps: ThemePanelDeps): ThemePanel {
  const { store, cssEditor, save, setStatusMessage } = deps;

  const themeAdoption: ThemeAdoption = {
    scope: 'slides',
    roles: ['title', 'body', 'caption'],
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
  let themeScopeSelect: HTMLSelectElement | null = null;
  let themeApplyButton: HTMLButtonElement | null = null;
  let activeThemeHost: HTMLElement | null = null;
  let chooser: HTMLElement | null = null;
  let themeEditor: HTMLElement | null = null;
  let layoutPreviewHost: HTMLElement | null = null;
  let themePreviewOpen = false;
  let hadMultipleSlidesSelected = false;

  function currentTheme(): ThemePreset | null {
    const deck = store.get().deck;
    const preset = themeById(selectedThemeId) ?? themeById(deck.themePreset);
    if (!preset) return null;
    if (selectedThemeId === deck.themePreset && deck.themeStyle) {
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
      themePreviewOpen = true;
      deps.onThemePreview?.(theme);
      if (chooser) chooser.hidden = !chooser.hidden;
      renderActiveTheme();
    });
    card.badge.hidden = selectedThemeId !== store.get().deck.themePreset;
    card.badge.textContent = selectedThemeId === store.get().deck.themePreset ? 'Current' : 'Preview';
    card.element.classList.add('selected', 'theme-active-card');
    card.element.setAttribute('aria-expanded', String(chooser ? !chooser.hidden : false));
    activeThemeHost.appendChild(card.element);
  }

  function notifyThemePreview(): void {
    const theme = currentTheme();
    renderActiveTheme();
    refreshSwatches();
    renderLayoutPreview();
    if (themePreviewOpen) deps.onThemePreview?.(theme);
  }

  function renderLayoutPreview(): void {
    if (!layoutPreviewHost) return;
    layoutPreviewHost.replaceChildren();
    const preview = deps.createLayoutPreview?.(currentTheme(), () => deps.onEditLayouts?.());
    if (preview) layoutPreviewHost.appendChild(preview);
  }

  function refreshThemeCss(label: string): void {
    const style = store.get().deck.themeStyle;
    if (!style) return;
    const css = withThemeBlock(cssEditor.getValue(), themeStyleCss(style, label));
    cssEditor.setValue(css);
    deps.saveThemeCss(css);
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

  function applyButtonLabel(): string {
    const count = store.get().slideSelection.size;
    return themeAdoption.scope === 'deck'
      ? 'Apply theme to deck'
      : themeAdoption.scope === 'slides'
        ? `Apply theme to ${count} selected slide${count === 1 ? '' : 's'}`
        : themeAdoption.scope === 'selection'
          ? 'Apply theme to selected objects'
          : 'Apply theme to current slide';
  }

  function build(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'theme-browser';

    const preset = store.get().deck.themePreset;
    themeGallery = createThemeGallery(THEMES, preset, (theme) => {
      selectedThemeId = theme.id;
      if (chooser) chooser.hidden = true;
      notifyThemePreview();
    });
    selectedThemeId = themeGallery.selectedId();

    const intro = document.createElement('div');
    intro.className = 'theme-browser-intro';
    const title = document.createElement('h2');
    title.textContent = 'Theme';
    intro.append(title);

    activeThemeHost = document.createElement('div');
    activeThemeHost.className = 'theme-active-host';

    chooser = document.createElement('section');
    chooser.className = 'theme-chooser';
    chooser.hidden = true;
    const chooserHeader = document.createElement('div');
    chooserHeader.className = 'theme-chooser-header';
    const chooserTitle = document.createElement('strong');
    chooserTitle.textContent = 'Choose a theme';
    const chooserClose = barButton('Close', () => {
      if (chooser) chooser.hidden = true;
      renderActiveTheme();
    });
    chooserHeader.append(chooserTitle, chooserClose);
    chooser.append(chooserHeader, themeGallery.element);

    const controls = document.createElement('div');
    controls.className = 'theme-adoption-controls';

    const scopeLabel = document.createElement('label');
    scopeLabel.className = 'field';
    const scopeTitle = document.createElement('span');
    scopeTitle.textContent = 'Apply to';
    const scope = document.createElement('select');
    themeScopeSelect = scope;
    for (const [value, label] of [
      ['deck', 'Deck defaults + all slides'],
      ['slides', 'Selected slides'],
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
      syncScope(store.get().slideSelection.size);
    });
    scopeLabel.append(scopeTitle, scope);

    const roleTitle = document.createElement('div');
    roleTitle.className = 'theme-option-title';
    roleTitle.textContent = 'Text roles';
    const roleBoxes = (['title', 'body', 'caption'] as const).map((role) => {
      const box = optionBox(role[0].toUpperCase() + role.slice(1), themeAdoption.roles.includes(role));
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

    const applyAction = document.createElement('div');
    applyAction.className = 'theme-actions theme-apply-action';
    themeApplyButton = barButton('Apply theme to selected slides', () => {
      const theme = currentTheme();
      if (!theme) return;
      const { slideIndex, slideSelection, selection } = store.get();
      store.commit((deck) => adoptThemeStyles(
        deck,
        theme,
        { ...themeAdoption, roles: [...themeAdoption.roles] },
        slideIndex,
        new Set(selection),
        new Set(slideSelection),
      ));
      if (themeAdoption.scope === 'deck') refreshThemeCss(theme.name);
      refreshSwatches();
      if (themeAdoption.scope === 'deck') themeGallery?.setInstalled(theme.id);
      if (themeAdoption.scope === 'deck') selectedThemeId = theme.id;
      void save();
      notifyThemePreview();
      const scopeName = themeAdoption.scope === 'deck'
        ? 'deck defaults and existing slides'
        : themeAdoption.scope === 'slides'
          ? `${slideSelection.size} selected slide${slideSelection.size === 1 ? '' : 's'}`
          : themeAdoption.scope === 'slide' ? 'current slide' : 'selection';
      setStatusMessage(`Used selected “${theme.name}” styles for ${scopeName}.`);
    });
    themeApplyButton.className = 'primary panel-action';
    applyAction.append(themeApplyButton);
    const themeSection = document.createElement('section');
    themeSection.className = 'theme-panel-section';
    const themeSectionTitle = document.createElement('div');
    themeSectionTitle.className = 'theme-option-title';
    themeSectionTitle.textContent = 'Current theme';
    const editTheme = barButton('Edit theme…', () => toggleThemeEditor());
    editTheme.classList.add('theme-section-action');

    const layoutsSection = document.createElement('section');
    layoutsSection.className = 'theme-panel-section layouts-section';
    const layoutsTitle = document.createElement('h3');
    layoutsTitle.textContent = 'Layouts';
    layoutPreviewHost = document.createElement('div');
    layoutPreviewHost.className = 'theme-layout-preview-host';
    themeEditor = document.createElement('section');
    themeEditor.className = 'theme-inline-editor';
    themeEditor.hidden = true;
    themeSection.append(themeSectionTitle, activeThemeHost, chooser, themeEditor, editTheme);
    layoutsSection.append(layoutsTitle, layoutPreviewHost);
    wrap.append(intro, controls, applyAction, themeSection, layoutsSection);
    renderActiveTheme();
    renderLayoutPreview();
    return wrap;
  }

  function toggleThemeEditor(): void {
    if (!themeEditor) return;
    if (!themeEditor.hidden) {
      themeEditor.hidden = true;
      return;
    }
    const theme = currentTheme();
    if (!theme) return;
    themeEditor.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'theme-option-title';
    heading.textContent = `Edit ${theme.name.replace(' · Modified', '')}`;
    themeEditor.appendChild(heading);

    const update = (mutate: (style: ThemeStyle) => void, label: string): void => {
      store.commit((deck) => {
        const base = themeById(selectedThemeId) ?? themeById(deck.themePreset) ?? THEMES[0];
        const style = structuredClone(deck.themeStyle ?? themeStyleOf(base));
        mutate(style);
        deck.themeStyle = style;
        deck.themePreset = base.id;
        selectedThemeId = base.id;
      }, { label });
      const installed = themeById(store.get().deck.themePreset);
      refreshThemeCss(`${installed?.name ?? 'Theme'} · Modified`);
      themeGallery?.setSelected(store.get().deck.themePreset);
      themeGallery?.setInstalled(store.get().deck.themePreset);
      void save();
      notifyThemePreview();
    };

    for (const role of ['title', 'body', 'caption'] as const) {
      themeEditor.appendChild(fontFamilyField(
        `${role[0].toUpperCase()}${role.slice(1)} typeface`,
        theme.fonts[role].family,
        (family) => {
          if (family) update((style) => { style.fonts[role].family = family; }, `Set theme ${role} typeface`);
        },
      ));
    }

    const semanticTitle = document.createElement('div');
    semanticTitle.className = 'theme-option-title';
    semanticTitle.textContent = 'Semantic colours';
    themeEditor.appendChild(semanticTitle);
    for (const [key, label] of [
      ['background', 'Background'],
      ['text', 'Text'],
      ['muted', 'Muted text'],
      ['accent', 'Accent'],
    ] as const) {
      themeEditor.appendChild(colorField(label, theme.colors[key], (value) => {
        if (value) update((style) => { style.colors[key] = value; }, `Set theme ${label.toLowerCase()}`);
      }));
    }

    const paletteTitle = document.createElement('div');
    paletteTitle.className = 'theme-option-title';
    paletteTitle.textContent = 'Palette swatches';
    themeEditor.appendChild(paletteTitle);
    theme.palette.forEach((color, index) => {
      themeEditor!.appendChild(colorField(`Swatch ${index + 1}`, color, (value) => {
        if (value) update((style) => { style.palette[index] = value; }, `Edit theme swatch ${index + 1}`);
      }));
    });
    const done = barButton('Done editing theme', () => {
      if (themeEditor) themeEditor.hidden = true;
    }, 'primary panel-action');
    themeEditor.appendChild(done);
    themeEditor.hidden = false;
  }

  function syncScope(slideSelectionCount: number): void {
    const multiple = slideSelectionCount > 1;
    const objectScope = themeScopeSelect?.querySelector<HTMLOptionElement>('option[value="selection"]');
    if (objectScope) objectScope.disabled = multiple;
    if (multiple && !hadMultipleSlidesSelected) {
      themeAdoption.scope = 'slides';
      if (themeScopeSelect) themeScopeSelect.value = 'slides';
    }
    hadMultipleSlidesSelected = multiple;
    if (themeApplyButton) themeApplyButton.textContent = applyButtonLabel();
  }

  const element = build();
  return {
    element,
    currentTheme,
    refreshSwatches,
    syncScope,
    applyButtonLabel,
    dismiss: () => {
      const wasOpen = themePreviewOpen
        || Boolean(chooser && !chooser.hidden)
        || Boolean(themeEditor && !themeEditor.hidden);
      themePreviewOpen = false;
      if (chooser) chooser.hidden = true;
      if (themeEditor) themeEditor.hidden = true;
      renderActiveTheme();
      return wasOpen;
    },
    noteDeckOpened: (deck) => {
      themeGallery?.setSelected(deck.themePreset);
      themeGallery?.setInstalled(deck.themePreset);
      selectedThemeId = themeGallery?.selectedId() ?? deck.themePreset;
      refreshSwatches();
      renderActiveTheme();
      renderLayoutPreview();
    },
  };
}

function presetFromStyle(style: ThemeStyle, base: ThemePreset): ThemePreset {
  return {
    id: base.id,
    name: `${base.name} · Modified`,
    description: base.description,
    fonts: structuredClone(style.fonts),
    palette: [...style.palette],
    colors: structuredClone(style.colors),
  };
}
