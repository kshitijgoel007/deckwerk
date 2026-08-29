// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { Player } from '../src/renderer/player/player.js';

/**
 * Navigation must not throw away video elements it can reuse, and must not
 * leave the ones it does throw away downloading.
 *
 * The bug class this guards (docs/media-loading.md): the player used to carry
 * only *playing* videos across a slide change. Everything else — a clip whose
 * first frame had not arrived yet, a clip on a revisited slide — was rebuilt
 * from scratch, restarting its fetch from byte zero; and every replaced or
 * discarded element kept its own fetch running after leaving the DOM, because
 * a detached media element keeps downloading. On a slow link a couple of
 * forward/back navigations were enough to occupy all six of the origin's
 * connections with orphaned downloads, at which point the visible slide's
 * videos sat on a loading spinner forever.
 */

function videoElement(
  id: string,
  src: string,
  start = 0,
  extra: Record<string, unknown> = {},
): SlideElement {
  return {
    id,
    type: 'video',
    x: 0, y: 0, w: 640, h: 360, rot: 0, z: 1, opacity: 1,
    class: [], style: {},
    src,
    poster: null, start, end: null,
    autoplay: false, loop: true, muted: true, controls: false,
    fit: 'contain',
    ...extra,
  } as unknown as SlideElement;
}

function imageElement(id: string, src: string): SlideElement {
  return {
    id,
    type: 'image',
    x: 0, y: 0, w: 640, h: 360, rot: 0, z: 1, opacity: 1,
    class: [], style: {},
    src,
    alt: '',
    fit: 'fill',
    sourceBox: null,
  } as unknown as SlideElement;
}

function deckWith(slides: SlideElement[][]): Deck {
  const deck = emptyDeck('Video reuse');
  deck.slides = slides.map((elements, i) => ({
    ...deck.slides[0],
    id: `s${i}`,
    elements,
  }));
  return deck;
}

function fakeReadyState(video: HTMLVideoElement, value: number): void {
  Object.defineProperty(video, 'readyState', { value, configurable: true });
}

let host: HTMLElement;
let player: Player | null = null;
const originalImageDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
const originalImageComplete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
const originalImageNaturalWidth = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  'naturalWidth',
);

function restoreImageProperty(
  name: 'decode' | 'complete' | 'naturalWidth',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(HTMLImageElement.prototype, name, descriptor);
  else Reflect.deleteProperty(HTMLImageElement.prototype, name);
}

const stageVideo = (): HTMLVideoElement => {
  const video = host.querySelector('video');
  expect(video).not.toBeNull();
  return video!;
};

beforeEach(() => {
  document.body.replaceChildren();
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  if (!globalThis.CSS) (globalThis as unknown as { CSS: typeof CSS }).CSS = {} as typeof CSS;
  if (!CSS.escape) CSS.escape = (value) => value;
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = function () {
    this.dispatchEvent(new Event('emptied'));
  };
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  player?.destroy();
  player = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreImageProperty('decode', originalImageDecode);
  restoreImageProperty('complete', originalImageComplete);
  restoreImageProperty('naturalWidth', originalImageNaturalWidth);
});

describe('video element reuse across navigation', () => {
  it('adopts a decoded, parked video into the next slide instead of refetching', () => {
    const deck = deckWith([
      [videoElement('a', 'assets/clip.05a38d7a.h264.mp4')],
      [videoElement('b', 'assets/clip.05a38d7a.h264.mp4')],
    ]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });
    const first = stageVideo();
    fakeReadyState(first, HTMLMediaElement.HAVE_ENOUGH_DATA);

    player.goToSlide(1);
    expect(stageVideo()).toBe(first);
    expect(first.getAttribute('src')).toBe('/x/assets/clip.05a38d7a.h264.mp4');
  });

  it('returns the same element from the pool when navigating back', () => {
    const deck = deckWith([
      [videoElement('a', 'assets/clip.05a38d7a.h264.mp4', 7)],
      [], // an all-text slide between the two visits
    ]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });
    const first = stageVideo();
    fakeReadyState(first, HTMLMediaElement.HAVE_ENOUGH_DATA);
    first.currentTime = 42;

    player.goToSlide(1);
    expect(host.querySelector('video')).toBeNull();

    player.goToSlide(0);
    const revisited = stageVideo();
    expect(revisited).toBe(first);
    // A revisit restarts the clip at its in-point, like a fresh render would.
    expect(revisited.currentTime).toBeCloseTo(7);
  });

  it('keeps a playing video going across consecutive slides (continuity)', () => {
    const deck = deckWith([
      [videoElement('a', 'assets/clip.05a38d7a.h264.mp4')],
      [videoElement('b', 'assets/clip.05a38d7a.h264.mp4')],
    ]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });
    const first = stageVideo();
    fakeReadyState(first, HTMLMediaElement.HAVE_ENOUGH_DATA);
    Object.defineProperty(first, 'paused', { value: false, configurable: true });
    first.currentTime = 3.5;

    player.goToSlide(1);
    const adopted = stageVideo();
    expect(adopted).toBe(first);
    // Continuity, not a restart: "plays across slides" keeps its position.
    expect(adopted.currentTime).toBeCloseTo(3.5);
  });

  it('aborts the fetch of a discarded still-loading video', () => {
    const deck = deckWith([
      [videoElement('a', 'assets/clip.05a38d7a.h264.mp4')],
      [], // nothing adopts the clip, and it has no frame worth pooling
    ]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });
    const first = stageVideo();
    expect(first.readyState).toBe(0); // still loading — jsdom never decodes

    player.goToSlide(1);
    // Not pooled (no decoded frame), so its download must be stopped: a
    // detached media element otherwise keeps a connection busy indefinitely.
    expect(first.hasAttribute('src')).toBe(false);
  });

  it('aborts every leftover video when the player is destroyed', () => {
    const deck = deckWith([[videoElement('a', 'assets/clip.05a38d7a.h264.mp4')]]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });
    const video = stageVideo();

    player.destroy();
    player = null;
    expect(video.hasAttribute('src')).toBe(false);
  });
});

