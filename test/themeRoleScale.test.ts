import { describe, expect, it } from 'vitest';
import { emptyDeck, type Slide, type SlideElement } from '../src/shared/deck.js';
import {
  STOCK_STYLESHEET_STYLE,
  applyDeckThemeToNewSlide,
  installThemeStyle,
  setThemeRoleSize,
  stripStyleProperties,
  themeById,
  themeStyleCss,
  themeStyleOf,
} from '../src/shared/themes.js';

function text(id: string, cls: string[], style: Record<string, string>, html = id): SlideElement {
  return {
    id, type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1, opacity: 1,
    class: cls, style, html, align: 'left', valign: 'top', autoFit: false,
  };
}

function slide(id: string, elements: SlideElement[]): Slide {
  return { id, name: id, background: { color: null, image: null }, notes: '', elements, timeline: [] };
}

describe('the deck-wide type scale per role', () => {
  it('changes the default and theme.css while every existing box keeps its size', () => {
    const deck = emptyDeck('Scale');
    deck.themePreset = 'editorial';
    deck.themeStyle = themeStyleOf(themeById('editorial')!);
    const before = deck.themeStyle.fonts.title.size;
    deck.slides[0].elements = [
      text('following', ['role-title'], {}),
      text('own', ['role-title'], { 'font-size': '80px' }),
      text('body', ['role-body'], {}),
    ];

    setThemeRoleSize(deck, 'title', 120);
    expect(deck.themeStyle.fonts.title.size).toBe(120);
    expect(themeStyleCss(deck.themeStyle)).toMatch(/\.role-title \{[^}]*font-size: 120px/);
    // The box that followed the stylesheet is pinned at what it rendered at.
    expect(deck.slides[0].elements[0].style).toEqual({ 'font-size': `${before}px` });
    // A box with its own size keeps exactly that.
    expect(deck.slides[0].elements[1].style).toEqual({ 'font-size': '80px' });
    // Other roles did not change, so nothing is written on them.
    expect(deck.slides[0].elements[2].style).toEqual({});
  });

  it('pins nothing when the size does not change', () => {
    const deck = emptyDeck('Scale');
    deck.themePreset = 'editorial';
    deck.themeStyle = themeStyleOf(themeById('editorial')!);
    deck.slides[0].elements = [text('t', ['role-title'], {})];
    setThemeRoleSize(deck, 'title', deck.themeStyle.fonts.title.size);
    expect(deck.slides[0].elements[0].style).toEqual({});
  });

  it('installs the theme the deck wears when it had no composed defaults yet', () => {
    const deck = emptyDeck('Scale');
    deck.themeSelection = {
      preset: 'poster', roles: ['title'], fontFamily: true, fontWeight: true,
      typeScale: true, textColor: false, objectColors: false,
    };
    setThemeRoleSize(deck, 'title', 120);
    expect(deck.themePreset).toBe('poster');
    expect(deck.themeStyle?.fonts.title.size).toBe(120);
    expect(deck.themeStyle?.fonts.body.size).toBe(themeById('poster')!.fonts.body.size);
  });

  it('gives a slide created afterwards the new size through theme.css alone', () => {
    const deck = emptyDeck('Scale');
    deck.themePreset = 'editorial';
    deck.themeStyle = themeStyleOf(themeById('editorial')!);
    setThemeRoleSize(deck, 'title', 120);
    deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'new', elements: [text('t', ['role-title'], {})] });
    applyDeckThemeToNewSlide(deck, 1);
    // Nothing inline: the regenerated `.role-title` rule is what sizes it.
    expect(deck.slides[1].elements[0].style).toEqual({});
  });
});

