// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { EditorStore } from '../src/renderer/editor/store.js';

/**
 * Regression tests for editing on the canvas.
 *
 * These exercise the real `EditorCanvas` against a DOM, because the bugs that
 * matter here — text that cannot be edited, playback that dies on every
 * unrelated redraw — are interaction bugs that type-checking cannot catch.
 */

/** jsdom lacks the observers and helpers the canvas relies on. */
function installDomShims(): void {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  // jsdom implements MouseEvent but not PointerEvent; the canvas listens for
  // pointer events, and they carry the same properties we rely on.
  if (!('PointerEvent' in globalThis)) {
    class PointerEventShim extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent =
      PointerEventShim;
  }
  // Pointer capture is not implemented in jsdom either.
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    if (!(name in Element.prototype)) {
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        value: () => {},
      });
    }
  }
  if (!globalThis.CSS) {
    (globalThis as unknown as { CSS: unknown }).CSS = {
      escape: (v: string) => v.replace(/["\\]/g, '\\$&'),
    };
  }
  // The canvas resolves asset paths through the preload bridge.
  (globalThis as unknown as { window: Window }).window.api = {
    assetUrl: (src: string) => src,
    pathForFile: () => '',
    importAssets: async () => [],
  } as never;
  // jsdom has no media stack; the canvas only needs play/pause to exist.
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: false });
      return Promise.resolve();
    }),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: vi.fn(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: true });
    }),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    value: true,
    writable: true,
  });
}

function setup() {
  installDomShims();
  const deck = emptyDeck('Test');
  deck.slides[0].elements = [
    {
      id: 'text-1',
      type: 'text',
      x: 100,
      y: 100,
      w: 600,
      h: 120,
      rot: 0,
      z: 1,
      opacity: 1,
      class: [],
      style: {},
      html: 'Original text',
      align: 'left',
      valign: 'middle',
    },
    {
      id: 'video-1',
      type: 'video',
      x: 100,
      y: 300,
      w: 640,
      h: 360,
      rot: 0,
      z: 2,
      opacity: 1,
      class: [],
      style: {},
      src: 'assets/clip.mp4',
      fit: 'contain',
      autoplay: true,
      loop: true,
      muted: true,
      controls: false,
      start: 0,
      end: null,
      poster: null,
      sourceBox: null,
    },
  ];

  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const store = new EditorStore(deck, '/tmp/deck');
  const canvas = new EditorCanvas(host, store);
  return { store, canvas, host };
}

const bodyOf = (host: HTMLElement, id: string): HTMLElement =>
  host.querySelector(`[data-element-id="${id}"]`)!.firstElementChild as HTMLElement;

describe('inline text editing', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('makes the text element editable and focused', () => {
    const { canvas, host } = setup();
    canvas.beginTextEdit('text-1');

    const body = bodyOf(host, 'text-1');
    expect(body.isContentEditable || body.contentEditable === 'true').toBe(true);
    expect(canvas.isEditing()).toBe(true);
  });

  it('writes edited content back to the deck', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');

    const body = bodyOf(host, 'text-1');
    body.innerHTML = 'Edited text';
    body.dispatchEvent(new FocusEvent('blur'));

    const el = store.slide!.elements.find((e) => e.id === 'text-1')!;
    expect(el.type).toBe('text');
    expect((el as { html: string }).html).toBe('Edited text');
    expect(canvas.isEditing()).toBe(false);
  });

  it('discards the edit on Escape', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');

    const body = bodyOf(host, 'text-1');
    body.innerHTML = 'Should not stick';
    body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    const el = store.slide!.elements.find((e) => e.id === 'text-1')!;
    expect((el as { html: string }).html).toBe('Original text');
    expect(canvas.isEditing()).toBe(false);
  });

  it('records the edit as a single undoable change', () => {
    const { store, canvas, host } = setup();
    expect(store.canUndo()).toBe(false);

    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    body.innerHTML = 'New';
    body.dispatchEvent(new FocusEvent('blur'));

    expect(store.canUndo()).toBe(true);
    store.undo();
    const el = store.slide!.elements.find((e) => e.id === 'text-1')!;
    expect((el as { html: string }).html).toBe('Original text');
  });

  it('does not touch the deck when the text is unchanged', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    bodyOf(host, 'text-1').dispatchEvent(new FocusEvent('blur'));
    expect(store.canUndo()).toBe(false);
  });

  it('starts editing when the text is double-clicked', () => {
    const { canvas, host } = setup();
    // jsdom reports zero-sized rects, so the stage must be given a real one for
    // the screen-to-canvas mapping (and therefore hit testing) to mean anything.
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;

    // A point inside the text element's box (100,100 600x120) at scale 1.
    host.dispatchEvent(
      new MouseEvent('dblclick', { clientX: 200, clientY: 150, bubbles: true }),
    );

    expect(canvas.isEditing()).toBe(true);
  });

  it('plays the video when it is double-clicked', () => {
    const { canvas, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;

    // Inside the video's box (100,300 640x360).
    host.dispatchEvent(
      new MouseEvent('dblclick', { clientX: 300, clientY: 400, bubbles: true }),
    );

    expect(canvas.isPlaying('video-1')).toBe(true);
  });
});

/**
 * The browser only synthesises `click` — and therefore `dblclick` — when the
 * element pressed on is still in the document at release. Re-rendering the
 * slide on pointerup silently destroyed both events, which is what stopped
 * double-click-to-edit from working while every direct-call test passed.
 *
 * jsdom does not synthesise click from mousedown/mouseup, so the event itself
 * cannot be asserted here. The invariant behind it can.
 */
