// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { parseDeck, type Deck } from '../src/shared/deck.js';
import {
  CLIPBOARD_FORMAT,
  type ClipboardPayload,
  type ClipboardWriteRequest,
  collectAssetSrcs,
  parseClipboardPayload,
  remapElementIds,
  rewriteAssetSrcs,
} from '../src/shared/clipboard.js';
import {
  EditorStore,
  copySelectionToClipboard,
  copySlidesToClipboard,
  pasteFromClipboard,
} from '../src/renderer/editor/store.js';

/**
 * Cross-instance copy/paste. Two stores stand in for two running apps; the
 * mock below plays the part of the OS pasteboard the main processes share.
 */

function sampleDeck(): Deck {
  return parseDeck({
    version: 1,
    title: 'Clipboard deck',
    slides: [
      {
        id: 'slide-1',
        background: { color: null, image: 'assets/bg.png' },
        elements: [
          { id: 'text-1', type: 'text', x: 0, y: 0, w: 400, h: 100, html: 'Hi' },
          { id: 'image-1', type: 'image', x: 10, y: 10, w: 300, h: 200, src: 'assets/fig.png' },
          {
            id: 'video-1', type: 'video', x: 20, y: 20, w: 640, h: 360,
            src: 'assets/clip.mp4', poster: 'assets/poster.jpg',
          },
        ],
        timeline: [
          {
            id: 't-1',
            trigger: { on: 'click', ref: null, delay: 0 },
            action: { type: 'appear', target: 'image-1', value: null },
          },
          {
            id: 't-2',
            trigger: { on: 'afterPrev', ref: 'text-1', delay: 100 },
            action: { type: 'play', target: 'video-1', value: null },
          },
        ],
      },
      { id: 'slide-2', elements: [], timeline: [] },
    ],
  });
}

/** In-memory stand-in for the OS pasteboard, shared by every "instance". */
let pasteboard: ClipboardPayload | null = null;

beforeEach(() => {
  pasteboard = null;
  (globalThis as unknown as { window: Window }).window.api = {
    writeClipboard: async (request: ClipboardWriteRequest) => {
      // What the main process does, minus asset path resolution: envelope,
      // serialise, validate on the way back out.
      pasteboard = parseClipboardPayload(JSON.parse(JSON.stringify({
        format: CLIPBOARD_FORMAT,
        version: 1,
        ...request,
        assets: collectAssetSrcs(request).map((src) => ({ src, absPath: `/src-deck/${src}` })),
      })));
    },
    readClipboard: async () => structuredClone(pasteboard),
  } as unknown as Window['api'];
});

describe('clipboard payload', () => {
  it('rejects foreign or stale pasteboard content', () => {
    expect(parseClipboardPayload({ hello: 'world' })).toBeNull();
    expect(parseClipboardPayload({ format: CLIPBOARD_FORMAT, version: 1, kind: 'elements', elements: [] })).toBeNull();
  });

  it('collects every referenced asset once', () => {
    const deck = sampleDeck();
    expect(collectAssetSrcs({ kind: 'slides', slides: deck.slides }).sort()).toEqual([
      'assets/bg.png', 'assets/clip.mp4', 'assets/fig.png', 'assets/poster.jpg',
    ]);
  });

  it('rewrites srcs to the destination deck, leaving unmapped ones visible', () => {
    const deck = sampleDeck();
    const payload = { kind: 'slides', slides: deck.slides, format: CLIPBOARD_FORMAT, version: 1, assets: [] } as ClipboardPayload;
    rewriteAssetSrcs(payload, new Map([
      ['assets/fig.png', 'assets/fig.abcd1234.png'],
      ['assets/bg.png', 'assets/bg.abcd1234.png'],
    ]));
    if (payload.kind !== 'slides') throw new Error('expected slides');
    const [slide] = payload.slides;
    expect(slide.background.image).toBe('assets/bg.abcd1234.png');
    expect(slide.elements[1]).toMatchObject({ src: 'assets/fig.abcd1234.png' });
    // Unmapped: the video keeps its old path (renders broken, not vanished).
    expect(slide.elements[2]).toMatchObject({ src: 'assets/clip.mp4', poster: 'assets/poster.jpg' });
  });

  it('remaps timeline refs and nulls refs that point outside the copy', () => {
    const deck = sampleDeck();
    const [slide] = deck.slides;
    const elements = slide.elements.filter((el) => el.id !== 'text-1');
    remapElementIds(elements, slide.timeline);
    const [image, video] = elements;
    expect(image.id).not.toBe('image-1');
    expect(slide.timeline[0].action.target).toBe(image.id);
    expect(slide.timeline[1].action.target).toBe(video.id);
    // t-2 was triggered by text-1, which did not travel.
    expect(slide.timeline[1].trigger.ref).toBeNull();
  });
});

describe('cross-instance copy/paste', () => {
  it('pastes elements with their builds into a second instance', async () => {
    const source = new EditorStore(sampleDeck(), '/src-deck');
    source.select(['image-1', 'video-1']);
    expect(await copySelectionToClipboard(source)).toBe(2);

    const destDeck = sampleDeck();
    destDeck.slides = [{ ...destDeck.slides[1] }];
    const dest = new EditorStore(parseDeck(destDeck), '/dest-deck');
    const result = await pasteFromClipboard(dest);
    expect(result).toEqual({ kind: 'elements', count: 2 });

    const slide = dest.slide!;
    expect(slide.elements).toHaveLength(2);
    // Fresh ids, ancestry kept.
    expect(slide.elements.map((el) => el.id)).not.toContain('image-1');
    expect(slide.elements[0].lineageId).toBe('image-1');
    // The two timeline entries targeting copied elements travelled and were remapped.
    expect(slide.timeline).toHaveLength(2);
    expect(slide.timeline[0].action.target).toBe(slide.elements[0].id);
    expect(slide.timeline[1].trigger.ref).toBeNull();
  });

  it('pastes whole slides after the current one in a second instance', async () => {
    const source = new EditorStore(sampleDeck(), '/src-deck');
    source.selectSlide(0);
    expect(await copySlidesToClipboard(source)).toBe(1);

    const dest = new EditorStore(sampleDeck(), '/dest-deck');
    dest.selectSlide(1);
    const result = await pasteFromClipboard(dest);
    expect(result).toEqual({ kind: 'slides', count: 1 });

    const { deck, slideIndex } = dest.get();
    expect(deck.slides).toHaveLength(3);
    expect(slideIndex).toBe(2);
    const pasted = deck.slides[2];
    expect(pasted.id).not.toBe('slide-1');
    expect(pasted.elements).toHaveLength(3);
    expect(pasted.elements.map((el) => el.id)).not.toContain('image-1');
    const image = pasted.elements.find((el) => el.lineageId === 'image-1')!;
    expect(pasted.timeline[0].action.target).toBe(image.id);
    expect(pasted.magicMoveFromPrevious).toBe(false);
  });

  it('pasting twice mints distinct ids each time', async () => {
    const store = new EditorStore(sampleDeck(), '/src-deck');
    store.select(['text-1']);
    await copySelectionToClipboard(store);
    await pasteFromClipboard(store);
    const [first] = [...store.get().selection];
    await pasteFromClipboard(store);
    const [second] = [...store.get().selection];
    expect(first).not.toBe(second);
    expect(store.slide!.elements).toHaveLength(5);
  });
});
