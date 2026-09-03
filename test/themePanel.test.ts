// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CssEditor } from '../src/renderer/editor/cssEditor.js';
import { createThemePanel } from '../src/renderer/editor/themePanel.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { emptyDeck } from '../src/shared/deck.js';
import { THEMES, fullThemeSelection } from '../src/shared/themes.js';

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

    // The Theme tab is built from the Props tab's sections, in the order you
    // read them: which theme the deck wears, what to do with it, then layouts.
    expect([...panel.element.children].map((child) => child.className)).toEqual([
      'theme-browser-intro',
      'insp-option-section theme-current-section',
      'insp-option-section theme-apply-section',
      'insp-option-section layouts-section',
    ]);
    expect([...panel.element.querySelectorAll('.insp-subtitle')].map((h) => h.textContent))
      .toEqual(['Current theme', 'Apply theme', 'Layouts']);
    expect(panel.element.querySelectorAll('.theme-active-host .theme-card')).toHaveLength(1);
    expect(panel.element.querySelector('.theme-chooser')?.hasAttribute('hidden')).toBe(true);
    expect(panel.element.querySelector('.theme-browser-intro p')).toBeNull();
    expect(onThemePreview).not.toHaveBeenCalled();
    panel.element.querySelector<HTMLButtonElement>('.theme-active-host .theme-card')!.click();
    expect(onThemePreview).toHaveBeenCalledTimes(1);
    panel.element.querySelector<HTMLButtonElement>('.layout-test-preview')!.click();
    expect(onEditLayouts).toHaveBeenCalledTimes(1);
    const roleLabels = [...panel.element.querySelectorAll<HTMLElement>('.theme-adoption-controls .field-check span')]
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

  it('follows the Light/Dark switch with the selection and the preview', () => {
    const store = new EditorStore(emptyDeck('Theme panel'), '/tmp/theme-panel');
    const onThemePreview = vi.fn();
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
      onThemePreview,
    });
    document.body.appendChild(panel.element);

    panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    const light = panel.currentTheme()!;
    [...panel.element.querySelectorAll<HTMLButtonElement>('.theme-mode-option')]
      .find((button) => button.textContent === 'Dark')!.click();

    // The dark half of the theme that was showing, not a different theme.
    expect(panel.currentTheme()!.id).toBe(`${light.id}-dark`);
    expect(store.get().deck.themeSelection?.preset).toBe(`${light.id}-dark`);
    expect((onThemePreview.mock.calls.at(-1)?.[0] as { id: string }).id).toBe(`${light.id}-dark`);
    // Flipping the switch is still browsing: the chooser stays open.
    expect(panel.element.querySelector<HTMLElement>('.theme-chooser')!.hidden).toBe(false);
  });

  it('ends the central preview whenever the chooser closes', () => {
    const store = new EditorStore(emptyDeck('Theme panel'), '/tmp/theme-panel');
    const onThemePreview = vi.fn();
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
      onThemePreview,
    });
    document.body.appendChild(panel.element);
    const chooser = panel.element.querySelector<HTMLElement>('.theme-chooser')!;
    const openChooser = () =>
      panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();

    // The chooser's own Close button.
    openChooser();
    expect(chooser.hidden).toBe(false);
    [...chooser.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Close')!.click();
    expect(chooser.hidden).toBe(true);
    expect(onThemePreview.mock.calls.at(-1)?.[0]).toBeNull();

    // Picking a card is a decision: the picker closes and the deck comes back.
    openChooser();
    [...panel.element.querySelectorAll<HTMLButtonElement>('.theme-gallery .theme-card')]
      .find((card) => card.dataset.themeId !== panel.currentTheme()!.id)!.click();
    expect(chooser.hidden).toBe(true);
    expect(onThemePreview.mock.calls.at(-1)?.[0]).toBeNull();

    // And re-opening the active card while the chooser is up closes it too.
    openChooser();
    openChooser();
    expect(chooser.hidden).toBe(true);
    expect(onThemePreview.mock.calls.at(-1)?.[0]).toBeNull();

    openChooser();
    expect(panel.dismiss()).toBe(true);
    expect(onThemePreview.mock.calls.at(-1)?.[0]).toBeNull();
  });

  it('marks the theme the deck last actually wore, not the one last clicked', () => {
    const deck = emptyDeck('Theme panel');
    deck.slides[0].elements.push({
      id: 'title-1', type: 'text', x: 0, y: 0, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
      class: ['role-title'], style: {}, html: 'A title', align: 'left', valign: 'middle',
    });
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
    const openChooser = () =>
      panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    const cardFor = (name: string) =>
      [...panel.element.querySelectorAll<HTMLButtonElement>('.theme-gallery .theme-card')]
        .find((element) => element.textContent?.includes(name))!;
    const markedPrevious = () => [...panel.element
      .querySelectorAll<HTMLElement>('.theme-gallery .theme-previous-badge')]
      .filter((badge) => !badge.hidden)
      .map((badge) => badge.closest<HTMLElement>('.theme-card')!.dataset.themeId);

    // Choose Swiss and actually put it on the slide.
    openChooser();
    cardFor(THEMES.find((theme) => theme.id === 'swiss')!.name).click();
    panel.element.querySelector<HTMLButtonElement>('.theme-apply-action button')!.click();
    openChooser();
    expect(markedPrevious()).toEqual([]);

    // Now merely click through another theme: chosen, never applied.
    const salon = THEMES.find((theme) => theme.id === 'salon')!;
    openChooser();
    cardFor(salon.name).click();
    openChooser();
    // Swiss is the last theme this deck actually wore; Salon is only selected.
    expect(markedPrevious()).toEqual(['swiss']);

    // Applying Salon makes it the deck's look, and Swiss the one to go back to.
    panel.element.querySelector<HTMLButtonElement>('.theme-apply-action button')!.click();
    openChooser();
    expect(store.get().deck.themeHistory).toEqual(['salon', 'swiss']);
    expect(markedPrevious()).toEqual(['swiss']);
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

  it('offers a theme the deck carries itself, and applies it like any built-in', () => {
    const deck = emptyDeck('Theme panel');
    // The shape `slide-agent theme create` writes, on a deck that has slides.
    deck.customThemes = [{
      id: 'lab-night',
      name: 'Lab Night',
      description: 'Slab titles on a deep ink ground.',
      fonts: structuredClone(THEMES[0].fonts),
      palette: ['#e9edf2', '#94a0ad', '#f0a83c'],
      colors: { background: '#12151a', text: '#e9edf2', muted: '#94a0ad', accent: '#f0a83c' },
    }];
    deck.slides[0].elements.push({
      id: 'title-1', type: 'text', x: 0, y: 0, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
      class: ['role-title'], style: { 'font-family': 'Comic Sans MS' }, html: 'A title',
      align: 'left', valign: 'middle',
    });
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

    panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    const card = [...panel.element.querySelectorAll<HTMLButtonElement>('.theme-gallery .theme-card')]
      .find((element) => element.textContent?.includes('Lab Night'));
    expect(card).toBeDefined();
    card!.click();
    // The gallery opens on the light side of its switch, so a dark deck theme
    // is offered as its generated light counterpart — the same courtesy the
    // built-ins get.
    expect(panel.currentTheme()?.id).toBe('lab-night-light');
    panel.element.querySelector<HTMLButtonElement>('.theme-apply-action button')!.click();

    const title = store.get().deck.slides[0].elements.find((element) => element.id === 'title-1')!;
    expect(title.style['font-family']).toBe(deck.customThemes[0].fonts.title.family);
  });

  it('offers the presets of a deck opened after the panel was built', () => {
    // The shells build the panel once, against an empty placeholder deck, and
    // hand it the real deck later through noteDeckOpened. A deck theme must
    // still reach the gallery — this is the path every real session takes.
    const store = new EditorStore(emptyDeck('Placeholder'), '/tmp/theme-panel');
    const panel = createThemePanel({
      store,
      cssEditor: { getValue: () => '', setValue: vi.fn() } as unknown as CssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
      onThemePreview: vi.fn(),
    });
    document.body.appendChild(panel.element);
    const cardIds = () => [...panel.element.querySelectorAll<HTMLElement>('.theme-gallery .theme-card')]
      .map((card) => card.dataset.themeId);
    expect(cardIds()).not.toContain('lab-night');

    const opened = emptyDeck('Opened later');
    opened.customThemes = [{
      id: 'lab-night', name: 'Lab Night', description: '',
      fonts: structuredClone(THEMES[0].fonts),
      palette: ['#e9edf2', '#94a0ad', '#f0a83c'],
      colors: { background: '#12151a', text: '#e9edf2', muted: '#94a0ad', accent: '#f0a83c' },
    }];
    opened.themeSelection = fullThemeSelection('lab-night');
    store.applyRemote(opened, 'open');
    panel.noteDeckOpened(opened);

    // The gallery now lists the deck theme, on the dark side its ground sits on,
    // and the chooser still holds exactly one gallery.
    expect(panel.element.querySelectorAll('.theme-gallery')).toHaveLength(1);
    expect(cardIds()).toContain('lab-night');
    expect(panel.currentTheme()?.id).toBe('lab-night');
    panel.element.querySelector<HTMLButtonElement>('.theme-active-card')!.click();
    expect(panel.element.querySelector('[data-theme-id="lab-night"]')!.classList.contains('selected')).toBe(true);

    // Opening a deck without presets of its own drops the card again.
    const plain = emptyDeck('Plain');
    store.applyRemote(plain, 'open');
    panel.noteDeckOpened(plain);
    expect(panel.element.querySelectorAll('.theme-gallery')).toHaveLength(1);
    expect(cardIds()).not.toContain('lab-night');
  });
});