/**
 * One clip shown through several different crops and in-points — what a
 * Keynote import routinely produces — must not be shuffled between those
 * slots. Pooling by file alone did exactly that: the cropped slot's element
 * (its frame decoded stretched into an 886x1268 box under `object-fit: fill`)
 * was handed to a square `contain` slot and vice versa, so each needed a seek
 * to the other's in-point. Until that seek lands the compositor keeps painting
 * the old texture scaled into the new box, which reads as a video that is
 * vertically squished for about half a second and then pops straight.
 */
describe('reuse never crosses presentations', () => {
  const CLIP = 'assets/clip.05a38d7a.h264.mp4';
  const cropped = (id: string) => videoElement(id, CLIP, 66.93, {
    w: 476, h: 458,
    sourceBox: { x: 0, y: -810, w: 886, h: 1268 },
  });
  const square = (id: string) => videoElement(id, CLIP, 0, { w: 458, h: 458 });

  it('does not hand a cropped slot’s element to a square slot', () => {
    const deck = deckWith([
      [square('a-sq'), cropped('a-crop')],
      [square('b-sq'), cropped('b-crop')],
    ]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });
    const nodeOf = (id: string) => host.querySelector<HTMLVideoElement>(
      `[data-element-id="${id}"] video`,
    )!;
    const firstSquare = nodeOf('a-sq');
    const firstCropped = nodeOf('a-crop');
    for (const video of [firstSquare, firstCropped]) {
      fakeReadyState(video, HTMLMediaElement.HAVE_ENOUGH_DATA);
    }
    firstSquare.currentTime = 0;
    firstCropped.currentTime = 66.93;

    player.goToSlide(1);

    // Each slot gets back the element that was already showing its own frame
    // through its own geometry — never the other one's.
    expect(nodeOf('b-sq')).toBe(firstSquare);
    expect(nodeOf('b-crop')).toBe(firstCropped);
    // And therefore nothing has to be re-seeked to a different in-point.
    expect(nodeOf('b-sq').currentTime).toBeCloseTo(0);
    expect(nodeOf('b-crop').currentTime).toBeCloseTo(66.93);
  });

  it('leaves a slot fresh rather than adopting a mismatched picture', () => {
    // Only a cropped element is available; the next slide wants a square one.
    const deck = deckWith([[cropped('only-crop')], [square('wants-square')]]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });
    const croppedNode = host.querySelector<HTMLVideoElement>('[data-element-id="only-crop"] video')!;
    fakeReadyState(croppedNode, HTMLMediaElement.HAVE_ENOUGH_DATA);

    player.goToSlide(1);
    const squareNode = host.querySelector<HTMLVideoElement>(
      '[data-element-id="wants-square"] video',
    )!;
    // A fresh element paints nothing until it has a frame, which is honest;
    // adopting the cropped element would paint a distorted one.
    expect(squareNode).not.toBe(croppedNode);
    expect(squareNode.dataset.mediaKey).not.toBe(croppedNode.dataset.mediaKey);
  });

  it('still carries a playing clip across differently shaped slots', () => {
    // Continuity is the exception: an element that keeps decoding repaints
    // every frame, so "plays across slides" may change shape mid-clip.
    const deck = deckWith([[square('play-sq')], [cropped('then-crop')]]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });
    const playing = host.querySelector<HTMLVideoElement>('[data-element-id="play-sq"] video')!;
    fakeReadyState(playing, HTMLMediaElement.HAVE_ENOUGH_DATA);
    Object.defineProperty(playing, 'paused', { value: false, configurable: true });
    playing.currentTime = 4;

    player.goToSlide(1);
    expect(host.querySelector('[data-element-id="then-crop"] video')).toBe(playing);
    expect(playing.currentTime).toBeCloseTo(4);
    // Its pooling identity moves with it, so the next hop reuses it correctly.
    expect(playing.dataset.mediaKey).toContain('886');
  });
});

