import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import type { Deck, Slide, SlideElement } from '../src/shared/deck.js';
import {
  THEMES,
  type ThemeAdoption,
  type ThemeScope,
  type ThemeTextRole,
  adoptThemeStyles,
  themeVariant,
} from '../src/shared/themes.js';
import { applyAgentOperations } from '../src/shared/agent.js';
import { diffDecks } from '../src/shared/deckDiff.js';
import { defaultLayoutMasters, syncDeckWithLayoutMasters } from '../src/shared/layoutMasters.js';

/**
 * Property fuzz for "apply theme to selected slides": random decks, random
 * adoption options, random rail selections. Whatever the inputs, an apply must
 *  - never throw,
 *  - never touch a slide outside its scope,
 *  - never rewrite deck defaults from a slide-scoped apply,
 *  - be idempotent,
 *  - survive the operation algebra (diff → apply reproduces it, inverse
 *    restores the original — this is what undo, collab and history replay),
 *  - own any background it wrote (a later layout-master sync must not revert
 *    it — the "slide goes back to the old theme" bug).
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T,>(rand: Rand, values: readonly T[]): T => values[Math.floor(rand() * values.length)];
const chance = (rand: Rand, p: number): boolean => rand() < p;

const ROLE_CLASSES = ['role-title', 'role-heading', 'role-body', 'role-caption', null] as const;
const COLORS = ['#e83a30', '#00ff00', '#123456', '#ffffff', '#000', 'rgba(10,20,30,0.5)', 'tomato', null] as const;
const SIZES = ['12px', '30px', '48px', '96px', '140px', null] as const;

function randomText(rand: Rand, id: string): SlideElement {
  const style: Record<string, string> = {};
  const size = pick(rand, SIZES);
  if (size) style['font-size'] = size;
  const color = pick(rand, COLORS);
  if (color) style['color'] = color;
  if (chance(rand, 0.3)) style['font-family'] = 'Comic Sans MS';
  if (chance(rand, 0.2)) style['font-weight'] = '700';
  const role = pick(rand, ROLE_CLASSES);
  const classes = [
    ...(role ? [role] : []),
    ...(chance(rand, 0.2) ? ['placeholder'] : []),
  ];
  return {
    id, type: 'text', x: Math.floor(rand() * 1600), y: Math.floor(rand() * 900),
    w: 200 + Math.floor(rand() * 800), h: 60 + Math.floor(rand() * 300),
    rot: 0, z: 1 + Math.floor(rand() * 20), opacity: 1, class: classes, style,
    html: chance(rand, 0.15) ? 'Hi' : 'A sentence long enough to count as prose.',
    align: 'left', valign: 'top',
  };
}

function randomShape(rand: Rand, id: string): SlideElement {
  return {
    id, type: 'shape', x: Math.floor(rand() * 1600), y: Math.floor(rand() * 900),
    w: 100 + Math.floor(rand() * 500), h: 100 + Math.floor(rand() * 400),
    rot: 0, z: 1 + Math.floor(rand() * 20), opacity: 1, class: [], style: {},
    shape: 'rect', fill: pick(rand, COLORS), stroke: pick(rand, COLORS),
    strokeWidth: 2, radius: 0, path: null, pathSize: null,
    arrowStart: false, arrowEnd: false,
  };
}

function randomDeck(rand: Rand): Deck {
  const deck = emptyDeck('Fuzz');
  if (chance(rand, 0.5)) deck.layoutMasters = defaultLayoutMasters();
  const slideCount = 1 + Math.floor(rand() * 5);
  deck.slides = Array.from({ length: slideCount }, (_, slideAt): Slide => {
    const elementCount = Math.floor(rand() * 5);
    const elements = Array.from({ length: elementCount }, (_, elementAt) =>
      chance(rand, 0.7)
        ? randomText(rand, `s${slideAt}-t${elementAt}`)
        : randomShape(rand, `s${slideAt}-o${elementAt}`));
    const slide: Slide = {
      id: `s${slideAt}`, name: `Slide ${slideAt}`,
      background: chance(rand, 0.4)
        ? { color: pick(rand, ['#101010', '#fffaf2', '#abcdef']), image: null }
        : { color: null, image: null },
      notes: '', elements, timeline: [],
    };
    if (chance(rand, 0.4)) slide.layout = pick(rand, ['freeform', 'standard', 'title'] as const);
    if (chance(rand, 0.5)) slide.layoutBackgroundInherited = chance(rand, 0.5);
    return slide;
  });
  return deck;
}

function randomAdoption(rand: Rand): ThemeAdoption {
  const allRoles: ThemeTextRole[] = ['title', 'heading', 'body', 'caption', 'base'];
  return {
    scope: pick(rand, ['slides', 'slides', 'slides', 'slide', 'selection', 'deck'] as const satisfies readonly ThemeScope[]),
    roles: allRoles.filter(() => chance(rand, 0.6)),
    fontFamily: chance(rand, 0.7),
    fontWeight: chance(rand, 0.6),
    typeScale: chance(rand, 0.4),
    textColor: chance(rand, 0.4),
    background: chance(rand, 0.4),
    objectColors: chance(rand, 0.4),
    replaceOverrides: chance(rand, 0.7),
    detectRoles: chance(rand, 0.3),
  };
}

const json = (value: unknown) => JSON.stringify(value);

describe('adoptThemeStyles fuzz', () => {
  it('holds its invariants across 300 random decks, options and selections', () => {
    for (let iteration = 0; iteration < 300; iteration++) {
      const rand = mulberry32(0xbeef + iteration);
      const deck = randomDeck(rand);
      // Derived dark/light variants are applied through the same pipeline.
      const theme = chance(rand, 0.3)
        ? themeVariant(pick(rand, THEMES), pick(rand, ['light', 'dark'] as const))
        : pick(rand, THEMES);
      const options = randomAdoption(rand);
      const slideIndex = Math.floor(rand() * (deck.slides.length + 1)) - (chance(rand, 0.1) ? 1 : 0);
      const selectedSlideIds = new Set(
        deck.slides.filter(() => chance(rand, 0.5)).map((slide) => slide.id),
      );
      if (chance(rand, 0.1)) selectedSlideIds.add('no-such-slide');
      const elementSelection = new Set(
        deck.slides.flatMap((slide) => slide.elements)
          .filter(() => chance(rand, 0.3))
          .map((element) => element.id),
      );

      const label = `iteration ${iteration} (theme ${theme.id}, scope ${options.scope})`;
      const before = structuredClone(deck) as Deck;
      const apply = (target: Deck) => adoptThemeStyles(
        target, theme, structuredClone(options), slideIndex,
        new Set(elementSelection), new Set(selectedSlideIds),
      );
      expect(() => apply(deck), label).not.toThrow();

      // Scope containment: slides outside the scope are untouched.
      const touchable = new Set(
        options.scope === 'deck' || options.scope === 'selection'
          ? deck.slides.map((slide) => slide.id)
          : options.scope === 'slides'
            ? [...selectedSlideIds]
            : [deck.slides[slideIndex]?.id].filter(Boolean) as string[],
      );
      for (const [at, slide] of deck.slides.entries()) {
        if (touchable.has(slide.id)) continue;
        expect(json(slide), `${label}: untouched slide ${slide.id}`).toBe(json(before.slides[at]));
      }

      // Slide-scoped applies never rewrite the deck defaults.
      if (options.scope !== 'deck') {
        expect(json(deck.themeStyle), label).toBe(json(before.themeStyle));
        expect(deck.themePreset, label).toBe(before.themePreset);
      }

      // Structure is preserved: same slides, same elements, same kinds.
      expect(deck.slides.map((slide) => slide.id), label)
        .toEqual(before.slides.map((slide) => slide.id));
      for (const [at, slide] of deck.slides.entries()) {
        expect(slide.elements.map((element) => `${element.id}:${element.type}`), label)
          .toEqual(before.slides[at].elements.map((element) => `${element.id}:${element.type}`));
      }

      // A written background belongs to the slide: the theme colour is there
      // and a later layout-master sync must not revert it.
      if (options.background && (options.scope === 'slides' || options.scope === 'slide' || options.scope === 'deck')) {
        for (const slide of deck.slides) {
          if (!touchable.has(slide.id)) continue;
          expect(slide.background, `${label}: background of ${slide.id}`)
            .toEqual({ color: theme.colors.background, image: null });
        }
        const synced = structuredClone(deck) as Deck;
        syncDeckWithLayoutMasters(synced);
        for (const slide of synced.slides) {
          if (!touchable.has(slide.id)) continue;
          expect(slide.background.color, `${label}: background of ${slide.id} after master sync`)
            .toBe(theme.colors.background);
        }
      }

      // Idempotence: applying the same theme with the same options again
      // changes nothing.
      const once = structuredClone(deck) as Deck;
      apply(deck);
      expect(json(deck), `${label}: idempotence`).toBe(json(once));

      // The operation algebra reproduces the apply and its undo — what
      // history, collab and undo/redo actually replay.
      // Deep equality, not JSON strings: op replay rebuilds objects with a
      // different key order, which diffDecks documents as non-load-bearing.
      const forward = diffDecks(before, once);
      expect(applyAgentOperations(before, forward), `${label}: diff replay`).toEqual(once);
      const inverse = diffDecks(once, before);
      expect(applyAgentOperations(once, inverse), `${label}: diff undo`).toEqual(before);

      // Shape colours land on the palette (or stay put for non-hex colours).
      if (options.objectColors) {
        for (const slide of deck.slides) {
          if (!touchable.has(slide.id)) continue;
          for (const element of slide.elements) {
            if (element.type !== 'shape') continue;
            if (options.scope === 'selection' && !elementSelection.has(element.id)) continue;
            const original = before.slides.find((candidate) => candidate.id === slide.id)!
              .elements.find((candidate) => candidate.id === element.id)!;
            for (const key of ['fill', 'stroke'] as const) {
              const value = element[key];
              const was = (original as typeof element)[key];
              if (value === null) { expect(was, label).toBeNull(); continue; }
              expect(
                theme.palette.includes(value) || value === was,
                `${label}: shape ${element.id} ${key} ${value}`,
              ).toBe(true);
            }
          }
        }
      }
    }
  });
});
