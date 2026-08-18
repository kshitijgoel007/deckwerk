// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { Inspector } from '../src/renderer/editor/inspector.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
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
  host.querySelector(`[data-element-id="${id}"] .text-content`)! as HTMLElement;

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

  it('keeps inherited text colour and its picker preview stable after editing', () => {
    installDomShims();
    const styles = document.createElement('style');
    styles.textContent = [
      readFileSync(join(process.cwd(), 'src/renderer/player/player.css'), 'utf8'),
      readFileSync(join(process.cwd(), 'src/renderer/editor/editor.css'), 'utf8'),
      '.slide { color: #5b21b6; }',
    ].join('\n');
    document.head.appendChild(styles);
    const deck = emptyDeck('Inherited colour');
    applySlideLayout(deck.slides[0], 'standard');
    const title = deck.slides[0].elements.find((element) =>
      element.class.includes('role-title'))!;
    const canvasHost = document.createElement('div');
    const inspectorHost = document.createElement('div');
    document.body.replaceChildren(canvasHost, inspectorHost);
    const store = new EditorStore(deck, '/tmp/inherited-colour');
    const canvas = new EditorCanvas(canvasHost, store);
    new Inspector(inspectorHost, store);
    store.select([title.id]);

    const beforeNode = canvasHost.querySelector<HTMLElement>(
      `[data-element-id="${title.id}"]`,
    )!;
    const beforePicker = inspectorHost.querySelector<HTMLInputElement>('input[type="color"]')!;
    expect(getComputedStyle(beforeNode).color).toBe('rgb(91, 33, 182)');
    expect(getComputedStyle(beforeNode.firstElementChild!).opacity).not.toBe('0.4');
    expect(beforePicker.value).toBe('#5b21b6');
    expect(beforePicker.dataset.inherited).toBe('true');

    canvas.beginTextEdit(title.id);
    bodyOf(canvasHost, title.id).innerHTML = 'Edited title';
    bodyOf(canvasHost, title.id).dispatchEvent(new FocusEvent('blur'));

    const afterNode = canvasHost.querySelector<HTMLElement>(
      `[data-element-id="${title.id}"]`,
    )!;
    const afterPicker = inspectorHost.querySelector<HTMLInputElement>('input[type="color"]')!;
    const edited = store.slide!.elements.find((element) => element.id === title.id)!;
    expect(edited.class).not.toContain('placeholder');
    expect(edited.style.color).toBeUndefined();
    expect(getComputedStyle(afterNode).color).toBe('rgb(91, 33, 182)');
    expect(afterPicker.value).toBe('#5b21b6');
    expect(afterPicker.dataset.inherited).toBe('true');

    afterPicker.value = '#c026d3';
    afterPicker.dispatchEvent(new Event('change', { bubbles: true }));
    let live = store.slide!.elements.find((element) => element.id === title.id)!;
    let livePicker = inspectorHost.querySelector<HTMLInputElement>('input[type="color"]')!;
    expect(live.style.color).toBe('#c026d3');
    expect(getComputedStyle(canvasHost.querySelector<HTMLElement>(
      `[data-element-id="${title.id}"]`,
    )!).color).toBe('rgb(192, 38, 211)');
    expect(livePicker.value).toBe('#c026d3');
    expect(livePicker.dataset.inherited).toBe('false');

    canvas.beginTextEdit(title.id);
    bodyOf(canvasHost, title.id).innerHTML = 'Edited again';
    bodyOf(canvasHost, title.id).dispatchEvent(new FocusEvent('blur'));
    live = store.slide!.elements.find((element) => element.id === title.id)!;
    livePicker = inspectorHost.querySelector<HTMLInputElement>('input[type="color"]')!;
    expect(live.style.color).toBe('#c026d3');
    expect(livePicker.value).toBe('#c026d3');

    inspectorHost.querySelector<HTMLButtonElement>('button[title="No colour"]')!.click();
    live = store.slide!.elements.find((element) => element.id === title.id)!;
    livePicker = inspectorHost.querySelector<HTMLInputElement>('input[type="color"]')!;
    expect(live.style.color).toBeUndefined();
    expect(livePicker.value).toBe('#5b21b6');
    expect(livePicker.dataset.inherited).toBe('true');
    styles.remove();
  });

  it('lets an element inline colour beat a theme rule that targets .text-content', () => {
    // Imported/agent-authored themes may style the content node directly
    // (`.role-title .text-content { color: … }`), which would override the
    // wrapper's inline colour by specificity — the imported colour vanished
    // and the picker went dead. Inline styles are mirrored onto .text-content
    // so the element always wins.
    installDomShims();
    const styles = document.createElement('style');
    styles.textContent = '.role-title .text-content { color: #111111; }';
    document.head.appendChild(styles);
    const deck = emptyDeck('Mirrored colour');
    deck.slides[0].elements = [{
      id: 'title-1', type: 'text', x: 0, y: 0, w: 800, h: 100, rot: 0, z: 1,
      opacity: 1, class: ['kn-text', 'role-title'],
      style: { 'font-size': '80px', color: '#ffffff' },
      html: 'Video Models', align: 'left', valign: 'middle',
    }];
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const store = new EditorStore(deck, '/tmp/mirrored-colour');
    new EditorCanvas(host, store);

    const content = () => host.querySelector<HTMLElement>(
      '[data-element-id="title-1"] .text-content',
    )!;
    expect(getComputedStyle(content()).color).toBe('rgb(255, 255, 255)');

    // The inspector's colour picker path: update style.color in place.
    store.select(['title-1']);
    store.updateSelected((element) => {
      if (element.type === 'text') element.style = { ...element.style, color: '#c026d3' };
    });
    expect(getComputedStyle(content()).color).toBe('rgb(192, 38, 211)');

    // Clearing the colour hands control back to the theme rule.
    store.updateSelected((element) => {
      if (element.type !== 'text') return;
      const { color: _color, ...rest } = element.style;
      element.style = rest;
    });
    expect(getComputedStyle(content()).color).toBe('rgb(17, 17, 17)');
    styles.remove();
  });

  it('opens imported `<br>` text as blocks, and flattens what return nests', () => {
    const { store, canvas, host } = setup();
    store.commit((deck) => {
      (deck.slides[0].elements[0] as { html: string }).html = 'one<br>two<br>three';
    });
    canvas.beginTextEdit('text-1');
    // Blocks in: return then splits a block instead of stranding a `<br>`.
    expect(bodyOf(host, 'text-1').innerHTML).toBe('<p>one</p><p>two</p><p>three</p>');

    // Blocks out: what Chrome leaves behind after two returns is one paragraph
    // with the rest of the text nested inside it, which used to swallow every
    // paragraph but the first.
    bodyOf(host, 'text-1').innerHTML = '<p>one</p><div><p>two</p><div><p>three</p></div></div>';
    bodyOf(host, 'text-1').dispatchEvent(new FocusEvent('blur'));
    expect((store.slide!.elements[0] as { html: string }).html).toBe(
      '<p>one</p><p>two</p><p>three</p>',
    );
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

  it('does not replace a native word selection with select-all on double-click', () => {
    const { canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const range = document.createRange();
    range.setStart(body.firstChild!, 0);
    range.setEnd(body.firstChild!, 8);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    body.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(selection.toString()).toBe('Original');
    expect(canvas.isEditing()).toBe(true);
  });

  it('applies font weight to only the selected text range', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');
    const body = bodyOf(host, 'text-1');
    const range = document.createRange();
    range.setStart(body.firstChild!, 0);
    range.setEnd(body.firstChild!, 8);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(canvas.applyTextSelectionWeight(700)).toBe(true);
    expect(body.innerHTML).toContain('font-weight: 700');
    expect(body.textContent).toBe('Original text');
    body.dispatchEvent(new FocusEvent('blur'));

    const text = store.slide!.elements.find((element) => element.id === 'text-1')!;
    expect(text.type).toBe('text');
    if (text.type === 'text') {
      expect(text.html).toContain('<span style="font-weight: 700;">Original</span> text');
    }
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

  it('marks videos with a small editor-only corner badge', () => {
    const { host } = setup();
    const video = host.querySelector<HTMLElement>('[data-element-id="video-1"]')!;
    const badge = video.querySelector<HTMLElement>(':scope > .video-editor-badge');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('▶');
    expect(badge?.getAttribute('aria-label')).toBe('Video');
  });

  it('enters mask mode through the media context-menu action', async () => {
    const { store, canvas, host } = setup();
    const stage = host.querySelector<HTMLElement>('.stage')!;
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
    canvas.contextActions = (element) => element?.type === 'video'
      ? [{ label: 'Edit mask (crop)', action: () => canvas.toggleMaskMode(element.id) }]
      : [];
    host.dispatchEvent(new MouseEvent('contextmenu', {
      clientX: 300, clientY: 400, bubbles: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const item = document.querySelector<HTMLButtonElement>('#ctx-menu button')!;

    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(item.isConnected).toBe(true);
    item.click();

    expect(canvas.maskingElement()).toBe('video-1');
    const video = store.slide!.elements.find((element) => element.id === 'video-1')!;
    expect(video.type).toBe('video');
    if (video.type === 'video') expect(video.sourceBox).toEqual({ x: 0, y: 0, w: 640, h: 360 });
    expect(host.querySelector('.sel-box.masking')).not.toBeNull();
    expect(host.querySelector('[data-element-id="video-1"] > div > video')).not.toBeNull();
  });

  /**
   * Regression: selecting a rotated element drew the selection box as if the
   * element were unrotated — the outline sat where the text *would* be at
   * rot 0 while the text itself rendered rotated. The selection box must carry
   * the same rotation as the element it highlights, about the same centre.
   */
  it('rotates the selection outline with a rotated element', () => {
    const { store, host } = setup();
    store.select(['text-1']);
    store.updateSelected((el) => {
      el.rot = -90;
    });

    const node = host.querySelector<HTMLElement>('[data-element-id="text-1"]')!;
    expect(node.style.transform).toBe('rotate(-90deg)');

    const box = host.querySelector<HTMLElement>('.sel-box')!;
    expect(box).not.toBeNull();
    // Same frame as the element…
    expect(box.style.left).toBe('100px');
    expect(box.style.top).toBe('100px');
    expect(box.style.width).toBe('600px');
    expect(box.style.height).toBe('120px');
    // …and the same rotation about it.
    expect(box.style.transform).toContain('rotate(-90deg)');
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

describe('warping media with "Keep aspect ratio" off', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('applies fit changes to the inner video without rebuilding it', () => {
    const { store, canvas } = setup();
    void canvas;
    const before = document.querySelector<HTMLElement>(
      '[data-element-id="video-1"] video',
    )!;
    expect(before.style.objectFit).toBe('contain');

    // Uncheck "Keep aspect ratio" — the inspector writes fit: 'fill'.
    store.select(['video-1']);
    store.updateSelected((el) => {
      if (el.type === 'video') el.fit = 'fill';
    });

    const after = document.querySelector<HTMLElement>(
      '[data-element-id="video-1"] video',
    )!;
    expect(after, 'the video element was recreated by a fit toggle').toBe(before);
    expect(
      after.style.objectFit,
      'fit: fill never reached the <video>, so resizing only moves the box',
    ).toBe('fill');

    // A resize with the toggle off must stretch the picture: the inner video
    // keeps filling the (now differently shaped) box instead of letterboxing.
    store.updateSelected((el) => {
      if (el.type === 'video') {
        el.w = 900;
        el.h = 120;
      }
    });
    const node = document.querySelector<HTMLElement>('[data-element-id="video-1"]')!;
    expect(node.style.width).toBe('900px');
    expect(node.style.height).toBe('120px');
    const video = node.querySelector<HTMLElement>('video')!;
    expect(video.style.width).toBe('100%');
    expect(video.style.height).toBe('100%');
    expect(video.style.objectFit).toBe('fill');
  });

  it('restores letterboxing when the toggle is switched back on', () => {
    const { store, canvas } = setup();
    void canvas;
    store.select(['video-1']);
    store.updateSelected((el) => {
      if (el.type === 'video') el.fit = 'fill';
    });
    store.updateSelected((el) => {
      if (el.type === 'video') el.fit = 'contain';
    });
    const video = document.querySelector<HTMLElement>(
      '[data-element-id="video-1"] video',
    )!;
    expect(video.style.objectFit).toBe('contain');
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

  it('hits a rotated text box where it renders, not at its unrotated bounds', () => {
    // Wide, short box rotated 90° about its centre: renders as a tall, narrow
    // column. Centre (400, 300), so the visible box spans x 385..415, y 200..400.
    const text = {
      id: 't', type: 'text' as const, x: 300, y: 285, w: 200, h: 30, rot: 90,
      z: 1, opacity: 1, class: [], style: {}, html: 'Waymo',
      align: 'left' as const, valign: 'middle' as const,
    };
    // Bottom of the rendered column — inside visually, outside the raw bounds.
    expect(elementContainsPoint(text, { x: 400, y: 390 })).toBe(true);
    expect(elementContainsPoint(text, { x: 400, y: 210 })).toBe(true);
    // Inside the raw bounds but visually empty after rotation.
    expect(elementContainsPoint(text, { x: 320, y: 300 })).toBe(false);
  });

  it('shows clean traces and persistent shared width controls for selected arrows', () => {
    const { store, host } = setup();
    const arrow = (id: string, start: { x: number; y: number }, end: { x: number; y: number }) => ({
      id,
      type: 'shape' as const,
      shape: 'arrow' as const,
      ...lineFromEndpoints(start, end, 1),
      z: 3,
      opacity: 1,
      class: [],
      style: {},
      fill: null,
      stroke: '#000000',
      strokeWidth: 7,
      radius: 0,
      path: null,
      pathSize: null,
      arrowStart: false,
      arrowEnd: true,
      control: null,
    });
    store.commit((deck) => deck.slides[0].elements.push(
      arrow('slide44-arrow-1', { x: 400, y: 300 }, { x: 610, y: 300 }),
      arrow('slide44-arrow-2', { x: 700, y: 500 }, { x: 770, y: 570 }),
    ));
    store.select(['slide44-arrow-1', 'slide44-arrow-2']);

    expect(host.querySelectorAll('.multi-line-sel')).toHaveLength(2);
    expect(host.querySelectorAll('.selection-line-preview')).toHaveLength(2);
    expect(host.querySelectorAll('.multi-line-sel .handle')).toHaveLength(0);

    const inspectorHost = document.createElement('aside');
    document.body.appendChild(inspectorHost);
    new Inspector(inspectorHost, store);
    const arrowStyle = [...inspectorHost.querySelectorAll<HTMLElement>('.insp-group')]
      .find((section) => section.querySelector('h3')?.textContent === 'Arrow style')!;
    const widthField = [...arrowStyle.querySelectorAll<HTMLLabelElement>('label')]
      .find((label) => label.querySelector('span')?.textContent === 'WIDTH')!;
    const width = widthField.querySelector<HTMLInputElement>('input')!;
    expect(width.value).toBe('7');

    width.value = '11.5';
    width.dispatchEvent(new Event('change', { bubbles: true }));

    const selected = store.selectedElements();
    expect(selected.map((element) => element.type === 'shape' && element.strokeWidth))
      .toEqual([11.5, 11.5]);
    const rerenderedWidth = [...inspectorHost.querySelectorAll<HTMLLabelElement>('label')]
      .find((label) => label.querySelector('span')?.textContent === 'WIDTH')!
      .querySelector<HTMLInputElement>('input')!;
    expect(rerenderedWidth.value).toBe('11.5');
  });
});

describe('same-kind multi-selection properties', () => {
  it('exposes mixed and shared text styling, applies it to all, and hides Magic Move', () => {
    const { store } = setup();
    const first = store.slide!.elements.find((element) => element.id === 'text-1')!;
    if (first.type !== 'text') throw new Error('expected text');
    first.style = { 'font-family': 'Avenir', 'font-size': '42px', 'font-weight': '400' };
    store.commit((deck) => deck.slides[0].elements.push({
      ...structuredClone(first),
      id: 'text-2',
      y: 220,
      html: 'Second text box',
      style: { 'font-family': 'Helvetica', 'font-size': '42px', 'font-weight': '700' },
    }));
    store.select(['text-1', 'text-2']);
    const inspectorHost = document.createElement('aside');
    document.body.appendChild(inspectorHost);
    new Inspector(inspectorHost, store);

    expect(inspectorHost.querySelector('.magic-move-section')).toBeNull();
    const textGroup = [...inspectorHost.querySelectorAll<HTMLElement>('.insp-group')]
      .find((section) => section.querySelector('h3')?.textContent === 'Text')!;
    const field = (label: string) => [...textGroup.querySelectorAll<HTMLLabelElement>('label')]
      .find((candidate) => candidate.querySelector('span')?.textContent === label)!;
    const family = field('Font family').querySelector<HTMLSelectElement>('select')!;
    const size = field('Font size').querySelector<HTMLInputElement>('input')!;
    const weight = field('Font weight').querySelector<HTMLSelectElement>('select')!;
    expect(family.value).toBe('__mixed__');
    expect(size.value).toBe('42');
    expect(weight.value).toBe('__mixed__');

    // The test environment has no local-font API, so the list is empty;
    // inject the option the way the picker would after enumeration.
    const interOption = document.createElement('option');
    interOption.value = 'Inter';
    family.appendChild(interOption);
    family.value = 'Inter';
    family.dispatchEvent(new Event('change', { bubbles: true }));
    const rerenderedText = [...inspectorHost.querySelectorAll<HTMLElement>('.insp-group')]
      .find((section) => section.querySelector('h3')?.textContent === 'Text')!;
    const rerenderedWeight = [...rerenderedText.querySelectorAll<HTMLLabelElement>('label')]
      .find((candidate) => candidate.querySelector('span')?.textContent === 'Font weight')!
      .querySelector<HTMLSelectElement>('select')!;
    rerenderedWeight.value = '600';
    rerenderedWeight.dispatchEvent(new Event('change', { bubbles: true }));

    // The picker stores the chosen family plus its cross-platform fallbacks.
    for (const element of store.selectedElements()) {
      expect(element.style['font-family']).toMatch(/^Inter, .*sans-serif$/);
    }
    expect(store.selectedElements().map((element) => element.style['font-weight']))
      .toEqual(['600', '600']);
    expect(inspectorHost.querySelector('.magic-move-section')).toBeNull();
  });

  it('keeps shared video options available without exposing single-clip tools', () => {
    const { store } = setup();
    const first = store.slide!.elements.find((element) => element.id === 'video-1')!;
    if (first.type !== 'video') throw new Error('expected video');
    store.commit((deck) => deck.slides[0].elements.push({
      ...structuredClone(first), id: 'video-2', x: 800, autoplay: false,
    }));
    store.select(['video-1', 'video-2']);
    const inspectorHost = document.createElement('aside');
    document.body.appendChild(inspectorHost);
    new Inspector(inspectorHost, store);

    const videoGroup = [...inspectorHost.querySelectorAll<HTMLElement>('.insp-group')]
      .find((section) => section.querySelector('h3')?.textContent === 'Video')!;
    const autoplay = [...videoGroup.querySelectorAll<HTMLLabelElement>('label')]
      .find((label) => label.querySelector('span')?.textContent === 'Autoplay')!
      .querySelector<HTMLInputElement>('input')!;
    expect(autoplay.indeterminate).toBe(true);
    autoplay.checked = true;
    autoplay.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.selectedElements().map((element) => element.type === 'video' && element.autoplay))
      .toEqual([true, true]);
    expect(videoGroup.textContent).not.toContain('Edit mask');
    expect(videoGroup.textContent).not.toContain('Trim');
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
    const wrap = createShapeInsertPicker(store);
    document.body.appendChild(wrap);
    const trigger = wrap.querySelector<HTMLButtonElement>('.shape-menu-trigger')!;
    trigger.focus();
    trigger.click();
    const item = [...wrap.querySelectorAll<HTMLButtonElement>('.shape-menu-item')].find(
      (el) => el.textContent === 'Curved arrow',
    )!;
    item.click();

    expect(document.activeElement).not.toBe(trigger);
    expect(wrap.querySelector('.shape-menu')).toBeNull();
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
    // Block, not inline: an inline SVG sits on a text baseline, which pushes a
    // 1px rule ~14px below its own endpoints. Asserted as the resolved value
    // rather than as attribute text, which only reflects who serialised it.
    const svg = host.querySelector<SVGElement>(`[data-element-id="${line.id}"] svg`)!;
    expect(getComputedStyle(svg).display).toBe('block');
  });

  it('leaves a rotated arrow selection box unrotated so canvas-space handles land on the arrow', () => {
    const { store, host } = setup();
    stageAtOne(host);
    const arrow = insertLine(store, 'arrow');
    store.commit((deck) => {
      const el = deck.slides[0].elements.find((e) => e.id === arrow.id)!;
      el.rot = 90;
    }, { label: 'rotate arrow' });
    store.select([arrow.id]);
    const rotated = store.slide!.elements.find((el) => el.id === arrow.id)!;
    // The endpoints already include the rotation, so the selection box must
    // not rotate again — otherwise every handle lands sideways off the arrow.
    const box = host.querySelector<HTMLElement>('.sel-box.line-sel')!;
    expect(box.style.transform).toBe('');
    const { start, end } = lineEndpoints(rotated);
    const drawnStart = host.querySelector<HTMLElement>('.handle-endpoint[data-endpoint="start"]')!;
    const drawnEnd = host.querySelector<HTMLElement>('.handle-endpoint[data-endpoint="end"]')!;
    expect(Number.parseFloat(drawnStart.style.left) + rotated.x).toBeCloseTo(start.x, 1);
    expect(Number.parseFloat(drawnStart.style.top) + rotated.y).toBeCloseTo(start.y, 1);
    expect(Number.parseFloat(drawnEnd.style.left) + rotated.x).toBeCloseTo(end.x, 1);
    expect(Number.parseFloat(drawnEnd.style.top) + rotated.y).toBeCloseTo(end.y, 1);
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

  it('applies paragraph spacing on the fast path, even mid text edit', () => {
    const { store, canvas, host } = setup();
    canvas.beginTextEdit('text-1');

    // Spacing changes are structure-preserving, so they must land on the
    // existing node — and without ending the editing session.
    store.select(['text-1']);
    store.updateSelected((el) => {
      if (el.type === 'text') el.paragraphSpacing = 24;
    });
    const node = host.querySelector<HTMLElement>('[data-element-id="text-1"]')!;
    expect(node.dataset.paragraphSpacing).toBe('24');
    expect(node.style.getPropertyValue('--paragraph-spacing')).toBe('24px');
    expect(canvas.isEditing()).toBe(true);

    store.updateSelected((el) => {
      if (el.type === 'text') delete el.paragraphSpacing;
    });
    expect(node.dataset.paragraphSpacing).toBeUndefined();
    expect(node.style.getPropertyValue('--paragraph-spacing')).toBe('');
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

describe('build badges on the canvas', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('numbers animated elements while the Build tab is open, and only then', () => {
    const { store, canvas, host } = setup();
    store.commit((deck) => {
      deck.slides[0].timeline.push(
        { id: 't-1', trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'appear', target: 'text-1', value: null } },
        { id: 't-2', trigger: { on: 'afterPrev', ref: null, delay: 0 },
          action: { type: 'play', target: 'video-1', value: null } },
        { id: 't-3', trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'disappear', target: 'text-1', value: null } },
      );
    });
    expect(host.querySelectorAll('.build-badge')).toHaveLength(0);

    canvas.setBuildBadgesVisible(true);
    const badges = [...host.querySelectorAll<HTMLElement>('.build-badge')];
    expect(badges.map((b) => b.textContent)).toEqual(['1,3', '2']);
    // Anchored to the element's top-right corner in canvas coordinates.
    expect(badges[0].style.left).toBe('700px');
    expect(badges[0].style.top).toBe('100px');

    canvas.setBuildBadgesVisible(false);
    expect(host.querySelectorAll('.build-badge')).toHaveLength(0);
  });
});
