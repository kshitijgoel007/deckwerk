// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CssEditor } from '../src/renderer/editor/cssEditor.js';
import { createThemePanel } from '../src/renderer/editor/themePanel.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { emptyDeck } from '../src/shared/deck.js';

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
    expect(roleLabels.slice(0, 3)).toEqual(['Title', 'Body', 'Caption']);
    expect(roleLabels).not.toContain('Heading');
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
});
