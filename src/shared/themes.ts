import type { Deck, Slide, SlideElement, ThemeStyle } from './deck.js';
import { type FontSet, deckProseMax, fontSetCss, roleForElement } from './fontSets.js';

/**
 * Theme presets, modelled on how omarchy themes work: installing a theme
 * changes what is *available* — the swatches in every colour picker, the role
 * styles in theme.css — while applying it to existing content is a separate,
 * granular act. With every apply-option off, installing a theme changes not a
 * single pixel of the deck; you then apply per slide (or deck-wide) with
 * exactly the aspects you asked for.
 */

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  /** This theme's own typographic system — roles written into theme.css. */
  fonts: FontSet['roles'];
  /** The swatch row offered in every colour picker. */
  palette: string[];
  colors: {
    background: string;
    text: string;
    muted: string;
    accent: string;
  };
}

export interface ApplyOptions {
  /** Strip inline text colours so the stylesheet's role colours take over. */
  textColors: boolean;
  /** Remap shape fills and strokes to the nearest palette colour. */
  objectColors: boolean;
  /** Cast font sizes to roles (strip inline sizes, ensure role classes). */
  fontSizes: boolean;
  /** Set slide backgrounds to the theme background. */
  backgrounds: boolean;
}

export const NO_APPLY: ApplyOptions = {
  textColors: false,
  objectColors: false,
  fontSizes: false,
  backgrounds: false,
};

/*
 * Five original, light presentation systems. Their directions borrow broad
 * lessons from strong contemporary identities (warm research editorial,
 * restrained product minimalism, vivid accessible colour, international
 * typographic style, and humanist publishing) without copying brand assets.
 * Stacks are system-first so a conference laptop renders without webfonts.
 */
const AVENIR = '"Avenir Next", Avenir, "Helvetica Neue", Inter, system-ui, sans-serif';
const HELVETICA = '"Helvetica Now Display", "Helvetica Neue", Helvetica, Arial, sans-serif';
const INTER = 'Inter, "Avenir Next", "Helvetica Neue", "Segoe UI", system-ui, sans-serif';
const MONO = '"JetBrains Mono", "IBM Plex Mono", "SF Mono", ui-monospace, Menlo, monospace';
const EDITORIAL_SERIF = 'Charter, "Iowan Old Style", "New York", Palatino, Georgia, serif';
const HUMANIST = '"Gill Sans", "Gill Sans MT", Seravek, "Segoe UI", Verdana, sans-serif';
const DIDONE = 'Didot, "Bodoni 72", "Playfair Display", "Times New Roman", serif';
const OPTIMA = 'Optima, Seravek, Candara, "Gill Sans", "Segoe UI", sans-serif';
const BASKERVILLE = 'Baskerville, "Libre Baskerville", "Hoefler Text", Georgia, serif';
const BOOK_SERIF = 'Palatino, "Palatino Linotype", "Iowan Old Style", "Book Antiqua", Georgia, serif';
const FUTURA = 'Futura, "Century Gothic", "Avenir Next", "Trebuchet MS", sans-serif';
const TERMINAL = '"SF Mono", Menlo, "JetBrains Mono", Consolas, ui-monospace, monospace';

