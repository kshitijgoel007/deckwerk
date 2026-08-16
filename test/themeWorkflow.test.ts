// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { NO_APPLY, THEMES, applyThemeToSlide, themeCss } from '../src/shared/themes.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { renderSlide } from '../src/renderer/player/render.js';
import { EditorStore } from '../src/renderer/editor/store.js';

function setup() {
  const deck = emptyDeck('Theme workflow');
  deck.slides[0].elements = [
    {
      id: 'title', type: 'text', x: 100, y: 100, w: 800, h: 120, rot: 0, z: 1,
      opacity: 1, class: [], style: { 'font-size': '48px', color: '#f00' },
      html: 'A title', align: 'left', valign: 'middle',
    },
    {
      id: 'body', type: 'text', x: 100, y: 300, w: 800, h: 160, rot: 0, z: 2,
      opacity: 1, class: [], style: { 'font-size': '32px' },
      html: 'Body copy', align: 'left', valign: 'top',
    },
  ];
  const store = new EditorStore(deck, '/tmp/theme');
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const inspector = new Inspector(host, store);
  return { deck, store, host, inspector };
}

function chooseRole(store: EditorStore, host: HTMLElement, id: string, role: string): void {
  store.select([id]);
  const select = [...host.querySelectorAll<HTMLSelectElement>('select')].find((candidate) =>
    [...candidate.options].some((option) => option.value === 'role-title'))!;
  select.value = role;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('role-based theme workflow', () => {
  beforeEach(() => document.body.replaceChildren());

  it('assigns Title and Body roles through the real inspector control', () => {
    const { store, host } = setup();
    chooseRole(store, host, 'title', 'role-title');
    chooseRole(store, host, 'body', 'role-body');
    expect(store.slide!.elements.find((el) => el.id === 'title')!.class).toContain('role-title');
    expect(store.slide!.elements.find((el) => el.id === 'body')!.class).toContain('role-body');
  });

  it('applies theme typography to explicitly selected roles on one slide', () => {
    const { store, host } = setup();
    chooseRole(store, host, 'title', 'role-title');
    chooseRole(store, host, 'body', 'role-body');
    const theme = THEMES.find((candidate) => candidate.id === 'hacker')!;

    applyThemeToSlide(store.slide!, theme, {
      ...NO_APPLY, fontSizes: true, textColors: true,
    }, 48);

    const title = store.slide!.elements.find((el) => el.id === 'title')!;
    const body = store.slide!.elements.find((el) => el.id === 'body')!;
    expect(title.class).toContain('role-title');
    expect(body.class).toContain('role-body');
    expect(title.style['font-size']).toBeUndefined();
    expect(title.style.color).toBeUndefined();

    const style = document.createElement('style');
    style.textContent = themeCss(theme);
    document.head.appendChild(style);
    document.body.appendChild(renderSlide(store.slide!, { resolveSrc: (src) => src }));
    expect(getComputedStyle(document.querySelector<HTMLElement>('[data-element-id="title"]')!).fontSize)
      .toBe(`${theme.fonts.title.size}px`);
    expect(getComputedStyle(document.querySelector<HTMLElement>('[data-element-id="body"]')!).fontSize)
      .toBe(`${theme.fonts.body.size}px`);
  });

  it('leaves the role assignments intact when applying a different theme', () => {
    const { store, host } = setup();
    chooseRole(store, host, 'title', 'role-title');
    chooseRole(store, host, 'body', 'role-body');
    applyThemeToSlide(store.slide!, THEMES[3], { ...NO_APPLY, fontSizes: true }, 48);
    applyThemeToSlide(store.slide!, THEMES[4], { ...NO_APPLY, fontSizes: true }, 48);
    expect(store.slide!.elements.map((el) => el.class.find((c) => c.startsWith('role-'))))
      .toEqual(['role-title', 'role-body']);
  });

  it('keeps the native colour panel anchored until its choice is accepted', () => {
    const { store, host } = setup();
    store.select(['title']);
    const input = host.querySelector<HTMLInputElement>('input[type="color"]')!;
    const originalInput = input;

    input.value = '#123456';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(host.querySelector('input[type="color"]')).toBe(originalInput);
    expect(store.slide!.elements.find((el) => el.id === 'title')!.style.color).toBe('#f00');

    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.slide!.elements.find((el) => el.id === 'title')!.style.color).toBe('#123456');
  });

  it('edits whole-box font size and weight and can return both to the theme', () => {
    const { store, host } = setup();
    store.select(['body']);
    const field = (label: string) => [...host.querySelectorAll<HTMLLabelElement>('label.field')]
      .find((candidate) => candidate.querySelector('span')?.textContent === label)!;
    const size = field('Font size').querySelector<HTMLInputElement>('input[type="number"]')!;
    const weight = field('Font weight').querySelector<HTMLSelectElement>('select')!;

    size.value = '54';
    size.dispatchEvent(new Event('change', { bubbles: true }));
    field('Font weight').querySelector<HTMLSelectElement>('select')!.value = '700';
    field('Font weight').querySelector<HTMLSelectElement>('select')!
      .dispatchEvent(new Event('change', { bubbles: true }));
    let body = store.slide!.elements.find((element) => element.id === 'body')!;
    expect(body.style['font-size']).toBe('54px');
    expect(body.style['font-weight']).toBe('700');

    field('Font size').querySelector<HTMLButtonElement>('button[title="Use theme value"]')!.click();
    field('Font weight').querySelector<HTMLSelectElement>('select')!.value = 'inherit';
    field('Font weight').querySelector<HTMLSelectElement>('select')!
      .dispatchEvent(new Event('change', { bubbles: true }));
    body = store.slide!.elements.find((element) => element.id === 'body')!;
    expect(body.style['font-size']).toBeUndefined();
    expect(body.style['font-weight']).toBeUndefined();
    expect(weight).not.toBeNull();
  });
});
