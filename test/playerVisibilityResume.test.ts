// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import { Player } from '../src/renderer/player/player.js';

/**
 * Chromium pauses muted video in a hidden or occluded page, and the player
 * deliberately does not fight that while hidden. The moment the page is
 * visible again, playback the build state still wants must restart on its
 * own — a presenter who switches Spaces mid-talk and comes back must not
 * find every clip frozen on its last frame.
 */

function videoDeck(): Deck {
  const deck = emptyDeck('Visibility');
  deck.slides[0].elements.push({
    id: 'clip',
    type: 'video',
    x: 0, y: 0, w: 640, h: 360, rot: 0, z: 1, opacity: 1,
    class: [], style: {},
    src: 'assets/clip.05a38d7a.h264.mp4',
    poster: null, start: 0, end: null,
    autoplay: true, loop: true, muted: true, controls: false,
    fit: 'contain',
  } as unknown as Deck['slides'][number]['elements'][number]);
  return deck;
}

describe('playback resumes when the page becomes visible', () => {
  let playCalls: number;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    document.body.replaceChildren();
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    if (!globalThis.CSS) (globalThis as unknown as { CSS: typeof CSS }).CSS = {} as typeof CSS;
    if (!CSS.escape) CSS.escape = (value) => value;

    playCalls = 0;
    HTMLMediaElement.prototype.play = () => {
      playCalls += 1;
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = () => {};

    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      get: () => visibility,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-kicks every intended video on visibilitychange', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const player = new Player({ deck: videoDeck(), container: host, resolveSrc: (src) => src });
    const initialPlays = playCalls;
    expect(initialPlays).toBeGreaterThan(0); // autoplay intent acted on at mount

    // The tab goes hidden; Chromium pauses the clip. The player declines to
    // retry while hidden — that part is by design.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    const playsWhileHidden = playCalls;

    // Coming back must restart playback without any user input.
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(playCalls).toBeGreaterThan(playsWhileHidden);

    player.destroy();
  });

  it('does not restart while blanked', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const player = new Player({ deck: videoDeck(), container: host, resolveSrc: (src) => src });
    player.toggleBlank();
    const plays = playCalls;

    document.dispatchEvent(new Event('visibilitychange'));
    expect(playCalls).toBe(plays);

    player.destroy();
  });

  it('does not restart a frame claimed by a capture path', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const player = new Player({ deck: videoDeck(), container: host, resolveSrc: (src) => src });
    const video = host.querySelector('video')!;
    video.dataset.holdFrame = 'true';
    const plays = playCalls;

    video.dispatchEvent(new Event('pause'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(playCalls).toBe(plays);

    player.destroy();
    vi.useRealTimers();
  });

  it('stops listening after destroy', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const player = new Player({ deck: videoDeck(), container: host, resolveSrc: (src) => src });
    player.destroy();
    const plays = playCalls;

    document.dispatchEvent(new Event('visibilitychange'));
    expect(playCalls).toBe(plays);
  });
});
