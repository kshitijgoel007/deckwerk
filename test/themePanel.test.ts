// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CssEditor } from '../src/renderer/editor/cssEditor.js';
import { createThemePanel } from '../src/renderer/editor/themePanel.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { emptyDeck } from '../src/shared/deck.js';
import { THEMES } from '../src/shared/themes.js';

describe('theme panel', () => {
  beforeEach(() => document.body.replaceChildren());

  it('keeps adoption controls first, then separates the active theme from layouts', () => {
    const store = new EditorStore(emptyDeck('Theme panel'), '/tmp/theme-panel');
    const cssEditor = {
      getValue: () => '',
      setValue: vi.fn(),
    } as unknown as CssEditor;
    const onThemePreview = vi.fn();
    const onEditLayouts = vi.fn();
    const panel = createThemePanel({
      store,
      cssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
      onThemePreview,
      onEditLayouts,
      createLayoutPreview: (_theme, onActivate) => {
        const button = document.createElement('button');
        button.className = 'layout-test-preview';
        button.addEventListener('click', onActivate);
        return button;
      },
    });
    document.body.appendChild(panel.element);

    expect([...panel.element.children].map((child) => child.className)).toEqual([
      'theme-browser-intro',
      'theme-adoption-controls',
      'theme-actions theme-apply-action',
      'theme-panel-section',
      'theme-panel-section layouts-section',
    ]);
    expect(panel.element.querySelectorAll('.theme-active-host .theme-card')).toHaveLength(1);
    expect(panel.element.querySelector('.theme-chooser')?.hasAttribute('hidden')).toBe(true);
    expect(panel.element.querySelector('.theme-browser-intro p')).toBeNull();
    expect(onThemePreview).not.toHaveBeenCalled();
    panel.element.querySelector<HTMLButtonElement>('.theme-active-host .theme-card')!.click();
    expect(onThemePreview).toHaveBeenCalledTimes(1);
    panel.element.querySelector<HTMLButtonElement>('.layout-test-preview')!.click();
    expect(onEditLayouts).toHaveBeenCalledTimes(1);
    const roleLabels = [...panel.element.querySelectorAll<HTMLElement>('.theme-adoption-controls .bar-check span')]
      .map((label) => label.textContent);
    expect(roleLabels.slice(0, 4)).toEqual(['Title', 'Heading', 'Body', 'Caption']);
    expect(roleLabels).not.toContain('Base');
  });

  it('dismisses theme picking and the inline theme editor', () => {
    const store = new EditorStore(emptyDeck('Theme panel'), '/tmp/theme-panel');
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
      onThemePreview: vi.fn(),
    });
    document.body.appendChild(panel.element);

    panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    panel.element.querySelector<HTMLButtonElement>('.theme-section-action')!.click();
    expect(panel.element.querySelector<HTMLElement>('.theme-chooser')!.hidden).toBe(false);
    expect(panel.element.querySelector<HTMLElement>('.theme-inline-editor')!.hidden).toBe(false);

    expect(panel.dismiss()).toBe(true);
    expect(panel.element.querySelector<HTMLElement>('.theme-chooser')!.hidden).toBe(true);
    expect(panel.element.querySelector<HTMLElement>('.theme-inline-editor')!.hidden).toBe(true);
    expect(panel.dismiss()).toBe(false);
  });

  it('records the chosen theme for new slides without restyling existing ones', () => {
    const store = new EditorStore(emptyDeck('Theme panel'), '/tmp/theme-panel');
    const setStatusMessage = vi.fn();
    const save = vi.fn();
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save,
      setStatusMessage,
      saveThemeCss: vi.fn(),
      onThemePreview: vi.fn(),
    });
    document.body.appendChild(panel.element);
    const before = JSON.stringify(store.get().deck.slides);

    // Open the chooser, then pick a card other than the one already showing.
    panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    const showing = panel.currentTheme()!.id;
    const target = THEMES.find((theme) => theme.id !== showing)!;
    const cards = [...panel.element.querySelectorAll<HTMLButtonElement>('.theme-gallery .theme-card')];
    const card = cards.find((element) => element.textContent?.includes(target.name));
    card!.click();

    expect(store.get().deck.themeSelection?.preset).toBe(target.id);
    // Choosing installs nothing and repaints nothing that already exists.
    expect(store.get().deck.themePreset).toBeNull();
    expect(store.get().deck.themeStyle).toBeNull();
    expect(JSON.stringify(store.get().deck.slides)).toBe(before);
    expect(save).toHaveBeenCalled();
    expect(setStatusMessage.mock.calls.at(-1)?.[0]).toContain('New slides will use');
    expect(setStatusMessage.mock.calls.at(-1)?.[0]).toContain(target.name);
  });

  it('carries the theme\'s font weight onto the slides it restyles', () => {
    const deck = emptyDeck('Theme panel');
    deck.slides[0].elements.push({
      id: 'title-1', type: 'text', x: 0, y: 0, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
      class: ['role-title'], style: { 'font-weight': '700' }, html: 'A heavy title',
      align: 'left', valign: 'middle',
    });
    // The store opens with the first slide selected, which is the apply scope.
    const store = new EditorStore(deck, '/tmp/theme-panel');
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
      onThemePreview: vi.fn(),
    });
    document.body.appendChild(panel.element);

    // Pick the condensed-medium theme, then apply with the panel's defaults.
    panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    const colloquium = THEMES.find((theme) => theme.id === 'colloquium')!;
    [...panel.element.querySelectorAll<HTMLButtonElement>('.theme-gallery .theme-card')]
      .find((element) => element.textContent?.includes(colloquium.name))!.click();
    panel.element.querySelector<HTMLButtonElement>('.theme-apply-action button')!.click();

    // The family without its weight is what left condensed titles at 700.
    const title = store.get().deck.slides[0].elements.find((element) => element.id === 'title-1')!;
    expect(title.style['font-family']).toBe(colloquium.fonts.title.family);
    expect(title.style['font-weight']).toBe(String(colloquium.fonts.title.weight));
  });
});
