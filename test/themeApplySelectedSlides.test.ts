// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import type { Deck, Slide, SlideElement } from '../src/shared/deck.js';
import {
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
 * the rail, tick properties, press Apply, then keep editing. What the apply
 * wrote must be the slides' own state: it has to survive switching slides,
 * layout-master syncs, undo/redo, and a save/reload round-trip.
 */

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
  it('applies every requested property to the selected slides and only those', () => {
    const deck = threeSlideDeck();
    const theme = THEMES.find((candidate) => candidate.id === 'noir')!;
    const before = JSON.parse(JSON.stringify(deck.slides));

    adoptThemeStyles(deck, theme, { ...FULL_APPLY }, 0, new Set(), new Set(['s2']));

    // Unselected slides are byte-for-byte untouched.
    expect(deck.slides[0]).toEqual(before[0]);
    expect(deck.slides[2]).toEqual(before[2]);

    const s2 = deck.slides[1];
    expect(s2.background).toEqual({ color: theme.colors.background, image: null });
    const title = s2.elements.find((el) => el.id === 's2-title')!;
    expect(title.style['font-family']).toBe(theme.fonts.title.family);
    expect(title.style['font-weight']).toBe(String(theme.fonts.title.weight));
    expect(title.style['font-size']).toBe(`${theme.fonts.title.size}px`);
    expect(title.style['color']).toBe(theme.colors.text);
    const box = s2.elements.find((el) => el.id === 's2-box')!;
    expect(box.type).toBe('shape');
    if (box.type === 'shape') {
      expect(theme.palette).toContain(box.fill);
      expect(theme.palette).toContain(box.stroke);
    }
  });

  it('marks an applied background as the slide\'s own, not the layout master\'s', () => {
    const deck = threeSlideDeck();
    deck.layoutMasters = defaultLayoutMasters();
    // The slide follows its master's background, as any layout-created slide does.
    applySlideLayout(deck.slides[1], 'standard', deck.layoutMasters);
    expect(deck.slides[1].layoutBackgroundInherited).toBe(true);

    const theme = THEMES.find((candidate) => candidate.id === 'noir')!;
    adoptThemeStyles(deck, theme, { ...FULL_APPLY }, 0, new Set(), new Set(['s2']));

    expect(deck.slides[1].background.color).toBe(theme.colors.background);
    // The theme background is an explicit author choice on this slide; leaving
    // the inherited flag up hands it back to the master on the next sync.
    expect(deck.slides[1].layoutBackgroundInherited).toBe(false);
  });

  it('keeps an applied background through a layout-master sync', () => {
    const deck = threeSlideDeck();
    deck.layoutMasters = defaultLayoutMasters();
    applySlideLayout(deck.slides[1], 'standard', deck.layoutMasters);

    const theme = THEMES.find((candidate) => candidate.id === 'noir')!;
    adoptThemeStyles(deck, theme, { ...FULL_APPLY }, 0, new Set(), new Set(['s2']));
    expect(deck.slides[1].background.color).toBe(theme.colors.background);

    // Editing any layout master re-syncs every slide (designWorkspace "Done").
    // The theme background the author just applied must not revert to the
    // master's — this is the "slide goes back to the old theme" report.
    syncDeckWithLayoutMasters(deck);
    expect(deck.slides[1].background.color).toBe(theme.colors.background);
  });

  it('records which theme was applied so new slides can follow it', () => {
    const deck = threeSlideDeck();
    const theme = THEMES.find((candidate) => candidate.id === 'salon')!;
    adoptThemeStyles(deck, theme, { ...FULL_APPLY }, 0, new Set(), new Set(['s1', 's3']));
    expect(deck.themeSelection?.preset).toBe('salon');
    // Slides-scope applies never rewrite the deck defaults.
    expect(deck.themePreset).toBeNull();
    expect(deck.themeStyle).toBeNull();
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
   * skipped entirely, so the apply changes nothing visible on such a slide.
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
    expect(plain.style['font-family']).toBeUndefined();

    adoptThemeStyles(deck, theme, { ...panelDefaults, detectRoles: true }, 0, new Set(), new Set(['s2']));
    const detected = deck.slides[1].elements.find((el) => el.id === 's2-plain')!;
    expect(detected.class.some((name) => name.startsWith('role-'))).toBe(true);
    expect(detected.style['font-family']).toBeTruthy();
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
    const s2 = store.get().deck.slides[1];
    expect(s2.background.color).toBe(theme.colors.background);
    expect(s2.elements.find((el) => el.id === 's2-title')!.style['font-family'])
      .toBe(theme.fonts.title.family);
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
    expect(reloaded.slides[1].background.color).toBe(theme.colors.background);
    expect(reloaded.themeSelection?.preset).toBe('phosphor');
  });
});

