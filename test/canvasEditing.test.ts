// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import {
  EditorCanvas,
  elementContainsPoint,
  lineEndpoints,
  lineFromEndpoints,
} from '../src/renderer/editor/canvas.js';
import {
  createShapeInsertPicker,
  insertLine,
  insertShape,
  insertText,
} from '../src/renderer/editor/elementCreation.js';
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

  it('renders TeX but restores editable source before typing', () => {
    const { store, canvas, host } = setup();
    const text = store.slide!.elements.find((el) => el.id === 'text-1')!;
    if (text.type !== 'text') throw new Error('expected text');
    store.select(['text-1']);
    store.updateSelected((el) => {
      if (el.type === 'text') el.html = 'Energy: $E=mc^2$';
    });
    expect(bodyOf(host, 'text-1').querySelector('.katex')).not.toBeNull();

    canvas.beginTextEdit('text-1');
    expect(bodyOf(host, 'text-1').innerHTML).toBe('Energy: $E=mc^2$');
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

  it('inserts multiple lines of text and can delete all of that text again', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    bodyOf(host, 'text-1').innerHTML = 'First line<br>Second line';
    bodyOf(host, 'text-1').dispatchEvent(new FocusEvent('blur'));
    expect((store.slide!.elements[0] as { html: string }).html).toBe(
      'First line<br>Second line',
    );

    canvas.beginTextEdit('text-1');
    bodyOf(host, 'text-1').innerHTML = '';
    bodyOf(host, 'text-1').dispatchEvent(new FocusEvent('blur'));
    expect((store.slide!.elements[0] as { html: string }).html).toBe('');
    expect(store.slide!.elements.some((el) => el.id === 'text-1')).toBe(true);
  });

  it('keeps Backspace inside an active text edit from deleting the text box', () => {
    const { store, canvas, host } = setup();
    store.select(['text-1']);
    canvas.beginTextEdit('text-1');
    bodyOf(host, 'text-1').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }),
    );
    expect(store.slide!.elements.some((el) => el.id === 'text-1')).toBe(true);
    expect(canvas.isEditing()).toBe(true);
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

describe('native line endpoint editing', () => {
  it('round-trips free start and end points through line geometry', () => {
    const start = { x: 606, y: 651 };
    const end = { x: 665, y: 672 };
    const geometry = lineFromEndpoints(start, end, 1);
    const points = lineEndpoints(geometry);

    expect(points.start.x).toBeCloseTo(start.x, 6);
    expect(points.start.y).toBeCloseTo(start.y, 6);
    expect(points.end.x).toBeCloseTo(end.x, 6);
    expect(points.end.y).toBeCloseTo(end.y, 6);
  });

  it('hits a rotated line near its visible segment, outside its thin box', () => {
    const line = {
      type: 'shape' as const, id: 'line', z: 1, opacity: 1, class: [], style: {},
      ...lineFromEndpoints({ x: 800, y: 200 }, { x: 1000, y: 400 }, 2),
      shape: 'line' as const, fill: null, stroke: '#000', strokeWidth: 4,
      radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
    };
    expect(elementContainsPoint(line, { x: 850, y: 250 })).toBe(true);
    expect(elementContainsPoint(line, { x: 850, y: 280 })).toBe(false);
  });
});

