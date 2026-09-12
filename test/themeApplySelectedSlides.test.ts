// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import type { Deck, Slide, SlideElement } from '../src/shared/deck.js';
import {
  STOCK_STYLESHEET_STYLE,
  THEMES,
  type ThemeAdoption,
  adoptThemeStyles,
} from '../src/shared/themes.js';
import { syncDeckWithLayoutMasters, defaultLayoutMasters } from '../src/shared/layoutMasters.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { createThemePanel } from '../src/renderer/editor/themePanel.js';
import type { CssEditor } from '../src/renderer/editor/cssEditor.js';

/**
 * "Apply theme to selected slides" — the exact user gesture: pick slides in
 * the rail, tick properties, press Apply, then keep editing. The apply installs
 * what it adopted into the deck defaults (theme.css); the selected slides then
 * *follow* theme.css, carrying no copy of those properties, while every other
 * slide is pinned inline at exactly what it rendered at before. That state has
 * to survive switching slides, layout-master syncs, undo/redo, and a
 * save/reload round-trip.
 */

const STOCK = STOCK_STYLESHEET_STYLE;

/** A slide with its styling taken off: what an apply must never touch outside its scope. */
const withoutStyling = (slide: Slide) => JSON.stringify({
  ...slide,
  background: undefined,
  layoutBackgroundInherited: undefined,
  elements: slide.elements.map((el) => ({ ...el, style: undefined })),
});

const FULL_APPLY: ThemeAdoption = {
  scope: 'slides',
  roles: ['title', 'heading', 'body', 'caption'],
  fontFamily: true,
  fontWeight: true,
  typeScale: true,
  textColor: true,
  background: true,
  objectColors: true,
  replaceOverrides: true,
  detectRoles: false,
};

function textEl(id: string, classes: string[], style: Record<string, string>, html = 'Words on a slide'): SlideElement {
  return {
    id, type: 'text', x: 100, y: 100, w: 800, h: 120, rot: 0, z: 1,
    opacity: 1, class: classes, style, html, align: 'left', valign: 'top',
  };
}

function shapeEl(id: string, fill: string | null, stroke: string | null): SlideElement {
  return {
    id, type: 'shape', x: 100, y: 400, w: 300, h: 200, rot: 0, z: 3,
    opacity: 1, class: [], style: {}, shape: 'rect', fill,
    stroke, strokeWidth: 2, radius: 0, path: null, pathSize: null,
    arrowStart: false, arrowEnd: false,
  };
}

function slideOf(id: string, elements: SlideElement[]): Slide {
  return {
    id, name: id, background: { color: null, image: null },
    notes: '', elements, timeline: [],
  };
}

/** Three slides: role-tagged text, untagged text, and a shape. */
function threeSlideDeck(): Deck {
  const deck = emptyDeck('Selected slides');
  deck.slides = [
    slideOf('s1', [
      textEl('s1-title', ['role-title'], { 'font-size': '96px', color: '#123456' }),
      textEl('s1-body', ['role-body'], {}),
    ]),
    slideOf('s2', [
      textEl('s2-title', ['role-title'], { 'font-size': '90px' }),
      textEl('s2-plain', [], { 'font-size': '40px', color: '#ff0000' }),
      shapeEl('s2-box', '#e83a30', '#00ff00'),
    ]),
    slideOf('s3', [
      textEl('s3-caption', ['role-caption'], { color: '#999999' }),
    ]),
  ];
  return deck;
}

