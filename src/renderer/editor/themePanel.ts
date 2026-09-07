import type { Deck, ThemeStyle } from '@shared/deck.js';
import { realignSlideToLayout } from '@shared/layoutMasters.js';
import {
  THEMES,
  deckThemes,
  type ThemeAdoption,
  type ThemePreset,
  adoptThemeStyles,
  baseThemeId,
  deckTheme,
  presetFromStyle,
  previousThemeUsed,
  themeById,
  themeStyleOf,
  themeStyleCss,
  themeStyleLabel,
  withThemeBlock,
  chooseDeckTheme,
  installThemeStyle,
  type ThemeTextRole,
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
import { numberField } from './inspector.js';

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
 * unusable here as a shipped one, and hiding it beats showing a card that
 * previews as a fallback face.
 */
function availableThemes(deck: Deck, currentPresetId: string | null): ThemePreset[] {
  const pool = deckThemes(deck);
  const currentBase = baseThemeId(currentPresetId, pool);
  return pool.filter((theme) =>
    theme.id === currentBase
    || (stackAvailable(theme.fonts.title.family) && stackAvailable(theme.fonts.body.family)));
}
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
  /**
   * Drive the read-only central Theme × Layout preview. `null` ends the
   * session and returns the canvas to the deck itself.
   */
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
  /** Label of the Apply layout button; follows the same scope as Apply theme. */
  layoutApplyButtonLabel(): string;
  /** Close the theme chooser/editor and end its central preview session. */
  dismiss(): boolean;
}