describe('stripStyleProperties', () => {
  it('strips absolute run sizes and keeps relative ones', () => {
    expect(stripStyleProperties('<span style="font-size: 40px; color: red">a</span>', ['font-size']))
      .toBe('<span style="color: red">a</span>');
    expect(stripStyleProperties('<span style="font-size: 0.6em">a</span>', ['font-size']))
      .toBe('<span style="font-size: 0.6em">a</span>');
    expect(stripStyleProperties('<span style="font-size: 80%; color: red">a</span>', ['font-size', 'color']))
      .toBe('<span style="font-size: 80%">a</span>');
  });

  it('reads a quoted font stack as one declaration, not as its entities', () => {
    // A serialized style writes the stack's quotes as `&quot;`, each ending in
    // a `;`. Splitting on those left the intro deck with
    // style="American Typewriter&quot; , &quot; SF Mono…" after a theme apply.
    const stack = 'font-family: &quot;American Typewriter&quot;, &quot;SF Mono&quot;, monospace';
    expect(stripStyleProperties(`<span style="${stack};">a</span>`, ['font-family']))
      .toBe('<span>a</span>');
    expect(stripStyleProperties(`<span style="${stack}; color: red">a</span>`, ['color']))
      .toBe(`<span style="${stack}">a</span>`);
    // Neither may a `;` inside a url() or a string end the declaration.
    expect(stripStyleProperties(
      '<span style="background-image: url(data:image/png;base64,AA); color: red">a</span>', ['color'],
    )).toBe('<span style="background-image: url(data:image/png;base64,AA)">a</span>');
    expect(stripStyleProperties(
      "<span style='font-family: \"A;B\"; color: red'>a</span>", ['color'],
    )).toBe("<span style='font-family: \"A;B\"'>a</span>");
  });

  it('handles single and double quoted attributes alike', () => {
    expect(stripStyleProperties("<b style='font-weight: 700; color: #123456'>a</b>", ['font-weight']))
      .toBe("<b style='color: #123456'>a</b>");
    expect(stripStyleProperties('<b style="font-weight: 700; color: #123456">a</b>', ['font-weight']))
      .toBe('<b style="color: #123456">a</b>');
  });

  it('removes the attribute when nothing is left in it', () => {
    expect(stripStyleProperties('<span style="color: red">a</span>', ['color'])).toBe('<span>a</span>');
    expect(stripStyleProperties('<span class="x" style="font-size: 12px; color: red">a</span>', ['color', 'font-size']))
      .toBe('<span class="x">a</span>');
  });

  it('preserves declarations it was not asked about, on every run', () => {
    const html = '<p style="text-decoration: underline; color: red">a <i style="letter-spacing: 1px; font-style: italic">b</i></p>';
    expect(stripStyleProperties(html, ['color', 'letter-spacing']))
      .toBe('<p style="text-decoration: underline">a <i style="font-style: italic">b</i></p>');
    // Markup without style attributes, or an empty property list, comes back as is.
    expect(stripStyleProperties('<p>plain</p>', ['color'])).toBe('<p>plain</p>');
    expect(stripStyleProperties(html, [])).toBe(html);
  });
});

