// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CssEditor } from '../src/renderer/editor/cssEditor.js';
import { createThemePanel } from '../src/renderer/editor/themePanel.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { emptyDeck, type Deck, type TextEl } from '../src/shared/deck.js';
import { defaultLayoutMasters, realignSlideToLayout } from '../src/shared/layoutMasters.js';

/**
 * "Apply layout" is Apply theme's geometric twin: it puts the in-scope slides'
 * text boxes back where their own layout master places them and changes
 * nothing else -- not styling, not content, not which layout a slide is on.
 */

function slot(deck: Deck, index: number, name: 'title' | 'body'): TextEl {
  return deck.slides[index].elements.find((el): el is TextEl => (
    el.type === 'text' && el.layoutPlaceholder === name
  ))!;
}

function nudgedDeck(): Deck {
  const deck = emptyDeck('Apply layout');
  deck.layoutMasters = defaultLayoutMasters();
  deck.slides.push(structuredClone({ ...deck.slides[0], id: 's2', name: 's2' }));
  deck.slides.push(structuredClone({ ...deck.slides[0], id: 's3', name: 's3' }));
  applySlideLayout(deck.slides[0], 'standard', deck.layoutMasters);
  applySlideLayout(deck.slides[1], 'standard', deck.layoutMasters);
  applySlideLayout(deck.slides[2], 'freeform', deck.layoutMasters);
  for (const index of [0, 1]) {
    const title = slot(deck, index, 'title');
    title.x = 400; title.y = 500; title.w = 300; title.h = 60; title.align = 'right';
    title.style = { color: '#ff0000', 'font-size': '200px' };
    title.html = 'Moved title';
    title.class = title.class.filter((name) => name !== 'placeholder');
  }
  return deck;
}

describe('realignSlideToLayout', () => {
  it('moves the slot boxes back to the master geometry and touches nothing else', () => {
    const deck = nudgedDeck();
    const before = structuredClone(deck.slides[0]);
    expect(realignSlideToLayout(deck.slides[0], deck.layoutMasters)).toBe(2);
    const title = slot(deck, 0, 'title');
    expect({ x: title.x, y: title.y, w: title.w, h: title.h, align: title.align })
      .toEqual({ x: 120, y: 58, w: 1680, h: 142, align: 'left' });
    expect(title.style).toEqual({ color: '#ff0000', 'font-size': '200px' });
    expect(title.html).toBe('Moved title');
    expect(title.class).not.toContain('placeholder');
    expect(deck.slides[0].layout).toBe('standard');
    expect(deck.slides[0].elements.map((el) => el.id)).toEqual(before.elements.map((el) => el.id));
  });

  it('has nothing to align on a freeform slide and never invents boxes', () => {
    const deck = nudgedDeck();
    const snapshot = JSON.stringify(deck.slides[2]);
    expect(realignSlideToLayout(deck.slides[2], deck.layoutMasters)).toBe(0);
    expect(JSON.stringify(deck.slides[2])).toBe(snapshot);

    const titleOnly = emptyDeck().slides[0];
    applySlideLayout(titleOnly, 'standard');
    titleOnly.elements = titleOnly.elements.filter((el) => el.type !== 'text' || el.layoutPlaceholder !== 'body');
    expect(realignSlideToLayout(titleOnly)).toBe(1);
    expect(titleOnly.elements.filter((el) => el.type === 'text')).toHaveLength(1);
  });
});

describe('Apply layout button', () => {
  beforeEach(() => document.body.replaceChildren());

  function panelFor(deck: Deck) {
    const store = new EditorStore(deck, '/tmp/apply-layout');
    const setStatusMessage = vi.fn();
    const save = vi.fn();
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save,
      setStatusMessage,
      saveThemeCss: vi.fn(),
    });
    document.body.appendChild(panel.element);
    const button = panel.element.querySelector<HTMLButtonElement>('.layout-apply-section button')!;
    return { store, panel, button, setStatusMessage, save };
  }

  it('is a heading and one button whose label follows the theme scope', () => {
    const { panel, button, store } = panelFor(nudgedDeck());
    const section = panel.element.querySelector('.layout-apply-section')!;
    expect(section.querySelector('.insp-subtitle')!.textContent).toBe('Apply layout');
    expect(section.querySelectorAll('input, select')).toHaveLength(0);
    expect(section.querySelectorAll('button')).toHaveLength(1);

    store.selectSlide(1);
    store.selectSlide(2, true);
    panel.syncScope(2);
    expect(button.textContent).toBe('Apply layout to 2 selected slides');
    expect(panel.layoutApplyButtonLabel()).toBe('Apply layout to 2 selected slides');

    const scope = panel.element.querySelector<HTMLSelectElement>('.theme-adoption-controls select')!;
    scope.value = 'deck';
    scope.dispatchEvent(new Event('change'));
    expect(button.textContent).toBe('Apply layout to deck');
    scope.value = 'selection';
    scope.dispatchEvent(new Event('change'));
    expect(button.textContent).toBe('Apply layout to current slide');
  });

  it('re-aligns only the selected slides, saves, undoes as one step, and reports', () => {
    const deck = nudgedDeck();
    const { store, panel, button, setStatusMessage, save } = panelFor(deck);
    store.selectSlide(1);
    panel.syncScope(1);
    button.click();

    const after = store.get().deck;
    expect(slot(after, 1, 'title').x).toBe(120);
    expect(slot(after, 0, 'title').x).toBe(400);
    expect(slot(after, 1, 'title').style).toEqual({ color: '#ff0000', 'font-size': '200px' });
    expect(save).toHaveBeenCalled();
    expect(setStatusMessage).toHaveBeenLastCalledWith(
      'Re-aligned 2 text boxes to the layout on the current slide.',
    );

    store.undo();
    expect(slot(store.get().deck, 1, 'title').x).toBe(400);
  });

  it('says so when the scope has nothing to align', () => {
    const deck = nudgedDeck();
    const { store, panel, button, setStatusMessage } = panelFor(deck);
    store.selectSlide(2);
    panel.syncScope(1);
    button.click();
    expect(setStatusMessage).toHaveBeenLastCalledWith(
      'Nothing to align: the current slide uses the freeform layout.',
    );
  });
});