describe('adoptThemeStyles at slides scope', () => {
  it('installs every requested property, clears it from the selected slides and pins the others', () => {
    const deck = threeSlideDeck();
    const theme = THEMES.find((candidate) => candidate.id === 'noir')!;
    const before = structuredClone(deck.slides);

    adoptThemeStyles(deck, theme, { ...FULL_APPLY }, 0, new Set(), new Set(['s2']));

    // The deck defaults are the stock stylesheet with the adopted cells replaced.
    expect(deck.themePreset).toBe('noir');
    for (const role of ['title', 'heading', 'body', 'caption'] as const) {
      expect(deck.themeStyle!.fonts[role]).toEqual({
        ...theme.fonts[role], color: theme.fonts[role].color ?? theme.colors.text,
      });
    }
    expect(deck.themeStyle!.fonts.base).toEqual(STOCK.fonts.base);
    expect(deck.themeStyle!.palette).toEqual(theme.palette);
    expect(deck.themeStyle!.colors).toEqual({
      background: theme.colors.background, accent: theme.colors.accent, muted: theme.colors.muted,
      // `base` was not in the role list, so the ground text colour is still the stock one.
      text: STOCK.colors.text,
    });

    // Unselected slides render exactly as before: everything they were taking
    // from the stock stylesheet that theme.css no longer says is pinned inline,
    // and nothing else about them changes.
    expect(withoutStyling(deck.slides[0])).toBe(withoutStyling(before[0]));
    expect(withoutStyling(deck.slides[2])).toBe(withoutStyling(before[2]));
    for (const at of [0, 2]) {
      expect(deck.slides[at].background).toEqual({ color: STOCK.colors.background, image: null });
      expect(deck.slides[at].layoutBackgroundInherited).toBe(false);
    }
    expect(deck.slides[0].elements[0].style).toEqual({
      'font-size': '96px', color: '#123456',
      'font-family': STOCK.fonts.title.family, 'line-height': '1.28', 'letter-spacing': '-0.02em',
    });
    expect(deck.slides[0].elements[1].style).toEqual({
      'font-family': STOCK.fonts.body.family, 'font-size': '48px', 'line-height': '1.3',
      'letter-spacing': 'normal', color: STOCK.colors.text,
    });
    expect(deck.slides[2].elements[0].style).toEqual({
      color: '#999999',
      'font-family': STOCK.fonts.caption.family, 'font-weight': '400', 'font-size': '30px',
      'letter-spacing': 'normal',
    });

    // The selected slide follows theme.css: no copy of anything adopted.
    const s2 = deck.slides[1];
    expect(s2.background).toEqual({ color: null, image: null });
    expect(s2.layoutBackgroundInherited).toBe(false);
    const title = s2.elements.find((el) => el.id === 's2-title')!;
    expect(title.style).toEqual({});
    // Untagged text is `base`, outside the role list: left exactly as it was.
    expect(s2.elements.find((el) => el.id === 's2-plain')!.style)
      .toEqual({ 'font-size': '40px', color: '#ff0000' });
    // Shape colours that are nobody's swatch are the author's own and stay.
    const box = s2.elements.find((el) => el.id === 's2-box')!;
    expect(box.type).toBe('shape');
    if (box.type === 'shape') {
      expect(box.fill).toBe('#e83a30');
      expect(box.stroke).toBe('#00ff00');
    }
  });

  it('hands an applied background to theme.css, and off the layout master', () => {
    const deck = threeSlideDeck();
    deck.layoutMasters = defaultLayoutMasters();
    // The slide follows its master's background, as any layout-created slide does.
    applySlideLayout(deck.slides[1], 'standard', deck.layoutMasters);
    expect(deck.slides[1].layoutBackgroundInherited).toBe(true);

    const theme = THEMES.find((candidate) => candidate.id === 'noir')!;
    adoptThemeStyles(deck, theme, { ...FULL_APPLY }, 0, new Set(), new Set(['s2']));

    // The ground is `.slide { background }` in theme.css now, which paints the theme colour.
    expect(deck.slides[1].background).toEqual({ color: null, image: null });
    expect(deck.themeStyle!.colors.background).toBe(theme.colors.background);
    // Following theme.css is an explicit author choice on this slide; leaving
    // the inherited flag up hands the ground back to the master on the next sync.
    expect(deck.slides[1].layoutBackgroundInherited).toBe(false);
  });

  it('keeps an applied background through a layout-master sync', () => {
    const deck = threeSlideDeck();
    deck.layoutMasters = defaultLayoutMasters();
    applySlideLayout(deck.slides[1], 'standard', deck.layoutMasters);

    const theme = THEMES.find((candidate) => candidate.id === 'noir')!;
    adoptThemeStyles(deck, theme, { ...FULL_APPLY }, 0, new Set(), new Set(['s2']));
    expect(deck.slides[1].background).toEqual({ color: null, image: null });

    // Editing any layout master re-syncs every slide (designWorkspace "Done").
    // The slide the author just handed to theme.css must not take the
    // master's ground back — this is the "slide goes back to the old theme" report.
    syncDeckWithLayoutMasters(deck);
    expect(deck.slides[1].background).toEqual({ color: null, image: null });
    expect(deck.slides[1].layoutBackgroundInherited).toBe(false);
  });

  it('records which theme was applied and installs it so new slides can follow it', () => {
    const deck = threeSlideDeck();
    const theme = THEMES.find((candidate) => candidate.id === 'salon')!;
    adoptThemeStyles(deck, theme, { ...FULL_APPLY }, 0, new Set(), new Set(['s1', 's3']));
    expect(deck.themeSelection?.preset).toBe('salon');
    // A slides-scope apply installs what it adopted as the deck defaults.
    expect(deck.themePreset).toBe('salon');
    expect(deck.themeStyle!.fonts.title.family).toBe(theme.fonts.title.family);
    expect(deck.themeStyle!.colors.background).toBe(theme.colors.background);
  });

  it('does not record a theme when every property was left unticked', () => {
    const deck = threeSlideDeck();
    const theme = THEMES.find((candidate) => candidate.id === 'salon')!;
    const before = JSON.stringify(deck);
    adoptThemeStyles(deck, theme, {
      ...FULL_APPLY,
      fontFamily: false, fontWeight: false, typeScale: false,
      textColor: false, background: false, objectColors: false,
    }, 0, new Set(), new Set(['s1', 's2', 's3']));
    expect(JSON.stringify(deck)).toBe(before);
  });

  /**
   * Characterization of the panel defaults, kept here because it is the most
   * common way "apply theme to selected slides" looks broken: with the
   * default options (no role detection, `base` not in the role list), text
   * that carries no role-* class — every box made with the Text tool — is
   * skipped entirely, and since `base` is not adopted either, theme.css still
   * gives it the same family: the apply changes nothing visible on such a slide.
   */
  it('skips untagged text unless role detection is on (panel default)', () => {
    const deck = threeSlideDeck();
    const theme = THEMES.find((candidate) => candidate.id === 'hacker')!;
    const panelDefaults: ThemeAdoption = {
      ...FULL_APPLY, typeScale: false, textColor: false,
      background: false, objectColors: false, detectRoles: false,
    };
    adoptThemeStyles(deck, theme, { ...panelDefaults }, 0, new Set(), new Set(['s2']));
    const plain = deck.slides[1].elements.find((el) => el.id === 's2-plain')!;
    expect(plain.class).toEqual([]);
    expect(plain.style).toEqual({ 'font-size': '40px', color: '#ff0000' });
    expect(deck.themeStyle!.fonts.base).toEqual(STOCK.fonts.base);

    // With detection on it is classed into a role the theme now styles, and
    // follows theme.css for that role's family and weight.
    adoptThemeStyles(deck, theme, { ...panelDefaults, detectRoles: true }, 0, new Set(), new Set(['s2']));
    const detected = deck.slides[1].elements.find((el) => el.id === 's2-plain')!;
    const role = detected.class.find((name) => name.startsWith('role-'))?.slice(5) as 'title' | 'heading' | 'body' | 'caption' | 'base' | undefined;
    expect(role).toBeDefined();
    expect(detected.style['font-family']).toBeUndefined();
    expect(detected.style['font-weight']).toBeUndefined();
    expect(deck.themeStyle!.fonts[role!].family).toBe(theme.fonts[role!].family);
  });
});