describe('pointer handling keeps the DOM stable', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  function press(host: HTMLElement, x: number, y: number): void {
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    const opts = { clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0 };
    host.dispatchEvent(new PointerEvent('pointerdown', opts));
    host.dispatchEvent(new PointerEvent('pointerup', opts));
  }

  it('does not detach the pressed element on a click without movement', () => {
    const { canvas, host } = setup();
    void canvas;
    const before = host.querySelector('[data-element-id="text-1"]')!;

    press(host, 200, 150);

    expect(before.isConnected, 'element was replaced during a plain click').toBe(true);
    expect(host.querySelector('[data-element-id="text-1"]')).toBe(before);
  });

  it('selects on click without moving the element', () => {
    const { store, host } = setup();
    const originalX = store.slide!.elements[0].x;

    press(host, 200, 150);

    expect([...store.get().selection]).toEqual(['text-1']);
    expect(store.slide!.elements[0].x).toBe(originalX);
    // A click is not an edit, so it must not consume an undo slot.
    expect(store.canUndo()).toBe(false);
  });

  it('ignores movement below the drag threshold', () => {
    const { store, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    const originalX = store.slide!.elements[0].x;

    const at = (x: number, y: number) => ({
      clientX: x,
      clientY: y,
      bubbles: true,
      pointerId: 1,
      button: 0,
    });
    host.dispatchEvent(new PointerEvent('pointerdown', at(200, 150)));
    host.dispatchEvent(new PointerEvent('pointermove', at(202, 151)));
    host.dispatchEvent(new PointerEvent('pointerup', at(202, 151)));

    expect(store.slide!.elements[0].x).toBe(originalX);
  });

  it('still moves the element once the threshold is cleared', () => {
    const { store, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    const originalX = store.slide!.elements[0].x;

    const at = (x: number, y: number) => ({
      clientX: x,
      clientY: y,
      bubbles: true,
      pointerId: 1,
      button: 0,
    });
    host.dispatchEvent(new PointerEvent('pointerdown', at(200, 150)));
    host.dispatchEvent(new PointerEvent('pointermove', at(340, 150)));
    host.dispatchEvent(new PointerEvent('pointerup', at(340, 150)));

    expect(store.slide!.elements[0].x).toBeGreaterThan(originalX);
  });
});

/**
 * Dragging commits a new deck on every pointermove. Rebuilding the slide DOM
 * each time recreates every `<video>`, which reloads the media — the visible
 * symptom being clips flickering continuously while you drag anything at all.
 * Geometry-only changes must therefore reposition the existing nodes.
 */
describe('dragging does not disturb media', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('keeps the same video node across a move', () => {
    const { store, canvas } = setup();
    void canvas;
    const before = document.querySelector('[data-element-id="video-1"] video');
    expect(before).not.toBeNull();

    store.select(['text-1']);
    store.updateSelected((el) => {
      el.x += 40;
    });

    const after = document.querySelector('[data-element-id="video-1"] video');
    expect(after, 'the video element was recreated during a move').toBe(before);
  });

  it('still repositions the moved element', () => {
    const { store, canvas } = setup();
    void canvas;
    store.select(['text-1']);
    store.updateSelected((el) => {
      el.x = 500;
    });

    const node = document.querySelector<HTMLElement>('[data-element-id="text-1"]')!;
    expect(node.style.left).toBe('500px');
  });

  it('does rebuild when the content actually changes', () => {
    const { store, canvas } = setup();
    void canvas;
    const before = document.querySelector('[data-element-id="video-1"] video');

    store.commit((deck) => {
      const el = deck.slides[0].elements.find((e) => e.id === 'video-1');
      if (el?.type === 'video') el.src = 'assets/other.mp4';
    });

    const after = document.querySelector('[data-element-id="video-1"] video');
    expect(after).not.toBe(before);
  });
});

describe('inline styles reach the DOM', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('applies a colour change without a rebuild', () => {
    const { store, host } = setup();
    const node = host.querySelector<HTMLElement>('[data-element-id="text-1"]')!;

    store.select(['text-1']);
    store.updateSelected((el) => {
      el.style = { ...el.style, color: '#ff0000' };
    });

    // Style-only changes take the fast path (no rebuild), so the colour has to
    // be applied to the existing node — before this fix the deck updated and
    // the pixels never did.
    const after = host.querySelector<HTMLElement>('[data-element-id="text-1"]')!;
    expect(after).toBe(node);
    // The DOM normalises hex to rgb(); either spelling proves it landed.
    expect(['#ff0000', 'rgb(255, 0, 0)']).toContain(after.style.getPropertyValue('color'));
  });

  it('clears a removed colour', () => {
    const { store, host } = setup();
    store.select(['text-1']);
    store.updateSelected((el) => {
      el.style = { color: '#00ff00' };
    });
    store.updateSelected((el) => {
      el.style = {};
    });
    const node = host.querySelector<HTMLElement>('[data-element-id="text-1"]')!;
    expect(node.style.getPropertyValue('color')).toBe('');
  });
});

describe('video preview on the canvas', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('starts paused so the canvas is not a wall of moving clips', () => {
    const { canvas } = setup();
    expect(canvas.isPlaying('video-1')).toBe(false);
  });

  it('toggles playback in place', () => {
    const { canvas } = setup();
    expect(canvas.toggleVideo('video-1')).toBe(true);
    expect(canvas.isPlaying('video-1')).toBe(true);
    expect(canvas.toggleVideo('video-1')).toBe(false);
    expect(canvas.isPlaying('video-1')).toBe(false);
  });

  it('keeps a playing video playing across an unrelated redraw', () => {
    const { store, canvas } = setup();
    canvas.toggleVideo('video-1');

    // Move a different element: the canvas fully re-renders.
    store.select(['text-1']);
    store.updateSelected((el) => {
      el.x += 10;
    });

    expect(canvas.isPlaying('video-1')).toBe(true);
  });
});