describe('warming upcoming slides', () => {
  it('prefetches the next slides’ clips one at a time, skipping the current slide’s', async () => {
    const fetched: string[] = [];
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const fetchStub = vi.fn((url: string) => {
      fetched.push(url);
      const response = { ok: true, blob: () => Promise.resolve(new Blob()) };
      return fetched.length === 1
        ? gate.then(() => response)
        : Promise.resolve(response);
    });
    vi.stubGlobal('fetch', fetchStub);

    const deck = deckWith([
      [videoElement('cur', 'assets/current.aaaaaaaa.mp4')],
      // Shares the current slide's clip — its bytes are already on their way
      // through the slide's own element, so warming it would double-fetch.
      [videoElement('n1', 'assets/current.aaaaaaaa.mp4'),
        videoElement('n2', 'assets/next.bbbbbbbb.mp4')],
      [videoElement('n3', 'assets/later.cccccccc.mp4')],
    ]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });

    // Strictly one warm transfer in flight: the second file waits for the first.
    expect(fetched).toEqual(['/x/assets/next.bbbbbbbb.mp4']);
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetched).toEqual(['/x/assets/next.bbbbbbbb.mp4', '/x/assets/later.cccccccc.mp4']);
    expect(fetched).not.toContain('/x/assets/current.aaaaaaaa.mp4');
  });

  it('never warms the same file twice', () => {
    const fetchStub = vi.fn(() =>
      Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob()) }));
    vi.stubGlobal('fetch', fetchStub);

    const deck = deckWith([
      [],
      [videoElement('n1', 'assets/next.bbbbbbbb.mp4')],
      [videoElement('n2', 'assets/next.bbbbbbbb.mp4')],
    ]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });
    player.goToSlide(1);
    player.goToSlide(0);
    const warmCalls = (fetchStub.mock.calls as unknown as string[][])
      .filter(([url]) => String(url).includes('next'));
    expect(warmCalls.length).toBe(1);
  });

  it('counts presentable slides rather than skipped slides in its warm horizon', async () => {
    const fetched: string[] = [];
    const fetchStub = vi.fn((url: string) => {
      fetched.push(url);
      return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob()) });
    });
    vi.stubGlobal('fetch', fetchStub);

    const deck = deckWith([
      [],
      [videoElement('hidden', 'assets/hidden.aaaaaaaa.mp4')],
      [videoElement('next', 'assets/next.bbbbbbbb.mp4')],
      [videoElement('later', 'assets/later.cccccccc.mp4')],
    ]);
    deck.slides[1].skipped = true;
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetched).toEqual([
      '/x/assets/next.bbbbbbbb.mp4',
      '/x/assets/later.cccccccc.mp4',
    ]);
    expect(fetched).not.toContain('/x/assets/hidden.aaaaaaaa.mp4');
  });

  it('predecodes an upcoming image and adopts that same element on entry', () => {
    const decode = vi.fn(() => Promise.resolve());
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: decode,
    });
    Object.defineProperty(HTMLImageElement.prototype, 'complete', {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
      configurable: true,
      get: () => 100,
    });

    const deck = deckWith([[], [imageElement('photo', 'assets/photo.12345678.jpeg')]]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });
    expect(decode).toHaveBeenCalledOnce();
    const warmed = document.querySelector<HTMLImageElement>('img');
    expect(warmed).toBeNull();

    player.goToSlide(1);
    const shown = host.querySelector<HTMLImageElement>('img');
    expect(shown).not.toBeNull();
    // The lookahead image's decode was the only decode request: the fresh
    // render was replaced by that already-decoded node rather than starting
    // over when the slide became visible.
    expect(decode).toHaveBeenCalledOnce();
    expect(shown?.getAttribute('src')).toBe('/x/assets/photo.12345678.jpeg');
  });

  it('hides an uncached image until its complete load event', async () => {
    Object.defineProperty(HTMLImageElement.prototype, 'complete', {
      configurable: true,
      get: () => false,
    });
    Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');

    const deck = deckWith([[imageElement('photo', 'assets/photo.12345678.jpeg')]]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });
    const image = host.querySelector<HTMLImageElement>('img')!;
    expect(image.style.visibility).toBe('hidden');

    image.dispatchEvent(new Event('load'));
    await Promise.resolve();
    await Promise.resolve();
    expect(image.style.visibility).toBe('');
  });
});