describe('quadratic curved arrows', () => {
  beforeEach(() => document.body.replaceChildren());

  function stageAtOne(host: HTMLElement): void {
    host.querySelector<HTMLElement>('.stage')!.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
  }

  function pointer(target: EventTarget, type: string, x: number, y: number): void {
    target.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0,
    }));
  }

  it('renders an inserted curved arrow as a quadratic path with an arrowhead', () => {
    const { store, host } = setup();
    const arrow = insertLine(store, 'arrow', true);
    const path = host.querySelector<SVGPathElement>(
      `[data-element-id="${arrow.id}"] svg > path`,
    )!;
    expect(path.getAttribute('d')).toContain(' Q ');
    expect(path.getAttribute('marker-end')).toContain('arrowhead-');
    expect(host.querySelector('.handle-curve-control')).not.toBeNull();
  });

  it('selects a curved arrow by clicking near the visible curve', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const arrow = insertLine(store, 'arrow', true);
    const { start, end } = lineEndpoints(arrow);
    const control = arrow.control!;
    const midpoint = {
      x: start.x * 0.25 + control.x * 0.5 + end.x * 0.25,
      y: start.y * 0.25 + control.y * 0.5 + end.y * 0.25,
    };
    store.clearSelection();
    pointer(host, 'pointerdown', midpoint.x, midpoint.y);
    pointer(host, 'pointerup', midpoint.x, midpoint.y);
    expect([...store.get().selection]).toEqual([arrow.id]);
  });

  it('reshapes the curve with its bend handle', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const arrow = insertLine(store, 'arrow', true);
    const beforePath = host.querySelector<SVGPathElement>(
      `[data-element-id="${arrow.id}"] svg > path`,
    )!.getAttribute('d');
    const handle = host.querySelector<HTMLElement>('.handle-curve-control')!;
    pointer(handle, 'pointerdown', arrow.control!.x, arrow.control!.y);
    pointer(host, 'pointermove', arrow.control!.x + 80, arrow.control!.y - 60);
    pointer(host, 'pointerup', arrow.control!.x + 80, arrow.control!.y - 60);
    const changed = store.slide!.elements.find((el) => el.id === arrow.id)!;
    expect(changed.type === 'shape' && changed.control).toEqual({
      x: arrow.control!.x + 80, y: arrow.control!.y - 60,
    });
    expect(host.querySelector<SVGPathElement>(
      `[data-element-id="${arrow.id}"] svg > path`,
    )!.getAttribute('d')).not.toBe(beforePath);
  });

  it('moves endpoints and bend together when dragging the arrow', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const arrow = insertLine(store, 'arrow', true);
    const originalControl = { ...arrow.control! };
    const { start, end } = lineEndpoints(arrow);
    const onCurve = {
      x: start.x * 0.25 + arrow.control!.x * 0.5 + end.x * 0.25,
      y: start.y * 0.25 + arrow.control!.y * 0.5 + end.y * 0.25,
    };
    pointer(host, 'pointerdown', onCurve.x, onCurve.y);
    pointer(host, 'pointermove', onCurve.x + 100, onCurve.y + 60);
    pointer(host, 'pointerup', onCurve.x + 100, onCurve.y + 60);
    const moved = store.slide!.elements.find((el) => el.id === arrow.id)!;
    expect(moved.type === 'shape' && moved.control!.x).toBeGreaterThan(originalControl.x);
    expect(moved.type === 'shape' && moved.control!.y).toBeGreaterThan(originalControl.y);
  });
});

