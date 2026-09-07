// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  THEMES,
  type ThemeAdoption,
  type ThemePreset,
  adoptThemeStyles,
  applyDeckThemeToNewSlide,
  baseThemeId,
  fullThemeSelection,
  themeById,
  themeCss,
  themeMode,
  themeVariant,
} from '../src/shared/themes.js';
import { type Deck, emptyDeck, parseDeck } from '../src/shared/deck.js';
import { deckTheme, deckThemes, fontSetOf } from '../src/shared/themes.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { createThemeGallery } from '../src/renderer/editor/themeGallery.js';

/**
 * Dark/light theme variants: every preset has a counterpart on the other side
 * of the room, derived by mirroring lightness while keeping hue — and the
 * picker's global Light/Dark switch shows whichever side is asked for.
 */

const avgLuma = (hex: string) => [1, 3, 5]
  .map((at) => Number.parseInt(hex.slice(at, at + 2), 16))
  .reduce((sum, channel) => sum + channel, 0) / 3;

describe('theme variants', () => {
  it('derives a legible counterpart for every preset in both modes', () => {
    for (const theme of THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        const variant = themeVariant(theme, mode);
        expect(themeMode(variant), `${theme.id} → ${mode}`).toBe(mode);
        // Same contrast bar the native presets are held to.
        expect(
          Math.abs(avgLuma(variant.colors.text) - avgLuma(variant.colors.background)),
          `${variant.id} text vs ground`,
        ).toBeGreaterThan(150);
        // The typography is the theme's voice and does not change with the mode.
        for (const role of ['title', 'heading', 'body', 'caption', 'base'] as const) {
          expect(variant.fonts[role].family).toBe(theme.fonts[role].family);
          expect(variant.fonts[role].size).toBe(theme.fonts[role].size);
          expect(variant.fonts[role].weight).toBe(theme.fonts[role].weight);
        }
        expect(variant.palette).toHaveLength(theme.palette.length);
      }
    }
  });

  it('returns the preset itself when it already sits in the requested mode', () => {
    const research = THEMES.find((theme) => theme.id === 'basic')!;
    const noir = THEMES.find((theme) => theme.id === 'noir')!;
    expect(themeVariant(research, 'light')).toBe(research);
    expect(themeVariant(noir, 'dark')).toBe(noir);
    expect(themeVariant(research, 'dark').id).toBe('basic-dark');
    expect(themeVariant(noir, 'light').id).toBe('noir-light');
  });

  it('resolves variant ids wherever presets are looked up', () => {
    expect(themeById('basic-dark')?.name).toBe('Research · Dark');
    expect(themeById('noir-light')?.name).toBe('Noir · Light');
    // A suffix that names the mode the preset is already in is not a real id.
    expect(themeById('basic-light')).toBeNull();
    expect(themeById('nope-dark')).toBeNull();
    expect(baseThemeId('basic-dark')).toBe('basic');
    expect(baseThemeId('noir-light')).toBe('noir');
    expect(baseThemeId('salon')).toBe('salon');
  });

  it('keeps a mid-lightness accent recognisable while flipping the grounds', () => {
    const research = THEMES.find((theme) => theme.id === 'basic')!;
    const dark = themeVariant(research, 'dark');
    // Paper flips to near-black, ink to off-white.
    expect(avgLuma(dark.colors.background)).toBeLessThan(30);
    expect(avgLuma(dark.colors.text)).toBeGreaterThan(215);
    // The clay accent stays a clay accent (its lightness pivots near center).
    const accentShift = Math.abs(avgLuma(dark.colors.accent) - avgLuma(research.colors.accent));
    expect(accentShift).toBeLessThan(60);
    // themeCss renders variants like any preset.
    expect(themeCss(dark)).toContain(`background: ${dark.colors.background}`);
  });

  it('flows through choose → new slide and apply-to-selected-slides', () => {
    const deck = emptyDeck('Variant flow');
    deck.slides[0].elements = [{
      id: 't1', type: 'text', x: 0, y: 0, w: 800, h: 100, rot: 0, z: 1,
      opacity: 1, class: ['role-title'], style: {},
      html: 'Title', align: 'left', valign: 'top',
    }];
    const dark = themeById('basic-dark')!;

    const apply: ThemeAdoption = {
      scope: 'slides', roles: ['title'], fontFamily: true, fontWeight: true,
      typeScale: false, textColor: true, background: true, objectColors: false,
      replaceOverrides: true, detectRoles: false,
    };
    adoptThemeStyles(deck, dark, apply, 0, new Set(), new Set(['slide-1']));
    // The variant is installed like any preset: the slide's ground follows
    // theme.css, which now paints the dark background.
    expect(deck.slides[0].background).toEqual({ color: null, image: null });
    expect(deck.themePreset).toBe('basic-dark');
    expect(deck.themeStyle?.colors.background).toBe(dark.colors.background);
    expect(deck.themeStyle?.fonts.title.color).toBe(dark.colors.text);
    expect(deck.slides[0].elements[0].style).toEqual({});
    expect(deck.themeSelection?.preset).toBe('basic-dark');

    // A slide created afterwards is born wearing the dark variant through
    // theme.css alone: nothing is written onto it.
    deck.slides.push({
      id: 'slide-2', name: '', background: { color: null, image: null },
      notes: '', elements: [], timeline: [],
    });
    applySlideLayout(deck.slides[1], 'standard', deck.layoutMasters);
    const born = JSON.stringify(deck.slides[1]);
    applyDeckThemeToNewSlide(deck, 1);
    expect(JSON.stringify(deck.slides[1])).toBe(born);
    expect(deck.slides[1].background.color).toBeNull();

    // fullThemeSelection round-trips the variant id too.
    deck.themeSelection = fullThemeSelection('noir-light');
    expect(themeById(deck.themeSelection.preset)?.colors.background)
      .toBe(themeById('noir-light')!.colors.background);
  });
});

