import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import type { Deck, Slide, SlideElement } from '../src/shared/deck.js';
import {
  THEMES,
  type ThemeAdoption,
  type ThemeScope,
  type ThemeTextRole,
  adoptThemeStyles,
  effectiveThemeStyle,
  themeStyleOf,
  themeVariant,
} from '../src/shared/themes.js';
import type { ThemeStyle } from '../src/shared/deck.js';
import { applyAgentOperations } from '../src/shared/agent.js';
import { diffDecks } from '../src/shared/deckDiff.js';
import { defaultLayoutMasters, syncDeckWithLayoutMasters } from '../src/shared/layoutMasters.js';

/**
 * Property fuzz for "apply theme to selected slides": random decks, random
 * adoption options, random rail selections. Whatever the inputs, an apply must
 *  - never throw,
 *  - install exactly what it adopted into the deck defaults (theme.css) and
 *    nothing else,
 *  - change nothing *visible* outside its scope: a box outside the scope
 *    renders at the same effective value before and after -- its own inline
 *    value, or, when it followed the stylesheet, the value the old stylesheet
 *    gave it (now pinned inline),
 *  - leave its targets carrying no copy of the adopted properties, so they
 *    follow theme.css,
 *  - be idempotent,
 *  - survive the operation algebra (diff → apply reproduces it, inverse
 *    restores the original — this is what undo, collab and history replay),
 *  - hand a target slide's ground to theme.css (a later layout-master sync
 *    must not take it back — the "slide goes back to the old theme" bug).
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
  const html = chance(rand, 0.15)
    ? 'Hi'
    : chance(rand, 0.3)
      ? 'A sentence <span style="font-size: 24px; color: #ff00ff">with a run</span> of its <em style=\'font-size: 0.7em\'>own</em>.'
      : 'A sentence long enough to count as prose.';
  const el: SlideElement = {
    id, type: 'text', x: Math.floor(rand() * 1600), y: Math.floor(rand() * 900),
    w: 200 + Math.floor(rand() * 800), h: 60 + Math.floor(rand() * 300),
    rot: 0, z: 1 + Math.floor(rand() * 20), opacity: 1, class: classes, style,
    html, align: 'left', valign: 'top',
  };
  if (chance(rand, 0.2)) el.contentStyle = { color: '#00aa00' };
  return el;
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

type TextElement = Extract<SlideElement, { type: 'text' }>;
const ADOPTABLE = ['font-family', 'font-weight', 'font-size', 'line-height', 'letter-spacing', 'color'] as const;

function roleOf(el: SlideElement): ThemeTextRole {
  const found = el.class.find((name) => /^role-(title|heading|body|caption|base)$/.test(name));
  return (found?.slice(5) as ThemeTextRole | undefined) ?? 'base';
}

/** What a box renders at for `property`: its own value, else the stylesheet's. */
function effective(el: TextElement, style: ThemeStyle, property: string): string | undefined {
  const inline = el.style[property] ?? el.contentStyle?.[property];
  if (inline !== undefined) return inline;
  const role = roleOf(el);
  const font = style.fonts[role];
  switch (property) {
    case 'font-family': return font.family;
    case 'font-weight': return String(font.weight);
    // A base box's size and leading come from `.element-text`, not theme.css.
    case 'font-size': return role === 'base' ? undefined : `${font.size}px`;
    case 'line-height': return role === 'base' ? undefined : String(font.lineHeight);
    case 'letter-spacing': return font.letterSpacing;
    case 'color': return font.color ?? (role === 'caption' ? style.colors.muted : style.colors.text);
    default: throw new Error(property);
  }
}

/** The properties an adoption clears from its targets and installs into the defaults. */
function adoptedProperties(options: ThemeAdoption): string[] {
  const properties: string[] = [];
  if (options.fontFamily) properties.push('font-family');
  if (options.fontWeight) properties.push('font-weight');
  if (options.typeScale) properties.push('font-size', 'line-height', 'letter-spacing');
  if (options.textColor) properties.push('color');
  return properties;
}

