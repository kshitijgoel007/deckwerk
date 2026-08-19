import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
import { makePanelResizable } from '../src/renderer/editor/panelResize.js';

describe('resizable editor panels', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><body><aside id="panel"></aside></body>', {
      pretendToBeVisual: true,
      url: 'https://deckwerk.test',
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      KeyboardEvent: dom.window.KeyboardEvent,
      localStorage: dom.window.localStorage,
    });
  });

  it('resizes from the keyboard and remembers the new dimensions', () => {
    const panel = document.getElementById('panel')!;
    makePanelResizable(panel, {
      storageKey: 'test-panel',
      width: { property: '--width', initial: 320, min: 240, max: () => 500, edge: 'left' },
      height: { property: '--height', initial: 600, min: 300, max: () => 800, edge: 'bottom' },
    });

    const left = panel.querySelector<HTMLElement>('.panel-resize-left')!;
    left.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    const bottom = panel.querySelector<HTMLElement>('.panel-resize-bottom')!;
    bottom.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    expect(panel.style.getPropertyValue('--width')).toBe('336px');
    expect(panel.style.getPropertyValue('--height')).toBe('616px');
    expect(JSON.parse(localStorage.getItem('test-panel')!)).toEqual({ width: 336, height: 616 });
  });

  it('restores, clamps, and resets a saved size', () => {
    localStorage.setItem('test-panel', JSON.stringify({ width: 900 }));
    const panel = document.getElementById('panel')!;
    makePanelResizable(panel, {
      storageKey: 'test-panel',
      width: { property: '--width', initial: 320, min: 240, max: () => 500, edge: 'right' },
    });

    expect(panel.style.getPropertyValue('--width')).toBe('500px');
    panel.querySelector<HTMLElement>('.panel-resize-right')!
      .dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    expect(panel.style.getPropertyValue('--width')).toBe('320px');
    expect(JSON.parse(localStorage.getItem('test-panel')!)).toEqual({ width: 320 });
  });

  it('can put shared size variables on a separate target', () => {
    const panel = document.getElementById('panel')!;
    makePanelResizable(panel, {
      storageKey: 'test-panel',
      sizeTarget: document.documentElement,
      width: { property: '--floating-width', initial: 400, min: 320, max: () => 800, edge: 'left' },
    });

    expect(document.documentElement.style.getPropertyValue('--floating-width')).toBe('400px');
    expect(panel.querySelector('.panel-resize-left')).not.toBeNull();
  });
});