describe('installThemeStyle pinning', () => {
  const nobody = { slides: new Set<string>(), elements: new Set<string>() };

  it('pins every differing property on boxes following the stylesheet, except base size and leading', () => {
    const deck = emptyDeck('Pin');
    const previous = STOCK_STYLESHEET_STYLE;
    const next = themeStyleOf(themeById('basic')!);
    deck.slides[0].elements = [
      text('title', ['role-title'], {}),
      text('base', [], {}),
    ];
    installThemeStyle(deck, next, 'basic', nobody);

    expect(deck.themeStyle).toEqual(next);
    expect(deck.themePreset).toBe('basic');
    const title = deck.slides[0].elements[0];
    expect(title.style).toEqual({
      'font-family': previous.fonts.title.family,
      'font-size': `${previous.fonts.title.size}px`,
      'line-height': String(previous.fonts.title.lineHeight),
      'letter-spacing': previous.fonts.title.letterSpacing,
      color: previous.colors.text,
    });
    // Same weight in both themes, so no pin for it.
    expect(previous.fonts.title.weight).toBe(next.fonts.title.weight);
    // A base box's size and leading come from `.element-text`, not theme.css.
    const base = deck.slides[0].elements[1];
    expect(base.style['font-size']).toBeUndefined();
    expect(base.style['line-height']).toBeUndefined();
    expect(base.style['font-family']).toBe(previous.fonts.base.family);
    expect(base.style.color).toBe(previous.colors.text);
  });

  it('leaves a box with its own value for a property alone', () => {
    const deck = emptyDeck('Pin');
    const withContent = text('content', ['role-title'], {}) as Extract<SlideElement, { type: 'text' }>;
    withContent.contentStyle = { color: '#ff0000' };
    deck.slides[0].elements = [
      text('own', ['role-title'], { 'font-family': 'Comic Sans MS', 'font-size': '80px' }),
      withContent,
    ];
    installThemeStyle(deck, themeStyleOf(themeById('basic')!), 'basic', nobody);

    const own = deck.slides[0].elements[0];
    expect(own.style['font-family']).toBe('Comic Sans MS');
    expect(own.style['font-size']).toBe('80px');
    expect(own.style['line-height']).toBe(String(STOCK_STYLESHEET_STYLE.fonts.title.lineHeight));
    // A colour set on `.text-content` counts as the box's own too.
    const content = deck.slides[0].elements[1];
    expect(content.style.color).toBeUndefined();
    expect(withContent.contentStyle).toEqual({ color: '#ff0000' });
  });

  it('pins a slide ground only when it was following the stylesheet and the ground differs', () => {
    const deck = emptyDeck('Pin');
    deck.slides = [slide('following', []), slide('own', [])];
    deck.slides[1].background = { color: '#abcdef', image: null };
    const next = themeStyleOf(themeById('basic')!);
    installThemeStyle(deck, next, 'basic', nobody);
    expect(deck.slides[0].background).toEqual({ color: STOCK_STYLESHEET_STYLE.colors.background, image: null });
    expect(deck.slides[0].layoutBackgroundInherited).toBe(false);
    expect(deck.slides[1].background).toEqual({ color: '#abcdef', image: null });

    // A style that keeps the ground pins nothing on a following slide.
    const same = emptyDeck('Pin');
    same.slides = [slide('same', [])];
    const again = structuredClone(STOCK_STYLESHEET_STYLE);
    again.fonts.title.size = 999;
    installThemeStyle(same, again, 'basic', nobody);
    expect(same.slides[0].background).toEqual({ color: null, image: null });
    expect(same.slides[0].layoutBackgroundInherited).toBeUndefined();
  });

  it('leaves the slides and elements that follow the new style on the cascade', () => {
    const deck = emptyDeck('Pin');
    deck.slides = [
      slide('s1', [text('s1-title', ['role-title'], {}), text('s1-body', ['role-body'], {})]),
      slide('s2', [text('s2-title', ['role-title'], {})]),
    ];
    const next = themeStyleOf(themeById('basic')!);
    installThemeStyle(deck, next, 'basic', { slides: new Set(['s1']), elements: new Set() });
    for (const el of deck.slides[0].elements) expect(el.style).toEqual({});
    expect(deck.slides[0].background).toEqual({ color: null, image: null });
    expect(deck.slides[1].elements[0].style['font-family']).toBe(STOCK_STYLESHEET_STYLE.fonts.title.family);
    expect(deck.slides[1].background.color).toBe(STOCK_STYLESHEET_STYLE.colors.background);

    // Selection scope names elements, not slides: the slide's other boxes are pinned.
    const other = emptyDeck('Pin');
    other.slides = [slide('s1', [text('a', ['role-title'], {}), text('b', ['role-title'], {})])];
    installThemeStyle(other, next, 'basic', { slides: new Set(), elements: new Set(['a']) });
    expect(other.slides[0].elements[0].style).toEqual({});
    expect(other.slides[0].elements[1].style['font-family']).toBe(STOCK_STYLESHEET_STYLE.fonts.title.family);
  });
});
