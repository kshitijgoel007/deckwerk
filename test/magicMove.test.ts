// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import {
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

  it('suggests strong matches without pairing unrelated same-type objects', () => {
    const source = [text('a', 'The same title'), text('b', 'Completely unrelated')];
    const target = [text('c', 'The same title'), text('d', 'Nothing in common')];
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
    expect(suggestMagicMovePairs(previous, next).map(([source, target]) =>
      [source.id, target.id])).toEqual([
      ['shape-590', 'shape-604'],
      ['shape-591', 'shape-605'],
    ]);
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
    expect(document.querySelector('.magic-modal')!.textContent).toContain('1 paired object');
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

  it('runs paired movement and discrete unpaired switches on one timeline', async () => {
    const deck = twoSlideDeck();
    deck.magicMoveDuration = 1350;
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
    expect(tracks.some((frames) =>
      frames[0].visibility === 'hidden' && frames[2].visibility === 'visible'))
      .toBe(true);
    expect(tracks.some((frames) =>
      frames[0].visibility === 'visible' && frames[2].visibility === 'hidden'))
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
      .toHaveLength(1);
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

  it('uses a slower deck-wide duration for every paired animation', () => {
    const deck = twoSlideDeck();
    deck.magicMoveDuration = 1250;
    deck.slides[0].elements[0].magicMoveId = 'pair';
    deck.slides[1].elements[0].magicMoveId = 'pair';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn();
    HTMLElement.prototype.animate = animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    expect(animate).toHaveBeenCalled();
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 1250 });
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

  it('edits the one global duration from the dedicated panel', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/magic');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new MagicMovePanel(host, store);
    const input = host.querySelector<HTMLInputElement>('.magic-duration input')!;
    expect(input.value).toBe('1000');
    input.value = '1450';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().deck.magicMoveDuration).toBe(1450);
  });
});
