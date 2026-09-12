import { describe, expect, it } from 'vitest';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import {
  STOCK_STYLESHEET_STYLE,
  chooseDeckTheme,
  effectiveThemeStyle,
  themeById,
  themeStyleCss,
  themeStyleFromCss,
  themeStyleOf,
} from '../src/shared/themes.js';

/**
 * Choosing a theme pins every existing box at the look it has today, so that
 * nothing on screen moves. "Today's look" used to be guessed from the deck's
 * metadata; a deck with none -- every import, every hand-styled stylesheet --
 * got the stock description instead, and untouched slides jumped to whatever
 * the guess was wrong about. The guess now defers to the deck's real theme.css.
 */

const NOIR = themeById('noir')!;

function title(id: string, style: Record<string, string> = {}): SlideElement {
  return {
    id, type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1, opacity: 1,
    class: ['role-title'], style, html: id, align: 'left', valign: 'top',
  };
}

const HAND_CSS = [
  '/* a hand-written stylesheet, nothing generated */',
  '.slide { background: #fdf6e3; color: #073642; font-family: Georgia, serif; }',
  '.element-text { font-size: 40px; line-height: 1.4; }',
  '.role-title { font-family: Georgia, serif; font-size: 72px; font-weight: 500; }',
  '.role-body { font-size: 36px; }',
  '.role-caption { color: #93a1a1; }',
  '',
].join('\n');

describe('themeStyleFromCss', () => {
  it('reads the role rules a stylesheet declares over the base for the rest', () => {
    const style = themeStyleFromCss(HAND_CSS, STOCK_STYLESHEET_STYLE);
    expect(style.fonts.title).toMatchObject({ family: 'Georgia, serif', size: 72, weight: 500 });
    expect(style.fonts.title.lineHeight).toBe(STOCK_STYLESHEET_STYLE.fonts.title.lineHeight);
    expect(style.fonts.body.size).toBe(36);
    expect(style.fonts.body.family).toBe(STOCK_STYLESHEET_STYLE.fonts.body.family);
    expect(style.fonts.base).toMatchObject({ family: 'Georgia, serif', size: 40, lineHeight: 1.4 });
    expect(style.colors).toMatchObject({ background: '#fdf6e3', text: '#073642', muted: '#93a1a1' });
    expect(style.fonts.caption.color).toBe('#93a1a1');
  });

  it('round-trips the block the app itself writes', () => {
    const written = themeStyleOf(NOIR);
    const read = themeStyleFromCss(themeStyleCss(written), STOCK_STYLESHEET_STYLE);
    for (const role of ['title', 'heading', 'body', 'caption'] as const) {
      expect(read.fonts[role]).toMatchObject({
        family: written.fonts[role].family,
        size: written.fonts[role].size,
        weight: written.fonts[role].weight,
        lineHeight: written.fonts[role].lineHeight,
        letterSpacing: written.fonts[role].letterSpacing,
      });
    }
    // A base box's size comes from `.element-text`, not from `.slide` (see
    // installThemeStyle), so only the face travels through the `.slide` rule.
    expect(read.fonts.base).toMatchObject({
      family: written.fonts.base.family,
      weight: written.fonts.base.weight,
      letterSpacing: written.fonts.base.letterSpacing,
    });
    expect(read.colors.background).toBe(written.colors.background);
    expect(read.colors.text).toBe(written.colors.text);
  });

  it('leaves the base alone for rules it cannot resolve', () => {
    const css = [
      ':root { --title: 60px; }',
      '.slide .role-title { font-size: var(--title); }',
      '@media (max-width: 600px) { .role-title { font-size: 20px; } }',
      '.role-title { font-size: 1.5em; background: linear-gradient(red, blue); }',
    ].join('\n');
    const style = themeStyleFromCss(css, STOCK_STYLESHEET_STYLE);
    expect(style.fonts.title.size).toBe(STOCK_STYLESHEET_STYLE.fonts.title.size);
    expect(style.colors.background).toBe(STOCK_STYLESHEET_STYLE.colors.background);
  });
});

describe('effectiveThemeStyle', () => {
  it('prefers the composed defaults the app installed over any stylesheet', () => {
    const deck = emptyDeck('Installed');
    deck.themePreset = NOIR.id;
    deck.themeStyle = themeStyleOf(NOIR);
    expect(effectiveThemeStyle(deck, HAND_CSS)).toEqual(deck.themeStyle);
  });

  it('reads the deck’s real stylesheet when the data has only a guess', () => {
    const deck = emptyDeck('Hand-styled');
    expect(effectiveThemeStyle(deck).fonts.title.size).toBe(STOCK_STYLESHEET_STYLE.fonts.title.size);
    expect(effectiveThemeStyle(deck, HAND_CSS).fonts.title.size).toBe(72);
  });
});

describe('choosing a theme on a hand-styled deck', () => {
  it('pins untouched titles at the size the stylesheet really gives them', () => {
    const deck = emptyDeck('Imported');
    deck.slides[0].elements = [title('t1'), title('own', { 'font-size': '80px' })];

    chooseDeckTheme(deck, NOIR, HAND_CSS);

    const pinned = deck.slides[0].elements[0];
    expect(pinned.style['font-size']).toBe('72px');
    expect(pinned.style['font-family']).toBe('Georgia, serif');
    expect(pinned.style['font-weight']).toBe('500');
    expect(pinned.style['color']).toBe('#073642');
    // A box carrying its own value keeps it.
    expect(deck.slides[0].elements[1].style['font-size']).toBe('80px');
    // The ground is pinned at the stylesheet's colour, not the stock white.
    expect(deck.slides[0].background.color).toBe('#fdf6e3');
    expect(deck.themePreset).toBe(NOIR.id);
  });

  it('still guesses the stock stylesheet when no CSS is at hand', () => {
    const deck = emptyDeck('No stylesheet');
    deck.slides[0].elements = [title('t1')];
    chooseDeckTheme(deck, NOIR);
    expect(deck.slides[0].elements[0].style['font-size'])
      .toBe(`${STOCK_STYLESHEET_STYLE.fonts.title.size}px`);
  });
});
