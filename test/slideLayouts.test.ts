// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyDeck } from '../src/shared/deck.js';
import { THEMES, NO_APPLY, applyThemeToSlide } from '../src/shared/themes.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { renderSlide } from '../src/renderer/player/render.js';

/** player.css with its @import inlined, the way the bundler would ship it. */
function readPlayerCss(): string {
  const dir = join(process.cwd(), 'src/renderer/player');
  const css = readFileSync(join(dir, 'player.css'), 'utf8');
  return css.replace(/@import\s+['"]\.\/([\w.-]+)['"];/g, (_match, name: string) =>
    readFileSync(join(dir, name), 'utf8'));
}

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

  it('switches to title-only without carrying an unwritten body prompt along', () => {
    // Reported: a new slideshow switched to Title slide showed a phantom box
    // on top of the title. It was the standard layout's body prompt, which
    // the title layout has no slot for and nobody had typed into.
    const slide = emptyDeck().slides[0];
    applySlideLayout(slide, 'standard');
    expect(slide.elements.some((el) => el.class.includes('role-body'))).toBe(true);
    applySlideLayout(slide, 'title');
    expect(slide.elements.some((el) => el.class.includes('role-body'))).toBe(false);
    const rendered = renderSlide(slide, { resolveSrc: (src) => src });
    expect(rendered.classList).toContain('layout-title');
  });

  it('switches to title-only non-destructively once the body has been written', () => {
    const slide = emptyDeck().slides[0];
    applySlideLayout(slide, 'standard');
    const body = slide.elements.find((el) => el.class.includes('role-body'))!;
    if (body.type === 'text') body.html = 'Words the author typed';
    body.class = body.class.filter((name) => name !== 'placeholder');

    applySlideLayout(slide, 'title');
    const kept = slide.elements.find((el) => el.id === body.id)!;
    expect(kept).toBeDefined();
    expect(kept.type === 'text' && kept.html).toBe('Words the author typed');
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

    expect(host.querySelector('.insp-title')?.textContent).toBe('slide');
    expect([...host.querySelectorAll('.insp-subtitle')].map((heading) => heading.textContent))
      .toEqual(['Layout', 'Morph']);
    expect([...host.querySelectorAll<HTMLElement>('.insp-group')]
      .some((section) => section.querySelector('h3')?.textContent === 'Slide')).toBe(false);

    const layout = [...host.querySelectorAll<HTMLSelectElement>('select')].find((select) =>
      [...select.options].some((option) => option.value === 'standard'))!;
    layout.value = 'standard';
    layout.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.slide!.layout).toBe('standard');

    host.querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    const color = document.querySelector<HTMLInputElement>('input[aria-label="Hex color"]')!;
    color.value = '#123456';
    color.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.slide!.background).toEqual({ color: '#123456', image: null });
    document.querySelector<HTMLButtonElement>('.color-picker-clear-theme')!.click();
    expect(store.slide!.background).toEqual({ color: null, image: null });
    expect([...host.querySelectorAll('button')].some((button) =>
      button.textContent === 'Apply theme to slide')).toBe(false);
  });

  it('keeps applicable slide controls for a multi-selection and applies them to all slides', () => {
    const deck = emptyDeck();
    const second = structuredClone(deck.slides[0]);
    second.id = 'slide-2';
    second.layout = 'title';
    second.background = { color: '#abcdef', image: null };
    deck.slides.push(second);
    const store = new EditorStore(deck, '/tmp/layout');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new Inspector(host, store);

    store.selectSlide(1, true);

    expect(host.querySelector('.insp-title')?.textContent).toBe('slides');
    expect([...host.querySelectorAll('.insp-subtitle')].map((heading) => heading.textContent))
      .toEqual(['Layout', 'Morph']);
    const layout = [...host.querySelectorAll<HTMLSelectElement>('select')].find((select) =>
      [...select.options].some((option) => option.value === 'standard'))!;
    expect(layout.value).toBe('__mixed__');
    expect(host.querySelector('.field-color > span')?.textContent).toBe('Background (mixed)');
    expect(host.querySelector('.color-picker-trigger')?.getAttribute('aria-label'))
      .toBe('Background (mixed): mixed');

    layout.value = 'standard';
    layout.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.selectedSlides().map((slide) => slide.layout)).toEqual(['standard', 'standard']);

    host.querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    const color = document.querySelector<HTMLInputElement>('input[aria-label="Hex color"]')!;
    color.value = '#123456';
    color.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.selectedSlides().map((slide) => slide.background))
      .toEqual([
        { color: '#123456', image: null },
        { color: '#123456', image: null },
      ]);
  });

  it('gives semantic layout text readable fallback sizes in an imported deck', () => {
    // The player's semantic type rules live in type.css, which the compile
    // page also loads. Vite inlines the @import when it bundles; jsdom does
    // not follow it, so resolve it here or the role sizes under test simply
    // are not present.
    const playerCss = readPlayerCss();
    const styles = document.createElement('style');
    styles.textContent = `${playerCss}\n.slide { font-family: sans-serif; }\n.kn-text { line-height: 1.2; }`;
    document.head.appendChild(styles);
    const slide = emptyDeck().slides[0];
    applySlideLayout(slide, 'standard');
    const rendered = renderSlide(slide, { resolveSrc: (src) => src });
    document.body.appendChild(rendered);

    expect(getComputedStyle(rendered.querySelector('.role-title')!).fontSize).toBe('92px');
    expect(getComputedStyle(rendered.querySelector('.role-body')!).fontSize).toBe('48px');
    styles.remove();
  });
});
