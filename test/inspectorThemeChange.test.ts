// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore } from '../src/renderer/editor/store.js';

/**
 * A theme.css change goes stale on the inspector's computed readouts (font
 * family, size, weight, spacing of the selected text), so the panel is rebuilt
 * on every stylesheet change — but only while something is selected. With
 * nothing selected the panel shows the Morph previews, and rebuilding those
 * re-mounts every preview video: the torn-down surfaces keep fetching until the
 * load gate's watchdog notices, and for a moment twice the budgeted videos are
 * on the wire (the collab slow-network suite caught exactly that).
 */
function setup(): { store: EditorStore; host: HTMLElement; inspector: Inspector } {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!globalThis.CSS) {
    (globalThis as unknown as { CSS: unknown }).CSS = {
      escape: (v: string) => v.replace(/["\\]/g, '\\$&'),
    };
  }
  (globalThis as unknown as { window: Window }).window.api = {
    assetUrl: (src: string) => src,
    pathForFile: () => '',
    importAssets: async () => [],
  } as never;
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: () => {} });

  const deck = emptyDeck('Theme change');
  deck.slides[0].elements = [{
    id: 'text-1', type: 'text', x: 100, y: 100, w: 600, h: 120, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, html: 'Title', align: 'left', valign: 'middle',
  }];
  const store = new EditorStore(deck, '/tmp/theme-change');
  const host = document.createElement('aside');
  document.body.replaceChildren(host);
  const inspector = new Inspector(host, store);
  return { store, host, inspector };
}

describe('inspector on a theme.css change', () => {
  it('leaves the Morph previews alone while nothing is selected', () => {
    const { host, inspector } = setup();
    const before = host.querySelector('.morph-section')?.firstElementChild;
    expect(before).toBeTruthy();

    inspector.noteThemeChanged();

    expect(host.querySelector('.morph-section')?.firstElementChild).toBe(before);
  });

  it('rebuilds the element controls when text is selected', () => {
    const { store, host, inspector } = setup();
    store.select(['text-1']);
    const before = host.querySelector('.insp-type-sections');
    expect(before).toBeTruthy();

    inspector.noteThemeChanged();

    const after = host.querySelector('.insp-type-sections');
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });
});
