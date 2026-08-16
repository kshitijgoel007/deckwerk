import { describe, expect, it } from 'vitest';
import {
  FONT_SETS,
  FONT_BLOCK_END,
  FONT_BLOCK_START,
  deckProseMax,
  fontSetCss,
  roleForElement,
  roleForSize,
  withFontBlock,
} from '../src/shared/fontSets.js';

/**
 * Font sets exist to make an imported deck *consistent*. Keynote gives every
 * text element its own inline size, so a deck looks approximately right and is
 * impossible to restyle. Casting sorts elements into five roles and moves the
 * type into the stylesheet.
 */

describe('role assignment', () => {
  it('sorts sizes into roles by their ratio to the deck maximum', () => {
    const max = 100;
    expect(roleForSize(100, max)).toBe('title');
    expect(roleForSize(90, max)).toBe('title');
    expect(roleForSize(70, max)).toBe('heading');
    expect(roleForSize(45, max)).toBe('body');
    expect(roleForSize(20, max)).toBe('caption');
  });

  it('is scale-invariant, so one deck’s body is not another’s caption', () => {
    // The same relative sizes must land in the same roles whatever the
    // absolute numbers, which is the entire reason ratios are used.
    for (const [size, max] of [
      [96, 96],
      [48, 48],
      [200, 200],
    ] as const) {
      expect(roleForSize(size, max)).toBe('title');
      expect(roleForSize(max * 0.45, max)).toBe('body');
      expect(roleForSize(max * 0.2, max)).toBe('caption');
    }
  });

  it('falls back to the catch-all when there is no size information', () => {
    expect(roleForSize(0, 0)).toBe('base');
  });
});

describe('casting decisions', () => {
  it('lets an explicit role class beat the size heuristic', () => {
    // The importer and the sidebar dropdown both assign role-* classes; a cast
    // that ignored them re-derived everything from sizes and flattened the
    // deck to "body".
    expect(roleForElement(['kn-text', 'role-title'], 40, 100)).toBe('title');
    expect(roleForElement(['role-caption'], 96, 100)).toBe('caption');
  });

  it('falls back to the size ratio for untagged text', () => {
    expect(roleForElement(['kn-text'], 96, 100)).toBe('title');
    expect(roleForElement([], 45, 100)).toBe('body');
  });

  it('excludes decorations from the deck scale', () => {
    // A lone 200px "+" glyph must not become the yardstick that demotes every
    // real 100px title to a heading.
    const max = deckProseMax([
      { html: '+', size: 200 },
      { html: 'A real slide title', size: 100 },
      { html: 'body copy here', size: 40 },
    ]);
    expect(max).toBe(100);
    expect(roleForElement([], 100, max)).toBe('title');
  });

  it('ignores markup when measuring prose length', () => {
    const max = deckProseMax([{ html: '<b>=</b>', size: 300 }, { html: 'Title', size: 90 }]);
    expect(max).toBe(90);
  });
});

describe('generated stylesheet', () => {
  it.each(FONT_SETS.map((s) => [s.name, s] as const))(
    '%s defines every role with a real size',
    (_name, set) => {
      const css = fontSetCss(set);
      for (const role of ['title', 'heading', 'body', 'caption'] as const) {
        expect(css).toContain(`.role-${role}`);
      }
      // The catch-all is applied to the slide itself, not a role class.
      expect(css).toContain('.slide {');

      const sizes = Object.values(set.roles).map((r) => r.size);
      expect(Math.min(...sizes)).toBeGreaterThan(12);
      // Titles must outrank captions, or the hierarchy is meaningless.
      expect(set.roles.title.size).toBeGreaterThan(set.roles.caption.size);
    },
  );

  it('keeps font stacks system-first so a deck renders on any machine', () => {
    // A webfont that fails to load on a conference laptop silently reflows
    // every slide, so each stack has to end in a generic family.
    for (const set of FONT_SETS) {
      for (const role of Object.values(set.roles)) {
        expect(role.family).toMatch(/(sans-serif|serif|monospace)\s*$/);
      }
    }
  });
});

describe('applying a set to a stylesheet', () => {
  const userCss = '.title { color: rebeccapurple; }\n';

  it('inserts a marked block and preserves the existing stylesheet', () => {
    const out = withFontBlock(userCss, fontSetCss(FONT_SETS[0]));
    expect(out).toContain(FONT_BLOCK_START);
    expect(out).toContain(FONT_BLOCK_END);
    expect(out).toContain('rebeccapurple');
  });

  it('replaces the previous block rather than stacking sets', () => {
    const once = withFontBlock(userCss, fontSetCss(FONT_SETS[0]));
    const twice = withFontBlock(once, fontSetCss(FONT_SETS[1]));

    // Exactly one generated block, whichever set was applied last.
    expect(twice.split(FONT_BLOCK_START)).toHaveLength(2);
    expect(twice).toContain(FONT_SETS[1].name);
    expect(twice).not.toContain(FONT_SETS[0].name);
    expect(twice).toContain('rebeccapurple');
  });

  it('survives repeated application without growing', () => {
    let css = userCss;
    for (let i = 0; i < 5; i++) css = withFontBlock(css, fontSetCss(FONT_SETS[2]));
    expect(css.split(FONT_BLOCK_START)).toHaveLength(2);
  });
});