describe('object creation and manipulation', () => {
  beforeEach(() => document.body.replaceChildren());

  function stageAtOne(host: HTMLElement): void {
    host.querySelector<HTMLElement>('.stage')!.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
  }

  function pointer(target: EventTarget, type: string, x: number, y: number): void {
    target.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0,
    }));
  }

  it.each(['line', 'arrow'] as const)('selects a rotated %s by clicking its stroke', (kind) => {
    const { store, host } = setup();
    stageAtOne(host);
    const created = insertLine(store, kind);
    const geometry = lineFromEndpoints({ x: 800, y: 200 }, { x: 1000, y: 400 }, 2);
    store.updateSelected((el) => Object.assign(el, geometry));
    store.clearSelection();

    pointer(host, 'pointerdown', 850, 250);
    pointer(host, 'pointerup', 850, 250);
    expect([...store.get().selection]).toEqual([created.id]);
  });

  it('inserts and renders an ellipse without throwing', () => {
    const { store, host } = setup();
    const ellipse = insertShape(store, 'ellipse');
    expect(store.slide!.elements.at(-1)).toMatchObject({ id: ellipse.id, shape: 'ellipse' });
    const rendered = host.querySelector<SVGEllipseElement>(
      `[data-element-id="${ellipse.id}"] ellipse`,
    )!;
    expect(rendered).not.toBeNull();
    expect(rendered.getAttribute('cx')).toBe(String(ellipse.w / 2));
    expect(rendered.getAttribute('cy')).toBe(String(ellipse.h / 2));
    expect(rendered.ownerSVGElement!.style.display).toBe('block');
    expect([...store.get().selection]).toEqual([ellipse.id]);
  });

  it('releases shape-picker focus so Backspace can delete a new arrow immediately', () => {
    const { store } = setup();
    const picker = createShapeInsertPicker(store);
    document.body.appendChild(picker);
    picker.focus();
    picker.value = 'curved-arrow';
    picker.dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.activeElement).not.toBe(picker);
    const [id] = [...store.get().selection];
    expect(store.slide!.elements.find((el) => el.id === id)).toMatchObject({
      shape: 'arrow',
      control: expect.any(Object),
    });
    store.deleteSelection();
    expect(store.slide!.elements.some((el) => el.id === id)).toBe(false);
  });

  it('inserts text above existing objects and selects it', () => {
    const { store } = setup();
    const text = insertText(store);
    expect(text.z).toBe(3);
    expect(text.html).toBe('New text');
    expect([...store.get().selection]).toEqual([text.id]);
  });

  it('moves an inserted ellipse by dragging it', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const ellipse = insertShape(store, 'ellipse');
    const start = { x: ellipse.x + 100, y: ellipse.y + 100 };
    pointer(host, 'pointerdown', start.x, start.y);
    pointer(host, 'pointermove', start.x + 100, start.y + 60);
    pointer(host, 'pointerup', start.x + 100, start.y + 60);
    const moved = store.slide!.elements.find((el) => el.id === ellipse.id)!;
    expect(moved.x).toBeGreaterThan(ellipse.x);
    expect(moved.y).toBeGreaterThan(ellipse.y);
  });

  it('reshapes an ellipse with its southeast handle', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const ellipse = insertShape(store, 'ellipse');
    const handle = host.querySelector<HTMLElement>(`.handle-se[data-element-id="${ellipse.id}"]`)!;
    pointer(handle, 'pointerdown', ellipse.x + ellipse.w, ellipse.y + ellipse.h);
    pointer(host, 'pointermove', ellipse.x + ellipse.w + 80, ellipse.y + ellipse.h + 40);
    pointer(host, 'pointerup', ellipse.x + ellipse.w + 80, ellipse.y + ellipse.h + 40);
    const resized = store.slide!.elements.find((el) => el.id === ellipse.id)!;
    expect(resized.w).toBeGreaterThan(ellipse.w);
    expect(resized.h).toBeGreaterThan(ellipse.h);
  });

  it('drags a line endpoint and keeps the handle centred on the new endpoint', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const line = insertLine(store, 'line');
    const handle = host.querySelector<HTMLElement>(`.handle-endpoint[data-endpoint="end"]`)!;
    const target = { x: 1300, y: 700 };
    pointer(handle, 'pointerdown', line.x + line.w, line.y + line.h / 2);
    pointer(host, 'pointermove', target.x, target.y);
    pointer(host, 'pointerup', target.x, target.y);
    const changed = store.slide!.elements.find((el) => el.id === line.id)!;
    const { end } = lineEndpoints(changed);
    expect(end.x).toBeCloseTo(target.x, 0);
    expect(end.y).toBeCloseTo(target.y, 0);
    const drawn = host.querySelector<HTMLElement>('.handle-endpoint[data-endpoint="end"]')!;
    expect(Number.parseFloat(drawn.style.left) + changed.x).toBeCloseTo(end.x, 1);
    expect(Number.parseFloat(drawn.style.top) + changed.y).toBeCloseTo(end.y, 1);
    expect(drawn.style.transform).toBe('translate(-50%, -50%)');
    expect(host.querySelector(`[data-element-id="${line.id}"] svg`)!.getAttribute('style'))
      .toContain('display: block');
  });

  it('deletes a selected text box and clears its selection', () => {
    const { store, host } = setup();
    store.commit((deck) => {
      deck.slides[0].timeline.push({
        id: 'step-1', trigger: { on: 'click', ref: null, delay: 0 },
        action: { type: 'appear', target: 'text-1', value: null },
      });
    });
    store.select(['text-1']);
    store.deleteSelection();
    expect(store.slide!.elements.some((el) => el.id === 'text-1')).toBe(false);
    expect(store.slide!.timeline).toHaveLength(0);
    expect(store.get().selection.size).toBe(0);
    expect(host.querySelector('[data-element-id="text-1"]')).toBeNull();
  });

  it('reliably selects, deselects, and reselects a text box', () => {
    const { store, host } = setup();
    stageAtOne(host);
    for (const [x, y, selected] of [[200, 150, true], [1500, 900, false], [200, 150, true]] as const) {
      pointer(host, 'pointerdown', x, y);
      pointer(host, 'pointerup', x, y);
      expect(store.get().selection.has('text-1')).toBe(selected);
      expect(host.querySelectorAll('.sel-box')).toHaveLength(selected ? 1 : 0);
    }
  });

  it('rebuilds an SVG when its kind or theme-driven paint changes', () => {
    const { store, host } = setup();
    const shape = insertShape(store, 'rect');
    store.updateSelected((el) => {
      if (el.type === 'shape') { el.shape = 'ellipse'; el.fill = '#ff0000'; }
    });
    const ellipse = host.querySelector(`[data-element-id="${shape.id}"] ellipse`)!;
    expect(ellipse.getAttribute('fill')).toBe('#ff0000');
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