/** The deck defaults an adoption should leave behind: the previous ones with the adopted cells replaced. */
function mergedDefaults(previous: ThemeStyle, theme: ThemePresetLike, options: ThemeAdoption): ThemeStyle {
  const source = themeStyleOf(theme);
  const next = structuredClone(previous);
  for (const role of options.roles) {
    if (options.fontFamily) next.fonts[role].family = source.fonts[role].family;
    if (options.fontWeight) next.fonts[role].weight = source.fonts[role].weight;
    if (options.typeScale) {
      next.fonts[role].size = source.fonts[role].size;
      next.fonts[role].lineHeight = source.fonts[role].lineHeight;
      next.fonts[role].letterSpacing = source.fonts[role].letterSpacing;
    }
    if (options.textColor) next.fonts[role].color = source.fonts[role].color ?? source.colors.text;
  }
  if (options.textColor && options.roles.includes('base')) next.colors.text = source.colors.text;
  if (options.textColor && options.roles.includes('caption')) next.colors.muted = source.colors.muted;
  if (options.background) next.colors.background = source.colors.background;
  if (options.objectColors) {
    next.palette = [...source.palette];
    next.colors.accent = source.colors.accent;
  }
  return next;
}
type ThemePresetLike = Parameters<typeof themeStyleOf>[0];

const withoutStyling = (slide: Slide) => json({
  ...slide,
  background: undefined,
  layoutBackgroundInherited: undefined,
  elements: slide.elements.map((el) => ({ ...el, style: undefined, contentStyle: undefined })),
});

