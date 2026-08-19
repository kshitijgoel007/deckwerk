import type { Deck } from '@shared/deck.js';
import {
  THEMES,
  type ThemeAdoption,
  type ThemePreset,
  adoptThemeStyles,
  themeById,
  themeStyleCss,
  withThemeBlock,
} from '@shared/themes.js';
import type { CssEditor } from './cssEditor.js';
import { barButton } from './shellWiring.js';
import type { EditorStore } from './store.js';
import { createThemeGallery, type ThemeGallery } from './themeGallery.js';

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
  let hadMultipleSlidesSelected = false;

  function currentTheme(): ThemePreset | null {
    return themeById(selectedThemeId) ?? themeById(store.get().deck.themePreset) ?? null;
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
    });
    selectedThemeId = themeGallery.selectedId();

    const intro = document.createElement('div');
    intro.className = 'theme-browser-intro';
    const title = document.createElement('h2');
    title.textContent = 'Themes';
    intro.append(title);

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

    const actions = document.createElement('div');
    actions.className = 'theme-actions';
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
      void save();
      const scopeName = themeAdoption.scope === 'deck'
        ? 'deck defaults and existing slides'
        : themeAdoption.scope === 'slides'
          ? `${slideSelection.size} selected slide${slideSelection.size === 1 ? '' : 's'}`
          : themeAdoption.scope === 'slide' ? 'current slide' : 'selection';
      setStatusMessage(`Used selected “${theme.name}” styles for ${scopeName}.`);
    });
    themeApplyButton.className = 'primary panel-action';
    actions.append(themeApplyButton);
    wrap.append(intro, controls, actions, themeGallery.element);
    return wrap;
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
    noteDeckOpened: (deck) => {
      themeGallery?.setSelected(deck.themePreset);
      themeGallery?.setInstalled(deck.themePreset);
      selectedThemeId = themeGallery?.selectedId() ?? deck.themePreset;
      refreshSwatches();
    },
  };
}
