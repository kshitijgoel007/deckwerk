import type { Deck, Slide } from './deck.js';
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
    name: 'Basic',
    description: 'Avenir geometry on white. Quietly confident; disappears behind the work.',
    fonts: {
      title: { family: AVENIR, size: 96, weight: 600, lineHeight: 1.04, letterSpacing: '-0.02em' },
      heading: { family: AVENIR, size: 58, weight: 600, lineHeight: 1.12, letterSpacing: '-0.01em' },
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
    description: 'Monospace everything on soft off-white. Terminal calm, phosphor accents.',
    fonts: {
      title: { family: MONO, size: 84, weight: 700, lineHeight: 1.1, letterSpacing: '-0.03em' },
      heading: { family: MONO, size: 52, weight: 600, lineHeight: 1.2, letterSpacing: '-0.02em' },
      body: { family: MONO, size: 32, weight: 400, lineHeight: 1.5, letterSpacing: '-0.01em' },
      caption: { family: MONO, size: 22, weight: 400, lineHeight: 1.4, letterSpacing: '0', color: '#7c7f93' },
      base: { family: MONO, size: 30, weight: 400, lineHeight: 1.5, letterSpacing: '-0.01em' },
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
      heading: { family: EDITORIAL_SERIF, size: 56, weight: 600, lineHeight: 1.15, letterSpacing: '0' },
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
    description: 'Helvetica, stark white, one red. International Typographic Style, no apologies.',
    fonts: {
      title: { family: HELVETICA, size: 110, weight: 700, lineHeight: 0.98, letterSpacing: '-0.04em' },
      heading: { family: HELVETICA, size: 60, weight: 700, lineHeight: 1.05, letterSpacing: '-0.02em' },
      body: { family: HELVETICA, size: 38, weight: 400, lineHeight: 1.3, letterSpacing: '0' },
      caption: { family: HELVETICA, size: 24, weight: 700, lineHeight: 1.25, letterSpacing: '0.08em', color: '#111111' },
      base: { family: HELVETICA, size: 34, weight: 400, lineHeight: 1.3, letterSpacing: '0' },
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
      heading: { family: HUMANIST, size: 54, weight: 600, lineHeight: 1.15, letterSpacing: '0' },
      body: { family: HUMANIST, size: 37, weight: 400, lineHeight: 1.4, letterSpacing: '0' },
      caption: { family: HUMANIST, size: 25, weight: 500, lineHeight: 1.35, letterSpacing: '0.02em', color: '#9c8e85' },
      base: { family: HUMANIST, size: 33, weight: 400, lineHeight: 1.4, letterSpacing: '0' },
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

/** Markers so installing again replaces rather than stacks. */
export const THEME_BLOCK_START = '/* >>> slide-editor theme (generated) */';
export const THEME_BLOCK_END = '/* <<< end theme */';

/** The CSS a theme installs: role typography plus ground colours. */
export function themeCss(theme: ThemePreset): string {
  return [
    `/* theme: ${theme.name} — ${theme.description} */`,
    fontSetCss(fontSetOf(theme)),
    `.slide {`,
    `  background: ${theme.colors.background};`,
    `  color: ${theme.colors.text};`,
    `}`,
    ``,
    `.role-caption { color: ${theme.colors.muted}; }`,
    ``,
  ].join('\n');
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
