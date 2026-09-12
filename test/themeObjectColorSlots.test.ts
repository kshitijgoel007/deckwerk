// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import type { Deck, SlideElement } from '../src/shared/deck.js';
import {
  THEMES,
  type ThemeAdoption,
  type ThemePreset,
  adoptThemeStyles,
  applyThemeToDeck,
  NO_APPLY,
  themeById,
  themeMode,
  themeVariant,
} from '../src/shared/themes.js';

/**
 * Shape colours across a theme's light/dark counterpart.
 *
 * A palette slot is a role — slot 0 the ink, 1 the muted tone, 2 the accent,
 * the last two the surface and the ground — and the flip to the other side of
 * the room keeps those roles in place. Nearest-in-RGB threw the role away: the
 * mid grey of Research (#6b6862) is closer to the *blue* of Research · Dark
 * than to that theme's own grey, so a grey box went to Dark blue and came back
 * light blue. Switching to dark and straight back has to be a round trip.
 */

const SHAPE_FILLS = ['#ece7dd', '#c96442', '#c96442', '#6b6862'];

const OBJECTS_ONLY: ThemeAdoption = {
  scope: 'deck',
  roles: [],
  fontFamily: false,
  fontWeight: false,
  typeScale: false,
  textColor: false,
  background: false,
  objectColors: true,
  replaceOverrides: true,
  detectRoles: false,
};

function shape(id: string, fill: string, stroke: string | null = null): SlideElement {
  return {
    id, type: 'shape', shape: 'rect', x: 100, y: 100, w: 400, h: 200, rot: 0, z: 1,
    opacity: 1, class: [], style: {}, fill, stroke, radius: 0,
  } as unknown as SlideElement;
}

function deckOfFills(fills: string[]): Deck {
  const deck = emptyDeck('Boxes');
  deck.slides[0].elements = fills.map((fill, at) => shape(`shape-${at}`, fill));
  return deck;
}

const fillsOf = (deck: Deck): string[] =>
  deck.slides[0].elements.map((el) => (el as { fill: string }).fill);

const counterpart = (theme: ThemePreset): ThemePreset =>
  themeVariant(theme, themeMode(theme) === 'dark' ? 'light' : 'dark');

