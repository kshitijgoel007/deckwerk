// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Deck, parseDeck } from '../src/shared/deck.js';
import { renderSlide } from '../src/renderer/player/render.js';

/**
 * The media-loading contract (docs/media-loading.md).
 *
 * A <video> paints nothing until a frame is decoded, each element fetches its
 * file independently, and a browser gives an origin six connections. Break any
 * rule below and the same bug family returns: previews render black, and a
 * deck that reuses one large clip across many elements floods the connection
 * pool at open, starving the present view's own resources for seconds.
 */

function videoDeck(overrides: Record<string, unknown> = {}): Deck {
  return parseDeck({
    version: 1,
    slides: [
      {
        id: 's1',
        elements: [
          {
            id: 'v1',
            type: 'video',
            x: 0, y: 0, w: 640, h: 360,
            src: 'assets/clip.05a38d7a.h264.mp4',
            ...overrides,
          },
        ],
      },
    ],
  });
}

function renderVideoEl(deck: Deck, mediaPreload?: 'auto' | 'metadata'): HTMLVideoElement {
  const root = renderSlide(deck.slides[0], { resolveSrc: (s) => `/x/${s}`, mediaPreload });
  const video = root.querySelector('video');
  expect(video).not.toBeNull();
  return video!;
}

describe('preview frames must be readable', () => {
  /**
   * A preview's frame is captured into a canvas and shown as a still. Drawing
   * a cross-origin frame taints the canvas, so the pixels cannot be read back
   * and the surface falls back to a live video -- the element that goes black.
   * The desktop app is that case: renderer on http(s)/file:, assets on deck:.
   */
  it('asks for CORS on cross-origin preview media, and not on same-origin', () => {
    const deck = videoDeck();
    const remote = renderSlide(deck.slides[0], {
      resolveSrc: (src) => `deck://asset/${src}`,
      mediaPreload: 'metadata',
    }).querySelector('video')!;
    expect(remote.crossOrigin).toBe('anonymous');

    const local = renderVideoEl(deck, 'metadata');
    expect(local.getAttribute('crossorigin')).toBeNull();
  });

  it('serves deck: assets with a CORS header on every path', () => {
    const source = readFileSync(join('src', 'main', 'assetProtocol.ts'), 'utf8');
    // 200/206 share one header map; the 304 branch builds its own.
    expect(source.match(/Access-Control-Allow-Origin/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(2);
  });
});

describe('video preload intent', () => {
  it('defaults to auto for the player, where playback is imminent', () => {
    expect(renderVideoEl(videoDeck()).preload).toBe('auto');
  });

  it('fetches only metadata on preview surfaces', () => {
    expect(renderVideoEl(videoDeck(), 'metadata').preload).toBe('metadata');
  });

  it('seeks one frame under metadata preload, so previews are not black', () => {
    const video = renderVideoEl(videoDeck(), 'metadata');
    video.dispatchEvent(new Event('loadedmetadata'));
    // Nothing else decodes a frame under 'metadata'; a seek a hair past zero
    // is what puts a picture in the element.
    expect(video.currentTime).toBeGreaterThan(0);
  });

  it('seeks to the trim in-point when one is set', () => {
    const video = renderVideoEl(videoDeck({ start: 12.5 }), 'metadata');
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBeCloseTo(12.5);
  });

  it('leaves a frame pinned by a capture path alone', () => {
    const video = renderVideoEl(videoDeck({ start: 12.5 }), 'metadata');
    video.dataset.holdFrame = 'true';
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(0);
  });

  it('does not seek at all under auto preload with no in-point', () => {
    const video = renderVideoEl(videoDeck(), 'auto');
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(0);
  });
});

/**
 * Source-level guards: every preview surface must declare 'metadata', and no
 * asset server may say no-store. Behavioural tests can't reach these callers
 * cheaply, and a silent revert of any one line re-opens the bug.
 */
describe('media-loading contract across surfaces', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it.each([
    'src/renderer/editor/canvas.ts',
    'src/renderer/editor/slideRail.ts',
    'src/renderer/editor/magicMovePanel.ts',
    'src/renderer/editor/agentBridge.ts',
    'src/renderer/editor/renderInvariants.ts',
    'src/renderer/presenter/main.ts',
  ])('%s renders previews with metadata preload', (file) => {
    expect(read(file)).toContain("mediaPreload: 'metadata'");
  });

  it('freezes Speaker View videos into session-cached stills', () => {
    const source = read('src/renderer/presenter/main.ts');
    expect(source).toContain('freezePreviewVideos(stage)');
    expect(source).toContain('revealImagesWhenDecoded(stage)');
  });

  it('the live player is the one auto-preload surface', () => {
    expect(read('src/renderer/player/player.ts')).not.toContain('mediaPreload');
  });

  it('the editor canvas keeps decoded videos alive across slide rebuilds', () => {
    // Switching slides rebuilds the layer; without harvest/adopt every video
    // restarts from "no frame decoded" — black until the network round-trips.
    const source = read('src/renderer/editor/canvas.ts');
    expect(source).toContain('this.harvestVideos()');
    expect(source).toContain('this.adoptVideos(slide)');
  });

  it.each([
    'src/server/collabServer.ts',
    'src/main/assetProtocol.ts',
  ])('%s never serves assets no-store', (file) => {
    const source = read(file);
    expect(source).toContain('immutable');
    // The collab server legitimately no-stores HTML/JSON routes; the asset
    // streamer itself must not.
    const assetSection = source.includes('serveFileWithRanges')
      ? source.slice(source.indexOf('async function serveFileWithRanges'))
      : source;
    expect(assetSection).not.toMatch(/['"]no-store['"]/);
  });
});
