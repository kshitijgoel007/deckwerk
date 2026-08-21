// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { Player } from '../src/renderer/player/player.js';

/**
 * Media has to survive a Magic Move, not just be positioned correctly by one.
 *
 * `magicMoveTransform.test.ts` proves the arithmetic and `magicMoveBrowser`
 * proves the geometry. Neither notices the failure this file exists for: the
 * transition completes, every wrapper is in the right place at the right size,
 * and the picture inside it is simply gone. Borders and effects are painted by
 * separate nodes from the media body, so a lost `<video>` leaves a perfectly
 * placed empty rectangle with its border still on it — which reads as
 * "the video went transparent" rather than as a missing element.
 *
 * So the assertion here is deliberately about survival rather than position:
 * after the move, every image and video still has a media body carrying its
 * source, and every typed border and effect is still painted. The matrix below
 * crosses image/video with bordered/unbordered, effects, crops, masks and
 * shared source files, because the paths that drop media are the ones that key
 * off those properties.
 */

const CASES: ReadonlyArray<{
  name: string;
  type: 'image' | 'video';
  /** Several entries deliberately share one file; see `sharedSrc` below. */
  src: string;
  border?: { width: number; color: string };
  radius?: number;
  effects?: SlideElement extends never ? never : NonNullable<Extract<SlideElement, { type: 'image' }>['effects']>;
  mask?: 'circle';
  /** Cropped on the source slide, uncropped on the target — the shape that broke. */
  cropOnSource?: boolean;
}> = [
  { name: 'video-plain', type: 'video', src: 'assets/shared.mp4' },
  {
    name: 'video-bordered',
    type: 'video',
    src: 'assets/shared.mp4',
    border: { width: 10, color: '#d14747' },
  },
  {
    name: 'video-bordered-cropped',
    type: 'video',
    src: 'assets/shared.mp4',
    border: { width: 10, color: '#d14747' },
    cropOnSource: true,
  },
  {
    name: 'video-effects',
    type: 'video',
    src: 'assets/shared.mp4',
    effects: [{ type: 'blur', radius: 4 }, { type: 'grayscale', amount: 0.5 }],
  },
  {
    name: 'video-own-file',
    type: 'video',
    src: 'assets/only-mine.mp4',
    border: { width: 4, color: '#2255aa' },
    radius: 12,
  },
  { name: 'image-plain', type: 'image', src: 'assets/shared.png' },
  {
    name: 'image-bordered',
    type: 'image',
    src: 'assets/shared.png',
    border: { width: 6, color: '#33aa55' },
    radius: 8,
  },
  {
    name: 'image-effects-masked',
    type: 'image',
    src: 'assets/shared.png',
    effects: [{ type: 'posterize', levels: 6 }],
    mask: 'circle',
    cropOnSource: true,
  },
];

function media(
  slide: 'a' | 'b',
  index: number,
  spec: (typeof CASES)[number],
): SlideElement {
  const cropped = spec.cropOnSource && slide === 'a';
  const base = {
    id: `${spec.name}-${slide}`,
    // Paired across the two slides by an explicit shared identity, exactly as
    // the editor's Magic Move pairing writes it.
    magicMoveId: `magic-${spec.name}`,
    x: 80 + index * 20,
    y: slide === 'a' ? 100 : 400,
    w: cropped ? 200 : 440,
    h: cropped ? 200 : 440,
    rot: 0,
    z: index + 1,
    opacity: 1,
    class: [],
    style: {},
    fit: 'contain' as const,
    ...(spec.border ? { borderWidth: spec.border.width, borderColor: spec.border.color } : {}),
    ...(spec.radius === undefined ? {} : { borderRadius: spec.radius }),
    ...(spec.effects ? { effects: spec.effects } : {}),
    ...(spec.mask ? { maskShape: spec.mask } : {}),
    sourceBox: cropped ? { x: 0, y: -230, w: 440, h: 440 } : null,
  };
  if (spec.type === 'video') {
    return {
      ...base,
      type: 'video',
      src: spec.src,
      autoplay: true,
      loop: true,
      muted: true,
      controls: false,
      start: 0,
      end: null,
      poster: null,
    } as SlideElement;
  }
  return { ...base, type: 'image', src: spec.src, alt: '' } as SlideElement;
}

function deckWithMagicMovedMedia(): Deck {
  const deck = emptyDeck('Magic Move media');
  deck.slides[0].elements = CASES.map((spec, i) => media('a', i, spec));
  deck.slides.push({
    ...deck.slides[0],
    id: 'slide-b',
    magicMoveFromPrevious: true,
    elements: CASES.map((spec, i) => media('b', i, spec)),
  });
  return deck;
}

