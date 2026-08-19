// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createThemeGallery } from '../src/renderer/editor/themeGallery.js';
import { THEMES } from '../src/shared/themes.js';

describe('theme gallery', () => {
  beforeEach(() => document.body.replaceChildren());

  it('shows every theme with its palette and the three current text roles', () => {
    const gallery = createThemeGallery(THEMES, 'basic', vi.fn());
    document.body.appendChild(gallery.element);

    const cards = document.querySelectorAll<HTMLElement>('.theme-card');
    expect(cards).toHaveLength(THEMES.length);
    for (const [index, card] of [...cards].entries()) {
      expect(card.querySelectorAll('.theme-card-swatch')).toHaveLength(THEMES[index].palette.length);
      expect(card.querySelector('.theme-card-heading > .theme-card-swatches')).not.toBeNull();
      expect(card.querySelector('.theme-card-preview > .theme-card-swatches')).toBeNull();
      expect(card.querySelector('.theme-font-title')?.textContent).toContain('The big idea');
      expect(card.querySelector('.theme-font-body')?.textContent).toContain('Readable body copy');
      expect(card.querySelector('.theme-font-caption')?.textContent).toContain('Supporting detail');
      expect(card.querySelector('.theme-font-heading')).toBeNull();
      expect(card.querySelector('.theme-card-description')).toBeNull();
    }
  });

  it('selects a card without treating it as installed', () => {
    const onSelect = vi.fn();
    const gallery = createThemeGallery(THEMES, 'basic', onSelect);
    document.body.appendChild(gallery.element);

    const target = document.querySelector<HTMLButtonElement>('[data-theme-id="swiss"]')!;
    target.click();
    expect(gallery.selectedId()).toBe('swiss');
    expect(target.getAttribute('aria-pressed')).toBe('true');
    expect(onSelect).toHaveBeenCalledWith(THEMES.find((theme) => theme.id === 'swiss'));
    expect(target.querySelector<HTMLElement>('.theme-installed-badge')!.hidden).toBe(true);

    gallery.setInstalled('swiss');
    expect(target.querySelector<HTMLElement>('.theme-installed-badge')!.hidden).toBe(false);
  });

  it('falls back to the first theme when a deck has no installed preset', () => {
    const gallery = createThemeGallery(THEMES, null, vi.fn());
    expect(gallery.selectedId()).toBe(THEMES[0].id);
    expect(gallery.element.querySelector('[aria-pressed="true"]')?.getAttribute('data-theme-id'))
      .toBe(THEMES[0].id);
  });
});