describe('the theme panel apply button', () => {
  beforeEach(() => document.body.replaceChildren());

  function buildPanel(store: EditorStore) {
    const cssEditor = { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor;
    const panel = createThemePanel({
      store,
      cssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
    });
    document.body.appendChild(panel.element);
    return panel;
  }

  function setOption(panel: HTMLElement, label: string, checked: boolean): void {
    const box = [...panel.querySelectorAll<HTMLLabelElement>('label.field-check')]
      .find((candidate) => candidate.querySelector('span')?.textContent === label)!;
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

    setOption(panel.element, 'Size + spacing', true);
    setOption(panel.element, 'Text colour', true);
    setOption(panel.element, 'Slide background', true);
    panel.element.querySelector<HTMLButtonElement>('.theme-apply-action button')!.click();

    const theme = panel.currentTheme()!;
    for (const slide of store.get().deck.slides) {
      expect(slide.background.color).toBe(theme.colors.background);
    }
    const title = store.get().deck.slides[0].elements.find((el) => el.id === 's1-title')!;
    expect(title.style['font-family']).toBe(theme.fonts.title.family);
    expect(title.style['font-size']).toBe(`${theme.fonts.title.size}px`);
  });

  it('applies to the single current slide when only it is selected', () => {
    const store = new EditorStore(threeSlideDeck(), '/tmp/theme-panel-apply');
    const panel = buildPanel(store);
    store.selectSlide(1);
    panel.syncScope(store.get().slideSelection.size);
    expect(panel.applyButtonLabel()).toBe('Apply theme to 1 selected slide');

    setOption(panel.element, 'Slide background', true);
    panel.element.querySelector<HTMLButtonElement>('.theme-apply-action button')!.click();

    const theme = panel.currentTheme()!;
    const { deck } = store.get();
    expect(deck.slides[1].background.color).toBe(theme.colors.background);
    expect(deck.slides[0].background.color).toBeNull();
    expect(deck.slides[2].background.color).toBeNull();

    // Switching away and back does not shed the apply.
    store.selectSlide(2);
    store.selectSlide(1);
    expect(store.get().deck.slides[1].background.color).toBe(theme.colors.background);
  });

  it('keeps a single-slide apply working after a multi-selection collapses', () => {
    const store = new EditorStore(threeSlideDeck(), '/tmp/theme-panel-apply');
    const panel = buildPanel(store);
    store.selectSlide(0);
    store.selectSlide(2, true);
    panel.syncScope(3);
    store.selectSlide(1); // collapse back to one slide
    panel.syncScope(1);

    setOption(panel.element, 'Slide background', true);
    panel.element.querySelector<HTMLButtonElement>('.theme-apply-action button')!.click();
    const theme = panel.currentTheme()!;
    expect(store.get().deck.slides[1].background.color).toBe(theme.colors.background);
    expect(store.get().deck.slides[0].background.color).toBeNull();
  });
});

describe('adoptThemeStyles at slides scope: selection edge cases', () => {
  const noir = () => THEMES.find((candidate) => candidate.id === 'noir')!;

  it('touches no slide when nothing is selected', () => {
    const deck = threeSlideDeck();
    const before = JSON.parse(JSON.stringify(deck.slides));
    adoptThemeStyles(deck, noir(), { ...FULL_APPLY }, 0, new Set(), new Set());
    expect(deck.slides).toEqual(before);
  });

  it('restyles every slide when all are selected, identically to naming them one by one', () => {
    const together = threeSlideDeck();
    adoptThemeStyles(together, noir(), { ...FULL_APPLY }, 0, new Set(), new Set(['s1', 's2', 's3']));
    const oneByOne = threeSlideDeck();
    for (const id of ['s1', 's2', 's3']) {
      adoptThemeStyles(oneByOne, noir(), { ...FULL_APPLY }, 0, new Set(), new Set([id]));
    }
    expect(together.slides).toEqual(oneByOne.slides);
    for (const slide of together.slides) {
      expect(slide.background.color).toBe(noir().colors.background);
    }
  });

  it('ignores ids of slides that no longer exist and still restyles the ones that do', () => {
    const deck = threeSlideDeck();
    const before = JSON.parse(JSON.stringify(deck.slides));
    expect(() => adoptThemeStyles(
      deck, noir(), { ...FULL_APPLY }, 0, new Set(), new Set(['deleted-slide', 's3', 'also-gone']),
    )).not.toThrow();
    expect(deck.slides[0]).toEqual(before[0]);
    expect(deck.slides[1]).toEqual(before[1]);
    expect(deck.slides[2].background.color).toBe(noir().colors.background);
    // Nothing was added for the ghosts.
    expect(deck.slides.map((slide) => slide.id)).toEqual(['s1', 's2', 's3']);
  });

  it('does not depend on slideIndex when a rail selection is given', () => {
    const deck = threeSlideDeck();
    // An out-of-range current index (slide deleted underneath the panel) is harmless.
    adoptThemeStyles(deck, noir(), { ...FULL_APPLY }, 99, new Set(), new Set(['s1']));
    expect(deck.slides[0].background.color).toBe(noir().colors.background);
    expect(deck.slides[1].background.color).toBeNull();
    // Single-slide scope with an index past the end is a no-op, not a throw.
    const single = threeSlideDeck();
    const before = JSON.parse(JSON.stringify(single.slides));
    expect(() => adoptThemeStyles(
      single, noir(), { ...FULL_APPLY, scope: 'slide' }, 3, new Set(), new Set(),
    )).not.toThrow();
    expect(single.slides).toEqual(before);
  });
});
