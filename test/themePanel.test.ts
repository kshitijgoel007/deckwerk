// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CssEditor } from '../src/renderer/editor/cssEditor.js';
import { createThemePanel } from '../src/renderer/editor/themePanel.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { emptyDeck } from '../src/shared/deck.js';

describe('theme panel', () => {
  beforeEach(() => document.body.replaceChildren());

  it('puts the apply menu before the gallery and exposes only current text roles', () => {
    const store = new EditorStore(emptyDeck('Theme panel'), '/tmp/theme-panel');
    const cssEditor = {
      getValue: () => '',
      setValue: vi.fn(),
    } as unknown as CssEditor;
    const panel = createThemePanel({
      store,
      cssEditor,
      save: vi.fn(),
      setStatusMessage: vi.fn(),
      saveThemeCss: vi.fn(),
    });
    document.body.appendChild(panel.element);

    expect([...panel.element.children].map((child) => child.className)).toEqual([
      'theme-browser-intro',
      'theme-adoption-controls',
      'theme-actions',
      'theme-gallery',
    ]);
    expect(panel.element.querySelector('.theme-browser-intro p')).toBeNull();
    const roleLabels = [...panel.element.querySelectorAll<HTMLElement>('.theme-adoption-controls .bar-check span')]
      .map((label) => label.textContent);
    expect(roleLabels.slice(0, 3)).toEqual(['Title', 'Body', 'Caption']);
    expect(roleLabels).not.toContain('Heading');
    expect(roleLabels).not.toContain('Base');
  });
});
