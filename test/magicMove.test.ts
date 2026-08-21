// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, parseDeck, type SlideElement } from '../src/shared/deck.js';
import {
  essentialMagicMovePairs,
  explicitMagicMovePairs,
  suggestMagicMovePairs,
  unchangedMagicMovePairs,
} from '../src/shared/magicMove.js';
import { MagicMovePanel } from '../src/renderer/editor/magicMovePanel.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { Player, matchMagicMoveElements } from '../src/renderer/player/player.js';

const text = (id: string, html: string, x = 0): SlideElement => ({
  id, type: 'text', x, y: 0, w: 300, h: 80, rot: 0, z: 1,
  opacity: 1, class: ['role-title'], style: {}, html, align: 'left', valign: 'top',
});

function twoSlideDeck() {
  const deck = emptyDeck('Magic');
  deck.slides[0].elements = [text('source', 'A shared title')];
  deck.slides.push({
    id: 'slide-2', name: '', background: { color: null, image: null }, notes: '',
    timeline: [], elements: [text('target', 'A shared title', 600)],
  });
  return deck;
}

describe('Magic Move matching', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    (globalThis as unknown as { window: Window }).window.api = {
      assetUrl: (src: string) => src,
    } as never;
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    if (!globalThis.CSS) (globalThis as unknown as { CSS: typeof CSS }).CSS = {} as typeof CSS;
    if (!CSS.escape) CSS.escape = (value) => value;
  });

  it('keeps modal object hover transparent despite the global button hover', () => {
    const css = readFileSync('src/renderer/editor/editor.css', 'utf8');
    const globalHover = css.lastIndexOf('button:hover:not(:disabled)');
    const objectHover = css.lastIndexOf('button.magic-object-hit:hover:not(:disabled)');
    expect(objectHover).toBeGreaterThan(globalHover);
    expect(css.slice(objectHover, objectHover + 180)).toContain('rgb(245 158 11 / 3%)');
  });

  it('essentially pairs objects that differ only by sub-epsilon drift', () => {
    const arrow = (id: string, x: number, y: number, w: number, rot: number): SlideElement => ({
      id, type: 'shape', shape: 'arrow', x, y, w, h: 1, rot, z: 1, opacity: 1,
      class: [], style: {}, fill: null, stroke: '#000000', strokeWidth: 6,
      radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: true,
    });
    // The drifted twin pairs; the relocated and restyled arrows decisively do not.
    const previous = [
      arrow('drifted-src', 367.5, 643.62, 167.35, 90.1),
      arrow('moved-src', 122.51, 566.6, 329.57, 90.07),
    ];
    const next = [
      arrow('drifted-dst', 367.12, 648.43, 167.14, 90.43),
      arrow('moved-dst', 611.75, 564.07, 329.8, 90.07),
      { ...arrow('restyled-dst', 367.5, 643.62, 167.35, 90.1), stroke: '#ff0000' },
    ];
    expect(essentialMagicMovePairs(previous, next).map((pair) => pair.map((el) => el.id)))
      .toEqual([['drifted-src', 'drifted-dst']]);
  });

  it('pairs nothing by default, even when visible content is identical', () => {
    const deck = twoSlideDeck();
    expect(matchMagicMoveElements(deck.slides[0].elements, deck.slides[1].elements)).toEqual([]);
  });

  it('animates only objects sharing an explicit pairing id', () => {
    const deck = twoSlideDeck();
    deck.slides[0].elements[0].magicMoveId = 'pair-1';
    deck.slides[1].elements[0].magicMoveId = 'pair-1';
    expect(explicitMagicMovePairs(deck.slides[0].elements, deck.slides[1].elements))
      .toEqual([[deck.slides[0].elements[0], deck.slides[1].elements[0]]]);
  });

  it('pairs a duplicated pairing id with the nearest object, not the last one', () => {
    // Copied authoring HTML can put one pairing id on two objects. Whichever
    // the map happened to keep would animate from the far side of the slide.
    const previous = [
      text('far', 'Duplicated id', 1600),
      text('near', 'Duplicated id', 20),
    ];
    previous[0].magicMoveId = 'dup';
    previous[1].magicMoveId = 'dup';
    const target = text('landing', 'Duplicated id', 40);
    target.magicMoveId = 'dup';

    expect(explicitMagicMovePairs(previous, [target])).toEqual([[previous[1], target]]);
  });

  it('gives two objects sharing one id a source each rather than one twice', () => {
    const previous = [text('left', 'Split', 0), text('right', 'Split', 900)];
    for (const element of previous) element.magicMoveId = 'dup';
    const targets = [text('to-right', 'Split', 940), text('to-left', 'Split', 60)];
    for (const element of targets) element.magicMoveId = 'dup';

    expect(explicitMagicMovePairs(previous, targets)).toEqual([
      [previous[1], targets[0]],
      [previous[0], targets[1]],
    ]);
  });

  it('skips objects that are visually identical and therefore never animate', () => {
    const source = [text('a', 'The same title')];
    const target = [text('c', 'The same title')];
    expect(suggestMagicMovePairs(source, target)).toEqual([]);
  });

  it('suggests strong matches without pairing unrelated same-type objects', () => {
    const source = [text('a', 'The same title'), text('b', 'Completely unrelated')];
    const target = [text('c', 'The same title', 600), text('d', 'Nothing in common', 600)];
    expect(suggestMagicMovePairs(source, target).map(([a, b]) => [a.id, b.id]))
      .toEqual([['a', 'c']]);
  });

  it('does not greedily pair every same-styled arrow on slides 18 and 19', () => {
    const arrow = (id: string, x: number, y: number, w: number): SlideElement => ({
      id, type: 'shape', shape: 'arrow', x, y, w, h: 1, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, fill: null, stroke: '#000000',
      strokeWidth: 7, radius: 0, path: null, pathSize: null,
      arrowStart: false, arrowEnd: true,
    });
    const previous = [
      arrow('shape-589', 778.38, 718.34, 186.35),
      arrow('shape-590', 367.5, 643.62, 167.35),
      arrow('shape-591', 122.51, 566.6, 329.57),
    ];
    const next = [
      arrow('shape-604', 367.12, 648.43, 167.14),
      arrow('shape-605', 611.75, 564.07, 329.8),
    ];
    // shape-590 → shape-604 is a sub-epsilon drift the essential matcher
    // already glides at runtime, so it needs no explicit pair suggestion.
    expect(suggestMagicMovePairs(previous, next).map(([source, target]) =>
      [source.id, target.id])).toEqual([
      ['shape-591', 'shape-605'],
    ]);
  });

  it('enables Magic Move from the panel button even with no matches to pair', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/magic');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new MagicMovePanel(host, store);
    expect(host.querySelector('.magic-enable .field-check, .magic-enable')!.textContent)
      .toContain('Enabled');
    host.querySelector<HTMLButtonElement>('.magic-enable-pair')!.click();
    expect(store.get().deck.slides[1].magicMoveFromPrevious).toBe(true);
    expect(host.textContent).toContain('Enabled Magic Move');
    host.remove();
  });

  it('pairs objects by clicking the two large slide previews in the modal', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/magic');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new MagicMovePanel(host, store);
    host.querySelector<HTMLButtonElement>('.magic-open')!.click();

    const modal = document.querySelector('.magic-modal')!;
    expect(modal.querySelectorAll('.magic-preview')).toHaveLength(2);
    modal.querySelector<HTMLButtonElement>('[data-side="source"][data-element-id="source"]')!.click();
    expect(modal.textContent).toContain('Now choose its partner');
    document.querySelector<HTMLButtonElement>('.magic-modal [data-side="target"][data-element-id="target"]')!.click();

    const source = store.get().deck.slides[0].elements[0];
    const target = store.get().deck.slides[1].elements[0];
    expect(source.magicMoveId).toBeTruthy();
    expect(target.magicMoveId).toBe(source.magicMoveId);
    expect(store.get().deck.slides[1].magicMoveFromPrevious).toBe(true);
    const lists = document.querySelectorAll<HTMLElement>('.magic-modal .magic-list');
    expect(lists).toHaveLength(2);
    const firstRow = lists[0].querySelector('.magic-list-item')!;
    expect(firstRow.classList.contains('paired')).toBe(true);
    expect(firstRow.querySelector('.magic-list-badge')!.textContent).toBe('1');
    document.querySelector<HTMLButtonElement>('.magic-modal-close')!.click();
  });

  it('pairs objects by clicking the element lists below the previews', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/magic');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new MagicMovePanel(host, store);
    host.querySelector<HTMLButtonElement>('.magic-open')!.click();

    const pick = (side: string, id: string) => document
      .querySelector<HTMLButtonElement>(`.magic-modal .magic-list-pick[data-side="${side}"][data-element-id="${id}"]`)!;
    pick('source', 'source').click();
    expect(document.querySelector('.magic-modal .magic-list-item.selected-source')).not.toBeNull();
    pick('target', 'target').click();

    const source = store.get().deck.slides[0].elements[0];
    expect(source.magicMoveId).toBeTruthy();
    expect(store.get().deck.slides[1].elements[0].magicMoveId).toBe(source.magicMoveId);
    document.querySelector<HTMLButtonElement>('.magic-modal-close')!.click();
  });

  it('opens a large horizontal two-slide editor from Props', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/magic');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new Inspector(host, store);

    const section = host.querySelector('.magic-move-section')!;
    const compactPreviews = section.querySelectorAll<HTMLElement>('.magic-compact-preview');
    expect(compactPreviews).toHaveLength(2);
    expect(section.querySelectorAll('.magic-object-hit-readonly')).toHaveLength(2);
    compactPreviews[0].click();
    const modal = document.querySelector('.magic-modal')!;
    const previews = [...modal.querySelectorAll<HTMLElement>('.magic-preview')];
    expect(previews).toHaveLength(2);
    expect(previews.map((preview) => preview.style.width)).toEqual(['', '']);
    expect([...modal.querySelectorAll<HTMLElement>('.magic-preview-label')]
      .map((label) => label.textContent)).toEqual(['Source · Slide 1', 'Target · Slide 2']);
    expect(modal.getAttribute('aria-modal')).toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.magic-modal')).toBeNull();
  });

  it('removes Magic Move, including its modal, as soon as an object is selected', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/magic');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new Inspector(host, store);
    host.querySelector<HTMLElement>('.magic-compact-preview')!.click();
    expect(document.querySelector('.magic-modal')).not.toBeNull();

    store.select(['source']);

    expect(host.querySelector('.magic-move-section')).toBeNull();
    expect(document.querySelector('.magic-modal')).toBeNull();
  });

  it('auto-pairs likely matches only when the author requests it', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/magic');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new MagicMovePanel(host, store);
    host.querySelector<HTMLButtonElement>('.magic-open')!.click();
    expect(explicitMagicMovePairs(store.get().deck.slides[0].elements, store.get().deck.slides[1].elements))
      .toHaveLength(0);

    [...document.querySelectorAll<HTMLButtonElement>('.magic-modal button')]
      .find((button) => button.textContent === 'Auto-pair')!.click();

    expect(explicitMagicMovePairs(store.get().deck.slides[0].elements, store.get().deck.slides[1].elements))
      .toHaveLength(1);
    expect(document.querySelector('.magic-modal')!.textContent).toContain('Auto-paired 1 object');
    document.querySelector<HTMLButtonElement>('.magic-modal-close')!.click();
  });

  it('runs paired movement and edge-window unpaired fades on one timeline', async () => {
    const deck = twoSlideDeck();
    deck.slides[1].magicMoveDuration = 1350;
    deck.slides[0].elements[0].magicMoveId = 'pair';
    deck.slides[1].elements[0].magicMoveId = 'pair';
    deck.slides[0].elements.push(text('disappears', 'Disappears', 900));
    deck.slides[1].elements.push(text('appears', 'Appears', 1100));
    deck.slides[1].magicMoveFromPrevious = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn((
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      _options?: number | KeyframeAnimationOptions,
    ) => ({ finished: Promise.resolve() }));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    expect(animate).toHaveBeenCalledTimes(3);
    expect(animate.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ duration: 1350 }),
      expect.objectContaining({ duration: 1350 }),
      expect.objectContaining({ duration: 1350 }),
    ]);
    const tracks = animate.mock.calls.map((call) => call[0] as Keyframe[]);
    // The incoming object fades in over the final quarter…
    expect(tracks.some((frames) =>
      frames[0].opacity === '0' && frames[1].offset === 0.75 &&
      frames[1].opacity === '0' && frames[2].opacity !== '0'))
      .toBe(true);
    // …and the removed object's ghost fades out over the first quarter.
    expect(tracks.some((frames) =>
      frames[0].opacity !== '0' && frames[1].offset === 0.25 &&
      frames[1].opacity === '0' && frames[2].opacity === '0'))
      .toBe(true);
    const discreteOptions = animate.mock.calls.slice(1).map((call) => call[1]);
    expect(discreteOptions).toEqual([
      expect.objectContaining({ easing: 'linear' }),
      expect.objectContaining({ easing: 'linear' }),
    ]);
    expect(host.querySelector('.magic-move-ghost')).not.toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(host.querySelector('.magic-move-ghost')).toBeNull();
    player.destroy();
  });

  it('translates same-size text between different-width boxes without stretching it', () => {
    const deck = twoSlideDeck();
    const source = deck.slides[0].elements[0] as Extract<SlideElement, { type: 'text' }>;
    const target = deck.slides[1].elements[0] as Extract<SlideElement, { type: 'text' }>;
    source.magicMoveId = 'pair';
    target.magicMoveId = 'pair';
    source.style = { 'font-size': '48px' };
    target.style = { 'font-size': '48px' };
    source.w = 949.55;
    target.w = 344.79;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn((
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      _options?: number | KeyframeAnimationOptions,
    ) => ({ finished: Promise.resolve() }));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    const frames = animate.mock.calls[0][0] as unknown as Keyframe[];
    expect(frames[0].transform).toBe('translate(-600px, 0px) scale(1, 1)');
    player.destroy();
  });

  it('scales paired text by its font size ratio, anchored at its alignment', () => {
    const deck = twoSlideDeck();
    const source = deck.slides[0].elements[0] as Extract<SlideElement, { type: 'text' }>;
    const target = deck.slides[1].elements[0] as Extract<SlideElement, { type: 'text' }>;
    source.magicMoveId = 'pair';
    target.magicMoveId = 'pair';
    source.style = { 'font-size': '80px' };
    target.style = { 'font-size': '40px' };
    source.align = 'center';
    target.align = 'center';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn((
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      _options?: number | KeyframeAnimationOptions,
    ) => ({ finished: Promise.resolve() }));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    const frames = animate.mock.calls[0][0] as unknown as Keyframe[];
    // Anchors: the top-centre of each box (x 0 w 300 vs x 600 w 300), scale
    // 80/40. The anchor is folded into the translate so the origin stays the
    // element centre: scaling by 2 about the centre lifts the box top by 40,
    // and the extra 40 puts it back on the source's top edge.
    expect(frames[0].transform).toBe('translate(-600px, 40px) scale(2, 2)');
    expect(frames[0].transformOrigin).toBe('center');
    player.destroy();
  });

  it('animates rotated movers about the center, matching the settled render', () => {
    const deck = twoSlideDeck();
    const arrow = (id: string, x: number, y: number, rot: number): SlideElement => ({
      id, type: 'shape', shape: 'arrow', x, y, w: 200, h: 2, rot, z: 1, opacity: 1,
      class: [], style: {}, fill: null, stroke: '#000000', strokeWidth: 6,
      radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: true,
      magicMoveId: 'arrow-pair',
    });
    deck.slides[0].elements = [arrow('arrow-src', 10, 20, 90)];
    deck.slides[1].elements = [arrow('arrow-dst', 14, 24, 91)];
    deck.slides[1].magicMoveFromPrevious = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn((
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      _options?: number | KeyframeAnimationOptions,
    ) => ({ finished: Promise.resolve() }));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    const frames = animate.mock.calls[0][0] as unknown as Keyframe[];
    // The settled render rotates about the center; the animation must move
    // between the two centers and rotate in the same frame of reference, or a
    // thin rotated arrow lurches at frame 0 and snaps back when fill ends.
    expect(frames[0].transform).toBe('translate(-4px, -4px) rotate(90deg) scale(1, 1)');
    expect(frames[0].transformOrigin).toBe('center');
    expect(frames[frames.length - 1].transform).toBe('rotate(91deg)');
    expect(frames[frames.length - 1].transformOrigin).toBe('center');
    player.destroy();
  });

  it('keeps a mover above a removed backdrop it outranked on the source slide', () => {
    const deck = twoSlideDeck();
    deck.slides[0].elements[0].magicMoveId = 'pair';
    deck.slides[1].elements[0].magicMoveId = 'pair';
    deck.slides[0].elements[0].z = 5;
    const backdrop: SlideElement = {
      id: 'backdrop', type: 'shape', shape: 'rect', x: 0, y: 0, w: 1920, h: 1080,
      rot: 0, z: 4, opacity: 1, class: [], style: {}, fill: '#ffffff', stroke: null,
      strokeWidth: 1, radius: 0, path: null, pathSize: null,
      arrowStart: false, arrowEnd: false,
    };
    deck.slides[0].elements.unshift(backdrop);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn((
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      _options?: number | KeyframeAnimationOptions,
    ) => ({ finished: Promise.resolve() }));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    const calls = animate.mock.calls.map((call) => call[0] as unknown as Keyframe[]);
    // The mover ranks above the backdrop for the eased first half, then drops
    // to its target DOM rank at the same wall-time midpoint as every discrete
    // switch — which requires linear overall timing with the ease on frame 0.
    const mover = calls.find((frames) => frames[0].transform !== undefined)!;
    expect(mover.map((frame) => frame.zIndex)).toEqual(['1', '1', '0', '0']);
    expect(mover[0].easing).toBe('cubic-bezier(.45,.05,.55,.95)');
    expect((animate.mock.calls[0][1] as KeyframeAnimationOptions).easing).toBe('linear');
    const ghost = calls.find((frames) =>
      frames[0].transform === undefined && frames[frames.length - 1].opacity === '0')!;
    expect(ghost.every((frame) => frame.zIndex === '0')).toBe(true);
    player.destroy();
  });

  it('keeps an identical image continuously visible without an explicit pair', () => {
    const deck = twoSlideDeck();
    const image = (id: string): SlideElement => ({
      id, type: 'image', src: 'assets/method.png', x: 19.08, y: 184.03,
      w: 922.53, h: 851.94, rot: 0, z: 1, opacity: 1, class: [], style: {},
      fit: 'fill', alt: '', sourceBox: { x: 15.33, y: -108.03, w: 4257.2, h: 1506.13 },
    });
    deck.slides[0].elements = [image('image-slide-18')];
    deck.slides[1].elements = [image('image-slide-19')];
    deck.slides[1].magicMoveFromPrevious = true;
    expect(unchangedMagicMovePairs(deck.slides[0].elements, deck.slides[1].elements))
      .toHaveLength(1);
    expect(suggestMagicMovePairs(deck.slides[0].elements, deck.slides[1].elements))
      .toHaveLength(0);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn();
    HTMLElement.prototype.animate = animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    expect(animate).not.toHaveBeenCalled();
    expect(host.querySelector('[data-element-id="image-slide-19"]')).not.toBeNull();
    player.destroy();
  });

  it('toggles Magic Move independently of whether anything is paired', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/magic');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new MagicMovePanel(host, store);
    const enabled = host.querySelector<HTMLInputElement>('.magic-enable input')!;
    expect(enabled.checked).toBe(false);
    enabled.checked = true;
    enabled.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().deck.slides[1].magicMoveFromPrevious).toBe(true);
    expect(explicitMagicMovePairs(store.get().deck.slides[0].elements, store.get().deck.slides[1].elements))
      .toHaveLength(0);
  });

  it('uses the destination slide duration for every paired animation', () => {
    const deck = twoSlideDeck();
    deck.slides[1].magicMoveDuration = 1250;
    deck.slides[0].elements[0].magicMoveId = 'pair';
    deck.slides[1].elements[0].magicMoveId = 'pair';
    const third = structuredClone(deck.slides[1]);
    third.id = 'slide-3';
    third.elements[0].id = 'target-3';
    third.elements[0].x = 900;
    third.magicMoveFromPrevious = true;
    third.magicMoveDuration = 650;
    deck.slides.push(third);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn();
    HTMLElement.prototype.animate = animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    expect(animate).toHaveBeenCalled();
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 1250 });
    animate.mockClear();
    player.goToSlide(2);
    expect(animate).toHaveBeenCalled();
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 650 });
    player.destroy();
  });

  it('leaves every object identical to a direct target-slide render after Magic Move', async () => {
    const deck = twoSlideDeck();
    const source = deck.slides[0].elements[0];
    const target = deck.slides[1].elements[0];
    source.magicMoveId = 'pair';
    target.magicMoveId = 'pair';
    source.rot = -18;
    target.rot = 27;
    target.opacity = 0.65;
    target.style = { color: 'rgb(12, 34, 56)', transform: 'rotate(27deg) skewX(4deg)' };
    deck.slides[1].elements.push(text('unpaired', 'Target only', 1000));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn((
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      _options?: number | KeyframeAnimationOptions,
    ) => ({ finished: Promise.resolve() }));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);
    await Promise.resolve();

    const directDeck = structuredClone(deck);
    for (const slide of directDeck.slides) {
      for (const element of slide.elements) element.magicMoveId = null;
    }
    const directHost = document.createElement('div');
    document.body.appendChild(directHost);
    const directPlayer = new Player({ deck: directDeck, container: directHost, resolveSrc: (src) => src });
    directPlayer.goToSlide(1);
    const actualObjects = [...host.querySelectorAll<HTMLElement>('.slide > .element')];
    const expectedObjects = [...directHost.querySelectorAll<HTMLElement>('.slide > .element')];
    expect(actualObjects.map((element) => element.outerHTML))
      .toEqual(expectedObjects.map((element) => element.outerHTML));
    expect(animate.mock.calls[0][1]).toMatchObject({ fill: 'none' });
    player.destroy();
    directPlayer.destroy();
  });

  it('edits the selected transition duration from the dedicated panel', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/magic');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new MagicMovePanel(host, store);
    const input = host.querySelector<HTMLInputElement>('.magic-duration input')!;
    expect(input.value).toBe('1000');
    input.value = '1450';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().deck.slides[1].magicMoveDuration).toBe(1450);
    expect(host.textContent).toContain('Duration');
    expect(host.textContent).not.toContain('Duration for deck');
  });

  it('migrates a legacy deck-wide duration onto every slide', () => {
    const legacy = parseDeck({
      ...emptyDeck('Legacy Magic Move'),
      magicMoveDuration: 1750,
      slides: [{ id: 'slide-1' }, { id: 'slide-2', magicMoveDuration: 900 }],
    });
    expect(legacy.slides.map((slide) => slide.magicMoveDuration)).toEqual([1750, 900]);
    expect(legacy).not.toHaveProperty('magicMoveDuration');
  });
});
