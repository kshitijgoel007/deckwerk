// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignWorkspace } from '../src/renderer/editor/designWorkspace.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { emptyDeck } from '../src/shared/deck.js';
import { THEMES } from '../src/shared/themes.js';

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('design workspace dismissal', () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
    (globalThis as unknown as { window: Window }).window.api = {
      assetUrl: (src: string) => src,
    } as never;
  });

  function setup(): DesignWorkspace {
    const canvasHost = document.createElement('main');
    document.body.appendChild(canvasHost);
    return new DesignWorkspace({
      canvasHost,
      store: new EditorStore(emptyDeck('Design'), '/tmp/design'),
      save: vi.fn(),
      setStatusMessage: vi.fn(),
    });
  }

  it('escapes the theme preview', () => {
    const workspace = setup();
    workspace.show(THEMES[0]);

    expect(workspace.escape()).toBe('theme');
    expect(document.querySelector<HTMLElement>('.design-preview-workspace')!.hidden).toBe(true);
    expect(workspace.escape()).toBeNull();
  });

  it('cancels the layout editor before leaving the theme preview', () => {
    const workspace = setup();
    workspace.show(THEMES[0]);
    workspace.openLayoutEditor('standard');

    expect(document.querySelector('.layout-editor-overlay')).not.toBeNull();
    expect(workspace.escape()).toBe('layout');
    expect(document.querySelector('.layout-editor-overlay')).toBeNull();
    expect(document.querySelector<HTMLElement>('.design-preview-workspace')!.hidden).toBe(false);
  });
});