describe('theme gallery light/dark switch', () => {
  function build(initialId: string | null, onSelect = vi.fn()) {
    const gallery = createThemeGallery(THEMES, initialId, onSelect);
    document.body.replaceChildren(gallery.element);
    return { gallery, onSelect };
  }
  const cardIds = () => [...document.querySelectorAll<HTMLElement>('.theme-card')]
    .map((card) => card.dataset.themeId);
  const modeButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.theme-mode-option')]
    .find((button) => button.textContent === label)!;

  it('opens on the side of the switch the current theme sits on', () => {
    build('basic');
    expect(modeButton('Light').classList.contains('selected')).toBe(true);
    expect(cardIds()).toContain('basic');
    expect(cardIds()).toContain('noir-light');

    build('noir');
    expect(modeButton('Dark').classList.contains('selected')).toBe(true);
    expect(cardIds()).toContain('noir');
    expect(cardIds()).toContain('basic-dark');
  });

  it('switches every card to its counterpart and selects variants', () => {
    const { gallery, onSelect } = build('basic');
    modeButton('Dark').click();
    expect(gallery.mode()).toBe('dark');
    expect(cardIds()).toContain('basic-dark');
    expect(cardIds()).toContain('noir');

    // The switch carries the selection across with it: asking for the dark
    // room means the selected theme's dark half, reported so previews follow.
    expect(gallery.selectedId()).toBe('basic-dark');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect((onSelect.mock.calls[0][0] as ThemePreset).id).toBe('basic-dark');
    expect(onSelect.mock.calls[0][1]).toBe('mode');

    document.querySelector<HTMLButtonElement>('[data-theme-id="basic-dark"]')!.click();
    expect(onSelect).toHaveBeenCalledTimes(2);
    const chosen = onSelect.mock.calls[1][0] as ThemePreset;
    expect(chosen.id).toBe('basic-dark');
    expect(onSelect.mock.calls[1][1]).toBe('card');
    expect(gallery.selectedId()).toBe('basic-dark');
    // The base card stays highlighted whichever side is displayed.
    expect(document.querySelector('[data-theme-id="basic-dark"]')!.classList.contains('selected')).toBe(true);
    modeButton('Light').click();
    expect(gallery.selectedId()).toBe('basic');
    expect(document.querySelector('[data-theme-id="basic"]')!.classList.contains('selected')).toBe(true);
  });

  it('follows a variant id arriving from a freshly opened deck', () => {
    const { gallery } = build('basic');
    gallery.setSelected('noir-light');
    expect(gallery.mode()).toBe('light');
    expect(gallery.selectedId()).toBe('noir-light');
    expect(document.querySelector('[data-theme-id="noir-light"]')!.classList.contains('selected')).toBe(true);
  });

  it('shows Current only on the literally installed variant', () => {
    const { gallery } = build('basic');
    gallery.setInstalled('basic');
    const badgeHidden = (id: string) => document
      .querySelector(`[data-theme-id="${id}"] .theme-installed-badge`)!
      .hasAttribute('hidden');
    expect(badgeHidden('basic')).toBe(false);
    modeButton('Dark').click();
    // Research · Dark is not what the deck wears; no badge on it.
    expect(badgeHidden('basic-dark')).toBe(true);
  });
});