describe('adoptThemeStyles fuzz', () => {
  it('holds its invariants across 300 random decks, options and selections', () => {
    for (let iteration = 0; iteration < 300; iteration++) {
      const rand = mulberry32(0xbeef + iteration);
      const deck = randomDeck(rand);
      // Some decks already wear composed defaults; the rest sit on the stock stylesheet.
      if (chance(rand, 0.3)) {
        const worn = pick(rand, THEMES);
        deck.themePreset = worn.id;
        deck.themeStyle = themeStyleOf(worn);
      }
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
      const previousStyle = structuredClone(effectiveThemeStyle(before));
      const apply = (target: Deck) => adoptThemeStyles(
        target, theme, structuredClone(options), slideIndex,
        new Set(elementSelection), new Set(selectedSlideIds),
      );
      expect(() => apply(deck), label).not.toThrow();

      const adoptedAnything = options.fontFamily || options.fontWeight || options.typeScale
        || options.textColor || options.background || options.objectColors;
      const adopted = adoptedProperties(options);

      // Scope: the slides whose boxes were asked to move.
      const scoped = new Set(
        options.scope === 'deck'
          ? deck.slides.map((slide) => slide.id)
          : options.scope === 'slides'
            ? [...selectedSlideIds]
            : [deck.slides[slideIndex]?.id].filter(Boolean) as string[],
      );
      const isTarget = (slide: Slide, el: SlideElement): boolean =>
        scoped.has(slide.id) && (options.scope !== 'selection' || elementSelection.has(el.id));

      // The deck defaults are exactly the previous ones with the adopted cells replaced.
      if (adoptedAnything) {
        expect(deck.themeStyle, label).toEqual(mergedDefaults(previousStyle, theme, options));
        expect(deck.themePreset, label).toBe(theme.id);
      } else {
        expect(json(deck.themeStyle), label).toBe(json(before.themeStyle));
        expect(deck.themePreset, label).toBe(before.themePreset);
        expect(json(deck), `${label}: nothing adopted is a no-op`).toBe(json(before));
      }
      const nextStyle = effectiveThemeStyle(deck);

      // Structure is preserved: same slides, same elements, same kinds; and
      // everything but styling is untouched outside the scope.
      expect(deck.slides.map((slide) => slide.id), label)
        .toEqual(before.slides.map((slide) => slide.id));
      for (const [at, slide] of deck.slides.entries()) {
        expect(slide.elements.map((element) => `${element.id}:${element.type}`), label)
          .toEqual(before.slides[at].elements.map((element) => `${element.id}:${element.type}`));
        if (!scoped.has(slide.id)) {
          expect(withoutStyling(slide), `${label}: untouched slide ${slide.id}`).toBe(withoutStyling(before.slides[at]));
        }
      }

      // Nothing outside the scope changes on screen: every non-target box
      // renders at the value it rendered at before, and so does every
      // non-target slide's ground. (A selected element on another slide is
      // left on the cascade on purpose and is the one exception.)
      for (const [at, slide] of deck.slides.entries()) {
        const was = before.slides[at];
        if (!scoped.has(slide.id) && was.background.image === null) {
          expect(slide.background.color ?? nextStyle.colors.background, `${label}: ground of ${slide.id}`)
            .toBe(was.background.color ?? previousStyle.colors.background);
        }
        for (const [elAt, el] of slide.elements.entries()) {
          const original = was.elements[elAt] as TextElement;
          if (el.type !== 'text' || isTarget(slide, el)) continue;
          if (options.scope === 'selection' && elementSelection.has(el.id)) continue;
          for (const property of ADOPTABLE) {
            expect(effective(el, nextStyle, property), `${label}: ${el.id} ${property}`)
              .toBe(effective(original, previousStyle, property));
          }
          // A pin is only ever written where the box had nothing of its own.
          for (const property of Object.keys(el.style)) {
            if (original.style[property] !== undefined) {
              expect(el.style[property], `${label}: ${el.id} own ${property}`).toBe(original.style[property]);
            }
          }
          expect(json(el.contentStyle), `${label}: ${el.id} contentStyle`).toBe(json(original.contentStyle));
          expect(el.html, `${label}: ${el.id} html`).toBe(original.html);
        }
      }

      // Targets follow theme.css: no copy of an adopted property at any level,
      // except a relative run size, which scales with the box and stays.
      for (const slide of deck.slides) {
        for (const el of slide.elements) {
          if (el.type !== 'text' || !isTarget(slide, el)) continue;
          if (!options.replaceOverrides || !options.roles.includes(roleOf(el))) continue;
          for (const property of adopted) {
            expect(el.style[property], `${label}: target ${el.id} style ${property}`).toBeUndefined();
            expect(el.contentStyle?.[property], `${label}: target ${el.id} contentStyle ${property}`).toBeUndefined();
            const runs = [...el.html.matchAll(/style\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
              .flatMap((m) => (m[1] ?? m[2]).split(';').map((d) => d.trim()).filter(Boolean));
            for (const run of runs) {
              const [name, value] = run.split(':').map((part) => part.trim());
              if (name !== property) continue;
              expect(property === 'font-size' && /(em|%)$/.test(value), `${label}: target ${el.id} run ${run}`).toBe(true);
            }
          }
        }
      }

      // A target slide's ground is theme.css's now, not the master's: the
      // theme colour renders and a later layout-master sync must not take it back.
      if (options.background && options.scope !== 'selection') {
        for (const slide of deck.slides) {
          if (!scoped.has(slide.id)) continue;
          expect(slide.background, `${label}: background of ${slide.id}`).toEqual({ color: null, image: null });
          expect(slide.layoutBackgroundInherited, `${label}: ${slide.id} inherits`).toBe(false);
        }
        expect(nextStyle.colors.background, label).toBe(theme.colors.background);
        const synced = structuredClone(deck) as Deck;
        syncDeckWithLayoutMasters(synced);
        for (const slide of synced.slides) {
          if (!scoped.has(slide.id)) continue;
          expect(slide.background.color, `${label}: background of ${slide.id} after master sync`).toBeNull();
        }
      }

      // The choice is remembered for the slides yet to be created.
      if (options.scope !== 'selection' && adoptedAnything) {
        expect(deck.themeSelection?.preset, label).toBe(theme.id);
        expect(deck.themeSelection?.roles, label).toEqual(options.roles);
      } else {
        expect(json(deck.themeSelection), label).toBe(json(before.themeSelection));
      }

      // Idempotence: applying the same theme with the same options again
      // changes nothing -- nothing differs, so nothing is pinned.
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
          if (!scoped.has(slide.id)) continue;
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
