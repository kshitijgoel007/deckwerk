import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import {
  NO_APPLY,
  THEMES,
  THEME_BLOCK_START,
  applyThemeToDeck,
  nearestPaletteColor,
  themeCss,
  withThemeBlock,
} from '../src/shared/themes.js';
import { alignElements } from '../src/renderer/editor/align.js';
import {
  EditorStore,
  copySelectionToClipboard,
  pasteFromClipboard,
} from '../src/renderer/editor/store.js';

/** A deck with a coloured title, a white label and a red box. */
function sampleDeck() {
  const deck = emptyDeck('T');
  deck.slides[0].elements = [
    {
      id: 't1', type: 'text', x: 0, y: 0, w: 800, h: 100, rot: 0, z: 1,
      opacity: 1, class: [], style: { 'font-size': '96px' },
      html: 'A real slide title', align: 'left', valign: 'top',
    },
    {
      id: 't2', type: 'text', x: 0, y: 200, w: 400, h: 60, rot: 0, z: 2,
      opacity: 1, class: [], style: { 'font-size': '30px', color: '#ffffff' },
      html: 'white label', align: 'left', valign: 'top',
    },
    {
      id: 's1', type: 'shape', x: 100, y: 400, w: 300, h: 200, rot: 0, z: 3,
      opacity: 1, class: [], style: {}, shape: 'rect', fill: '#e83a30',
      stroke: null, strokeWidth: 2, radius: 0, path: null, pathSize: null,
      arrowStart: false, arrowEnd: false,
    },
  ];
  return deck;
}

describe('theme presets', () => {
  it('offers five light themes', () => {
    expect(THEMES).toHaveLength(5);
    for (const t of THEMES) {
      // All light by decision: dark grounds would mean re-editing every figure.
      const bg = t.colors.background;
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(bg.slice(i, i + 2), 16));
      expect((r + g + b) / 3, `${t.name} background is not light`).toBeGreaterThan(200);
      expect(t.palette.length).toBeGreaterThanOrEqual(6);
      expect(t.fonts.title.size).toBeGreaterThan(t.fonts.caption.size);
    }
  });

  it('installing writes a replaceable block', () => {
    const once = withThemeBlock('.mine { color: red; }', themeCss(THEMES[0]));
    const twice = withThemeBlock(once, themeCss(THEMES[1]));
    expect(twice.split(THEME_BLOCK_START)).toHaveLength(2);
    expect(twice).toContain('.mine { color: red; }');
    expect(twice).toContain(THEMES[1].name);
  });
});

describe('applying a theme', () => {
  it('with every option off, changes nothing', () => {
    const deck = sampleDeck();
    const before = JSON.stringify(deck);
    applyThemeToDeck(deck, THEMES[0], NO_APPLY);
    // This IS the omarchy model: install changes what is available, not what
    // exists. Apply-nothing must be a strict no-op.
    expect(JSON.stringify(deck)).toBe(before);
  });

  it('textColors strips inline colours only', () => {
    const deck = sampleDeck();
    applyThemeToDeck(deck, THEMES[0], { ...NO_APPLY, textColors: true });
    const t2 = deck.slides[0].elements.find((e) => e.id === 't2')!;
    expect(t2.style['color']).toBeUndefined();
    // Sizes untouched.
    expect(t2.style['font-size']).toBe('30px');
  });

  it('fontSizes casts to roles and strips sizes', () => {
    const deck = sampleDeck();
    applyThemeToDeck(deck, THEMES[0], { ...NO_APPLY, fontSizes: true });
    const t1 = deck.slides[0].elements.find((e) => e.id === 't1')!;
    expect(t1.class).toContain('role-title');
    expect(t1.style['font-size']).toBeUndefined();
    // Colour untouched: the white label stays white.
    const t2 = deck.slides[0].elements.find((e) => e.id === 't2')!;
    expect(t2.style['color']).toBe('#ffffff');
  });

  it('objectColors remaps shape colours to the palette', () => {
    const deck = sampleDeck();
    const theme = THEMES[3]; // Swiss: has a strong red
    applyThemeToDeck(deck, theme, { ...NO_APPLY, objectColors: true });
    const s1 = deck.slides[0].elements.find((e) => e.id === 's1')!;
    if (s1.type !== 'shape') throw new Error('expected shape');
    expect(theme.palette).toContain(s1.fill);
  });

  it('backgrounds sets the slide ground', () => {
    const deck = sampleDeck();
    applyThemeToDeck(deck, THEMES[2], { ...NO_APPLY, backgrounds: true });
    expect(deck.slides[0].background.color).toBe(THEMES[2].colors.background);
  });
});

describe('nearestPaletteColor', () => {
  it('finds the closest colour', () => {
    expect(nearestPaletteColor('#e83a30', ['#111111', '#e63946', '#ffffff'])).toBe('#e63946');
  });

  it('leaves rgba and names alone so translucency survives', () => {
    expect(nearestPaletteColor('rgba(255, 255, 255, 0.7)', ['#ffffff'])).toBe(
      'rgba(255, 255, 255, 0.7)',
    );
  });
});

describe('align and distribute', () => {
  const rects = [
    { id: 'a', x: 0, y: 0, w: 100, h: 50 },
    { id: 'b', x: 300, y: 120, w: 50, h: 80 },
    { id: 'c', x: 600, y: 40, w: 200, h: 60 },
  ];

  it('aligns left edges', () => {
    const m = alignElements(rects, 'left');
    expect(m.get('b')!.x).toBe(0);
    expect(m.get('c')!.x).toBe(0);
  });

  it('centres vertically as a group', () => {
    const m = alignElements(rects, 'vcenter');
    // Group spans y 0..200, centre 100.
    expect(m.get('a')!.y).toBe(75);
    expect(m.get('b')!.y).toBe(60);
  });

  it('distributes with even gaps, endpoints pinned', () => {
    const m = alignElements(rects, 'distributeH');
    expect(m.get('a')!.x).toBe(0);
    // Total width 350 in span 800 -> gap 225: a[0..100], b[325..375], c[600..800].
    expect(m.get('b')!.x).toBe(325);
    expect(m.get('c')!.x).toBe(600);
  });

  it('matches sizes to the first-selected element', () => {
    const m = alignElements(rects, 'matchW');
    expect(m.get('a')).toBeUndefined();
    expect(m.get('b')!.w).toBe(100);
  });

  it('does nothing for fewer than two elements', () => {
    expect(alignElements([rects[0]], 'left').size).toBe(0);
  });
});

describe('element clipboard', () => {
  it('copies and pastes with fresh ids and an offset', () => {
    const store = new EditorStore(sampleDeck(), '/tmp/x');
    store.select(['t1', 's1']);
    expect(copySelectionToClipboard(store)).toBe(2);

    store.selectSlide(0);
    const created = pasteFromClipboard(store);
    expect(created).toHaveLength(2);

    const slide = store.slide!;
    expect(slide.elements).toHaveLength(5);
    const pasted = slide.elements.find((e) => e.id === created[0])!;
    expect(pasted.x).toBe(24); // original 0 + offset
    expect(created[0]).not.toBe('t1');
  });

  it('pastes onto a different slide', () => {
    const deck = sampleDeck();
    deck.slides.push({
      id: 'slide-2', name: '', background: { color: null, image: null },
      notes: '', elements: [], timeline: [],
    });
    const store = new EditorStore(deck, '/tmp/x');
    store.select(['s1']);
    copySelectionToClipboard(store);
    store.selectSlide(1);
    pasteFromClipboard(store);
    expect(store.get().deck.slides[1].elements).toHaveLength(1);
  });
});
