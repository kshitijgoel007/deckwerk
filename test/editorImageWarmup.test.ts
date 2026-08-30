// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDeck } from '../src/shared/deck.js';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { installCanvasDomShims } from './support/canvasHarness.js';

describe('editor image lookahead', () => {
  beforeEach(() => {
    installCanvasDomShims();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('decodes the next slide image once and adopts that same node on navigation', async () => {
    const decoded: HTMLImageElement[] = [];
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: vi.fn(function (this: HTMLImageElement) {
        decoded.push(this);
        return Promise.resolve();
      }),
    });
    Object.defineProperty(HTMLImageElement.prototype, 'complete', {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
      configurable: true,
      get: () => 5712,
    });
    vi.stubGlobal('requestIdleCallback', vi.fn((callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 10 });
      return 1;
    }));
    vi.stubGlobal('cancelIdleCallback', vi.fn());

    const deck = parseDeck({
      version: 1,
      slides: [
        { id: 's1', elements: [] },
        {
          id: 's2',
          elements: [{
            id: 'photo', type: 'image', x: 0, y: 0, w: 640, h: 480,
            src: 'assets/large.jpeg',
          }],
        },
      ],
    });
    const store = new EditorStore(deck, '/tmp/image-warmup');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new EditorCanvas(host, store);
    await Promise.resolve();

    expect(decoded).toHaveLength(1);
    const warmed = decoded[0];
    expect(host.querySelector('img')).toBeNull();

    store.selectSlide(1);

    expect(host.querySelector('img')).toBe(warmed);
    expect(decoded).toHaveLength(1);
  });
});