describe('apply theme through the editor store', () => {
  it('survives switching away from the slide and back', () => {
    const store = new EditorStore(threeSlideDeck(), '/tmp/theme-apply');
    const theme = THEMES.find((candidate) => candidate.id === 'noir')!;
    store.selectSlide(1);
    store.commit((deck) => adoptThemeStyles(
      deck, theme, { ...FULL_APPLY }, 1, new Set(), new Set(['s2']),
    ));

    store.selectSlide(0);
    store.selectSlide(1);
    const { deck } = store.get();
    const s2 = deck.slides[1];
    expect(s2.background).toEqual({ color: null, image: null });
    expect(s2.elements.find((el) => el.id === 's2-title')!.style['font-family']).toBeUndefined();
    expect(deck.themeStyle!.colors.background).toBe(theme.colors.background);
    expect(deck.themeStyle!.fonts.title.family).toBe(theme.fonts.title.family);
  });

  it('undoes and redoes as one step, restoring the exact previous state', () => {
    const store = new EditorStore(threeSlideDeck(), '/tmp/theme-apply');
    const before = structuredClone(store.get().deck);
    const theme = THEMES.find((candidate) => candidate.id === 'poster')!;
    store.commit((deck) => adoptThemeStyles(
      deck, theme, { ...FULL_APPLY }, 0, new Set(), new Set(['s1', 's2']),
    ));
    const applied = structuredClone(store.get().deck);
    expect(applied).not.toEqual(before);

    store.undo();
    expect(store.get().deck).toEqual(before);
    store.redo();
    expect(store.get().deck).toEqual(applied);
  });

  it('round-trips through serialization without losing the apply', () => {
    const store = new EditorStore(threeSlideDeck(), '/tmp/theme-apply');
    const theme = THEMES.find((candidate) => candidate.id === 'phosphor')!;
    store.commit((deck) => adoptThemeStyles(
      deck, theme, { ...FULL_APPLY }, 0, new Set(), new Set(['s2']),
    ));
    const reloaded = JSON.parse(JSON.stringify(store.get().deck)) as Deck;
    expect(reloaded.slides[1].background).toEqual({ color: null, image: null });
    expect(reloaded.themePreset).toBe('phosphor');
    expect(reloaded.themeStyle?.colors.background).toBe(theme.colors.background);
    expect(reloaded.themeSelection?.preset).toBe('phosphor');
  });
});

