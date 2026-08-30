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

  it('decodes a large image wall sequentially only up to the pixel budget', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: vi.fn(() => new Promise<void>((resolve) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        releases.push(() => { inFlight -= 1; resolve(); });
      })),
    });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
      configurable: true, get: () => 6_000,
    });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', {
      configurable: true, get: () => 4_000,
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
          elements: Array.from({ length: 10 }, (_, index) => ({
            id: `photo-${index}`, type: 'image', x: 0, y: 0, w: 640, h: 480,
            src: `assets/large-${index}.jpeg`,
          })),
        },
      ],
    });
    const store = new EditorStore(deck, '/tmp/image-wall');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new EditorCanvas(host, store);

    expect(releases).toHaveLength(1);
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releases).toHaveLength(1);
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(maxInFlight).toBe(1);
    expect(HTMLImageElement.prototype.decode).toHaveBeenCalledTimes(2);
  });
});