export const THEMES: ThemePreset[] = [
  {
    id: 'basic',
    name: 'Research',
    description: 'Warm editorial serif, humanist prose, and a restrained clay accent.',
    fonts: {
      title: { family: EDITORIAL_SERIF, size: 108, weight: 700, lineHeight: 1.0, letterSpacing: '-0.03em' },
      heading: { family: EDITORIAL_SERIF, size: 64, weight: 600, lineHeight: 1.08, letterSpacing: '-0.015em' },
      body: { family: AVENIR, size: 48, weight: 400, lineHeight: 1.32, letterSpacing: '0' },
      caption: { family: AVENIR, size: 30, weight: 500, lineHeight: 1.3, letterSpacing: '0.015em', color: '#6b6862' },
      base: { family: AVENIR, size: 42, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
    },
    palette: ['#191918', '#6b6862', '#c96442', '#6a8fab', '#71815d', '#d6a756', '#ece7dd', '#faf9f5'],
    colors: { background: '#faf9f5', text: '#191918', muted: '#6b6862', accent: '#c96442' },
  },
  {
    id: 'hacker',
    name: 'Mercury',
    description: 'Cool product minimalism with compact display type and desaturated blue.',
    fonts: {
      title: { family: HELVETICA, size: 106, weight: 700, lineHeight: 1.0, letterSpacing: '-0.045em' },
      heading: { family: HELVETICA, size: 62, weight: 650, lineHeight: 1.08, letterSpacing: '-0.025em' },
      body: { family: INTER, size: 46, weight: 400, lineHeight: 1.34, letterSpacing: '-0.005em' },
      caption: { family: MONO, size: 29, weight: 500, lineHeight: 1.3, letterSpacing: '0.025em', color: '#686a73' },
      base: { family: INTER, size: 42, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
    },
    palette: ['#222326', '#686a73', '#5e6ad2', '#8a7cf0', '#378a78', '#bd6f49', '#e4e6eb', '#f4f5f8'],
    colors: { background: '#f4f5f8', text: '#222326', muted: '#686a73', accent: '#5e6ad2' },
  },
  {
    id: 'editorial',
    name: 'Press',
    description: 'Modern geometric display type over literary prose with vivid editorial colour.',
    fonts: {
      title: { family: AVENIR, size: 112, weight: 700, lineHeight: 0.99, letterSpacing: '-0.04em' },
      heading: { family: AVENIR, size: 66, weight: 600, lineHeight: 1.06, letterSpacing: '-0.02em' },
      body: { family: EDITORIAL_SERIF, size: 47, weight: 400, lineHeight: 1.36, letterSpacing: '0' },
      caption: { family: MONO, size: 29, weight: 500, lineHeight: 1.3, letterSpacing: '0.05em', color: '#716b66' },
      base: { family: EDITORIAL_SERIF, size: 42, weight: 400, lineHeight: 1.36, letterSpacing: '0' },
    },
    palette: ['#201d1b', '#716b66', '#635bff', '#e25950', '#0a8f79', '#d98923', '#eee9e3', '#fffdf9'],
    colors: { background: '#fffdf9', text: '#201d1b', muted: '#716b66', accent: '#635bff' },
  },
  {
    id: 'swiss',
    name: 'Grid',
    description: 'One hard-working grotesk, oversized hierarchy, strict grid, decisive red.',
    fonts: {
      title: { family: HELVETICA, size: 118, weight: 700, lineHeight: 0.96, letterSpacing: '-0.05em' },
      heading: { family: HELVETICA, size: 68, weight: 700, lineHeight: 1.02, letterSpacing: '-0.03em' },
      body: { family: INTER, size: 48, weight: 450, lineHeight: 1.28, letterSpacing: '-0.01em' },
      caption: { family: MONO, size: 30, weight: 600, lineHeight: 1.22, letterSpacing: '0.07em', color: '#4f4f4f' },
      base: { family: INTER, size: 43, weight: 400, lineHeight: 1.3, letterSpacing: '0' },
    },
    palette: ['#111111', '#4f4f4f', '#e12d39', '#0759b8', '#ef9b36', '#218c74', '#eeeeec', '#ffffff'],
    colors: { background: '#ffffff', text: '#111111', muted: '#4f4f4f', accent: '#e12d39' },
  },
  {
    id: 'soft',
    name: 'Field Notes',
    description: 'Humanist display, readable book serif, and natural low-chroma accents.',
    fonts: {
      title: { family: HUMANIST, size: 104, weight: 600, lineHeight: 1.03, letterSpacing: '-0.02em' },
      heading: { family: HUMANIST, size: 64, weight: 600, lineHeight: 1.1, letterSpacing: '-0.01em' },
      body: { family: EDITORIAL_SERIF, size: 46, weight: 400, lineHeight: 1.38, letterSpacing: '0' },
      caption: { family: HUMANIST, size: 30, weight: 500, lineHeight: 1.32, letterSpacing: '0.025em', color: '#82766e' },
      base: { family: EDITORIAL_SERIF, size: 42, weight: 400, lineHeight: 1.38, letterSpacing: '0' },
    },
    palette: ['#383431', '#82766e', '#c96f52', '#6f8f78', '#6688a3', '#d1a34b', '#eee7dc', '#fffaf2'],
    colors: { background: '#fffaf2', text: '#383431', muted: '#82766e', accent: '#c96f52' },
  },
  {
    id: 'noir',
    name: 'Noir',
    description: 'Warm near-black ground, tight grotesk display, and a brass accent for dark rooms.',
    fonts: {
      title: { family: HELVETICA, size: 108, weight: 700, lineHeight: 0.98, letterSpacing: '-0.04em' },
      heading: { family: HELVETICA, size: 62, weight: 650, lineHeight: 1.06, letterSpacing: '-0.02em' },
      body: { family: INTER, size: 46, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
      caption: { family: MONO, size: 29, weight: 500, lineHeight: 1.3, letterSpacing: '0.04em', color: '#97918a' },
      base: { family: INTER, size: 42, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
    },
    palette: ['#ece6dc', '#97918a', '#d4a955', '#7fa8c9', '#8fae8b', '#c9705e', '#2a2724', '#141210'],
    colors: { background: '#141210', text: '#ece6dc', muted: '#97918a', accent: '#d4a955' },
  },
  {
    id: 'salon',
    name: 'Salon',
    description: 'High-contrast Didone display over calm Optima prose, cream paper, oxblood accent.',
    fonts: {
      title: { family: DIDONE, size: 116, weight: 700, lineHeight: 1.0, letterSpacing: '-0.01em' },
      heading: { family: DIDONE, size: 68, weight: 600, lineHeight: 1.08, letterSpacing: '0' },
      body: { family: OPTIMA, size: 47, weight: 400, lineHeight: 1.36, letterSpacing: '0.005em' },
      caption: { family: OPTIMA, size: 30, weight: 500, lineHeight: 1.3, letterSpacing: '0.06em', color: '#7d7468' },
      base: { family: OPTIMA, size: 42, weight: 400, lineHeight: 1.36, letterSpacing: '0.005em' },
    },
    palette: ['#232019', '#7d7468', '#8e3b3b', '#3f5e63', '#a3803c', '#5d6b47', '#efe8da', '#f7f2e9'],
    colors: { background: '#f7f2e9', text: '#232019', muted: '#7d7468', accent: '#8e3b3b' },
  },
  {
    id: 'essay',
    name: 'Essay',
    description: 'Bookish Baskerville headings and Palatino prose with a deep-green accent.',
    fonts: {
      title: { family: BASKERVILLE, size: 104, weight: 700, lineHeight: 1.04, letterSpacing: '-0.01em' },
      heading: { family: BASKERVILLE, size: 62, weight: 600, lineHeight: 1.12, letterSpacing: '0' },
      body: { family: BOOK_SERIF, size: 46, weight: 400, lineHeight: 1.4, letterSpacing: '0' },
      caption: { family: HUMANIST, size: 29, weight: 500, lineHeight: 1.32, letterSpacing: '0.03em', color: '#847b6d' },
      base: { family: BOOK_SERIF, size: 42, weight: 400, lineHeight: 1.4, letterSpacing: '0' },
    },
    palette: ['#2b271f', '#847b6d', '#2e5e4e', '#7c4a33', '#5a6b8c', '#a88b3d', '#f0ead9', '#fbf7ef'],
    colors: { background: '#fbf7ef', text: '#2b271f', muted: '#847b6d', accent: '#2e5e4e' },
  },
  {
    id: 'poster',
    name: 'Poster',
    description: 'Geometric Futura display, warm poster paper, and primary Bauhaus colour.',
    fonts: {
      title: { family: FUTURA, size: 114, weight: 700, lineHeight: 0.98, letterSpacing: '-0.015em' },
      heading: { family: FUTURA, size: 64, weight: 600, lineHeight: 1.06, letterSpacing: '0' },
      body: { family: AVENIR, size: 46, weight: 400, lineHeight: 1.32, letterSpacing: '0' },
      caption: { family: FUTURA, size: 29, weight: 500, lineHeight: 1.28, letterSpacing: '0.09em', color: '#6d675c' },
      base: { family: AVENIR, size: 42, weight: 400, lineHeight: 1.32, letterSpacing: '0' },
    },
    palette: ['#14151a', '#6d675c', '#d1342c', '#23579c', '#e8a713', '#2c6e49', '#ebe4d5', '#f5f0e6'],
    colors: { background: '#f5f0e6', text: '#14151a', muted: '#6d675c', accent: '#d1342c' },
  },
  {
    id: 'phosphor',
    name: 'Phosphor',
    description: 'Terminal monospace on a green-black CRT ground; amber highlights.',
    fonts: {
      title: { family: TERMINAL, size: 92, weight: 700, lineHeight: 1.04, letterSpacing: '-0.02em' },
      heading: { family: TERMINAL, size: 56, weight: 600, lineHeight: 1.1, letterSpacing: '-0.01em' },
      body: { family: TERMINAL, size: 46, weight: 400, lineHeight: 1.4, letterSpacing: '0' },
      caption: { family: TERMINAL, size: 28, weight: 500, lineHeight: 1.34, letterSpacing: '0.05em', color: '#7d9486' },
      base: { family: TERMINAL, size: 40, weight: 400, lineHeight: 1.42, letterSpacing: '0' },
    },
    palette: ['#d7e4dc', '#7d9486', '#4ade80', '#e8b04b', '#6bb2d6', '#d67676', '#1a231e', '#0d1210'],
    colors: { background: '#0d1210', text: '#d7e4dc', muted: '#7d9486', accent: '#4ade80' },
  },
];

export function themeById(id: string | null | undefined): ThemePreset | null {
  return THEMES.find((t) => t.id === id) ?? null;
}

export function fontSetOf(theme: ThemePreset): FontSet {
  return { id: theme.id, name: theme.name, description: theme.description, roles: theme.fonts };
}

export function themeStyleOf(theme: ThemePreset): ThemeStyle {
  return structuredClone({ fonts: theme.fonts, palette: theme.palette, colors: theme.colors });
}

/** Markers so installing again replaces rather than stacks. */
export const THEME_BLOCK_START = '/* >>> slide-editor theme (generated) */';
export const THEME_BLOCK_END = '/* <<< end theme */';

/** The CSS a theme installs: role typography plus ground colours. */
export function themeCss(theme: ThemePreset): string {
  return themeStyleCss(themeStyleOf(theme), `${theme.name} — ${theme.description}`);
}

/** CSS for a deck's composed defaults, which may draw properties from several presets. */
export function themeStyleCss(style: ThemeStyle, label = 'Custom deck defaults'): string {
  return [
    `/* theme: ${label} */`,
    fontSetCss({ id: 'deck-defaults', name: label, description: '', roles: style.fonts }),
    `.slide {`,
    `  background: ${style.colors.background};`,
    `  color: ${style.colors.text};`,
    `}`,
    ``,
    `.role-caption { color: ${style.colors.muted}; }`,
    ``,
  ].join('\n');
}

export type ThemeScope = 'deck' | 'slide' | 'slides' | 'selection';
export type ThemeTextRole = 'title' | 'heading' | 'body' | 'caption' | 'base';
export interface ThemeAdoption {
  scope: ThemeScope;
  roles: ThemeTextRole[];
  fontFamily: boolean;
  fontWeight: boolean;
  typeScale: boolean;
  textColor: boolean;
  background: boolean;
  objectColors: boolean;
  replaceOverrides: boolean;
  detectRoles: boolean;
}

function explicitRole(el: SlideElement): ThemeTextRole {
  const found = el.class.find((name) => /^role-(title|heading|body|caption)$/.test(name));
  return (found?.slice(5) as ThemeTextRole | undefined) ?? 'base';
}

/** Adopt only requested properties from a preset, at an explicit scope. */
export function adoptThemeStyles(
  deck: Deck,
  theme: ThemePreset,
  options: ThemeAdoption,
  slideIndex: number,
  selection: Set<string>,
  selectedSlideIds: Set<string> = new Set(),
): void {
  const source = themeStyleOf(theme);
  const slides = options.scope === 'deck'
    ? deck.slides
    : options.scope === 'slides'
      ? deck.slides.filter((slide) => selectedSlideIds.has(slide.id))
    : [deck.slides[slideIndex]].filter((slide): slide is Slide => Boolean(slide));
  const maxProse = deckProseMax(deck.slides.flatMap((slide) => slide.elements
    .filter((el) => el.type === 'text')
    .map((el) => ({ html: el.html, size: Number.parseFloat(el.style['font-size'] ?? '0') || 0 }))));

  if (options.scope === 'deck') {
    const defaults = structuredClone(deck.themeStyle ?? source);
    for (const role of options.roles) {
      if (options.fontFamily) defaults.fonts[role].family = source.fonts[role].family;
      if (options.fontWeight) defaults.fonts[role].weight = source.fonts[role].weight;
      if (options.typeScale) {
        defaults.fonts[role].size = source.fonts[role].size;
        defaults.fonts[role].lineHeight = source.fonts[role].lineHeight;
        defaults.fonts[role].letterSpacing = source.fonts[role].letterSpacing;
      }
      if (options.textColor) {
        defaults.fonts[role].color = source.fonts[role].color ?? source.colors.text;
      }
    }
    if (options.textColor && options.roles.includes('base')) defaults.colors.text = source.colors.text;
    if (options.textColor && options.roles.includes('caption')) defaults.colors.muted = source.colors.muted;
    if (options.background) defaults.colors.background = source.colors.background;
    if (options.objectColors) {
      defaults.palette = [...source.palette];
      defaults.colors.accent = source.colors.accent;
    }
    deck.themeStyle = defaults;
    deck.themePreset = theme.id;
  }

  for (const slide of slides) {
    if (options.background && options.scope !== 'selection') {
      slide.background = { color: source.colors.background, image: null };
    }
    for (const el of slide.elements) {
      if (options.scope === 'selection' && !selection.has(el.id)) continue;
      if (el.type === 'text') {
        let role = explicitRole(el);
        if (options.detectRoles && role === 'base') {
          const size = Number.parseFloat(el.style['font-size'] ?? '0') || 0;
          role = roleForElement(el.class, size, maxProse);
          el.class = [...el.class.filter((name) => !name.startsWith('role-')), `role-${role}`];
        }
        if (!options.roles.includes(role)) continue;
        if (options.scope === 'deck' && !options.replaceOverrides) continue;
        const font = source.fonts[role];
        const style = { ...el.style };
        const inherit = options.scope === 'deck' && options.replaceOverrides;
        const set = (property: string, value: string) => {
          if (inherit) delete style[property];
          else style[property] = value;
        };
        if (options.fontFamily) set('font-family', font.family);
        if (options.fontWeight) set('font-weight', String(font.weight));
        if (options.typeScale) {
          set('font-size', `${font.size}px`);
          set('line-height', String(font.lineHeight));
          set('letter-spacing', font.letterSpacing);
        }
        if (options.textColor) set('color', font.color ?? source.colors.text);
        el.style = style;
      } else if (el.type === 'shape' && options.objectColors) {
        if (el.fill) el.fill = nearestPaletteColor(el.fill, source.palette);
        if (el.stroke) el.stroke = nearestPaletteColor(el.stroke, source.palette);
      }
    }
  }
}

/** Replace any previously installed theme block, leaving user CSS untouched. */
export function withThemeBlock(css: string, block: string): string {
  const wrapped = `${THEME_BLOCK_START}\n${block}${THEME_BLOCK_END}\n`;
  const start = css.indexOf(THEME_BLOCK_START);
  const end = css.indexOf(THEME_BLOCK_END);
  if (start !== -1 && end > start) {
    return css.slice(0, start) + wrapped + css.slice(end + THEME_BLOCK_END.length + 1);
  }
  return `${wrapped}\n${css}`;
}

/** Parse #rgb/#rrggbb; null for anything else (rgba stays untouched). */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * The palette colour closest to `color`. Non-hex colours (rgba with alpha,
 * names) are left alone — a deliberate translucency must survive a theme.
 */
export function nearestPaletteColor(color: string, palette: string[]): string {
  const rgb = hexToRgb(color);
  if (!rgb) return color;
  let best = color;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of palette) {
    const c = hexToRgb(candidate);
    if (!c) continue;
    const d = (rgb[0] - c[0]) ** 2 + (rgb[1] - c[1]) ** 2 + (rgb[2] - c[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return best;
}

/**
 * Apply the selected aspects of a theme to one slide, in place.
 *
 * `maxProse` is the deck-wide typographic scale (see `deckProseMax`), passed in
 * so per-slide application classifies text the same way a deck-wide one would.
 */
export function applyThemeToSlide(
  slide: Slide,
  theme: ThemePreset,
  opts: ApplyOptions,
  maxProse: number,
): void {
  if (opts.backgrounds) {
    slide.background = { color: theme.colors.background, image: null };
  }

  for (const el of slide.elements) {
    if (el.type === 'text') {
      if (opts.textColors) {
        const rest = { ...el.style };
        delete rest['color'];
        el.style = rest;
      }
      if (opts.fontSizes) {
        const size = Number.parseFloat(el.style['font-size'] ?? '0') || 0;
        const role = roleForElement(el.class, size, maxProse);
        el.class = [...el.class.filter((c) => !c.startsWith('role-')), `role-${role}`];
        const rest = { ...el.style };
        delete rest['font-size'];
        el.style = rest;
      }
    }

    if (el.type === 'shape' && opts.objectColors) {
      if (el.fill) el.fill = nearestPaletteColor(el.fill, theme.palette);
      if (el.stroke) el.stroke = nearestPaletteColor(el.stroke, theme.palette);
    }
  }
}

/** Deck-wide apply: every slide, one shared typographic scale. */
export function applyThemeToDeck(deck: Deck, theme: ThemePreset, opts: ApplyOptions): void {
  const maxProse = deckProseMax(
    deck.slides.flatMap((s) =>
      s.elements
        .filter((e) => e.type === 'text')
        .map((e) => ({
          html: (e as { html: string }).html,
          size: Number.parseFloat(e.style['font-size'] ?? '0') || 0,
        })),
    ),
  );
  for (const slide of deck.slides) applyThemeToSlide(slide, theme, opts, maxProse);
}