describe('the theme panel apply button', () => {
  beforeEach(() => document.body.replaceChildren());

  function buildPanel(store: EditorStore) {
    const cssEditor = { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor;
    const saveThemeCss = vi.fn<(css: string) => void>();
    const panel = createThemePanel({
      store,
      cssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss,
    });
    document.body.appendChild(panel.element);
    return Object.assign(panel, { saveThemeCss });
  }

  function setOption(panel: HTMLElement, label: string, checked: boolean): void {
    const box = [...panel.querySelectorAll<HTMLLabelElement>('label.field-check')]
      .find((candidate) => candidate.querySelector('span')?.textContent?.trim().startsWith(label))!;
    const input = box.querySelector<HTMLInputElement>('input')!;
    if (input.checked !== checked) input.click();
  }

  it('applies to the rail selection captured at click time', () => {
    const store = new EditorStore(threeSlideDeck(), '/tmp/theme-panel-apply');
    const panel = buildPanel(store);
    store.selectSlide(0);
    store.selectSlide(2, true); // rail range: s1..s3
    panel.syncScope(store.get().slideSelection.size);
    expect(panel.applyButtonLabel()).toBe('Apply theme to 3 selected slides');

    setOption(panel.element, 'Type scale', true);
    setOption(panel.element, 'Colour', true);
    panel.element.querySelector<HTMLButtonElement>('.theme-apply-action button')!.click();

    const theme = panel.currentTheme()!;
    const { deck } = store.get();
    // Every selected slide follows theme.css, which the panel rewrote for the theme.
    for (const slide of deck.slides) {
      expect(slide.background).toEqual({ color: null, image: null });
    }
    expect(deck.themeStyle!.colors.background).toBe(theme.colors.background);
    const title = deck.slides[0].elements.find((el) => el.id === 's1-title')!;
    expect(title.style['font-family']).toBeUndefined();
    expect(title.style['font-size']).toBeUndefined();
    expect(deck.themeStyle!.fonts.title.family).toBe(theme.fonts.title.family);
    expect(deck.themeStyle!.fonts.title.size).toBe(theme.fonts.title.size);
    expect(panel.saveThemeCss).toHaveBeenCalledTimes(1);
    const css = panel.saveThemeCss.mock.calls[0][0];
    expect(css).toContain(`background: ${theme.colors.background};`);
    expect(css).toContain(`font-size: ${theme.fonts.title.size}px`);
  });

  it('applies to the single current slide when only it is selected', () => {
    const store = new EditorStore(threeSlideDeck(), '/tmp/theme-panel-apply');
    const panel = buildPanel(store);
    store.selectSlide(1);
    panel.syncScope(store.get().slideSelection.size);
    expect(panel.applyButtonLabel()).toBe('Apply theme to 1 selected slide');

    setOption(panel.element, 'Colour', true);
    panel.element.querySelector<HTMLButtonElement>('.theme-apply-action button')!.click();

    const theme = panel.currentTheme()!;
    const { deck } = store.get();
    // The selected slide follows theme.css; the others are pinned at the stock ground.
    expect(deck.slides[1].background).toEqual({ color: null, image: null });
    expect(deck.themeStyle!.colors.background).toBe(theme.colors.background);
    expect(deck.slides[0].background.color).toBe(STOCK.colors.background);
    expect(deck.slides[2].background.color).toBe(STOCK.colors.background);

    // Switching away and back does not shed the apply.
    store.selectSlide(2);
    store.selectSlide(1);
    expect(store.get().deck.slides[1].background).toEqual({ color: null, image: null });
    expect(store.get().deck.themeStyle!.colors.background).toBe(theme.colors.background);
  });

  it('keeps a single-slide apply working after a multi-selection collapses', () => {
    const store = new EditorStore(threeSlideDeck(), '/tmp/theme-panel-apply');
    const panel = buildPanel(store);
    store.selectSlide(0);
    store.selectSlide(2, true);
    panel.syncScope(3);
    store.selectSlide(1); // collapse back to one slide
    panel.syncScope(1);

    setOption(panel.element, 'Colour', true);
    panel.element.querySelector<HTMLButtonElement>('.theme-apply-action button')!.click();
    const theme = panel.currentTheme()!;
    const { deck } = store.get();
    expect(deck.slides[1].background).toEqual({ color: null, image: null });
    expect(deck.themeStyle!.colors.background).toBe(theme.colors.background);
    expect(deck.slides[0].background.color).toBe(STOCK.colors.background);
  });
});

describe('adoptThemeStyles at slides scope: selection edge cases', () => {
  const noir = () => THEMES.find((candidate) => candidate.id === 'noir')!;

  it('moves nothing on screen when nothing is selected: every slide is pinned where it was', () => {
    const deck = threeSlideDeck();
    const before = structuredClone(deck.slides);
    adoptThemeStyles(deck, noir(), { ...FULL_APPLY }, 0, new Set(), new Set());
    // The theme is installed, so every slide has to be pinned to keep its look.
    expect(deck.themePreset).toBe('noir');
    for (const [at, slide] of deck.slides.entries()) {
      expect(withoutStyling(slide)).toBe(withoutStyling(before[at]));
      expect(slide.background).toEqual({ color: STOCK.colors.background, image: null });
    }
    expect(deck.slides[1].elements[0].style).toEqual({
      'font-size': '90px', 'font-family': STOCK.fonts.title.family,
      'line-height': '1.28', 'letter-spacing': '-0.02em', color: STOCK.colors.text,
    });
  });

  it('restyles every slide when all are selected, identically to naming them one by one', () => {
    const together = threeSlideDeck();
    adoptThemeStyles(together, noir(), { ...FULL_APPLY }, 0, new Set(), new Set(['s1', 's2', 's3']));
    const oneByOne = threeSlideDeck();
    for (const id of ['s1', 's2', 's3']) {
      adoptThemeStyles(oneByOne, noir(), { ...FULL_APPLY }, 0, new Set(), new Set([id]));
    }
    expect(together.slides).toEqual(oneByOne.slides);
    expect(together.themeStyle).toEqual(oneByOne.themeStyle);
    for (const slide of together.slides) {
      expect(slide.background).toEqual({ color: null, image: null });
      for (const el of slide.elements) {
        if (el.type === 'text' && el.class.some((name) => name.startsWith('role-'))) {
          expect(el.style['font-family']).toBeUndefined();
        }
      }
    }
    expect(together.themeStyle!.colors.background).toBe(noir().colors.background);
  });

  it('ignores ids of slides that no longer exist and still restyles the ones that do', () => {
    const deck = threeSlideDeck();
    const before = structuredClone(deck.slides);
    expect(() => adoptThemeStyles(
      deck, noir(), { ...FULL_APPLY }, 0, new Set(), new Set(['deleted-slide', 's3', 'also-gone']),
    )).not.toThrow();
    // The slides not named are pinned, not restyled.
    expect(withoutStyling(deck.slides[0])).toBe(withoutStyling(before[0]));
    expect(withoutStyling(deck.slides[1])).toBe(withoutStyling(before[1]));
    expect(deck.slides[0].background.color).toBe(STOCK.colors.background);
    expect(deck.slides[1].background.color).toBe(STOCK.colors.background);
    expect(deck.slides[2].background).toEqual({ color: null, image: null });
    // Colour was adopted too, so the target caption carries nothing of its own now.
    expect(deck.slides[2].elements[0].style).toEqual({});
    // Nothing was added for the ghosts.
    expect(deck.slides.map((slide) => slide.id)).toEqual(['s1', 's2', 's3']);
  });

  it('does not depend on slideIndex when a rail selection is given', () => {
    const deck = threeSlideDeck();
    // An out-of-range current index (slide deleted underneath the panel) is harmless.
    adoptThemeStyles(deck, noir(), { ...FULL_APPLY }, 99, new Set(), new Set(['s1']));
    expect(deck.slides[0].background).toEqual({ color: null, image: null });
    expect(deck.slides[1].background.color).toBe(STOCK.colors.background);
    // Single-slide scope with an index past the end targets no slide and does
    // not throw: the theme is installed and every slide pinned where it was.
    const single = threeSlideDeck();
    const before = structuredClone(single.slides);
    expect(() => adoptThemeStyles(
      single, noir(), { ...FULL_APPLY, scope: 'slide' }, 3, new Set(), new Set(),
    )).not.toThrow();
    expect(single.themePreset).toBe('noir');
    for (const [at, slide] of single.slides.entries()) {
      expect(withoutStyling(slide)).toBe(withoutStyling(before[at]));
      expect(slide.background.color).toBe(STOCK.colors.background);
    }
  });
});