describe('theme variants and deck themes through deck.json', () => {
  const reload = (deck: Deck): Deck => parseDeck(JSON.parse(JSON.stringify(deck)));

  it('round-trips a variant id in themeSelection and themePreset through parse → serialize → parse', () => {
    const deck = emptyDeck('Round trip');
    const dark = themeById('basic-dark')!;
    adoptThemeStyles(deck, dark, {
      scope: 'deck', roles: ['title', 'heading', 'body', 'caption', 'base'],
      fontFamily: true, fontWeight: true, typeScale: true, textColor: true,
      background: true, objectColors: true, replaceOverrides: true, detectRoles: false,
    }, 0, new Set());
    const reloaded = reload(deck);
    expect(reloaded.themePreset).toBe('basic-dark');
    expect(reloaded.themeSelection?.preset).toBe('basic-dark');
    expect(reloaded.themeHistory).toEqual(['basic-dark']);
    // The reloaded deck resolves to the same colours the variant was derived with.
    const worn = deckTheme(reloaded)!;
    expect(worn.colors.background).toBe(dark.colors.background);
    expect(worn.fonts.title.family).toBe(dark.fonts.title.family);
  });

  it('round-trips a deck theme and resolves its generated variant after reload', () => {
    const deck = emptyDeck('Custom');
    deck.customThemes = [{
      id: 'lab-night', name: 'Lab Night', description: '',
      fonts: structuredClone(THEMES[0].fonts),
      palette: ['#e9edf2', '#94a0ad', '#f0a83c'],
      colors: { background: '#12151a', text: '#e9edf2', muted: '#94a0ad', accent: '#f0a83c' },
    }];
    deck.themeSelection = fullThemeSelection('lab-night-light');
    const reloaded = reload(deck);
    expect(reloaded.customThemes).toEqual(deck.customThemes);
    const light = themeById('lab-night-light', deckThemes(reloaded))!;
    expect(themeMode(light)).toBe('light');
    expect(deckTheme(reloaded)?.id).toBe('lab-night-light');
    // Bare resolution (built-ins only) does not know deck themes: callers must pass the pool.
    expect(themeById('lab-night')).toBeNull();
  });

  it('falls back to no theme, without throwing, when a deck names an unknown preset or variant', () => {
    const deck = emptyDeck('Unknown');
    deck.themePreset = 'retired-preset';
    deck.themeSelection = fullThemeSelection('retired-preset-dark');
    expect(deckTheme(reload(deck))).toBeNull();
    // A suffix naming the mode the base already sits in is not a real id either.
    deck.themeSelection = fullThemeSelection('noir-dark');
    expect(deckTheme(reload(deck))).toBeNull();
    // ...and applying the deck theme to a new slide under such a selection is a no-op.
    deck.slides.push({
      id: 'slide-2', name: '', background: { color: null, image: null },
      notes: '', elements: [], timeline: [],
    });
    expect(() => applyDeckThemeToNewSlide(deck, 1)).not.toThrow();
    expect(deck.slides[1].background.color).toBeNull();
  });

  it('never mutates a preset: applying, editing the deck and deriving variants leave THEMES intact', () => {
    const snapshot = JSON.stringify(THEMES);
    const deck = emptyDeck('Immutability');
    deck.slides[0].elements.push({
      id: 't', type: 'text', x: 0, y: 0, w: 800, h: 100, rot: 0, z: 1, opacity: 1,
      class: ['role-title'], style: {}, html: 'Title', align: 'left', valign: 'top',
    });
    for (const theme of THEMES) {
      themeVariant(theme, 'dark');
      themeVariant(theme, 'light');
      adoptThemeStyles(deck, theme, {
        scope: 'deck', roles: ['title', 'heading', 'body', 'caption', 'base'],
        fontFamily: true, fontWeight: true, typeScale: true, textColor: true,
        background: true, objectColors: true, replaceOverrides: true, detectRoles: false,
      }, 0, new Set());
      // The deck's own defaults are the author's to edit afterwards.
      deck.themeStyle!.fonts.title.family = 'Comic Sans MS';
      deck.themeStyle!.palette[0] = '#badbad';
      deck.themeStyle!.colors.background = '#badbad';
      deck.slides[0].background.color = '#badbad';
    }
    expect(JSON.stringify(THEMES)).toBe(snapshot);
    // The same holds for a deck theme: the deck's style is a copy, not a reference.
    const custom = {
      id: 'mine', name: 'Mine', description: '', fonts: structuredClone(THEMES[0].fonts),
      palette: ['#000000', '#ffffff'],
      colors: { background: '#ffffff', text: '#000000', muted: '#555555', accent: '#ff0000' },
    };
    deck.customThemes = [custom];
    const customSnapshot = JSON.stringify(custom);
    adoptThemeStyles(deck, themeById('mine', deckThemes(deck))!, {
      scope: 'deck', roles: ['title', 'heading', 'body', 'caption', 'base'],
      fontFamily: true, fontWeight: true, typeScale: true, textColor: true,
      background: true, objectColors: true, replaceOverrides: true, detectRoles: false,
    }, 0, new Set());
    deck.themeStyle!.palette.push('#123456');
    deck.themeStyle!.fonts.body.size = 1;
    expect(JSON.stringify(deck.customThemes[0])).toBe(customSnapshot);
  });

  it('writes CSS that names only the families the theme itself declares, for presets and variants', () => {
    const familyList = (css: string) => [...css.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
    for (const theme of THEMES) {
      for (const shown of [theme, themeVariant(theme, 'dark'), themeVariant(theme, 'light')]) {
        const declared = new Set(Object.values(fontSetOf(shown).roles).map((role) => role.family));
        const css = themeCss(shown);
        const used = familyList(css);
        expect(used.length, shown.id).toBeGreaterThan(0);
        for (const family of used) expect(declared.has(family), `${shown.id}: ${family}`).toBe(true);
        // Every ground colour the CSS paints is one the variant carries.
        expect(css).toContain(`background: ${shown.colors.background};`);
        expect(css).toContain(`color: ${shown.colors.text};`);
        expect(css).toContain(`.role-caption { color: ${shown.colors.muted}; }`);
        // No template holes.
        expect(css).not.toMatch(/undefined|null|NaN/);
      }
    }
  });
});
