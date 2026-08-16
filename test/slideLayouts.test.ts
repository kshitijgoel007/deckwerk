// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { THEMES, NO_APPLY, applyThemeToSlide } from '../src/shared/themes.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { renderSlide } from '../src/renderer/player/render.js';

describe('slide layouts', () => {
  beforeEach(() => document.body.replaceChildren());

  it('creates a stable title-over-body standard layout', () => {
    const slide = emptyDeck().slides[0];
    applySlideLayout(slide, 'standard');
    const title = slide.elements.find((el) => el.class.includes('role-title'))!;
    const body = slide.elements.find((el) => el.class.includes('role-body'))!;
    expect(slide.layout).toBe('standard');
    expect({ x: title.x, y: title.y, w: title.w, h: title.h }).toEqual(
      { x: 120, y: 58, w: 1680, h: 142 },
    );
    expect({ x: body.x, y: body.y, w: body.w, h: body.h }).toEqual(
      { x: 120, y: 252, w: 1680, h: 700 },
    );
  });

  it('switches to title-only non-destructively', () => {
    const slide = emptyDeck().slides[0];
    applySlideLayout(slide, 'standard');
    const bodyId = slide.elements.find((el) => el.class.includes('role-body'))!.id;
    applySlideLayout(slide, 'title');
    expect(slide.elements.some((el) => el.id === bodyId)).toBe(true);
    const rendered = renderSlide(slide, { resolveSrc: (src) => src });
    expect(rendered.classList).toContain('layout-title');
  });

  it('does not let a theme move the layout geometry', () => {
    const slide = emptyDeck().slides[0];
    applySlideLayout(slide, 'standard');
    const before = slide.elements.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
    applyThemeToSlide(slide, THEMES[3], {
      ...NO_APPLY, fontSizes: true, textColors: true, backgrounds: true,
    }, 100);
    expect(slide.elements.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }))).toEqual(before);
  });

  it('offers slide layout and a direct background override', () => {
    const deck = emptyDeck();
    const store = new EditorStore(deck, '/tmp/layout');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new Inspector(host, store);

    const layout = [...host.querySelectorAll<HTMLSelectElement>('select')].find((select) =>
      [...select.options].some((option) => option.value === 'standard'))!;
    layout.value = 'standard';
    layout.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.slide!.layout).toBe('standard');

    const color = host.querySelector<HTMLInputElement>('input[type="color"]')!;
    color.value = '#123456';
    color.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.slide!.background).toEqual({ color: '#123456', image: null });
    host.querySelector<HTMLButtonElement>('button[title="No colour"]')!.click();
    expect(store.slide!.background).toEqual({ color: null, image: null });
    expect([...host.querySelectorAll('button')].some((button) =>
      button.textContent === 'Apply theme to slide')).toBe(false);
  });
});