/** A colour as the DOM reports it back, so hex and rgb() forms compare equal. */
function normalizeColor(value: string): string {
  const probe = document.createElement('div');
  probe.style.borderColor = value;
  return probe.style.borderColor;
}

/** The node that actually paints the picture, however deeply a crop nests it. */
function mediaBody(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>('img, video, .pending-asset');
}

describe('magic move media survival', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    if (!globalThis.CSS) (globalThis as unknown as { CSS: typeof CSS }).CSS = {} as typeof CSS;
    if (!CSS.escape) CSS.escape = (value) => value;
    // jsdom has no playback; the player only ever calls these two.
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    HTMLMediaElement.prototype.load = () => {};
  });

  it('keeps every image and video painted across a Magic Move, with borders and effects', () => {
    const deck = deckWithMagicMovedMedia();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const player = new Player({ deck, container: host, resolveSrc: (src) => `/deck/${src}` });
    const stage = host.querySelector<HTMLElement>('.stage')!;

    // Every video on the source slide is mid-playback, which is what makes the
    // player try to carry live elements into the next slide instead of using
    // the freshly rendered ones.
    for (const video of stage.querySelectorAll('video')) {
      Object.defineProperty(video, 'paused', { value: false, configurable: true });
      Object.defineProperty(video, 'currentTime', { value: 3, configurable: true });
    }
    expect(stage.querySelectorAll('video, img')).toHaveLength(CASES.length);

    player.next();

    for (const spec of CASES) {
      const id = `${spec.name}-b`;
      const wrapper = stage.querySelector<HTMLElement>(`[data-element-id="${id}"]`);
      expect(wrapper, `${spec.name}: wrapper missing after Magic Move`).toBeTruthy();

      const body = mediaBody(wrapper!);
      expect(body, `${spec.name}: media body lost — wrapper survived but paints nothing`)
        .toBeTruthy();
      expect(body!.tagName.toLowerCase(), `${spec.name}: wrong media body`)
        .toBe(spec.type === 'video' ? 'video' : 'img');
      expect(
        body!.getAttribute('src'),
        `${spec.name}: media body kept no source`,
      ).toBe(`/deck/${spec.src}`);

      if (spec.border) {
        const overlay = wrapper!.querySelector<HTMLElement>(':scope > .media-border-overlay');
        expect(overlay, `${spec.name}: border overlay lost`).toBeTruthy();
        expect(overlay!.style.borderWidth, `${spec.name}: border width changed`)
          .toBe(`${spec.border.width}px`);
        expect(overlay!.style.borderStyle, `${spec.name}: border style changed`).toBe('solid');
        // Compared through the DOM's own normalisation, since a colour set as
        // hex is read back as rgb().
        expect(overlay!.style.borderColor, `${spec.name}: border colour changed`)
          .toBe(normalizeColor(spec.border.color));
      }
    }

    // No media may be left stranded: one body per element, no duplicates and
    // no orphans parked outside a wrapper by a failed hand-off.
    expect(stage.querySelectorAll('video, img')).toHaveLength(CASES.length);
  });

  /**
   * The other half of the contract. Survival alone could be satisfied by never
   * carrying anything over, which would reintroduce the decoder flash the
   * hand-off exists to prevent — so pin the continuation too.
   */
  it('still continues a playing video across the move rather than restarting it', () => {
    const deck = deckWithMagicMovedMedia();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const player = new Player({ deck, container: host, resolveSrc: (src) => `/deck/${src}` });
    const stage = host.querySelector<HTMLElement>('.stage')!;

    const live = stage.querySelector<HTMLVideoElement>(
      '[data-element-id="video-own-file-a"] video',
    )!;
    Object.defineProperty(live, 'paused', { value: false, configurable: true });
    Object.defineProperty(live, 'currentTime', { value: 7, configurable: true });
    live.dataset.continuedFrom = 'slide-a';

    player.next();

    const adopted = stage.querySelector<HTMLVideoElement>(
      '[data-element-id="video-own-file-b"] video',
    );
    expect(adopted, 'the target slot lost its video entirely').toBeTruthy();
    expect(adopted, 'the playing element was not carried into the next slide').toBe(live);
    expect(adopted!.dataset.continuedFrom).toBe('slide-a');
    // Carried once, not left behind in the slot it came from as well.
    expect(stage.querySelectorAll('[data-continued-from]')).toHaveLength(1);
  });
});