describe('shape colours through a light/dark theme switch', () => {
  it('brings slide 4 of the intro deck home unchanged', () => {
    // The fills on that slide: surface, accent, accent, muted — all Research
    // swatches, as picked from the colour row.
    const deck = deckOfFills(SHAPE_FILLS);
    const light = themeById('basic')!;
    const dark = themeById('basic-dark')!;

    adoptThemeStyles(deck, dark, { ...OBJECTS_ONLY }, 0, new Set());
    const inDark = fillsOf(deck);
    // Every box moved to the dark theme's *matching* slot, not its nearest hue.
    expect(inDark).toEqual([dark.palette[6], dark.palette[2], dark.palette[2], dark.palette[1]]);

    adoptThemeStyles(deck, light, { ...OBJECTS_ONLY }, 0, new Set());
    expect(fillsOf(deck)).toEqual(SHAPE_FILLS);
  });

  it('sends a paper-coloured box to the dark theme’s ground, not to near-white', () => {
    const deck = deckOfFills(['#faf9f5']);
    const dark = themeById('basic-dark')!;
    adoptThemeStyles(deck, dark, { ...OBJECTS_ONLY }, 0, new Set());
    // Slot 7 is the ground: a box that was the paper is now the dark ground.
    expect(fillsOf(deck)).toEqual([dark.palette[7]]);
  });

  it('is a round trip for every swatch of every preset, in both directions', () => {
    for (const theme of THEMES) {
      const other = counterpart(theme);
      for (const [there, back] of [[other, theme], [theme, other]] as const) {
        const deck = deckOfFills(back.palette);
        adoptThemeStyles(deck, there, { ...OBJECTS_ONLY }, 0, new Set());
        expect(fillsOf(deck), `${back.id} → ${there.id}`).toEqual(there.palette);
        adoptThemeStyles(deck, back, { ...OBJECTS_ONLY }, 0, new Set());
        expect(fillsOf(deck), `${back.id} → ${there.id} → back`).toEqual(back.palette);
      }
    }
  });

  it('is idempotent: applying the same theme twice settles', () => {
    for (const theme of THEMES) {
      for (const target of [theme, counterpart(theme)]) {
        const deck = deckOfFills([...theme.palette, '#3a7bd5', '#ffcc00']);
        adoptThemeStyles(deck, target, { ...OBJECTS_ONLY }, 0, new Set());
        const once = fillsOf(deck);
        adoptThemeStyles(deck, target, { ...OBJECTS_ONLY }, 0, new Set());
        expect(fillsOf(deck), `${target.id} twice`).toEqual(once);
      }
    }
  });

  it('carries strokes by slot too', () => {
    const deck = emptyDeck('Outlines');
    deck.slides[0].elements = [shape('s1', '#faf9f5', '#6b6862')];
    const dark = themeById('basic-dark')!;
    adoptThemeStyles(deck, dark, { ...OBJECTS_ONLY }, 0, new Set());
    const el = deck.slides[0].elements[0] as { fill: string; stroke: string };
    expect(el.stroke).toBe(dark.palette[1]);
    adoptThemeStyles(deck, themeById('basic')!, { ...OBJECTS_ONLY }, 0, new Set());
    expect((deck.slides[0].elements[0] as { stroke: string }).stroke).toBe('#6b6862');
  });

  it('leaves a colour that is nobody’s swatch exactly as the author set it', () => {
    const deck = deckOfFills(['#e83a30', '#ffffff', 'rgba(255, 255, 255, 0.4)']);
    const swiss = themeById('swiss')!;
    adoptThemeStyles(deck, swiss, { ...OBJECTS_ONLY }, 0, new Set());
    // No slot claims #e83a30, so it is the author's own red and stays. White
    // stays too: snapped to the nearest swatch it landed on the theme's
    // ground, and every white arrow on the slide disappeared.
    expect(fillsOf(deck)[0]).toBe('#e83a30');
    expect(fillsOf(deck)[1]).toBe('#ffffff');
    // A deliberate translucency survives a theme.
    expect(fillsOf(deck)[2]).toBe('rgba(255, 255, 255, 0.4)');
  });

  it('honours slots for a theme the deck carries itself', () => {
    const deck = deckOfFills(['#123456', '#abcdef']);
    deck.customThemes = [{
      ...structuredClone(THEMES[0]),
      id: 'house',
      name: 'House',
      palette: ['#123456', '#abcdef', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#eeeeee', '#ffffff'],
    }];
    const house = themeById('house', [...THEMES, ...deck.customThemes])!;
    const dark = themeVariant(house, 'dark');
    adoptThemeStyles(deck, dark, { ...OBJECTS_ONLY }, 0, new Set());
    expect(fillsOf(deck)).toEqual([dark.palette[0], dark.palette[1]]);
    adoptThemeStyles(deck, house, { ...OBJECTS_ONLY }, 0, new Set());
    expect(fillsOf(deck)).toEqual(['#123456', '#abcdef']);
  });

  it('maps by slot on the deck-wide apply path as well', () => {
    const deck = deckOfFills(SHAPE_FILLS);
    applyThemeToDeck(deck, themeById('basic-dark')!, { ...NO_APPLY, objectColors: true });
    applyThemeToDeck(deck, themeById('basic')!, { ...NO_APPLY, objectColors: true });
    expect(fillsOf(deck)).toEqual(SHAPE_FILLS);
  });

  it('keeps the black arrows of an imported deck black under Research (3D in the wild, slide 5)', () => {
    // Keynote import: black strokes and black panels on a white ground. Pure
    // black is the flipped ground of Swiss · Dark, a theme this deck has never
    // worn. Indexing every built-in sent the strokes to slot 7 — Research's
    // paper — and every arrow on the slide disappeared.
    const deck = emptyDeck('3D in the wild');
    deck.slides[0].elements = [
      shape('arrow', null as unknown as string, '#000000'),
      shape('panel', '#000000'),
      shape('frame', '#ffffff', '#000000'),
    ];
    adoptThemeStyles(deck, themeById('basic')!, { ...OBJECTS_ONLY }, 0, new Set());
    const [arrow, panel, frame] = deck.slides[0].elements as unknown as { fill: string | null; stroke: string | null }[];
    expect(arrow.stroke).toBe('#000000');
    expect(panel.fill).toBe('#000000');
    expect(frame.stroke).toBe('#000000');
    expect(frame.fill).toBe('#ffffff');
  });

  it('never lets a stroke land on the ground slot, even from a worn theme', () => {
    // A deck genuinely on Swiss · Dark, with an outline drawn in that theme's
    // black ground colour (an author picking "black" from the row). Going back
    // to light Swiss, a fill in that colour becomes the white paper; a stroke
    // would vanish, so it stays.
    const deck = emptyDeck('Outlines');
    const swissDark = themeById('swiss-dark')!;
    const swiss = themeById('swiss')!;
    deck.slides[0].elements = [shape('s1', swissDark.palette[7], swissDark.palette[7])];
    adoptThemeStyles(deck, swissDark, { ...OBJECTS_ONLY }, 0, new Set());
    adoptThemeStyles(deck, swiss, { ...OBJECTS_ONLY }, 0, new Set());
    const el = deck.slides[0].elements[0] as { fill: string; stroke: string };
    expect(el.fill).toBe(swiss.palette[7]);
    expect(el.stroke).toBe(swissDark.palette[7]);
  });

  it('only indexes the themes the deck has worn', () => {
    // Research's accent is a real swatch, but of a theme this deck never used.
    const deck = deckOfFills(['#c96442']);
    adoptThemeStyles(deck, themeById('swiss')!, { ...OBJECTS_ONLY }, 0, new Set());
    expect(fillsOf(deck)).toEqual(['#c96442']);
    // Once the deck has worn Research, the same colour does travel.
    const worn = deckOfFills(['#c96442']);
    worn.themeHistory = ['basic'];
    adoptThemeStyles(worn, themeById('swiss')!, { ...OBJECTS_ONLY }, 0, new Set());
    expect(fillsOf(worn)).toEqual([themeById('swiss')!.palette[2]]);
  });
});
