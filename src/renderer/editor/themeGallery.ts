import type { ThemePreset } from '@shared/themes.js';

export interface ThemeGallery {
  element: HTMLElement;
  selectedId: () => string | null;
  setSelected: (id: string | null) => void;
  setInstalled: (id: string | null) => void;
}

export interface ThemePreviewCard {
  element: HTMLButtonElement;
  badge: HTMLElement;
}

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
  heading.append(name, swatches, badge);

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
  return { element: card, badge };
}

/** A visual, keyboard-accessible theme list. Selecting a card does not install it. */
export function createThemeGallery(
  themes: ThemePreset[],
  initialId: string | null,
  onSelect: (theme: ThemePreset) => void,
): ThemeGallery {
  const element = document.createElement('div');
  element.className = 'theme-gallery';
  let selected = themes.some((theme) => theme.id === initialId)
    ? initialId
    : themes[0]?.id ?? null;
  let installed = initialId;

  const cards = new Map<string, HTMLButtonElement>();
  const badges = new Map<string, HTMLElement>();

  function refresh(): void {
    for (const [id, card] of cards) {
      const active = id === selected;
      card.classList.toggle('selected', active);
      card.setAttribute('aria-pressed', String(active));
      badges.get(id)!.hidden = id !== installed;
    }
  }

  for (const theme of themes) {
    const previewCard = createThemePreviewCard(theme, () => {
      selected = theme.id;
      refresh();
      onSelect(theme);
    });
    const card = previewCard.element;
    const badge = previewCard.badge;
    badges.set(theme.id, badge);
    cards.set(theme.id, card);
    element.appendChild(card);
  }

  refresh();
  return {
    element,
    selectedId: () => selected,
    setSelected: (id) => {
      selected = themes.some((theme) => theme.id === id) ? id : themes[0]?.id ?? null;
      refresh();
    },
    setInstalled: (id) => {
      installed = id;
      refresh();
    },
  };
}