export function createThemePanel(deps: ThemePanelDeps): ThemePanel {
  const { store, cssEditor, save, setStatusMessage } = deps;

  const themeAdoption: ThemeAdoption = {
    scope: 'slides',
    roles: ['title', 'heading', 'body', 'caption'],
    fontFamily: true,
    // A family and the weight it is set in are one decision. With this off by
    // default, switching a deck from a bold grotesk to Colloquium's condensed
    // medium left every title at 700: the new face, the old weight, and a
    // theme card that no longer described the slides it had just restyled.
    fontWeight: true,
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
  let layoutApplyButton: HTMLButtonElement | null = null;
  let activeThemeHost: HTMLElement | null = null;
  let chooser: HTMLElement | null = null;
  let themeEditor: HTMLElement | null = null;
  let layoutPreviewHost: HTMLElement | null = null;
  let themePreviewOpen = false;
  let hadMultipleSlidesSelected = false;

  function currentTheme(): ThemePreset | null {
    const deck = store.get().deck;
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
    card.badge.hidden = selectedThemeId !== store.get().deck.themePreset;
    card.badge.textContent = selectedThemeId === store.get().deck.themePreset ? 'Current' : 'Preview';
    card.element.classList.add('selected', 'theme-active-card');
    card.element.setAttribute('aria-expanded', String(chooser ? !chooser.hidden : false));
    activeThemeHost.appendChild(card.element);
  }

  /**
   * Leave the chooser and its preview.
   *
   * Closing the picker is the author saying "show me the deck again": the
   * central Theme × Layout preview is scaffolding for choosing, and leaving it
   * up meant the canvas kept showing sample slides after the choice was made.
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
    renderLayoutPreview();
    if (themePreviewOpen) deps.onThemePreview?.(theme);
  }

  function renderLayoutPreview(): void {
    if (!layoutPreviewHost) return;
    layoutPreviewHost.replaceChildren();
    const preview = deps.createLayoutPreview?.(currentTheme(), () => deps.onEditLayouts?.());
    if (preview) layoutPreviewHost.appendChild(preview);
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
   * Record the chosen theme as the deck's current one.
   *
   * Existing slides are left exactly as they are — restyling them is what the
   * Apply control above is for — but slides created from here on are born
   * wearing this theme, so the choice has to outlive the panel and the session.
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
      + 'styling — use “Apply theme…” above to restyle them.',
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

  function optionBox(text: string, checked: boolean): { label: HTMLElement; input: HTMLInputElement } {
    const label = document.createElement('label');
    label.className = 'field field-check';
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

  /**
   * Apply layout shares Apply theme's scope: it is the same question, asked of
   * geometry instead of styling. Objects are not a layout scope, so "selected
   * objects" means the slide those objects sit on.
   */
  function layoutApplyButtonLabel(): string {
    const count = store.get().slideSelection.size;
    return themeAdoption.scope === 'deck'
      ? 'Apply layout to deck'
      : themeAdoption.scope === 'slides'
        ? `Apply layout to ${count} selected slide${count === 1 ? '' : 's'}`
        : 'Apply layout to current slide';
  }

  /**
   * Re-align every in-scope slide's text boxes to its own layout master.
   * Nothing about the slide's look changes: this is for boxes that were
   * nudged, resized or imported off-grid and should sit where the layout says.
   */
  function applyLayout(): void {
    const { deck, slideIndex, slideSelection } = store.get();
    const ids = new Set<string>(themeAdoption.scope === 'deck'
      ? deck.slides.map((slide) => slide.id)
      : themeAdoption.scope === 'slides' && slideSelection.size > 0
        ? slideSelection
        : [deck.slides[slideIndex]?.id].filter((id): id is string => Boolean(id)));
    let moved = 0;
    let freeform = 0;
    store.commit((target) => {
      for (const slide of target.slides) {
        if (!ids.has(slide.id)) continue;
        if ((slide.layout ?? 'freeform') === 'freeform') { freeform += 1; continue; }
        moved += realignSlideToLayout(slide, target.layoutMasters);
      }
    }, { label: 'Apply layout' });
    void save();
    const scopeName = themeAdoption.scope === 'deck'
      ? 'the deck'
      : ids.size === 1 ? 'the current slide' : `${ids.size} selected slides`;
    setStatusMessage(moved === 0
      ? (freeform === ids.size
        ? `Nothing to align: ${scopeName} uses the freeform layout.`
        : `No text boxes to align on ${scopeName}.`)
      : `Re-aligned ${moved} text box${moved === 1 ? '' : 'es'} to the layout on ${scopeName}.`);
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

  /** The ids the gallery currently offers, to tell when a deck needs a new one. */
  let offeredThemeIds = '';

  /**
   * A gallery for this deck's menu of themes.
   *
   * The menu is per deck, not per session: a deck carries its own presets, and
   * the panel is built once, before any deck is open, against the shell's
   * empty placeholder. Building the gallery from that deck alone meant a deck
   * theme created by `slide-agent theme create` was applied fine but never
   * offered — the card simply was not there. `noteDeckOpened` rebuilds the
   * gallery whenever the menu it would show differs from the one on screen.
   */
  function buildGallery(deck: Deck): ThemeGallery {
    const preset = chosenPresetId(deck);
    const themes = availableThemes(deck, preset);
    offeredThemeIds = themes.map((theme) => theme.id).join('\n');
    return createThemeGallery(themes, preset, (theme, source) => {
      selectedThemeId = theme.id;
      chooseTheme(theme);
      // Picking a card is a decision and closes the picker; flipping the
      // Light/Dark switch is still browsing, so the gallery stays open and only
      // the preview follows the theme to the other side of the room.
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
    const chooserClose = barButton('Close', () => endPreview());
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

    // Heading rides along with Title: headings are what imports and agents tag,
    // not a role authors pick, so it gets no box of its own.
    const roleTitle = groupLabel('Text roles');
    const roleBoxes = (['title', 'body', 'caption'] as const).map((role) => {
      const box = optionBox(role[0].toUpperCase() + role.slice(1), themeAdoption.roles.includes(role));
      box.input.addEventListener('change', () => {
        const covered: ThemeAdoption['roles'] = role === 'title' ? ['title', 'heading'] : [role];
        themeAdoption.roles = box.input.checked
          ? [...new Set([...themeAdoption.roles, ...covered])]
          : themeAdoption.roles.filter((candidate) => !covered.includes(candidate));
      });
      return box.label;
    });

    const propertyTitle = groupLabel('Properties from theme');
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
    applyAction.className = 'theme-apply-action';
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
      // Every scope installs what it adopted (see adoptThemeStyles), so the
      // stylesheet the slides load has to follow the deck's defaults each time.
      if (store.get().deck.themeStyle) refreshThemeCss();
      refreshSwatches();
      themeGallery?.setInstalled(store.get().deck.themePreset);
      selectedThemeId = store.get().deck.themePreset;
      void save();
      refreshPreviousBadge();
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

    const editTheme = barButton('Edit theme…', () => toggleThemeEditor());
    editTheme.classList.add('theme-section-action');
    themeEditor = document.createElement('section');
    themeEditor.className = 'theme-inline-editor';
    themeEditor.hidden = true;
    const themeSection = panelSection('Current theme', 'theme-current-section');
    themeSection.append(activeThemeHost, chooser, themeEditor, editTheme);

    const applySection = panelSection('Apply theme', 'theme-apply-section');
    applySection.append(controls, applyAction);

    layoutPreviewHost = document.createElement('div');
    layoutPreviewHost.className = 'theme-layout-preview-host';
    const layoutsSection = panelSection('Layouts', 'layouts-section');
    layoutsSection.append(layoutPreviewHost);

    // Apply theme's geometric twin: a heading and one button, no options.
    const layoutApplyAction = document.createElement('div');
    layoutApplyAction.className = 'theme-apply-action';
    layoutApplyButton = barButton(layoutApplyButtonLabel(), applyLayout, 'primary panel-action');
    layoutApplyAction.append(layoutApplyButton);
    const layoutApplySection = panelSection('Apply layout', 'layout-apply-section');
    layoutApplySection.append(layoutApplyAction);

    // Which theme the deck wears comes first; what to do with it second. The
    // old order asked you to configure an adoption before showing you what you
    // were adopting.
    wrap.append(intro, themeSection, applySection, layoutsSection, layoutApplySection);
    refreshPreviousBadge();
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
    themeEditor.appendChild(groupLabel(`Edit ${theme.name.replace(' · Modified', '')}`));

    const update = (mutate: (style: ThemeStyle) => void, label: string): void => {
      store.commit((deck) => {
        const pool = deckThemes(deck);
        const base = themeById(selectedThemeId, pool) ?? themeById(deck.themePreset, pool) ?? THEMES[0];
        const style = structuredClone(deck.themeStyle ?? themeStyleOf(base));
        mutate(style);
        // A default changes for new slides and the next Apply; slides already
        // on the stylesheet are pinned where they are (installThemeStyle).
        installThemeStyle(deck, style, base.id, { slides: new Set(), elements: new Set() });
        selectedThemeId = base.id;
      }, { label });
      refreshThemeCss();
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

    // The deck's default size per role. Editing it changes what new slides
    // are born with and what Apply installs; existing slides keep the size
    // they have (setThemeRoleSize pins the ones that were following theme.css).
    themeEditor.appendChild(groupLabel('Type scale'));
    const ROLE_LABELS: Record<Exclude<ThemeTextRole, 'base' | 'heading'>, string> = {
      title: 'Title', body: 'Body', caption: 'Caption',
    };
    for (const role of ['title', 'body', 'caption'] as const) {
      const sizeField = numberField(
        `${ROLE_LABELS[role]} size`,
        theme.fonts[role].size,
        (value) => {
          const size = Math.round(Math.max(6, Math.min(400, value)) * 10) / 10;
          update((style) => { style.fonts[role].size = size; }, `Set theme ${role} size`);
        },
      );
      sizeField.classList.add('theme-role-size');
      sizeField.querySelector('input')!.title = 'Value in px';
      themeEditor.appendChild(sizeField);
    }
    const scaleHint = document.createElement('p');
    scaleHint.className = 'insp-hint theme-scale-hint';
    scaleHint.textContent = 'Sizes for new slides. Existing slides keep theirs until you apply the theme to them.';
    themeEditor.appendChild(scaleHint);

    themeEditor.appendChild(groupLabel('Semantic colours'));
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

    themeEditor.appendChild(groupLabel('Palette swatches'));
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
    if (layoutApplyButton) layoutApplyButton.textContent = layoutApplyButtonLabel();
  }

  const element = build();
  return {
    element,
    currentTheme,
    refreshSwatches,
    syncScope,
    applyButtonLabel,
    layoutApplyButtonLabel,
    dismiss: () => {
      const wasOpen = themePreviewOpen
        || Boolean(chooser && !chooser.hidden)
        || Boolean(themeEditor && !themeEditor.hidden);
      if (themeEditor) themeEditor.hidden = true;
      endPreview();
      return wasOpen;
    },
    noteDeckOpened: (deck) => {
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
      refreshSwatches();
      renderActiveTheme();
      renderLayoutPreview();
    },
  };
}
