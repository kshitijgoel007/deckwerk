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
 * Five looks, all light (dark mode would mean re-editing every figure), each
 * with a genuinely different typographic voice. Stacks are system-first so a
 * conference laptop renders them without webfonts.
 */
const AVENIR = '"Avenir Next", Avenir, "Helvetica Neue", Inter, system-ui, sans-serif';
const HELVETICA = '"Helvetica Now Display", "Helvetica Neue", Helvetica, Arial, sans-serif';
const MONO = '"JetBrains Mono", "IBM Plex Mono", "SF Mono", ui-monospace, Menlo, monospace';
const EDITORIAL_SERIF = '"New York", "Iowan Old Style", Palatino, Georgia, serif';
const HUMANIST = '"Gill Sans", "Gill Sans MT", Seravek, "Segoe UI", Verdana, sans-serif';

export const THEMES: ThemePreset[] = [
  {
    id: 'basic',
    name: 'Studio',
    description: 'Editorial display serif over calm Avenir prose. Quiet and gallery-like.',
    fonts: {
      title: { family: EDITORIAL_SERIF, size: 102, weight: 700, lineHeight: 1.01, letterSpacing: '-0.025em' },
      heading: { family: EDITORIAL_SERIF, size: 58, weight: 600, lineHeight: 1.1, letterSpacing: '-0.01em' },
      body: { family: AVENIR, size: 38, weight: 400, lineHeight: 1.35, letterSpacing: '0' },
      caption: { family: AVENIR, size: 26, weight: 500, lineHeight: 1.3, letterSpacing: '0.01em', color: '#6e6e73' },
      base: { family: AVENIR, size: 34, weight: 400, lineHeight: 1.35, letterSpacing: '0' },
    },
    palette: ['#1d1d1f', '#6e6e73', '#0071e3', '#bf4800', '#1d7d45', '#8944ab', '#f5f5f7', '#ffffff'],
    colors: { background: '#ffffff', text: '#1d1d1f', muted: '#6e6e73', accent: '#0071e3' },
  },
  {
    id: 'hacker',
    name: 'Hacker',
    description: 'Monospace display over humanist prose, with crisp phosphor-green accents.',
    fonts: {
      title: { family: MONO, size: 84, weight: 700, lineHeight: 1.1, letterSpacing: '-0.03em' },
      heading: { family: MONO, size: 52, weight: 600, lineHeight: 1.2, letterSpacing: '-0.02em' },
      body: { family: HUMANIST, size: 36, weight: 400, lineHeight: 1.42, letterSpacing: '0' },
      caption: { family: MONO, size: 22, weight: 500, lineHeight: 1.4, letterSpacing: '0', color: '#7c7f93' },
      base: { family: HUMANIST, size: 33, weight: 400, lineHeight: 1.42, letterSpacing: '0' },
    },
    palette: ['#24273a', '#7c7f93', '#40a02b', '#d20f39', '#1e66f5', '#df8e1d', '#8839ef', '#eff1f5'],
    colors: { background: '#eff1f5', text: '#24273a', muted: '#7c7f93', accent: '#40a02b' },
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Serif display on warm paper, magazine margins. For talks that read like essays.',
    fonts: {
      title: { family: EDITORIAL_SERIF, size: 100, weight: 700, lineHeight: 1.02, letterSpacing: '-0.015em' },
      heading: { family: HUMANIST, size: 54, weight: 600, lineHeight: 1.15, letterSpacing: '0.01em' },
      body: { family: AVENIR, size: 36, weight: 400, lineHeight: 1.45, letterSpacing: '0' },
      caption: { family: AVENIR, size: 24, weight: 500, lineHeight: 1.35, letterSpacing: '0.06em', color: '#8a817c' },
      base: { family: AVENIR, size: 33, weight: 400, lineHeight: 1.45, letterSpacing: '0' },
    },
    palette: ['#2b2118', '#5c554e', '#9a3b3b', '#33658a', '#5f7161', '#c58940', '#f3ede4', '#faf6ef'],
    colors: { background: '#faf6ef', text: '#2b2118', muted: '#8a817c', accent: '#9a3b3b' },
  },
  {
    id: 'swiss',
    name: 'Swiss',
    description: 'Oversized Helvetica over literary serif copy, with one uncompromising red accent.',
    fonts: {
      title: { family: HELVETICA, size: 110, weight: 700, lineHeight: 0.98, letterSpacing: '-0.04em' },
      heading: { family: HELVETICA, size: 60, weight: 700, lineHeight: 1.05, letterSpacing: '-0.02em' },
      body: { family: EDITORIAL_SERIF, size: 38, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
      caption: { family: MONO, size: 23, weight: 600, lineHeight: 1.25, letterSpacing: '0.06em', color: '#111111' },
      base: { family: EDITORIAL_SERIF, size: 34, weight: 400, lineHeight: 1.34, letterSpacing: '0' },
    },
    palette: ['#111111', '#555555', '#e63946', '#0057b7', '#f4a261', '#2a9d8f', '#eeeeee', '#ffffff'],
    colors: { background: '#ffffff', text: '#111111', muted: '#555555', accent: '#e63946' },
  },
  {
    id: 'soft',
    name: 'Soft',
    description: 'Humanist sans, cream ground, muted pastels. Friendly without being cute.',
    fonts: {
      title: { family: HUMANIST, size: 92, weight: 600, lineHeight: 1.06, letterSpacing: '-0.01em' },
      heading: { family: EDITORIAL_SERIF, size: 55, weight: 600, lineHeight: 1.12, letterSpacing: '0' },
      body: { family: EDITORIAL_SERIF, size: 37, weight: 400, lineHeight: 1.4, letterSpacing: '0' },
      caption: { family: HUMANIST, size: 25, weight: 500, lineHeight: 1.35, letterSpacing: '0.02em', color: '#9c8e85' },
      base: { family: EDITORIAL_SERIF, size: 33, weight: 400, lineHeight: 1.4, letterSpacing: '0' },
    },
    palette: ['#4a4458', '#8d86a0', '#e07a5f', '#81b29a', '#6d9dc5', '#e9c46a', '#f2e9e4', '#fffdf8'],
    colors: { background: '#fffdf8', text: '#4a4458', muted: '#9c8e85', accent: '#e07a5f' },
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
