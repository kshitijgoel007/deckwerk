// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { classifyMedia } from '../src/main/deckStore.js';
import { emptyDeck } from '../src/shared/deck.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { applyElementBoxStyles, renderElement, syncMediaFrame } from '../src/renderer/player/render.js';

const base = {
  x: 10, y: 20, w: 800, h: 500, rot: 0, z: 1, opacity: 1, class: [], style: {},
};

describe('media assets and borders', () => {
  it.each(['figure.png', 'photo.jpg', 'drawing.svg', 'paper.pdf'])(
    'accepts %s as a dropped visual asset',
    (name) => expect(classifyMedia(name)).toBe('image'),
  );

  it('keeps a PDF as a vector-backed embedded document', () => {
    const node = renderElement({
      ...base, id: 'pdf', type: 'image', src: 'assets/paper.pdf', fit: 'contain',
      alt: '', sourceBox: null,
    }, { resolveSrc: (src) => `deck://${src}` });
    const pdf = node.querySelector('embed')!;
    expect(pdf.type).toBe('application/pdf');
    expect(pdf.src).toContain('paper.pdf#page=1');
  });

  it('overlays editable coloured borders without putting them in the media box model', () => {
    const node = renderElement({
      ...base, id: 'image', type: 'image', src: 'assets/image.png', fit: 'contain',
      alt: '', sourceBox: null, borderColor: '#ff3366', borderWidth: 8,
      borderRadius: 14,
    }, { resolveSrc: (src) => src });
    const image = node.querySelector<HTMLImageElement>('img')!;
    const border = node.querySelector<HTMLElement>(':scope > .media-border-overlay')!;

    expect(node.style.border).toBe('');
    expect(image.style.width).toBe('100%');
    expect(image.style.height).toBe('100%');
    expect(border.style.position).toBe('absolute');
    expect(border.style.inset).toBe('0');
    expect(border.style.border).toContain('8px solid');
    expect(border.style.border).toContain('rgb(255, 51, 102)');
    expect(border.style.borderRadius).toBe('14px');
    expect(node.style.borderRadius).toBe('14px');
  });

  /**
   * Element wrappers are absolutely positioned with no z-index, so the slide
   * paints them in document order. That makes any z-index *inside* a wrapper
   * resolve against the slide unless the wrapper is a stacking context -- so
   * the border overlay's `z-index:1` floated above every element rendered
   * after it, and moving a front video over a bordered one drew the bordered
   * one's frame across it.
   */
  it('keeps a media border from painting over the elements in front of it', () => {
    const node = renderElement({
      ...base, id: 'image', type: 'image', src: 'assets/image.png', fit: 'cover',
      alt: '', sourceBox: null, borderColor: '#ff3366', borderWidth: 8,
    }, { resolveSrc: (src) => src });
    const border = node.querySelector<HTMLElement>(':scope > .media-border-overlay')!;
    // The overlay still sits above its own media...
    expect(border.style.zIndex).toBe('1');
    // ...but that stacking is scoped to this element, not to the slide.
    expect(node.style.isolation).toBe('isolate');
  });

  it('overlays a CSS-authored media border too', () => {
    const node = renderElement({
      ...base, id: 'video', type: 'video', src: 'assets/video.mp4', fit: 'cover',
      autoplay: false, loop: false, muted: true, controls: false, start: 0, end: null,
      poster: null, sourceBox: null, style: { border: '5px solid #ffffff' },
    }, { resolveSrc: (src) => src });
    const border = node.querySelector<HTMLElement>(':scope > .media-border-overlay')!;

    expect(node.style.border).toBe('');
    expect(node.querySelector<HTMLVideoElement>('video')!.style.width).toBe('100%');
    expect(border.style.border).toContain('5px solid');
  });

  it('lets an explicit inspector width suppress a stale CSS-authored border', () => {
    const element = {
      ...base, id: 'image', type: 'image' as const, src: 'assets/image.png', fit: 'cover' as const,
      alt: '', sourceBox: null, style: { border: '7px solid #f3b61f' },
      borderColor: '#f3b61f', borderWidth: 7,
    };
    const node = renderElement(element, { resolveSrc: (src) => src });
    const border = node.querySelector<HTMLElement>(':scope > .media-border-overlay')!;
    expect(border.style.border).toContain('7px solid');

    syncMediaFrame(node, { ...element, borderWidth: 0 });
    expect(border.style.border).toBe('');
  });

  it('lets an explicit zero radius suppress stale CSS-authored rounded corners', () => {
    const element = {
      ...base, id: 'video', type: 'video' as const, src: 'assets/video.mp4', fit: 'cover' as const,
      autoplay: false, loop: false, muted: true, controls: false, start: 0, end: null,
      poster: null, sourceBox: null, style: { 'border-radius': '24px' },
    };
    const node = renderElement(element, { resolveSrc: (src) => src });
    expect(node.style.borderRadius).toBe('24px');

    syncMediaFrame(node, { ...element, borderRadius: 0 });
    expect(node.style.borderRadius).toBe('');
    expect(node.querySelector<HTMLVideoElement>('video')!.style.borderRadius).toBe('');
  });

  it('lets an explicit rectangular mask suppress a stale CSS circle', () => {
    const element = {
      ...base, id: 'image', type: 'image' as const, src: 'assets/image.png', fit: 'cover' as const,
      alt: '', sourceBox: null, style: { 'border-radius': '50%' },
    };
    const node = renderElement(element, { resolveSrc: (src) => src });
    expect(node.style.borderRadius).toBe('50%');

    syncMediaFrame(node, { ...element, maskShape: 'rect' });
    expect(node.style.borderRadius).toBe('');
    expect(node.querySelector<HTMLImageElement>('img')!.style.borderRadius).toBe('');
  });

  it('lets an explicit empty effect list suppress a stale CSS filter', () => {
    const node = renderElement({
      ...base, id: 'image', type: 'image', src: 'assets/image.png', fit: 'cover',
      alt: '', sourceBox: null, style: { filter: 'blur(18px)' }, effects: [],
    }, { resolveSrc: (src) => src });

    expect(node.style.filter).toBe('');
    expect(node.querySelector<HTMLImageElement>('img')!.style.filter).toBe('');
  });

  it('shows legacy CSS borders and circles in the inspector and can clear them', () => {
    const deck = emptyDeck('Legacy decoration');
    deck.slides[0].elements.push({
      ...base, id: 'image', type: 'image', src: 'assets/image.png', fit: 'cover',
      alt: '', sourceBox: null,
      style: { border: '7px solid #ff3366', 'border-radius': '50%' },
    });
    const store = new EditorStore(deck, '/tmp/legacy-decoration');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new Inspector(host, store);
    store.select(['image']);

    const sections = [...host.querySelectorAll<HTMLElement>('.insp-option-section')];
    const masking = sections.find((section) => section.querySelector('h4')?.textContent?.startsWith('Masking'))!;
    const border = sections.find((section) => section.querySelector('h4')?.textContent === 'Border')!;
    const circle = masking.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const width = border.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(circle.checked).toBe(true);
    expect(width.value).toBe('7');

    circle.checked = false;
    circle.dispatchEvent(new Event('change', { bubbles: true }));
    host.querySelector<HTMLElement>('.media-border-options')!
      .querySelector<HTMLInputElement>('input[type="number"]')!.value = '0';
    host.querySelector<HTMLElement>('.media-border-options')!
      .querySelector<HTMLInputElement>('input[type="number"]')!
      .dispatchEvent(new Event('change', { bubbles: true }));

    const image = store.selectedElements()[0];
    if (image.type !== 'image') throw new Error('expected image');
    expect(image.maskShape).toBe('rect');
    expect(image.borderWidth).toBe(0);
    expect(image.style).toEqual({});
  });

  it('resolves media and CSS assets inside a sandboxed HTML fallback', () => {
    const node = renderElement({
      ...base,
      id: 'portrait-fallback',
      type: 'html',
      html: '<figure data-slide-editor-fallback-root><img src="assets/portrait.jpg"></figure>',
      sandboxed: true,
      css: '.portrait { background-image:url("assets/texture.png") }',
      fallbackReason: 'Clipped media frame with a CSS pseudo-element overlay',
    }, { resolveSrc: (src) => `/decks/test/${src}` });

    const shadow = node.querySelector('div')!.shadowRoot!;
    expect(shadow.querySelector('img')!.getAttribute('src'))
      .toBe('/decks/test/assets/portrait.jpg');
    expect(shadow.querySelector('style')!.textContent)
      .toContain('url("/decks/test/assets/texture.png")');
  });
});

describe('shape effect contours', () => {
  const shape = {
    ...base,
    id: 'shape',
    type: 'shape' as const,
    fill: '#ffffff',
    stroke: '#663399',
    strokeWidth: 4,
    arrowStart: false,
    arrowEnd: false,
    path: null,
    pathSize: null,
    control: null,
    style: { 'box-shadow': '0 20px 40px #0006' },
  };

  it('makes imported ellipse and rounded-rectangle shadows follow their SVG contour', () => {
    const ellipse = renderElement({ ...shape, shape: 'ellipse', radius: 0 }, { resolveSrc: (src) => src });
    const card = renderElement({ ...shape, shape: 'rect', radius: 31 }, { resolveSrc: (src) => src });

    expect(ellipse.style.borderRadius).toBe('50%');
    expect(card.style.borderRadius).toBe('31px');
  });

  it('clears the contour when a rounded shape becomes square', () => {
    const rounded = { ...shape, shape: 'rect' as const, radius: 31 };
    const square = { ...rounded, radius: 0 };
    const node = renderElement(rounded, { resolveSrc: (src) => src });

    applyElementBoxStyles(node, square, rounded);

    expect(node.style.borderRadius).toBe('');
  });
});
