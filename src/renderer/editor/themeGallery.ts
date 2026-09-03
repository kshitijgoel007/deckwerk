import {
  type ThemeMode,
  type ThemePreset,
  baseThemeId,
  themeById,
  themeMode,
  themeVariant,
} from '@shared/themes.js';

export interface ThemeGallery {
  element: HTMLElement;
  selectedId: () => string | null;
  setSelected: (id: string | null) => void;
  setInstalled: (id: string | null) => void;
  /** Mark the last theme this deck actually wore, other than the current one. */
  setPrevious: (id: string | null) => void;
  mode: () => ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

export interface ThemePreviewCard {
  element: HTMLButtonElement;
  /** "Current": this card is the variant the deck has installed. */
  badge: HTMLElement;
  /** "Last used": the theme the deck wore before the current one. */
  previousBadge: HTMLElement;
}

/** How a gallery selection came about, since the two read differently. */
export type ThemeSelectSource = 'card' | 'mode';

const FONT_SAMPLES: Array<{
  role: keyof ThemePreset['fonts'];
  label: string;
  copy: string;
}> = [
  { role: 'title', label: 'Title', copy: 'The big idea' },
  { role: 'body', label: 'Body', copy: 'Readable body copy for the story.' },
  { role: 'caption', label: 'Caption', copy: 'Supporting detail' },
];

/** One reusable visual theme card, used by both the compact active view and chooser. */
export function createThemePreviewCard(
  theme: ThemePreset,
  onSelect: () => void,
): ThemePreviewCard {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'theme-card';
  card.dataset.themeId = theme.id;
  card.setAttribute('aria-label', `Select ${theme.name} theme`);

  const preview = document.createElement('span');
  preview.className = 'theme-card-preview';
  preview.style.background = theme.colors.background;
  preview.style.color = theme.colors.text;

  const heading = document.createElement('span');
  heading.className = 'theme-card-heading';
  const name = document.createElement('strong');
  name.textContent = theme.name;
  const badge = document.createElement('span');
  badge.className = 'theme-installed-badge';
  badge.textContent = 'Current';
  const previousBadge = document.createElement('span');
  previousBadge.className = 'theme-installed-badge theme-previous-badge';
  previousBadge.textContent = 'Last used';
  previousBadge.hidden = true;

  const swatches = document.createElement('span');
  swatches.className = 'theme-card-swatches';
  swatches.setAttribute('aria-label', `${theme.name} colour palette`);
  for (const color of theme.palette) {
    const swatch = document.createElement('span');
    swatch.className = 'theme-card-swatch';
    swatch.style.background = color;
    swatch.title = color;
    swatches.appendChild(swatch);
  }
  heading.append(name, swatches, badge, previousBadge);

  const samples = document.createElement('span');
  samples.className = 'theme-font-samples';
  for (const sample of FONT_SAMPLES) {
    const font = theme.fonts[sample.role];
    const row = document.createElement('span');
    row.className = `theme-font-sample theme-font-${sample.role}`;
    const label = document.createElement('small');
    label.textContent = sample.label;
    const copy = document.createElement('span');
    copy.textContent = sample.copy;
    copy.style.fontFamily = font.family;
    copy.style.fontWeight = String(font.weight);
    copy.style.letterSpacing = font.letterSpacing;
    copy.style.lineHeight = String(font.lineHeight);
    if (font.color) copy.style.color = font.color;
    row.append(label, copy);
    samples.appendChild(row);
  }

  preview.append(heading, samples);
  card.appendChild(preview);
  card.addEventListener('click', onSelect);
  return { element: card, badge, previousBadge };
}

/**
 * A visual, keyboard-accessible theme list. Selecting a card does not install
 * it. A global Light/Dark switch shows every theme's counterpart in that mode
 * — the two native dark presets become light themes and vice versa — and a
 * card selected under it carries the variant id (`noir-light`), which
 * `themeById` resolves everywhere a preset id is looked up.
 */
export function createThemeGallery(
  themes: ThemePreset[],
  initialId: string | null,
  onSelect: (theme: ThemePreset, source: ThemeSelectSource) => void,
): ThemeGallery {
  const element = document.createElement('div');
  element.className = 'theme-gallery';
  const known = (id: string | null): boolean =>
    themes.some((theme) => theme.id === baseThemeId(id, themes));
  let selected = known(initialId) ? initialId : themes[0]?.id ?? null;
  let installed = initialId;
  let previous: string | null = null;
  const initialTheme = themeById(selected, themes);
  let mode: ThemeMode = initialTheme ? themeMode(initialTheme) : 'light';

  const toggle = document.createElement('div');
  toggle.className = 'theme-mode-toggle';
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Theme appearance');
  const modeButtons = new Map<ThemeMode, HTMLButtonElement>();
  for (const [value, label] of [['light', 'Light'], ['dark', 'Dark']] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-mode-option';
    button.textContent = label;
    button.addEventListener('click', () => setMode(value));
    modeButtons.set(value, button);
    toggle.appendChild(button);
  }
  const grid = document.createElement('div');
  grid.className = 'theme-gallery-grid';
  element.append(toggle, grid);

  const cards = new Map<string, HTMLButtonElement>();
  const badges = new Map<string, {
    badge: HTMLElement;
    previousBadge: HTMLElement;
    shownId: string;
  }>();

  function refresh(): void {
    for (const [value, button] of modeButtons) {
      button.classList.toggle('selected', value === mode);
      button.setAttribute('aria-pressed', String(value === mode));
    }
    for (const [baseId, card] of cards) {
      const active = baseId === baseThemeId(selected, themes);
      card.classList.toggle('selected', active);
      card.setAttribute('aria-pressed', String(active));
      const entry = badges.get(baseId)!;
      // "Current" only where it is literally true: the displayed variant is
      // the installed one, not merely the installed theme's other half.
      entry.badge.hidden = entry.shownId !== installed;
      // The deck's previous look is named exactly, variant included: pointing
      // at a card showing the other half of that theme would send the author
      // back to a look this deck has never worn.
      entry.previousBadge.hidden = !previous || entry.shownId !== previous;
    }
  }

  function rebuild(): void {
    cards.clear();
    badges.clear();
    grid.replaceChildren();
    for (const base of themes) {
      const shown = themeVariant(base, mode);
      const previewCard = createThemePreviewCard(shown, () => {
        selected = shown.id;
        refresh();
        onSelect(shown, 'card');
      });
      badges.set(base.id, {
        badge: previewCard.badge,
        previousBadge: previewCard.previousBadge,
        shownId: shown.id,
      });
      cards.set(base.id, previewCard.element);
      grid.appendChild(previewCard.element);
    }
    refresh();
  }

  /**
   * Flip the whole gallery — and the selection with it.
   *
   * The switch reads as "show me this theme in the dark", not "browse other
   * themes": leaving the selection on the light preset meant the preview kept
   * showing the side of the room you had just switched away from. The
   * counterpart is selected and reported, so the preview follows.
   */
  function setMode(next: ThemeMode): void {
    if (mode === next) return;
    mode = next;
    const base = themeById(baseThemeId(selected, themes), themes);
    const counterpart = base ? themeVariant(base, mode) : null;
    if (counterpart) selected = counterpart.id;
    rebuild();
    if (counterpart) onSelect(counterpart, 'mode');
  }

  rebuild();
  return {
    element,
    selectedId: () => selected,
    setSelected: (id) => {
      selected = known(id) ? id : themes[0]?.id ?? null;
      // A deck wearing a variant opens the picker on that side of the switch.
      const theme = themeById(selected, themes);
      if (theme && themeMode(theme) !== mode) {
        mode = themeMode(theme);
        rebuild();
        return;
      }
      refresh();
    },
    setInstalled: (id) => {
      installed = id;
      refresh();
    },
    setPrevious: (id) => {
      previous = id;
      refresh();
    },
    mode: () => mode,
    setMode,
  };
}
